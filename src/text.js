/**
 * Markdown/HTMLが混在する本文から、画像URLを抽出する。
 *
 * 対応する記法:
 * - Markdown画像: ![alt](url "title")
 * - HTML img: <img src="url">
 *
 * ここでの基本方針:
 * - 厳密なMarkdownパーサは使わず、実運用で十分な正規表現で拾う（依存を増やさない）
 * - ただし「拾いすぎ」防止のため、最後に URL としてパースできる http(s) のみ採用する
 * - Setで重複排除（同一URLが複数回出ても1回だけ処理するため）
 *
 * @param {string} markdown
 * @returns {string[]}
 */
export function extractImageUrlsFromMarkdown(markdown) {
    const urls = new Set();

    // Markdown画像: ![alt](url "title")
    // 正規表現はやや緩め（タイトルや括弧などを広く許容）にし、
    // その後 isHttpUrl() で http(s) のみ残す。
    const mdImg = /!\[[^\]]*]\((\S+?)(?:\s+["'][^"']*["'])?\)/g;
    for (const match of markdown.matchAll(mdImg)) {
        const raw = match[1].trim();
        const cleaned = stripWrappingBrackets(raw);
        if (isHttpUrl(cleaned)) {
            urls.add(cleaned);
        }
    }

    // HTML <img ... src="...">
    // Markdown本文にHTMLが混ざるケースを想定（Qiitaでは許容される）。
    const htmlImg = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*?>/gi;
    for (const match of markdown.matchAll(htmlImg)) {
        const raw = match[1].trim();
        if (isHttpUrl(raw)) {
            urls.add(raw);
        }
    }

    return Array.from(urls);
}

/**
 * 本文中のURLを、指定されたマップで一括置換する（完全一致の文字列置換）。
 *
 * 重要:
 * - 正規表現置換ではなく split/join を使うことで、
 *   URL中の `?` `&` `.` などをエスケープし忘れて事故るリスクを避ける。
 * - “URLらしき部分一致”ではなく、元URL文字列そのものだけを置換する。
 *   → 置換範囲を最小にして、本文の意図しない部分を書き換えないため。
 *
 * @param {string} markdown
 * @param {Map<string, string>} urlMap
 * @returns {string}
 */
export function replaceImageUrls(markdown, urlMap) {
    let out = markdown;
    for (const [from, to] of urlMap.entries()) {
        // Exact string replace (all occurrences).
        out = out.split(from).join(to);
    }
    return out;
}

function stripWrappingBrackets(s) {
    // <https://...> のように山括弧で囲われたURL表記を許容する。
    if (s.startsWith("<") && s.endsWith(">")) {
        return s.slice(1, -1).trim();
    }
    return s;
}

function isHttpUrl(s) {
    // URLとしてパースでき、かつ http/https のみ採用する（file: や javascript: を避ける）。
    try {
        const u = new URL(s);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch {
        return false;
    }
}

