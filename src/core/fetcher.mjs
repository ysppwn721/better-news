/**
 * 抓取编排：列表页 → 增量筛选 → 详情页并发富化 → 打标 → 入库。
 */
import { HttpClient } from '../core/http.mjs';
import { log } from '../core/log.mjs';
import { analyze, inferSubcategory, makeSummary } from '../core/keywords.mjs';
import { parseDetail } from '../sources/cms.mjs';
import { collectListPages } from '../sources/paging.mjs';
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
    this.enrichLimit = opts.enrichLimit ?? 40; // 每个信源每次最多抓多少篇详情
    // 整轮详情抓取的总预算。
    //
    // 为什么需要总预算：翻页改为按时间截止后，单轮新增条目会到数百上千条，
    // 若按「每信源 40 条」放开，一轮就是三千多次详情请求，本机定时任务
    // 会被掐断。列表信息（标题+日期+链接）已经足够搜索与列表展示，
    // 正文只是让卡片显示摘要、并让「截止提醒」能读到报名截止日期，
    // 因此按总量封顶、按发布时间从新到旧补，多跑几轮自然补齐。
    this.enrichTotal = opts.enrichTotal ?? 1200;
    this.enrichedSoFar = 0;
    this.onProgress = opts.onProgress || null;
  }

  /**
   * 抓取单个信源
   * @param {object} source {id,name,categoryId,listUrl,pageTemplate,maxPages}
   * @param {{pages?: number, sinceMonths?: number, maxItems?: number, enrich?: boolean}} [opts]
   */
  async fetchSource(source, opts = {}) {
    // 翻页上限的优先级：命令行 --pages > 信源自己的 maxPages > 全局默认 12。
    //
    // ⚠ 这里以前写的是 `opts.pages ?? 12`，即**信源的 maxPages 从来没生效过**：
    //   registry/sources 里给每个信源配的 maxPages（主站 3、学工部 4、学院栏目 6…）
    //   全部被这个 12 覆盖。结果是想控制某个栏目的抓取深度时改配置没有任何效果——
    //   排查「学院专栏内容不全」时就被这条误导过一次。
    // 现在把 per-source 配置真正接上；命令行显式给了 --pages 时仍以命令行为准。
    const maxPages = Math.min(opts.pages ?? source.maxPages ?? 12, 40);
    const sinceMonths = opts.sinceMonths ?? 6;
    const maxItems = opts.maxItems ?? 300;
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

    // 1) 收集列表条目（按时间截止翻页；翻页规则与 App 端共用一份实现）
    //
    // 曾经这里用 `栏目/2.htm` 推导页码，而本站 CMS 页码是倒序的——
    // 第 2 页直接跳到 2017 年并停止翻页，网页端因此比 App 端少了半年以上的通知。
    const listing = await collectListPages(
      async (u) => (await this.client.fetchHtml(u)).html,
      { listUrl, maxPages, sinceMonths },
    );
    const firstError = listing.firstError;

    if (!listing.items.length) {
      this.store.markSourceFetch(source.id, { status: `失败: ${firstError || '无条目'}`, error: firstError ? 1 : 0 });
      return { sourceId: source.id, ok: false, error: firstError || '列表页无条目', fetched: 0, inserted: 0 };
    }

    let all = listing.items.slice(0, maxItems);

    // 同一通知常被发在多个栏目下（产生多个 URL），按标题去重后再入库
    const deduped = dedupeByTitle(all);
    all = deduped.items;
    if (deduped.removed > 0) {
      log.debug(`[${source.name}] 标题去重移除 ${deduped.removed} 条跨栏目重复`);
    }

    // 已在库的条目（用于判断「新条目」与「有没有正文」）
    const known = new Map();
    for (const it of all) {
      const row = this.store.findItemByUrl(it.url);
      if (row) known.set(it.url, row);
    }

    // 2) 挑出「还需要抓正文」的条目
    //
    // ⚠ 这里曾经是 `all.slice(0, enrichLimit).filter(未入库)`——只给**新条目**抓正文。
    //   后果：一轮抓完目录后，所有条目都已在库，此后每轮 targets 都是空的，
    //   那些「只抓到列表、没抓到正文」的条目永远补不上正文（实测正文率卡在 51%），
    //   依赖正文的「截止提醒」和卡片摘要随之长期缺失。
    //   现在把「已入库但没有正文」也纳入，并按发布时间从新到旧推进，
    //   多跑几轮就能把正文补齐。
    const needsBody = (it) => {
      const row = known.get(it.url);
      if (!row) return true;                    // 新条目
      if (row.restricted) return false;         // 校内受限页重试没有意义
      return !(row.body_text || '').length;     // 已入库但正文还是空的
    };
    const targets = enrich ? all.filter(needsBody).slice(0, this.enrichLimit) : [];
    // 已知且已有正文的条目里复查最前面几条，应对「先发后改」的补充通知
    const recheck = enrich
      ? all.filter((it) => known.has(it.url) && !needsBody(it)).slice(0, 2)
      : [];
    let toFetch = [...targets, ...recheck];

    // 总预算封顶：本轮剩余额度用完后只抓列表，不再抓详情
    const left = Math.max(0, this.enrichTotal - this.enrichedSoFar);
    if (toFetch.length > left) toFetch = toFetch.slice(0, left);
    this.enrichedSoFar += toFetch.length;

    log.info(`[${source.name}] 列表 ${all.length} 条，待抓详情 ${targets.length} 条（另有 ${known.size} 条已入库）`);

    // 3) 并发抓详情（只处理配额内的条目，其余条目照样入库）
    let done = 0;
    let detailFailed = 0;
    const detailByUrl = new Map();
    await pooled(toFetch, this.concurrency, async (it) => {
      try {
        const { html, url } = await this.client.fetchHtml(it.url);
        const d = parseDetail(html, url || it.url, { title: it.title, date: it.date });
        done++;
        this.onProgress?.({ source: source.name, done, total: toFetch.length, title: d.title || it.title });
        detailByUrl.set(it.url, d);
      } catch (e) {
        // 详情失败不致命：列表页已有的标题与日期照样入库
        detailFailed++;
        detailByUrl.set(it.url, null);
      }
    });

    // 4) 组装入库：**列表里的每一条都要入库**，详情只是补充。
    //
    // ⚠ 这里曾经只遍历抓过详情的条目（toFetch），于是每个信源实际入库的是
    //   「前 enrichLimit 条」——25 条以外的通知被静默丢掉。翻页明明抓回了
    //   学院 50 条通知，库里却只有 25 条，学生看到的就是「新闻不全」。
    let inserted = 0, updated = 0, restricted = 0;
    for (const li of all) {
      const detail = detailByUrl.get(li.url) || null;
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
      : `成功 新增${inserted} 更新${updated} 仅列表${listOnly}${restricted ? ` 校内受限${restricted}` : ''}`;
    this.store.markSourceFetch(source.id, { status, count: inserted, error: detailFailed });

    return {
      sourceId: source.id, sourceName: source.name, ok: true,
      fetched: all.length, inserted, updated, failed: detailFailed, restricted,
    };
  }

  /**
   * 批量抓取
   * @param {Array<object>} sources
   */
  async fetchAll(sources, opts = {}) {
    const started = Date.now();
    const results = [];
    if (opts.enrichTotal != null) this.enrichTotal = opts.enrichTotal;
    this.enrichedSoFar = 0; // 每轮重新计数，预算不跨轮累计
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

/**
 * 列表页翻页 URL 推导：/index/tzgg.htm → /index/tzgg/2.htm
 *
 * ⚠ 已废弃（deprecated）：中北大学的 CMS 页码是**倒序**的，`/2.htm` 指向的是
 * 最老一页而不是第 2 页。翻页一律走 src/sources/paging.mjs 的 collectListPages
 * （从页面「下页」链接读真实地址）。此函数仅为兼容旧脚本保留。
 */
export function derivePageUrl(listUrl, page) {
  const m = listUrl.match(/^(.*?)(\d*)\.(htm|html)$/i);
  if (!m) return null;
  const [, base, , ext] = m;
  const cleanBase = base.replace(/\/\d+$/, '');
  return `${cleanBase}${page}.${ext}`;
}
