/**
 * 静态导出：把数据库导出为前端可直接加载的 JSON 快照。
 *
 * 为什么需要：Cloudflare Pages / GitHub Pages 只能托管静态文件，跑不了 Node 抓取服务。
 * 因此架构拆成两半——
 *   抓取器（Node）在 GitHub Actions 里定时跑 → 产出静态 JSON → 提交仓库 → CF Pages 托管前端。
 *
 * 体积策略（每份数据只存一次，避免重复占空间）：
 *   items.json       全部条目的清单（标题 + 摘要 + 标签），供列表、筛选、本地搜索
 *   detail/{id}.json 单条正文 HTML 与附件，进入详情页时才按需加载
 *   index.json       栏目统计、信源状态、截止时间、快照版本
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Store } from '../src/store/db.mjs';
import { CATEGORIES, COLLEGES, CATEGORY_MAP } from '../src/sources/registry.mjs';
import { extractDeadlines, daysUntil } from '../src/core/deadline.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 列表摘要长度：卡片上显示两行，同时作为"标题没命中时的次级搜索字段" */
const EXCERPT_CHARS = 300;

export function exportStatic({ outDir = resolve(ROOT, 'public/data'), store, quiet = false } = {}) {
  const db = store || new Store();
  const ownStore = !store;
  const log = (...a) => { if (!quiet) console.log(...a); };

  const detailDir = resolve(outDir, 'detail');
  // 全量重建，避免已删除条目残留在快照里
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(detailDir, { recursive: true });

  const counts = db.counts();
  const all = db.listItems({ limit: 100000 }).items;
  log(`导出 ${all.length} 条…`);

  // ---- 1. 条目清单 ----
  const items = all.map((it) => ({
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
    excerpt: (it.bodyText || '').slice(0, EXCERPT_CHARS).replace(/\s+/g, ' ').trim(),
  }));
  writeJson(resolve(outDir, 'items.json'), items);

  // ---- 2. 单条详情（只在进入详情页时加载） ----
  let detailBytes = 0;
  let detailCount = 0;
  for (const it of all) {
    const detail = {
      id: it.id,
      bodyHtml: compactHtml(it.bodyHtml),
      bodyText: '', // 摘要已在 items.json，不再重复存储；详情页直接用 bodyHtml
      attachments: it.attachments || [],
      image: it.image || null,
    };
    // 正文与附件都为空时不必生成文件，前端会回落到摘要 + 跳原文
    if (!detail.bodyHtml && !detail.attachments.length) continue;
    const json = JSON.stringify(detail);
    writeFileSync(resolve(detailDir, `${it.id}.json`), json, 'utf8');
    detailBytes += Buffer.byteLength(json);
    detailCount++;
  }

  // ---- 3. 截止时间 ----
  const deadlines = [];
  for (const it of all) {
    for (const d of extractDeadlines(`${it.title}\n${(it.bodyText || '').slice(0, 2500)}`)) {
      const left = daysUntil(d.date);
      if (left >= -1 && left <= 45) {
        deadlines.push({
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
  deadlines.sort((a, b) => a.daysLeft - b.daysLeft);

  // ---- 4. 索引（含信源状态与栏目统计） ----
  const byCat = new Map();
  for (const it of all) byCat.set(it.categoryId, (byCat.get(it.categoryId) || 0) + 1);
  const latestPerCat = new Map();
  for (const it of all) {
    if (!it.publishedAt) continue;
    const cur = latestPerCat.get(it.categoryId);
    if (!cur || it.publishedAt > cur) latestPerCat.set(it.categoryId, it.publishedAt);
  }

  const sources = db.sourceStats().map((s) => ({
    id: s.id,
    name: s.name,
    categoryId: s.category_id,
    categoryName: CATEGORY_MAP[s.category_id]?.name || '其他',
    listUrl: s.list_url,
    lastFetch: s.last_fetch,
    lastStatus: s.last_status,
    itemCount: s.item_count,
    errorCount: s.error_count,
  }));

  // 快照版本：条目集合变化时改变，前端据此决定是否刷新本地缓存
  const version = createHash('sha1')
    .update(`${all.length}:${all.map((i) => i.id).join(',')}`)
    .digest('hex').slice(0, 12);

  const index = {
    generatedAt: new Date().toISOString(),
    version,
    total: all.length,
    important: counts.important,
    latestAt: all.map((i) => i.publishedAt).filter(Boolean).sort().pop() || null,
    categories: CATEGORIES.map((c) => ({
      ...c,
      total: byCat.get(c.id) || 0,
      latest: latestPerCat.get(c.id) || null,
    })),
    sources,
    colleges: COLLEGES,
    deadlines,
    // 计算机科学与技术学院默认置顶（学生本人的学院）
    priorityCollege: 'col-cst',
    priorityCollegeName: '计算机科学与技术学院',
    // 后台推送服务地址（部署 Cloudflare Worker 后设置环境变量 BN_PUSH_WORKER，
    // 前端据此判断是否展示「后台推送」开关；未设置则该功能自动隐藏）
    pushWorkerUrl: process.env.BN_PUSH_WORKER || null,
  };
  writeJson(resolve(outDir, 'index.json'), index);

  const size = dirSize(outDir);
  log(`条目 ${items.length} 条，详情文件 ${detailCount} 份，截止线索 ${deadlines.length} 条`);
  log(`快照版本 ${version}，输出 ${outDir.replace(ROOT, '.')}（共 ${(size / 1024).toFixed(0)} KB，详情占 ${(detailBytes / 1024).toFixed(0)} KB）`);

  if (ownStore) db.close();
  return { version, total: all.length, detailCount, bytes: size, index };
}

/**
 * 压缩正文 HTML。
 *
 * 学校通知多从 Word 粘贴，带大量内联样式（实测单条最大 2 MB），
 * 这些样式不仅撑大快照，还会破坏前端排版（固定宽度、绝对定位、行高）。
 * 这里剥掉 style / class / 事件属性，只保留结构与图片链接，由前端 CSS 统一排版。
 */
function compactHtml(html) {
  if (!html) return '';
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s(?:style|class|lang|align|valign|border|cellpadding|cellspacing|width|height|dir|face|size|color|bgcolor|id|name|title|onclick|onload|onerror)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/<(o:p|w:[^>\s]+|st1:[^>\s]+|v:[^>\s]+)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(o:p|w:[^>\s]+|st1:[^>\s]+|v:[^>\s]+)[^>]*>/gi, '')
    // Word 会把每段拆成多个 <span> 包裹（实测单条最多 7000+ 个），语义为零且撑大体积。
    // 去掉后保留 <strong>/<em>/<u> 等真正有意义的行内标记。
    .replace(/<\/?span[^>]*>/gi, '')
    .replace(/(\s)\s+/g, '$1')
    .replace(/>\s+</g, '><')
    .trim();
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data), 'utf8');
}

function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const f of readdirSync(dir)) {
    const p = resolve(dir, f);
    const st = statSync(p);
    total += st.isDirectory() ? dirSize(p) : st.size;
  }
  return total;
}

// 直接运行：node scripts/export-static.mjs
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  exportStatic();
}
