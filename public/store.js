/**
 * 数据层：把「Node API 模式」与「静态 JSON 模式」统一成同一套接口。
 *
 * 为什么要这层：同一份前端要跑在两个完全不同的后端上——
 *   · 本地/服务器：Node 服务提供 /api/*，可写（标记已读、触发抓取）
 *   · Cloudflare Pages：只有静态文件，读取 /data/*.json，不可写
 * 把差异收敛到本文件，UI 代码不必关心部署形态。
 *
 * 状态存储：已读/收藏一律存 localStorage。
 * 原因：静态托管没有后端可写；统一到本地后两种模式行为一致，
 * 也避免「本地标的已读」在静态站点上丢失。
 */

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
  del(key) {
    try { localStorage.removeItem(LS_PREFIX + key); } catch {}
  },
};

/**
 * 已读/收藏集合。
 *
 * 用「条目 URL 的短哈希」而非数据库 id 作为键：
 * 抓取端在数据库重建（如 CI 缓存失效）或换机器时会重新分配条目 id，
 * 若按 id 记录，用户的已读状态会整体错乱——挂到别的通知上。
 * URL 是条目的天然唯一键，跨环境稳定。
 */
const keyOf = (item) => {
  const url = typeof item === 'string' ? item : item?.url;
  if (!url) return '';
  // FNV-1a 32 位哈希，足够区分且比存完整 URL 省空间
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
  /** 上次访问之后新增的条目数（用于「N 条新通知」提示，按 id 增量判断即可） */
  freshCount(items) {
    const base = stateStore.lastVisitMaxId;
    if (!base) return 0;
    return items.filter((i) => i.id > base).length;
  },
};

/** 快照缓存：静态模式下把 items.json 缓存在 localStorage，避免每次打开都下载 */
const cache = {
  key: 'snapshot',
  load(version) {
    const c = local.get(cache.key, null);
    if (c && c.version === version) return c.items;
    return null;
  },
  save(version, items) {
    try {
      local.set(cache.key, { version, items });
      return true;
    } catch {
      // 超出 localStorage 配额：清掉缓存不影响功能，只是下次要重新下载
      local.del(cache.key);
      return false;
    }
  },
};

class DataSource {
  constructor() {
    this.mode = 'unknown'; // 'api' | 'static'
    this.index = null;
    this.items = [];
    this.detailCache = new Map();
  }

  /** 探测运行模式：能拿到 /api/meta 就是 API 模式，否则读静态快照 */
  async init() {
    try {
      const res = await fetch('./api/meta', { headers: { Accept: 'application/json' } });
      if (res.ok && (res.headers.get('content-type') || '').includes('json')) {
        this.mode = 'api';
        this.index = await this.#loadApiIndex();
        return this;
      }
    } catch { /* 落到静态模式 */ }
    this.mode = 'static';
    this.index = await this.#loadStaticIndex();
    return this;
  }

  get isApi() { return this.mode === 'api'; }

  async #loadApiIndex() {
    const [meta, cats, sources, deadlines] = await Promise.all([
      fetch('./api/meta').then((r) => r.json()),
      fetch('./api/categories').then((r) => r.json()),
      fetch('./api/sources').then((r) => r.json()),
      fetch('./api/deadlines?days=45').then((r) => r.json()).catch(() => []),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      version: `api-${meta.counts.maxId}`,
      total: meta.counts.total,
      important: meta.counts.important,
      latestAt: null,
      categories: cats,
      sources,
      colleges: meta.colleges,
      deadlines,
      settings: meta.settings,
      runtime: meta.runtime,
      priorityCollege: 'col-cst',
      priorityCollegeName: '计算机科学与技术学院',
    };
  }

  async #loadStaticIndex() {
    const res = await fetch('./data/index.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('无法加载数据快照（data/index.json）');
    const index = await res.json();
    return { ...index, settings: null, runtime: null };
  }

  /** 加载条目清单（静态模式优先用本地缓存） */
  async loadItems({ force = false } = {}) {
    if (this.mode === 'api') {
      // 优先走单次请求的 /api/all。
      // 原因：远距离链路（如 Cloudflare 隧道）下每次请求往返 16~36 秒，
      // 分 5 页拉取会叠加到 100 秒以上，页面长期停在「正在载入」。
      try {
        const res = await fetch('./api/all', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.items) && data.items.length) {
            this.items = data.items;
            return this.items;
          }
        }
      } catch { /* 回落分页方式 */ }

      const r = await fetch('./api/items?limit=200');
      const data = await r.json();
      // 分页兜底：逐页取全量，以便前端统一做本地筛选
      const all = [...data.items];
      let offset = all.length;
      while (offset < data.total && offset < 5000) {
        const more = await fetch(`./api/items?limit=200&offset=${offset}`).then((x) => x.json());
        if (!more.items.length) break;
        all.push(...more.items);
        offset += more.items.length;
      }
      this.items = all.map((it) => ({
        ...it,
        excerpt: it.excerpt ?? (it.bodyText || '').slice(0, 300).replace(/\s+/g, ' ').trim(),
      }));
      return this.items;
    }

    // 静态模式
    if (!force) {
      const cached = cache.load(this.index.version);
      if (cached) { this.items = cached; return this.items; }
    }
    const res = await fetch('./data/items.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('无法加载条目数据（data/items.json）');
    this.items = await res.json();
    cache.save(this.index.version, this.items);
    return this.items;
  }

  /** 单条正文：静态模式按需拉取 detail/{id}.json */
  async loadDetail(id) {
    if (this.detailCache.has(id)) return this.detailCache.get(id);
    let detail = null;
    if (this.mode === 'api') {
      const res = await fetch(`./api/items/${id}`);
      if (res.ok) detail = await res.json();
    } else {
      const res = await fetch(`./data/detail/${id}.json`, { cache: 'force-cache' });
      detail = res.ok ? await res.json() : null;
    }
    // 快照里没有正文（受限条目等）时返回空壳，由调用方回落到摘要 + 跳原文
    const result = detail || { id, bodyHtml: '', bodyText: '', attachments: [] };
    this.detailCache.set(id, result);
    return result;
  }

  /** 触发抓取（仅 API 模式可用） */
  async triggerFetch(sources = null) {
    if (this.mode !== 'api') throw new Error('静态托管模式无法触发抓取');
    const res = await fetch('./api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '触发抓取失败');
    return res.json();
  }

  async fetchStatus() {
    if (this.mode !== 'api') return { fetching: false, lastRun: this.index?.generatedAt };
    return fetch('./api/status').then((r) => r.json()).catch(() => ({}));
  }

  async saveSettings(patch) {
    if (this.mode !== 'api') throw new Error('静态托管模式无法修改服务端设置');
    const res = await fetch('./api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    this.index.settings = data.settings;
    return data.settings;
  }
}

export const data = new DataSource();
export { stateStore, local, cache };
