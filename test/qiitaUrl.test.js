import { describe, expect, test } from "vitest";
import { parseQiitaItemIdFromUrl, toQiitaEditUrl } from "../src/qiitaUrl.js";

describe("qiitaUrl", () => {
    test("parseQiitaItemIdFromUrl: extracts item_id", () => {
        const id = parseQiitaItemIdFromUrl("https://qiita.com/user/items/12fceb78768613255f15");
        expect(id).toBe("12fceb78768613255f15");
    });

    test("parseQiitaItemIdFromUrl: rejects invalid URL", () => {
        expect(() => parseQiitaItemIdFromUrl("not-a-url")).toThrow(/Invalid URL/);
    });

    test("parseQiitaItemIdFromUrl: rejects non-qiita host", () => {
        expect(() => parseQiitaItemIdFromUrl("https://example.com/user/items/abc")).toThrow(/Not a qiita\.com URL/);
    });

    test("parseQiitaItemIdFromUrl: rejects unparseable path", () => {
        expect(() => parseQiitaItemIdFromUrl("https://qiita.com/user/abc")).toThrow(/Cannot parse item_id/);
    });

    test("toQiitaEditUrl: builds edit url with encoding", () => {
        expect(toQiitaEditUrl("a b")).toBe("https://qiita.com/items/a%20b/edit");
    });
});

