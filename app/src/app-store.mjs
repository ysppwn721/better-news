/**
 * App 数据层：对 app.js 暴露与网页版完全相同的接口。
 *
 * 网页版有 API / 静态快照两种模式；App 是第三种——**本机抓取**：
 * 直连学校站点抓列表、存进 IndexedDB、界面从本地库读取。
 * 由于接口名一致（data / stateStore / local），public/app.js 一行都不用改。
 */
import { SOURCES, CATEGORIES, COLLEGES, daysUntil, extractDeadlines } from '../shared/entry.mjs';
import { db } from './storage.mjs';
import { runScrape, fetchDetail } from './scraper.mjs';

const LS_PREFIX = 'bn.';
const local = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(LS_PREFIX + key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)); } catch {}
  },
  del(key) { try { localStorage.removeItem(LS_PREFIX + key); } catch {} },
};

/** 已读/收藏：与网页版一致，用 URL 哈希作键（不随数据库重建而错位） */
const keyOf = (item) => {
  const url = typeof item === 'string' ? item : item?.url;
  if (!url) return '';
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
};

const stateStore = {
  readIds: new Set(local.get('readKeys', [])),
  starredIds: new Set(local.get('starredKeys', [])),
  notifiedId: local.get('notifiedId', 0),
  lastVisitMaxId: local.get('lastVisitMaxId', 0),

  key: keyOf,
  isRead: (item) => stateStore.readIds.has(keyOf(item)),
  isStarred: (item) => stateStore.starredIds.has(keyOf(item)),
  setRead(item, on = true) {
    const k = keyOf(item);
    if (!k) return;
    on ? stateStore.readIds.add(k) : stateStore.readIds.delete(k);
    local.set('readKeys', [...stateStore.readIds]);
  },
  setStarred(item, on = true) {
    const k = keyOf(item);
    if (!k) return;
    on ? stateStore.starredIds.add(k) : stateStore.starredIds.delete(k);
    local.set('starredKeys', [...stateStore.starredIds]);
  },
  markAllRead(items) {
    for (const it of items) {
      const k = keyOf(it);
      if (k) stateStore.readIds.add(k);
    }
    local.set('readKeys', [...stateStore.readIds]);
  },
  clearRead() {
    stateStore.readIds.clear();
    local.set('readKeys', []);
  },
  setNotified(id) { stateStore.notifiedId = id; local.set('notifiedId', id); },
  snapshotVisit(maxId) { local.set('lastVisitMaxId', maxId); },
  freshCount(items) {
    const base = stateStore.lastVisitMaxId;
    if (!base) return 0;
    return items.filter((i) => i.id > base).length;
  },
};

/** 抓取运行状态（供界面显示进度） */
const runtime = {
  fetching: false,
  progress: null,
  lastRun: local.get('lastScrapeAt', null),
  lastResult: null,
};

/** 为条目补一个稳定的数字 id（界面用它做「上次访问后的新条目」判断） */
let idSeed = 0;
const withId = (item) => ({ ...item, id: undefined, _stableId: item.url });
function assignIds(items) {
  // 用 URL 排序后分配下标作为 id，保证同一批数据每次启动 id 一致
  const ordered = [...items].sort((a, b) => String(a.url).localeCompare(String(b.url)));
  const map = new Map();
  ordered.forEach((it, i) => map.set(it.url, i + 1));
  idSeed = ordered.length;
  return items.map((it) => ({ ...it, id: map.get(it.url) || 0 }));
}

/**
 * 与网页版 store.js 的 DataSource 保持同名的接口。
 * isApi 置为 true：界面据此启用「刷新」按钮并调用 triggerFetch()。
 */
class AppDataSource {
  constructor() {
    this.mode = 'app';
    this.isApi = true; // 复用「可主动刷新」这套界面逻辑
    this.items = [];
    this.index = null;
    this.detailCache = new Map();
  }

