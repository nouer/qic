/**
 * @param {string} qiitaArticleUrl
 * @returns {string}
 */
export function parseQiitaItemIdFromUrl(qiitaArticleUrl) {
    let url;
    try {
        url = new URL(qiitaArticleUrl);
    } catch {
        throw new Error(`Invalid URL: ${qiitaArticleUrl}`);
    }

    if (url.hostname !== "qiita.com") {
        throw new Error(`Not a qiita.com URL: ${qiitaArticleUrl}`);
    }

    // /<user>/items/<item_id>
    const parts = url.pathname.split("/").filter(Boolean);
    const itemsIdx = parts.indexOf("items");
    if (itemsIdx < 0 || parts.length < itemsIdx + 2) {
        throw new Error(`Cannot parse item_id from URL: ${qiitaArticleUrl}`);
    }

    return parts[itemsIdx + 1];
}

/**
 * @param {string} itemId
 */
export function toQiitaEditUrl(itemId) {
    return `https://qiita.com/items/${encodeURIComponent(itemId)}/edit`;
}

