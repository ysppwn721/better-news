/**
 * 命令行检索：用与应用**完全相同**的匹配规则（标题 + 校园口语别名）查库。
 *
 * 用途：用户反馈「搜综测、搜选课什么也搜不到」时，不必装 APK 就能验证
 * 网页快照里到底有没有这些通知，以及它们落在哪个栏目、日期是哪天。
 *
 * 用法: node scripts/search-db.mjs 选课 推免
 *       node scripts/search-db.mjs 综测 --limit 20 --db=data/better-news.db
 */
import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { titleMatches, expandQuery } from '../src/core/aliases.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const dbArg = argv.find((a) => a.startsWith('--db='));
const limIdx = argv.indexOf('--limit');
const LIMIT = limIdx > -1 ? Number(argv[limIdx + 1]) : 10;
// 注意：没传 --limit 时 limIdx 是 -1，若直接拿 limIdx+1 会把第 0 个关键词过滤掉
const skipIdx = limIdx > -1 ? limIdx + 1 : -1;
const kws = argv.filter((a, i) => !a.startsWith('--') && i !== skipIdx);

if (!kws.length) {
  console.error('用法: node scripts/search-db.mjs <关键词> [更多关键词] [--limit N] [--db=路径]');
  process.exit(1);
}

const db = new DatabaseSync(dbArg ? dbArg.slice(5) : resolve(ROOT, 'data/better-news.db'), { readOnly: true });
const rows = db.prepare('select title, published_at, source_name, category_name from items').all();

for (const kw of kws) {
  const hit = rows.filter((r) => titleMatches(r.title, kw));
  console.log(`\n「${kw}」命中 ${hit.length} 条`);
  const terms = expandQuery(kw);
  if (terms.length > 1) console.log(`  别名展开: ${terms.join(' / ')}`);
  hit.sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));
  for (const r of hit.slice(0, LIMIT)) {
    console.log(`    ${r.published_at || '----------'}  [${r.source_name}] ${r.title.slice(0, 46)}`);
  }
  if (hit.length > LIMIT) console.log(`    … 其余 ${hit.length - LIMIT} 条略`);
}
db.close();
