/**
 * 探测计算机学院「深层栏目」：学院首页导航里的二级栏目
 * （学生工作 / 研究生培养 / 本科生培养 / 招生信息 下面的子栏目）。
 *
 * 背景：自动发现（discover.mjs）只看学院首页的直链，深度为 1，
 * 于是「考试安排」「培养方案」「学生动态」「就业工作」这些真正对学生有用的
 * 二级栏目从来没进过信源。
 *
 * 用法: node scripts/probe-cst-deep.mjs
 */
import { parseList } from '../src/sources/cms.mjs';
import { totalPages, nextPageUrl } from '../src/sources/paging.mjs';

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36' };

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer()).toString('utf8');
    } catch (e) {
      if (i === 2) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
}

const CANDIDATES = [
  // 学生工作（学生最关心的）
  ['学生工作·首页', 'http://cst.nuc.edu.cn/xsgz.htm'],
  ['学生动态', 'http://cst.nuc.edu.cn/xsgz/xsdt.htm'],
  ['就业工作', 'http://cst.nuc.edu.cn/xsgz/jygz.htm'],
  ['团学动态', 'http://cst.nuc.edu.cn/xsgz/txdt.htm'],
  ['科技创新', 'http://cst.nuc.edu.cn/xsgz/kjcx.htm'],
  ['文件汇编', 'http://cst.nuc.edu.cn/xsgz/wjhb.htm'],
  // 本科生培养
  ['本科生培养·首页', 'http://cst.nuc.edu.cn/bkspy.htm'],
  ['考试安排', 'http://cst.nuc.edu.cn/bkspy/ksap.htm'],
  ['管理文件', 'http://cst.nuc.edu.cn/bkspy/glwj.htm'],
  ['教学成果', 'http://cst.nuc.edu.cn/bkspy/jxcg.htm'],
  // 研究生培养
  ['研究生培养·首页', 'http://cst.nuc.edu.cn/yjspy.htm'],
  ['培养方案', 'http://cst.nuc.edu.cn/yjspy/pyfa.htm'],
  ['学位管理', 'http://cst.nuc.edu.cn/yjspy/xwgl.htm'],
  ['教育管理', 'http://cst.nuc.edu.cn/yjspy/jygl.htm'],
  // 下载专区
  ['下载专区·综合科', 'http://cst.nuc.edu.cn/xzzq/zhk.htm'],
  ['下载专区·学生科', 'http://cst.nuc.edu.cn/xzzq/xsk.htm'],
  ['下载专区·团委', 'http://cst.nuc.edu.cn/xzzq/tw.htm'],
  ['下载专区·科研科', 'http://cst.nuc.edu.cn/xzzq/kyk.htm'],
  // 招生
  ['招生信息·首页', 'http://cst.nuc.edu.cn/zsxx.htm'],
  ['本科生招生', 'http://cst.nuc.edu.cn/zsxx/bkszs.htm'],
  ['硕士生招生', 'http://cst.nuc.edu.cn/zsxx/ssszs.htm'],
  ['博士生招生', 'http://cst.nuc.edu.cn/zsxx/bsszs.htm'],
  // 科研
  ['科研动态', 'http://cst.nuc.edu.cn/kxyj/kydt.htm'],
  // 党群
  ['工会工作', 'http://cst.nuc.edu.cn/dqgz/ghgz.htm'],
  ['规章制度', 'http://cst.nuc.edu.cn/dqgz/gzzd.htm'],
];

console.log('栏目'.padEnd(20), '条目', '总页', '最新', '最早', '  首条标题');
const ok = [];
for (const [name, url] of CANDIDATES) {
  try {
    const html = await get(url);
    const items = parseList(html, url);
    const dates = items.map((i) => i.date).filter(Boolean).sort();
    const tp = totalPages(html);
    const fresh = dates[dates.length - 1] || '-';
    // 只看最近 12 个月内有更新的
    const monthsOld = fresh === '-' ? 999 : (Date.now() - new Date(fresh).getTime()) / (30 * 86400000);
    const flag = monthsOld <= 12 ? '★' : ' ';
    console.log(
      flag, name.padEnd(18),
      String(items.length).padStart(4),
      String(tp ?? '?').padStart(4),
      String(fresh).padStart(11),
      String(dates[0] || '-').padStart(11),
      ' ', (items[0]?.title || '').slice(0, 34),
    );
    if (items.length && monthsOld <= 12) ok.push({ name, url, n: items.length, latest: fresh, totalPages: tp });
  } catch (e) {
    console.log(' ', name.padEnd(18), '  ERROR ' + e.message);
  }
}

console.log(`\n★ = 最近 12 个月内有更新（共 ${ok.length} 个）：`);
for (const c of ok) console.log(`  ${c.name}  ${c.latest}  首页${c.n}条 共${c.totalPages ?? '?'}页  ${c.url}`);
