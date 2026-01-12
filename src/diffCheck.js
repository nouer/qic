/**
 * Markdown本文の比較を安定させるための正規化。
 *
 * Qiitaエディタは内部で自動整形・保存・再描画を行うため、
 * 「見た目は同じでもテキストとしては差がある」状態が起こりえます。
 * 一方で、本ツールは **画像URL以外の本文改変を絶対に避けたい** ため、
 * 文字列比較のノイズを抑えた上で安全に差分判定できるようにします。
 *
 * 実施する正規化は以下の3点（意図的に“最小限”）:
 * - CRLF → LF（Windows改行差の吸収）
 * - 各行末の空白/タブ削除（エディタ由来の末尾空白差の吸収）
 * - 末尾の余分な改行削除（EOFの改行数差の吸収）
 *
 * ※ 逆に言うと、本文中の別の変更（文字の追加/削除、行の順序、URL以外の差）を
 *    誤って「同一」とみなさないよう、過剰な正規化は行いません。
 *
 * @param {string} s
 */
function normalizeMarkdown(s) {
    const lf = s.replace(/\r\n/g, "\n");
    const lines = lf.split("\n").map((l) => l.replace(/[ \t]+$/g, ""));
    return lines.join("\n").replace(/\n+$/g, "");
}

/**
 * 「URL置換だけが行われたか？」の検査。
 *
 * 期待する変更は、`urlMap` で指定された from→to の **単純な文字列置換のみ** です。
 * それ以外の変更（例: 本文の一部が消える、別文字が混ざる、順序が変わる等）が起きた場合は
 * 記事の自動更新（submit）を中止するために、失敗理由と差分付近のコンテキストを返します。
 *
 * 重要:
 * - 置換は正規表現ではなく split/join の全件置換（完全一致）で行います。
 *   → URLに含まれる `?` や `&` 等のメタ文字の扱いで事故が起こらないようにするため。
 * - `normalizeMarkdown()` を通してから比較します。
 *   → 改行・行末空白・EOF改行の差は「URL以外の改変」として扱わないため。
 *
 * @param {{
 *   originalBody: string,
 *   currentBody: string,
 *   urlMap: Map<string, string>
 * }} params
 */
export function verifyOnlyUrlChanges({ originalBody, currentBody, urlMap }) {
    // originalBody に対して URL置換を適用した「期待本文」を作る。
    // （実際のエディタ操作がどうであれ、最終的に一致しているべき姿をここで定義する）
    let expected = originalBody;
    for (const [from, to] of urlMap.entries()) {
        expected = expected.split(from).join(to);
    }

    const nExpected = normalizeMarkdown(expected);
    const nCurrent = normalizeMarkdown(currentBody);

    if (nExpected === nCurrent) {
        return { ok: true, reason: "only_url_changes" };
    }

    // 失敗時の診断情報として「最初に違いが出た位置」を探す。
    // これにより、巨大な本文でも diff の“当たり”を付けやすくする。
    const max = Math.min(nExpected.length, nCurrent.length);
    let i = 0;
    for (; i < max; i += 1) {
        if (nExpected[i] !== nCurrent[i]) break;
    }

    // 差分の周辺だけを切り出して返す（ログ/ファイル出力用）。
    // 文字数は“見やすさ”と“個人情報/秘匿情報の過剰出力リスク”のバランスで控えめにしている。
    const contextStart = Math.max(0, i - 120);
    const contextEndExpected = Math.min(nExpected.length, i + 120);
    const contextEndCurrent = Math.min(nCurrent.length, i + 120);

    return {
        ok: false,
        reason: "non_url_change_detected",
        firstDiffIndex: i,
        expectedContext: nExpected.slice(contextStart, contextEndExpected),
        currentContext: nCurrent.slice(contextStart, contextEndCurrent),
        expectedLength: nExpected.length,
        currentLength: nCurrent.length
    };
}

