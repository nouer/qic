import path from "node:path";
import fs from "node:fs/promises";

/**
 * Qiitaの「アップロードしたファイル」設定画面をUI操作して、
 * 指定URLに対応するアップロード済み画像を削除する（ベストエフォート）。
 *
 * なぜUI駆動か:
 * - Qiitaはアップロード済み画像の削除APIを外部に公開していないため、
 *   実際の画面操作（クリック）でしか削除できない。
 *
 * 安全上の注意:
 * - 画像削除は不可逆（復元できない）なので、呼び出し側では
 *   「公開記事に新URLが反映されている」ことを検証できた場合のみ実行する。
 *
 * ベストエフォート方針:
 * - 一覧に見つからない/ページングで取りこぼす/表示が遅い等は起こり得るため、
 *   見つからない場合はログを残して続行する（ツール全体を失敗させない）。
 *
 * @param {{
 *   page: import("playwright").Page,
 *   logger: any,
 *   originalUrls: string[],
 *   artifactsDir: string
 * }} params
 */
export async function deleteQiitaUploadedFilesByUrls({ page, logger, originalUrls }) {
    // URLから「削除対象を識別するキー（UUID）」を取り出す。
    // キーが取れないURLは削除対象にできないため除外する。
    const deletables = originalUrls
        .map((u) => ({ url: u, key: parseQiitaImageKey(u) }))
        .filter((x) => x.key !== null);

    if (deletables.length === 0) {
        logger.info("No deletable original URLs detected.");
        return;
    }

    const settingsUrl = await openUploadedFilesListPage(page, logger);
    logger.info("Opening uploaded files settings page...", { settingsUrl, count: deletables.length });

    /** @type {Set<string>} */
    const remaining = new Set(deletables.map((d) => d.key));
    /** @type {Map<string, number>} */
    const retryBudgetByUuid = new Map(deletables.map((d) => [d.key, 1])); // each image gets one full-pass retry
    const maxPages = 50;
    let lastListUrl = null;
    /** @type {string|null} */
    let lastFingerprint = null;

    const runOnePass = async (passIndex) => {
        logger.info("delete_originals.pass_start", { passIndex, remaining: remaining.size });
        // Always start from page 1 for each pass to avoid being stuck mid-list due to timing issues.
        await page.goto("https://qiita.com/settings/uploaded_images", { waitUntil: "domcontentloaded" });
        lastListUrl = null;
        lastFingerprint = null;

        for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
            await waitForUploadedImagesListReady(page, logger);
            const currentListUrl = page.url();

            logger.info("Scanning uploaded images page...", {
                passIndex,
                pageIndex,
                maxPages,
                url: currentListUrl,
                remaining: remaining.size
            });

            // 1ページ分の処理:
            // - まずページ内に存在するUUID一覧をまとめて抽出する（DOM走査は高コストなので一回で済ませる）
            // - それと remaining（未削除）を突き合わせて “このページで削除できる候補” を決める
            const pageUuids = await collectUuidsFromUploadedImagesPage(page).catch(() => []);
            const hits = [];
            for (const uuid of remaining) {
                if (pageUuids.includes(uuid)) {
                    hits.push(uuid);
                }
            }

            if (hits.length === 0) {
                // タイミング対策:
                // SPAの遅延描画で「今はまだDOMに出ていない」可能性がある。
                // そのため、このページにヒットが無い場合は一度だけ reload して再抽出する。
                const beforeFp = await getUploadedImagesListFingerprint(page).catch(() => null);
                await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
                await waitForUploadedImagesListReady(page, logger);
                const afterFp = await getUploadedImagesListFingerprint(page).catch(() => null);
                if (beforeFp !== afterFp) {
                    const pageUuids2 = await collectUuidsFromUploadedImagesPage(page).catch(() => []);
                    for (const uuid of remaining) {
                        if (pageUuids2.includes(uuid)) {
                            hits.push(uuid);
                        }
                    }
                }
            }

            logger.info("delete_originals.page_hits", {
                passIndex,
                pageIndex,
                url: currentListUrl,
                pageUuidCount: pageUuids.length,
                hitCount: hits.length
            });

            let deletedOnThisPage = 0;
            for (const uuid of hits) {
                logger.info("delete_originals.found_on_page", { passIndex, pageIndex, uuid, url: currentListUrl });
                // 削除は1件ずつ（安全のため）。
                // まとめてクリックすると、ダイアログの取り違え/誤削除リスクが上がる。
                // eslint-disable-next-line no-await-in-loop
                const ok = await deleteIfVisibleOnCurrentPage(page, uuid, logger);
                if (ok) {
                    remaining.delete(uuid);
                    deletedOnThisPage += 1;
                    // Deletion triggers re-render; wait a bit to avoid racing.
                    // eslint-disable-next-line no-await-in-loop
                    await waitForUploadedImagesListReady(page, logger);
                }
            }

            logger.info("Finished scanning page.", { passIndex, pageIndex, deletedOnThisPage, remaining: remaining.size });

            if (remaining.size === 0) {
                logger.info("Deleted all target uploaded files.", { count: deletables.length, passIndex });
                return true;
            }

            const moved = await goToNextUploadedImagesPageIfExists(page, logger, { pageIndex, lastListUrl, lastFingerprint });
            lastListUrl = currentListUrl;
            lastFingerprint = await getUploadedImagesListFingerprint(page).catch(() => lastFingerprint);
            if (!moved) {
                logger.info("delete_originals.reached_end", { passIndex, pageIndex, remaining: remaining.size });
                return false;
            }
        }

        logger.info("delete_originals.max_pages_reached", { passIndex, maxPages, remaining: remaining.size });
        return false;
    };

    // Pass 0: normal scan. If we reach the end with remaining, retry pass once per UUID (one full retry from page 1).
    const completedInFirstPass = await runOnePass(0);
    if (!completedInFirstPass && remaining.size > 0) {
        const retrySet = new Set();
        for (const uuid of remaining) {
            const left = retryBudgetByUuid.get(uuid) ?? 0;
            if (left > 0) {
                retryBudgetByUuid.set(uuid, left - 1);
                retrySet.add(uuid);
            }
        }
        if (retrySet.size > 0) {
            logger.warn("delete_originals.retry_pass_start", { retryCount: retrySet.size });
            // Keep only retrySet in remaining for the retry pass.
            for (const uuid of Array.from(remaining)) {
                if (!retrySet.has(uuid)) {
                    remaining.delete(uuid);
                }
            }
            await runOnePass(1);
        }
    }

    for (const uuid of remaining) {
        logger.warn("Failed to delete (not found after paging).", { uuid });
    }
}

