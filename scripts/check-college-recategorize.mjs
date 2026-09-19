/**
 * 检查学院条目是否因为「关键词改判栏目」而跑出了「★ 计算机学院」置顶栏。
 *
 * 背景：Fetcher 对 categoryId === 'college' 的条目会跑 hintCategory()，
 * 让明显属于某部门的条目归位（如学院发的奖学金公示 → 学生工作）。
 * 这本身是设计意图，但它会让这些条目从置顶学院栏「消失」——
 * 学生看到的就是「我们学院的内容怎么这么少」。
 *
 * 用法: node scripts/check-college-recategorize.mjs [id前缀=col-cst]
 */
import { Store } from '../src/store/db.mjs';

const prefix = process.argv[2] || 'col-cst';
const store = new Store();

const rows = store.db.prepare(`
  SELECT source_id AS sid, category_id AS cid, COUNT(*) AS n
  FROM items WHERE source_id LIKE ? GROUP BY sid, cid ORDER BY sid, n DESC
`).all(`${prefix}%`);

console.log('信源'.padEnd(14), 'categoryId'.padEnd(11), '条数');
let moved = 0, total = 0;
for (const r of rows) {
  console.log(String(r.sid).padEnd(14), String(r.cid).padEnd(11), String(r.n).padStart(4));
  total += r.n;
  if (r.cid !== 'college') moved += r.n;
}
console.log(`\n合计 ${total} 条，其中被改判到非 college 栏目 ${moved} 条（${(moved / total * 100).toFixed(1)}%）`);

const ex = store.db.prepare(`
  SELECT source_id AS sid, category_id AS cid, title FROM items
  WHERE source_id LIKE ? AND category_id != 'college' LIMIT 15
`).all(`${prefix}%`);
if (ex.length) {
  console.log('\n样例：');
  for (const e of ex) console.log(`  ${e.sid}  →  ${e.cid}   ${String(e.title).slice(0, 40)}`);
}
store.close?.();
