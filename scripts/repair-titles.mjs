/**
 * 修复被错误页标题污染的条目。
 *
 * 背景：部分学院栏目对校外网限制访问，直接请求 article.jsp 会返回「系统提示」页，
 * 早期版本把该页标题当成了条目标题（标题=系统提示、正文为空）。
 * 本脚本回到各信源的列表页，用 URL 重新匹配真实标题与日期，并标记为「受限」。
 */
import { Store } from '../src/store/db.mjs';
import { HttpClient } from '../src/core/http.mjs';
import { parseList, parseDetail, isRestrictedPage } from '../src/sources/cms.mjs';
import { buildSources } from '../src/core/sources.mjs';

const dry = process.argv.includes('--dry');
const store = new Store();
const client = new HttpClient({ timeoutMs: 15000 });

// 1) 找出可疑条目：标题异常或正文为空且 URL 是文章页
const suspects = store.db.prepare(`
  SELECT id, url, title, source_id, source_name, published_at
  FROM items
  WHERE title IN ('系统提示','提示信息','错误')
     OR (length(COALESCE(body_text,'')) = 0 AND summary = '')
`).all();
console.log(`发现 ${suspects.length} 条可疑条目\n`);
if (!suspects.length) { store.close(); process.exit(0); }

// 2) 按信源分组，逐个列表页拉取标题映射
const sources = buildSources();
const bySource = new Map();
for (const s of suspects) {
  if (!bySource.has(s.source_id)) bySource.set(s.source_id, []);
  bySource.get(s.source_id).push(s);
}

let fixed = 0, restricted = 0, unresolved = 0;
for (const [sourceId, rows] of bySource) {
  const src = sources.find((x) => x.id === sourceId);
  if (!src?.listUrl) { unresolved += rows.length; continue; }
  let items = [];
  try {
    const pageCount = Math.min(src.maxPages ?? 1, 4);
    for (let p = 1; p <= pageCount; p++) {
      const url = p === 1 ? src.listUrl
        : (src.pageTemplate ? src.pageTemplate.replace('{page}', p) : src.listUrl);
      const { html } = await client.fetchHtml(url);
      const parsed = parseList(html, url);
      if (!parsed.length) break;
      items.push(...parsed);
    }
  } catch (e) {
    console.log(`  ✗ ${src.name} 列表页抓取失败: ${e.message}`);
    unresolved += rows.length;
    continue;
  }
  const map = new Map(items.map((i) => [i.url, i]));

  for (const r of rows) {
    const found = map.get(r.url);
    if (!found) {
      // 列表页已翻不到（旧文章）→ 至少标记为受限，避免展示错误标题
      if (!dry && /系统提示|提示信息|错误/.test(r.title)) {
        store.fixTitleByUrl(r.url, `（历史通知，标题不可得）${r.published_at || ''}`, '该条目为早期抓取的历史通知，正文需在校园网内访问。');
      }
      unresolved++;
      continue;
    }
    // 确认详情是否受限
    let isRestricted = false;
    try {
      const { html } = await client.fetchHtml(r.url);
      isRestricted = isRestrictedPage(html);
    } catch { isRestricted = true; }

    const summary = isRestricted
      ? '该通知正文需在校园网内访问，请点击「查看原文」跳转官网查看。'
      : '';
    if (!dry) {
      store.fixTitleByUrl(r.url, found.title, summary);
      if (isRestricted) store.markRestricted(r.url, summary);
    }
    fixed++;
    if (isRestricted) restricted++;
    console.log(`  ${isRestricted ? '受限' : '正常'}  ${found.title.slice(0, 44)}`);
  }
}

console.log(`\n${dry ? '[试运行] ' : ''}修复 ${fixed} 条（其中受限 ${restricted} 条），未解析 ${unresolved} 条`);
console.log(`库内受限条目合计: ${store.restrictedCount()}`);
store.close();
