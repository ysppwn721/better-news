// 探测学院栏目页的分页 URL 形式
import { HttpClient } from '../src/core/http.mjs';
import { parseList } from '../src/sources/cms.mjs';

const cases = [
  'http://cst.nuc.edu.cn/xwzx/tzgg.htm',
  'http://cst.nuc.edu.cn/xwzx/xyxw.htm',
  'http://jwc.nuc.edu.cn/index/tzgg.htm',
  'https://xsgzb.nuc.edu.cn/index/tzgg.htm',
  'http://hkyh.nuc.edu.cn/txgz/gsgg.htm',
];

const client = new HttpClient({ timeoutMs: 15000, retries: 0 });

for (const base of cases) {
  console.log(`\n=== ${base} ===`);
  try {
    const { html } = await client.fetchHtml(base);
    const first = parseList(html, base);
    console.log(`  第 1 页: ${first.length} 条`);
    // 找页面里的分页链接
    const links = [...html.matchAll(/href=["']([^"']*(?:\d+)[^"']*\.(?:htm|html))["']/gi)]
      .map((m) => m[1])
      .filter((h) => /(page|index|\/\d+\.htm|\d+\.htm$)/i.test(h))
      .slice(0, 8);
    console.log(`  疑似分页链接: ${links.length ? links.join(' | ') : '(无)'}`);
    // 检查是否用了 createPageHTML 之类的脚本
    const scriptPage = html.match(/createPageHTML\([^)]*\)|totalPage|pageCount|recordCount/i);
    console.log(`  分页脚本线索: ${scriptPage ? scriptPage[0].slice(0, 60) : '(无)'}`);
  } catch (e) {
    console.log(`  抓取失败: ${e.message.slice(0, 50)}`);
  }
}

// 直接试几种分页 URL
console.log('\n=== 直接试探分页 URL ===');
const tries = [
  'http://cst.nuc.edu.cn/xwzx/tzgg/2.htm',
  'http://cst.nuc.edu.cn/xwzx/tzgg2.htm',
  'http://cst.nuc.edu.cn/xwzx/tzgg/1.htm',
  'http://jwc.nuc.edu.cn/index/tzgg/2.htm',
  'https://xsgzb.nuc.edu.cn/index/tzgg/2.htm',
  'http://hkyh.nuc.edu.cn/txgz/gsgg/2.htm',
];
for (const u of tries) {
  try {
    const { html } = await client.fetchHtml(u);
    const items = parseList(html, u);
    const dates = items.map((i) => i.date).filter(Boolean).sort();
    console.log(`  ✓ ${u}  → ${items.length} 条  日期范围 ${dates[0] || '?'} ~ ${dates[dates.length - 1] || '?'}`);
  } catch (e) {
    console.log(`  ✗ ${u}  (${e.message.slice(0, 30)})`);
  }
}
