// 排查计算机学院首页新闻列表的日期排版
import { HttpClient } from '../src/core/http.mjs';
import { parseList } from '../src/sources/cms.mjs';

const url = 'http://cst.nuc.edu.cn/';
const client = new HttpClient({ timeoutMs: 25000 });
const { html } = await client.fetchHtml(url);

console.log('页面大小:', html.length, '字节');

// 找一个新闻条目的原始 HTML
const idx = html.indexOf('五寨县第一中学');
console.log('\n=== 「五寨县第一中学」条目原始 HTML ===');
console.log(JSON.stringify(html.slice(Math.max(0, idx - 600), idx + 500)));

console.log('\n=== 页面中所有日期形态 ===');
const dates = [...html.matchAll(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/g)].slice(0, 12).map((m) => m[0]);
console.log('  完整日期:', dates.join(' | ') || '(无)');
const short = [...html.matchAll(/\d{2}-\d{2}20\d{2}|\d{1,2}[-/]\d{1,2}(?!\d)/g)].slice(0, 12).map((m) => m[0]);
console.log('  短日期:', short.join(' | ') || '(无)');

console.log('\n=== 解析结果 ===');
for (const it of parseList(html, url).slice(0, 12)) {
  console.log(`  ${(it.date || '【无】').padEnd(11)} ${it.title.slice(0, 44)}`);
}

// 找出「新闻」区域附近的 class 名
console.log('\n=== 首页可能的列表容器 class ===');
const classes = new Map();
for (const m of html.matchAll(/class="([^"]{2,50})"/g)) {
  const k = m[1];
  classes.set(k, (classes.get(k) || 0) + 1);
}
[...classes.entries()].filter(([k]) => /news|list|xw|item|con|time|date/i.test(k))
  .sort((a, b) => b[1] - a[1]).slice(0, 14)
  .forEach(([k, n]) => console.log(`  ${n}x  ${k}`));
