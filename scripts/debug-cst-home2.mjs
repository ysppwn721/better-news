// 定位计算机学院首页上 2026-09-16 / 09-15 这些最新条目所在区块
import { HttpClient } from '../src/core/http.mjs';

const url = 'http://cst.nuc.edu.cn/';
const client = new HttpClient({ timeoutMs: 25000 });
const { html } = await client.fetchHtml(url);

for (const needle of ['2026-09-16', '2026-09-15', '2026-09-04']) {
  const i = html.indexOf(needle);
  console.log(`\n########## ${needle} @ ${i} ##########`);
  if (i < 0) { console.log('  未找到'); continue; }
  console.log(JSON.stringify(html.slice(Math.max(0, i - 800), i + 300)));
}

// 列出首页所有带链接的区块标题
console.log('\n########## 首页区块（div id/class + 标题）##########');
for (const m of html.matchAll(/<(div|ul|dl)[^>]*(?:id|class)="([^"]{2,40})"[^>]*>\s*(?:<[^>]+>\s*){0,3}([\u4e00-\u9fa5]{2,14})/g)) {
  console.log(`  <${m[1]} ${m[2]}> → ${m[3]}`);
}
