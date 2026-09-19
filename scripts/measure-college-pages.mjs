/**
 * 量化「学院栏目被截断」：对若干学院栏目实际翻页，统计真实可抓条目数
 * 与「只翻 1 页」的差距。
 *
 * 用法: node scripts/measure-college-pages.mjs [maxPages]
 */
import { collectListPages, totalPages, nextPageUrl } from '../src/sources/paging.mjs';
import { parseList } from '../src/sources/cms.mjs';

const MAXP = Number(process.argv[2] || 16);
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36' };

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const b = Buffer.from(await r.arrayBuffer());
      return b.toString('utf8');
    } catch (e) {
      if (i === 2) throw e;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
}

const TARGETS = [
  ['计算机·通知公告', 'http://cst.nuc.edu.cn/xwzx/tzgg.htm'],
  ['计算机·学院新闻', 'http://cst.nuc.edu.cn/xwzx/xyxw.htm'],
  ['计算机·教学动态', 'http://cst.nuc.edu.cn/bkspy/jxdt.htm'],
  ['计算机·党建动态', 'http://cst.nuc.edu.cn/dqgz/djdt.htm'],
  ['计算机·教学科', 'http://cst.nuc.edu.cn/xzzq/jxk.htm'],
];

console.log(`每栏目最多翻 ${MAXP} 页，按发布时间截止 6 个月\n`);
console.log('栏目'.padEnd(20), '总页数', '页1条数', '翻页后条数', '翻页数', '最早日期', '最新日期');

for (const [name, url] of TARGETS) {
  try {
    const html1 = await get(url);
    const tp = totalPages(html1);
    const page1 = parseList(html1, url);
    const r = await collectListPages(get, { listUrl: url, maxPages: MAXP, sinceMonths: 6 });
    const dates = r.items.map((i) => i.date).filter(Boolean).sort();
    console.log(
      name.padEnd(20),
      String(tp ?? '?').padStart(6),
      String(page1.length).padStart(7),
      String(r.items.length).padStart(10),
      String(r.pages).padStart(6),
      String(dates[0] || '?').padStart(11),
      String(dates[dates.length - 1] || '?').padStart(11),
    );
  } catch (e) {
    console.log(name.padEnd(20), 'ERROR ' + e.message);
  }
}

// 顺带看一眼分页控件到底有没有被正确识别
const html = await get(TARGETS[0][1]);
console.log('\n分页控件原始片段:');
const m = html.match(/<span[^>]*class="[^"]*p_next[^"]*"[\s\S]{0,200}/i);
console.log(m ? m[0].replace(/\s+/g, ' ') : '(未找到 p_next)');
console.log('nextPageUrl =>', nextPageUrl(html, TARGETS[0][1]));
console.log('totalPages =>', totalPages(html));