async function collectUuidsFromUploadedImagesPage(page) {
    // UploadedImagesSettings コンポーネント配下から UUID を抽出する。
    // href/src/data-src/srcset を広く走査し、S3 URL やサムネURLに含まれる UUID を拾う。
    return await page.evaluate(() => {
        const root = document.querySelector("[id^='UploadedImagesSettings-react-component']");
        if (!root) return [];
        const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
        /** @type {Set<string>} */
        const uuids = new Set();

        const maybeExtract = (v) => {
            if (typeof v !== "string") return;
            for (const m of v.matchAll(UUID_RE)) {
                uuids.add(m[0]);
            }
        };

        for (const el of Array.from(root.querySelectorAll("[href],[src],[data-src],[srcset]"))) {
            maybeExtract(el.getAttribute("href"));
            maybeExtract(el.getAttribute("src"));
            maybeExtract(el.getAttribute("data-src"));
            const srcset = el.getAttribute("srcset");
            if (typeof srcset === "string") {
                maybeExtract(srcset);
            }
        }
        return Array.from(uuids);
    });
}

/**
 * Upload a local file via Qiita "uploaded files" settings page and return the new qiita-image-store URL.
 * This avoids touching the article editor (safer).
 *
 * @param {{
 *   page: import("playwright").Page,
 *   logger: any,
 *   localImagePath: string
 * }} params
 */
