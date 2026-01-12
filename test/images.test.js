import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { describe, expect, test, vi } from "vitest";

vi.mock("axios", () => {
    return {
        default: {
            get: vi.fn()
        }
    };
});

import axios from "axios";
import sharp from "sharp";
import { downloadImageToFile, isQiitaUploadSupportedByExtension, optimizeImageToTargetBytes } from "../src/images.js";

function makeDeterministicNoiseBuffer(size) {
    const buf = Buffer.alloc(size);
    // LCG for determinism
    let x = 123456789;
    for (let i = 0; i < buf.length; i += 1) {
        x = (1103515245 * x + 12345) >>> 0;
        buf[i] = x & 0xff;
    }
    return buf;
}

describe("images", () => {
    test("isQiitaUploadSupportedByExtension: recognizes supported formats", () => {
        expect(isQiitaUploadSupportedByExtension("a.png")).toBe(true);
        expect(isQiitaUploadSupportedByExtension("a.jpg")).toBe(true);
        expect(isQiitaUploadSupportedByExtension("a.jpeg")).toBe(true);
        expect(isQiitaUploadSupportedByExtension("a.gif")).toBe(true);
        expect(isQiitaUploadSupportedByExtension("a.tiff")).toBe(true);
        expect(isQiitaUploadSupportedByExtension("a.avif")).toBe(true);
        expect(isQiitaUploadSupportedByExtension("a.webp")).toBe(false);
        expect(isQiitaUploadSupportedByExtension("a.txt")).toBe(false);
    });

    test("downloadImageToFile: writes stream to disk and returns size/contentType", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qic-dl-"));
        const outputPath = path.join(dir, "x.png");

        const payload = Buffer.from("hello");
        axios.get.mockResolvedValueOnce({
            data: Readable.from([payload]),
            headers: { "content-type": "image/png" }
        });

        const res = await downloadImageToFile("https://example.com/x.png", outputPath);
        expect(res.byteLength).toBe(payload.byteLength);
        expect(res.contentType).toBe("image/png");
        const file = await fs.readFile(outputPath);
        expect(file.equals(payload)).toBe(true);
    });

    test("downloadImageToFile: returns null contentType when header missing", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qic-dl-"));
        const outputPath = path.join(dir, "x.bin");

        const payload = Buffer.from("abc");
        axios.get.mockResolvedValueOnce({
            data: Readable.from([payload]),
            headers: {}
        });

        const res = await downloadImageToFile("https://example.com/x.bin", outputPath);
        expect(res.byteLength).toBe(payload.byteLength);
        expect(res.contentType).toBe(null);
    });

    test("downloadImageToFile: throws ACCESS_DENIED on 403", async () => {
        axios.get.mockRejectedValueOnce({ response: { status: 403 } });
        await expect(downloadImageToFile("https://example.com/forbidden.png", "/tmp/never.png")).rejects.toMatchObject({
            code: "ACCESS_DENIED",
            status: 403
        });
    });

    test("downloadImageToFile: throws DOWNLOAD_FAILED on other errors", async () => {
        axios.get.mockRejectedValueOnce({ response: { status: 500 } });
        await expect(downloadImageToFile("https://example.com/fail.png", "/tmp/never.png")).rejects.toMatchObject({
            code: "DOWNLOAD_FAILED",
            status: 500
        });
    });

    test("optimizeImageToTargetBytes: produces output <= targetBytes for JPEG", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qic-opt-"));
        const inputPath = path.join(dir, "in.jpg");
        const outputPath = path.join(dir, "out.jpg");

        const width = 900;
        const height = 900;
        const raw = makeDeterministicNoiseBuffer(width * height * 3);

        await sharp(raw, { raw: { width, height, channels: 3 } })
            .jpeg({ quality: 95 })
            .toFile(inputPath);

        const targetBytes = 120_000;
        await optimizeImageToTargetBytes({ inputPath, outputPath, targetBytes });

        const outSize = await fs.stat(outputPath).then((s) => s.size);
        expect(outSize).toBeLessThanOrEqual(targetBytes);
    });

    test("optimizeImageToTargetBytes: flattens alpha when output is JPEG", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qic-opt-"));
        const inputPath = path.join(dir, "in.png");
        const outputPath = path.join(dir, "out.jpg");

        const width = 400;
        const height = 400;
        const raw = makeDeterministicNoiseBuffer(width * height * 4);

        await sharp(raw, { raw: { width, height, channels: 4 } })
            .png()
            .toFile(inputPath);

        const targetBytes = 90_000;
        await optimizeImageToTargetBytes({ inputPath, outputPath, targetBytes });
        const meta = await sharp(outputPath).metadata();
        expect(meta.format).toBe("jpeg");
    });

    test("optimizeImageToTargetBytes: produces output <= targetBytes for PNG", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qic-opt-"));
        const inputPath = path.join(dir, "in.png");
        const outputPath = path.join(dir, "out.png");

        const width = 600;
        const height = 600;
        const raw = makeDeterministicNoiseBuffer(width * height * 3);

        await sharp(raw, { raw: { width, height, channels: 3 } })
            .png({ compressionLevel: 0 })
            .toFile(inputPath);

        const targetBytes = 180_000;
        await optimizeImageToTargetBytes({ inputPath, outputPath, targetBytes });

        const outSize = await fs.stat(outputPath).then((s) => s.size);
        expect(outSize).toBeLessThanOrEqual(targetBytes);
    });

    test("optimizeImageToTargetBytes: supports .jpeg extension output", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qic-opt-"));
        const inputPath = path.join(dir, "in.png");
        const outputPath = path.join(dir, "out.jpeg");

        await sharp({
            create: { width: 300, height: 300, channels: 3, background: { r: 1, g: 2, b: 3 } }
        })
            .png()
            .toFile(inputPath);

        await optimizeImageToTargetBytes({ inputPath, outputPath, targetBytes: 50_000 });
        const meta = await sharp(outputPath).metadata();
        expect(meta.format).toBe("jpeg");
    });

    test("optimizeImageToTargetBytes: throws on unsupported output extension", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qic-opt-"));
        const inputPath = path.join(dir, "in.png");
        const outputPath = path.join(dir, "out.webp");

        await sharp({
            create: { width: 10, height: 10, channels: 3, background: { r: 10, g: 20, b: 30 } }
        })
            .png()
            .toFile(inputPath);

        await expect(optimizeImageToTargetBytes({ inputPath, outputPath, targetBytes: 1000 })).rejects.toThrow(
            /Unsupported output format/
        );
    });

    test("optimizeImageToTargetBytes: can hit fallback path when target is impossibly small", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qic-opt-"));
        const inputPath = path.join(dir, "in.png");
        const outputPath = path.join(dir, "out.png");

        const width = 300;
        const height = 300;
        const raw = makeDeterministicNoiseBuffer(width * height * 3);
        await sharp(raw, { raw: { width, height, channels: 3 } })
            .png({ compressionLevel: 0 })
            .toFile(inputPath);

        // Very small target to encourage fallback writing.
        await optimizeImageToTargetBytes({ inputPath, outputPath, targetBytes: 128 });
        const outSize = await fs.stat(outputPath).then((s) => s.size);
        expect(outSize).toBeGreaterThan(0);
    });
});

