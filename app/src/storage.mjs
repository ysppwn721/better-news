/**
 * App 本地存储（IndexedDB）。
 *
 * 为什么不用 localStorage：条目加上正文摘要可到 1~2 MB，
 * localStorage 通常只有 5 MB 且是同步 API，写入会卡住界面。
 * IndexedDB 容量大得多、异步、且支持按索引查询。
 *
 * 为什么不用 @capacitor/preferences：那是键值对存储，
 * 适合存配置，不适合存上千条记录。
 */

const DB_NAME = 'better-news';
const DB_VERSION = 1;
const STORE_ITEMS = 'items';
const STORE_META = 'meta';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ITEMS)) {
        const store = db.createObjectStore(STORE_ITEMS, { keyPath: 'url' });
        // 唯一键用 url：同一条通知在不同次抓取中 URL 不变，天然去重
        store.createIndex('publishedAt', 'publishedAt');
        store.createIndex('categoryId', 'categoryId');
        store.createIndex('sourceId', 'sourceId');
        store.createIndex('firstSeen', 'firstSeen');
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    try {
      result = fn(store);
    } catch (e) {
      reject(e);
      return;
    }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const wrap = (req) => ({ __req: req });

export const db = {
  /**
   * 批量写入条目。仅新增或更新，不删除已有记录。
   * @returns {Promise<{inserted:number, updated:number}>}
   */
  async upsertItems(items) {
    if (!items.length) return { inserted: 0, updated: 0 };
    const database = await openDb();
    return new Promise((resolve, reject) => {
      const t = database.transaction(STORE_ITEMS, 'readwrite');
      const store = t.objectStore(STORE_ITEMS);
      let inserted = 0;
      let updated = 0;

      for (const item of items) {
        const getReq = store.get(item.url);
        getReq.onsuccess = () => {
          const existing = getReq.result;
          if (existing) {
            // 保留首次收录时间与用户的已读状态。
            //
            // ⚠ 正文/摘要必须「非空才覆盖」：抓取分两阶段，列表阶段会把每条
            //   通知以 bodyText:'' 写回一次，若直接展开 item 就会用空串把上一轮
            //   抓到的正文清空——于是每次刷新都丢掉正文，摘要空白、
            //   截止提醒（只出现在正文里）也随之失效。踩过一次，别再踩。
            const merged = {
              ...existing,
              ...item,
              firstSeen: existing.firstSeen || item.firstSeen,
              bodyText: item.bodyText || existing.bodyText || '',
              bodyHtml: item.bodyHtml || existing.bodyHtml || '',
              summary: item.summary || existing.summary || '',
              attachments: (item.attachments && item.attachments.length) ? item.attachments : existing.attachments,
            };
            updated++;
            store.put(merged);
          } else {
            inserted++;
            store.put(item);
          }
        };
        getReq.onerror = () => reject(getReq.error);
      }

      t.oncomplete = () => resolve({ inserted, updated });
      t.onerror = () => reject(t.error);
    });
  },

  /** 批量删除条目（按 url）——用于跨批次去重后清理重复项 */
  async deleteItems(urls) {
    const list = (urls || []).filter(Boolean);
    if (!list.length) return 0;
    const database = await openDb();
    return new Promise((resolve, reject) => {
      const t = database.transaction(STORE_ITEMS, 'readwrite');
      const store = t.objectStore(STORE_ITEMS);
      for (const u of list) store.delete(u);
      t.oncomplete = () => resolve(list.length);
      t.onerror = () => reject(t.error);
    });
  },

  /** 读取全部条目（按发布时间倒序） */
  async allItems() {
    const rows = await tx(STORE_ITEMS, 'readonly', (s) => wrap(s.getAll()));
    rows.sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
    return rows;
  },

  async getItem(url) {
    return tx(STORE_ITEMS, 'readonly', (s) => wrap(s.get(url)));
  },

  async count() {
    return tx(STORE_ITEMS, 'readonly', (s) => wrap(s.count()));
  },

  async clear() {
    await tx(STORE_ITEMS, 'readwrite', (s) => s.clear());
    await tx(STORE_META, 'readwrite', (s) => s.clear());
  },

  /**
   * 清理旧条目：只保留最近 N 条，避免长期使用无限增长。
   *
   * 为什么上限从 2000 提到 6000：翻页改为按时间截止后，一轮就能有 2000+
   * 条（六个年级、二十多个学院的通知），旧上限会把两三个月前的通知直接删掉，
   * 学生搜「选课」就又搜不到了。6000 条约 6MB，对手机存储无压力。
   */
  async prune(maxItems = 6000) {
    const rows = await tx(STORE_ITEMS, 'readonly', (s) => wrap(s.getAll()));
    if (rows.length <= maxItems) return 0;
    rows.sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
    const drop = rows.slice(maxItems);
    await new Promise((resolve, reject) => {
      const database = dbPromise;
      database.then((d) => {
        const t = d.transaction(STORE_ITEMS, 'readwrite');
        const store = t.objectStore(STORE_ITEMS);
        for (const it of drop) store.delete(it.url);
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    });
    return drop.length;
  },

  async getMeta(key, fallback = null) {
    const row = await tx(STORE_META, 'readonly', (s) => wrap(s.get(key)));
    return row ? row.value : fallback;
  },

  async setMeta(key, value) {
    return tx(STORE_META, 'readwrite', (s) => s.put({ key, value }));
  },
};
