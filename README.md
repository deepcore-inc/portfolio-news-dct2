# portfolio-news-dct2

DEEPCORE DCT-2 ポートフォリオ企業のニュースを自動生成・公開するリポジトリです。

**公開URL**: https://karinyoshida02.github.io/portfolio-news-dct2/

---

## セットアップ手順

### 1. GitHub Secrets の設定

リポジトリの Settings → Secrets and variables → Actions に以下を登録してください。

| Secret名 | 内容 |
|----------|------|
| `SPREADSHEET_ID` | スプレッドシートBのID（URLの `/d/` と `/edit` の間の文字列） |
| `SPREADSHEET_A_ID` | スプレッドシートAのID（ニュース収集DB） |
| `SPREADSHEET_A_SHEET` | スプレッドシートAのシート名（例: `2026年度データベース`）省略時はこの値がデフォルト |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Cloud サービスアカウントのJSONキー（**1行**に整形したJSON文字列）※スプレッドシートBへの**編集権限**が必要 |
| `ANTHROPIC_API_KEY` | Anthropic APIキー |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook URL（確認依頼通知の送信先） |

> ⚠️ **スプレッドシートBのサービスアカウント権限を「閲覧者」→「編集者」に変更してください。**
> sync-sheet.js がスプレッドシートBに書き込むために必要です。
> スプレッドシートAは「閲覧者」のままで構いません。

### 2. Google Sheets API の設定（事前に人間が実施）

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成（または既存を使用）
2. **Google Sheets API** を有効化
3. **サービスアカウント**を作成し、JSONキーをダウンロード
4. スプレッドシートBをサービスアカウントのメールアドレスに「閲覧者」権限で共有

### 3. GitHub Pages の設定

1. リポジトリの Settings → Pages を開く
2. Source: **Deploy from a branch**
3. Branch: `main` / Folder: `/docs`
4. Save

### 4. 手動実行でテスト

Actions タブ → "Generate Portfolio News (DCT-2)" → Run workflow

---

## ワークフロー全体像

```
【毎週月曜 9:00 JST】
sync.yml 自動実行
  ↓
  スプレッドシートA から新着ニュースを取得
  ↓
  スプレッドシートB に未掲載分を追記
  （カテゴリ・Notion載せない は過去データから自動入力）
  ↓
  Slack に確認依頼を送信
        ↓
  ← 担当者がスプレッドシートBで内容を確認・修正 →
        ↓
  Slack の「▶️ HTML生成を実行」ボタンを押す
        ↓
  GitHub Actions で generate.yml を手動実行
  ↓
  fetch-sheet → classify（AI分類） → OGP取得 → HTML生成 → Push → 公開
```

## ファイル構成

```
portfolio-news-dct2/
├── .github/workflows/
│   ├── sync.yml            # 【毎週月曜】スプレッドシートA→B同期 + Slack通知
│   └── generate.yml        # 【手動実行】HTML生成 → GitHub Pages 公開
├── scripts/
│   ├── sync-sheet.js       # スプレッドシートA→B同期 + Slack通知（新規）
│   ├── fetch-sheet.js      # スプレッドシートBからデータ取得
│   ├── classify.js         # Claude API でカテゴリ自動分類
│   ├── fetch-ogp.js        # OGP 画像取得
│   └── generate-html.js    # HTML ファイル生成
├── templates/
│   └── index.template.html # HTML テンプレート
├── docs/                   # GitHub Pages 公開フォルダ
│   ├── index.html          # 最新月のページ
│   └── archives/           # 月別アーカイブ（YYYYMM.html）
├── data/
│   └── news-cache.json     # 生成時の中間データ（コミット対象外）
└── package.json
```

## スプレッドシート仕様

| 列 | カラム名 | 説明 |
|----|---------|------|
| A | 日付 | 公開日（YYYY/MM/DD） |
| B | No | 会社番号（2000番台=DCT-2） |
| C | 会社名 | 会社名 |
| D | ステルス | 非公開フラグ（現在は無視） |
| E | タイトル | ニュースタイトル |
| F | リンク | 記事URL |
| G | カテゴリ① | 大分類（空欄の場合はAIが分類） |
| H | カテゴリ② | 小分類（空欄の場合はAIが分類） |
| I | Notion載せない | "1" の場合は掲載除外 |
| J | LINKS | 無視 |
| K | 掲載月 | YYYYMM形式（例: 202601） |

## ローカルでのテスト

```bash
npm install

# 必要な環境変数をセット
export FUND_ID=dct2
export SPREADSHEET_ID=your_spreadsheet_b_id
export SPREADSHEET_A_ID=your_spreadsheet_a_id
export SPREADSHEET_A_SHEET='2026年度データベース'
export GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
export ANTHROPIC_API_KEY=your_api_key
export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz

# 【ステップ1】スプレッドシートA → B の同期 + Slack 通知
node scripts/sync-sheet.js

# 【ステップ2】スプレッドシートBからデータ取得 → 分類 → OGP → HTML生成
npm run build
# または個別に実行:
npm run fetch      # スプレッドシートBからデータ取得
npm run classify   # Claude API でカテゴリ分類
npm run ogp        # OGP 画像取得
npm run generate   # HTML 生成
```

生成された HTML は `docs/index.html` と `docs/archives/` で確認できます。

## Slack Incoming Webhook の設定方法

1. https://api.slack.com/apps を開く
2. 「Create New App」→「From scratch」でアプリを作成
3. 「Incoming Webhooks」を有効化
4. 「Add New Webhook to Workspace」で通知先チャンネルを選択
5. 発行された `https://hooks.slack.com/services/...` の URL を `SLACK_WEBHOOK_URL` Secret に登録
