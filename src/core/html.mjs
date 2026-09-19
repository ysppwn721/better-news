/**
 * 轻量 HTML 解析工具（零依赖）。
 *
 * 为什么不直接上 cheerio：中北大学各子站虽然同属 Visual SiteBuilder CMS，
 * 但容器类名三站三样（article-tt / c-title / title），属性引号大小写混用，
 * 且正文容器常存在标签不闭合。正则 + 括号配平比 DOM 解析更鲁棒，也更省依赖。
 */

const NAMED = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ldquo: '“', rdquo: '”',
  hellip: '…', mdash: '—', ndash: '–', middot: '·', times: '×', minus: '−',
  copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', bull: '•', deg: '°',
  rarr: '→', larr: '←', uarr: '↑', darr: '↓', permil: '‰', sect: '§', para: '¶',
};

/** 解码 HTML 实体（含数字实体） */
export function decodeEntities(s) {
  if (!s) return '';
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (full, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return full;
      try { return String.fromCodePoint(code); } catch { return full; }
    }
    const named = NAMED[body] ?? NAMED[body.toLowerCase()];
    return named !== undefined ? named : full;
  });
}

const BLOCK_TAGS = /<\/?(p|div|br|li|ul|ol|tr|td|th|table|h[1-6]|section|article|header|footer|blockquote|pre|hr|figure|figcaption)\b[^>]*>/gi;

/**
 * 抽取纯文本。块级标签结束后补一个换行，行内标签直接剔除（避免中英文粘连）。
 * @param {string} html
 * @param {{keepNewlines?: boolean}} [opts]
 */
export function textOf(html, opts = {}) {
  if (!html) return '';
  const keep = opts.keepNewlines !== false;
  let s = html
    .replace(/<(script|style|noscript|iframe|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, keep ? '\n' : ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|blockquote|pre|td|th)>/gi, keep ? '\n' : ' ')
    .replace(BLOCK_TAGS, keep ? '\n' : ' ')
    .replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  if (!keep) return s.replace(/\s+/g, ' ').trim();
  return s
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export const textFlat = (html) => textOf(html, { keepNewlines: false });

/** 取标签属性值，兼容属性引号大小写与单双引号 */
export function attr(tagHtml, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = tagHtml.match(re);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}

/** 把 <div id="x"> 起始位置扩展为完整元素文本（按同名标签配平） */
export function sliceElement(html, startIdx, tagName = 'div') {
  const open = new RegExp(`<${tagName}\\b`, 'gi');
  const close = new RegExp(`</${tagName}\\s*>`, 'gi');
  open.lastIndex = startIdx;
  const first = open.exec(html);
  if (!first || first.index !== startIdx) {
    // 起始位置不是该标签，退化为到下一个同类闭合
    close.lastIndex = startIdx;
    const c = close.exec(html);
    return c ? html.slice(startIdx, c.index + c[0].length) : html.slice(startIdx, startIdx + 20000);
  }
  let depth = 0, cursor = startIdx;
  while (cursor < html.length) {
    open.lastIndex = cursor;
    close.lastIndex = cursor;
    const o = open.exec(html);
    const c = close.exec(html);
    if (!c) return html.slice(startIdx);
    if (o && o.index < c.index) {
      depth++;
      cursor = o.index + o[0].length;
    } else {
      depth--;
      cursor = c.index + c[0].length;
      if (depth === 0) return html.slice(startIdx, cursor);
    }
  }
  return html.slice(startIdx);
}

/** 找 id 对应元素的完整 HTML；支持传入 id 列表按顺序尝试 */
export function elementById(html, ids) {
  for (const id of [].concat(ids)) {
    const re = new RegExp(`<div\\b[^>]*\\bid\\s*=\\s*["']?${id}["']?[^>]*>`, 'i');
    const m = re.exec(html);
    if (m) return sliceElement(html, m.index, 'div');
  }
  return null;
}

/** 遍历所有 <a>，回调 (href, innerHtml, rawTag) */
export function* anchors(html) {
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    yield { href: attr(m[1], 'href'), inner: m[2], tag: m[1], index: m.index, end: re.lastIndex };
  }
}

export const stripTags = (html) => decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * 在 HTML 中定位首个匹配值，返回 [start, end] 偏移。
 * 用于按优先级链抽取标题/日期。
 */
export function findPattern(html, patterns) {
  for (const p of patterns) {
    const m = typeof p === 'string' ? html.match(new RegExp(escapeRe(p), 'i')) : html.match(p);
    if (m) return m;
  }
  return null;
}

export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
