// 排查重复条目：同一条通知为何出现多次
import { Store } from '../src/store/db.mjs';

const store = new Store();

console.log('=== URL 完全重复的条目 ===');
const dupUrl = store.db.prepare(
  'SELECT url, COUNT(*) AS c FROM items GROUP BY url HAVING c > 1',
).all();
console.log(`  ${dupUrl.length} 组`);

console.log('\n=== 标题+来源相同的条目（疑似同一通知被不同 URL 收录）===');
const dupTitle = store.db.prepare(`
  SELECT title, source_id, COUNT(*) AS c, GROUP_CONCAT(url, ' | ') AS urls
  FROM items
  GROUP BY title, source_id
  HAVING c > 1
  ORDER BY c DESC
  LIMIT 15
`).all();
console.log(`  ${dupTitle.length} 组（仅显示前 15）`);
for (const r of dupTitle) {
  console.log(`  ${r.c}x [${r.source_id}] ${r.title.slice(0, 40)}`);
  for (const u of String(r.urls).split(' | ')) console.log(`       ${u}`);
}

const totalDupGroups = store.db.prepare(`
  SELECT COUNT(*) AS n FROM (
    SELECT title, source_id FROM items GROUP BY title, source_id HAVING COUNT(*) > 1
  )
`).get().n;
console.log(`\n  标题重复组总数: ${totalDupGroups}`);

console.log('\n=== 同一学院不同栏目收录了同一条通知 ===');
const crossCol = store.db.prepare(`
  SELECT title, COUNT(DISTINCT source_id) AS n, GROUP_CONCAT(DISTINCT source_id) AS srcs
  FROM items
  GROUP BY title
  HAVING n > 1
  ORDER BY n DESC
  LIMIT 10
`).all();
console.log(`  ${crossCol.length} 组（仅显示前 10）`);
for (const r of crossCol) {
  console.log(`  ${r.n} 个栏目: ${r.title.slice(0, 36)}`);
  console.log(`       ${r.srcs}`);
}

store.close();
