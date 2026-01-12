/**
 * Extract image URLs from Markdown/HTML mixed text.
 *
 * Supported:
 * - Markdown image: ![alt](url)
 * - HTML img: <img src="url">
 *
 * @param {string} markdown
 * @returns {string[]}
 */
export function extractImageUrlsFromMarkdown(markdown) {
    const urls = new Set();

    // Markdown image: ![alt](url "title")
    // Very permissive; we'll post-filter with URL parsing.
    const mdImg = /!\[[^\]]*]\((\S+?)(?:\s+["'][^"']*["'])?\)/g;
    for (const match of markdown.matchAll(mdImg)) {
        const raw = match[1].trim();
        const cleaned = stripWrappingBrackets(raw);
        if (isHttpUrl(cleaned)) {
            urls.add(cleaned);
        }
    }

    // HTML <img ... src="...">
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
 * Replace URLs in markdown using the given mapping.
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
    // Handle <https://...> style.
    if (s.startsWith("<") && s.endsWith(">")) {
        return s.slice(1, -1).trim();
    }
    return s;
}

function isHttpUrl(s) {
    try {
        const u = new URL(s);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch {
        return false;
    }
}

