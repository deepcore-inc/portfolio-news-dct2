'use strict';

/**
 * fetch-sheet.js
 * Google Sheets からニュースデータを取得し data/news-cache.json に保存する
 *
 * 必要な環境変数:
 *   FUND_ID                    - 'dct1' または 'dct2'
 *   SPREADSHEET_ID             - スプレッドシートのID
 *   GOOGLE_SERVICE_ACCOUNT_JSON - サービスアカウントのJSONキー（1行文字列）
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const FUND_ID = process.env.FUND_ID;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

if (!FUND_ID || !SPREADSHEET_ID || !SERVICE_ACCOUNT_JSON) {
  console.error('[ERROR] 必要な環境変数が不足しています: FUND_ID, SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON');
  process.exit(1);
}

if (!['dct1', 'dct2'].includes(FUND_ID)) {
  console.error(`[ERROR] FUND_ID は 'dct1' または 'dct2' である必要があります。現在値: ${FUND_ID}`);
  process.exit(1);
}

// サービスアカウント認証情報をパース
let credentials;
try {
  credentials = JSON.parse(SERVICE_ACCOUNT_JSON);
} catch (e) {
  console.error('[ERROR] GOOGLE_SERVICE_ACCOUNT_JSON のパースに失敗しました:', e.message);
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

/**
 * 対象行かどうかを判定する
 * - No が L 始まりは除外
 * - No が 1000〜2999 のみ対象
 * - Notion載せない が "1" は除外
 * - 掲載月 が空欄は除外
 */
const isTarget = (row) => {
  const no = row['No'];
  const notionExclude = row['Notion載せない'];
  const month = row['掲載月'];

  if (!no) return false;
  if (String(no).startsWith('L')) return false;

  const noNum = parseInt(no, 10);
  if (isNaN(noNum) || !(noNum >= 1000 && noNum < 3000)) return false;

  if (notionExclude === '1') return false;
  if (!month || !month.trim()) return false;

  return true;
};

/**
 * No からファンドIDを返す
 */
const getFund = (no) => {
  const noNum = parseInt(no, 10);
  if (noNum >= 1000 && noNum < 2000) return 'dct1';
  if (noNum >= 2000 && noNum < 3000) return 'dct2';
  return null;
};

/**
 * 日付を YYYY/MM/DD から YYYY.MM.DD に変換
 */
const formatDate = (raw) => {
  if (!raw) return '';
  return raw.trim().replace(/\//g, '.');
};

async function main() {
  console.log(`[INFO] FUND_ID: ${FUND_ID}`);

  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  // スプレッドシートデータを取得
  let response;
  try {
    response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'A:K',
    });
  } catch (e) {
    console.error('[ERROR] スプレッドシートの取得に失敗しました:', e.message);
    process.exit(1);
  }

  const rows = response.data.values;
  if (!rows || rows.length < 2) {
    console.error('[ERROR] スプレッドシートにデータがありません');
    process.exit(1);
  }

  // ヘッダー行からカラムインデックスを構築
  // 列定義（仕様書準拠、位置順）:
  //   A=日付, B=No, C=会社名, D=ステルス, E=タイトル,
  //   F=リンク, G=カテゴリ①, H=カテゴリ②, I=Notion載せない, J=LINKS, K=掲載月
  const COL_DEFAULTS = ['日付', 'No', '会社名', 'ステルス', 'タイトル', 'リンク', 'カテゴリ①', 'カテゴリ②', 'Notion載せない', 'LINKS', '掲載月'];
  const headerRow = rows[0];
  const colIdx = {};

  // まず位置ベースのデフォルトをセット
  COL_DEFAULTS.forEach((name, i) => {
    colIdx[name] = i;
  });

  // ヘッダー行が存在すれば上書き
  headerRow.forEach((h, i) => {
    const trimmed = h.trim();
    if (COL_DEFAULTS.includes(trimmed)) {
      colIdx[trimmed] = i;
    }
  });

  const get = (row, name) => (row[colIdx[name]] !== undefined ? String(row[colIdx[name]]) : '').trim();

  // データ行をオブジェクト配列に変換（ヘッダー行を除く）
  const dataRows = rows.slice(1).map((row) => {
    const obj = {};
    COL_DEFAULTS.forEach((name) => {
      obj[name] = get(row, name);
    });
    return obj;
  });

  // フィルタリング & ファンド振り分け
  const filtered = dataRows
    .filter(isTarget)
    .filter((row) => getFund(row['No']) === FUND_ID);

  // No の昇順にソート（初回投資実行順）
  filtered.sort((a, b) => parseInt(a['No'], 10) - parseInt(b['No'], 10));

  // 掲載月でグループ化
  const byMonth = {};
  for (const row of filtered) {
    const month = row['掲載月'].replace(/\s/g, '');
    if (!byMonth[month]) byMonth[month] = [];
    byMonth[month].push({
      no: row['No'],
      company: row['会社名'],
      cat1: row['カテゴリ①'],
      cat2: row['カテゴリ②'],
      title: row['タイトル'],
      url: row['リンク'],
      date: formatDate(row['日付']),
      img: null, // fetch-ogp.js で補完する
    });
  }

  // data/ ディレクトリを作成
  const dataDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const cachePath = path.join(dataDir, 'news-cache.json');
  fs.writeFileSync(cachePath, JSON.stringify(byMonth, null, 2), 'utf-8');

  const totalItems = Object.values(byMonth).reduce((sum, arr) => sum + arr.length, 0);
  const monthsSorted = Object.keys(byMonth).sort().reverse();
  console.log(`[INFO] ${Object.keys(byMonth).length} ヶ月分、計 ${totalItems} 件を保存しました`);
  console.log(`[INFO] 掲載月一覧: ${monthsSorted.join(', ')}`);
}

main().catch((err) => {
  console.error('[ERROR]', err);
  process.exit(1);
});
