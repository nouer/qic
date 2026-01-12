import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { createLogger } from "../src/logger.js";

describe("logger", () => {
    test("createLogger: writes to file and does not crash on unserializable data", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qic-logger-"));
        const logFilePath = path.join(dir, "app.log");

        const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
        const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

        const logger = await createLogger({ logFilePath });

        const circular = { a: 1 };
        circular.self = circular;
        logger.info("circular", circular);

        await logger.close();

        const content = await fs.readFile(logFilePath, "utf-8");
        expect(content).toContain("Logger initialized.");
        expect(content).toContain("[INFO] circular");
        expect(content).toContain("<unserializable>");

        consoleLog.mockRestore();
        consoleWarn.mockRestore();
        consoleError.mockRestore();
    });

    test("logger methods: route to correct console function and support undefined data", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qic-logger-"));
        const logFilePath = path.join(dir, "app.log");

        const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
        const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

        const logger = await createLogger({ logFilePath });
        logger.debug("d1");
        logger.info("i1");
        logger.warn("w1");
        logger.error("e1");

        await logger.close();

        expect(consoleLog).toHaveBeenCalled();
        expect(consoleWarn).toHaveBeenCalled();
        expect(consoleError).toHaveBeenCalled();

        const content = await fs.readFile(logFilePath, "utf-8");
        expect(content).toContain("[DEBUG] d1");
        expect(content).toContain("[INFO] i1");
        expect(content).toContain("[WARN] w1");
        expect(content).toContain("[ERROR] e1");

        consoleLog.mockRestore();
        consoleWarn.mockRestore();
        consoleError.mockRestore();
    });
});