export async function uploadFileAndGetQiitaImageUrlViaSettings({ page, logger, localImagePath }) {
    // 手順:
    // 1) 一覧ページで “既存URL集合” を取得
    // 2) アップロードページでアップロード
    // 3) ネットワーク or 一覧の差分から “新規URL” を特定して返す
    //
    // 一覧差分方式を取る理由:
    // - UI表示が遅い/順序が変わることがあり、単純に「先頭が新規」とは言えない
    // - 事前集合との差分なら安定して“新規”を判定できる
    const listUrl = await openUploadedFilesListPage(page, logger);
    const beforeList = await collectQiitaImageStoreUrlsFromListPage(page, logger);
    const beforeSet = new Set(beforeList);
    logger.info("Captured existing uploaded image URLs.", { count: beforeSet.size, listUrl });

    const uploadUrl = await openUploadedFilesUploadPage(page, logger);
    logger.info("Opening upload page...", { uploadUrl });

    const input = page.locator("input[type='file']").first();
    if ((await input.count()) === 0) {
        throw new Error("Upload page: file input not found.");
    }

    const localSize = await fs.stat(localImagePath).then((s) => s.size);
    const remainingBytes = await getMonthlyRemainingUploadBytesFromUploadPage(page).catch(() => null);
    if (typeof remainingBytes === "number") {
        if (remainingBytes <= 0) {
            throw new Error("Qiitaの今月の画像アップロード上限に達しています（remaining=0）。不要なファイルを削除するか、次の月までお待ちください。");
        }
        if (localSize > remainingBytes) {
            throw new Error(
                `Qiitaの今月の残りアップロード容量が不足しています（remaining=${remainingBytes} bytes, file=${localSize} bytes）。不要なファイルを削除するか、次の月までお待ちください。`
            );
        }
    }

    // 可能ならネットワークレスポンスから新URLを取得する（高速で、一覧レンダリング待ちを避けられる）。
    const netUrlPromise = waitForQiitaImageStoreUrlFromNetwork(page, logger, { timeoutMs: 8_000, ignoreUrls: beforeSet });

    logger.info("Uploading file via upload page...", { localImagePath });
    const usedFileChooser = await uploadViaFileChooserIfPossible(page, logger, localImagePath);
    if (!usedFileChooser) {
        await input.setInputFiles(localImagePath);
        // Give the page a chance to start the upload.
        await page.waitForTimeout(1500);
    }

    const netUrl = await netUrlPromise.catch(() => null);
    if (typeof netUrl === "string" && isValidQiitaImageStoreUrl(netUrl)) {
        logger.info("Detected uploaded file URL from network.", { url: netUrl });
        return netUrl;
    }

    // After upload, go back to list page and wait for the new URL to appear.
    await page.goto(listUrl, { waitUntil: "domcontentloaded" });
    const localFileName = (() => {
        try {
            return new URL(`file://${localImagePath}`).pathname.split("/").pop() || null;
        } catch {
            return localImagePath.split("/").pop() || null;
        }
    })();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        await assertNotLoggedOut(page);
        await waitForUploadedImagesListReady(page, logger, { timeoutMs: 30_000 });

        if (localFileName) {
            const byNameHeading = page.getByRole("heading", { name: new RegExp(escapeRegExp(localFileName)) }).first();
            if ((await byNameHeading.count()) > 0) {
                const listItem = byNameHeading.locator("..").locator("..").locator("..");
                const link = listItem.locator("a[href^='https://qiita-image-store.s3.']").first();
                const href = await link.getAttribute("href").catch(() => null);
                if (href) {
                    logger.info("Detected uploaded file URL by filename match.", { fileName: localFileName, url: href });
                    return href;
                }
            }
        }

        const afterList = await collectQiitaImageStoreUrlsFromListPage(page, logger, { timeoutMs: 10_000 });
        for (const u of afterList) {
            if (!beforeSet.has(u)) {
                logger.info("Detected uploaded file URL from list page diff.", { url: u });
                return u;
            }
        }
        await page.waitForTimeout(500);
    }

    throw new Error("Timed out waiting for uploaded file URL to appear on list page.");
}

