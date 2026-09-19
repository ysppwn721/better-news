/**
 * 通用适配器：中北大学 Visual SiteBuilder (VSB9) CMS。
 *
 * 适用范围：www.nuc.edu.cn 及 jwc / grs / xsgzb / tw 等全部子站——它们共用同一套
 * CMS，因此列表页与详情页的抽取逻辑只需一份。
 *
 * 站点差异（已由多策略链覆盖）：
 *   标题容器  .article-tt（教务） / h1.c-title（学工部） / h3.title（主站）
 *   日期标签  "发布时间："         / "发布日期："            / "发布时间："
 *   日期格式  2026年09月18日       / 2026-09-16               / 2026年09月18日
 *   正文容器  #vsb_content         / #vsb_content             / #vsb_content_2
 *   属性引号  Content=" 与 content=" 混用
 */
import { attr, decodeEntities, elementById, sliceElement, stripTags, textFlat, textOf } from '../core/html.mjs';

const INFO_RE = /\/info\/(\d+)\/(\d+)\.htm/i;
/**
 * 部分学院站仍用旧的 article.jsp 形式：
 *   /article.jsp?urltype=news.NewsContentUrl&wbtreeid=1056&wbnewsid=12077
 * 这类链接同样是有效文章页，需与 info/ 形式一并识别。
 */