  /** 初始化：读本地库，没有数据则自动抓一次 */
  async init() {
    const [items, lastScrapeAt] = await Promise.all([
      db.allItems(),
      db.getMeta('lastScrapeAt', null),
    ]);

    this.items = assignIds(items);
    runtime.lastRun = lastScrapeAt;

    this.index = {
      generatedAt: lastScrapeAt || new Date().toISOString(),
      version: `app-${this.items.length}-${lastScrapeAt || 'never'}`,
      total: this.items.length,
      important: this.items.filter((i) => i.important).length,
      latestAt: this.items.map((i) => i.publishedAt).filter(Boolean).sort().pop() || null,
      categories: CATEGORIES.map((c) => ({
        ...c,
        total: this.items.filter((i) => i.categoryId === c.id).length,
        latest: this.items.filter((i) => i.categoryId === c.id)
          .map((i) => i.publishedAt).filter(Boolean).sort().pop() || null,
      })),
      sources: SOURCES.map((s) => ({
        id: s.id,
        name: s.name,
        categoryId: s.categoryId,
        categoryName: CATEGORIES.find((c) => c.id === s.categoryId)?.name || '其他',
        listUrl: s.listUrl,
        itemCount: this.items.filter((i) => i.sourceId === s.id).length,
        lastStatus: '本机抓取',
      })),
      colleges: COLLEGES,
      deadlines: this.#buildDeadlines(),
      priorityCollege: 'col-cst',
      priorityCollegeName: '计算机科学与技术学院',
      settings: { notifyCategories: CATEGORIES.map((c) => c.id), notifyImportantOnly: false, pollInterval: 300 },
      runtime,
    };

    // 后台自动刷新：数据为空或已过期时抓一次，不阻塞界面
    this.#scheduleAutoRefresh();
    return this;
  }

  /**
   * 判断数据是否需要刷新，并启动后台抓取。
   *
   * 由 App 自己抓取，所以「新鲜度」完全可控——只要用户打开就抓最新的。
   * 但为了避免每次切回前台都发 49 个请求，加了间隔门槛。
   */
  #scheduleAutoRefresh({ maxAgeMinutes = 30 } = {}) {
    const empty = this.items.length === 0;
    const age = runtime.lastRun ? (Date.now() - new Date(runtime.lastRun).getTime()) / 60000 : Infinity;
    if (!empty && age < maxAgeMinutes) return;
    if (runtime.fetching) return;

