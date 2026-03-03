'use strict';

/**
 * sync-sheet.js
 * スプレッドシートA（ニュース収集DB）から新着ニュースを取得し、
 * スプレッドシートB（公開管理DB）に未掲載分を追記する。
 *
 * 処理内容:
 *   1. スプレッドシートA の当年度シートを全件取得
 *   2. FUND_ID に合わせて No（1000番台 or 2000番台）でフィルタリング
 *   3. スプレッドシートB に同じ URL が既にある行はスキップ（重複排除）
 *   4. 新着分について、同じ No の過去データを B から参照し
 *      カテゴリ①・②・Notion載せない を自動入力
 *   5. スプレッドシートB の末尾に追記
 *   6. Slack Incoming Webhook で確認依頼通知を送信
 *
 * 必要な環境変数:
 *   FUND_ID                     - 'dct1' または 'dct2'
 *   SPREADSHEET_A_ID            - スプレッドシートA の ID
 *   SPREADSHEET_A_SHEET         - スプレッドシートA のシート名
 *                                 (デフォルト: '2026年度データベース')
 *   SPREADSHEET_ID              - スプレッドシートB の ID（既存 Secret 流用）
 *   GOOGLE_SERVICE_ACCOUNT_JSON - サービスアカウント JSON（読み書き権限が必要）
 *   SLACK_WEBHOOK_URL           - Slack Incoming Webhook URL
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// ── 環境変数 ──────────────────────────────────────────────────────────
const FUND_ID = process.env.FUND_ID;
const SPREADSHEET_A_ID = process.env.SPREADSHEET_A_ID;
const SPREADSHEET_A_SHEET = process.env.SPREADSHEET_A_SHEET || '2026年度データベース';
const SPREADSHEET_B_ID = process.env.SPREADSHEET_ID;
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

if (!SPREADSHEET_A_ID || !SPREADSHEET_B_ID || !SERVICE_ACCOUNT_JSON) {
  console.error('[ERROR] 必要な環境変数が不足しています: SPREADSHEET_A_ID, SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON');
  process.exit(1);
}

// ── スプレッドシートA の列定義（0始まり、デフォルト位置） ──────────────
const COL_A_DEFAULT = {
  取得日時: 0,
  ステルス: 1,
  No: 2,
  会社名: 3,
  公開日: 4,
  タイトル: 5,
  詳細: 6,
  リンク: 7,
  配信ステータス: 8,
};

// ── スプレッドシートB の列定義（0始まり、デフォルト位置） ──────────────
const COL_B_DEFAULT = {
  日付: 0,
  No: 1,
  会社名: 2,
  ステルス: 3,
  タイトル: 4,
  リンク: 5,
  'カテゴリ①': 6,
  'カテゴリ②': 7,
  'Notion載せない': 8,
  LINKS: 9,
  掲載月: 10,
};

// ── Google 認証（読み書き両方のスコープ） ────────────────────────────
let credentials;
try {
  credentials = JSON.parse(SERVICE_ACCOUNT_JSON);
} catch (e) {
  console.error('[ERROR] GOOGLE_SERVICE_ACCOUNT_JSON のパースに失敗:', e.message);
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'], // 読み書き
});

// ── ユーティリティ ────────────────────────────────────────────────────

/** No が対象範囲（1000〜2999、L始まり除外）かどうかを確認 */
const isValidNo = (no) => {
  if (!no) return false;
  if (String(no).startsWith('L')) return false;
  const n = parseInt(no, 10);
  return !isNaN(n) && n >= 1000 && n < 3000;
};

/** No からファンドIDを返す */
const getFund = (no) => {
  const n = parseInt(no, 10);
  if (n >= 1000 && n < 2000) return 'dct1';
  if (n >= 2000 && n < 3000) return 'dct2';
  return null;
};

/** "2026/01/10 10:30" → "202601" */
const toYYYYMM = (dateStr) => {
  if (!dateStr) return '';
  const m = dateStr.match(/(\d{4})[\/\-\.](\d{1,2})/);
  if (!m) return '';
  return `${m[1]}${String(m[2]).padStart(2, '0')}`;
};

