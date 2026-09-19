// 评估把抓取搬到 Cloudflare Worker 的可行性
import { Store } from '../src/store/db.mjs';
import { buildSources } from '../src/core/sources.mjs';

const sources = buildSources();
const store = new Store();
const total = store.db.prepare('SELECT COUNT(*) AS c FROM items').get().c;
const withBody = store.db.prepare("SELECT COUNT(*) AS c FROM items WHERE length(COALESCE(body_text,'')) > 30").get().c;

console.log('=== 抓取规模 ===');
console.log(`  信源数: ${sources.length}`);
console.log(`  每轮列表页请求: ${sources.length}`);
console.log(`  每轮详情页请求: 最多 ${sources.length * 25}（远超任何单次请求的子请求上限）`);

console.log('\n=== 数据构成 ===');
console.log(`  条目总数: ${total}`);
console.log(`  含正文: ${withBody}（${Math.round(withBody / total * 100)}%）`);
console.log('  正文的用途：全文搜索、截止时间识别、详情页直接阅读');

console.log('\n=== Cloudflare Workers 免费版限制 ===');
console.log('  · 单次请求最多 50 个子请求（fetch）');
console.log('  · Cron Triggers 支持，最小 1 分钟粒度');
console.log('  · CPU 时间 10ms/请求（网络等待不计入 CPU）');
console.log('  · KV 免费额度：10 万次读/天，1000 次写/天');

console.log('\n=== 结论 ===');
console.log(`  ${sources.length} 个列表页 > 50 子请求上限，必须分批。`);
console.log('  方案：把信源切成 N 批，每次 cron 抓一批，N 次 cron 完成一轮。');
const batches = Math.ceil(sources.length / 40);
console.log(`  按每批 40 个信源算：${batches} 批 → 若 cron 每 5 分钟一次，一轮约 ${batches * 5} 分钟。`);
console.log('  详情页：无法在同一轮抓完，改为「首次入库时抓一次详情并存入 KV」，');
console.log('  之后列表轮询只更新标题与日期。KV 写入 1000 次/天，够用。');

store.close();
