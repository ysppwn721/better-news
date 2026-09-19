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
import { parseDetail, analyze, makeSummary, inferSubcategory, hintCategory, CATEGORY_MAP, collectListPages } from '../shared/entry.mjs';
import { db } from './storage.mjs';

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/122 Mobile Safari/537.36';

/**
 * 带退避重试的抓取。
 *
 * 为什么必须重试：校园站点偶发超时是常态——实测一轮 100 个信源里会有十几个
 * 瞬时失败。此前一旦失败就 break 掉整个信源的翻页，整栏通知凭空消失，
 * 学生看到的就是「新闻不全」。失败重试 3 次可把瞬时失败压到接近 0。
 *
 * 404/403 这类确定性错误不重试——重试也不会成功，只浪费流量和电。
 */
async function fetchText(url, { attempts = 3, timeoutMs = 20000 } = {}) {
  let lastErr = new Error('抓取失败');
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 500 * i));
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
        signal: ac ? ac.signal : undefined,
      });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        if ([403, 404, 410, 451].includes(res.status)) break;
        continue;
      }
      return await res.text();
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`超时 (${timeoutMs}ms)`) : e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastErr;
}

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

/**
 * 按「同站点 + 同标题」去重。
 *
 * 学院常把同一条通知同时发在多个栏目下，产生多个 URL；
 * 以 URL 为唯一键无法识别，学生就会看到同一条通知出现两次。
 * 保留发布时间较新的一份；不同部门的同名通知不合并。
 */
function dedupeByTitle(items) {
  const best = new Map();
  for (const it of items) {
    let host = '';
    try { host = new URL(it.url).hostname.replace(/^www\./, ''); } catch { host = it.url; }
    const key = `${host}::${(it.title || '').replace(/\s+/g, '')}`;
    const prev = best.get(key);
    if (!prev || String(it.date || '') > String(prev.date || '')) best.set(key, it);
  }
  const keep = new Set([...best.values()].map((x) => x.url));
  return items.filter((x) => keep.has(x.url));
}

const isDesktop = () => typeof window !== 'undefined' && !window.Capacitor?.isNativePlatform;

/**
 * 抓取一个信源的列表页（按时间截止翻页），返回条目数组。
 *
 * 翻页规则（倒序页码、以「下页」链接为准）与容错约定集中在 src/sources/paging.mjs，
 * 由 Node 抓取（网页快照）与 App 端共用同一份实现，避免两边行为分叉。
 *
 * @param {object} source 信源配置
 * @param {{maxPages?: number, sinceMonths?: number}} [opts]
 */
export async function fetchSourceList(source, opts = {}) {
  const r = await collectListPages((u) => fetchText(u), {
    listUrl: source.listUrl,
    maxPages: Math.min(opts.maxPages ?? source.maxPages ?? 10, 40),
    sinceMonths: opts.sinceMonths ?? 6,
  });
  // 第 1 页就失败 → 抛出让调用方记为「失败信源」，而不是悄悄当成空栏目
  if (r.firstError && !r.items.length) throw new Error(r.firstError);
  return r.items;
}

/**
 * 抓取一条通知的详情（正文 + 附件）
 */
export async function fetchDetail(url, fallback = {}) {
  try {
    const html = await fetchText(url);
    return parseDetail(html, url, fallback);
  } catch {
    return null;
  }
}

/**
 * 抓取全部信源并写入本地库。
 *
 * 分两阶段，避免历史缺陷：
 *   阶段一：抓列表（含翻页）→ 全量去重 → 入库。此时界面立刻有完整目录。
 *   阶段二（可选）：为「还没有正文」的条目补正文，受 budget 配额限制。
 *
 * 为什么必须分开：此前把「抓详情」和「抓列表」混在一起，
 * 结果只给极少数条目抓了正文（实测 1224 条里只有 23 条有正文），
 * 既搜不到正文内容，详情页也常常空白。
 * 分开之后，目录始终完整，正文按时间倒序逐步补齐，不会拖慢首次可用时间。
 *
 * @param {object} opts
 * @param {Array} opts.sources 信源清单
 * @param {number} opts.concurrency 并发数
 * @param {number} opts.sinceMonths 抓取最近几个月的内容（按时间截止翻页）
 * @param {number} opts.maxPages 每信源最多翻几页（安全上限）
 * @param {number} opts.bodyBudget 本轮最多补多少条正文（0 = 不补）
 * @param {(p:object)=>void} opts.onProgress 进度回调
 * @param {(p:object)=>Promise<void>|void} opts.onBatch 每批入库后的回调（界面据此提前渲染）
 */
