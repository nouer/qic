# 詳細設計書（QIC）

## 1. CLI仕様

エントリポイントは `src/cli.js`（`package.json` の `bin.qic`）。

- `qic run <qiitaArticleUrl>`
  - `--scope all|single`
  - `--target-kb <number>`（既定: 500）
  - `--out <dir>`（既定: `./out`）
  - `--log-file <path>`
  - `--concurrency <number>`
  - `--storage-state <path>`
  - `--headed/--headless`
  - `--dry-run`
  - `--delete-original`

## 2. 目標サイズと許容上限

`src/qic.js` で以下を計算し、**判定/最適化目標を統一**する。

- `targetBytes = targetKb * 1024`
- `targetToleranceRatio = 0.2`
- `targetBytesMax = targetBytes * (1 + targetToleranceRatio)`

### 対象判定（single/all 共通）

- **`<= targetBytesMax`**: 許容範囲（最適化・再アップロード対象外）
- **`> targetBytesMax`**: 最適化・再アップロード対象

## 3. 画像最適化アルゴリズム（可読性優先）

実装: `src/images.js` の `optimizeImageToTargetBytes()`

### 基本方針

「文字が読めない」問題を避けるため、**解像度を急激に落とさない**。

- まず **品質（quality）を可能な限り高く**保って `targetBytesMax` 以下に収める
- それでも収まらない場合のみ、**scale を 0.95倍ずつ**下げて再試行する

### JPEG

- `findBestUnderTarget()` で「`<= targetBytesMax` を満たす最大quality」を二分探索
- 対象scaleで収まらない場合、scaleを `1.0 → 0.95 → 0.903 ...` と段階的に下げる

### PNG

PNGは文字の輪郭が重要なため、PNGのまま出力しつつ容量を落とす。

- `png({ palette: true, quality, effort: 10, compressionLevel: 9 })`

### 最終結果ログ

`optimize.result` に以下を出す（`src/qic.js` から logger を渡す）。

- `selected.scale / selected.width / selected.height / selected.quality / selected.bytes`
- `targetBytes`

## 4. 本文取得/置換（CodeMirror6）

実装: `src/qiitaUi.js`

### 課題

Qiita編集画面は CodeMirror6 を使っており、DOM上の可視範囲しか読めない場合がある。

### 対応

- **本文取得**:
  - `getBodyLive()` を優先（GraphQL autosaveのpayload等からraw bodyを取得する戦略）
- **URL差し替え**:
  - CodeMirror6 の `EditorView` API に直接 dispatch して置換
  - 失敗時は全文書き換えにフォールバック

## 5. 安全チェック（URL以外の差分検知）

実装: `src/diffCheck.js` / 呼び出し: `src/qic.js`

### 仕様

- 期待本文 = `originalBody` に対して `urlMap` の置換を全適用したもの
- 実本文 = エディタから再取得した `currentBody`
- 上記2つを比較し、**URL置換以外の差分があれば中止**

### 成果物

検知した場合は `out/artifacts/` に出力して中止する。

- `*-expected.md`
- `*-current.md`
- `*-diff-check.json`

## 6. 更新ボタン押下（UI自動化）

実装: `src/qiitaUi.js` の `clickUpdate()`

### 仕様

- 「公開設定へ」→「記事を更新する」の2段階を想定
- UIの状態待ちが長くなるため、ステップログ/ハートビートログを出す
- Playwrightのclickがハングしやすい箇所は `page.evaluate()` のDOMクリックを優先

## 7. 削除（/settings/uploaded_images）設計

実装: `src/qiitaUploadedFilesUi.js`

### 方針

- `/settings/uploaded_images` をページングし、対象UUIDを削除
- **ページ内のUUIDを一括抽出**して「このページに存在するか」を判定（見逃しを減らす）
- ページ描画が遅いことがあるため、ヒット0のページは **1回だけreload→再抽出**
- 最終ページまで行っても残っている場合、**1回だけ1ページ目から再走査**（各UUIDに1回のリトライ）

### ログ

- `delete_originals.pass_start`（パス開始）
- `delete_originals.page_hits`（ページ内UUID数/ヒット数）
- `delete_originals.reached_end`（末尾到達）
- `delete_originals.retry_pass_start`（リトライ開始）

## 8. ディレクトリ/成果物の扱い（Git管理方針）

- 実行時生成物（`out/`, `secret/`, `node_modules/`）はGit管理しない（`.gitignore`）
- 実行のたびに `out/` は生成される（コード側で `ensureDir`）

