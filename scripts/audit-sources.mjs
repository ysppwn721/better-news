/**
 * 数据体检：按信源维度统计条目数、正文率、日期范围，并特别标出重点学院的差距。
 * 用法: node scripts/audit-sources.mjs [过滤子串]
 */
import { Store } from '../src/store/db.mjs';
import { buildSources } from '../src/core/sources.mjs';

const filter = process.argv[2] || '';
const store = new Store();
const sources = buildSources();

const rows = store.db.prepare(`
  SELECT source_id AS sourceId,
         COUNT(*) AS n,
         SUM(CASE WHEN body_text IS NOT NULL AND length(body_text) > 0 THEN 1 ELSE 0 END) AS withBody,
         MIN(published_at) AS oldest,
         MAX(published_at) AS newest
  FROM items GROUP BY source_id
`).all();
const byId = new Map(rows.map((r) => [r.sourceId, r]));

const total = store.db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN body_text IS NOT NULL AND length(body_text)>0 THEN 1 ELSE 0 END) AS b FROM items').get();
console.log(`库内总计 ${total.n} 条，有正文 ${total.b} 条（${(total.b / total.n * 100).toFixed(1)}%）\n`);

console.log('信源'.padEnd(38), '条目'.padStart(5), '有正文'.padStart(6), '正文率'.padStart(7), ' 最早'.padEnd(12), '最新');
let sum = 0;
for (const s of sources) {
  if (filter && !`${s.id} ${s.name}`.includes(filter)) continue;
  const r = byId.get(s.id) || { n: 0, withBody: 0, oldest: '-', newest: '-' };
  sum += r.n;
  const rate = r.n ? `${(r.withBody / r.n * 100).toFixed(0)}%` : '-';
  console.log(
    `${s.id}`.padEnd(16) + `${s.name}`.slice(0, 20).padEnd(22),
    String(r.n).padStart(5), String(r.withBody).padStart(6), rate.padStart(7),
    ` ${String(r.oldest || '-')}`.padEnd(12), String(r.newest || '-'),
  );
}
if (filter) console.log(`\n匹配信源合计 ${sum} 条`);

// 列出配置里存在但库里一条都没有的信源（「压根没抓」的直接证据）
const empty = sources.filter((s) => !(byId.get(s.id)?.n));
if (empty.length) {
  console.log(`\n⚠ 配置里有、但库里 0 条的信源（${empty.length} 个）：`);
  for (const s of empty) console.log(`  ${s.id}  ${s.name}  ${s.listUrl || '(无地址)'}`);
}
store.close?.();