async function waitForQiitaImageStoreUrlFromNetwork(page, logger, { timeoutMs, ignoreUrls }) {
    // アップロード処理中に発生するレスポンスから qiita-image-store URL を見つける。
    // - 直接S3 URLがレスポンスURLとして出る場合
    // - JSONレスポンス本文の中にURLが含まれる場合
    // どちらも拾えるようにする。
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const res = await page
            .waitForResponse(
                (r) => {
                    const url = r.url();
                    if (url.includes("qiita-image-store.s3.")) return true;
                    if (url.includes("/upload") || url.includes("/api/upload")) return true;
                    return false;
                },
                { timeout: 10_000 }
            )
            .catch(() => null);
        if (!res) continue;
        const url = res.url();
        if (url.includes("qiita-image-store.s3.")) {
            if (!isValidQiitaImageStoreUrl(url)) {
                logger.debug?.("upload.network.ignored_invalid_url", { url });
                continue;
            }
            if (ignoreUrls && ignoreUrls.has(url)) {
                logger.debug?.("upload.network.ignored_existing_url", { url });
                continue;
            }
            return url;
        }
        let text = "";
        try {
            text = await res.text();
        } catch {
            text = "";
        }
        const found = extractQiitaImageStoreUrls(text)[0] ?? null;
        if (found) {
            if (!isValidQiitaImageStoreUrl(found)) {
                logger.debug?.("upload.network.ignored_invalid_url", { url: found });
                continue;
            }
            if (ignoreUrls && ignoreUrls.has(found)) {
                logger.debug?.("upload.network.ignored_existing_url", { url: found });
                continue;
            }
            return found;
        }
        logger.debug?.("upload.network.no_url_in_response", { url, status: res.status() });
    }
    return null;
}

async function uploadViaFileChooserIfPossible(page, logger, localImagePath) {
    // The upload page has "画像を選択" button wired to a file chooser.
    // Using filechooser tends to be more reliable than setInputFiles() alone for React uploaders.
    const container = page.locator("[id^='UploadingImagesSettings-react-component']").first();
    const chooseButton = container.getByRole("button", { name: /画像を選択/ }).first();
    if ((await chooseButton.count()) === 0) return false;

    try {
        logger.info("Opening file chooser (upload page)...");
        const [chooser] = await Promise.all([
            page.waitForEvent("filechooser", { timeout: 10_000 }),
            chooseButton.click({ force: true })
        ]);
        await chooser.setFiles(localImagePath);
        await page.waitForTimeout(1500);
        return true;
    } catch (e) {
        logger.warn("File chooser upload failed; falling back to setInputFiles().", { error: String(e) });
        return false;
    }
}

function isValidQiitaImageStoreUrl(url) {
    // Expect full image URL like:
    // https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/143127/<uuid>.png
    return /^https:\/\/qiita-image-store\.s3\.[^/]+\.amazonaws\.com\/0\/\d+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i.test(
        url
    );
}

async function getMonthlyRemainingUploadBytesFromUploadPage(page) {
    return await page.evaluate(() => {
        const el = document.querySelector(
            "script.js-react-on-rails-component[data-component-name='UploadingImagesSettings']"
        );
        if (!el) return null;
        const text = el.textContent || "";
        const json = JSON.parse(text);
        const v = json?.monthlyRemainingImageUploadableSize;
        if (typeof v === "number") return v;
        return null;
    });
}

async function assertNotLoggedOut(page) {
    const url = page.url();
    if (url.includes("/login") || url.includes("oauth")) {
        throw new Error(`Qiitaにログインしていない可能性があります（${url}）。先にブラウザでログインしてください。`);
    }
    const title = await page.title().catch(() => "");
    if (typeof title === "string" && title.toLowerCase().includes("log in")) {
        throw new Error("Qiitaにログインしていない可能性があります（Log inページ）。先にブラウザでログインしてください。");
    }
}

