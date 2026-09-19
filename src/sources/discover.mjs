/**
 * 栏目自动发现：从站点首页找出「通知公告 / 学院新闻」类列表页。
 *
 * 为什么需要：23 个学院的栏目路径各不相同且会随改版变化（/tzgg.htm、/index/tzgg.htm、
 * /xwzx/tzgg.htm、/notice.htm……），硬编码必然腐坏。改为按「锚文本语义 + 列表页特征」
 * 打分挑选，站点改版后重新发现即可，不需要改代码。
 */
import { attr, stripTags } from '../core/html.mjs';
import { parseList, isArticleUrl } from './cms.mjs';
import { log } from '../core/log.mjs';

/** 栏目名语义权重 */
const NAME_SCORES = [
  [/通知公告|通知与公告|公告通知|通知$|公告$/, 100],
  [/学院新闻|新闻动态|学院动态|新闻中心|要闻/, 80],
  [/研究生|本科生|教学|教务|科研|学生工作|党建|党务/, 55],
  [/公示|招标|学术|讲座|活动|就业/, 35],
  [/招聘|招生/, 25],
];
/** 明显不是栏目的名字 */
const NAME_BLOCK = /^(首页|网站首页|返回|更多|more|下载|English|联系我们|机构设置|部门简介|学院概况|学校概况|师资|人才培养|学科建设|友情链接)/i;

function scoreName(text) {
  if (!text || text.length > 20) return 0;
  if (NAME_BLOCK.test(text)) return -1;
  for (const [re, s] of NAME_SCORES) if (re.test(text)) return s;
  return 0;
}

/**
 * 内容实测打分：光看栏目名不够——「教学科」「本科生招生」这类名字也可能命中，
 * 但里面的文章未必是学生要看的通知。真正的判据是栏目里的文章标题长什么样：
 * 「关于开展…的通知」「…名单公示」「…选课安排」才是可行动信息。
 */
const ACTION_TITLE_RE = /关于|通知|公告|公示|安排|报名|申请|评选|评审|遴选|申报|选课|考试|调整|放假|返校|开学|答辩|毕业|招聘|讲座|活动|采集|核对|提交|截止|名单|要求|办法|方案|会议/;
/** 明确不是学生通知的（人事、科研项目申报、招生录取、领导活动） */
const NON_STUDENT_RE = /公开招聘|人才引进|师资|职称|岗位聘任|采购|招标|中标|询价|工会|离退休|党委理论学习|巡视整改|科研项目申报指南|国家自然科学基金|录取名单|招生简章|招生计划|复试|调剂|录取通知书/;

/**
 * 对候选栏目抽 8 条标题算「可行动信息密度」
 * @returns {number} 0~1
 */
function contentScore(items) {
  const sample = items.slice(0, 8);
  if (!sample.length) return 0;
  let hit = 0;
  for (const it of sample) {
    if (ACTION_TITLE_RE.test(it.title) && !NON_STUDENT_RE.test(it.title)) hit++;
  }
  const ratio = hit / sample.length;
  // 长期不更新的栏目（最新日期早于半年前）降权，但仍保留候选
  const latest = sample.map((i) => i.date).filter(Boolean).sort().pop();
  let fresh = 1;
  if (latest) {
    const months = (Date.now() - new Date(`${latest}T00:00:00+08:00`).getTime()) / (30 * 86400000);
    if (months > 12) fresh = 0.6;
    else if (months > 6) fresh = 0.8;
  }
  return Number((ratio * fresh).toFixed(3));
}

/**
 * 从首页 HTML 发现候选栏目页
 * @returns {Promise<Array<{url, name, score, itemCount, latest, contentScore, sampleTitles}>>}
 */
