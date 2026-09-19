/**
 * 一键自检：验证解析器、数据完整性与各 API 是否正常。
 * 用法: node scripts/selftest.mjs [--offline]
 *   --offline 跳过联网检查（只查本地数据与解析器单测）
 */
import { Store } from '../src/store/db.mjs';
import { parseList, parseDetail, parseDate, isRestrictedPage } from '../src/sources/cms.mjs';
import { analyze, makeSummary, inferSubcategory } from '../src/core/keywords.mjs';
import { buildSources, loadDiscovered } from '../src/core/sources.mjs';
import { monthsSince } from '../src/sources/discover.mjs';
import { CATEGORIES } from '../src/sources/registry.mjs';
import { HttpClient } from '../src/core/http.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const offline = process.argv.includes('--offline');
let pass = 0, fail = 0;
const results = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  ✓ ${name}`); }
  else { fail++; results.push(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`); }
}

// ---------- 1. 解析器单测（纯函数，不联网） ----------
console.log('【1】解析器单测');
check('日期: 2026年09月18日', parseDate('发布时间：2026年09月18日') === '2026-09-18', parseDate('发布时间：2026年09月18日'));
check('日期: 09-182026 (学工部格式)', parseDate('09-182026') === '2026-09-18', parseDate('09-182026'));
check('日期: 2026-09-16', parseDate('发布日期：2026-09-16') === '2026-09-16', parseDate('发布日期：2026-09-16'));
check('日期: Sep 15 2026 (英文月份)', parseDate('Sep 15 2026') === '2026-09-15', parseDate('Sep 15 2026'));
check('日期: 拆分为 日+年月', parseDate('<h3>18</h3><span>/ 2026-09</span>') === '2026-09-18', parseDate('<h3>18</h3><span>/ 2026-09</span>'));
check('日期: 非法输入返回 null', parseDate('没有日期') === null);
check('受限页识别', isRestrictedPage('<html><title>系统提示</title>您无权访问此页面</html>') === true);
check('正常页不误判为受限', isRestrictedPage('<div id="vsb_content"><div class="v_news_content">正文</div></div>'.padEnd(5000, 'x')) === false);

// 列表解析（结构照搬主站真实排版：日期在 <a> 之后的兄弟节点里）
const fakeList = `
<ul>
  <li><div class="news-txt"><h3><a href="../info/1014/62063.htm" title="关于开展专项检查的通知">关于开展专项检查的通知</a></h3></div>
      <div class="news-time flexbox"><h3>18</h3><span>/ 2026-09</span></div></li>
  <li><a href="/info/1035/8904.htm">关于做好2026年研究生国家奖学金评审工作的通知</a><span>2026-09-16</span></li>
  <li><a href="/index.htm">首页</a></li>
  <li><a href="/info/1035/8934.htm">09-182026 关于中北大学第六届研究生会主席团候选人名单的公示</a></li>
</ul>`;
const listed = parseList(fakeList, 'https://example.nuc.edu.cn/index/tzgg.htm');
check('列表解析: 条目数=3（导航链接被过滤）', listed.length === 3, `实际 ${listed.length}`);
check('列表解析: 主站拆分日期', listed[0]?.date === '2026-09-18', listed[0]?.date);
check('列表解析: 标准日期', listed[1]?.date === '2026-09-16', listed[1]?.date);
check('列表解析: 学工部日期', listed[2]?.date === '2026-09-18', listed[2]?.date);
check('列表解析: 标题已去掉日期尾巴', !/\d{2}-\d{2}20\d{2}/.test(listed[2]?.title || ''), listed[2]?.title);
// ../info/... 相对 /index/tzgg.htm 解析后回到站点根
check('列表解析: 相对链接已转绝对', listed[0]?.url === 'https://example.nuc.edu.cn/info/1014/62063.htm', listed[0]?.url);

// 详情解析
const fakeDetail = `
<meta name="pageTitle" content="关于开展专项检查的通知">
<div class="article-sm">发布时间：2026年09月18日 作者： 点击量：[1]</div>
<div class="article-p"><div id="vsb_content"><div class="v_news_content">
  <p>各学院：</p><p>请于2026年9月30日前完成材料报送，逾期不予受理。</p>
  <a href="/system/_content/download.jsp?wbfileid=ABC">附件1：申报表.docx</a>
</div></div></div>`;
const det = parseDetail(fakeDetail, 'https://x.nuc.edu.cn/info/1014/62063.htm');
check('详情: 标题来自 meta', det.title === '关于开展专项检查的通知', det.title);
check('详情: 日期', det.date === '2026-09-18', det.date);
check('详情: 正文抽取', det.bodyText.includes('逾期不予受理'), det.bodyText.slice(0, 40));
check('详情: 附件识别', det.attachments.length === 1 && det.attachments[0].name.includes('申报表'), JSON.stringify(det.attachments));
check('详情: 附件链接转绝对', det.attachments[0]?.url.startsWith('https://x.nuc.edu.cn/'), det.attachments[0]?.url);

