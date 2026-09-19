// 找出标题抽取异常的条目
import { Store } from '../src/store/db.mjs';

const store = new Store();
const rows = store.db.prepare(`
  SELECT id, title, source_name, published_at, url, length(title) AS len
  FROM items
  WHERE length(title) > 80
     OR title LIKE '%一审%' OR title LIKE '%责编%'
     OR title LIKE '%现将%' OR title LIKE '%如有异议%'
     OR title LIKE '%联系电话%' OR title LIKE '%名单如下%'
  ORDER BY len DESC
`).all();

console.log(`标题异常的条目：${rows.length} 条\n`);
for (const r of rows) {
  console.log(`  id=${r.id} (${r.len}字) [${r.source_name}] ${r.published_at}`);
  console.log(`    ${r.title}`);
  console.log(`    ${r.url}`);
}
store.close();
