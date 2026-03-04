'use strict';

/**
 * fetch-sheet.js
 * Google Sheets からニュースデータを取得し data/news-cache.json に保存する
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

const isTarget = (row) => {
  const no = row['No'];
  const publicDate = row['公開日'];
  if (!no) return false;
  if (String(no).startsWith('L')) return false;
  const noNum = parseInt(no, 10);
  if (isNaN(noNum) || !(noNum >= 1000 && noNum < 3000)) return false;
  if (!publicDate || !publicDate.trim()) return false;
  return true;
};

const getFund = (no) => {
  const noNum = parseInt(no, 10);
  if (noNum >= 1000 && noNum < 2000) return 'dct1';
  if (noNum >= 2000 && noNum < 3000) return 'dct2';
  return null;
};

const getYearMonth = (raw) => {
  if (!raw) return null;
  const match = raw.trim().match(/^(\d{4})\/(\d{2})/);
  if (!match) return null;
  return `${match[1]}${match[2]}`;
};

const formatDate = (raw) => {
  if (!raw) return '';
  return raw.trim().slice(0, 10).replace(/\//g, '.');
};

async function main() {
  console.log(`[INFO] FUND_ID: ${FUND_ID}`);

  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  // シート一覧を取得して「データベース」を含むシートを自動検出
  let sheetTitle;
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheetList = meta.data.sheets.map(s => s.properties.title);
    console.log('[INFO] シート一覧:', sheetList.join(', '));
    const found = sheetList.find(t => t.includes('データベース')) || sheetList[0];
    if (!found) {
      console.error('[ERROR] シートが見つかりません:', sheetList.join(', '));
      process.exit(1);
    }
    sheetTitle = found;
    console.log(`[INFO] 使用シート: ${sheetTitle}`);
  } catch (e) {
    console.error('[ERROR] シート情報の取得に失敗しました:', e.message);
    process.exit(1);
  }

  // データ取得（シートIDを使って範囲指定）
  let rows;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: sheetTitle,  // シート名のみ指定（全データ取得）
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

  const COL_DEFAULTS = ['取得日時', 'ステルス', 'No', '会社名', '公開日', 'タイトル', '詳細', 'リンク', '配信ステータス'];
  const headerRow = rows[0];
  const colIdx = {};

  COL_DEFAULTS.forEach((name, i) => { colIdx[name] = i; });
  headerRow.forEach((h, i) => {
    const trimmed = h.trim();
    if (COL_DEFAULTS.includes(trimmed)) colIdx[trimmed] = i;
  });

  console.log('[INFO] 検出された列:', headerRow.slice(0, 9).map((h, i) => `${String.fromCharCode(65+i)}=${h}`).join(', '));

  const get = (row, name) => (row[colIdx[name]] !== undefined ? String(row[colIdx[name]]) : '').trim();

  const dataRows = rows.slice(1).map((row) => {
    const obj = {};
    COL_DEFAULTS.forEach((name) => { obj[name] = get(row, name); });
    return obj;
  });

  const filtered = dataRows
    .filter(isTarget)
    .filter((row) => getFund(row['No']) === FUND_ID);

  filtered.sort((a, b) => parseInt(a['No'], 10) - parseInt(b['No'], 10));

  const byMonth = {};
  for (const row of filtered) {
    const month = getYearMonth(row['公開日']);
    if (!month) {
      console.warn(`[WARN] No=${row['No']} の公開日を解析できません: "${row['公開日']}"`);
      continue;
    }
    if (!byMonth[month]) byMonth[month] = [];
    byMonth[month].push({
      no: row['No'],
      company: row['会社名'],
      cat1: '',
      cat2: '',
      title: row['タイトル'],
      url: row['リンク'],
      date: formatDate(row['公開日']),
      img: null,
    });
  }

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
