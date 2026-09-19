/**
 * 抓取客户端：编码自适应（UTF-8 / GBK）+ 超时 + 退避重试 + 限速。
 *
 * 中北大学主站 www.nuc.edu.cn 部分页面是 GBK 编码，子站多为 UTF-8，
 * 因此必须先嗅探 charset 再解码，否则中文标题会变乱码。
 */
import { log } from './log.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const REPLACEMENT_THRESHOLD = 30;

/** 从字节流嗅探编码：优先 meta charset，其次 Content-Type，其次 BOM */
function sniffCharset(buf, contentType) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  const head = buf.subarray(0, 4096).toString('latin1');
  const meta = head.match(/charset\s*=\s*["']?\s*([\w-]+)/i);
  if (meta) return meta[1].toLowerCase();
  const ct = (contentType || '').match(/charset\s*=\s*([\w-]+)/i);
  if (ct) return ct[1].toLowerCase();
  return null;
}

function decode(buf, charset) {
  const cs = (charset || 'utf-8').toLowerCase();
  if (cs === 'gb2312' || cs === 'gbk' || cs === 'gb18030') {
    try { return new TextDecoder('gb18030').decode(buf); } catch { /* fallthrough */ }
  }
  return buf.toString('utf8');
}

export class HttpClient {
  /** @param {{timeoutMs?: number, retries?: number, minIntervalMs?: number}} [opts] */
  constructor(opts = {}) {
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.retries = opts.retries ?? 2;
    this.minIntervalMs = opts.minIntervalMs ?? 350;
    this.lastAt = 0;
  }

  async #throttle() {
    const wait = this.lastAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastAt = Date.now();
  }

  /**
   * 抓取单页
   * @returns {Promise<{html: string, url: string, status: number, charset: string}>}
   */
  async fetchHtml(url, { retries = this.retries } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        const backoff = 700 * 2 ** (attempt - 1);
        log.debug(`重试 ${attempt}/${retries} (${backoff}ms) ${url}`);
        await new Promise((r) => setTimeout(r, backoff));
      }
      await this.#throttle();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
          signal: ac.signal,
          redirect: 'follow',
          headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Connection': 'keep-alive',
          },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        let charset = sniffCharset(buf, res.headers.get('content-type'));
        let html = decode(buf, charset);

        // 嗅探失败但解出大量替换符 → 极可能是 GBK 站点
        const bad = (html.match(/\uFFFD/g) || []).length;
        if (bad > REPLACEMENT_THRESHOLD && (!charset || charset.startsWith('utf'))) {
          const alt = decode(buf, 'gb18030');
          if ((alt.match(/\uFFFD/g) || []).length < bad) {
            html = alt;
            charset = 'gb18030(guessed)';
          }
        }
        return { html, url: res.url || url, status: res.status, charset: charset || 'utf-8' };
      } catch (e) {
        lastErr = e;
        if (e.name === 'AbortError') lastErr = new Error(`超时 (${this.timeoutMs}ms)`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`抓取失败 ${url}: ${lastErr?.message || lastErr}`);
  }
}

export const defaultClient = new HttpClient();
