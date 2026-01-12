import path from "node:path";
import fs from "fs-extra";
import pLimit from "p-limit";
import sanitizeFilename from "sanitize-filename";
import { chromium } from "playwright";
import { parseQiitaItemIdFromUrl, toQiitaEditUrl } from "./qiitaUrl.js";
import { extractImageUrlsFromMarkdown, replaceImageUrls } from "./text.js";
import { downloadImageToFile, isQiitaUploadSupportedByExtension, optimizeImageToTargetBytes } from "./images.js";
import { openQiitaEditorAndRun } from "./qiitaUi.js";
import { createLogger } from "./logger.js";
import { deleteQiitaUploadedFilesByUrls } from "./qiitaUploadedFilesUi.js";
import { verifyOnlyUrlChanges } from "./diffCheck.js";

/**
 * @typedef {Object} RunQicOptions
 * @property {string} qiitaArticleUrl
 * @property {"all"|"single"=} scope
 * @property {number} targetBytes
 * @property {string} outDir
 * @property {string | null=} logFilePath
 * @property {number} concurrency
 * @property {{ headless: boolean, storageStatePath: string | null }} playwright
 * @property {boolean} dryRun
 * @property {boolean=} deleteOriginal
 */

/**
 * @param {RunQicOptions} options
 */
