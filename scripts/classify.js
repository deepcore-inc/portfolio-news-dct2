'use strict';

/**
 * classify.js
 * data/news-cache.json を読み込み、カテゴリ①・②が空欄の記事を
 * Claude API で自動分類して更新する
 *
 * 必要な環境変数:
 *   ANTHROPIC_API_KEY - Anthropic API キー
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('[ERROR] ANTHROPIC_API_KEY が設定されていません');
  process.exit(1);
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-20250514';

/**
 * 分類プロンプトを生成する
 */
const buildPrompt = (title, company) => `あなたはスタートアップ企業のニュースを分類するアシスタントです。

以下のニュースタイトルを読んで、カテゴリを判定してください。

会社名: ${company}
タイトル: ${title}

## カテゴリルール

### カテゴリ①（大分類）- 必ず1つ選択
- 資金調達: 調達、ラウンド、クローズ、投資等のキーワード
- 事業進捗: プロダクトリリース、パートナーシップ、導入事例等
- その他: 受賞、採択、特集記事、組織・人事、出版等

### カテゴリ②（小分類）
- 資金調達の場合: 空欄（選択不要）
- 事業進捗の場合: プロダクト / パートナーシップ / 導入事例 のいずれか1つ
- その他の場合: 特集 / 受賞・採択 / 出版・発信 / 組織・人事 のいずれか1つ

## 出力形式
JSON形式のみで返答してください。説明文は不要です。

{
  "cat1": "資金調達|事業進捗|その他",
  "cat2": "プロダクト|パートナーシップ|導入事例|特集|受賞・採択|出版・発信|組織・人事|",
  "reason": "判断理由を日本語で一文"
}`;

const VALID_CAT1 = ['資金調達', '事業進捗', 'その他'];

/**
 * 1件の記事を分類する
 * 失敗時はデフォルト値を返す（処理を継続するため）
 */
async function classifyItem(item) {
  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: buildPrompt(item.title, item.company),
        },
      ],
    });

    const text = message.content[0].text.trim();

    // JSON 部分を抽出（コードブロック等に囲まれている場合も対応）
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('レスポンスに JSON が見つかりません');

    const json = JSON.parse(jsonMatch[0]);

    const cat1 = VALID_CAT1.includes(json.cat1) ? json.cat1 : 'その他';
    const cat2 = typeof json.cat2 === 'string' ? json.cat2.trim() : '';

    return { cat1, cat2 };
  } catch (e) {
    console.warn(`  [WARN] 分類失敗 "${item.title.slice(0, 40)}...": ${e.message}`);
    return { cat1: 'その他', cat2: '' };
  }
}

async function main() {
  const cachePath = path.join(process.cwd(), 'data', 'news-cache.json');

  if (!fs.existsSync(cachePath)) {
    console.log('[INFO] news-cache.json が存在しません。スキップします。');
    return;
  }

  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  let classifiedCount = 0;
  let skippedCount = 0;

  for (const month of Object.keys(cache).sort()) {
    for (const item of cache[month]) {
      if (item.cat1) {
        skippedCount++;
        continue;
      }

      console.log(`[INFO] 分類中 [${month}] ${item.company}: ${item.title.slice(0, 50)}...`);
      const result = await classifyItem(item);
      item.cat1 = result.cat1;
      item.cat2 = result.cat2;
      classifiedCount++;

      // API レート制限を考慮して少し待つ
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  console.log(`[INFO] 分類完了: ${classifiedCount} 件を分類、${skippedCount} 件はスキップ（入力済み）`);
}

main().catch((err) => {
  console.error('[ERROR]', err);
  process.exit(1);
});
