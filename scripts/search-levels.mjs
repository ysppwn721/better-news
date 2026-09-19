/**
 * 搜索命中层级分布：判断关键词命中主要来自哪个字段。
 *
 * 用途：回答「搜某个词为什么结果这么多/这么少」。
 * 例如搜「选课」若命中大量「栏目」层级，说明栏目名（教务选课）参与了匹配，
 * 会淹没真正的选课通知——本项目就出现过这个问题，现已把栏目名排除在整串匹配外。
 *
 * 用法: node scripts/search-levels.mjs [关键词...]
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const items = JSON.parse(readFileSync(resolve(ROOT, 'public/data/items.json'), 'utf8'));

/**
 * 与 public/app.js 的 matchScore 保持一致的层级判定。
 * 注意：categoryName 不参与（栏目名不代表内容，会让整栏命中）。
 */
function levelOf(item, q) {
  const t = (item.title || '').toLowerCase();
  if (t.includes(q)) return '标题';
  if ((item.excerpt || '').toLowerCase().includes(q)) return '摘要';
  const tags = [(item.tags || []).join(' '), item.subcategory || ''].join(' ').toLowerCase();
  if (tags.includes(q)) return '标签';
  if ((item.searchText || '').toLowerCase().includes(q)) return '正文';
  if ((item.sourceName || '').toLowerCase().includes(q)) return '来源';
  return null;
}

const kws = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['选课', '奖学金', '推免', '考试', '国家奖学金', '困难认定', '党课', '四六级'];

console.log('关键词            标题   摘要   标签   正文   来源   合计');
for (const kw of kws) {
  const q = kw.toLowerCase();
  const dist = { 标题: 0, 摘要: 0, 标签: 0, 正文: 0, 来源: 0 };
  for (const it of items) {
    const lv = levelOf(it, q);
    if (lv) dist[lv]++;
  }
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  console.log(
    `${kw.padEnd(14, '　')} ${String(dist.标题).padStart(5)} ${String(dist.摘要).padStart(6)} `
    + `${String(dist.标签).padStart(6)} ${String(dist.正文).padStart(6)} ${String(dist.来源).padStart(6)} `
    + `${String(total).padStart(6)}`,
  );
}

console.log('\n说明：界面按 标题 > 摘要 > 标签 > 正文 > 来源 > 分词兜底 排序，');
console.log('      因此「标题」命中会稳定排在前面，正文命中只作为补充。');