const ARTICLE_JSP_RE = /article\.jsp\?(?:[^#]*&)?wbnewsid=(\d+)/i;

/** 从 URL 提取栏目与文章编号；不是文章页返回 null */
export function articleIds(url) {
  const a = url.match(INFO_RE);
  if (a) return { columnId: a[1], articleId: a[2] };
  const b = url.match(ARTICLE_JSP_RE);
  if (b) {
    const tree = url.match(/[?&]wbtreeid=(\d+)/i);
    return { columnId: tree ? tree[1] : null, articleId: b[1] };
  }
  return null;
}

/** 是否为文章详情页 */
export const isArticleUrl = (url) => !!articleIds(url);

/** 链接是否与列表页同站（忽略 www. 前缀差异） */
function isSameSite(absUrl, baseUrl) {
  try {
    const a = new URL(absUrl);
    const b = new URL(baseUrl);
    const norm = (h) => h.replace(/^www\./i, '').toLowerCase();
    return norm(a.hostname) === norm(b.hostname);
  } catch { return false; }
}

/** 列表页可能出现的日期格式 */
const DATE_PATTERNS = [
  // 主站: 日期被拆成两个元素 —— <h3>18</h3><span>/ 2026-09</span>（日在前，年月在后）
  { re: /(?:^|[^\d])(\d{1,2})\s*<\/h3>\s*<span[^>]*>\s*\/\s*(20\d{2})\s*[-/.年]\s*(\d{1,2})/, order: 'dym' },
  { re: /(20\d{2})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*日?/, order: 'ymd' },
  { re: /(\d{2})-(\d{2})(20\d{2})/, order: 'mdy' }, // 学工部: 09-182026
  // 仅有 年-月 时，配合紧邻的「日」数字使用
  { re: /(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*月?(?![\d\-/.])/, order: 'ym' },
];

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** 解析日期字符串 → ISO 日期 (YYYY-MM-DD)，失败返回 null */
export function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/\s+/g, ' ');
  // 英文月份形式（部分学院站模板输出 "Sep 15 2026" / "15 Sep 2026"）
  const en = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})\b/) || s.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(20\d{2})\b/);
  if (en) {
    let mo, dd;
    if (MONTHS[en[1].slice(0, 3).toLowerCase()]) { mo = MONTHS[en[1].slice(0, 3).toLowerCase()]; dd = +en[2]; }
    else { dd = +en[1]; mo = MONTHS[en[2].slice(0, 3).toLowerCase()]; }
    if (mo && dd >= 1 && dd <= 31) return `${en[3]}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }
  for (const { re, order } of DATE_PATTERNS) {
    const m = s.match(re);
    if (!m) continue;
    let y, mo, d;
    if (order === 'ymd') {
      [, y, mo, d] = m.map(Number);
    } else if (order === 'dym') {
      d = Number(m[1]); y = Number(m[2]); mo = Number(m[3]);
    } else {
      mo = Number(m[1]); d = Number(m[2]); y = Number(m[3]);
      if (mo > 12 && d <= 12) [mo, d] = [d, mo]; // 容错 DD-MMYYYY
    }
    if (!y || !mo || !d || mo > 12 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

/** 判断一段 HTML 里是否含日期（用于就近取日期） */
const hasDate = (html) => DATE_PATTERNS.some(({ re }) => re.test(html));

/**
 * 在锚点之后的窗口里找日期。除标准格式外，还处理「日/年月被拆到两个元素」的主站排版：
 *   <a ...>标题</a></h3></div><div class="news-time"><h3>18</h3><span>/ 2026-09</span></div>
 */
const SPLIT_DATE_RE =
  /(\d{1,2})\s*<\/h3>\s*<span[^>]*>\s*\/\s*(20\d{2})\s*[-/.年]\s*(\d{1,2})|(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*月?\s*<\/span>\s*<\w+[^>]*>\s*(\d{1,2})/;

/**
 * 从窗口里取「距离窗口起点最近」的日期。
 *
 * 不能简单地「先找完整日期、再找拆分日期」——列表里相邻条目的日期会串位：
 * 若条目 A 用拆分格式（18 / 2026-09）而条目 B 用完整格式，A 的窗口会先命中 B 的日期，
 * 导致 A 显示成 B 的日期。因此这里比较两种模式的起始位置，取更靠前的那个。
 */
function dateFromWindow(win) {
  const direct = win.match(/(?:20\d{2}[\-/.年]\d{1,2}[\-/.月]\d{1,2}|\d{2}-\d{2}20\d{2}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+20\d{2})/);
  const sm = win.match(SPLIT_DATE_RE);

  if (direct && (!sm || direct.index <= sm.index)) {
    const d = parseDate(direct[0]);
    if (d) return d;
  }
  if (sm) {
    let y, mo, dd;
    if (sm[1]) { dd = +sm[1]; y = +sm[2]; mo = +sm[3]; }
    else { y = +sm[4]; mo = +sm[5]; dd = +sm[6]; }
    if (y && mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    }
  }
  if (direct) {
    const d = parseDate(direct[0]);
    if (d) return d;
  }
  return null;
}

/**
 * 解析列表页 → 条目数组
 * @param {string} html 列表页 HTML
 * @param {string} baseUrl 列表页 URL（用于补全相对链接）
 * @returns {Array<{url, title, date, summary, columnId}>}
 */
export function parseList(html, baseUrl) {
  const items = [];
  const seen = new Set();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = re.exec(html))) {
    const tag = m[1];
    const inner = m[2];
    // 标题：优先 title 属性（截断标题的站点靠它拿全文），否则用锚文本
    const titleAttr = attr(tag, 'title');
    const innerText = textFlat(inner);
    let title = (titleAttr && titleAttr.length >= innerText.length ? titleAttr : innerText)
      .replace(/^[·•\s]+|[·•\s]+$/g, '')
      .trim();
    if (!title || title.length < 6) continue;
    if (!/[\u4e00-\u9fa5]/.test(title)) continue;
    if (/^(更多|详情|查看|下一条|上一条|返回|首页|more)$/i.test(title)) continue;
    // 表格表头 / 栏目标题被当成条目的情况（如「实验室建设>」「标题」「发布时间」）
    if (/^(标题|序号|日期|发布时间|来源|作者|附件|内容|名称|类型|操作)[>:：]?$/.test(title)) continue;
    if (/[>》]$/.test(title) && title.length <= 10) continue;
    if (/^(国家大学生文化素质教育基地|晋公网安备|\（晋\）)/.test(title)) continue;

    const href = attr(tag, 'href');
    if (!href || /^(javascript:|mailto:|#)/i.test(href)) continue;

    let abs;
    try { abs = new URL(decodeEntities(href), baseUrl).href; } catch { continue; }
    // 只收本站链接：页脚的「友情链接 / 快捷入口」常指向其他域名（如 metic.nuc.edu.cn），
    // 其 URL 也可能带 /info/{栏目}/{文章}，若不按域名过滤会混进结果。
    if (!isSameSite(abs, baseUrl)) continue;

    // 日期：锚标签自身 → 锚之后窗口（列表通常「标题……日期」同排，主站日期在锚点之后）
    let date = parseDate(title);
    if (!date) {
      const after = html.slice(m.index, m.index + m[0].length + 600);
      date = dateFromWindow(after);
    }
    if (!date) {
      const before = html.slice(Math.max(0, m.index - 300), m.index);
      date = dateFromWindow(before);
    }

    const isArticle = isArticleUrl(abs);
    // 既不是文章页又没日期 → 多为导航链接，丢弃
    if (!isArticle && !date) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);

    const ids = articleIds(abs);
    items.push({
      url: abs,
      title,
      date,
      summary: '',
      columnId: ids?.columnId || null,
    });
  }

  // 标题清洗：日期可能被包进 <a> 内（学工部列表形如「09-182026 关于……的通知」），
  // 前后都要剥离，否则标题会带上日期、且 parseDate 会误把标题当日期源。
  for (const it of items) {
    it.title = it.title
      .replace(/^\s*(?:20\d{2}\s*[年\-/.]\s*\d{1,2}\s*[月\-/.]\s*\d{1,2}\s*日?|\d{2}-\d{2}20\d{2}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+20\d{2})\s*/, '')
      .replace(/\s*(?:20\d{2}\s*[年\-/.]\s*\d{1,2}\s*[月\-/.]\s*\d{1,2}\s*日?|\d{2}-\d{2}20\d{2}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+20\d{2})\s*$/, '')
      .replace(/^[·•\-\s]+|[·•\-\s]+$/g, '')
      .trim();
  }
  return items;
}

/**
 * 判断是否为「无权访问/系统提示」页。
 * 部分栏目对校外网限制访问（如各学院内部公示），直接请求 article.jsp 会返回
 * 「系统提示 / 您无权访问此页面」。这类页不能当作正文抓取，否则标题会退化成
 * 「系统提示」、正文全空——必须识别出来，只保留列表页已有的标题与日期。
 */
export function isRestrictedPage(html) {
  if (!html) return false;
  if (html.length > 4000) return false;
  return /您无权访问|系统提示|无权访问此页面|请输入密码|Access Denied/i.test(html)
    && !/v_news_content|article-tt|c-title/.test(html);
}

/** 详情页标题：多策略链 */
function parseDetailTitle(html, fallback) {
  const strategies = [
    /<meta\s+name=["']pageTitle["']\s+content=["']([^"']+)["']/i,
    /<meta\s+name=["']pageTitle["']\s+Content=["']([^"']+)["']/i,
    /<div\b[^>]*class=["'][^"']*\barticle-tt\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<h1\b[^>]*class=["'][^"']*\bc-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i,
    /<h3\b[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i,
    /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
    /<h2\b[^>]*>([\s\S]*?)<\/h2>/i,
  ];
  for (const re of strategies) {
    const m = html.match(re);
    const t = m && stripTags(m[1]);
    if (t && t.length >= 4 && /[\u4e00-\u9fa5]/.test(t)) return t;
  }
  // <title> 兜底：剥离站点后缀
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (tm) {
    const t = stripTags(tm[1]).replace(/[-_|—]\s*中北大学[\s\S]*$/, '').trim();
    if (t) return t;
  }
  return fallback || '';
}

/** 详情页发布日期：多策略链 */
function parseDetailDate(html, fallback) {
  const strategies = [
    /(?:发布时间|发布日期|时间)\s*[:：]\s*(20\d{2}\s*[年\-/.]\s*\d{1,2}\s*[月\-/.]\s*\d{1,2}\s*日?)/,
    /<div\b[^>]*class=["'][^"']*\b(article-sm|other-s|art-itro)\b[^"']*["'][^>]*>([\s\S]{0,300}?)<\/div>/i,
  ];
  for (const re of strategies) {
    const m = html.match(re);
    if (!m) continue;
    const d = parseDate(m[1] || m[2]);
    if (d) return d;
  }
  // 主站 meta / 页面顶部区域兜底
  const head = html.slice(0, 40000);
  const near = head.match(/发布时间[^0-9]{0,40}(20\d{2}\s*[年\-/.]\s*\d{1,2}\s*[月\-/.]\s*\d{1,2})/);
  if (near) {
    const d = parseDate(near[1]);
    if (d) return d;
  }
  return fallback || null;
}

/** 详情页正文：定位 #vsb_content* 容器 */
function parseDetailBody(html) {
  const m = html.match(/<div\b[^>]*\bid\s*=\s*["']?(vsb_content(?:_\d+)?)["']?[^>]*>/i);
  if (m) {
    const el = sliceElement(html, m.index, 'div');
    if (el && el.length > 40) return el;
  }
  // 退路：v_news_content 类
  const vm = html.match(/<div\b[^>]*class=["'][^"']*\bv_news_content\b[^"']*["'][^>]*>/i);
  if (vm) {
    const el = sliceElement(html, vm.index, 'div');
    if (el && el.length > 40) return el;
  }
  return null;
}

/** 从正文/页面抽取附件链接 */
function parseAttachments(html, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(m[1], 'href');
    if (!href) continue;
    if (!/(download\.jsp|_content\/download|\.(pdf|docx?|xlsx?|pptx?|zip|rar|wps|et)$)/i.test(href)) continue;
    let abs;
    try { abs = new URL(decodeEntities(href), baseUrl).href; } catch { continue; }
    if (seen.has(abs)) continue;
    seen.add(abs);
    const name = stripTags(m[2]) || decodeURIComponent(abs.split('/').pop() || '附件');
    out.push({ name: name.slice(0, 120), url: abs });
  }
  return out.slice(0, 12);
}

/** 正文首个有意义的图片（用于列表缩略图） */
function parseImage(html, baseUrl) {
  const m = html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/i);
  if (!m) return null;
  try { return new URL(decodeEntities(m[1]), baseUrl).href; } catch { return null; }
}

/**
 * 解析详情页
 * @param {string} html
 * @param {string} url 详情页 URL
 * @param {{title?: string, date?: string|null}} [fallback] 列表页已知信息
 */
export function parseDetail(html, url, fallback = {}) {
  // 受限页：不做任何抽取，交由调用方以列表页信息兜底
  if (isRestrictedPage(html)) {
    return {
      title: fallback.title || '',
      date: fallback.date || null,
      bodyHtml: '',
      bodyText: '',
      attachments: [],
      image: null,
      metaDescription: '',
      wordCount: 0,
      restricted: true,
    };
  }
  const title = parseDetailTitle(html, fallback.title);
  const date = parseDetailDate(html, fallback.date);
  const bodyHtml = parseDetailBody(html);
  const bodyText = bodyHtml ? textOf(bodyHtml) : '';
  const metaDesc = html.match(/<meta\s+name=["']description["']\s+[Cc]ontent=["']([^"']*)["']/i);
  return {
    title,
    date,
    bodyHtml: bodyHtml || '',
    bodyText,
    attachments: parseAttachments(bodyHtml || html, url),
    image: bodyHtml ? parseImage(bodyHtml, url) : null,
    metaDescription: metaDesc ? decodeEntities(metaDesc[1]).trim() : '',
    wordCount: bodyText.replace(/\s/g, '').length,
  };
}

export { INFO_RE };