export async function runScrape({
  sources,
  concurrency = 6,
  sinceMonths = 6,
  maxPages = 10,
  bodyBudget = 0,
  onProgress,
  onBatch,
} = {}) {
  const started = Date.now();
  const failed = [];

  // ---------- 阶段一：列表 ----------
  //
  // 分批落库（而不是等 102 个信源全抓完再一次写入）：
  // 手机上抓完 102 个信源要 1~3 分钟，若全程不落库，用户打开 App 后
  // 会盯着「正在抓取」干等几分钟、一条内容也看不到——这正是「为什么还在抓取」
  // 的观感来源。现在每完成约 10 个信源就写一次库并通知界面，
  // 十几秒内列表就有内容，剩下的在后台继续补。
  const existing = new Set((await db.allItems()).map((i) => i.url));
  const pending = [];
  let inserted = 0;
  let completed = 0;
  let collectedCount = 0;
  const FLUSH_EVERY = 10;

  /** 把某信源的列表条目组装成待入库对象 */
  const buildItems = (src, items) => items.map((li) => {
    const { tags, audiences, important } = analyze(li.title, '');
    let categoryId = src.categoryId;
    if (categoryId === 'college' || categoryId === 'other') {
      const hinted = hintCategory(li.title, categoryId);
      if (hinted !== categoryId) categoryId = hinted;
    }
    return {
      url: li.url,
      title: li.title,
      summary: '',
      bodyText: '',
      bodyHtml: '',
      attachments: [],
      publishedAt: li.date || null,
      sourceId: src.id,
      sourceName: src.name,
      categoryId,
      categoryName: CATEGORY_MAP[categoryId]?.name || '其他',
      subcategory: inferSubcategory(li.title),
      tags: [...new Set([...tags, ...audiences])],
      important,
      restricted: false,
      firstSeen: new Date().toISOString(),
    };
  });

  const flush = async () => {
    if (!pending.length) return;
    const batch = pending.splice(0, pending.length);
    const unique = dedupeByTitle(batch);
    for (const it of unique) {
      if (!existing.has(it.url)) { inserted++; existing.add(it.url); }
    }
    await db.upsertItems(unique);
    // 通知界面渲染这一批——只写库不通知的话，用户还是要等整轮抓完才看得到内容
    try { await onBatch?.({ total: existing.size }); } catch { /* 渲染失败不影响抓取 */ }
  };

  let done = 0;
  await pooled(sources, concurrency, async (src) => {
    let items = [];
    let error = null;
    // 单个信源失败不能拖垮整轮抓取：记下失败原因，其它信源继续
    try {
      items = await fetchSourceList(src, { maxPages, sinceMonths });
    } catch (e) {
      error = e.message;
    }
    done++;
    onProgress?.({ phase: 'list', done, total: sources.length, source: src.name, found: items.length });
    if (error || !items.length) failed.push(src.name);
    if (items.length) { pending.push(...buildItems(src, items)); collectedCount += items.length; }
    completed++;
    if (completed % FLUSH_EVERY === 0) await flush();
    return { src, count: items.length };
  });

  await flush();

  // 收尾：分批落库可能漏掉「跨批次」的同站同名条目（学院常把同一条通知
  // 发在多个栏目下），最后按全库做一次去重，把多出来的 URL 删掉。
  const all = await db.allItems();
  const uniqueAll = dedupeByTitle(all);
  if (uniqueAll.length !== all.length) {
    const keep = new Set(uniqueAll.map((x) => x.url));
    const dup = all.filter((x) => !keep.has(x.url)).map((x) => x.url);
    await db.deleteItems(dup);
  }

  // 本轮新增计数以「入库后实际条数」为准（分批落库时上面已累加，这里不再重复）

  // ---------- 阶段二：补正文 ----------
  let bodiesFetched = 0;
  if (bodyBudget > 0) {
    const allRows = await db.allItems();
    // 优先补最近发布的、且还没有正文的条目
    const needBody = allRows
      .filter((i) => !(i.bodyText || '').length && !i.restricted)
      .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))
      .slice(0, bodyBudget);

    let d = 0;
    await pooled(needBody, Math.min(4, concurrency), async (item) => {
      const detail = await fetchDetail(item.url, { title: item.title, date: item.publishedAt });
      d++;
      onProgress?.({ phase: 'body', done: d, total: needBody.length, source: item.sourceName });
      if (!detail) return;
      const patch = {
        ...item,
        title: detail.title || item.title,
        publishedAt: detail.date || item.publishedAt,
        bodyText: detail.bodyText || '',
        bodyHtml: detail.bodyHtml || '',
        attachments: detail.attachments || [],
        restricted: !!detail.restricted,
        summary: detail.restricted
          ? '该通知正文需在校园网内访问，请点击「查看原文」跳转官网查看。'
          : makeSummary(detail.bodyText || ''),
      };
      const again = analyze(patch.title, patch.bodyText);
      patch.tags = [...new Set([...again.tags, ...again.audiences])];
      patch.important = again.important;
      delete patch.id;
      await db.upsertItems([patch]);
      bodiesFetched++;
    });
  }

  await db.prune(6000);

  const elapsed = Math.round((Date.now() - started) / 1000);
  return {
    inserted,
    updated: 0,
    sources: sources.length,
    failed,
    elapsed,
    total: collectedCount,
    bodiesFetched,
  };
}
