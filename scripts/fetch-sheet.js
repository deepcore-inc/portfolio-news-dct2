'use strict';

/**
 * fetch-sheet.js
 * スプレッドシートB（NewsReport-LP）からニュースデータを取得し
 * data/news-cache.json に保存する
 *
 * スプレッドシートBのカラム:
 *   日付 | No | 会社名 | ステルス | タイトル | リンク |
 *   カテゴリ① | カテゴリ② | Notion載せない | LINKS | 掲載月
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

// スプレッドシートBのカラム定義
const COL_NAMES = ['日付', 'No', '会社名', 'ステルス', 'タイトル', 'リンク', 'カテゴリ①', 'カテゴリ②', 'Notion載せない', 'LINKS', '掲載月'];

async function main() {
  console.log(`[INFO] FUND_ID: ${FUND_ID}`);

  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  // シート一覧を取得
  let sheetTitle;
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheetList = meta.data.sheets.map(s => s.properties.title);
    console.log('[INFO] シート一覧:', sheetList.join(', '));
    sheetTitle = sheetList.find(t => t.includes('データベース')) || sheetList[0];
    console.log(`[INFO] 使用シート: ${sheetTitle}`);
  } catch (e) {
    console.error('[ERROR] シート情報の取得に失敗しました:', e.message);
    process.exit(1);
  }

  // データ取得
  let rows;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: sheetTitle,
    });
    rows = res.data.values;
  } catch (e) {
    console.error('[ERROR] スプレッドシートの取得に失敗しました:', e.message);
    process.exit(1);
  }

  if (!rows || rows.length < 2) {
    console.error('[ERROR] スプレッドシートにデータがありません');
    process.exit(1);
  }

  // ヘッダーからカラムインデックスを構築
  const headerRow = rows[0];
  const colIdx = {};
  COL_NAMES.forEach((name, i) => { colIdx[name] = i; }); // デフォルト位置
  headerRow.forEach((h, i) => {
    const trimmed = h.trim();
    if (COL_NAMES.includes(trimmed)) colIdx[trimmed] = i;
  });

  console.log('[INFO] 検出された列:', headerRow.map((h, i) => `${String.fromCharCode(65 + i)}=${h}`).join(', '));

  const get = (row, name) => (row[colIdx[name]] !== undefined ? String(row[colIdx[name]]) : '').trim();

  // データ行を処理
  const byMonth = {};
  let totalCount = 0;
  let excludedCount = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const no = get(row, 'No');
    const title = get(row, 'タイトル');
    const url = get(row, 'リンク');
    const month = get(row, '掲載月');

    // 必須フィールドのバリデーション
    if (!no || !title || !url) continue;

    // No の範囲チェック
    if (String(no).startsWith('L')) continue;
    const noNum = parseInt(no, 10);
    if (isNaN(noNum) || noNum < 1000 || noNum >= 3000) continue;

    // FUND_ID でフィルタ（dct1=1000番台、dct2=2000番台）
    const fund = noNum >= 1000 && noNum < 2000 ? 'dct1' : noNum >= 2000 && noNum < 3000 ? 'dct2' : null;
    if (fund !== FUND_ID) continue;

    // 掲載月がない場合は日付からフォールバック
    let yearMonth = month;
    if (!yearMonth) {
      const date = get(row, '日付');
      const m = date.match(/(\d{4})[\/\.\-](\d{1,2})/);
      yearMonth = m ? `${m[1]}${String(m[2]).padStart(2, '0')}` : null;
      if (!yearMonth) {
        console.warn(`[WARN] No=${no} の掲載月を解析できません`);
        continue;
      }
    }

    // Notion載せない = 1 の記事は除外
    const notionExclude = get(row, 'Notion載せない');
    if (notionExclude === '1') {
      excludedCount++;
      continue;
    }

    if (!byMonth[yearMonth]) byMonth[yearMonth] = [];
    byMonth[yearMonth].push({
      no,
      company: get(row, '会社名'),
      cat1: get(row, 'カテゴリ①'),
      cat2: get(row, 'カテゴリ②'),
      title,
      url,
      date: get(row, '日付'),
      img: null,
    });
    totalCount++;
  }

  // No 順でソート
  for (const month of Object.keys(byMonth)) {
    byMonth[month].sort((a, b) => parseInt(a.no, 10) - parseInt(b.no, 10));
  }

  const dataDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const cachePath = path.join(dataDir, 'news-cache.json');
  fs.writeFileSync(cachePath, JSON.stringify(byMonth, null, 2), 'utf-8');

  const monthsSorted = Object.keys(byMonth).sort().reverse();
  console.log(`[INFO] ${Object.keys(byMonth).length} ヶ月分、計 ${totalCount} 件を保存しました`);
  console.log(`[INFO] Notion除外: ${excludedCount} 件`);
  console.log(`[INFO] 掲載月一覧: ${monthsSorted.join(', ')}`);
}

main().catch((err) => {
  console.error('[ERROR]', err);
  process.exit(1);
});
