// 精确分析分页结构：找分页控件、试探正确的第 2 页
import { HttpClient } from '../src/core/http.mjs';
import { parseList } from '../src/sources/cms.mjs';

const base = process.argv[2] || 'http://cst.nuc.edu.cn/xwzx/tzgg.htm';
const client = new HttpClient({ timeoutMs: 15000, retries: 0 });

const { html } = await client.fetchHtml(base);

console.log('=== 搜索分页相关 HTML 片段 ===');
for (const kw of ['下一页', '下页', '尾页', '共', '页', 'page', 'Page', 'jump', 'createPage']) {
  let i = html.indexOf(kw);
  let count = 0;
  while (i >= 0 && count < 2) {
    const seg = html.slice(Math.max(0, i - 120), i + 120).replace(/\s+/g, ' ');
    console.log(`  [${kw}] ${seg}`);
    i = html.indexOf(kw, i + 1);
    count++;
  }
}

console.log('\n=== 页面底部 1500 字符（分页控件通常在这里）===');
console.log(html.slice(-1500).replace(/\s+/g, ' '));

console.log('\n=== 试探各种第 2 页 URL ===');
const tries = [
  base.replace(/\.htm$/, '/2.htm'),
  base.replace(/\.htm$/, '_2.htm'),
  base.replace(/\.htm$/, '2.htm'),
  base.replace(/([^/]+)\.htm$/, '$1/index_2.htm'),
  base.replace(/\.htm$/, '/index_2.htm'),
  `${base}?page=2`,
  base.replace(/([^/]+)\.htm$/, '$1/2.htm'),
];
for (const u of tries) {
  try {
    const { html: h } = await client.fetchHtml(u);
    const items = parseList(h, u);
    const dates = items.map((i) => i.date).filter(Boolean).sort();
    if (items.length) {
      console.log(`  ✓ ${u}`);
      console.log(`      ${items.length} 条  ${dates[0]} ~ ${dates[dates.length - 1]}  例: ${items[0].title.slice(0, 34)}`);
    } else {
      console.log(`  · ${u}  → 解析 0 条（${h.length} 字节）`);
    }
  } catch (e) {
    console.log(`  ✗ ${u}`);
  }
}
