// 导航发现：抓首页，列出所有栏目页候选（相对链接 .htm 且非 info/ 文章页）
const sites = process.argv.slice(2);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

for (const base of sites) {
  try {
    const r = await fetch(base, { headers: { 'User-Agent': UA } });
    const buf = Buffer.from(await r.arrayBuffer());
    let html = buf.toString('utf8');
    if ((html.match(/\uFFFD/g) || []).length > 20) {
      try { html = new TextDecoder('gbk').decode(buf); } catch {}
    }
    const origin = new URL(base).origin;
    const links = new Map();
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{1,80}?)<\/a>/gi)) {
      let href = m[1].trim();
      const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!text || /^(首页|more|更多|下一条|上一条)$/i.test(text)) continue;
      if (/^javascript:|^mailto:|\.(jpg|png|gif|pdf|doc|docx|xls|zip|rar)$/i.test(href)) continue;
      let abs;
      try { abs = new URL(href, base).href; } catch { continue; }
      if (!abs.startsWith(origin)) continue;
      if (/\/info\/\d+\//.test(abs)) continue;        // 文章页
      if (/\.(css|js)$/i.test(abs)) continue;
      if (!/\.htm/i.test(abs)) continue;
      // 只保留像栏目的：中文标题 2-12 字
      if (!/^[\u4e00-\u9fa5A-Za-z0-9（）()\-]{2,14}$/.test(text)) continue;
      if (!links.has(abs)) links.set(abs, text);
    }
    console.log(`\n########## ${base}  (${links.size} 个栏目候选) ##########`);
    for (const [u, t] of links) console.log(`  ${t.padEnd(16, '　')} ${u.replace(origin, '')}   [${u}]`);
  } catch (e) {
    console.log(`\n########## ${base} ERR ${e.message}`);
  }
}
