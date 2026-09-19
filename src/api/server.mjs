/**
 * HTTP 服务：REST API + 静态界面 + 定时抓取 + 提醒推送。
 *
 * 两种运行形态：
 *  1) 本地/服务器常驻（本文件）：直接读写 SQLite、定时抓取、提供 /api/* 接口；
 *  2) 静态托管（Cloudflare Pages）：由 scripts/export-static.mjs 导出 JSON 快照，
 *     前端自动切换到静态数据源，本服务不参与。前端两种模式共用同一份代码。
 */
import express from 'express';
import cron from 'node-cron';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Store } from '../store/db.mjs';
import { Fetcher } from '../core/fetcher.mjs';
import { analyze } from '../core/keywords.mjs';
import { log } from '../core/log.mjs';
import { CATEGORIES, CATEGORY_MAP, COLLEGES } from '../sources/registry.mjs';
import { buildSources, registerAll } from '../core/sources.mjs';
import { extractDeadlines, daysUntil } from '../core/deadline.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SETTINGS_FILE = resolve(ROOT, 'config/settings.json');

const DEFAULT_SETTINGS = {
  cron: process.env.BN_CRON || '*/30 * * * *', // 默认每 30 分钟
  autoFetch: true,
  fetchColleges: false,
  pages: 2,
  enrich: 25,
  concurrency: 4,
  notifyCategories: CATEGORIES.map((c) => c.id), // 参与提醒的栏目
  notifyImportantOnly: false,
  remindBeforeDays: 1, // 「即将截止」提前提醒天数
};

function loadSettings() {
  if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s) {
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
}

