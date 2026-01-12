/**
 * Qiita記事URLから item_id を取り出す。
 *
 * 期待する形式:
 * - https://qiita.com/<user>/items/<item_id>
 *
 * 注意:
 * - Qiitaの /drafts/... など別パスはここでは扱わない（編集URL生成の前段として item_id が必要なため）。
 * - URLとしてパースできない入力や、qiita.com 以外は早期に例外にする。
 *
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

    // 例: /<user>/items/<item_id>
    const parts = url.pathname.split("/").filter(Boolean);
    const itemsIdx = parts.indexOf("items");
    if (itemsIdx < 0 || parts.length < itemsIdx + 2) {
        throw new Error(`Cannot parse item_id from URL: ${qiitaArticleUrl}`);
    }

    return parts[itemsIdx + 1];
}

/**
 * item_id から Qiitaの編集画面URL（/edit）を作る。
 *
 * 補足:
 * - 実際のアクセス時には Qiita 側の都合で /drafts/<uuid>/edit にリダイレクトされる場合があるが、
 *   起点は items/<id>/edit で問題ない。
 *
 * @param {string} itemId
 */
export function toQiitaEditUrl(itemId) {
    return `https://qiita.com/items/${encodeURIComponent(itemId)}/edit`;
}

