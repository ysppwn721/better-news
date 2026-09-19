// 统计各关键词的命中层级分布，判断"正文命中是否稀释了标题命中"
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const items = JSON.parse(readFileSync(resolve(ROOT, 'public/data/items.json'), 'utf8'));

function level(item, q) {
  const t = (item.title || '').toLowerCase();
  if (t.includes(q)) return '标题';
  const m = [item.sourceName || '', item.categoryName || '', (item.tags || []).join(' ')].join(' ').toLowerCase();
  if (m.includes(q)) return '来源栏目';
  if ((item.excerpt || '').toLowerCase().includes(q)) return '摘要';
  if ((item.searchText || '').toLowerCase().includes(q)) return '正文';
  return null;
}

const kws = ['选课', '奖学金', '推免', '考试', '国家奖学金', '困难认定', '党课', '四六级', '考试安排'];
console.log('关键词            标题   来源栏目  摘要   正文   合计');
for (const kw of kws) {
  const q = kw.toLowerCase();
  const dist = { 标题: 0, 来源栏目: 0, 摘要: 0, 正文: 0 };
  for (const it of items) {
    const lv = level(it, q);
    if (lv) dist[lv]++;
  }
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  console.log(
    `${kw.padEnd(14, '　')} ${String(dist.标题).padStart(5)} ${String(dist.来源栏目).padStart(6)} `
    + `${String(dist.摘要).padStart(6)} ${String(dist.正文).padStart(6)} ${String(total).padStart(6)}`,
  );
}

console.log('\n=== 「选课」标题命中的条目（前 12 条，这才是用户想要的）===');
for (const it of items.filter((i) => (i.title || '').includes('选课')).slice(0, 12)) {
  console.log(`  ${it.publishedAt} ${it.title.slice(0, 48)}`);
}
