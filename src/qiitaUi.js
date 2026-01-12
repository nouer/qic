/**
 * Qiita editor automation via Playwright.
 *
 * NOTE: Qiita UI can change; selectors here aim to be resilient.
 */

import { uploadFileAndGetQiitaImageUrlViaSettings } from "./qiitaUploadedFilesUi.js";

    /**
     * @typedef {Object} EditorContext
     * @property {() => Promise<string>} getBody
     * @property {(body: string) => Promise<void>} setBody
     * @property {(urlMap: Map<string, string>) => Promise<void>} replaceUrls
     * @property {(localImagePath: string) => Promise<string>} uploadImageAndGetUrl
     */

/**
 * @param {{
 *   page: import("playwright").Page,
 *   context?: import("playwright").BrowserContext,
 *   editUrl: string,
 *   logger?: any,
 *   artifactsDir?: string,
 *   runInEditor: (ctx: EditorContext & { clickUpdate: () => Promise<void> }) => Promise<void>
 * }} params
 */
export async function openQiitaEditorAndRun({ page, context = null, editUrl, logger = null, artifactsDir = null, runInEditor }) {
    page.setDefaultTimeout(120_000);

    const log = logger
        ? logger
        : {
              debug: console.log,
              info: console.log,
              warn: console.warn,
              error: console.error
          };

    if (context && artifactsDir) {
        try {
            await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
            log.info("Playwright tracing started.", { artifactsDir });
        } catch (e) {
            log.warn("Failed to start Playwright tracing.", { error: String(e) });
        }
    }

    attachPlaywrightEventLogs(page, log);

    log.info(`Opening editor: ${editUrl}`);
    await page.goto(editUrl, { waitUntil: "domcontentloaded" });

    // Wait for user to login if needed.
    // If not logged in, Qiita may redirect to login page or show a login prompt.
    try {
        await waitForLoginAndEditorReady(page, editUrl, log);
    } catch (e) {
        await dumpArtifacts(page, context, artifactsDir, "waitForLoginAndEditorReady", log);
        throw e;
    }

    let editor;
    try {
        await ensureWriteTab(page, log);
        editor = await detectEditor(page, log);
    } catch (e) {
        await dumpArtifacts(page, context, artifactsDir, "detectEditor", log);
        throw e;
    }

    const getBody = async () => {
        return await editor.getBody();
    };

    const getBodyLive = async () => {
        if (typeof editor.getBodyLive === "function") {
            return await editor.getBodyLive();
        }
        return await editor.getBody();
    };

    const setBody = async (body) => {
        await editor.setBody(body);
    };

    /**
     * @param {Map<string, string>} urlMap
     */
    const replaceUrls = async (urlMap) => {
        if (typeof editor.replaceUrls === "function") {
            const result = await editor.replaceUrls(urlMap);
            log.info("Replaced URLs in editor (in-place).", result);
            if (result?.ok === true) {
                return;
            }
            log.warn("In-place replace failed; falling back to full rewrite.", result);
        }
        // Fallback: rewrite full body.
        const current = await editor.getBody();
        const out = current;
        let replaced = out;
        for (const [from, to] of urlMap.entries()) {
            replaced = replaced.split(from).join(to);
        }
        await editor.setBody(replaced);
        // Wait until the editor reflects the rewritten body (MUST be live, not the initial React store snapshot).
        const deadline = Date.now() + 15_000;
        const replacedN = normalizeForCompare(replaced);
        let matched = false;
        while (Date.now() < deadline) {
            const now =
                typeof editor.getBodyLive === "function" ? await editor.getBodyLive().catch(() => "") : await editor.getBody();
            if (normalizeForCompare(now) === replacedN) {
                matched = true;
                break;
            }
            await page.waitForTimeout(250);
        }
        if (!matched) {
            throw new Error("URL置換後の本文がエディタに反映されませんでした（全文書き換えフォールバック）。");
        }
        log.info("Replaced URLs in editor (full rewrite fallback).", { rules: urlMap.size });
    };

    const uploadImageAndGetUrl = async (localImagePath) => {
        // Safer strategy: upload via settings page to avoid touching editor content.
        try {
            const currentUrl = page.url();
            const uploadedUrl = await uploadFileAndGetQiitaImageUrlViaSettings({
                page,
                logger: log,
                localImagePath
            });
            // Navigate back to editor and re-detect editor instance.
            await page.goto(currentUrl, { waitUntil: "domcontentloaded" });
            await waitForLoginAndEditorReady(page, editUrl, log);
            await ensureWriteTab(page, log);
            editor = await detectEditor(page, log);
            return uploadedUrl;
        } catch (e) {
            await dumpArtifacts(page, context, artifactsDir, "uploadImageAndGetUrl", log);
            throw e;
        }
    };

    const clickUpdate = async () => {
        try {
            const startedAt = Date.now();
            const step = (name, extra = {}) => {
                log.info("clickUpdate.step", {
                    step: name,
                    url: page.url(),
                    elapsedMs: Date.now() - startedAt,
                    ...extra
                });
            };

            // Ensure we are on editor page (some flows may navigate elsewhere).
            if (!page.url().includes("/edit")) {
                log.warn("Not on edit page; navigating back to edit URL before submit.", { currentUrl: page.url(), editUrl });
                await page.goto(editUrl, { waitUntil: "domcontentloaded" });
                await waitForLoginAndEditorReady(page, editUrl, log);
            }

            step("find_update_button");
            const updateButton = await findUpdateButton(page);
            if (!updateButton) throw new Error("Update button not found.");

            const btnInfo = await updateButton
                .evaluate((el) => ({
                    text: (el.innerText ?? "").trim(),
                    disabled: /** @type {any} */ (el).disabled ?? el.getAttribute("aria-disabled") ?? null
                }))
                .catch(() => null);
            log.info("Clicking submit button...", { button: btnInfo });

            log.info("PHASE: click_submit_button");

            // These can unexpectedly block for a long time; keep them best-effort with short timeouts + logs.
            step("pre_click_scroll_top");
            await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

            step("pre_click_scroll_button_into_view");
            await updateButton
                .scrollIntoViewIfNeeded({ timeout: 5_000 })
                .catch((e) => log.warn("clickUpdate.scrollIntoViewIfNeeded_failed", { error: String(e) }));

            // Close any tooltip/dialog that might block clicks (best-effort).
            step("pre_click_escape");
            await page.keyboard.press("Escape").catch(() => {});

            // IMPORTANT: avoid Playwright actionability checks here; they can hang on Qiita.
            // Prefer clicking the resolved element itself (fast, no actionability), then try a text-based DOM search,
            // and finally fall back to locator.click().
            const outer = await updateButton
                .evaluate((el) => (el.outerHTML ?? "").slice(0, 400))
                .catch(() => null);
            if (outer) {
                log.info("Submit button snapshot.", { outerHtmlHead: outer });
            }

            const clickWithTimeout = async (p, timeoutMs) => {
                return await Promise.race([
                    p.then(() => true),
                    page.waitForTimeout(timeoutMs).then(() => false)
                ]);
            };

            // 1) Click the element itself (usually works even when Playwright click gets stuck).
            step("click_submit_by_element");
            const clickedByElement = await clickWithTimeout(
                updateButton.evaluate((el) => /** @type {any} */ (el).click?.()),
                2000
            ).catch(() => false);
            if (!clickedByElement) {
                // 2) Text-based DOM click (avoids relying on attributes that sometimes differ).
                step("click_submit_by_text");
                const clickedByText = await clickWithTimeout(
                    page.evaluate(() => {
                        const isVisible = (el) => {
                            if (!el) return false;
                            const style = window.getComputedStyle(el);
                            if (style.display === "none" || style.visibility === "hidden") return false;
                            const rect = el.getBoundingClientRect();
                            if (rect.width === 0 || rect.height === 0) return false;
                            return true;
                        };
                        const buttons = Array.from(document.querySelectorAll("button"));
                        const targets = buttons.filter((b) => {
                            const t = (b.innerText ?? "").trim();
                            if (!t) return false;
                            // Primary: "公開設定へ" (Qiita publish settings step)
                            // Fallback: some layouts directly show update/publish.
                            return /公開設定へ|記事を更新する|投稿する|公開する/.test(t);
                        });
                        const visible = targets.find((b) => isVisible(b));
                        const btn = visible ?? targets[0] ?? null;
                        if (!btn) return false;
                        /** @type {any} */ (btn).click?.();
                        return true;
                    }),
                    2000
                ).catch(() => false);
                if (!clickedByText) {
                    // 3) Final fallback: force click (may still fail if page got closed/crashed).
                    log.warn("DOM click() did not run; falling back to locator.click().");
                    step("click_submit_by_locator");
                    await updateButton.click({ force: true, timeout: 8_000, noWaitAfter: true });
                }
            }

            // Wait for either confirmation dialog OR leaving edit page OR "saving" UI.
            step("wait_publish_settings_or_confirm_start");
            const dialog = page.locator("dialog[open]").first();
            const commitMessage = page.locator("#commitMessage, textarea[name='commitMessage']").first();
            await dialog.waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});

            const confirmInDialog = dialog.getByRole("button", { name: /記事を更新する|投稿する|公開する/ }).first();
            const confirmGlobal = page.getByRole("button", { name: /記事を更新する|投稿する|公開する/ }).first();
            const loading = page.getByText(/更新中です|保存中|処理中/).first();

            // Some accounts/layouts take a long time to open the publish settings UI.
            // Keep the user informed while polling.
            const waitStart = Date.now();
            let lastProgressLogAt = 0;
            const maxWaitMs = 180_000;
            while (Date.now() - waitStart < maxWaitMs) {
                if (page.isClosed()) {
                    throw new Error("ページが閉じたため、更新処理を継続できませんでした（clickUpdate中）。");
                }
                const url = page.url();
                if (!url.includes("/edit")) return true;

                const hasConfirm = (await confirmInDialog.count()) > 0 || (await confirmGlobal.count()) > 0;
                const hasLoading = (await loading.count()) > 0;
                if (hasConfirm || hasLoading) break;

                if (Date.now() - lastProgressLogAt > 10_000) {
                    lastProgressLogAt = Date.now();
                    log.info("Waiting for publish settings / confirm UI...", {
                        phase: "wait_publish_settings_or_confirm",
                        elapsedMs: Date.now() - waitStart,
                        url,
                        hasDialog: (await dialog.count()) > 0,
                        hasCommitMessage: (await commitMessage.count()) > 0,
                        hasConfirm: false,
                        hasLoading: false
                    });
                }
                await page.waitForTimeout(500);
            }
            if (Date.now() - waitStart >= maxWaitMs) {
                throw new Error("公開設定（確認）画面の表示待ちがタイムアウトしました。Qiita側のUI/通信状況を確認してください。");
            }

            const confirm =
                (await confirmInDialog.count()) > 0 ? confirmInDialog : (await confirmGlobal.count()) > 0 ? confirmGlobal : null;
            if (confirm) {
                log.info("Clicking confirm button...");
                await confirm.click({ force: true, timeout: 15_000, noWaitAfter: true });
            }

            // Wait until saving finishes or navigation happens.
            const deadline = Date.now() + 120_000;
            while (Date.now() < deadline) {
                const url = page.url();
                if (!url.includes("/edit")) return true;
                if ((await loading.count()) > 0) {
                    await page.waitForTimeout(1000);
                    continue;
                }
                await page.waitForTimeout(1000);
            }
            log.warn("Submit did not navigate away from edit page; please verify in browser.");
            return false;
        } catch (e) {
            await dumpArtifacts(page, context, artifactsDir, "clickUpdate", log);
            throw e;
        }
    };

    await runInEditor({ getBody, getBodyLive, setBody, replaceUrls, uploadImageAndGetUrl, clickUpdate });
}