    // 延后一点再抓，先让界面把已有数据渲染出来
    setTimeout(() => {
      this.triggerFetch().catch(() => {});
    }, empty ? 300 : 2500);
  }

  /** 供界面调用：数据是否陈旧（用于展示提示） */
  isStale(maxAgeMinutes = 60) {
    if (!runtime.lastRun) return true;
    return (Date.now() - new Date(runtime.lastRun).getTime()) / 60000 > maxAgeMinutes;
  }

  /** 从本地条目里算截止时间（复用共享的识别规则） */
  #buildDeadlines() {
    const out = [];
    for (const it of this.items) {
      const text = `${it.title}\n${(it.bodyText || '').slice(0, 2500)}`;
      const dates = extractDeadlines(text);
      for (const d of dates) {
        const left = daysUntil(d.date);
        if (left >= -1 && left <= 45) {
          out.push({
            // 用与界面一致的条目 id：本类在 init() 里用 URL 顺序重排了 id，
            // 若这里用别的东西作 id，界面的「有截止」筛选与截止面板都会对不上。
            itemId: it.id,
            title: it.title,
            date: d.date,
            daysLeft: left,
            hint: d.hint,
            sourceName: it.sourceName,
            categoryName: it.categoryName,
            important: it.important,
          });
        }
      }
    }
    out.sort((a, b) => a.daysLeft - b.daysLeft);
    return out;
  }

  async loadItems() {
    // 补上摘要字段（卡片要显示、搜索标题未命中时也用它兜底）。
    // 不再生成 searchText：搜索已改为按标题为主，无需把正文带进内存。
    this.items = this.items.map((it) => ({
      ...it,
      excerpt: it.excerpt || (it.bodyText || '').slice(0, 300).replace(/\s+/g, ' ').trim(),
    }));
    return this.items;
  }

  /** 详情：优先用本地已存的正文，没有就现场抓一次并落库 */
  async loadDetail(id) {
    const item = this.items.find((x) => x.id === id);
    if (!item) return { id, bodyHtml: '', bodyText: '', attachments: [] };
    if (this.detailCache.has(item.url)) return this.detailCache.get(item.url);

    // 本地已有正文（首次抓取时抓过）直接用
    if (item.bodyHtml || item.bodyText) {
      const r = { id, bodyHtml: item.bodyHtml || '', bodyText: item.bodyText || '', attachments: item.attachments || [] };
      this.detailCache.set(item.url, r);
      return r;
    }

    // 受限条目不必再试
    if (item.restricted) {
      const r = { id, bodyHtml: '', bodyText: '', attachments: [], restricted: true };
      this.detailCache.set(item.url, r);
      return r;
    }

    // 现场抓正文并写回本地，下次打开就是离线可读
    const detail = await fetchDetail(item.url, { title: item.title, date: item.publishedAt });
    const patch = detail
      ? {
        ...item,
        title: detail.title || item.title,
        bodyText: detail.bodyText || '',
        bodyHtml: detail.bodyHtml || '',
        attachments: detail.attachments || [],
        restricted: !!detail.restricted,
        summary: detail.restricted
          ? '该通知正文需在校园网内访问，请点击「查看原文」跳转官网查看。'
          : (item.summary || ''),
      }
      : { ...item, restricted: true };

    await db.upsertItems([stripInternal(patch)]);
    Object.assign(item, patch);

    const r = {
      id,
      bodyHtml: patch.bodyHtml || '',
      bodyText: patch.bodyText || '',
      attachments: patch.attachments || [],
      restricted: !!patch.restricted,
    };
    this.detailCache.set(item.url, r);
    return r;
  }

  /** 抓取：界面点「刷新」时调用 */
  async triggerFetch() {
    if (runtime.fetching) throw new Error('正在抓取中');

    // 先跑一次轻量抓取（只抓列表），拿到最新标题与日期
    await this.#scrape({ fetchDetails: false });
    // 抓完后异步补正文，不阻塞界面
    this.#scrape({ fetchDetails: true, detailLimit: 6 }).catch(() => {});
    return { started: true };
  }

  async #scrape({ fetchDetails = false, detailLimit = 0 } = {}) {
    runtime.fetching = true;
    runtime.progress = { phase: 'list', done: 0, total: SOURCES.length, source: '' };
    try {
      const res = await runScrape({
        sources: SOURCES,
        concurrency: 6,
        fetchDetails,
        detailLimit,
        onProgress: (p) => { runtime.progress = p; },
      });
      const at = new Date().toISOString();
      runtime.lastRun = at;
      runtime.lastResult = res;
      await db.setMeta('lastScrapeAt', at);
      await db.setMeta('lastResult', res);
      await db.prune(2000);
      return res;
    } finally {
      runtime.fetching = false;
      runtime.progress = null;
    }
  }

  async fetchStatus() {
    return {
      fetching: runtime.fetching,
      progress: runtime.progress,
      lastRun: runtime.lastRun,
      lastResult: runtime.lastResult,
    };
  }

  /** App 端设置存在本地（无服务端可写） */
  async saveSettings(patch) {
    const cur = local.get('settings', {});
    const next = { ...cur, ...patch };
    local.set('settings', next);
    if (this.index) this.index.settings = { ...this.index.settings, ...next };
    return this.index?.settings || next;
  }

  /** 重新从本地库加载（抓取完成后调用） */
  async reload() {
    const items = await db.allItems();
    this.items = assignIds(items);
    return this.items;
  }
}

/** 去掉内部字段，避免写进库里 */
function stripInternal(item) {
  const { id, _stableId, _isNew, ...rest } = item;
  return rest;
}

export const data = new AppDataSource();
export { stateStore, local };

/**
 * 仅供构建期自测脚本使用：暴露内部抓取函数，便于在真实浏览器里
 * 直接验证「列表解析 → 打标 → 落库」链路，而不必先打包 APK。
 * 界面代码不引用这里。
 */
export const __internal = { runScrape, fetchDetail, db, SOURCES };
