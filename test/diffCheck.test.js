import { describe, expect, test } from "vitest";
import { verifyOnlyUrlChanges } from "../src/diffCheck.js";

describe("diffCheck", () => {
    test("verifyOnlyUrlChanges: ok when only URL changes", () => {
        const originalBody = "line1\r\n![a](https://old)\r\nline3  \r\n";
        const currentBody = "line1\n![a](https://new)\nline3\n";
        const urlMap = new Map([["https://old", "https://new"]]);
        const res = verifyOnlyUrlChanges({ originalBody, currentBody, urlMap });
        expect(res.ok).toBe(true);
        expect(res.reason).toBe("only_url_changes");
    });

    test("verifyOnlyUrlChanges: detects non-url change and returns context", () => {
        const originalBody = "hello\n![a](https://old)\nworld\n";
        const currentBody = "HELLO\n![a](https://new)\nworld\n";
        const urlMap = new Map([["https://old", "https://new"]]);
        const res = verifyOnlyUrlChanges({ originalBody, currentBody, urlMap });
        expect(res.ok).toBe(false);
        expect(res.reason).toBe("non_url_change_detected");
        expect(res.firstDiffIndex).toBeGreaterThanOrEqual(0);
        expect(res.expectedContext).toContain("hello");
        expect(res.currentContext).toContain("HELLO");
    });

    test("verifyOnlyUrlChanges: detects length-only differences (expected longer/shorter)", () => {
        const urlMap = new Map([["https://old", "https://new"]]);

        const originalBody = "a\n![x](https://old)\n";
        const currentBodyMissing = "a\n"; // missing the URL line entirely
        const res1 = verifyOnlyUrlChanges({ originalBody, currentBody: currentBodyMissing, urlMap });
        expect(res1.ok).toBe(false);

        const currentBodyExtra = "a\n![x](https://new)\nextra\n";
        const res2 = verifyOnlyUrlChanges({ originalBody, currentBody: currentBodyExtra, urlMap });
        expect(res2.ok).toBe(false);
    });
});