function normalizeForCompare(s) {
    return String(s ?? "")
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((l) => l.replace(/[ \t]+$/g, ""))
        .join("\n")
        .replace(/\n+$/g, "");
}

async function waitForLoginAndEditorReady(page, editUrl, log) {
    // If redirected to login, user must login manually.
    // We'll wait until we're on the edit URL and editor elements appear.
    const deadline = Date.now() + 15 * 60_000;
    let lastLogAt = 0;
    while (Date.now() < deadline) {
        const url = page.url();
        // Qiita may redirect to /drafts/<uuid>/edit even when opening /items/<uuid>/edit.
        // Match by edit path broadly.
        const onEdit =
            url.includes("/edit") && (url.includes("/items/") || url.includes("/drafts/"));
        if (onEdit) {
            const hasEditor =
                (await findBodyTextarea(page).count()) > 0 ||
                (await page.locator("[contenteditable='true']").count()) > 0;
            if (hasEditor > 0) {
                log.info("Editor detected; continuing.", { url });
                return;
            }
        }

        if (Date.now() - lastLogAt > 2000) {
            lastLogAt = Date.now();
            const textareaCount = await page.locator("textarea").count();
            const ceCount = await page.locator("[contenteditable='true']").count();
            log.info("Waiting for login/editor...", {
                url,
                onEdit,
                textareaCount,
                contentEditableCount: ceCount,
                expectedEditUrl: editUrl
            });
        }
        await page.waitForTimeout(1000);
    }
    throw new Error("Timed out waiting for login/editor readiness. Please login in the opened browser.");
}

