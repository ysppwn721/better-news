/**
 * 排查「学院栏目覆盖缺口」的成因：那几条漏掉的 URL 到底在库里的什么位置？
 *
 * 两种可能：
 *   a) 它挂在别的 source_id 下（曾作为该学院另一个栏目被抓到，属于归类问题）；
 *   b) 库里根本没有（属于真的没抓到）。
 *
 * 用法: node scripts/probe-coverage-gap.mjs <sourceId> [maxPages]
 */
import { Store } from '../src/store/db.mjs';
import { buildSources } from '../src/core/sources.mjs';
import { collectListPages } from '../src/sources/paging.mjs';

const sourceId = process.argv[2] || 'col-cst-13';
const MAXP = Number(process.argv[3] || 0);

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36' };
async function get(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer()).toString('utf8');
}

const store = new Store();
const s = buildSources().find((x) => x.id === sourceId);
if (!s) { console.error(`未找到信源 ${sourceId}`); process.exit(1); }
console.log(`信源 ${s.id}  ${s.name}\n列表页 ${s.listUrl}\n`);

const r = await collectListPages(get, {
  listUrl: s.listUrl,
  maxPages: MAXP || s.maxPages || 6,
  sinceMonths: 6,
});
console.log(`官网取到 ${r.items.length} 条（翻了 ${r.pages} 页）\n`);

const byUrl = store.db.prepare('SELECT url, source_id AS sid, source_name AS sn, title, published_at AS d FROM items WHERE url = ?');
for (const it of r.items) {
  const row = byUrl.get(it.url);
  if (!row) {
    console.log(`✗ 库里没有       ${it.date || '?'}  ${it.title.slice(0, 34)}`);
  } else if (row.sid !== sourceId) {
    console.log(`≠ 归在别的信源下  [${row.sid}] ${it.date || '?'}  ${it.title.slice(0, 30)}`);
  } else {
    console.log(`✓ 正常            ${it.date || '?'}  ${it.title.slice(0, 34)}`);
  }
}
store.close?.();
