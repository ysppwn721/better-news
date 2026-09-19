/**
 * 检查搜索结果的匹配原因：看命中的是标题、摘要还是正文片段。
 * 用法: node scripts/inspect-search-hits.mjs <关键词>
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kw = process.argv[2] || '推免';
const q = kw.toLowerCase();

const items = JSON.parse(readFileSync(resolve(ROOT, 'public/data/items.json'), 'utf8'));

function where(item) {
  const t = (item.title || '').toLowerCase();
  const e = (item.excerpt || '').toLowerCase();
  const s = (item.searchText || '').toLowerCase();
  const hits = [];
  if (t.includes(q)) hits.push('标题');
  if (e.includes(q)) hits.push('摘要');
  if (s.includes(q)) hits.push('正文');
  return hits;
}

const matched = items.filter((i) => where(i).length);

console.log(`关键词「${kw}」命中 ${matched.length} 条\n`);
console.log('=== 命中位置分布 ===');
const dist = {};
for (const m of matched) {
  const k = where(m).join('+');
  dist[k] = (dist[k] || 0) + 1;
}
for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${v} 条`);

console.log('\n=== 仅正文命中的条目（标题看不出相关性）===');
const bodyOnly = matched.filter((m) => !where(m).includes('标题') && !where(m).includes('摘要'));
console.log(`  共 ${bodyOnly.length} 条，示例前 6 条：`);
for (const m of bodyOnly.slice(0, 6)) {
  const idx = (m.searchText || '').toLowerCase().indexOf(q);
  const ctx = idx >= 0 ? m.searchText.slice(Math.max(0, idx - 30), idx + 40) : '';
  console.log(`  · ${m.title.slice(0, 40)}`);
  console.log(`      正文上下文: …${ctx.replace(/\s+/g, ' ')}…`);
}

console.log('\n=== 标题或摘要命中的条目（真正相关）===');
const titleHit = matched.filter((m) => where(m).includes('标题') || where(m).includes('摘要'));
console.log(`  共 ${titleHit.length} 条，示例前 5 条：`);
for (const m of titleHit.slice(0, 5)) console.log(`  · [${m.sourceName}] ${m.title.slice(0, 44)}`);
