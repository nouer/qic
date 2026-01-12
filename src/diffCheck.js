/**
 * Normalize markdown for stable comparison:
 * - Convert CRLF to LF
 * - Trim trailing spaces on each line
 * - Trim trailing newlines at EOF
 *
 * @param {string} s
 */
function normalizeMarkdown(s) {
    const lf = s.replace(/\r\n/g, "\n");
    const lines = lf.split("\n").map((l) => l.replace(/[ \t]+$/g, ""));
    return lines.join("\n").replace(/\n+$/g, "");
}

/**
 * Verify that the current body equals the original body with ONLY the URL replacements applied.
 *
 * @param {{
 *   originalBody: string,
 *   currentBody: string,
 *   urlMap: Map<string, string>
 * }} params
 */
export function verifyOnlyUrlChanges({ originalBody, currentBody, urlMap }) {
    let expected = originalBody;
    for (const [from, to] of urlMap.entries()) {
        expected = expected.split(from).join(to);
    }

    const nExpected = normalizeMarkdown(expected);
    const nCurrent = normalizeMarkdown(currentBody);

    if (nExpected === nCurrent) {
        return { ok: true, reason: "only_url_changes" };
    }

    // Find first differing position for diagnostics
    const max = Math.min(nExpected.length, nCurrent.length);
    let i = 0;
    for (; i < max; i += 1) {
        if (nExpected[i] !== nCurrent[i]) break;
    }

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

