/**
 * 列表页翻页：所有信源共用的「第 N 页在哪」逻辑。
 *
 * 为什么单独抽出来：Node 抓取（bin/bn.mjs，产出网页快照）与 App 端抓取
 * （app/src/scraper.mjs，手机直连）必须用同一套翻页规则。此前两边各写一份，
 * Node 侧用的是 `栏目/2.htm` 这种朴素推导，而中北大学这套 CMS 的页码是**倒序**的，
 * 于是 Node 侧第 2 页直接跳到 2017 年的内容并停止翻页——网页端因此比 App 端
 * 少了大半年的通知（实测 1387 条 vs 1910 条），学生搜「选课」只搜得到 3 条。
 *
 * ⚠ 中北大学（Visual SiteBuilder 9）分页规则：
 *   第 1 页（最新）就是列表页本身，例如 /xwzx/tzgg.htm
 *   第 2 页是 /xwzx/tzgg/71.htm，最后一页是 /xwzx/tzgg/1.htm（最老）
 *   页面上「下页」链接才是权威，必须从 HTML 里读出来，不能靠数字推导。
 */
import { parseList } from './cms.mjs';

/**
 * 从分页控件里读出下一页 URL。
 *
 * @param {string} html 当前页 HTML
 * @param {string} baseUrl 当前页 URL（用于把相对链接转绝对）
 * @returns {string|null}
 */
export function nextPageUrl(html, baseUrl) {
  // 分页控件形如：<span class="p_next p_fun"><a href="tzgg/71.htm">下页</a></span>
  const m = html.match(/<span[^>]*class="[^"]*p_next[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"/i)
    || html.match(/<a[^>]*href="([^"]+)"[^>]*>\s*下页\s*<\/a>/i)
    || html.match(/<a[^>]*href="([^"]+)"[^>]*>\s*下一页\s*<\/a>/i);
  if (!m) return null;
  try {
    return new URL(m[1], baseUrl).href;
  } catch {
    return null;
  }
}

/** 从页面读总页数（仅用于诊断），读不到返回 null */
export function totalPages(html) {
  const m = html.match(/共\s*(\d+)\s*页/) || html.match(/pageCount\s*=\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * 按「发布时间截止线」翻页收集列表条目。
 *
 * 为什么按时间而不是固定页数：栏目每页仅 10 条，固定翻 3 页只覆盖最近一个月，
 * 而「选课通知」「综测通知」这类学生最关心的内容往往两三个月前就发了，
 * 早已被挤出前几页——这正是「学院信息不全、搜不到选课」的根因。
 * 翻到该页最早一条早于截止线即停，既保证覆盖，又不会在低产栏目上白翻。
 *
 * 容错约定：
 *   - 第 1 页失败 → 视为该信源失败（firstError 带回），调用方据此标记；
 *   - 后续页失败 → 保留已抓到的条目正常返回（宁可少几页，也不清空整栏）。
 *
 * @param {(url: string) => Promise<string>} fetchHtml 取回 HTML 文本
 * @param {{listUrl: string, maxPages?: number, sinceMonths?: number, onPage?: Function}} opts
 * @returns {Promise<{items: Array<object>, pages: number, firstError: string|null, oldest: string|null}>}
 */
export async function collectListPages(fetchHtml, {
  listUrl,
  maxPages = 12,
  sinceMonths = 6,
  onPage,
} = {}) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - sinceMonths);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const collected = new Map();
  let url = listUrl;
  let pages = 0;
  let firstError = null;
  let oldest = null;

  while (url && pages < maxPages) {
    pages++;
    let html;
    let items;
    try {
      html = await fetchHtml(url);
      items = parseList(html, url);
    } catch (e) {
      if (pages === 1) firstError = e.message;
      break;
    }

    if (!items.length) break;

    let added = 0;
    for (const it of items) {
      if (!collected.has(it.url)) { collected.set(it.url, it); added++; }
    }
    // 翻页翻到重复内容（分页控件失效或已到底），停止
    if (added === 0 && pages > 1) break;

    const dated = items.map((i) => i.date).filter(Boolean).sort();
    const pageOldest = dated[0] || null;
    const pageNewest = dated[dated.length - 1] || null;
    if (pageOldest && (!oldest || pageOldest < oldest)) oldest = pageOldest;
    onPage?.({ page: pages, url, count: items.length, oldest: pageOldest });

    // 判停：本页「大部分条目」已早于截止线 → 覆盖够了。
    //
    // 这里是按比例而不是按「本页最早一条」判停：有些栏目把一条置顶的老通知
    // （实测有 2014 年的）放在第 1 页，按最早一条判停会在第 1 页就退出，
    // 整栏只抓到 15 条——那正是「新闻不全」的成因之一。
    if (dated.length >= 3) {
      const oldCount = dated.filter((d) => d < cutoffIso).length;
      if (oldCount / dated.length >= 0.6) break;
    } else if (pageNewest && pageNewest < cutoffIso) {
      break; // 条目太少，直接用最新一条判断
    }

    const next = nextPageUrl(html, url);
    if (!next || next === url) break;
    url = next;
  }

  return { items: [...collected.values()], pages, firstError, oldest };
}
