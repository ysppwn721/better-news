/**
 * 探测 Worker 环境能否访问校内站点。
 *
 * 用途：判断「把抓取逻辑搬到 Cloudflare Worker」是否可行。
 * 结果会揭示两类信息：
 *   1) 各校站点的 HTTP 可达性（是否有地区/风控拦截）
 *   2) Worker 出口 IP 与所在地区（Cloudflare 边缘节点）
 *
 * 用法：先把本文件内容临时挂到 worker 路由上，或直接 wrangler dev 后访问 /probe
 */
export async function probeSites() {
  const targets = [
    ['主站通知公告', 'https://www.nuc.edu.cn/index/tzgg.htm'],
    ['学工部通知', 'https://xsgzb.nuc.edu.cn/index/tzgg.htm'],
    ['教务部通知', 'http://jwc.nuc.edu.cn/index/tzgg.htm'],
    ['研究生院通知', 'http://grs.nuc.edu.cn/index/tzgg.htm'],
    ['校团委', 'https://tw.nuc.edu.cn/'],
    ['计算机学院', 'http://cst.nuc.edu.cn/'],
    ['航空宇航学院', 'http://hkyh.nuc.edu.cn/index/tzgg.htm'],
  ];

  const results = [];
  for (const [name, url] of targets) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        redirect: 'follow',
      });
      const buf = await res.arrayBuffer();
      const text = new TextDecoder('utf-8').decode(buf.slice(0, 4000));
      const isHtml = /<html|<!doctype|<\/html/i.test(text);
      const hasCmsMarker = /v_news_content|Visual SiteBuilder|_sitegray/i.test(text);
      results.push({
        name,
        url,
        status: res.status,
        bytes: buf.byteLength,
        ms: Date.now() - started,
        isHtml,
        hasCmsMarker,
        cfRay: res.headers.get('cf-ray') || null,
        server: res.headers.get('server') || null,
        contentType: res.headers.get('content-type') || null,
        snippet: isHtml ? text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 120) : null,
      });
    } catch (e) {
      results.push({ name, url, error: String(e).slice(0, 200), ms: Date.now() - started });
    }
  }
  return results;
}