const restricted = parseDetail('<html><title>系统提示</title><p>您无权访问此页面</p></html>', 'https://x/', { title: '列表页标题', date: '2026-09-01' });
check('详情: 受限页回落到列表标题', restricted.title === '列表页标题' && restricted.restricted === true, JSON.stringify(restricted.title));

// ---------- 2. 关键词规则 ----------
console.log('\n【2】关键词规则');
check('选课通知 → 选课标签', analyze('关于2026-2027学年第一学期美育课程选课的通知').tags.includes('选课'));
check('免试攻读不误标考试', !analyze('关于2027年推荐免试攻读硕士研究生的名单公示').tags.includes('考试'));
check('国家奖学金评审 → 评奖评优', analyze('关于做好2026年研究生国家奖学金评审工作的通知').tags.includes('评奖评优'));
check('数学建模竞赛 → 竞赛创新', analyze('2026研究生数学建模竞赛正式报名通知').tags.includes('竞赛创新'));
check('经费报账不误标评优', !analyze('关于2025年山西省研究生创新项目经费报账的通知').tags.includes('评奖评优'));
check('党支部 → 党务工作', analyze('教务部党支部召开党员大会').tags.includes('党务工作'));
check('摘要去掉公文抬头', makeSummary('各学院：为做好选课工作，现将有关事项通知如下。') === '为做好选课工作，现将有关事项通知如下。', makeSummary('各学院：为做好选课工作，现将有关事项通知如下。'));
check('二级分类推断', inferSubcategory('关于选课工作的通知') === '选课', inferSubcategory('关于选课工作的通知'));

// ---------- 3. 信源装配 ----------
console.log('\n【3】信源装配');
const sources = buildSources();
check('内置信源 ≥ 10 个', sources.filter((s) => !s.id.startsWith('col-')).length >= 10, String(sources.length));
check('学院信源已装配', sources.some((s) => s.id.startsWith('col-')), String(sources.filter((s) => s.id.startsWith('col-')).length));
check('所有信源都有栏目地址', sources.every((s) => !!s.listUrl), sources.filter((s) => !s.listUrl).map((s) => s.id).join(','));
check('信源 id 无重复', new Set(sources.map((s) => s.id)).size === sources.length);
const catIds = new Set(CATEGORIES.map((c) => c.id));
check('信源栏目 id 合法', sources.every((s) => catIds.has(s.categoryId)), sources.filter((s) => !catIds.has(s.categoryId)).map((s) => s.id).join(','));

// 学院栏目覆盖度：曾因只取综合分前 2 个栏目而漏掉「最近才更新」的栏目，
// 导致用户反馈「学院最近发的通知全没有」。这里把「不能漏掉活跃栏目」变成回归断言。
//
// 注意判据不是「每学院至少 N 个栏目」——有些学院站点本身内容就很少
// （创新创业学院、仪器与电子学院、卓越工程师学院各自只有 1 个可用栏目），
// 强行补第 2 个只会引入无关内容。真正要防的是「站点有活跃栏目却未被纳入」。
const collegeSrc = sources.filter((s) => s.id.startsWith('col-'));
const perCollege = new Map();
for (const s of collegeSrc) {
  const base = s.id.replace(/-\d+$/, '');
  perCollege.set(base, (perCollege.get(base) || 0) + 1);
}
check('学院信源总数 ≥ 40', collegeSrc.length >= 40, `实际 ${collegeSrc.length}`);
check('每个学院至少 1 个栏目', [...perCollege.values()].every((n) => n >= 1), `共 ${perCollege.size} 个学院`);
const cstSources = collegeSrc.filter((s) => s.id.startsWith('col-cst'));
check('计算机学院栏目 ≥ 4 个', cstSources.length >= 4,
  `${cstSources.length} 个: ${cstSources.map((s) => s.name).join(' / ')}`);

// 脚本编码体检：PowerShell 5.1 读 .ps1 时按系统 ANSI 代码页解码，
// 带中文的 .ps1 若没有 UTF-8 BOM 会被解成乱码并直接语法报错
// （踩过：编辑脚本时工具顺手去掉了 BOM，导致 -Register 注册计划任务整条失败）。
{
  const psFiles = readdirSync(resolve(ROOT, 'scripts')).filter((f) => f.endsWith('.ps1'));
  const bad = psFiles.filter((f) => {
    const b = readFileSync(resolve(ROOT, 'scripts', f));
    return !(b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF);
  });
  check('PowerShell 脚本带 UTF-8 BOM', bad.length === 0, bad.join(', '));
}