async function detectEditor(page, log) {
    const engine = await detectEditorEngine(page);
    if (engine?.kind === "codemirror6") {
        log.info("Using CodeMirror6 editor.");
        return makeCodeMirror6Editor(page);
    }
    if (engine?.kind === "codemirror") {
        log.info("Using CodeMirror editor.");
        return makeCodeMirrorEditor(page);
    }
    if (engine?.kind === "monaco") {
        log.info("Using Monaco editor.");
        return makeMonacoEditor(page);
    }

    // Prefer textarea (common actual form field) because it's easiest to set/get reliably.
    const bestTextarea = await findBestBodyTextarea(page, log);
    if (bestTextarea) {
        log.info("Using textarea editor.", { pickedTextarea: bestTextarea.meta });
        return makeTextareaEditor(bestTextarea.locator);
    }

    // Fallback: contenteditable (less reliable).
    const ce = page.locator("[contenteditable='true']").first();
    if ((await ce.count()) > 0) {
        log.info("Using contenteditable editor.");
        return makeContentEditableEditor(ce);
    }

    throw new Error("Editor not found on page.");
}

function findBodyTextarea(page) {
    // Try likely candidates first; fallback to any textarea.
    const selectors = [
        'textarea[name="body"]',
        'textarea[name="raw_body"]',
        'textarea[id*="body" i]',
        'textarea[name*="body" i]',
        "textarea"
    ];
    return page.locator(selectors.join(", ")).first();
}

async function ensureWriteTab(page, log) {
    // Qiita editor typically has tabs like "本文" / "プレビュー".
    const candidates = [
        page.getByRole("tab", { name: /本文/ }),
        page.getByRole("tab", { name: /Write/i })
    ];
    for (const tab of candidates) {
        if ((await tab.count()) > 0) {
            try {
                await tab.first().click({ timeout: 2000 });
                log.info("Selected write tab.");
                return;
            } catch {
                // ignore
            }
        }
    }
}

