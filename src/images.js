import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import fsExtra from "fs-extra";
import sharp from "sharp";

/**
 * 画像URLをHTTP(S)で取得してローカルへ保存する。
 *
 * なぜ「streamで保存」するのか:
 * - 画像サイズが大きいことがあるため、メモリに全読み込みせずに保存したい
 * - axios の responseType=stream を使うと Node のストリームで安全に書き込める
 *
 * 失敗時は Qiita のS3公開設定等で起こりがちな 403 を特別扱いし、
 * 呼び出し側（`runQic`）で「スキップしてURLを変更しない」判断ができるように
 * `err.code` を付与して投げ直す。
 *
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
        // Qiitaの画像URLでも、設定や期限等によりS3側が AccessDenied(403) を返すことがある。
        // その場合は「最適化できない」だけであり、処理全体を失敗させるのはもったいない。
        // 呼び出し側でスキップできるように分類して返す。
        const code = status === 403 ? "ACCESS_DENIED" : "DOWNLOAD_FAILED";
        const err = new Error(`Failed to download image (${code}): ${url}`);
        err.code = code;
        err.status = status;
        err.url = url;
        throw err;
    }

    // ダウンロードしたストリームをそのままファイルへ保存する。
    await new Promise((resolve, reject) => {
        const w = fs.createWriteStream(outputPath);
        res.data.pipe(w);
        w.on("finish", resolve);
        w.on("error", reject);
        res.data.on("error", reject);
    });

    // 保存後にサイズを確認して返す（呼び出し側で「圧縮すべきか」を判断するため）。
    const stat = await fsExtra.stat(outputPath);
    const contentType = typeof res.headers?.["content-type"] === "string" ? res.headers["content-type"] : null;
    return { byteLength: stat.size, contentType };
}

/**
 * 画像を「目標バイト数（targetBytes）」付近まで圧縮/変換して出力する。
 *
 * 出力形式は **JPEG/PNGのみ**（Qiitaアップロード互換を優先）。
 *
 * ここでの設計方針:
 * - 文字が含まれるスクショ系の可読性を落としにくいよう、まずは縮小せずに品質調整を試す
 * - それでも入らない場合のみ、段階的に縮小（scaleを0.95ずつ）して再探索する
 * - JPEGは透過を持てないため、alphaがある入力は白背景でflattenする
 *
 * 注意:
 * - 「必ずtargetBytes以下にする」ことを最優先にすると、極端な縮小になり可読性が壊れる。
 *   そのため、どうしても入らない場合は “最小限の縮小＋そこそこの品質” で出力し、
 *   パイプラインを止めない方針を取る（呼び出し側でログを見て判断できる）。
 *
 * @param {{ inputPath: string, outputPath: string, targetBytes: number, logger?: any }} params
 */
export async function optimizeImageToTargetBytes({ inputPath, outputPath, targetBytes, logger }) {
    await fsExtra.ensureDir(path.dirname(outputPath));
    const log = logger ?? { info: () => {}, warn: () => {} };

    // 先にメタデータを読むことで、巨大画像でも安全に処理戦略を立てられる。
    const img = sharp(inputPath, { failOn: "none" });
    const meta = await img.metadata();

    const hasAlpha = meta.hasAlpha === true;
    const outputFormat = inferOutputFormat(outputPath);
    if (outputFormat !== "jpeg" && outputFormat !== "png") {
        throw new Error(`Unsupported output format (use .jpg/.jpeg/.png): ${outputPath}`);
    }

    if (!meta.width || !meta.height) {
        // フォールバック:
        // 画像の幅/高さが取れない（壊れた画像・特殊形式等）場合は、resize を絡めると失敗しやすい。
        // そのため「原寸のまま品質だけ」を探索する。
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

    // 探索戦略（重要）:
    // - 可読性維持のため、まずはサイズ（ピクセル）を維持したまま「品質」を二分探索で詰める
    // - それで targetBytes 以下にならない場合のみ、scale を少しずつ下げて再探索する
    // - これにより「必要最小限の劣化」で目標サイズに近づける
    const originalWidth = meta.width;
    const originalHeight = meta.height;

    let bestOverall = null;
    const minScale = 0.55;
    const scaleStep = 0.95;

    for (let scale = 1.0; scale >= minScale; scale = Math.round(scale * scaleStep * 1000) / 1000) {
        const width = Math.max(1, Math.round(originalWidth * scale));
        const height = Math.max(1, Math.round(originalHeight * scale));

        // そのscaleにおける「入る範囲で最も高い品質」を探す。
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
        // 最終手段:
        // どうしても入らない場合でも、パイプラインを止めずに“妥当な見た目”の出力を返す。
        // ここで極端に縮小して無理やり targetBytes に合わせると、文字が潰れて本末転倒になりがち。
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
        // JPEGは透過を持てないため、alphaがある場合は白背景でflattenする。
        // （透明背景のスクショ等で黒背景になる事故を避ける）
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

    // PNG:
    // 文字の輪郭を保ちやすいのでスクショ向き。
    // palette（減色）+ 最大圧縮でサイズを削る。
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
    // Qiitaのアップロード画面が受け付ける拡張子のざっくり判定。
    // ただし実際には content-type / 容量上限 / 月間上限などでも失敗しうるため、
    // ここは「事前に弾きたい拡張子を弾く」程度の用途。
    const ext = path.extname(filePath).toLowerCase();
    return ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif" || ext === ".tiff" || ext === ".avif";
}

async function findBestUnderTarget({ inputPath, outputFormat, hasAlpha, width, height, targetBytes, scale }) {
    // 二分探索で「targetBytes以下に収まる範囲で最も高いquality」を探す。
    // 見つかれば {quality, buffer, ...}、どのqualityでも入らなければ null。
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

