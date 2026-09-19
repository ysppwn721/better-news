/**
 * 对比 Node 抓取与 App 抓取的列表覆盖度。
 *
 * 背景：网页快照（Node 侧）长期比 App 侧少几百条通知，学生搜「选课」「综测」
 * 在网页上搜不到——根因是两边翻页规则不一致。此脚本用同一份信源清单分别跑
 * 一遍，输出每个信源的条目数，用来确认两边已经对齐。
 *
 * 用法: node scripts/compare-coverage.mjs [--limit N]
 */
import { buildSources } from '../src/core/sources.mjs';
import { collectListPages } from '../src/sources/paging.mjs';
import { HttpClient } from '../src/core/http.mjs';

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;

const client = new HttpClient({ timeoutMs: 20000, minIntervalMs: 0 });

/** 只抓需要的几个信源（默认全量） */
const sources = buildSources()
  .filter((s) => s.listUrl)
  .slice(0, LIMIT || undefined);

console.log(`信源 ${sources.length} 个，按时间截止翻页（最近 6 个月，最多 12 页）\n`);

const rows = [];
let i = 0;
const CONC = 6;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (i < sources.length) {
    const s = sources[i++];
    const t0 = Date.now();
    try {
      const r = await collectListPages(
        async (u) => (await client.fetchHtml(u)).html,
        { listUrl: s.listUrl, maxPages: 12, sinceMonths: 6 },
      );
      const dates = r.items.map((x) => x.date).filter(Boolean).sort();
      rows.push({
        id: s.id, name: s.name, n: r.items.length, pages: r.pages,
        newest: dates[dates.length - 1] || '-', oldest: dates[0] || '-',
        ms: Date.now() - t0, err: r.firstError || '',
      });
    } catch (e) {
      rows.push({ id: s.id, name: s.name, n: 0, pages: 0, newest: '-', oldest: '-', ms: Date.now() - t0, err: e.message });
    }
  }
}));

rows.sort((a, b) => b.n - a.n);
let total = 0;
for (const r of rows) {
  total += r.n;
  const flag = r.err ? ' ✗' : r.n === 0 ? ' ·空' : '';
  console.log(`${String(r.n).padStart(4)} 条  ${String(r.pages).padStart(2)}页  ${r.oldest} ~ ${r.newest}  ${r.name}${flag}${r.err ? '  → ' + r.err.slice(0, 60) : ''}`);
}

const zero = rows.filter((r) => r.n === 0);
console.log(`\n合计 ${total} 条（去重前），${rows.length} 个信源，空洞 ${zero.length} 个`);
if (zero.length) {
  console.log('空洞信源：');
  for (const r of zero) console.log(`  - ${r.name}${r.err ? '  → ' + r.err.slice(0, 80) : ''}`);
}
