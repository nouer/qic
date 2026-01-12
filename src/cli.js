#!/usr/bin/env node
import { Command } from "commander";
import { runQic } from "./qic.js";

const program = new Command();

program.name("qic").description("Qiita image optimizer via Playwright").version("0.1.0");

program
    .command("run")
    .argument("<qiitaArticleUrl>", "Qiita article URL: https://qiita.com/<user>/items/<item_id>")
    .option("--scope <scope>", "process scope: all|single (default: all)", "all")
    .option("--target-kb <number>", "target size (KB), default: 500", "500")
    .option("--out <dir>", "output directory, default: ./out", "./out")
    .option("--log-file <path>", "log file path (default: <out>/logs/qic-<timestamp>.log)")
    .option("--concurrency <number>", "download/convert concurrency, default: 4", "4")
    .option(
        "--storage-state <path>",
        "Playwright storageState path (can also be set via env: QIC_STORAGE_STATE_PATH)"
    )
    .option("--headed", "run with visible browser (default)", false)
    .option("--headless", "run headless (recommended only with --storage-state)", false)
    .option("--dry-run", "do not click update button", false)
    .option("--delete-original", "after successful update, delete original uploaded images (DANGEROUS)", false)
    .action(async (qiitaArticleUrl, options) => {
        const scope = String(options.scope ?? "all");
        const targetKb = Number(options.targetKb);
        const concurrency = Number(options.concurrency);

        if (scope !== "all" && scope !== "single") {
            throw new Error("--scope must be 'all' or 'single'");
        }
        if (!Number.isFinite(targetKb) || targetKb <= 0) {
            throw new Error("--target-kb must be a positive number");
        }
        if (!Number.isFinite(concurrency) || concurrency <= 0) {
            throw new Error("--concurrency must be a positive number");
        }

        const headless =
            options.headless === true
                ? true
                : options.headed === true
                    ? false
                    : false; // default: headed

        const storageStatePath = options.storageState ?? process.env.QIC_STORAGE_STATE_PATH ?? null;

        await runQic({
            qiitaArticleUrl,
            scope,
            targetBytes: Math.round(targetKb * 1024),
            outDir: options.out,
            logFilePath: options.logFile ?? null,
            concurrency,
            playwright: {
                headless,
                storageStatePath
            },
            dryRun: options.dryRun === true,
            deleteOriginal: options.deleteOriginal === true
        });
    });

program.parseAsync(process.argv).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err?.stack ?? String(err));
    process.exitCode = 1;
});