async function findBestBodyTextarea(page, log) {
    const handles = await page.locator("textarea").elementHandles();
    if (handles.length === 0) {
        return null;
    }

    /** @type {{ idx: number, name: string|null, id: string|null, len: number }[]} */
    const metas = [];
    for (let i = 0; i < handles.length; i += 1) {
        const h = handles[i];
        try {
            const meta = await h.evaluate((el) => ({
                name: el.getAttribute("name"),
                id: el.getAttribute("id"),
                len: (el.value ?? "").length
            }));
            metas.push({ idx: i, ...meta });
        } catch {
            // ignore
        }
    }

    // Exclude known non-body fields
    const filtered = metas.filter((m) => (m.name ?? "") !== "commitMessage" && (m.id ?? "") !== "commitMessage");
    filtered.sort((a, b) => b.len - a.len);
    log.info("Textarea candidates (top3 by length).", { top: filtered.slice(0, 3) });

    const best = filtered[0];
    if (!best || best.len === 0) {
        return null;
    }

    return {
        locator: page.locator("textarea").nth(best.idx),
        meta: best
    };
}

function makeTextareaEditor(textarea) {
    return {
        async getBody() {
            return await textarea.inputValue();
        },
        async setBody(body) {
            await textarea.click({ timeout: 30_000 });
            await textarea.fill(body);
        }
    };
}

function makeContentEditableEditor(el) {
    return {
        async getBody() {
            return await el.textContent();
        },
        async setBody(body) {
            await el.click({ timeout: 30_000 });
            // Select all and type
            await el.press("Control+A");
            await el.type(body, { delay: 0 });
        }
    };
}

async function detectEditorEngine(page) {
    return await page.evaluate(() => {
        // CodeMirror 6 (Qiita v3 editor)
        const cm6 = document.querySelector(".cm-editor");
        const body = document.querySelector("[data-test-editor-body='true']");
        if (cm6 && body && body.getAttribute("contenteditable") === "true") {
            return { kind: "codemirror6" };
        }

        // CodeMirror
        const cmHost = document.querySelector(".CodeMirror");
        const cm = cmHost && /** @type {any} */ (cmHost).CodeMirror;
        if (cm && typeof cm.getValue === "function" && typeof cm.setValue === "function") {
            return { kind: "codemirror" };
        }

        // Monaco
        const monaco = /** @type {any} */ (globalThis).monaco;
        if (monaco?.editor?.getModels && typeof monaco.editor.getModels === "function") {
            const models = monaco.editor.getModels();
            if (Array.isArray(models) && models.length > 0 && typeof models[0]?.getValue === "function") {
                return { kind: "monaco" };
            }
        }
        return null;
    });
}

