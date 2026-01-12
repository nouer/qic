import { describe, expect, test } from "vitest";
import { extractImageUrlsFromMarkdown, replaceImageUrls } from "../src/text.js";

describe("text", () => {
    test("extractImageUrlsFromMarkdown: extracts markdown image URLs and de-duplicates", () => {
        const md = `
# title

![alt](https://example.com/a.png)
![alt](<https://example.com/a.png>)
![alt2](https://example.com/b.jpg "title")
![alt3](not-a-url)
`;
        const urls = extractImageUrlsFromMarkdown(md);
        expect(urls.sort()).toEqual(["https://example.com/a.png", "https://example.com/b.jpg"].sort());
    });

    test("extractImageUrlsFromMarkdown: extracts HTML <img src>", () => {
        const md = `<p><img src="https://example.com/c.png" /></p>`;
        expect(extractImageUrlsFromMarkdown(md)).toEqual(["https://example.com/c.png"]);
    });

    test("extractImageUrlsFromMarkdown: ignores non-http(s) urls", () => {
        const md = `![x](ftp://example.com/a.png)\n<img src="mailto:test@example.com">`;
        expect(extractImageUrlsFromMarkdown(md)).toEqual([]);
    });

    test("replaceImageUrls: replaces all occurrences", () => {
        const md = `![x](https://example.com/a.png)\nagain https://example.com/a.png`;
        const map = new Map([["https://example.com/a.png", "https://cdn.example.com/a.png"]]);
        const out = replaceImageUrls(md, map);
        expect(out).toContain("https://cdn.example.com/a.png");
        expect(out).not.toContain("https://example.com/a.png");
    });
});

