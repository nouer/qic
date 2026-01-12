#!/usr/bin/env node
import { Command } from "commander";
import { runQic } from "./qic.js";

/**
 * CLIエントリポイント。
 *
 * このプロジェクト（QIC: Qiita Image Compressor/Optimizer）は、
 * Qiita記事の本文中にある画像URLを対象に
 * 1) 画像をダウンロード
 * 2) 目標サイズ付近まで圧縮（または形式変換）
 * 3) Qiitaへ再アップロード
 * 4) 本文中のURLを新URLへ置換
 * 5) （オプション）元のアップロード済み画像を削除
 * を Playwright で自動化します。
 *
 * ここでは commander を使って、実行時オプションの受け取りとバリデーションを行い、
 * 実処理は `runQic()` に委譲します（CLIは薄く保つ方針）。
 */
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

        // CLI入力の早期バリデーション。
        // ここで落としておくと、Playwright起動やネットワーク処理をする前に
        // ユーザーへ分かりやすいエラーを返せます。
        if (scope !== "all" && scope !== "single") {
            throw new Error("--scope must be 'all' or 'single'");
        }
        if (!Number.isFinite(targetKb) || targetKb <= 0) {
            throw new Error("--target-kb must be a positive number");
        }
        if (!Number.isFinite(concurrency) || concurrency <= 0) {
            throw new Error("--concurrency must be a positive number");
        }

        // headless/headed の扱い:
        // - デフォルトは headed（ブラウザを表示）にして、ログイン等の手動操作ができるようにする。
        // - headless は CI 等で使う想定だが、ログインが必要なケースが多いので
        //   `--storage-state`（ログイン状態の保存/復元）併用を推奨する。
        const headless =
            options.headless === true
                ? true
                : options.headed === true
                    ? false
                    : false; // default: headed

        // storageState は CLI と環境変数のどちらでも指定可能にする。
        // - CLI: --storage-state <path>
        // - env: QIC_STORAGE_STATE_PATH
        // どちらも無ければ null（毎回手動ログインの可能性がある）。
        const storageStatePath = options.storageState ?? process.env.QIC_STORAGE_STATE_PATH ?? null;

        await runQic({
            qiitaArticleUrl,
            scope,
            // 内部は bytes で扱う（Sharp/FS/HTTPは bytes が自然）。
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

