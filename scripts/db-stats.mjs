/**
 * 快照/数据库体检：确认数据量是否够、关键词是否搜得到。
 *
 * 用户反馈过「学院信息不全、搜选课搜不到」，所以这里把
 * 「总量 / 学院各栏目 / 学生最关心的关键词命中数」打出来，
 * 作为每次改动后的验收依据。
 *
 * 用法: node scripts/db-stats.mjs [--db=路径]
 */
import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbArg = process.argv.find((a) => a.startsWith('--db='));
const DB = dbArg ? dbArg.slice(5) : resolve(ROOT, 'data/better-news.db');

const db = new DatabaseSync(DB, { readOnly: true });
const one = (sql, ...a) => db.prepare(sql).get(...a)?.c ?? 0;

const total = one('select count(*) c from items');
console.log(`库: ${DB}`);
console.log(`条目总数 ${total}`);

const rows = db.prepare(
  "select source_name n, count(*) c, max(published_at) latest from items where source_id like 'col-cst%' group by source_id order by c desc",
).all();
console.log('\n计算机科学与技术学院各栏目:');
for (const r of rows) console.log(`  ${String(r.c).padStart(4)} 条  最新 ${r.latest || '-'}  ${r.n}`);

const dates = db.prepare('select min(published_at) a, max(published_at) b from items where published_at is not null').get();
console.log(`\n日期范围 ${dates.a} ~ ${dates.b}`);

const body = one("select count(*) c from items where body_text is not null and length(body_text) > 50");
console.log(`有正文 ${body} 条（${Math.round(body / Math.max(1, total) * 100)}%）`);

console.log('\n关键搜索词（标题子串）:');
const kws = ['选课', '综测', '综合素质测评', '奖学金', '推免', '推荐免试', '保研', '四、六级', '四六级', '体测', '体质', '考试', '公示', '困难', '认定', '培养方案', '学籍', '转专业', '实习', '毕业', '答辩'];
for (const k of kws) console.log(`  ${k.padEnd(6, '　')} ${one('select count(*) c from items where title like ?', `%${k}%`)}`);

console.log('\n计算机学院里学生最关心的词:');
for (const k of ['选课', '综测', '综合素质', '奖学金', '推免', '考试', '答辩', '毕业', '实习']) {
  console.log(`  ${k.padEnd(6, '　')} ${one("select count(*) c from items where source_id like 'col-cst%' and title like ?", `%${k}%`)}`);
}

console.log('\n最近 12 条:');
for (const r of db.prepare('select published_at d, source_name s, title t from items order by published_at desc limit 12').all()) {
  console.log(`  ${r.d}  [${r.s}] ${r.t.slice(0, 42)}`);
}
db.close();