async function waitForUploadedImagesListReady(page, logger, { timeoutMs = 30_000 } = {}) {
    await assertNotLoggedOut(page);

    const heading = page.getByRole("heading", { name: /アップロードしたファイル/ }).first();
    await heading.waitFor({ timeout: timeoutMs });

    const container = page.locator("[id^='UploadedImagesSettings-react-component']").first();
    // ページング中はコンテナが一時的に隠れることがあるため、
    // “visible” ではなく “attached” を条件にする。
    await container.waitFor({ state: "attached", timeout: timeoutMs });

    const startedAt = Date.now();
    let lastBeatAt = 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await assertNotLoggedOut(page);

        const containerVisible = await container.isVisible().catch(() => false);
        // “描画完了” の判定は厳密に取れないため、ヒューリスティックで判断する:
        // - qiita-image-store へのリンクが出ている
        // - 削除ボタンが出ている
        // - 空状態（ありません等）が出ている
        // のいずれかなら “操作しても大丈夫そう” とみなす。
        const linkCount = await container.locator("a[href^='https://qiita-image-store.s3.']").count().catch(() => 0);
        const deleteBtnCount = await container.getByRole("button", { name: /削除|Delete/i }).count().catch(() => 0);
        const emptyStateCount = await container.getByText(/ありません|存在しません/).count().catch(() => 0);

        if (linkCount > 0 || deleteBtnCount > 0 || emptyStateCount > 0) {
            logger.debug?.("uploaded_images.ready", {
                url: page.url(),
                containerVisible,
                linkCount,
                deleteBtnCount,
                emptyStateCount
            });
            return;
        }

        const now = Date.now();
        if (now - lastBeatAt >= 5_000) {
            lastBeatAt = now;
            logger.info("uploaded_images.waiting_list_render", {
                url: page.url(),
                elapsedMs: now - startedAt,
                containerVisible,
                linkCount,
                deleteBtnCount
            });
        }
        await page.waitForTimeout(250);
    }

    // Provide a clearer error than Playwright's "locator resolved to hidden".
    throw new Error(
        `uploaded_images list render timed out after ${timeoutMs}ms (url=${page.url()}).`
    );
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function collectQiitaImageStoreUrlsFromListPage(page, logger, { timeoutMs = 10_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const urls = await page
            .evaluate(() => {
                /** @type {string[]} */
                const out = [];
                const push = (v) => {
                    if (typeof v !== "string") return;
                    if (!v.startsWith("https://qiita-image-store.s3.")) return;
                    out.push(v);
                };
                for (const el of Array.from(document.querySelectorAll("[src],[href],[data-src],[srcset]"))) {
                    push(el.getAttribute("src"));
                    push(el.getAttribute("href"));
                    push(el.getAttribute("data-src"));
                    const srcset = el.getAttribute("srcset");
                    if (typeof srcset === "string") {
                        for (const part of srcset.split(",")) {
                            const u = part.trim().split(/\s+/)[0];
                            push(u);
                        }
                    }
                }
                // Dedupe, preserving order.
                const seen = new Set();
                const ordered = [];
                for (const u of out) {
                    if (seen.has(u)) continue;
                    seen.add(u);
                    ordered.push(u);
                }
                return ordered;
            })
            .catch(() => []);

        if (urls.length > 0) {
            return urls;
        }
        await page.waitForTimeout(250);
    }
    logger.warn("No qiita-image-store URLs found on uploaded images list page (yet).");
    return [];
}

async function openUploadedFilesListPage(page, logger) {
    const candidates = ["https://qiita.com/settings/uploaded_images", "https://qiita.com/settings/uploaded_files"];
    for (const url of candidates) {
        const res = await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => null);
        const status = res?.status?.() ?? null;
        if (status && status >= 200 && status < 300) {
            return url;
        }
        // Some environments don't provide status; fall back to URL heuristic.
        if (!page.url().includes("404") && !page.url().includes("/404")) {
            // Keep trying if we clearly landed on a 404 page by title.
            const title = await page.title().catch(() => "");
            if (typeof title === "string" && !title.includes("404")) {
                return url;
            }
        }
    }
    throw new Error("Failed to open Qiita uploaded files list page (no known URL worked).");
}

async function openUploadedFilesUploadPage(page, logger) {
    const candidates = ["https://qiita.com/settings/uploading_images", "https://qiita.com/settings/uploading_files"];
    for (const url of candidates) {
        const res = await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => null);
        const status = res?.status?.() ?? null;
        if (status && status >= 200 && status < 300) {
            return url;
        }
        const title = await page.title().catch(() => "");
        if (typeof title === "string" && title.length > 0 && !title.includes("404") && !title.includes("Not Found")) {
            // If it looks like a real page, accept it.
            return url;
        }
        logger.warn("Upload page candidate not available.", { url, status, title });
    }
    throw new Error("Failed to open Qiita uploaded files upload page (no known URL worked).");
}