/** "2026/01/10" → "2026.01.10" */
const formatDate = (raw) => (raw ? raw.trim().split(' ')[0].replace(/\//g, '.') : '');

/**
 * ヘッダー行から列インデックスマップを構築する
 * デフォルト位置 + ヘッダー名が一致した列で上書き
 */
const buildColIdx = (headerRow, defaults) => {
  const idx = { ...defaults };
  (headerRow || []).forEach((h, i) => {
    const name = h.trim();
    if (name in idx) idx[name] = i;
  });
  return idx;
};

/** 行データから指定列の値を安全に取得 */
const getCell = (row, colIdx, name) => (row[colIdx[name]] !== undefined ? String(row[colIdx[name]]) : '').trim();

// ── Slack 通知 ────────────────────────────────────────────────────────

async function sendSlack(payload) {
  if (!SLACK_WEBHOOK_URL) {
    console.log('[INFO] SLACK_WEBHOOK_URL 未設定のため Slack 通知をスキップ');
    return;
  }
  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      console.log('[INFO] Slack 通知を送信しました');
    } else {
      console.warn(`[WARN] Slack 通知失敗: HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn('[WARN] Slack 通知エラー:', e.message);
  }
}

// ── メイン処理 ───────────────────────────────────────────────────────

async function main() {
  const fundLabel = FUND_ID ? FUND_ID.toUpperCase() : '全ファンド';
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  // ===== 1. スプレッドシートA を読み込む =====
  console.log(`[INFO] スプレッドシートA「${SPREADSHEET_A_SHEET}」を読み込み中...`);
  let resA;
  try {
    resA = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_A_ID,
      range: `'${SPREADSHEET_A_SHEET}'!A:I`,
    });
  } catch (e) {
    console.error('[ERROR] スプレッドシートA の読み込みに失敗:', e.message);
    process.exit(1);
  }

  const rowsA = resA.data.values || [];
  if (rowsA.length < 2) {
    console.log('[INFO] スプレッドシートA にデータがありません');
    return;
  }

  const colIdxA = buildColIdx(rowsA[0], COL_A_DEFAULT);
  const getA = (row, name) => getCell(row, colIdxA, name);

  // ヘッダー行を除いてパース → No が有効かつタイトル・リンクが存在する行のみ
  const allFromA = rowsA.slice(1)
    .map((row) => ({
      No: getA(row, 'No'),
      会社名: getA(row, '会社名'),
      ステルス: getA(row, 'ステルス'),
      公開日: getA(row, '公開日'),
      タイトル: getA(row, 'タイトル'),
      リンク: getA(row, 'リンク'),
    }))
    .filter((r) => isValidNo(r.No) && r.タイトル && r.リンク);

  // FUND_ID が指定されている場合はそのファンドのみ絞り込む
  const targetFromA = FUND_ID
    ? allFromA.filter((r) => getFund(r.No) === FUND_ID)
    : allFromA;

  console.log(`[INFO] スプレッドシートA: 全 ${allFromA.length} 件中、対象 ${targetFromA.length} 件`);

  // ===== 2. スプレッドシートB を読み込む =====
  console.log('[INFO] スプレッドシートB を読み込み中...');
  let resB;
  try {
    resB = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_B_ID,
      range: 'A:K',
    });
  } catch (e) {
    console.error('[ERROR] スプレッドシートB の読み込みに失敗:', e.message);
    process.exit(1);
  }

  const rowsB = resB.data.values || [];
  const colIdxB = buildColIdx(rowsB[0] || [], COL_B_DEFAULT);
  const getB = (row, name) => getCell(row, colIdxB, name);

  const existingB = rowsB.slice(1).map((row) => ({
    No: getB(row, 'No'),
    リンク: getB(row, 'リンク'),
    'カテゴリ①': getB(row, 'カテゴリ①'),
    'カテゴリ②': getB(row, 'カテゴリ②'),
    'Notion載せない': getB(row, 'Notion載せない'),
  }));

  console.log(`[INFO] スプレッドシートB: 既存 ${existingB.length} 件`);

  // ===== 3. 重複チェック（URL で比較） =====
  const existingUrls = new Set(existingB.map((r) => r.リンク).filter(Boolean));

  // ===== 4. 同じ No の過去データを参照マップに構築 =====
  // 後から出てくる行で上書き → 最新エントリが使われる
  const pastByNo = {};
  for (const row of existingB) {
    if (row.No) {
      pastByNo[row.No] = {
        'カテゴリ①': row['カテゴリ①'] || pastByNo[row.No]?.['カテゴリ①'] || '',
        'カテゴリ②': row['カテゴリ②'] || pastByNo[row.No]?.['カテゴリ②'] || '',
        // Notion載せない: "1" が一度でもあれば引き継ぐ
        'Notion載せない': row['Notion載せない'] === '1' ? '1' : (pastByNo[row.No]?.['Notion載せない'] || ''),
      };
    }
  }

  // ===== 5. 新着ニュースの抽出 =====
  const newItems = targetFromA.filter((r) => !existingUrls.has(r.リンク));
  console.log(`[INFO] 新着ニュース: ${newItems.length} 件`);

  if (newItems.length === 0) {
    console.log('[INFO] 追加する新着ニュースはありません');
    await sendSlack({
      text: `📭 Portfolio News（${fundLabel}）: 新着ニュースなし`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*📭 新着ニュースなし（${fundLabel}）*\n今回のチェックで追加対象のニュースはありませんでした。`,
          },
        },
      ],
    });
    return;
  }

  // ===== 6. 追記データを構築 =====
  const newRows = newItems.map((item) => {
    const past = pastByNo[item.No] || {};
    return [
      formatDate(item.公開日),           // A: 日付
      item.No,                           // B: No
      item.会社名,                        // C: 会社名
      item.ステルス,                      // D: ステルス
      item.タイトル,                      // E: タイトル
      item.リンク,                        // F: リンク
      past['カテゴリ①'] || '',            // G: カテゴリ①（過去データ参照）
      past['カテゴリ②'] || '',            // H: カテゴリ②（過去データ参照）
      past['Notion載せない'] || '',       // I: Notion載せない（過去データ参照）
      '',                                 // J: LINKS（空欄）
      toYYYYMM(item.公開日),              // K: 掲載月（公開日から自動算出）
    ];
  });

  // ===== 7. スプレッドシートB に追記 =====
  console.log(`[INFO] スプレッドシートB に ${newRows.length} 件を追記します...`);
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_B_ID,
      range: 'A:K',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: newRows },
    });
    console.log('[INFO] スプレッドシートB への追記が完了しました');
  } catch (e) {
    console.error('[ERROR] スプレッドシートB への書き込みに失敗:', e.message);
    process.exit(1);
  }

  // ===== 8. サマリーをファイルに保存（デバッグ・後続ステップ参照用） =====
  const dataDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'sync-result.json'),
    JSON.stringify({ fundId: FUND_ID, addedCount: newItems.length, items: newItems }, null, 2),
    'utf-8'
  );

  // ===== 9. Slack 通知 =====
  const sheetBUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_B_ID}/edit`;
  const actionsBaseUrl = FUND_ID === 'dct1'
    ? 'https://github.com/KarinYOSHIDA02/portfolio-news-dct1/actions/workflows/generate.yml'
    : 'https://github.com/KarinYOSHIDA02/portfolio-news-dct2/actions/workflows/generate.yml';

  // 新着一覧（最大15件）
  const maxDisplay = 15;
  const itemLines = newItems.slice(0, maxDisplay).map((item, i) => {
    const past = pastByNo[item.No] || {};
    const notionMark = past['Notion載せない'] === '1' ? '  ⚠️ Notion除外' : '';
    const catInfo = past['カテゴリ①'] ? `[${past['カテゴリ①']}${past['カテゴリ②'] ? `/${past['カテゴリ②']}` : ''}]` : '[未分類→AI分類]';
    return `${i + 1}. *${item.会社名}* ${catInfo}${notionMark}\n   ${item.タイトル}`;
  });
  if (newItems.length > maxDisplay) {
    itemLines.push(`_...他 ${newItems.length - maxDisplay} 件_`);
  }

  await sendSlack({
    text: `📰 Portfolio News（${fundLabel}）: ${newItems.length}件の新着ニュースを追加しました`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `📰 新着ニュース ${newItems.length}件 追加完了（${fundLabel}）`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'スプレッドシートBに以下のニュースを追加しました。\n内容を確認・必要に応じて修正後、*「▶️ HTML生成を実行」*ボタンを押してください。',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: itemLines.join('\n\n'),
        },
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '💡 *確認ポイント*: カテゴリ・掲載月・Notion載せない を確認し、必要に応じてスプレッドシートで修正してください。',
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '📊 スプレッドシートを確認', emoji: true },
            url: sheetBUrl,
            style: 'primary',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '▶️ HTML生成を実行', emoji: true },
            url: actionsBaseUrl,
          },
        ],
      },
    ],
  });

  console.log(`[INFO] 完了: ${newItems.length} 件を追加しました`);
}

main().catch((err) => {
  console.error('[ERROR]', err);
  process.exit(1);
});