export async function runQic(options) {
    const TARGET_TOLERANCE_RATIO = 0.2;
    const targetBytesMax = Math.round(options.targetBytes * (1 + TARGET_TOLERANCE_RATIO));
    const itemId = parseQiitaItemIdFromUrl(options.qiitaArticleUrl);
    const editUrl = toQiitaEditUrl(itemId);
    const scope = options.scope ?? "all";

    const outDirAbs = path.resolve(options.outDir);
    const logsDir = path.join(outDirAbs, "logs");
    const artifactsDir = path.join(outDirAbs, "artifacts");
    const originalsDir = path.join(outDirAbs, "originals");
    const optimizedDir = path.join(outDirAbs, "optimized");
    const backupsDir = path.join(outDirAbs, "backups");

    await fs.ensureDir(originalsDir);
    await fs.ensureDir(optimizedDir);
    await fs.ensureDir(logsDir);
    await fs.ensureDir(artifactsDir);
    await fs.ensureDir(backupsDir);

    const logFilePath =
        options.logFilePath ??
        path.join(logsDir, `qic-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
    const logger = await createLogger({ logFilePath });

    // Always log runtime identity to detect accidental execution of a different build (e.g. npx downloading another package).
    logger.info("Runtime identity.", {
        cwd: process.cwd(),
        argv0: process.argv[0],
        argv1: process.argv[1],
        moduleUrl: import.meta.url
    });

    const browser = await chromium.launch({ headless: options.playwright.headless });
    let storageStateToLoad = null;
    let storageStateToSave = null;
    if (options.playwright.storageStatePath) {
        const ssPathAbs = path.resolve(options.playwright.storageStatePath);
        storageStateToSave = ssPathAbs;
        const exists = await fs.pathExists(ssPathAbs);
        if (exists) {
            storageStateToLoad = ssPathAbs;
        } else {
            logger.warn("storageState file not found; continuing without it (you can login and it will be saved on exit).", {
                storageStatePath: options.playwright.storageStatePath,
                resolvedPath: ssPathAbs
            });
        }
    }

    const context = await browser.newContext(storageStateToLoad ? { storageState: storageStateToLoad } : {});
    const page = await context.newPage();

    let runError = null;
    try {
        logger.info("Starting QIC.", {
            qiitaArticleUrl: options.qiitaArticleUrl,
            editUrl,
            outDir: outDirAbs,
            scope,
            targetBytes: options.targetBytes,
            targetBytesMax,
            targetToleranceRatio: TARGET_TOLERANCE_RATIO,
            concurrency: options.concurrency,
            headless: options.playwright.headless,
            storageStatePath: options.playwright.storageStatePath,
            dryRun: options.dryRun,
            deleteOriginal: options.deleteOriginal === true
        });

        logger.info("PHASE: open_editor", { editUrl });
        await openQiitaEditorAndRun({
            page,
            context,
            editUrl,
            logger,
            artifactsDir,
            async runInEditor({ getBody, getBodyLive, setBody, replaceUrls, uploadImageAndGetUrl, clickUpdate }) {
                logger.info("PHASE: read_body");
                logger.info("Reading article body from editor...");
                const bodyFromLive = await getBodyLive().catch(() => "");
                const bodyFromStore = await getBody();
                const originalBody = bodyFromLive.length >= bodyFromStore.length ? bodyFromLive : bodyFromStore;
                const backupPath = path.join(
                    backupsDir,
                    `${itemId}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`
                );
                await fs.writeFile(backupPath, originalBody, "utf-8");
                logger.info("Backed up article body.", { backupPath });
                logger.info("Editor body stats.", {
                    length: originalBody.length,
                    head: originalBody.slice(0, 200)
                });
                const imageUrls = extractImageUrlsFromMarkdown(originalBody);

                if (imageUrls.length === 0) {
                    logger.info("No images found in article body.");
                    return;
                }

                logger.info("PHASE: collect_images", { found: imageUrls.length });
                logger.info(`Found ${imageUrls.length} image(s).`);

                const limit = pLimit(options.concurrency);
                const uniqueUrls = Array.from(new Set(imageUrls));
                const urlsToProcess = [];

                /** @type {Map<string, { originalPath: string, uploadPath: string, wasConverted: boolean }>} */
                const localPathsByUrl = new Map();
                /** @type {Set<string>} */
                const skippedDownloadUrls = new Set();

                if (scope === "single") {
                    logger.info("PHASE: select_single_image", { targetBytes: options.targetBytes, targetBytesMax });
                    logger.info("Scope=single: searching first image > targetBytesMax.", {
                        targetBytesMax,
                        candidates: uniqueUrls.length
                    });
                    let selectedUrl = null;

                    for (let idx = 0; idx < uniqueUrls.length; idx += 1) {
                        const url = uniqueUrls[idx];
                        const safeBase = sanitizeFilename(`img-${idx + 1}`) || `img-${idx + 1}`;
                        const originalPath = path.join(originalsDir, `${safeBase}${guessExtFromUrl(url)}`);
                        // Qiita upload rejects image/webp. Prefer PNG output for PNG inputs (better text readability),
                        // otherwise use JPEG.
                        const ext = path.extname(originalPath).toLowerCase();
                        const optimizedExt = ext === ".png" ? ".png" : ".jpg";
                        const optimizedPath = path.join(optimizedDir, `${safeBase}${optimizedExt}`);

                        logger.info(`Downloading (probe): ${url}`);
                        let dl;
                        try {
                            // eslint-disable-next-line no-await-in-loop
                            dl = await downloadImageToFile(url, originalPath);
                        } catch (e) {
                            if (e?.code === "ACCESS_DENIED") {
                                logger.warn("Skipping image (AccessDenied) while probing.", { url, error: String(e) });
                                skippedDownloadUrls.add(url);
                                continue;
                            }
                            throw e;
                        }
                        logger.info("Downloaded (probe).", { url, originalPath, bytes: dl.byteLength, contentType: dl.contentType });

                        if (dl.byteLength <= targetBytesMax) {
                            logger.info("Scope=single: skipping (within tolerance).", {
                                url,
                                bytes: dl.byteLength,
                                targetBytesMax
                            });
                            continue;
                        }

                        const originalSupported = isQiitaUploadSupportedByExtension(originalPath);
                        const skipOptimize = originalSupported && dl.byteLength <= targetBytesMax;
                        if (skipOptimize) {
                            localPathsByUrl.set(url, { originalPath, uploadPath: originalPath, wasConverted: false });
                        } else {
                            logger.info("PHASE: optimize_image", { input: originalPath, output: optimizedPath });
                            logger.info(
                                `Optimizing -> <=${Math.round(targetBytesMax / 1024)}KB (tolerance +${Math.round(
                                    TARGET_TOLERANCE_RATIO * 100
                                )}%): ${originalPath}`
                            );
                            // eslint-disable-next-line no-await-in-loop
                            await optimizeImageToTargetBytes({
                                inputPath: originalPath,
                                outputPath: optimizedPath,
                                targetBytes: targetBytesMax,
                                logger
                            });
                            const optimizedBytes = await fs.stat(optimizedPath).then((s) => s.size).catch(() => null);
                            logger.info("Optimized image written.", { optimizedPath, optimizedBytes });
                            localPathsByUrl.set(url, { originalPath, uploadPath: optimizedPath, wasConverted: true });
                        }

                        selectedUrl = url;
                        urlsToProcess.push(url);
                        break;
                    }

                    if (!selectedUrl) {
                        logger.info("Scope=single: no images > targetBytesMax found. Nothing to do.", {
                            targetBytesMax
                        });
                        return;
                    }
                } else {
                    const candidates = uniqueUrls.length;
                    logger.info("PHASE: select_images_all", { targetBytes: options.targetBytes, targetBytesMax, candidates });
                    const selected = await Promise.all(
                        uniqueUrls.map((url, idx) =>
                            limit(async () => {
                                const safeBase = sanitizeFilename(`img-${idx + 1}`) || `img-${idx + 1}`;
                                const originalPath = path.join(originalsDir, `${safeBase}${guessExtFromUrl(url)}`);
                                // Qiita upload rejects image/webp. Prefer PNG output for PNG inputs (better text readability),
                                // otherwise use JPEG.
                                const ext = path.extname(originalPath).toLowerCase();
                                const optimizedExt = ext === ".png" ? ".png" : ".jpg";
                                const optimizedPath = path.join(optimizedDir, `${safeBase}${optimizedExt}`);

                                logger.info(`Downloading: ${url}`);
                                let dl;
                                try {
                                    dl = await downloadImageToFile(url, originalPath);
                                } catch (e) {
                                    if (e?.code === "ACCESS_DENIED") {
                                        // Some qiita-image-store objects are not publicly readable (AccessDenied).
                                        // In that case we cannot optimize/reupload; keep original URL as-is.
                                        logger.warn("Skipping image (AccessDenied). URL will remain unchanged.", {
                                            url,
                                            error: String(e)
                                        });
                                        skippedDownloadUrls.add(url);
                                        return null;
                                    }
                                    throw e;
                                }

                                // Only process images that exceed the tolerance threshold.
                                // If nothing exceeds, all-mode should do nothing (same behavior as single-mode).
                                if (dl.byteLength <= targetBytesMax) {
                                    logger.info("Skipping (within tolerance).", { url, bytes: dl.byteLength, targetBytesMax });
                                    return null;
                                }

                                const originalSupported = isQiitaUploadSupportedByExtension(originalPath);
                                // Here the file is > targetBytesMax; it needs processing.

                                logger.info(
                                    `Optimizing -> <=${Math.round(targetBytesMax / 1024)}KB (tolerance +${Math.round(
                                        TARGET_TOLERANCE_RATIO * 100
                                    )}%): ${originalPath}`
                                );
                                await optimizeImageToTargetBytes({
                                    inputPath: originalPath,
                                    outputPath: optimizedPath,
                                    targetBytes: targetBytesMax,
                                    logger
                                });

                                // Even if the original is supported, we only touch it when it's over the tolerance threshold.
                                localPathsByUrl.set(url, { originalPath, uploadPath: optimizedPath, wasConverted: true });
                                return url;
                            })
                        )
                    );
                    urlsToProcess.push(...selected.filter((u) => typeof u === "string"));

                    logger.info("Scope=all: selected images to process.", {
                        selected: urlsToProcess.length,
                        skippedWithinTolerance: candidates - urlsToProcess.length - skippedDownloadUrls.size,
                        skippedAccessDenied: skippedDownloadUrls.size,
                        candidates
                    });

                    if (urlsToProcess.length === 0) {
                        logger.info("Scope=all: no images > targetBytesMax found. Nothing to do.", {
                            targetBytesMax
                        });
                        return;
                    }
                }

                /** @type {Map<string, string>} */
                const uploadedUrlByOriginalUrl = new Map();

                for (const url of urlsToProcess) {
                    if (skippedDownloadUrls.has(url)) {
                        continue;
                    }
                    const local = localPathsByUrl.get(url);
                    if (!local) {
                        continue;
                    }

                    logger.info("PHASE: upload_image", { localPath: local.uploadPath });
                    logger.info(`Uploading to Qiita editor: ${local.uploadPath}`);
                    const uploadedUrl = await uploadImageAndGetUrl(local.uploadPath);
                    logger.info(`Uploaded URL: ${uploadedUrl}`);
                    uploadedUrlByOriginalUrl.set(url, uploadedUrl);
                }

                const newBody = replaceImageUrls(originalBody, uploadedUrlByOriginalUrl);

                if (newBody === originalBody) {
                    logger.warn("No URL changes detected; skipping update.");
                    return;
                }

                logger.info("PHASE: replace_urls", { rules: uploadedUrlByOriginalUrl.size });
                logger.info("Replacing URLs in editor...");
                await replaceUrls(uploadedUrlByOriginalUrl);
                const didMutateEditor = true;

                // Safety check: ensure no non-URL changes occurred before submit.
                let expectedForCheck = originalBody;
                for (const [from, to] of uploadedUrlByOriginalUrl.entries()) {
                    expectedForCheck = expectedForCheck.split(from).join(to);
                }

                // Wait a bit for the editor/store to reflect replacements before comparing.
                // Prefer getBodyLive(): for Qiita CM6, this reads full rawBody from autosave GraphQL payload.
                let currentBody = await getBodyLive().catch(() => "");
                const waitDeadline = Date.now() + 15_000;
                while (Date.now() < waitDeadline) {
                    const next = await getBodyLive().catch(() => "");
                    if (next === expectedForCheck) {
                        currentBody = next;
                        break;
                    }
                    currentBody = next;
                    await page.waitForTimeout(250);
                }

                const check = verifyOnlyUrlChanges({ originalBody, currentBody, urlMap: uploadedUrlByOriginalUrl });
                if (!check.ok) {
                    const ts = new Date().toISOString().replace(/[:.]/g, "-");
                    const expectedPath = path.join(artifactsDir, `${ts}-expected.md`);
                    const currentPath = path.join(artifactsDir, `${ts}-current.md`);
                    const reportPath = path.join(artifactsDir, `${ts}-diff-check.json`);

                    await fs.writeFile(expectedPath, expectedForCheck, "utf-8");
                    await fs.writeFile(currentPath, currentBody, "utf-8");
                    await fs.writeJson(reportPath, check, { spaces: 2 });

                    logger.error("Diff check failed: non-URL changes detected. Aborting before submit.", {
                        reportPath,
                        expectedPath,
                        currentPath,
                        check
                    });
                    throw new Error("本文にURL以外の差分が検出されたため、記事更新を中止しました（out/artifacts に差分を出力しました）。");
                }

                if (options.dryRun) {
                    logger.info("--dry-run: not clicking update button.");
                    if (didMutateEditor) {
                        logger.info("--dry-run: restoring original body in editor to avoid leaving draft modified.");
                        await setBody(originalBody);
                    }
                    return;
                }

                logger.info("PHASE: submit_update");
                logger.info("Clicking update...");
                const updated = await clickUpdate();

                // Post-submit verification: ensure the *published* article reflects the URL changes
                // before we delete originals. (Qiita can keep /edit URL even after save.)
                const verifyPublishedArticle = async () => {
                    const maxMs = 90_000;
                    const startedAt = Date.now();
                    const fromUrls = Array.from(uploadedUrlByOriginalUrl.keys());
                    const toUrls = Array.from(uploadedUrlByOriginalUrl.values());

                    while (Date.now() - startedAt < maxMs) {
                        try {
                            logger.info("PHASE: verify_published_article", { elapsedMs: Date.now() - startedAt });
                            await page.goto(options.qiitaArticleUrl, { waitUntil: "domcontentloaded" });
                            await page.waitForTimeout(1000);
                            const html = await page.content();

                            const hasAllNew = toUrls.every((u) => html.includes(u));
                            const hasAnyOld = fromUrls.some((u) => html.includes(u));
                            if (hasAllNew && !hasAnyOld) {
                                return { ok: true, hasAllNew, hasAnyOld };
                            }
                            logger.info("Verifying published article update...", { hasAllNew, hasAnyOld });
                        } catch (e) {
                            logger.warn("Failed to verify published article (will retry).", { error: String(e) });
                        }
                        await page.waitForTimeout(5000);
                    }
                    return { ok: false };
                };

                const verified = await verifyPublishedArticle();
                if (verified.ok) {
                    logger.info("Published article verification OK (URLs updated).");
                } else {
                    logger.warn("Published article verification failed/unknown; skipping deletion of original files.", {
                        updated,
                        qiitaArticleUrl: options.qiitaArticleUrl
                    });
                }

                if (verified.ok) {
                    if (options.deleteOriginal === true) {
                        logger.info("PHASE: delete_originals", { count: uploadedUrlByOriginalUrl.size });
                        logger.info("Article update succeeded. Deleting original uploaded files...");
                        await deleteQiitaUploadedFilesByUrls({
                            page,
                            logger,
                            originalUrls: Array.from(uploadedUrlByOriginalUrl.keys()),
                            artifactsDir
                        });
                    } else {
                        logger.info("Article update succeeded. Skipping deletion of original files (enable with --delete-original).");
                    }
                } else {
                    logger.warn("Article update status is unknown; skipping deletion of original files.", { updated });
                }
            }
        });
        logger.info("Done.");
    } catch (e) {
        runError = e;
        throw e;
    } finally {
        // Save storageState even on failure (useful when user completed login/2FA but later steps failed).
        if (storageStateToSave) {
            try {
                await fs.ensureDir(path.dirname(storageStateToSave));
                await context.storageState({ path: storageStateToSave });
                logger.info("Saved storageState.", { path: storageStateToSave, when: runError ? "on_error" : "on_success" });
            } catch (e) {
                logger.warn("Failed to save storageState.", { path: storageStateToSave, error: String(e) });
            }
        }

        await page.close().catch(() => {});
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
        await logger.close().catch(() => {});
    }
}

function guessExtFromUrl(url) {
    try {
        const u = new URL(url);
        const base = path.basename(u.pathname);
        const ext = path.extname(base);
        if (!ext || ext.length > 10) {
            return ".img";
        }
        return ext;
    } catch {
        return ".img";
    }
}