async function goToNextUploadedImagesPageIfExists(
    page,
    logger,
    { pageIndex = null, lastListUrl = null, lastFingerprint = null } = {}
) {
    const ensureUploadedImagesUrl = async (reason) => {
        const url = page.url();
        if (url.startsWith("https://qiita.com/settings/uploaded_images")) {
            return true;
        }
        const expectedNextUrl =
            typeof pageIndex === "number" ? `https://qiita.com/settings/uploaded_images?page=${pageIndex + 1}` : null;
        logger.warn("Paging navigated away from uploaded_images; recovering...", { reason, url, expectedNextUrl });
        if (expectedNextUrl) {
            const resp = await page.goto(expectedNextUrl, { waitUntil: "domcontentloaded" }).catch(() => null);
            const status = resp?.status?.();
            if (typeof status === "number" && status >= 400) {
                logger.warn("Recovery navigation got non-2xx status.", { status, expectedNextUrl });
                return false;
            }
            return page.url().startsWith("https://qiita.com/settings/uploaded_images");
        }
        await page.goto("https://qiita.com/settings/uploaded_images", { waitUntil: "domcontentloaded" }).catch(() => {});
        return page.url().startsWith("https://qiita.com/settings/uploaded_images");
    };

    // pageIndex が分かる場合は URLで次ページへ移動する（決定的で安全）。
    // “次のページ” ボタンはページ内に複数存在し得て、誤クリックで別ページへ飛ぶ事故があるため。
    if (typeof pageIndex === "number") {
        const nextUrl = `https://qiita.com/settings/uploaded_images?page=${pageIndex + 1}`;
        logger.info("Paging to next uploaded images page (goto)...", { nextUrl });
        const resp = await page.goto(nextUrl, { waitUntil: "domcontentloaded" }).catch(() => null);
        const status = resp?.status?.();
        if (typeof status === "number" && status >= 400) {
            logger.warn("Paging by goto returned non-2xx; will try click-based paging.", { status, nextUrl });
        } else {
            const ok = await ensureUploadedImagesUrl("goto");
            if (ok) {
                return true;
            }
            // If we couldn't recover, don't loop forever.
            return false;
        }
    }

    // Try common pagination patterns. Prefer rel=next.
    const relNext = page.locator("a[rel='next']").first();
    if ((await relNext.count()) > 0) {
        const href = await relNext.getAttribute("href").catch(() => null);
        logger.info("Paging to next uploaded images page (rel=next)...", { href });
        await relNext.click().catch(async () => {
            if (href) {
                await page.goto(new URL(href, "https://qiita.com").toString(), { waitUntil: "domcontentloaded" });
            }
        });
        return await ensureUploadedImagesUrl("rel=next");
    }

    // New UI uses buttons for pagination (aria-label="次のページ").
    // IMPORTANT: scope to the UploadedImagesSettings component to avoid clicking unrelated "次のページ" buttons (which can navigate to other pages).
    const root = page.locator("[id^='UploadedImagesSettings-react-component']").first();
    const nextButton = root.getByRole("button", { name: /次のページ/ }).first();
    if ((await nextButton.count()) > 0) {
        const disabled = await nextButton
            .evaluate((el) => /** @type {any} */ (el).disabled ?? el.getAttribute("aria-disabled") === "true")
            .catch(() => false);
        if (disabled) {
            logger.info("Next page button is disabled; stopping paging.");
            return false;
        }
        const beforeUrl = page.url();
        const beforeFp = await getUploadedImagesListFingerprint(page).catch(() => null);

        logger.info("Paging to next uploaded images page (button)...", { beforeUrl });
        await nextButton.click({ force: true }).catch(() => {});

        // Some layouts update the list without changing URL (SPA). Detect both URL change and list fingerprint change.
        const deadline = Date.now() + 12_000;
        let lastBeatAt = 0;
        while (Date.now() < deadline) {
            const nowUrl = page.url();
            // Guard against accidental navigation out of uploaded_images.
            if (!nowUrl.startsWith("https://qiita.com/settings/uploaded_images")) {
                return await ensureUploadedImagesUrl("button-click");
            }
            if (nowUrl !== beforeUrl) {
                return true;
            }
            const nowFp = await getUploadedImagesListFingerprint(page).catch(() => null);
            if (beforeFp && nowFp && nowFp !== beforeFp) {
                return true;
            }
            const now = Date.now();
            if (now - lastBeatAt >= 3_000) {
                lastBeatAt = now;
                logger.info("Paging in progress...", { url: nowUrl });
            }
            await page.waitForTimeout(250);
        }

        const finalUrl = page.url();
        const finalFp = await getUploadedImagesListFingerprint(page).catch(() => null);
        // Guard: if neither URL nor fingerprint changes across pages, avoid infinite loop.
        if (lastListUrl && finalUrl === lastListUrl && lastFingerprint && finalFp && finalFp === lastFingerprint) {
            logger.warn("Next page navigation did not change URL nor list content; stopping paging to avoid loop.", {
                url: finalUrl
            });
            return false;
        }
        // Might still have moved even if we couldn't prove it quickly; allow one more page scan.
        return true;
    }

    const nextByText = page.getByRole("link", { name: /次へ|次の|Next/i }).first();
    if ((await nextByText.count()) > 0) {
        const href = await nextByText.getAttribute("href").catch(() => null);
        logger.info("Paging to next uploaded images page (text)...", { href });
        await nextByText.click().catch(async () => {
            if (href) {
                await page.goto(new URL(href, "https://qiita.com").toString(), { waitUntil: "domcontentloaded" });
            }
        });
        const now = page.url();
        if (lastListUrl && now === lastListUrl) {
            logger.warn("Next page navigation did not change URL; stopping paging to avoid loop.", { url: now });
            return false;
        }
        return await ensureUploadedImagesUrl("text");
    }

    return false;
}

