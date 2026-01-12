import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";

describe("images (mocked sharp)", () => {
    test("optimizeImageToTargetBytes: unknown dimensions fallback can succeed", async () => {
        vi.resetModules();

        vi.doMock("sharp", () => {
            const sharp = () => {
                const pipeline = {
                    metadata: async () => ({ width: null, height: null, hasAlpha: false, size: 123 }),
                    resize() {
                        return pipeline;
                    },
                    flatten() {
                        return pipeline;
                    },
                    jpeg() {
                        return pipeline;
                    },
                    png() {
                        return pipeline;
                    },
                    toBuffer: async () => Buffer.alloc(100)
                };
                return pipeline;
            };
            return { default: sharp };
        });

        const { optimizeImageToTargetBytes } = await import("../src/images.js");

        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qic-mock-"));
        const inputPath = path.join(dir, "in.any");
        const outputPath = path.join(dir, "out.jpg");
        await fs.writeFile(inputPath, "x");

        await optimizeImageToTargetBytes({ inputPath, outputPath, targetBytes: 150 });
        const outSize = await fs.stat(outputPath).then((s) => s.size);
        expect(outSize).toBe(100);
    });

    test("optimizeImageToTargetBytes: unknown dimensions fallback can fail (no candidate fits)", async () => {
        vi.resetModules();

        vi.doMock("sharp", () => {
            const sharp = () => {
                const pipeline = {
                    metadata: async () => ({ width: null, height: null, hasAlpha: false, size: 123 }),
                    resize() {
                        return pipeline;
                    },
                    flatten() {
                        return pipeline;
                    },
                    jpeg() {
                        return pipeline;
                    },
                    png() {
                        return pipeline;
                    },
                    toBuffer: async () => Buffer.alloc(1000)
                };
                return pipeline;
            };
            return { default: sharp };
        });

        const { optimizeImageToTargetBytes } = await import("../src/images.js");

        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qic-mock-"));
        const inputPath = path.join(dir, "in.any");
        const outputPath = path.join(dir, "out.png");
        await fs.writeFile(inputPath, "x");

        await expect(optimizeImageToTargetBytes({ inputPath, outputPath, targetBytes: 150 })).rejects.toThrow(
            /unknown dimensions/
        );
    });
});

