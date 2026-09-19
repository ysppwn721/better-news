/**
 * 检查搜索打分与排序：前若干条的相关度是否递减。
 * 用法: node scripts/check-search-rank.mjs <关键词>
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kw = (process.argv[2] || '选课').toLowerCase();
const items = JSON.parse(readFileSync(resolve(ROOT, 'public/data/items.json'), 'utf8'));

// 与 app.js 保持一致的打分逻辑
function matchScore(item, q) {
  const haystack = [
    item.title || '', item.excerpt || '', item.searchText || '',
    item.sourceName || '', item.categoryName || '', (item.tags || []).join(' '),
  ].join(' ').toLowerCase();

  if (haystack.includes(q)) return 2;
  if (q.length < 3) return 0;

  const cuts = q.length >= 4
    ? [[0, Math.ceil(q.length * 0.6)], [Math.ceil(q.length * 0.6), q.length]]
    : [[0, q.length]];
  for (const [from, to] of cuts) {
    const part = q.slice(from, to);
    let ok = false;
    for (let n = Math.min(4, part.length); n >= 2 && !ok; n--) {
      for (let i = 0; i + n <= part.length; i++) {
        if (haystack.includes(part.slice(i, i + n))) { ok = true; break; }
      }
    }
    if (!ok) return 0;
  }
  const covered = new Array(q.length).fill(false);
  for (let n = Math.min(4, q.length); n >= 2; n--) {
    for (let i = 0; i + n <= q.length; i++) {
      const gram = q.slice(i, i + n);
      if (haystack.includes(gram)) for (let k = i; k < i + n; k++) covered[k] = true;
    }
  }
  return covered.filter(Boolean).length / q.length >= 0.5 ? 1 : 0;
}

const scored = items.map((i) => ({ i, s: matchScore(i, kw) })).filter((x) => x.s > 0);
const byScore = { 2: scored.filter((x) => x.s === 2).length, 1: scored.filter((x) => x.s === 1).length };
console.log(`关键词「${kw}」`);
console.log(`  精确命中(2分): ${byScore[2]} 条`);
console.log(`  模糊命中(1分): ${byScore[1]} 条`);

// 模拟界面排序：先按日期，再按分数（稳定排序）
const sorted = [...scored].sort((a, b) =>
  String(b.i.publishedAt || '').localeCompare(String(a.i.publishedAt || '')) || b.i.id - a.i.id);
sorted.sort((a, b) => b.s - a.s);

console.log('\n  排序后前 8 条（分数应递减）：');
for (const x of sorted.slice(0, 8)) {
  const where = [];
  if ((x.i.title || '').includes(kw)) where.push('标题');
  else if ((x.i.excerpt || '').includes(kw)) where.push('摘要');
  else if ((x.i.searchText || '').includes(kw)) where.push('正文');
  else where.push('分词');
  console.log(`    ${x.s}分 [${where.join('')}] ${x.i.publishedAt} ${x.i.title.slice(0, 36)}`);
}
