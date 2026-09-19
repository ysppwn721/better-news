// 查看电气与控制工程学院的两个同名「通知公告」栏目是否真的是不同栏目
import { HttpClient } from '../src/core/http.mjs';
import { parseList } from '../src/sources/cms.mjs';
import { loadDiscovered } from '../src/core/sources.mjs';

const d = loadDiscovered()['col-ece'];
console.log('学院:', d.collegeName);
console.log('\n=== 已选用的栏目 ===');
for (const c of d.columns || []) console.log(`  ${c.name.padEnd(16, '　')} ${c.url}`);

console.log('\n=== 候选里的通知类栏目 ===');
const notice = (d.candidates || []).filter((c) => /通知|公告|公示/.test(c.name || ''));
for (const c of notice) console.log(`  ${c.name.padEnd(16, '　')} 最新=${c.latest}  ${c.url}`);

const client = new HttpClient({ timeoutMs: 20000 });
console.log('\n=== 逐个抓取对比内容 ===');
for (const c of notice) {
  try {
    const { html } = await client.fetchHtml(c.url);
    const items = parseList(html, c.url);
    const latest = items.map((i) => i.date).filter(Boolean).sort().pop();
    console.log(`\n  ${c.url}`);
    console.log(`    解析 ${items.length} 条，最新 ${latest}`);
    for (const it of items.slice(0, 3)) console.log(`      ${it.date} ${it.title.slice(0, 40)}`);
  } catch (e) {
    console.log(`\n  ${c.url}\n    抓取失败: ${e.message.slice(0, 50)}`);
  }
}