export async function discoverColumns(client, siteUrl, { maxCandidates = 30, minItems = 4 } = {}) {
  const origin = new URL(siteUrl).origin;
  let html;
  try {
    ({ html } = await client.fetchHtml(siteUrl));
  } catch (e) {
    log.warn(`栏目发现失败(首页) ${siteUrl}: ${e.message}`);
    return [];
  }

  // 收集同源 .htm 链接
  const cands = new Map();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]{1,80}?)<\/a>/gi)) {
    const href = attr(m[1], 'href');
    if (!href || /^(javascript:|mailto:|#)/i.test(href)) continue;
    const text = stripTags(m[2]);
    let s = scoreName(text);
    let display = text;
    // 首页区块里的「MORE / 更多」（如 <H2>通知公告</H2><A href="xwzx/tzgg.htm">MORE</A>）
    // 本身名字没信息量，但它指向的往往正是最重要的通知栏。
    // 取该链接前面的同级标题作为它的名字，把「通知公告」这类语义补回来。
    if (s <= 0 && /^(MORE|更多|more|\.\.\.)$/i.test(text)) {
      const before = html.slice(Math.max(0, m.index - 400), m.index);
      const heading = [...before.matchAll(/<h[1-6][^>]*>([\s\S]{2,30}?)<\/h[1-6]>/gi)].pop()
        || [...before.matchAll(/>([\u4e00-\u9fa5]{2,10})</g)].pop();
      const guess = heading ? stripTags(heading[1]) : '';
      if (guess && scoreName(guess) > 0) {
        s = scoreName(guess) - 1;
        display = guess;
      }
    }
    if (s <= 0) continue;
    let abs;
    try { abs = new URL(href, siteUrl).href; } catch { continue; }
    if (!abs.startsWith(origin)) continue;
    if (/\/info\/\d+\//.test(abs)) continue;      // 文章页
    if (isArticleUrl(abs)) continue;              // article.jsp?wbnewsid= 形式的文章页
    if (!/\.(htm|html)$/i.test(abs)) continue;
    const prev = cands.get(abs);
    if (!prev || prev.score < s) cands.set(abs, { url: abs, name: display, score: s });
  }

  const ranked = [...cands.values()].sort((a, b) => b.score - a.score).slice(0, maxCandidates);
  const good = [];
  // 逐个验证：页面必须真的像列表页（含足够多的文章链接）
  for (const c of ranked) {
    try {
      const { html: lh } = await client.fetchHtml(c.url);
      const items = parseList(lh, c.url);
      if (items.length >= minItems) {
        const latest = items.map((i) => i.date).filter(Boolean).sort().pop() || null;
        good.push({
          ...c,
          itemCount: items.length,
          latest,
          contentScore: contentScore(items),
          sampleTitles: items.slice(0, 5).map((i) => i.title),
        });
      }
    } catch (e) {
      log.debug(`栏目候选不可用 ${c.url}: ${e.message}`);
    }
  }
  // 统一加权排序（名称先验 + 内容实测 + 时效性）
  return applyNameBoost(good);
}

/** 明确是「通知栏」的名称 → 直接置顶（学生的第一诉求就是通知公告栏） */
const NOTICE_NAME_RE = /通知|公告|公示|文件通知|事务通知/;
/** 学生关心的次级栏目 */
const STUDENT_NAME_RE = /学生工作|团学|党群|党建|党务|学工|教务|教学|研究生|培养|奖学金|资助|新闻|就业|科研|招生/;

/** 距今多少个月；无日期返回 Infinity */
export function monthsSince(latest) {
  if (!latest) return Infinity;
  return (Date.now() - new Date(`${latest}T00:00:00+08:00`).getTime()) / (30 * 86400000);
}

/** 候选栏目的最终排序分 */
function rankScore({ score, contentScore, latest }) {
  let total = score * 0.35 + contentScore * 100 * 0.45;
  // 时效性：学院站更新慢，过期栏目必须让位。
  // 权重给得足——「最近真的在更新」是判断栏目是否有用的最强信号，
  // 曾因低估时效性而漏掉学院最新的通知栏（见 commit 记录）。
  if (latest) {
    const months = (Date.now() - new Date(`${latest}T00:00:00+08:00`).getTime()) / (30 * 86400000);
    if (months <= 1) total += 30;
    else if (months <= 3) total += 20;
    else if (months <= 6) total += 8;
    else if (months <= 12) total -= 8;
    else total -= 35; // 一年以上未更新，基本是死栏目
  } else {
    total -= 18; // 连日期都解析不出，多半不是标准列表页
  }
  return total;
}

/** 名称层面的最终加权：通知栏置顶 */
export function applyNameBoost(columns) {
  for (const c of columns) {
    c.nameBoost = NOTICE_NAME_RE.test(c.name) ? 70 : (STUDENT_NAME_RE.test(c.name) ? 18 : 0);
    c.total = rankScore(c) + c.nameBoost;
  }
  return columns.sort((a, b) => b.total - a.total);
}
export function columnKey(name) {
  return String(name || '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/(学院|学部|系|中心|办公室|科室)$/g, '')
    .trim();
}

/**
 * 为一个学院挑选要抓取的栏目。
 *
 * 判据（按优先级）：
 *   1) 最近还在更新的栏目一律纳入（默认 90 天内）——这是学生最在意的：
 *      「学院最近发的通知不能漏」。曾因为只取综合分前 2 个而漏掉最新栏目，
 *      导致用户反馈「最近发的全没有」。
 *   2) 综合分最高的作为兜底，保证每个学院至少有一个入口。
 *   3) 排除内容实测分过低且已停更很久的栏目（如只有 2021 年内容的页面）。
 *
 * @param {Array} columns 已排序的候选栏目
 * @param {number} max 每学院最多抓几个（控制请求量）
 * @param {{freshMonths?: number, minContent?: number}} [opts]
 */
export function pickColumns(columns, max = 6, { freshMonths = 3, minContent = 0.3 } = {}) {
  const out = [];
  const seen = new Set();
  const take = (c) => {
    const key = columnKey(c.name);
    if (seen.has(key)) return false;
    seen.add(key);
    out.push(c);
    return true;
  };

  // 1) 新鲜栏目优先（按综合分顺序遍历，保证都是「通知类」优先）
  for (const c of columns) {
    if (out.length >= max) break;
    if (monthsSince(c.latest) <= freshMonths) take(c);
  }

  // 2) 兜底：保证至少有一个入口
  if (!out.length) {
    for (const c of columns) {
      if (take(c)) break;
    }
  }

  // 3) 补充：质量达标但不够新鲜的重要栏目（如「学院新闻」这类时效稍弱但内容相关的）
  for (const c of columns) {
    if (out.length >= max) break;
    if (c.contentScore >= 0.6 && monthsSince(c.latest) <= 12) take(c);
  }

  // 按综合分排序，让第一个是最重要的（用作默认入口）
  return out.sort((a, b) => b.total - a.total);
}