function makeCodeMirror6Editor(page) {
    const body = page.locator("[data-test-editor-body='true']").first();
    const cmContent = page.locator(".cm-editor .cm-content[contenteditable='true']").first();
    return {
        async getBody() {
            // Prefer raw markdown from React store (keeps correct newlines).
            const storeBody = await page.evaluate(() => {
                try {
                    const el = document.querySelector("script[data-js-react-on-rails-store='AppStoreWithReactOnRails']");
                    const txt = el?.textContent;
                    if (!txt) return null;
                    const json = JSON.parse(txt);
                    const raw = json?.articleEditor?.article?.rawBody ?? null;
                    if (typeof raw === "string" && raw.length > 0) {
                        return raw;
                    }
                    const orig = json?.articleEditor?.article?.originalRawBody ?? null;
                    if (typeof orig === "string" && orig.length > 0) {
                        return orig;
                    }
                    return null;
                } catch {
                    return null;
                }
            });
            if (typeof storeBody === "string") {
                return storeBody;
            }

            // Fallback: join visual lines with newline.
            const joined = await page.evaluate(() => {
                const lines = Array.from(document.querySelectorAll(".cm-content .cm-line"));
                if (lines.length === 0) return null;
                return lines.map((l) => l.textContent ?? "").join("\n");
            });
            if (typeof joined === "string") {
                return joined;
            }

            // Last resort: innerText.
            return await body.innerText();
        },
        async getBodyLive() {
            // IMPORTANT: CM6 virtualizes the DOM; reading ".cm-line" only gives visible lines.
            // Prefer EditorView.state.doc (full document) if we can reach the view.
            const fromView = await page.evaluate(() => {
                const isView = (v) =>
                    v && typeof v.dispatch === "function" && v.state && v.state.doc && typeof v.state.doc.toString === "function";
                const extractViewFromNode = (n) => {
                    if (!n) return null;
                    if (isView(n.cmView)) return n.cmView;
                    if (isView(n.view)) return n.view;
                    try {
                        for (const k of Object.getOwnPropertyNames(n)) {
                            const v = n[k];
                            if (isView(v)) return v;
                        }
                        for (const s of Object.getOwnPropertySymbols(n)) {
                            const v = n[s];
                            if (isView(v)) return v;
                        }
                    } catch {
                        // ignore
                    }
                    return null;
                };
                const root = document.querySelector(".cm-editor");
                if (!root) return null;
                const nodes = [root, ...root.querySelectorAll("*")];
                for (const n of nodes) {
                    const v = extractViewFromNode(n);
                    if (isView(v)) {
                        return v.state.doc.toString();
                    }
                }
                return null;
            });
            if (typeof fromView === "string" && fromView.length > 0) {
                return fromView;
            }

            // Next best (reliable full markdown): capture autosave request payload (GraphQL SaveEditingArticle).
            // Qiita's CM6 editor virtualizes DOM, but the autosave payload includes full rawBody.
            try {
                if ((await cmContent.count()) > 0) {
                    await cmContent.click({ timeout: 30_000 });
                } else {
                    await body.click({ timeout: 30_000 });
                }

                let last = null;
                for (let i = 0; i < 2; i += 1) {
                    const reqPromise = page.waitForRequest(
                        (req) => {
                            if (req.method() !== "POST") return false;
                            const url = req.url();
                            if (!url.includes("/graphql")) return false;
                            const post = req.postData() ?? "";
                            return post.includes("SaveEditingArticle") && post.includes("\"rawBody\"");
                        },
                        { timeout: 8_000 }
                    );

                    // Trigger autosave without changing content (insert+backspace).
                    await page.keyboard.insertText(" ");
                    await page.keyboard.press("Backspace");

                    const req = await reqPromise;
                    /** @type {any} */
                    let json = null;
                    try {
                        json = req.postDataJSON();
                    } catch {
                        json = null;
                    }
                    const rawBody = json?.variables?.input?.rawBody ?? null;
                    if (typeof rawBody === "string" && rawBody.length > 0) {
                        last = rawBody;
                    }
                    // Slight delay to let the editor flush state if it's lagging.
                    await page.waitForTimeout(250);
                }
                if (typeof last === "string" && last.length > 0) return last;
            } catch {
                // ignore and fall back
            }

            // Last resort: wrapper innerText(). NOTE: This may be partial due to virtualization.
            const fromInnerText = await body.innerText().catch(() => "");
            if (typeof fromInnerText === "string" && fromInnerText.length > 0) {
                return fromInnerText;
            }

            return "";
        },
        async setBody(text) {
            // IMPORTANT: operate on the actual CM contenteditable element (not the wrapper),
            // otherwise Ctrl+A/insertText may be ignored and nothing changes.
            if ((await cmContent.count()) > 0) {
                await cmContent.click({ timeout: 30_000 });
            } else {
                await body.click({ timeout: 30_000 });
            }
            await page.keyboard.press("Control+A");
            await page.keyboard.insertText(text);

            // Confirm set by matching full markdown via autosave payload (GraphQL SaveEditingArticle).
            const deadline = Date.now() + 15_000;
            const expectedN = normalizeForCompare(text);
            let matched = false;
            while (Date.now() < deadline) {
                const reqPromise = page
                    .waitForRequest(
                        (req) => {
                            if (req.method() !== "POST") return false;
                            const url = req.url();
                            if (!url.includes("/graphql")) return false;
                            const post = req.postData() ?? "";
                            return post.includes("SaveEditingArticle") && post.includes("\"rawBody\"");
                        },
                        { timeout: 8_000 }
                    )
                    .catch(() => null);

                // Nudge autosave (no-op)
                await page.keyboard.insertText(" ");
                await page.keyboard.press("Backspace");

                const req = await reqPromise;
                /** @type {any} */
                let json = null;
                if (req) {
                    try {
                        json = req.postDataJSON();
                    } catch {
                        json = null;
                    }
                }
                const rawBody = json?.variables?.input?.rawBody ?? "";
                if (typeof rawBody === "string" && normalizeForCompare(rawBody) === expectedN) {
                    matched = true;
                    break;
                }
                await page.waitForTimeout(250);
            }
            if (!matched) {
                throw new Error("CodeMirror6本文の反映確認に失敗しました（setBody後に一致しません）。");
            }
        },
        /**
         * Replace only the URL substrings inside CodeMirror6 document without rewriting whole body.
         * Requires EditorView to be reachable from DOM (best-effort).
         *
         * @param {Map<string, string>} urlMap
         */
        async replaceUrls(urlMap) {
            const entries = Array.from(urlMap.entries());
            const direct = await page.evaluate((pairs) => {
                const isView = (v) =>
                    v && typeof v.dispatch === "function" && v.state && v.state.doc && typeof v.state.doc.toString === "function";

                const findView = () => {
                    const root = document.querySelector(".cm-editor");
                    if (!root) return null;
                    const extractViewFromNode = (n) => {
                        if (!n) return null;
                        if (isView(n.cmView)) return n.cmView;
                        if (isView(n.view)) return n.view;
                        try {
                            for (const k of Object.getOwnPropertyNames(n)) {
                                const v = n[k];
                                if (isView(v)) return v;
                            }
                            for (const s of Object.getOwnPropertySymbols(n)) {
                                const v = n[s];
                                if (isView(v)) return v;
                            }
                        } catch {
                            // ignore
                        }
                        return null;
                    };
                    const nodes = [root, ...root.querySelectorAll("*")];
                    for (const n of nodes) {
                        const v = extractViewFromNode(n);
                        if (isView(v)) return v;
                    }
                    return null;
                };

                const view = /** @type {any} */ (findView());
                if (!isView(view)) {
                    return { ok: false, reason: "EditorView not found on DOM", replacedCount: 0 };
                }
                const stateDoc = view.state.doc?.toString?.();
                if (typeof stateDoc !== "string") {
                    return { ok: false, reason: "EditorView.state.doc not readable", replacedCount: 0 };
                }

                const doc = stateDoc;
                let replacedCount = 0;
                /** @type {{from:number,to:number,insert:string}[]} */
                const changes = [];
                for (const [fromStr, toStr] of pairs) {
                    if (!fromStr) continue;
                    let idx = doc.indexOf(fromStr);
                    while (idx !== -1) {
                        changes.push({ from: idx, to: idx + fromStr.length, insert: toStr });
                        replacedCount += 1;
                        idx = doc.indexOf(fromStr, idx + fromStr.length);
                    }
                }
                // Apply from end to start so indexes stay valid.
                changes.sort((a, b) => b.from - a.from);
                for (const c of changes) {
                    view.dispatch({ changes: c });
                }
                return { ok: true, replacedCount };
            }, entries);

            if (direct?.ok === true) {
                return direct;
            }

            // IMPORTANT: Do NOT try to use CodeMirror search panel here.
            // It is flaky (browser shortcuts / focus / popup) and can crash the run.
            // Let the caller fall back to full rewrite via setBody(), guarded by diff-check.
            return direct ?? { ok: false, reason: "EditorView not found on DOM", replacedCount: 0 };
        }
    };
}

