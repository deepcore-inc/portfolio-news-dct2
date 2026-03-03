'use strict';

/**
 * fetch-ogp.js
 * data/news-cache.json を読み込み、img が null の記事の OGP 画像URLを
 * 各記事ページから取得して更新する
 *
 * Node.js 20 以上の組み込み fetch を使用
 */

const fs = require('fs');
const path = require('path');

const TIMEOUT_MS = 5000;

/**
 * 指定URLのページから og:image メタタグの画像URLを取得する
 * 取得失敗時は null を返す（エラーにはしない）
 */
async function fetchOgpImage(url) {
  if (!url || url === '#' || !url.startsWith('http')) return null;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; portfolio-news-bot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!res.ok) return null;

    const html = await res.text();

    // property="og:image" content="..." の順
    const m1 = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (m1) return m1[1];

    // content="..." property="og:image" の順（属性順が逆の場合）
    const m2 = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (m2) return m2[1];

    return null;
  } catch {
    return null;
  }
}

async function main() {
  const cachePath = path.join(process.cwd(), 'data', 'news-cache.json');

  if (!fs.existsSync(cachePath)) {
    console.log('[INFO] news-cache.json が存在しません。スキップします。');
    return;
  }

  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  let fetched = 0;
  let notFound = 0;
  let skipped = 0;

  for (const month of Object.keys(cache).sort()) {
    for (const item of cache[month]) {
      // img が null のもののみ処理（空文字 = 取得済みで見つからなかった、をスキップ）
      if (item.img !== null) {
        skipped++;
        continue;
      }

      process.stdout.write(`[OGP] ${item.company}: `);
      const imgUrl = await fetchOgpImage(item.url);

      if (imgUrl) {
        item.img = imgUrl;
        fetched++;
        console.log(`取得 ✓`);
      } else {
        item.img = ''; // 空文字 = 取得試みたが見つからなかった
        notFound++;
        console.log(`画像なし`);
      }
    }
  }

  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  console.log(`[INFO] OGP 取得完了: ${fetched} 件取得、${notFound} 件は画像なし、${skipped} 件スキップ`);
}

main().catch((err) => {
  console.error('[ERROR]', err);
  process.exit(1);
});
