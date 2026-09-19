/**
 * 抓取编排：列表页 → 增量筛选 → 详情页并发富化 → 打标 → 入库。
 */
import { HttpClient } from '../core/http.mjs';
import { log } from '../core/log.mjs';
import { analyze, inferSubcategory, makeSummary } from '../core/keywords.mjs';
import { parseDetail, parseList } from '../sources/cms.mjs';
import { CATEGORY_MAP, hintCategory } from '../sources/registry.mjs';

/**
 * 按「同站点 + 同标题」去重。
 *
 * 为什么需要：学院常把同一条通知同时发在多个栏目下，于是产生多个 URL
 * （例如信息与通信工程学院的研究生奖学金公示同时出现在 /info/1056/ 与 /info/1024/）。
 * 以 URL 为唯一键无法识别这种情况，学生就会在列表里看到同一条通知出现两次。
 *
 * 保留策略：同一标题保留发布时间较新的一份；时间相同则保留先遇到的。
 * 只在同一站点内去重——不同部门发布同名通知属于正常情况，不应合并。
 */
export function dedupeByTitle(items) {
  const best = new Map();
  for (const it of items) {
    let host = '';
    try { host = new URL(it.url).hostname.replace(/^www\./, ''); } catch { host = it.url; }
    const key = `${host}::${(it.title || '').replace(/\s+/g, '')}`;
    const prev = best.get(key);
    if (!prev) { best.set(key, it); continue; }
    const a = it.date || '';
    const b = prev.date || '';
    if (a > b) best.set(key, it);
  }
  // 保持原有顺序输出，只剔除被判定为重复的条目
  const keep = new Set([...best.values()].map((x) => x.url));
  const out = items.filter((x) => keep.has(x.url));
  return { items: out, removed: items.length - out.length };
}

