#!/usr/bin/env node
/**
 * 一次性导出全量条目（含正文摘要）为单个 JSON 文件。
 *
 * 为什么需要：前端在 API 模式下原本逐页拉取（802 条 = 5 次请求）。
 * 本机访问时每次仅 0.3 秒无所谓，但经 Cloudflare 隧道时每次往返要 16~36 秒，
 * 5 次叠加超过 100 秒，页面长时间停在「正在载入」。
 *
 * 改为单个文件后只需 1 次往返，隧道场景下也只需数秒。
 * 这也是静态托管模式（GitHub Pages）一直用的方式。
 *
 * 用法：
 *   node scripts/export-single.mjs                    # 用默认数据库，输出 public/data/all.json
 *   node scripts/export-single.mjs --out D:\x.json
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store/db.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = (process.argv.find((a) => a.startsWith('--out=')) || '').replace('--out=', '');
const out = outArg || resolve(ROOT, 'public/data/all.json');

const store = new Store(process.env.BN_DB);
const { items, total } = store.listItems({ limit: 100000 });

const payload = items.map((it) => ({
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
}));

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ total, generatedAt: new Date().toISOString(), items: payload }), 'utf8');

const kb = (JSON.stringify(payload).length / 1024).toFixed(0);
console.log(`已导出 ${total} 条 → ${out.replace(ROOT, '.')}（${kb} KB）`);
store.close();
