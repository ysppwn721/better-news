/**
 * 校验「学院专栏」是否真的把官网栏目抓全了。
 *
 * 逐信源对比：官网当前列表页（含翻页）能取到的条目 vs 库里已有的条目，
 * 输出缺失条数与缺失样例。用户反馈过「学院专栏压根没从学院官网抓」，
 * 这个脚本就是用来把这句话变成可核对的数字的。
 *
 * 用法: node scripts/verify-college-coverage.mjs [id子串=cst] [maxPages]
 */
import { Store } from '../src/store/db.mjs';
import { buildSources } from '../src/core/sources.mjs';
import { collectListPages } from '../src/sources/paging.mjs';

const filter = process.argv[2] || 'cst';
const MAXP = Number(process.argv[3] || 0); // 0 = 用信源自身配置

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36' };
async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer()).toString('utf8');
    } catch (e) {
      if (i === 2) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
}

const store = new Store();
const sources = buildSources().filter((s) => s.id.includes(filter));
console.log(`校验 ${sources.length} 个信源（id 含「${filter}」）\n`);
console.log('信源'.padEnd(26), '官网可抓', '库内', '缺失', '  缺失样例');
let totLive = 0, totDb = 0, totMiss = 0;

for (const s of sources) {
  const rows = store.db.prepare('SELECT url, title, published_at AS d FROM items WHERE source_id = ?').all(s.id);
  const have = new Set(rows.map((r) => r.url));
  let live = [];
  try {
    const r = await collectListPages(get, {
      listUrl: s.listUrl,
      maxPages: MAXP || s.maxPages || 6,
      sinceMonths: 6,
    });
    live = r.items;
  } catch (e) {
    console.log(String(s.name).slice(0, 24).padEnd(26), 'ERROR ' + e.message);
    continue;
  }
  const missing = live.filter((i) => !have.has(i.url));
  totLive += live.length; totDb += rows.length; totMiss += missing.length;
  const rate = live.length ? `${(100 - missing.length / live.length * 100).toFixed(0)}%` : '-';
  console.log(
    String(s.name).replace('计算机科学与技术学院', '计算机').slice(0, 24).padEnd(26),
    String(live.length).padStart(8),
    String(rows.length).padStart(4),
    String(missing.length).padStart(4),
    ` 覆盖${rate}`.padEnd(8),
    missing.slice(0, 2).map((m) => `${m.date || '?'} ${m.title.slice(0, 22)}`).join(' | '),
  );
}
console.log(`\n合计：官网可抓 ${totLive} 条，库内 ${totDb} 条，缺口 ${totMiss} 条`);
store.close?.();