export async function startServer({ store, port = 5178, host = '127.0.0.1' } = {}) {
  const db = store || new Store();
  const settings = loadSettings();
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  /** 运行状态（内存态，供前端显示进度） */
  const runtime = {
    fetching: false,
    lastRun: db.getMeta('lastFetchAt'),
    lastResult: null,
    progress: null,
    startedAt: new Date().toISOString(),
  };

  const publicDir = resolve(ROOT, 'public');
  app.use(express.static(publicDir, { extensions: ['html'] }));

  // ---------- 元信息 ----------
  app.get('/api/meta', (req, res) => {
    const counts = db.counts();
    const sinceId = Number(db.getMeta('uiLastSeenId', '0'));
    res.json({
      categories: CATEGORIES,
      counts,
      freshCount: db.newSince(sinceId).length,
      settings,
      runtime: { ...runtime },
      colleges: COLLEGES,
      version: '0.1.0',
    });
  });

  // ---------- 栏目统计 ----------
  app.get('/api/categories', (req, res) => {
    const sinceId = Number(db.getMeta('uiLastSeenId', '0'));
    const stats = db.categoryStats(sinceId);
    const map = new Map(stats.map((s) => [s.categoryId, s]));
    res.json(CATEGORIES.map((c) => ({
      ...c,
      total: map.get(c.id)?.total || 0,
      unread: map.get(c.id)?.unread || 0,
      fresh: map.get(c.id)?.fresh || 0,
      latest: map.get(c.id)?.latest || null,
    })));
  });

  // ---------- 条目列表 ----------
  app.get('/api/items', (req, res) => {
    const {
      category, source, q, tag, starred, unread, days, important,
      limit, offset, sinceId, brief, sort,
    } = req.query;
    const result = db.listItems({
      category, source, q, tag, sort,
      starred: starred === '1' || starred === 'true',
      unread: unread === '1' || unread === 'true',
      important: important === '1' || important === 'true',
      days: days ? Number(days) : undefined,
      sinceId: sinceId ? Number(sinceId) : undefined,
      limit: Math.min(Number(limit) || 30, 200),
      offset: Number(offset) || 0,
    });
    if (brief === '1') {
      result.items = result.items.map(({ bodyHtml, bodyText, ...rest }) => ({
        ...rest,
        excerpt: (bodyText || '').slice(0, 200),
      }));
    }
    res.json(result);
  });

  // ---------- 全量条目（单次请求） ----------
  /**
   * 前端一次性拉取全部条目。
   *
   * 为什么不复用 /api/items 分页：经 Cloudflare 隧道等远距离链路时，
   * 每次请求往返 16~36 秒，分 5 页就等于 100 秒以上，页面会长时间空白。
   * 合并成一次请求后只剩一次往返。
   */
  app.get('/api/all', (req, res) => {
    const { items, total } = db.listItems({ limit: 100000 });
    res.set('Cache-Control', 'no-store');
    res.json({
      total,
      generatedAt: new Date().toISOString(),
      items: items.map((it) => ({
        id: it.id,
        url: it.url,
        title: it.title,
        publishedAt: it.publishedAt,
        sourceId: it.sourceId,
        sourceName: it.sourceName,
        categoryId: it.categoryId,
        categoryName: it.categoryName,
        subcategory: it.subcategory,
        tags: it.tags,
        important: it.important,
        restricted: it.restricted,
        excerpt: (it.bodyText || '').slice(0, 300).replace(/\s+/g, ' ').trim(),
        // 正文片段供本地搜索：只搜标题+摘要会漏掉用户的常用说法
        searchText: (it.bodyText || '').slice(0, 2000).replace(/\s+/g, ' ').trim(),
      })),
    });
  });

  // ---------- 单条详情 ----------
  app.get('/api/items/:id', (req, res) => {
    const item = db.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: '条目不存在' });
    res.json(item);
  });

  // ---------- 已读 / 收藏 ----------
  app.patch('/api/items/:id', (req, res) => {
    const { isRead, starred } = req.body || {};
    const ok = db.setFlags(req.params.id, { isRead, starred });
    res.json({ ok, item: db.getItem(req.params.id) });
  });

  app.post('/api/items/read-all', (req, res) => {
    const n = db.markAllRead(req.body || {});
    // 已全读 → 把提醒基线推到当前最大 id
    db.setMeta('uiLastSeenId', db.counts().maxId);
    res.json({ ok: true, changed: n });
  });

  // ---------- 信源 ----------
  app.get('/api/sources', (req, res) => {
    res.json(db.sourceStats().map((r) => ({
      id: r.id,
      name: r.name,
      categoryId: r.category_id,
      categoryName: CATEGORY_MAP[r.category_id]?.name || '其他',
      listUrl: r.list_url,
      enabled: !!r.enabled,
      lastFetch: r.last_fetch,
      lastStatus: r.last_status,
      itemCount: r.item_count,
      unread: r.unread,
      errorCount: r.error_count,
    })));
  });

  // ---------- 抓取 ----------
  async function runFetch({ sources = null, reason = 'manual' } = {}) {
    if (runtime.fetching) return { ok: false, error: '已有抓取任务在运行中' };
    runtime.fetching = true;
    runtime.progress = { done: 0, total: 0, source: '' };
    try {
      const all = buildSources();
      registerAll(db, all);
      let targets = all;
      if (sources?.length) {
        const set = new Set(sources);
        targets = all.filter((s) => set.has(s.id) || set.has(s.categoryId));
      } else {
        // 默认不含学院（量大），除非设置里开启
        targets = settings.fetchColleges ? all : all.filter((s) => s.categoryId !== 'college');
      }
      log.info(`[抓取:${reason}] ${targets.length} 个信源`);
      const fetcher = new Fetcher(db, {
        concurrency: settings.concurrency,
        enrichLimit: settings.enrich,
        onProgress: (p) => {
          runtime.progress = { done: p.done, total: p.total, source: p.source, title: p.title };
        },
      });
      const result = await fetcher.fetchAll(targets, { pages: settings.pages });
      runtime.lastRun = new Date().toISOString();
      runtime.lastResult = {
        inserted: result.inserted,
        elapsed: result.elapsed,
        sources: result.results.length,
        reason,
      };
      db.setMeta('lastFetchAt', runtime.lastRun);
      return { ok: true, ...runtime.lastResult };
    } catch (e) {
      log.error('抓取失败:', e.message);
      return { ok: false, error: e.message };
    } finally {
      runtime.fetching = false;
      runtime.progress = null;
    }
  }

  app.post('/api/fetch', async (req, res) => {
    const { sources } = req.body || {};
    if (runtime.fetching) return res.status(409).json({ ok: false, error: '已有抓取任务在运行中' });
    // 异步执行，立即返回，前端轮询 /api/status 看进度
    runFetch({ sources, reason: 'manual' });
    res.json({ ok: true, started: true });
  });

  app.get('/api/status', (req, res) => res.json({ ...runtime }));

  // ---------- 设置 ----------
  app.get('/api/settings', (req, res) => res.json(settings));

  app.put('/api/settings', (req, res) => {
    const body = { ...(req.body || {}) };
    // reloadCron 只是本次请求的控制参数，不落库
    const reloadCron = body.reloadCron !== false;
    delete body.reloadCron;
    Object.assign(settings, body);
    saveSettings(settings);
    if (reloadCron) scheduleCron();
    res.json({ ok: true, settings });
  });

  // ---------- 提醒相关 ----------
  /** 新消息轮询：返回 id > since 的条目（前端做浏览器通知） */
  app.get('/api/notifications', (req, res) => {
    const since = Number(req.query.since || 0);
    const cats = settings.notifyCategories?.length ? settings.notifyCategories : null;
    let items = db.newSince(since, cats);
    if (settings.notifyImportantOnly) items = items.filter((i) => i.important);
    res.json({
      maxId: db.counts().maxId,
      items: items.map((i) => ({
        id: i.id,
        title: i.title,
        url: i.url,
        categoryId: i.categoryId,
        categoryName: i.categoryName,
        sourceName: i.sourceName,
        publishedAt: i.publishedAt,
        important: i.important,
        tags: i.tags,
      })),
    });
  });

  /** 标记「已推送通知」，避免重复弹窗 */
  app.post('/api/notifications/ack', (req, res) => {
    const id = Number(req.body?.id || 0);
    if (id > 0) db.setMeta('notifiedId', id);
    res.json({ ok: true });
  });

  /** 截止时间：从正文里找「截止/截至 …」并转成日期，用于「即将截止」提醒 */
  app.get('/api/deadlines', (req, res) => {
    const horizon = Number(req.query.days ?? settings.remindBeforeDays + 14);
    const { items } = db.listItems({ limit: 500 });
    const out = [];
    for (const it of items) {
      const text = `${it.title}\n${(it.bodyText || '').slice(0, 2500)}`;
      for (const d of extractDeadlines(text)) {
        const diff = daysUntil(d.date);
        if (diff >= -1 && diff <= horizon) {
          out.push({
            itemId: it.id,
            title: it.title,
            url: it.url,
            date: d.date,
            hint: d.hint,
            daysLeft: diff,
            categoryName: it.categoryName,
            sourceName: it.sourceName,
            isRead: it.isRead,
          });
        }
      }
    }
    out.sort((a, b) => a.daysLeft - b.daysLeft);
    res.json(out.slice(0, 80));
  });

  // ---------- 维护 ----------
  app.post('/api/retag', (req, res) => {
    const result = db.retagAll(analyze);
    res.json({ ok: true, ...result });
  });

  // ---------- 定时任务 ----------
  let task = null;
  function scheduleCron() {
    if (task) { task.stop(); task = null; }
    if (!settings.autoFetch || !settings.cron) return;
    if (!cron.validate(settings.cron)) {
      log.warn(`cron 表达式无效: ${settings.cron}`);
      return;
    }
    task = cron.schedule(settings.cron, () => {
      log.info('触发定时抓取');
      runFetch({ reason: 'cron' });
    });
    log.info(`定时抓取已启用: ${settings.cron}`);
  }

  scheduleCron();

  // 启动后若库是空的，自动抓一次，保证打开就有内容
  if (db.counts().total === 0) {
    setTimeout(() => runFetch({ reason: 'startup' }), 800);
  }

  const server = app.listen(port, host, () => {
    log.info(`服务已启动: http://${host}:${port}`);
  });

  // 优雅退出
  const shutdown = () => {
    task?.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 返回一个永不 resolve 的 promise：调用方 await 即代表「服务常驻」
  return { app, server, db, runFetch, settings, lifetime: new Promise(() => {}) };
}

// 直接以 --standalone 运行本文件时可独立启动（正常入口是 bin/bn.mjs serve）
if (process.argv.includes('--standalone') && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  startServer({ port: Number(process.env.PORT || 5178) });
}
