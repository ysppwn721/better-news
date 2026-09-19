/**
 * 存储层：Node 24 内置 node:sqlite（零原生依赖，无需编译）。
 *
 * 表设计：
 *   items   公告条目（唯一键 = url，天然去重）
 *   sources 信源
 *   meta    抓取状态与 UI 状态（lastSeenId 用于「新消息」角标 / 提醒基线）
 *   read_state 已读/收藏（单用户本地应用，直接存库更省事）
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  url          TEXT    NOT NULL UNIQUE,
  title        TEXT    NOT NULL,
  summary      TEXT    DEFAULT '',
  body_text    TEXT    DEFAULT '',
  body_html    TEXT    DEFAULT '',
  attachments  TEXT    DEFAULT '[]',
  image        TEXT,
  published_at TEXT,
  source_id    TEXT    NOT NULL,
  source_name  TEXT    DEFAULT '',
  category_id  TEXT    NOT NULL,
  category_name TEXT   DEFAULT '',
  subcategory  TEXT    DEFAULT '',
  tags         TEXT    DEFAULT '[]',
  important    INTEGER DEFAULT 0,
  restricted   INTEGER DEFAULT 0,
  first_seen   TEXT    NOT NULL,
  updated_at   TEXT,
  is_read      INTEGER DEFAULT 0,
  starred      INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_pub   ON items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_cat   ON items(category_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_src   ON items(source_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_seen  ON items(id DESC);

CREATE TABLE IF NOT EXISTS sources (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category_id TEXT NOT NULL,
  list_url    TEXT,
  enabled     INTEGER DEFAULT 1,
  last_fetch  TEXT,
  last_status TEXT,
  last_count  INTEGER DEFAULT 0,
  total_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  builtin     INTEGER DEFAULT 1,
  sort        INTEGER DEFAULT 100
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

export class Store {
  constructor(dbPath) {
    const file = dbPath || process.env.BN_DB || resolve(ROOT, 'data/better-news.db');
    mkdirSync(dirname(file), { recursive: true });
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.#migrate();
    this.#prepare();
  }

  /** 轻量迁移：老库补列（SQLite 不支持 ADD COLUMN IF NOT EXISTS，需先查表结构） */
  #migrate() {
    const cols = new Set(this.db.prepare('PRAGMA table_info(items)').all().map((c) => c.name));
    if (!cols.has('restricted')) {
      this.db.exec('ALTER TABLE items ADD COLUMN restricted INTEGER DEFAULT 0');
    }
  }

  #prepare() {
    this.q = {
      insertItem: this.db.prepare(`
        INSERT INTO items (url, title, summary, body_text, body_html, attachments, image,
                           published_at, source_id, source_name, category_id, category_name,
                           subcategory, tags, important, restricted, first_seen)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(url) DO NOTHING
      `),
      updateItem: this.db.prepare(`
        UPDATE items SET title=?, summary=?, body_text=?, body_html=?, attachments=?, image=?,
                         published_at=?, tags=?, important=?, subcategory=?, restricted=?, updated_at=?
        WHERE url=?
      `),
      findByUrl: this.db.prepare('SELECT * FROM items WHERE url = ?'),
      upsertSource: this.db.prepare(`
        INSERT INTO sources (id, name, category_id, list_url, builtin, sort)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, category_id=excluded.category_id,
          list_url=excluded.list_url, sort=excluded.sort
      `),
      markFetch: this.db.prepare(`
        UPDATE sources SET last_fetch=?, last_status=?, last_count=?,
               total_count=total_count+?, error_count=error_count+?
        WHERE id=?
      `),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this.db.prepare(`
        INSERT INTO meta (key, value) VALUES (?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `),
    };
  }

  getMeta(key, fallback = null) {
    const row = this.q.getMeta.get(key);
    return row ? row.value : fallback;
  }

  setMeta(key, value) {
    this.q.setMeta.run(key, String(value));
  }

  registerSource(src) {
    this.q.upsertSource.run(
      src.id, src.name, src.categoryId || src.category_id || 'other',
      src.listUrl || src.list_url || '', src.builtin ? 1 : 0, src.sort ?? 100,
    );
  }

  markSourceFetch(id, { status, count = 0, error = 0 }) {
    this.q.markFetch.run(new Date().toISOString(), status, count, count, error, id);
  }

  findItemByUrl(url) {
    return this.q.findByUrl.get(url);
  }

  /**
   * 写入条目；已存在则按需更新（标题/正文变化 → updated_at）
   * @returns {{inserted: boolean, updated: boolean, id: number|null}}
   */
  saveItem(item) {
    const existing = this.q.findByUrl.get(item.url);
    if (!existing) {
      const info = this.q.insertItem.run(
        item.url, item.title, item.summary || '', item.bodyText || '', item.bodyHtml || '',
        JSON.stringify(item.attachments || []), item.image || null,
        item.publishedAt || null, item.sourceId, item.sourceName || '',
        item.categoryId, item.categoryName || '', item.subcategory || '',
        JSON.stringify(item.tags || []), item.important ? 1 : 0,
        item.restricted ? 1 : 0, new Date().toISOString(),
      );
      return { inserted: true, updated: false, id: Number(info.lastInsertRowid) };
    }
    // 已知受限条目再次抓到（仍受限）→ 不覆盖已有数据
    if (item.restricted && existing.restricted) {
      return { inserted: false, updated: false, id: existing.id };
    }
    const changed =
      (item.bodyText && item.bodyText.length > (existing.body_text || '').length + 20) ||
      (item.title && item.title !== existing.title && existing.body_text === '');
    if (changed) {
      this.q.updateItem.run(
        item.title, item.summary || existing.summary, item.bodyText || existing.body_text,
        item.bodyHtml || existing.body_html, JSON.stringify(item.attachments || []),
        item.image || existing.image, item.publishedAt || existing.published_at,
        JSON.stringify(item.tags || JSON.parse(existing.tags || '[]')),
        item.important ? 1 : existing.important, item.subcategory || existing.subcategory,
        item.restricted ? 1 : existing.restricted,
        new Date().toISOString(), item.url,
      );
      return { inserted: false, updated: true, id: existing.id };
    }
    return { inserted: false, updated: false, id: existing.id };
  }

  /** 分页查询条目 */
  listItems(opts = {}) {
    const {
      category, source, q, tag, starred, unread, days, important,
      limit = 30, offset = 0, sinceId, sort = 'date',
    } = opts;
    const where = [];
    const args = [];
    if (category && category !== 'all') { where.push('category_id = ?'); args.push(category); }
    if (source) { where.push('source_id = ?'); args.push(source); }
    if (starred) where.push('starred = 1');
    if (unread) where.push('is_read = 0');
    if (important) where.push('important = 1');
    if (tag) { where.push('tags LIKE ?'); args.push(`%"${tag}"%`); }
    if (days) {
      where.push("COALESCE(published_at, substr(first_seen,1,10)) >= date('now', ?)");
      args.push(`-${Number(days)} days`);
    }
    if (sinceId) { where.push('id > ?'); args.push(Number(sinceId)); }
    if (q) {
      where.push('(title LIKE ? OR summary LIKE ? OR body_text LIKE ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // sinceId 用于「拉取某一时间点之后的新条目」，必须升序；其余按用户选择排序
    const order = sinceId
      ? 'ORDER BY id ASC'
      : (sort === 'firstSeen'
        ? 'ORDER BY first_seen DESC, id DESC'
        : 'ORDER BY COALESCE(published_at, substr(first_seen,1,10)) DESC, id DESC');

    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM items ${clause}`).get(...args).n;
    const rows = this.db.prepare(
      `SELECT * FROM items ${clause} ${order} LIMIT ? OFFSET ?`,
    ).all(...args, Number(limit), Number(offset));

    return { total, items: rows.map(rowToItem) };
  }

  getItem(id) {
    const row = this.db.prepare('SELECT * FROM items WHERE id = ?').get(Number(id));
    return row ? rowToItem(row) : null;
  }

  setFlags(id, { isRead, starred }) {
    const sets = [];
    const args = [];
    if (isRead !== undefined) { sets.push('is_read = ?'); args.push(isRead ? 1 : 0); }
    if (starred !== undefined) { sets.push('starred = ?'); args.push(starred ? 1 : 0); }
    if (!sets.length) return false;
    args.push(Number(id));
    this.db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return true;
  }

  markAllRead(filter = {}) {
    const where = [];
    const args = [];
    if (filter.category && filter.category !== 'all') { where.push('category_id = ?'); args.push(filter.category); }
    if (filter.source) { where.push('source_id = ?'); args.push(filter.source); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const info = this.db.prepare(`UPDATE items SET is_read = 1 ${clause}`).run(...args);
    return Number(info.changes || 0);
  }

  /** 各栏目统计（含未读数） */
  categoryStats(sinceId = 0) {
    return this.db.prepare(`
      SELECT category_id AS categoryId,
             COUNT(*) AS total,
             SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread,
             SUM(CASE WHEN id > ? THEN 1 ELSE 0 END) AS fresh,
             MAX(COALESCE(published_at, substr(first_seen,1,10))) AS latest
      FROM items GROUP BY category_id
    `).all(Number(sinceId));
  }

  sourceStats() {
    return this.db.prepare(`
      SELECT s.*,
             (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id) AS item_count,
             (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id AND i.is_read = 0) AS unread
      FROM sources s ORDER BY s.sort, s.id
    `).all();
  }

  /** 新条目（id 大于基线），用于提醒 */
  newSince(sinceId, categories = null) {
    const args = [Number(sinceId)];
    let clause = 'WHERE id > ?';
    if (categories?.length) {
      clause += ` AND category_id IN (${categories.map(() => '?').join(',')})`;
      args.push(...categories);
    }
    const rows = this.db.prepare(
      `SELECT * FROM items ${clause} ORDER BY id ASC LIMIT 100`,
    ).all(...args);
    return rows.map(rowToItem);
  }

  counts() {
    const r = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread,
             SUM(CASE WHEN starred = 1 THEN 1 ELSE 0 END) AS starred,
             SUM(CASE WHEN important = 1 THEN 1 ELSE 0 END) AS important,
             MAX(id) AS maxId
      FROM items
    `).get();
    return {
      total: r.total || 0, unread: r.unread || 0, starred: r.starred || 0,
      important: r.important || 0, maxId: r.maxId || 0,
    };
  }

  deleteItemsBySource(sourceId) {
    const info = this.db.prepare('DELETE FROM items WHERE source_id = ?').run(sourceId);
    return Number(info.changes || 0);
  }

  /** 受限条目数量（需校园网访问） */
  restrictedCount() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM items WHERE restricted = 1').get().n;
  }

  /** 按 URL 直接改标题与摘要（用于修复被错误页标题污染的条目） */
  fixTitleByUrl(url, title, summary) {
    const info = this.db.prepare('UPDATE items SET title = ?, summary = ? WHERE url = ?')
      .run(title, summary || '', url);
    return Number(info.changes || 0);
  }

  /** 标记条目为受限（正文需校园网） */
  markRestricted(url, summary) {
    const info = this.db.prepare('UPDATE items SET restricted = 1, summary = ? WHERE url = ?')
      .run(summary || '该通知正文需在校园网内访问，请点击「查看原文」跳转官网查看。', url);
    return Number(info.changes || 0);
  }

  /**
   * 依据当前关键词规则重算全部条目的标签/重要性。
   * 规则迭代后无需重新爬取，直接本地重算即可校正历史数据。
   * @param {(title: string, body: string) => {tags: string[], audiences: string[], important: boolean}} analyze
   */
  retagAll(analyze, { dryRun = false, limit = 0 } = {}) {
    const rows = this.db.prepare(
      `SELECT id, title, body_text, tags, important FROM items ${limit ? `LIMIT ${Number(limit)}` : ''}`,
    ).all();
    const update = this.db.prepare('UPDATE items SET tags = ?, important = ? WHERE id = ?');
    let changed = 0;
    const samples = [];
    for (const r of rows) {
      const { tags, audiences, important } = analyze(r.title, r.body_text || '');
      const next = [...new Set([...tags, ...audiences])];
      const nextJson = JSON.stringify(next);
      const prevJson = r.tags || '[]';
      if (nextJson !== prevJson || (important ? 1 : 0) !== r.important) {
        changed++;
        if (samples.length < 15) {
          samples.push({
            title: r.title,
            before: JSON.parse(prevJson),
            after: next,
          });
        }
        if (!dryRun) update.run(nextJson, important ? 1 : 0, r.id);
      }
    }
    return { total: rows.length, changed, samples };
  }

  close() { this.db.close(); }
}

function rowToItem(row) {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    summary: row.summary,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    attachments: safeJson(row.attachments, []),
    image: row.image,
    publishedAt: row.published_at,
    sourceId: row.source_id,
    sourceName: row.source_name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    subcategory: row.subcategory,
    tags: safeJson(row.tags, []),
    important: !!row.important,
    restricted: !!row.restricted,
    firstSeen: row.first_seen,
    updatedAt: row.updated_at,
    isRead: !!row.is_read,
    starred: !!row.starred,
  };
}

function safeJson(s, fallback) {
  try { return JSON.parse(s || ''); } catch { return fallback; }
}
