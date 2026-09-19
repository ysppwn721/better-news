// 数据质量体检：日期缺失、栏目分布、标签分布、疑似噪音条目
import { Store } from '../src/store/db.mjs';

const store = new Store();

console.log('=== 无发布日期的条目（按信源）===');
const noDate = store.db.prepare(
  'SELECT source_id, source_name, COUNT(*) AS n FROM items WHERE published_at IS NULL GROUP BY source_id ORDER BY n DESC',
).all();
if (!noDate.length) console.log('  （无，全部条目都有日期）');
for (const r of noDate) console.log(`  ${r.source_id.padEnd(22)} ${r.source_name.padEnd(18, '　')} ${r.n}`);

console.log('\n=== 栏目分布 ===');
for (const r of store.db.prepare(
  'SELECT category_name, COUNT(*) AS n, SUM(CASE WHEN published_at IS NULL THEN 1 ELSE 0 END) AS nodate FROM items GROUP BY category_id ORDER BY n DESC',
).all()) {
  console.log(`  ${r.category_name.padEnd(10, '　')} ${String(r.n).padStart(4)} 条（无日期 ${r.nodate}）`);
}

console.log('\n=== 各信源日期新鲜度 ===');
const fresh = store.db.prepare(`
  SELECT source_name, category_name, COUNT(*) AS n, MAX(published_at) AS latest
  FROM items GROUP BY source_id ORDER BY latest DESC
`).all();
for (const r of fresh.slice(0, 12)) console.log(`  ${String(r.latest).padEnd(11)} ${r.source_name.padEnd(20, '　')} ${r.n} 条`);
console.log('  …');
for (const r of fresh.slice(-8)) console.log(`  ${String(r.latest).padEnd(11)} ${r.source_name.padEnd(20, '　')} ${r.n} 条`);

console.log('\n=== 标签分布（Top 18）===');
const tagCount = new Map();
for (const it of store.db.prepare('SELECT tags FROM items').all()) {
  for (const t of JSON.parse(it.tags || '[]')) tagCount.set(t, (tagCount.get(t) || 0) + 1);
}
[...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)
  .forEach(([t, n]) => console.log(`  ${t.padEnd(12, '　')} ${n}`));

console.log('\n=== 疑似噪音（标题过短/非通知类）===');
const noisy = store.db.prepare(`
  SELECT title, source_name, published_at FROM items
  WHERE length(title) < 12 OR title LIKE '%培养方案%' OR title LIKE '%照片%' OR title LIKE '%风采%'
  ORDER BY published_at DESC LIMIT 12
`).all();
for (const r of noisy) console.log(`  ${String(r.published_at).padEnd(11)} [${r.source_name}] ${r.title.slice(0, 44)}`);

console.log('\n=== 重要标记统计 ===');
const imp = store.db.prepare('SELECT COUNT(*) AS n FROM items WHERE important = 1').get().n;
console.log(`  ${imp} 条被标记为重要`);
const samples = store.db.prepare('SELECT title FROM items WHERE important = 1 ORDER BY published_at DESC LIMIT 6').all();
for (const s of samples) console.log(`    · ${s.title.slice(0, 46)}`);

console.log('\n=== 含截止时间的条目 ===');
const dl = store.db.prepare("SELECT title, published_at FROM items WHERE tags LIKE '%\"截止\"%' ORDER BY published_at DESC LIMIT 8").all();
console.log(`  共 ${store.db.prepare("SELECT COUNT(*) AS n FROM items WHERE tags LIKE '%\"截止\"%'").get().n} 条`);
for (const r of dl) console.log(`    ${String(r.published_at).padEnd(11)} ${r.title.slice(0, 46)}`);

store.close();
process.exit(0);
