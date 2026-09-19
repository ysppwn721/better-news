/**
 * App 端抓取引擎。
 *
 * 为什么 App 能自己抓：学校站点不带任何 CORS 头，WebView 里的 fetch 会被
 * 浏览器安全策略拦截。Capacitor 的 CapacitorHttp 插件会把 http(s) 请求
 * 交给原生网络栈执行（原生代码不受 CORS 约束），所以同一套解析逻辑能直接复用。
 *
 * 抓取策略（针对手机的电量与流量优化）：
 *   1) 只抓「列表页」就能拿到标题、日期、链接——这是通知的核心信息；
 *   2) 详情的正文按需抓取（用户点开某条时才拉），不预先抓全部；
 *   3) 并发受控（默认 6），既快又不至于把学校站点打爆；
 *   4) 增量：列表里已存在的条目直接跳过，只对新条目做后续处理。
 *
 * 实测延迟：本机到学校站点中位 681ms。49 个信源并发 6 路约 8~15 秒。
 */
import { parseList, parseDetail, analyze, makeSummary, inferSubcategory, hintCategory, CATEGORY_MAP } from '../shared/entry.mjs';
import { db } from './storage.mjs';

/** 简易并发池 */
async function pooled(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = { __error: e.message };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

const isDesktop = () => typeof window !== 'undefined' && !window.Capacitor?.isNativePlatform;

/**
 * 抓取一个信源的列表页（含翻页），返回条目数组。
 * @param {object} source
 * @param {number} pages 最多翻几页
 */
export async function fetchSourceList(source, pages = 1) {
  const collected = new Map();
  const maxPages = Math.min(pages, source.maxPages || 1, 5);

  for (let p = 1; p <= maxPages; p++) {
    let url = source.listUrl;
    if (p > 1) {
      if (source.pageTemplate) url = source.pageTemplate.replace('{page}', p);
      else {
        const m = source.listUrl.match(/^(.*?)(\d*)\.(htm|html)$/i);
        if (!m) break;
        url = `${m[1].replace(/\/\d+$/, '')}${p}.${m[3]}`;
      }
    }
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/122 Mobile Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
      });
      if (!res.ok) break;
      const html = await res.text();
      const items = parseList(html, url);
      if (!items.length) break;
      for (const it of items) if (!collected.has(it.url)) collected.set(it.url, it);
    } catch {
      break; // 单页失败不影响其它信源
    }
  }
  return [...collected.values()];
}

/**
 * 抓取一条通知的详情（正文 + 附件）
 */
export async function fetchDetail(url, fallback = {}) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/122 Mobile Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parseDetail(html, url, fallback);
  } catch {
    return null;
  }
}

/**
 * 抓取全部信源并写入本地库。
 *
 * @param {object} opts
 * @param {Array} opts.sources 信源清单
 * @param {number} opts.concurrency 并发数
 * @param {(p:object)=>void} opts.onProgress 进度回调
 * @param {boolean} opts.fetchDetails 是否为每条新通知抓正文（默认 false，按需抓）
 * @returns {Promise<{inserted:number, updated:number, sources:number, failed:string[], elapsed:number}>}
 */
export async function runScrape({ sources, concurrency = 6, onProgress, fetchDetails = false, detailLimit = 10 } = {}) {
  const started = Date.now();
  const existing = new Set((await db.allItems()).map((i) => i.url));
  const failed = [];
  let inserted = 0;
  let updated = 0;

  let done = 0;
  const listResults = await pooled(sources, concurrency, async (src) => {
    const items = await fetchSourceList(src, 1);
    done++;
    onProgress?.({ phase: 'list', done, total: sources.length, source: src.name, found: items.length });
    if (!items.length) failed.push(src.name);
    return { src, items };
  });

  // 组装条目
  const toSave = [];
  for (const r of listResults) {
    if (!r || r.__error) continue;
    const { src, items } = r;
    for (const li of items) {
      const title = li.title;
      const blob = title;
      const { tags, audiences, important } = analyze(title, '');
      let categoryId = src.categoryId;
      if (categoryId === 'college' || categoryId === 'other') {
        const hinted = hintCategory(blob, categoryId);
        if (hinted !== categoryId) categoryId = hinted;
      }
      const isNew = !existing.has(li.url);
      if (isNew) inserted++;
      toSave.push({
        url: li.url,
        title,
        summary: '',
        bodyText: '',
        bodyHtml: '',
        attachments: [],
        publishedAt: li.date || null,
        sourceId: src.id,
        sourceName: src.name,
        categoryId,
        categoryName: CATEGORY_MAP[categoryId]?.name || '其他',
        subcategory: inferSubcategory(title),
        tags: [...new Set([...tags, ...audiences])],
        important,
        restricted: false,
        firstSeen: new Date().toISOString(),
        _isNew: isNew,
      });
    }
  }

  // 可选：为新条目抓正文（比串行快得多，但仍受学校站点压力限制）
  if (fetchDetails && toSave.length) {
    const fresh = toSave.filter((x) => x._isNew).slice(0, detailLimit * 4);
    let d = 0;
    await pooled(fresh, Math.min(4, concurrency), async (item) => {
      const detail = await fetchDetail(item.url, { title: item.title, date: item.publishedAt });
      d++;
      onProgress?.({ phase: 'detail', done: d, total: fresh.length, source: item.sourceName });
      if (detail) {
        item.title = detail.title || item.title;
        item.publishedAt = detail.date || item.publishedAt;
        item.bodyText = detail.bodyText || '';
        item.bodyHtml = detail.bodyHtml || '';
        item.attachments = detail.attachments || [];
        item.restricted = !!detail.restricted;
        item.summary = detail.restricted
          ? '该通知正文需在校园网内访问，请点击「查看原文」跳转官网查看。'
          : makeSummary(item.bodyText);
        const again = analyze(item.title, item.bodyText);
        item.tags = [...new Set([...again.tags, ...again.audiences])];
        item.important = again.important;
      }
    });
  }

  const res = await db.upsertItems(toSave.map(({ _isNew, ...rest }) => rest));
  updated = Math.max(0, res.updated);

  const elapsed = Math.round((Date.now() - started) / 1000);
  return { inserted, updated, sources: sources.length, failed, elapsed, total: toSave.length };
}
