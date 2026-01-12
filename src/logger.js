import fs from "node:fs";
import path from "node:path";
import fsExtra from "fs-extra";

/**
 * @typedef {"debug"|"info"|"warn"|"error"} LogLevel
 */

/**
 * シンプルなロガーを生成する（console + ファイル追記）。
 *
 * なぜ自前実装か:
 * - CLIツールとして依存を増やしすぎない
 * - 実行ログを「後から検証できる形」で残したい（Playwrightの自動操作は失敗時の再現が難しい）
 * - JSONの構造化ログで、後から grep/集計しやすくしたい
 *
 * 仕様:
 * - 1行 = 1ログ（ISO時刻 + レベル + メッセージ + optional JSON）
 * - data は JSON.stringify できない場合があるため、safeJson で保護する
 * - close() を呼ぶことでファイルストリームを確実に閉じる（CI/Windows等で重要）
 *
 * @param {{ logFilePath: string }} params
 */
export async function createLogger({ logFilePath }) {
    await fsExtra.ensureDir(path.dirname(logFilePath));
    const stream = fs.createWriteStream(logFilePath, { flags: "a" });

    /**
     * @param {LogLevel} level
     * @param {string} message
     * @param {any=} data
     */
    const write = (level, message, data) => {
        const ts = new Date().toISOString();
        const line =
            data === undefined
                ? `${ts} [${level.toUpperCase()}] ${message}`
                : `${ts} [${level.toUpperCase()}] ${message} | ${safeJson(data)}`;

        // console + file の両方に出す:
        // - 実行中は進捗を標準出力で把握したい
        // - 失敗時はファイルログ（タイムスタンプ付き）で時系列を追いたい
        // eslint-disable-next-line no-console
        (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
        stream.write(line + "\n");
    };

    const logger = {
        logFilePath,
        debug: (message, data) => write("debug", message, data),
        info: (message, data) => write("info", message, data),
        warn: (message, data) => write("warn", message, data),
        error: (message, data) => write("error", message, data),
        async close() {
            // stream.end は「バッファがflushされてから終了」を保証するため Promise 化して待つ。
            await new Promise((resolve) => stream.end(resolve));
        }
    };

    logger.info("Logger initialized.", { logFilePath });
    return logger;
}

function safeJson(v) {
    // JSON化できない（循環参照など）データが来てもロガー自体は落とさない。
    try {
        return JSON.stringify(v);
    } catch {
        return "\"<unserializable>\"";
    }
}

