// 侦察脚本：探测各站点栏目页的列表结构，输出候选条目 + DOM 特征
// 用法: node scripts/probe.mjs <url> [outfile]
const url = process.argv[2];
const out = process.argv[3];

const r = await fetch(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  },
});
const buf = Buffer.from(await r.arrayBuffer());
let html = buf.toString('utf8');
// GBK 兜底：若 utf8 解码出现大量替换字符，尝试 gbk
if ((html.match(/\uFFFD/g) || []).length > 20) {
  try { html = new TextDecoder('gbk').decode(buf); } catch {}
  console.log('[encoding] gbk fallback used');
}
console.log(`[status] ${r.status}  [bytes] ${buf.length}  [final] ${r.url}`);

const chardet = (html.match(/charset=["']?([\w-]+)/i) || [])[1];
console.log(`[charset-declared] ${chardet}`);

// 抓取所有链接文本，过滤出像新闻标题的
const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{2,200}?)<\/a>/gi;
const items = [];
let m;
while ((m = re.exec(html))) {
  const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (text.length >= 8 && /[\u4e00-\u9fa5]/.test(text)) {
    items.push({ href: m[1], text });
  }
}
console.log(`[link-items] ${items.length}`);
for (const it of items.slice(0, 40)) console.log(`  ${it.text.slice(0, 46)}  ||  ${it.href}`);

// 找日期
const dates = [...html.matchAll(/(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})/g)].slice(0, 12).map(x => x[0]);
console.log(`[dates] ${[...new Set(dates)].join(' | ')}`);

// 找 \"info/栏目/文章\" 模式
const cols = [...new Set([...html.matchAll(/info\/(\d+)\//g)].map(x => x[1]))];
console.log(`[columns] ${cols.join(',')}`);

if (out) {
  const fs = await import('node:fs');
  fs.mkdirSync(new URL('.', `file:///${out.replace(/\\/g, '/')}`).pathname.replace(/^\//, ''), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`[saved] ${out}`);
}
