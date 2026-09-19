/**
 * 列出某个学院站点的全部栏目及评分，用于人工核对「有没有漏掉该学院的栏目」。
 *
 * 背景：用户反馈「我们学院的信息不只是官网上的信息，我们自己学院的网页上也是有的」。
 * 自动发现只挑前 8 个栏目，可能会漏掉「研究生教育」「学生工作」这类
 * 学生真正关心的栏目。此脚本把候选全列出来，便于人工判断要不要补进配置。
 *
 * 用法: node scripts/probe-college-columns.mjs [学院id=cst] [--take 8]
 */
import { HttpClient } from '../src/core/http.mjs';
import { discoverColumns, pickColumns, columnKey, monthsSince } from '../src/sources/discover.mjs';
import { COLLEGES } from '../src/sources/registry.mjs';
import { loadDiscovered } from '../src/core/sources.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const takeIdx = process.argv.indexOf('--take');
const TAKE = takeIdx > -1 ? Number(process.argv[takeIdx + 1]) : 8;
// 站点也可以从环境变量给（PowerShell 里传 `--url=http://…` 会被拆坏参数）
const urlIdx = process.argv.findIndex((a) => a.startsWith('--url'));
const urlArg = urlIdx > -1
  ? (process.argv[urlIdx].includes('=') ? process.argv[urlIdx].split('=').slice(1).join('=') : process.argv[urlIdx + 1])
  : process.env.BN_SITE;

let college;
if (urlArg) {
  // 也支持直接探测任意站点（如教务部 jwc、学生工作部 xsgzb）
  const host = new URL(urlArg).host;
  college = { id: host, name: host, host, url: urlArg };
} else {
  const id = args[0] || 'cst';
  college = COLLEGES.find((c) => c.id === id);
  if (!college) {
    console.error(`未找到学院: ${id}`);
    console.error(`可用: ${COLLEGES.map((c) => c.id).join(', ')}`);
    console.error('或用 --url <站点> / 环境变量 BN_SITE 探测任意站点');
    process.exit(1);
  }
}

const client = new HttpClient({ timeoutMs: 20000, minIntervalMs: 0 });
const site = college.url || `http://${college.host}/`;
console.log(`${college.name}  ${site}\n`);

const cols = await discoverColumns(client, site, { minItems: 2 });
cols.sort((a, b) => (b.contentScore || 0) - (a.contentScore || 0));

// 已配置进信源的栏目 URL（用于标出「已在抓取」）
const configured = new Set(
  Object.values(loadDiscovered())
    .flatMap((v) => (v.columns || []).map((c) => columnKey(c.name, c.url))),
);

console.log('内容分  名称评分  条目  最新        栏目标题');
for (const c of cols) {
  const inUse = configured.has(columnKey(c.name, c.url)) ? '✓' : ' ';
  console.log(
    `${inUse} ${String(Math.round((c.contentScore || 0) * 100)).padStart(5)}%`
    + `  ${String(Math.round((c.score || 0) * 100)).padStart(5)}%`
    + `  ${String(c.itemCount).padStart(4)}`
    + `  ${String(c.latest || '?').padEnd(11)}`
    + ` ${c.name}   ${c.url}`,
  );
}

const chosen = pickColumns(cols, TAKE);
const chosenKeys = new Set(chosen.map((c) => columnKey(c.name, c.url)));
console.log(`\n自动挑选（前 ${TAKE} 个，✓=当前配置里已在抓）：`);
for (const c of chosen) {
  console.log(`  ${configured.has(columnKey(c.name, c.url)) ? '✓' : '·'} ${c.name}  (内容分 ${Math.round((c.contentScore || 0) * 100)}%, 最新 ${c.latest || '?'} ${monthsSince(c.latest) ?? '?'} 个月前)`);
}
const missed = cols.filter((c) => !chosenKeys.has(columnKey(c.name, c.url))
  && (c.contentScore || 0) >= 0.6 && (monthsSince(c.latest) ?? 99) <= 12);
if (missed.length) {
  console.log('\n⚠ 被认为有价值但没被自动选中的栏目（可能需要人工补进配置）：');
  for (const c of missed) console.log(`  - ${c.name}  最新 ${c.latest}  内容分 ${Math.round((c.contentScore || 0) * 100)}%  ${c.url}`);
}