async function getUploadedImagesListFingerprint(page) {
    // Fingerprint the current list by the first few qiita-image-store URLs in the list.
    return await page.evaluate(() => {
        const root = document.querySelector("[id^='UploadedImagesSettings-react-component']");
        if (!root) return null;
        /** @type {string[]} */
        const urls = [];
        const push = (v) => {
            if (typeof v !== "string") return;
            if (!v.startsWith("https://qiita-image-store.s3.")) return;
            urls.push(v);
        };
        for (const el of Array.from(root.querySelectorAll("[href],[src],[data-src],[srcset]"))) {
            push(el.getAttribute("href"));
            push(el.getAttribute("src"));
            push(el.getAttribute("data-src"));
            const srcset = el.getAttribute("srcset");
            if (typeof srcset === "string") {
                for (const part of srcset.split(",")) {
                    const u = part.trim().split(/\s+/)[0];
                    push(u);
                }
            }
        }
        const seen = new Set();
        const first = [];
        for (const u of urls) {
            if (seen.has(u)) continue;
            seen.add(u);
            first.push(u);
            if (first.length >= 8) break;
        }
        if (first.length === 0) return null;
        return first.join("|");
    });
}

async function deleteIfVisibleOnCurrentPage(page, uuid, logger) {
    const startedAt = Date.now();
    const urlAtStart = page.url();
    const step = (name, extra = {}) => {
        logger.info("delete_originals.step", { step: name, uuid, url: page.url(), elapsedMs: Date.now() - startedAt, ...extra });
    };

    // uuid が含まれる要素（href/src/data-src/srcset）をアンカーにして “該当行” を見つける。
    // レイアウトによっては lazy-load で data-src/srcset に入るため、それも対象にする。
    const hitSelector =
        `[href*="${uuid}"],[src*="${uuid}"],[data-src*="${uuid}"],[srcset*="${uuid}"]`;
    let hit = page.locator(hitSelector).first();

    // すぐ見つからない場合は、少しスクロールしてlazy描画を促す。
    if ((await hit.count()) === 0) {
        for (let i = 0; i < 6; i += 1) {
            await page.evaluate((k) => window.scrollTo(0, k * window.innerHeight), i).catch(() => {});
            await page.waitForTimeout(300);
            hit = page.locator(hitSelector).first();
            if ((await hit.count()) > 0) break;
        }
    }
    if ((await hit.count()) === 0) {
        return false;
    }

    step("found_uuid_on_page", { urlAtStart });

    // Best-effort: close overlays that may block clicks.
    await page.keyboard.press("Escape").catch(() => {});
    step("scroll_into_view");
    await hit.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch((e) => {
        logger.warn("delete_originals.scroll_failed", { uuid, url: page.url(), error: String(e) });
    });

    // hit の近傍から削除ボタンを探す。
    step("find_delete_button");
    const scope = hit.locator("xpath=ancestor-or-self::*[self::li or self::tr or self::div][1]");
    const deleteBtn = scope.getByRole("button", { name: /削除|Delete/i }).first();
    if ((await deleteBtn.count()) === 0) {
        // Fallback: search around the hit.
        const fallbackDelete = hit.locator("xpath=ancestor::*[1]").getByRole("button", { name: /削除|Delete/i }).first();
        if ((await fallbackDelete.count()) === 0) {
            logger.warn("Delete button not found near uuid hit.", { uuid });
            return false;
        }
        step("click_delete_button_fallback");
        await fallbackDelete.click({ force: true, timeout: 5_000 }).catch((e) => {
            logger.warn("delete_originals.click_delete_failed", { uuid, url: page.url(), error: String(e) });
            return;
        });
    } else {
        step("click_delete_button");
        // 一部UIは window.confirm() のネイティブダイアログを使う。
        // クリック前に dialog イベントを仕掛けて accept できるようにする（取りこぼし防止）。
        const nativeDialogPromise = page
            .waitForEvent("dialog", { timeout: 3_000 })
            .then(async (d) => {
                logger.info("delete_originals.native_dialog", { uuid, type: d.type(), message: d.message() });
                await d.accept().catch(() => {});
            })
            .catch(() => null);

        await deleteBtn.click({ force: true, timeout: 5_000 }).catch((e) => {
            logger.warn("delete_originals.click_delete_failed", { uuid, url: page.url(), error: String(e) });
            return;
        });
        await nativeDialogPromise;
    }

    // 確認ダイアログが出る場合は、そのダイアログの中のボタンだけを押す。
    // 重要: 画面全体から “削除” 文字列で探して押すと、別要素を誤クリックする危険がある。
    step("confirm_if_needed");
    const modal = page.locator("dialog[open], [role='dialog'], [aria-modal='true']").first();
    const modalVisible = await modal
        .waitFor({ state: "visible", timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
    step("confirm_modal_state", { modalVisible });
    if (modalVisible) {
        // Prefer explicit "削除する" wording, then fall back to broader matches.
        const confirmPrimary = modal.getByRole("button", { name: /削除する|Delete|OK|はい/i }).first();
        const confirmFallback = modal.getByRole("button", { name: /削除|Delete|OK|はい/i }).first();
        const confirm = (await confirmPrimary.count()) > 0 ? confirmPrimary : confirmFallback;
        if ((await confirm.count()) > 0) {
            const confirmText = await confirm.evaluate((el) => (el.innerText ?? "").trim()).catch(() => null);
            step("click_confirm_in_modal", { confirmText });
            await confirm.click({ force: true, timeout: 5_000 }).catch((e) => {
                logger.warn("delete_originals.click_confirm_failed", { uuid, url: page.url(), error: String(e) });
            });
        } else {
            logger.warn("delete_originals.confirm_button_not_found_in_modal", { uuid, url: page.url() });
        }
    }

    // uuid がページから消えるまで待つ（ベストエフォート）。
    step("wait_disappear");
    const deadline = Date.now() + 15_000;
    let lastBeatAt = 0;
    while (Date.now() < deadline) {
        const still = (await page.locator(`a[href*="${uuid}"], img[src*="${uuid}"]`).count().catch(() => 0)) > 0;
        if (!still) {
            logger.info("Deleted uploaded file.", { uuid });
            return true;
        }
        const now = Date.now();
        if (now - lastBeatAt >= 5_000) {
            lastBeatAt = now;
            logger.info("delete_originals.waiting_for_disappear", {
                uuid,
                url: page.url(),
                elapsedMs: now - startedAt
            });
        }
        await page.waitForTimeout(500);
    }

    // UIがすぐ再描画されない場合があるため、1回だけ reload して確認する。
    step("reload_and_recheck");
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await waitForUploadedImagesListReady(page, logger, { timeoutMs: 30_000 }).catch(() => {});
    const stillAfterReload = (await page.locator(`a[href*="${uuid}"], img[src*="${uuid}"]`).count().catch(() => 0)) > 0;
    if (!stillAfterReload) {
        logger.info("Deleted uploaded file (confirmed after reload).", { uuid });
        return true;
    }
    logger.warn("Delete may not have completed (uuid still present).", { uuid });
    return false;
}

function extractQiitaImageStoreUrls(text) {
    const urls = [];
    const re = /https:\/\/qiita-image-store\.s3\.[^\s"'\\)]+/g;
    for (const m of String(text ?? "").matchAll(re)) {
        urls.push(m[0]);
    }
    return urls;
}

function parseQiitaImageKey(url) {
    // Example: https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/143127/xxxxxxxx-....png
    try {
        const u = new URL(url);
        if (!u.hostname.includes("qiita-image-store")) {
            return null;
        }
        const base = path.basename(u.pathname);
        const uuid = base.split(".")[0];
        if (!uuid || uuid.length < 10) {
            return null;
        }
        return uuid;
    } catch {
        return null;
    }
}