async function replaceUrlsViaCodeMirrorSearchPanel(page, bodyLocator, urlMap) {
    // Focus actual CM content (Ctrl+H is often captured by the browser as "History", so start with Ctrl+F).
    const cmContent = page.locator(".cm-editor .cm-content[contenteditable='true']").first();
    if ((await cmContent.count()) > 0) {
        await cmContent.click({ timeout: 30_000 });
    } else {
        await bodyLocator.click({ timeout: 30_000 });
    }

    // Open search panel
    await page.keyboard.press("Control+F");

    const panel = page.locator(".cm-panel.cm-search").first();
    await panel.waitFor({ timeout: 10_000 });

    const searchInput = panel.locator("input[name='search']").first();
    // Ensure replace input is visible (some CM panels require toggling replace mode)
    let replaceInput = panel.locator("input[name='replace']").first();
    if ((await replaceInput.count()) === 0) {
        const toggleReplaceBtn = panel.locator("button").filter({ hasText: /replace|置換/i }).first();
        if ((await toggleReplaceBtn.count()) > 0) {
            await toggleReplaceBtn.click({ force: true }).catch(() => {});
        } else {
            await page.keyboard.press("Alt+R").catch(() => {});
        }
        replaceInput = panel.locator("input[name='replace']").first();
    }

    // Best-effort locate "Replace all" button.
    const replaceAllCandidates = [
        panel.locator("button[name='replaceAll']").first(),
        panel.locator("button[name='replaceall']").first(),
        panel.locator("button").filter({ hasText: /replace all/i }).first(),
        panel.locator("button").filter({ hasText: /すべて置換|全て置換|すべて置き換え|全て置き換え/ }).first()
    ];
    let replaceAllButton = null;
    for (const c of replaceAllCandidates) {
        if ((await c.count().catch(() => 0)) > 0) {
            replaceAllButton = c;
            break;
        }
    }

    let total = 0;
    for (const [from, to] of urlMap.entries()) {
        if (!from || from === to) continue;
        await searchInput.fill(from);
        await replaceInput.fill(to).catch(async () => {
            // If replace input is still missing, try Ctrl+H as last resort (may or may not work).
            await page.keyboard.press("Control+H").catch(() => {});
            replaceInput = panel.locator("input[name='replace']").first();
            await replaceInput.fill(to);
        });

        if (replaceAllButton) {
            await replaceAllButton.click({ force: true });
        } else {
            // Keyboard fallback: many CM6 setups bind Alt+Enter to "Replace all"
            await page.keyboard.press("Alt+Enter").catch(() => {});
        }
        total += 1;
        await page.waitForTimeout(150);
    }

    // Close panel (best-effort)
    await page.keyboard.press("Escape").catch(() => {});
    return total;
}

function makeCodeMirrorEditor(page) {
    return {
        async getBody() {
            return await page.evaluate(() => {
                const host = document.querySelector(".CodeMirror");
                const cm = host && /** @type {any} */ (host).CodeMirror;
                return cm ? String(cm.getValue()) : "";
            });
        },
        async setBody(body) {
            await page.evaluate((b) => {
                const host = document.querySelector(".CodeMirror");
                const cm = host && /** @type {any} */ (host).CodeMirror;
                if (!cm) {
                    throw new Error("CodeMirror not found");
                }
                cm.setValue(b);
                cm.focus();
            }, body);
        }
    };
}

function makeMonacoEditor(page) {
    return {
        async getBody() {
            return await page.evaluate(() => {
                const monaco = /** @type {any} */ (globalThis).monaco;
                const models = monaco?.editor?.getModels?.() ?? [];
                if (!Array.isArray(models) || models.length === 0) {
                    return "";
                }
                return String(models[0].getValue());
            });
        },
        async setBody(body) {
            await page.evaluate((b) => {
                const monaco = /** @type {any} */ (globalThis).monaco;
                const models = monaco?.editor?.getModels?.() ?? [];
                if (!Array.isArray(models) || models.length === 0) {
                    throw new Error("Monaco model not found");
                }
                models[0].setValue(b);
            }, body);
        }
    };
}

