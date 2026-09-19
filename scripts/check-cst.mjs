// 检查计算机学院抓取结果（含最新条目）
import { Store } from '../src/store/db.mjs';

const store = new Store();
const rows = store.db.prepare(
  "SELECT title, published_at, source_name, source_id FROM items WHERE source_id LIKE 'col-cst%' ORDER BY published_at DESC LIMIT 18",
).all();

console.log('=== 计算机科学与技术学院 最新条目 ===');
for (const r of rows) {
  const src = r.source_name.includes('·') ? r.source_name.split('·')[1] : '通知公告';
  console.log(`  ${(r.published_at || '无日期').padEnd(11)} [${src}] ${r.title.slice(0, 48)}`);
}

const total = store.db.prepare("SELECT COUNT(*) AS c FROM items WHERE source_id LIKE 'col-cst%'").get().c;
const bySrc = store.db.prepare(
  "SELECT source_name, COUNT(*) AS c, MAX(published_at) AS latest FROM items WHERE source_id LIKE 'col-cst%' GROUP BY source_id",
).all();
console.log(`\n  合计 ${total} 条`);
for (const s of bySrc) console.log(`    ${s.source_name.padEnd(28, '　')} ${String(s.c).padStart(3)} 条  最新 ${s.latest}`);

// 全库统计
const counts = store.counts();
const fresh = store.db.prepare(
  "SELECT COUNT(*) AS c FROM items WHERE published_at >= date('now','-7 days')",
).get().c;
console.log(`\n=== 全库 ===`);
console.log(`  总计 ${counts.total} 条，近 7 天 ${fresh} 条`);
store.close();
