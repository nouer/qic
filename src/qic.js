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
 * QICの中核処理（CLIから呼ばれる）。
 *
 * 目的:
 * - Qiita記事本文に埋め込まれた画像URLを検出し、容量が大きい画像を圧縮して再アップロードし、
 *   本文中のURLだけを安全に差し替える。
 *
 * 重要な安全設計:
 * - 本文の書き換えは「URL置換のみ」を原則とし、置換以外の差分が混入した場合は更新を中止する。
 *   → `verifyOnlyUrlChanges()` がその安全装置（異常時は artifacts にエビデンスを出力）。
 * - 画像の“元ファイル削除”は非常に危険なので、更新後に公開記事が反映されたことを検証できた場合のみ、
 *   かつユーザーが `deleteOriginal` を明示指定した場合にだけ実行する。
 *
 * フェーズ概要（ログに PHASE: を出す）:
 * - open_editor
 * - read_body（バックアップ含む）
 * - collect_images / select_(single|all)
 * - download / optimize
 * - upload
 * - replace_urls
 * - diff_check
 * - submit_update（dry-runならここは実行しない）
 * - verify_published_article
 * - delete_originals（オプション）
 */

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
    // 「目標サイズ」には多少の余裕（tolerance）を持たせる。
    // 例: target=500KB、tolerance=0.2 なら “<=600KB なら許容” とし、
    // 余計な再圧縮で画質を落としすぎないようにする。
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

    // 実行時の同一性を必ずログに残す:
    // 例) npx 経由で別パッケージが実行される等の事故検知に役立つ。
    logger.info("Runtime identity.", {
        cwd: process.cwd(),
        argv0: process.argv[0],
        argv1: process.argv[1],
        moduleUrl: import.meta.url
    });

    // ブラウザ起動（headless/headedはCLIで選択）。
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

    // storageStateがあるならログイン状態（cookie/localStorage等）を復元して起動する。
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
                // Qiita CM6 は DOM が仮想化されるため、見えている行だけが innerText に現れることがある。
                // そのため getBodyLive()（可能ならGraphQL autosave payload等）を優先し、
                // 取得結果が短い場合に備えて getBody()（React store等のスナップショット）とも比較する。
                const bodyFromLive = await getBodyLive().catch(() => "");
                const bodyFromStore = await getBody();
                const originalBody = bodyFromLive.length >= bodyFromStore.length ? bodyFromLive : bodyFromStore;
                const backupPath = path.join(
                    backupsDir,
                    `${itemId}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`
                );
                // 自動操作前に必ず本文をバックアップする（事故時に手動復旧できるように）。
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
                    // scope=single:
                    // “最初に見つかった targetBytesMax 超え画像”だけを対象にする。
                    // → 記事が大きい場合でも影響範囲を最小化し、まずは一枚で試せる運用を想定。
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
                        // Qiitaは image/webp をアップロードで弾く。
                        // そのため出力は PNG/JPEG に寄せる。
                        // - 入力がPNGならPNGのまま（スクショ等の文字がにじみにくい）
                        // - それ以外は JPEG（容量を落としやすい）
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
                    // scope=all:
                    // すべての画像候補についてダウンロード → “targetBytesMax超え”だけ最適化対象にする。
                    // ただし同時実行数は concurrency で制限し、S3/ローカルCPUを過負荷にしない。
                    const candidates = uniqueUrls.length;
                    logger.info("PHASE: select_images_all", { targetBytes: options.targetBytes, targetBytesMax, candidates });
                    const selected = await Promise.all(
                        uniqueUrls.map((url, idx) =>
                            limit(async () => {
                                const safeBase = sanitizeFilename(`img-${idx + 1}`) || `img-${idx + 1}`;
                                const originalPath = path.join(originalsDir, `${safeBase}${guessExtFromUrl(url)}`);
                                // Qiitaは image/webp をアップロードで弾くため、出力は PNG/JPEG に寄せる。
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

                    // 画像アップロードは「エディタ本文を触らない」経路を優先する。
                    // （本文に余計な差分が入ると危険なため。アップロード後はURLだけ差し替える）
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

                // 安全確認（最重要）:
                // submit 前に「URL置換以外の変更が起きていない」ことを必ず確認する。
                let expectedForCheck = originalBody;
                for (const [from, to] of uploadedUrlByOriginalUrl.entries()) {
                    expectedForCheck = expectedForCheck.split(from).join(to);
                }

                // 置換直後はエディタ内部状態（store/autosave）が追従するまでタイムラグがある。
                // そのため短時間ポーリングして一致を待つ（特にCM6は live 取得を優先）。
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

                    // 後から原因分析できるよう、期待本文・実際本文・診断レポートを artifacts に保存する。
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
                    // dry-run:
                    // - submit（更新ボタン押下）はしない
                    // - ただし途中でエディタ本文を触った場合、下書きが汚れるので原文に戻す
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

                // submit後の検証:
                // Qiitaは保存後も /edit に留まることがあるため、
                // 実際の公開記事HTMLに新URLが反映されたことを確認してから次の危険操作へ進む。
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
        // storageState は失敗時でも保存する（ログイン/2FAまでは通ったが後段で失敗、がよくあるため）。
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
    // URL末尾のパスから拡張子を推測する。
    // 推測できない場合は ".img" を付けて保存し、Sharp側で読み取れることに期待する。
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

