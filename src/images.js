import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import fsExtra from "fs-extra";
import sharp from "sharp";

/**
 * @param {string} url
 * @param {string} outputPath
 */
export async function downloadImageToFile(url, outputPath) {
    await fsExtra.ensureDir(path.dirname(outputPath));
    let res;
    try {
        res = await axios.get(url, {
            responseType: "stream",
            timeout: 60_000,
            maxRedirects: 5
        });
    } catch (e) {
        const status = e?.response?.status ?? null;
        const code = status === 403 ? "ACCESS_DENIED" : "DOWNLOAD_FAILED";
        const err = new Error(`Failed to download image (${code}): ${url}`);
        err.code = code;
        err.status = status;
        err.url = url;
        throw err;
    }

    await new Promise((resolve, reject) => {
        const w = fs.createWriteStream(outputPath);
        res.data.pipe(w);
        w.on("finish", resolve);
        w.on("error", reject);
        res.data.on("error", reject);
    });

    const stat = await fsExtra.stat(outputPath);
    const contentType = typeof res.headers?.["content-type"] === "string" ? res.headers["content-type"] : null;
    return { byteLength: stat.size, contentType };
}

/**
 * Compress image to near target bytes.
 *
 * Output format: JPEG/PNG (Qiita upload friendly).
 *
 * @param {{ inputPath: string, outputPath: string, targetBytes: number, logger?: any }} params
 */
export async function optimizeImageToTargetBytes({ inputPath, outputPath, targetBytes, logger }) {
    await fsExtra.ensureDir(path.dirname(outputPath));
    const log = logger ?? { info: () => {}, warn: () => {} };

    // Read metadata first to handle huge images.
    const img = sharp(inputPath, { failOn: "none" });
    const meta = await img.metadata();

    const hasAlpha = meta.hasAlpha === true;
    const outputFormat = inferOutputFormat(outputPath);
    if (outputFormat !== "jpeg" && outputFormat !== "png") {
        throw new Error(`Unsupported output format (use .jpg/.jpeg/.png): ${outputPath}`);
    }

    if (!meta.width || !meta.height) {
        // Fallback: if dimensions are unknown, only try quality tuning at full size.
        const best = await findBestUnderTarget({
            inputPath,
            outputFormat,
            hasAlpha,
            width: null,
            height: null,
            targetBytes,
            scale: null
        });
        if (!best) {
            throw new Error(`Failed to optimize image (unknown dimensions): ${inputPath}`);
        }
        await fsExtra.writeFile(outputPath, best.buffer);
        log.info("optimize.result", {
            inputPath,
            outputPath,
            outputFormat,
            original: { width: meta.width, height: meta.height, bytes: meta.size },
            selected: { width: null, height: null, scale: null, quality: best.quality, bytes: best.buffer.byteLength },
            targetBytes
        });
        return;
    }

    // Strategy:
    // - Keep dimensions as large as possible (readability).
    // - Find the BEST (highest) quality that fits under targetBytes.
    // - Only if that fails, shrink scale gradually (0.95x, 0.95x, ...) and retry.
    const originalWidth = meta.width;
    const originalHeight = meta.height;

    let bestOverall = null;
    const minScale = 0.55;
    const scaleStep = 0.95;

    for (let scale = 1.0; scale >= minScale; scale = Math.round(scale * scaleStep * 1000) / 1000) {
        const width = Math.max(1, Math.round(originalWidth * scale));
        const height = Math.max(1, Math.round(originalHeight * scale));

        // Try to keep quality high; search for the maximum quality that fits.
        const bestAtScale = await findBestUnderTarget({
            inputPath,
            outputFormat,
            hasAlpha,
            width,
            height,
            targetBytes,
            scale
        });

        if (bestAtScale) {
            bestOverall = bestAtScale;
            break;
        }
    }

    if (!bestOverall) {
        // As a last resort, return the closest candidate (even if over target) so the pipeline can continue.
        // This prevents extreme downscaling just to "force" a size.
        const fallback = await renderBuffer(inputPath, {
            width: Math.max(1, Math.round(originalWidth * minScale)),
            height: Math.max(1, Math.round(originalHeight * minScale)),
            quality: outputFormat === "jpeg" ? 60 : 70,
            hasAlpha,
            outputFormat
        });
        await fsExtra.writeFile(outputPath, fallback);
        log.warn("optimize.result_fallback_over_target", {
            inputPath,
            outputPath,
            outputFormat,
            original: { width: originalWidth, height: originalHeight, bytes: meta.size },
            selected: {
                width: Math.max(1, Math.round(originalWidth * minScale)),
                height: Math.max(1, Math.round(originalHeight * minScale)),
                scale: minScale,
                quality: outputFormat === "jpeg" ? 60 : 70,
                bytes: fallback.byteLength
            },
            targetBytes
        });
        return;
    }

    await fsExtra.writeFile(outputPath, bestOverall.buffer);
    log.info("optimize.result", {
        inputPath,
        outputPath,
        outputFormat,
        original: { width: originalWidth, height: originalHeight, bytes: meta.size },
        selected: {
            width: bestOverall.width,
            height: bestOverall.height,
            scale: bestOverall.scale,
            quality: bestOverall.quality,
            bytes: bestOverall.buffer.byteLength
        },
        targetBytes
    });
}

async function renderBuffer(inputPath, { width, height, quality, hasAlpha, outputFormat }) {
    const s = sharp(inputPath, { failOn: "none" });
    let pipeline = width && height ? s.resize(width, height, { fit: "inside" }) : s;

    if (outputFormat === "jpeg") {
        // JPEG doesn't support alpha; flatten if needed.
        if (hasAlpha) {
            pipeline = pipeline.flatten({ background: "#ffffff" });
        }
        return pipeline
            .jpeg({
                quality,
                mozjpeg: true
            })
            .toBuffer();
    }

    // PNG: use palette quantization to reduce size while keeping text crisp.
    return pipeline
        .png({
            compressionLevel: 9,
            adaptiveFiltering: true,
            palette: true,
            quality: Math.max(1, Math.min(100, quality)),
            effort: 10
        })
        .toBuffer();
}

function inferOutputFormat(outputPath) {
    const ext = path.extname(outputPath).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg") {
        return "jpeg";
    }
    if (ext === ".png") {
        return "png";
    }
    return "unknown";
}

export function isQiitaUploadSupportedByExtension(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif" || ext === ".tiff" || ext === ".avif";
}

async function findBestUnderTarget({ inputPath, outputFormat, hasAlpha, width, height, targetBytes, scale }) {
    // Returns { quality, buffer } with the HIGHEST quality that is <= targetBytes, or null if none fits.
    const ranges =
        outputFormat === "jpeg"
            ? { qMin: 55, qMax: 95, iterations: 9 }
            : { qMin: 40, qMax: 100, iterations: 9 };

    let low = ranges.qMin;
    let high = ranges.qMax;
    /** @type {{ quality: number, buffer: Buffer, width: number|null, height: number|null, scale: number|null } | null} */
    let best = null;

    for (let i = 0; i < ranges.iterations && low <= high; i += 1) {
        const q = Math.round((low + high) / 2);
        // eslint-disable-next-line no-await-in-loop
        const buf = await renderBuffer(inputPath, { width, height, quality: q, hasAlpha, outputFormat });
        if (buf.byteLength <= targetBytes) {
            best = { quality: q, buffer: buf, width: width ?? null, height: height ?? null, scale: scale ?? null };
            low = q + 1; // try higher quality
        } else {
            high = q - 1; // need smaller
        }
    }

    return best;
}

