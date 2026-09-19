// 核对计算机学院抓取覆盖度
import { Store } from '../src/store/db.mjs';

const store = new Store();
const rows = store.db.prepare(
  `SELECT source_name, COUNT(*) AS c, MAX(published_at) AS latest
   FROM items WHERE source_id LIKE 'col-cst%' GROUP BY source_id ORDER BY latest DESC`,
).all();

console.log('=== 计算机科学与技术学院：各栏目条目数与最新日期 ===');
for (const r of rows) {
  console.log(`  ${r.source_name.padEnd(30, '　')} ${String(r.c).padStart(3)} 条   最新 ${r.latest}`);
}
const total = store.db.prepare("SELECT COUNT(*) AS c FROM items WHERE source_id LIKE 'col-cst%'").get().c;
console.log(`\n  合计 ${total} 条（此前 30 条）`);

console.log('\n=== 最近 8 条（跨所有栏目）===');
for (const r of store.db.prepare(
  `SELECT title, published_at, source_name FROM items
   WHERE source_id LIKE 'col-cst%' ORDER BY published_at DESC LIMIT 8`,
).all()) {
  const sub = r.source_name.includes('·') ? r.source_name.split('·')[1] : '通知公告';
  console.log(`  ${r.published_at}  [${sub}] ${r.title.slice(0, 42)}`);
}

console.log('\n=== 全库 ===');
const c = store.counts();
console.log(`  条目 ${c.total} 条，重要 ${c.important} 条`);
const src = store.db.prepare('SELECT COUNT(DISTINCT source_id) AS n FROM items').get().n;
console.log(`  有数据的信源 ${src} 个`);
store.close();