async function uploadViaAnyImageInput(page, localImagePath, baseBodySnapshot, log) {
    // Collect file inputs for debugging and pick best candidates.
    const all = await page.locator("input[type='file']").elementHandles();
    const metas = [];
    for (const h of all) {
        try {
            // eslint-disable-next-line no-await-in-loop
            metas.push(
                // eslint-disable-next-line no-await-in-loop
                await h.evaluate((el) => ({
                    id: el.getAttribute("id"),
                    name: el.getAttribute("name"),
                    accept: el.getAttribute("accept"),
                    class: el.getAttribute("class"),
                    disabled: el.hasAttribute("disabled"),
                    multiple: el.hasAttribute("multiple")
                }))
            );
        } catch {
            // ignore
        }
    }
    log.info("Detected file input(s).", { count: metas.length, samples: metas.slice(0, 10) });

    const input = page.locator("input[type='file'][accept*='image' i]").first();
    if ((await input.count()) === 0) {
        return null;
    }

    const before = await readAnyEditorText(page);
    const beforeUrls = new Set(extractQiitaImageStoreUrls(before));

    await input.setInputFiles(localImagePath);

    // Detect immediate policy errors (e.g., monthly limit exceeded) to avoid long waits.
    const policyRes = await page
        .waitForResponse((r) => r.url().includes("/api/upload/policies"), { timeout: 10_000 })
        .catch(() => null);
    if (policyRes) {
        const status = policyRes.status();
        if (status >= 400) {
            let body = "";
            try {
                body = await policyRes.text();
            } catch {
                body = "";
            }
            // Typical: {"errors":{"size":["Monthly limit exceeded"]}}
            if (status === 413 && body.includes("Monthly limit exceeded")) {
                throw new Error(
                    "Qiitaの今月の画像アップロード容量上限に達しています（Monthly limit exceeded）。不要な画像を削除するか、翌月まで待つか、方式A（外部ホスティング）を検討してください。"
                );
            }
            // Typical: {"errors":{"content_type":["は一覧にありません"]}}
            if (body.includes("content_type")) {
                throw new Error(`Qiitaが受け付けない画像形式の可能性があります。詳細: ${body}`);
            }
            log.warn("Upload policy request failed.", { status, body: body.slice(0, 500) });
        }
    }

    const url = await waitForNewQiitaImageUrlInBody(page, beforeUrls, log);
    if (url) return url;

    // If no usable file input, try drag&drop onto editor container by dispatching events is complex;
    // we skip for now and rely on file input.
    return null;
}

async function waitForNewQiitaImageUrlInBody(page, beforeUrls, log) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        const current = await readAnyEditorText(page);
        for (const u of extractQiitaImageStoreUrls(current)) {
            if (!beforeUrls.has(u)) {
                log.info("Detected upload URL from body diff.", { url: u });
                return u;
            }
        }
        await page.waitForTimeout(300);
    }
    return null;
}

function extractQiitaImageStoreUrls(text) {
    const urls = [];
    const re = /https:\/\/qiita-image-store\.s3\.[^\s"'\\)]+/g;
    for (const m of text.matchAll(re)) {
        urls.push(m[0]);
    }
    return urls;
}

async function waitForInsertedImageUrl(page, baseBodySnapshot) {
    // Poll editor text; extract the last inserted markdown image url.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        const current = await readAnyEditorText(page);
        if (current && current !== baseBodySnapshot) {
            const diffPart = current.slice(baseBodySnapshot.length);
            const url = extractFirstHttpUrl(diffPart) ?? extractLastMarkdownImageUrl(current);
            if (url) {
                return url;
            }
        }
        await page.waitForTimeout(500);
    }
    return null;
}

async function readAnyEditorText(page) {
    const cm6 = page.locator("[data-test-editor-body='true']").first();
    if ((await cm6.count()) > 0) {
        return await cm6.innerText();
    }
    const textarea = page.locator("textarea").first();
    if ((await textarea.count()) > 0) {
        return await textarea.inputValue();
    }
    const ce = page.locator("[contenteditable='true']").first();
    if ((await ce.count()) > 0) {
        return (await ce.innerText()) ?? "";
    }
    return "";
}

function extractFirstHttpUrl(text) {
    const m = text.match(/https?:\/\/[^\s)>"']+/);
    return m ? m[0] : null;
}

function extractLastMarkdownImageUrl(text) {
    const re = /!\[[^\]]*]\((https?:\/\/\S+?)(?:\s+["'][^"']*["'])?\)/g;
    let last = null;
    for (const m of text.matchAll(re)) {
        last = m[1];
    }
    return last;
}

async function findUpdateButton(page) {
    // New Qiita editor: main submit button has data-test-editor-submit-button
    const submits = page.locator("[data-test-editor-submit-button='true']");
    const submitCount = await submits.count();
    if (submitCount > 0) {
        // There can be multiple buttons (some hidden). Prefer the first visible one.
        for (let i = 0; i < submitCount; i += 1) {
            const b = submits.nth(i);
            // eslint-disable-next-line no-await-in-loop
            if (await b.isVisible().catch(() => false)) {
                return b;
            }
        }
        return submits.first();
    }
    // Fallback: buttons containing "更新" or "Update"
    const candidates = [page.getByRole("button", { name: /更新/ }), page.getByRole("button", { name: /Update/i })];
    for (const loc of candidates) {
        const c = await loc.count();
        if (c > 0) {
            for (let i = 0; i < c; i += 1) {
                const b = loc.nth(i);
                // eslint-disable-next-line no-await-in-loop
                if (await b.isVisible().catch(() => false)) {
                    return b;
                }
            }
            return loc.first();
        }
    }
    return null;
}

