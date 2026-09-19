// 校验已发现栏目的真实可用性 + 解析效果（发现阶段只验内容，未验 HTTP 状态）
import { HttpClient } from '../src/core/http.mjs';
import { parseList } from '../src/sources/cms.mjs';
import { loadDiscovered } from '../src/core/sources.mjs';

const client = new HttpClient({ timeoutMs: 15000, retries: 1 });
const d = loadDiscovered();
const rows = [];

for (const [key, entry] of Object.entries(d)) {
  const cols = entry.columns?.length ? entry.columns : (entry.listUrl ? [{ url: entry.listUrl, name: entry.columnName }] : []);
  for (const c of cols) {
    try {
      const { html, status } = await client.fetchHtml(c.url);
      const items = parseList(html, c.url);
      const dated = items.filter((i) => i.date).length;
      const latest = items.map((i) => i.date).filter(Boolean).sort().pop() || '无';
      rows.push({
        college: entry.collegeName, col: c.name, ok: true, status,
        items: items.length, dated, latest, url: c.url,
        sample: items[0]?.title?.slice(0, 30) || '',
      });
    } catch (e) {
      rows.push({ college: entry.collegeName, col: c.name, ok: false, status: '-', items: 0, dated: 0, latest: '-', url: c.url, sample: e.message.slice(0, 40) });
    }
  }
}

const bad = rows.filter((r) => !r.ok || r.items === 0 || r.dated === 0);
console.log(`共校验 ${rows.length} 个栏目，异常 ${bad.length} 个\n`);
console.log('--- 正常栏目（按最新日期排序）---');
for (const r of rows.filter((x) => x.ok && x.dated > 0).sort((a, b) => String(b.latest).localeCompare(String(a.latest)))) {
  console.log(`  ${String(r.latest).padEnd(11)} ${r.college.padEnd(11, '　')} ${String(r.col).padEnd(9, '　')} ${r.items}条(带日期${r.dated})  ${r.sample}`);
}
if (bad.length) {
  console.log('\n--- 异常栏目 ---');
  for (const r of bad) console.log(`  ✗ ${r.college} / ${r.col}  ${r.status}  ${r.url}  ${r.sample}`);
}

// 汇总：最新日期分布
const fresh = rows.filter((r) => r.ok && r.latest !== '无').map((r) => r.latest).sort();
console.log(`\n最新日期范围: ${fresh[0] || '-'} ~ ${fresh[fresh.length - 1] || '-'}`);
