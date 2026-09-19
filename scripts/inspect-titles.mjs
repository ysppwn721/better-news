// 排查：标题异常（像正文段落而非标题）的条目
import { Store } from '../src/store/db.mjs';

const store = new Store();
const rows = store.db.prepare(
  'SELECT id, title, source_name, published_at, url FROM items ORDER BY length(title) DESC',
).all();

const suspicious = rows.filter((r) =>
  r.title.length > 60 ||
  /一审|二审|三审|责编|根据|各学院|各同学|现将|如下|如有异议|联系电话|为了/.test(r.title));

console.log(`共 ${rows.length} 条，标题可疑 ${suspicious.length} 条\n`);
console.log('=== 标题长度分布 ===');
const buckets = { '<20': 0, '20-40': 0, '40-60': 0, '60-100': 0, '>100': 0 };
for (const r of rows) {
  const n = r.title.length;
  if (n < 20) buckets['<20']++;
  else if (n <= 40) buckets['20-40']++;
  else if (n <= 60) buckets['40-60']++;
  else if (n <= 100) buckets['60-100']++;
  else buckets['>100']++;
}
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(8)} ${v}`);

console.log('\n=== 可疑条目（前 15）===');
for (const r of suspicious.slice(0, 15)) {
  console.log(`  [${r.source_name}] ${String(r.published_at)}`);
  console.log(`    ${r.title.slice(0, 110)}`);
}

console.log('\n=== 最短标题（前 8）===');
for (const r of rows.slice(-8)) console.log(`  (${r.title.length}) [${r.source_name}] ${r.title}`);

store.close();