/** 简单并发池：避免对校园网站点造成压力，同时保证速度 */
async function pooled(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (e) {
        results[idx] = { __error: e.message, item: items[idx] };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export class Fetcher {
  /**
   * @param {import('../store/db.mjs').Store} store
   * @param {{concurrency?: number, timeoutMs?: number, enrichLimit?: number}} [opts]
   */
  constructor(store, opts = {}) {
    this.store = store;
    this.client = opts.client || new HttpClient({ timeoutMs: opts.timeoutMs ?? 20000 });
    this.concurrency = opts.concurrency ?? 4;
    this.enrichLimit = opts.enrichLimit ?? 25; // 每个信源每次最多抓多少篇详情
    this.onProgress = opts.onProgress || null;
  }

  /**
   * 抓取单个信源
   * @param {object} source {id,name,categoryId,listUrl,pageTemplate,maxPages}
   * @param {{pages?: number, maxItems?: number, enrich?: boolean}} [opts]
   */
  async fetchSource(source, opts = {}) {
    const pages = Math.min(opts.pages ?? source.maxPages ?? 1, 10);
    const maxItems = opts.maxItems ?? 80;
    const enrich = opts.enrich !== false;
    const listUrl = source.listUrl;

    if (!listUrl) {
      return { sourceId: source.id, ok: false, error: '未配置栏目地址', fetched: 0, inserted: 0 };
    }

    // 登记信源（走 API 手动抓取时也能保证信源表是最新的）
    this.store.registerSource({
      id: source.id, name: source.name, categoryId: source.categoryId,
      listUrl: source.listUrl, builtin: true, sort: source.sort ?? 100,
    });

    // 1) 收集列表条目（含翻页）
    const collected = new Map();
    let firstError = null;
    for (let p = 1; p <= pages; p++) {
      const url = p === 1
        ? listUrl
        : (source.pageTemplate
          ? source.pageTemplate.replace('{page}', p)
          : derivePageUrl(listUrl, p));
      if (!url) break;
      try {
        const { html } = await this.client.fetchHtml(url);
        const items = parseList(html, url);
        if (!items.length) break;
        for (const it of items) if (!collected.has(it.url)) collected.set(it.url, it);
      } catch (e) {
        if (p === 1) firstError = e.message;
        log.debug(`列表翻页失败 ${url}: ${e.message}`);
        break;
      }
    }

    if (!collected.size) {
      this.store.markSourceFetch(source.id, { status: `失败: ${firstError || '无条目'}`, error: firstError ? 1 : 0 });
      return { sourceId: source.id, ok: false, error: firstError || '列表页无条目', fetched: 0, inserted: 0 };
    }

    let all = [...collected.values()].slice(0, maxItems);

    // 同一通知常被发在多个栏目下（产生多个 URL），按标题去重后再入库
    const deduped = dedupeByTitle(all);
    all = deduped.items;
    if (deduped.removed > 0) {
      log.debug(`[${source.name}] 标题去重移除 ${deduped.removed} 条跨栏目重复`);
    }

    // 2) 增量：已入库且未过期的条目直接跳过详情抓取
    const known = new Map();
    for (const it of all) {
      const row = this.store.findItemByUrl(it.url);
      if (row) known.set(it.url, row);
    }

    const needDetail = enrich ? all.slice(0, this.enrichLimit) : [];
    const targets = needDetail.filter((it) => !known.has(it.url));
    // 已知条目中时间最近的少量几条复查一次（应对「先发后改」的补充通知）
    // 受限条目（需校内网）不复查——重试也不会成功，只会浪费请求。
    const recheck = needDetail
      .filter((it) => known.has(it.url) && !known.get(it.url).restricted)
      .slice(0, 3);
    const toFetch = [...targets, ...recheck];

    log.info(`[${source.name}] 列表 ${all.length} 条，待抓详情 ${targets.length} 条（另有 ${known.size} 条已入库）`);

    // 3) 并发抓详情
    let done = 0;
    const details = await pooled(toFetch, this.concurrency, async (it) => {
      try {
        const { html, url } = await this.client.fetchHtml(it.url);
        const d = parseDetail(html, url || it.url, { title: it.title, date: it.date });
        done++;
        this.onProgress?.({ source: source.name, done, total: toFetch.length, title: d.title || it.title });
        return { list: it, detail: d };
      } catch (e) {
        // 详情失败不致命：保留列表页已有的标题与日期
        return { list: it, detail: null, error: e.message };
      }
    });

    // 4) 组装入条
    let inserted = 0, updated = 0, failed = 0, restricted = 0;
    for (const r of details) {
      if (!r || r.__error) { failed++; continue; }
      const { list: li, detail } = r;
      if (r.error) failed++;
      if (detail?.restricted) restricted++;
      // 标题优先用详情页，但受限页/空标题时回落到列表页标题（绝不用「系统提示」这类错误页标题）
      const title = (detail?.title && !/^(系统提示|提示信息|错误)$/.test(detail.title))
        ? detail.title
        : li.title;
      const bodyText = detail?.bodyText || '';
      const publishedAt = detail?.date || li.date || null;
      const blob = `${title}\n${bodyText.slice(0, 3000)}`;
      // 标签以标题为准，正文仅做补充（见 keywords.mjs 精度说明）
      const { tags, audiences, important } = analyze(title, bodyText);
      // 信源栏目优先；若信源本身是「学院」，允许关键词把明显属于某部门的条目归位
      let categoryId = source.categoryId;
      if (categoryId === 'college' || categoryId === 'other') {
        const hinted = hintCategory(blob, categoryId);
        if (hinted !== categoryId) categoryId = hinted;
      }
      const categoryName = CATEGORY_MAP[categoryId]?.name || '其他';

      const res = this.store.saveItem({
        url: li.url,
        title,
        summary: detail?.restricted
          ? '该通知正文需在校园网内访问，请点击「查看原文」跳转官网查看。'
          : makeSummary(bodyText || detail?.metaDescription || ''),
        bodyText,
        bodyHtml: detail?.bodyHtml || '',
        attachments: detail?.attachments || [],
        image: detail?.image || null,
        publishedAt,
        sourceId: source.id,
        sourceName: source.name,
        categoryId,
        categoryName,
        subcategory: inferSubcategory(title),
        tags: [...new Set([...tags, ...audiences])],
        important,
        restricted: !!detail?.restricted,
      });
      if (res.inserted) inserted++;
      else if (res.updated) updated++;
    }

    const listOnly = all.length - toFetch.length;
    const status = firstError
      ? `部分成功（${firstError.slice(0, 40)}）`
      : `成功 新增${inserted} 更新${updated} 复用${listOnly}${restricted ? ` 校内受限${restricted}` : ''}`;
    this.store.markSourceFetch(source.id, { status, count: inserted, error: failed });

    return {
      sourceId: source.id, sourceName: source.name, ok: true,
      fetched: all.length, inserted, updated, failed, restricted,
    };
  }

  /**
   * 批量抓取
   * @param {Array<object>} sources
   */
  async fetchAll(sources, opts = {}) {
    const started = Date.now();
    const results = [];
    for (const s of sources) {
      if (opts.signal?.aborted) break;
      try {
        results.push(await this.fetchSource(s, opts));
      } catch (e) {
        log.error(`[${s.name}] 抓取异常: ${e.message}`);
        this.store.markSourceFetch(s.id, { status: `异常: ${e.message.slice(0, 60)}`, error: 1 });
        results.push({ sourceId: s.id, sourceName: s.name, ok: false, error: e.message });
      }
    }
    const inserted = results.reduce((n, r) => n + (r.inserted || 0), 0);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    log.info(`抓取完成：${results.length} 个信源，新增 ${inserted} 条，耗时 ${elapsed}s`);
    return { results, inserted, elapsed: Number(elapsed) };
  }
}

/** 列表页翻页 URL 推导：/index/tzgg.htm → /index/tzgg/2.htm */
export function derivePageUrl(listUrl, page) {
  const m = listUrl.match(/^(.*?)(\d*)\.(htm|html)$/i);
  if (!m) return null;
  const [, base, , ext] = m;
  const cleanBase = base.replace(/\/\d+$/, '');
  return `${cleanBase}${page}.${ext}`;
}
