/**
 * 翻页调试：打印某信源逐页的条目数、日期区间与判停原因。
 *
 * 起因：网页快照里计算机学院只有 49 条，而 App 端同一栏目能到 116 条——
 * 两边用的都是 collectListPages，必须查出判停在哪儿。
 *
 * 用法: node scripts/debug-paging.mjs <listUrl> [maxPages] [sinceMonths]
 */
import { collectListPages } from '../src/sources/paging.mjs';
import { HttpClient } from '../src/core/http.mjs';

const [listUrl, maxPagesArg, sinceArg] = process.argv.slice(2);
if (!listUrl) {
  console.error('用法: node scripts/debug-paging.mjs <listUrl> [maxPages] [sinceMonths]');
  process.exit(1);
}
const maxPages = Number(maxPagesArg || 12);
const sinceMonths = Number(sinceArg || 6);

const client = new HttpClient({ timeoutMs: 20000, minIntervalMs: 0 });
const cutoff = new Date();
cutoff.setMonth(cutoff.getMonth() - sinceMonths);
console.log(`截止线 ${cutoff.toISOString().slice(0, 10)}（近 ${sinceMonths} 个月），最多 ${maxPages} 页\n`);

const r = await collectListPages(
  async (u) => (await client.fetchHtml(u)).html,
  {
    listUrl, maxPages, sinceMonths,
    onPage: ({ page, url, count, oldest }) => {
      console.log(`第 ${page} 页  ${String(count).padStart(3)} 条  最早 ${oldest || '-'}  ${url}`);
    },
  },
);

const dates = r.items.map((x) => x.date).filter(Boolean).sort();
console.log(`\n共 ${r.items.length} 条，翻 ${r.pages} 页，日期 ${dates[0]} ~ ${dates[dates.length - 1]}`);
if (r.firstError) console.log(`首页错误: ${r.firstError}`);