async function revertEditorTo(page, editor, before, log) {
    // Try undo a few times first.
    const beforeN = normalizeForCompare(before);
    for (let i = 0; i < 30; i += 1) {
        const current = await editor.getBody();
        if (normalizeForCompare(current) === beforeN) {
            return;
        }
        // Focus editor area if possible.
        const cm6 = page.locator("[data-test-editor-body='true']").first();
        if ((await cm6.count()) > 0) {
            await cm6.click().catch(() => {});
        }
        await page.keyboard.press("Control+Z").catch(() => {});
        await page.waitForTimeout(150);
    }

    log.error("Failed to restore editor body after upload via undo. Aborting to avoid corrupting the draft.");
    throw new Error("Failed to restore editor body after upload (undo). Draftが破損しないよう中止しました。");
}

function attachPlaywrightEventLogs(page, log) {
    page.on("console", (msg) => {
        log.debug("page.console", { type: msg.type(), text: msg.text() });
    });
    page.on("pageerror", (err) => {
        log.warn("page.pageerror", { error: String(err) });
    });
    page.on("requestfailed", (req) => {
        const url = req.url();
        const failure = req.failure();
        const errorText = failure?.errorText ?? "";

        let hostname = "";
        try {
            hostname = new URL(url).hostname;
        } catch {
            hostname = "";
        }

        // Reduce noise: Qiita pages trigger many third-party requests (ads/analytics/etc),
        // and navigations often cause net::ERR_ABORTED which is usually not actionable.
        // Keep WARN for qiita.com / qiita-image-store / upload-related requests.
        const isLikelyActionable =
            hostname === "qiita.com" ||
            hostname.endsWith(".qiita.com") ||
            hostname.includes("qiita-image-store.s3.") ||
            url.includes("://qiita.com/graphql") ||
            url.includes("/api/upload");

        const isAbortNoise = String(errorText).includes("net::ERR_ABORTED");
        const isThirdPartyNoise =
            url.includes("analytics.google.com") ||
            url.includes("googletagmanager.com") ||
            url.includes("google-analytics.com") ||
            url.includes("doubleclick.net") ||
            url.includes("googlesyndication.com") ||
            url.includes("fundingchoicesmessages.google.com") ||
            url.includes("facebook.net") ||
            url.includes("amazon-adsystem.com") ||
            url.includes("impact-ad.jp") ||
            url.includes("logly.co.jp") ||
            url.includes("nidan.d2c.ne.jp") ||
            url.includes("id5-sync.com") ||
            url.includes("4dex.io");

        if (!isLikelyActionable && (isAbortNoise || isThirdPartyNoise)) {
            log.debug?.("page.requestfailed", { url, failure });
            return;
        }

        log.warn("page.requestfailed", { url, failure });
    });
    page.on("response", async (res) => {
        const status = res.status();
        if (status >= 400) {
            const url = res.url();
            /** @type {string|null} */
            let body = null;
            if (url.includes("/api/upload/policies") || url.includes("/api/upload")) {
                try {
                    body = (await res.text()).slice(0, 2000);
                } catch {
                    body = null;
                }
            }
            log.warn("page.response", { url, status, body });
        }
    });
    page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) {
            log.info("page.navigated", { url: frame.url() });
        }
    });
}

async function dumpArtifacts(page, context, artifactsDir, label, log) {
    try {
        if (!artifactsDir) {
            return;
        }
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const prefix = `${ts}-${label}`;
        const screenshotPath = `${artifactsDir}/${prefix}.png`;
        const htmlPath = `${artifactsDir}/${prefix}.html`;
        const tracePath = `${artifactsDir}/${prefix}.zip`;

        const screenshotErr = await page
            .screenshot({ path: screenshotPath, fullPage: true })
            .then(() => null)
            .catch((e) => String(e));
        const html = await page.content().catch(() => null);
        if (html) {
            await (await import("fs-extra")).default.writeFile(htmlPath, html);
        }

        const fsExtra = (await import("fs-extra")).default;
        const screenshotExists = await fsExtra.pathExists(screenshotPath);
        const htmlExists = await fsExtra.pathExists(htmlPath);

        if (context) {
            const traceErr = await context.tracing
                .stop({ path: tracePath })
                .then(() => null)
                .catch((e) => String(e));
            // Restart tracing for continued run, best-effort
            await context.tracing.start({ screenshots: true, snapshots: true, sources: true }).catch(() => {});
            log.info("Tracing stopped.", { tracePath, traceErr });
        }

        log.info("Artifacts dumped.", {
            screenshotPath,
            screenshotExists,
            screenshotErr,
            htmlPath,
            htmlExists,
            tracePath
        });
    } catch (e) {
        log.warn("Failed to dump artifacts.", { error: String(e) });
    }
}
