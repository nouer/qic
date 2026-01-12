import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";

describe("images (mocked sharp): force jpeg fallback branch", () => {
    test("optimizeImageToTargetBytes: when nothing fits, uses fallback branch for JPEG output", async () => {
        vi.resetModules();

        // Force: known dimensions, but every renderBuffer call returns a buffer larger than targetBytes.
        // This makes bestOverall null and executes the fallback path.
        vi.doMock("sharp", () => {
            const sharp = () => {
                const pipeline = {
                    metadata: async () => ({ width: 100, height: 100, hasAlpha: false, size: 999 }),
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
        const outputPath = path.join(dir, "out.jpg");
        await fs.writeFile(inputPath, "x");

        // Very small target that can never be met by our mocked buffers.
        await optimizeImageToTargetBytes({ inputPath, outputPath, targetBytes: 10 });
        const outSize = await fs.stat(outputPath).then((s) => s.size);
        expect(outSize).toBe(1000);
    });
});