// 覆盖度体检：检查「候选中的通知类栏目是否都被纳入」。
//
// 为什么只盯通知类：学生的核心诉求就是通知公告。学院站的活跃栏目常有 7~10 个，
// 超过每学院上限（8）时必然有取舍，全部纳入既不现实也会稀释信息。
// 但「通知公告」这类栏目一个都不能漏——曾出现电气与控制工程学院的
// 「通知公告」因比教学类栏目晚一天而被挤掉的情况。
const discovered = loadDiscovered();
let missedNotice = [];
for (const [key, entry] of Object.entries(discovered)) {
  const candidates = entry.candidates || [];
  const noticeCols = candidates.filter((c) => /通知|公告|公示/.test(c.name || ''));
  if (!noticeCols.length) continue;
  const chosenUrls = new Set((entry.columns || []).map((c) => c.url));
  const missed = noticeCols.filter((c) => !chosenUrls.has(c.url) && monthsSince(c.latest) <= 12);
  if (missed.length) {
    missedNotice.push(`${entry.collegeName}: ${missed.map((c) => `${c.name}(${c.latest})`).join(', ')}`);
  }
}
check('候选中的通知类栏目均已纳入', missedNotice.length === 0,
  missedNotice.slice(0, 3).join(' | ') || '全部已覆盖');

// ---------- 4. 本地数据 ----------
console.log('\n【4】本地数据');
const store = new Store();
const counts = store.counts();
if (counts.total === 0) {
  results.push('  · 库为空，跳过数据检查（先运行 npm run fetch）');
} else {
  const noDate = store.db.prepare('SELECT COUNT(*) AS n FROM items WHERE published_at IS NULL').get().n;
  check('条目全部有发布日期', noDate / counts.total < 0.02, `缺日期 ${noDate}/${counts.total}`);
  // 标题异常判定：
  //   · 正文特征词出现在标题里 → 抽取到了正文段落（这是真正要抓的）
  //   · 超长标题：阈值放到 200 字，因为英文学术讲座题目本身就可能上百字符
  //     （如「数学前沿论坛100期 题目：A priori estimates and ...」138 字，属正常数据）
  const badTitle = store.db.prepare(`
    SELECT COUNT(*) AS n FROM items
    WHERE length(title) > 200
       OR title LIKE '%一审%' OR title LIKE '%责编%'
       OR title LIKE '%现将%' OR title LIKE '%如有异议%'
       OR title LIKE '%联系电话%' OR title LIKE '%名单如下%'
  `).get().n;
  check('无标题抽取异常（正文特征词或超长）', badTitle === 0, `${badTitle} 条`);
  const sysTitle = store.db.prepare("SELECT COUNT(*) AS n FROM items WHERE title LIKE '%系统提示%'").get().n;
  check('无「系统提示」错误标题', sysTitle === 0, `${sysTitle} 条`);
  const badUrl = store.db.prepare("SELECT COUNT(*) AS n FROM items WHERE url NOT LIKE 'http%'").get().n;
  check('URL 均为绝对地址', badUrl === 0, `${badUrl} 条`);
  const withBody = store.db.prepare("SELECT COUNT(*) AS n FROM items WHERE length(COALESCE(body_text,'')) > 30").get().n;
  const restricted = store.restrictedCount();
  check('正文抓取率 ≥ 70%', withBody / counts.total >= 0.7, `${withBody}/${counts.total}（受限 ${restricted}）`);
  const dup = store.db.prepare('SELECT COUNT(*) AS n FROM (SELECT url FROM items GROUP BY url HAVING COUNT(*) > 1)').get().n;
  check('无重复 URL', dup === 0, `${dup} 组`);
  const catStat = store.categoryStats();
  check('栏目分布非空', catStat.length >= 3, String(catStat.length));
}
store.close();

// ---------- 5. 联网检查（可选） ----------
if (!offline) {
  console.log('\n【5】联网检查（抓取 3 个核心信源首页）');
  const client = new HttpClient({ timeoutMs: 15000, retries: 1 });
  for (const id of ['www-tzgg', 'xsgzb-tzgg', 'jwc-tzgg']) {
    const src = sources.find((s) => s.id === id);
    if (!src) { check(`信源 ${id} 存在`, false); continue; }
    try {
      const { html } = await client.fetchHtml(src.listUrl);
      const items = parseList(html, src.listUrl);
      const dated = items.filter((i) => i.date).length;
      check(`${src.name}: 解析到条目且带日期`, items.length >= 5 && dated >= items.length * 0.9,
        `${items.length} 条 / 带日期 ${dated}`);
    } catch (e) {
      check(`${src.name}: 抓取成功`, false, e.message.slice(0, 60));
    }
  }
}

console.log(`\n${results.join('\n')}`);
console.log(`\n结果: ${pass} 项通过, ${fail} 项失败`);
process.exit(fail ? 1 : 0);
