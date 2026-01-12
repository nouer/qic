import fs from "node:fs";
import path from "node:path";
import fsExtra from "fs-extra";

/**
 * @typedef {"debug"|"info"|"warn"|"error"} LogLevel
 */

/**
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

        // console + file
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
            await new Promise((resolve) => stream.end(resolve));
        }
    };

    logger.info("Logger initialized.", { logFilePath });
    return logger;
}

function safeJson(v) {
    try {
        return JSON.stringify(v);
    } catch {
        return "\"<unserializable>\"";
    }
}

