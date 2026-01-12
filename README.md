# QIC

Qiita記事の画像をローカルに取得し、**目標サイズ（既定: 500KB）に近づけて再アップロード**し、本文内の画像URLを差し替えて更新するローカルCLIです。

- 画像アップロード/記事更新: **Qiitaの編集UIをPlaywrightで自動操作**します
- 安全策: **URL差し替え以外の本文差分があれば更新しない**（差分を `out/artifacts/` に出力）
- **補足**: Qiita API v2 には「画像のアップロード」「アップロード済み画像の削除」を直接行う公開APIがない（または実用的に利用できない）ため、本ツールは **ブラウザ自動操作（Playwright）**でアップロード/削除を行います。

## 前提

- Node.js 18+ 推奨
- 実行時にブラウザが起動します（既定は表示あり）。GUI環境が必要です
- Qiitaへのログインは **起動時に手動**で行います（2FA対応）

## 運用上の注意（Qiitaの制約）

- **月間の画像アップロード容量が小さい**: Qiita側の表示/仕様として、画像アップロードは **月間上限（目安: 100MB）**があります。大きい画像を何度も上げ直すとすぐ枯渇します。
- **容量を戻すには「アップロードしたファイル」から削除が必要**: 不要になった画像は、Qiitaの `設定 → アップロードしたファイル`（`/settings/uploaded_images`）から削除しないと、月間残容量が回復しません。
- **削除GUIは運用しづらい**: `uploaded_images` は **ページング**で、**検索機能がなく**、初期ロードも重いことがあります（大量に溜まると手作業削除が非常に面倒です）。

## インストール

```bash
npm i
```

Playwright Chromium は `npm i` 後に自動でインストールされます（`postinstall`）。

## 使い方（基本）

```bash
npx qic run "https://qiita.com/<user>/items/<item_id>"
```

起動するとChromiumが開きます。**Qiitaへログインして編集画面が表示されるまで待つ**と、処理が自動で進みます。

## 実行モード（全体/単発）

### 一括（`--scope all`）: 許容上限を超える画像だけ処理

```bash
npx qic run "https://qiita.com/<user>/items/<item_id>" --scope all
```

- **許容上限（後述）を超える画像だけ**を最適化→アップロード→URL差し替えします
- 許容上限を超える画像が1枚もなければ **何もしません**

### 単発（`--scope single`）: 許容上限を超える最初の1枚だけ処理

```bash
npx qic run "https://qiita.com/<user>/items/<item_id>" --scope single
```

- 本文中の画像を上から順に見て、**許容上限を超える最初の1枚だけ**を処理します
- 許容上限を超える画像がなければ **何もしません**

### おすすめの進め方

- まず **`--scope single`** で動作確認（ログイン/更新/削除含む）する
- 問題がなければ **`--scope all`** で記事全体へ適用する

## 目標サイズと許容範囲（+20%）

`--target-kb 500` を指定した場合、厳密な 500KB ではなく **最大 +20% を許容**します。

- **目標**: `targetBytes = 500KB`
- **許容上限**: `targetBytesMax = 500KB * 1.2 = 600KB`

判定/最適化は次の通りです。

- **`<= targetBytesMax`**: 許容範囲（変換不要扱い）
- **`> targetBytesMax`**: 最適化・再アップロード対象

## 2FAを毎回しない（セッション保存）

Qiitaが2FAの場合、Playwrightの `storageState` を保存して再利用できます。

### 初回（手動ログインして保存）

```bash
npx qic run "https://qiita.com/<user>/items/<item_id>" --storage-state ./secret/qic.json --dry-run
```

- `--storage-state` のファイルが存在しない場合でもエラーにせず続行し、終了時に作成します

### 次回以降（保存済みセッションを利用）

```bash
npx qic run "https://qiita.com/<user>/items/<item_id>" --storage-state ./secret/qic.json
```

`--storage-state` が有効でログイン情報が残っていれば、**2FAが有効なアカウントでも毎回の再ログインは不要**になります。

（任意）環境変数でも指定できます:

```bash
export QIC_STORAGE_STATE_PATH=./secret/qic.json
```

## ログ・成果物（解析用）

- 実行ログ: **コンソール** + `out/logs/`（デフォルト）
- 失敗/タイムアウト時の成果物: `out/artifacts/`
  - スクリーンショット（png）
  - HTML（html）
  - Playwright trace（zip）
  - 差分（expected/current）と詳細（diff-check.json）

## オプション一覧

- `--scope <all|single>`: 実行モード（上記）
- `--target-kb <number>`: 目標サイズ（KB）
- `--out <dir>`: 出力先（既定: `./out`）
- `--log-file <path>`: ログファイルパス（指定しない場合は自動生成）
- `--concurrency <number>`: 画像DL/変換の並列数（既定: 4）
- `--headed`: ブラウザ表示（既定）
- `--headless`: ブラウザ非表示（`--storage-state` がある場合に推奨）
- `--storage-state <path>`: Playwrightセッション保存ファイル
- `--dry-run`: 更新ボタンを押さず停止（記事を更新しない）
- `--delete-original`: 記事更新成功後に、元のアップロード済み画像を `/settings/uploaded_images` から削除（ベストエフォート）

## 画像変換（可読性重視）

- JPEG: **品質を可能な限り高く保ち**、収まらない場合だけ **0.95倍ずつ段階的に縮小**
- PNG: PNGのまま出力し、量子化等でサイズを落とす（文字の輪郭を保ちやすい）
- 変換結果はログ `optimize.result` に `scale/解像度/品質/サイズ` が出ます

## 削除（`--delete-original`）の仕様

削除はQiitaの「設定 → アップロードしたファイル」（`/settings/uploaded_images`）をUI操作します。

- ページング/初期ロードが遅いためベストエフォート
- 「ページ内に対象UUIDが含まれるか」を一括判定し、見つかったものだけ削除
- 最終ページまで行っても残っている場合は **1回だけ1ページ目から再走査**（各画像1回のリトライ）

## 安全チェック（URL以外の差分検知）

編集画面を開いた直後の本文Markdownを `out/backups/` に保存し、**保存（更新）直前に「URL差し替え以外の差分が無いこと」を検証**します。  
差分が検出された場合は更新を中止し、`out/artifacts/` に差分ファイルを出力します。

## 設計ドキュメント

- `docs/spec.md`: 仕様書
- `docs/basic-design.md`: 基本設計
- `docs/detailed-design.md`: 詳細設計

## 注意

- QiitaのUI変更により自動化が壊れる可能性があります
- 画像の著作権・再配布可否は利用者が確認してください

## 開発・テスト環境

- Linux: **Ubuntu 24.04 ARM64 Desktop**
- ブラウザ: **Chromium（Playwright）**

## 開発方法について

本プロジェクトは **AIエージェントで開発**しており、ドキュメント/コードを含めて **手書き（人間の直接実装）は一切していません**。

