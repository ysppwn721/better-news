/**
 * 日期校正：用列表页的权威日期修正库中已存的日期。
 *
 * 背景：早期版本存在「相邻条目日期串位」缺陷（拆分格式 + 完整格式混排时取到了下一条的日期），
 * 已入库的日期因此可能有误。而 saveItem 只在正文变化时才更新，不会自动纠正历史日期。
 * 本脚本重扫各信源列表页，按 URL 回填正确日期。
 */
import { Store } from '../src/store/db.mjs';
import { HttpClient } from '../src/core/http.mjs';
import { parseList } from '../src/sources/cms.mjs';
import { buildSources } from '../src/core/sources.mjs';

const dry = process.argv.includes('--dry');
const only = process.argv.filter((a) => !a.startsWith('--')).slice(2);

const store = new Store();
const client = new HttpClient({ timeoutMs: 15000, retries: 1 });
const sources = buildSources().filter((s) => (only.length ? only.includes(s.id) : true));

let scanned = 0, fixed = 0;
const samples = [];

for (const src of sources) {
  if (!src.listUrl) continue;
  const pages = Math.min(src.maxPages ?? 1, 5);
  const map = new Map();
  for (let p = 1; p <= pages; p++) {
    const url = p === 1 ? src.listUrl
      : (src.pageTemplate ? src.pageTemplate.replace('{page}', p) : src.listUrl);
    try {
      const { html } = await client.fetchHtml(url);
      const items = parseList(html, url);
      if (!items.length) break;
      for (const it of items) if (it.date) map.set(it.url, it.date);
    } catch { break; }
  }
  if (!map.size) continue;

  for (const [url, date] of map) {
    const row = store.findItemByUrl(url);
    if (!row) continue;
    scanned++;
    if (row.published_at !== date) {
      if (samples.length < 20) {
        samples.push({ title: row.title, from: row.published_at, to: date, src: src.name });
      }
      if (!dry) store.db.prepare('UPDATE items SET published_at = ? WHERE url = ?').run(date, url);
      fixed++;
    }
  }
}

console.log(`${dry ? '[试运行] ' : ''}扫描 ${scanned} 条，日期修正 ${fixed} 条\n`);
for (const s of samples) {
  console.log(`  ${String(s.from)} → ${s.to}   [${s.src}] ${s.title.slice(0, 42)}`);
}
store.close();
