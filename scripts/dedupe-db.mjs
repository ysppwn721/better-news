/**
 * 清理库内重复条目：同一站点 + 同一标题只保留最新一份。
 *
 * 背景：学院把同一条通知发在多个栏目下会产生多个 URL，
 * 以 URL 为唯一键时会被当作多条收录（如信息与通信工程学院的研究生奖学金公示
 * 同时存在于 /info/1056/ 与 /info/1024/）。抓取端已加去重，这里清理历史数据。
 *
 * 用法: node scripts/dedupe-db.mjs [--dry]
 */
import { Store } from '../src/store/db.mjs';

const dry = process.argv.includes('--dry');
const store = new Store();

const rows = store.db.prepare(
  'SELECT id, url, title, source_id, published_at, first_seen FROM items',
).all();

/** 与抓取端一致的去重键：站点 + 规范化标题 */
function keyOf(r) {
  let host = '';
  try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch { host = r.url; }
  return `${host}::${(r.title || '').replace(/\s+/g, '')}`;
}

const groups = new Map();
for (const r of rows) {
  const k = keyOf(r);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

const toDelete = [];
const samples = [];
for (const [, list] of groups) {
  if (list.length < 2) continue;
  // 保留发布时间最新的一条；时间相同则保留 id 较大（较晚收录）的
  list.sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')) || b.id - a.id);
  const keep = list[0];
  const drop = list.slice(1);
  toDelete.push(...drop.map((d) => d.id));
  if (samples.length < 8) {
    samples.push({ title: keep.title, kept: keep.url, dropped: drop.map((d) => d.url) });
  }
}

console.log(`共 ${rows.length} 条，发现 ${toDelete.length} 条重复\n`);
for (const s of samples) {
  console.log(`  · ${s.title.slice(0, 40)}`);
  console.log(`      保留 ${s.kept}`);
  for (const d of s.dropped) console.log(`      删除 ${d}`);
}

if (!toDelete.length) {
  console.log('\n没有需要清理的重复条目');
  store.close();
  process.exit(0);
}

if (dry) {
  console.log(`\n[试运行] 将删除 ${toDelete.length} 条`);
} else {
  const del = store.db.prepare('DELETE FROM items WHERE id = ?');
  let n = 0;
  for (const id of toDelete) { del.run(id); n++; }
  const after = store.db.prepare('SELECT COUNT(*) AS c FROM items').get().c;
  console.log(`\n已删除 ${n} 条，库内剩余 ${after} 条`);
}

store.close();
