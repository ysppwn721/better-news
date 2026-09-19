/**
 * 测量「点开文章 → 正文出现」的真实耗时（分阶段计时）。
 *
 * 背景：在线上 Pages（跨太平洋）测到详情 4 秒仍未加载完成，需要知道它是
 * 「慢但会出来」还是「卡住不出来」。这决定了详情页要不要加超时兜底。
 *
 * 用法: node scripts/measure-detail-timing.mjs [url] [等待秒数=25]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectCdp, waitForResult } from './lib/cdp.mjs';

const url = process.argv[2] || 'https://ysppwn721.github.io/better-news/';
const WAIT_S = Number(process.argv[3] || 25);
const PORT = 9495;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\bn-detail-timing',
  '--window-size=390,844', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });
await sleep(2800);

let target = null;
for (let i = 0; i < 20; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (res.ok) { target = await res.json(); break; }
  } catch {}
  await sleep(500);
}
const api = await connectCdp(target.webSocketDebuggerUrl);
api.send('Runtime.enable');
api.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

const evaluate = async (expr, timeout = 90000) => {
  const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const res = await waitForResult(api, id, timeout);
  if (res?.exceptionDetails) return { __error: res.exceptionDetails.exception?.description };
  return res?.result?.value;
};

// 等首屏
for (let i = 0; i < 40; i++) {
  if (await evaluate(`document.querySelectorAll('.card').length > 0`)) break;
  await sleep(1000);
}
console.log('首屏完成\n');

const out = await evaluate(`(async () => {
  const rec = [];
  const t0 = performance.now();
  const card = document.querySelector('.card');
  const title = card.querySelector('.card-title').textContent.slice(0, 26);

  // 记录详情资源的网络耗时（如果有 Resource Timing）
  card.click();

  // 轮询正文出现
  const deadline = ${WAIT_S} * 1000;
  let appearedAt = null, lastText = null;
  while (performance.now() - t0 < deadline) {
    const body = document.querySelector('.drawer-body .body');
    const txt = body ? body.textContent.trim() : '';
    lastText = txt.slice(0, 40);
    if (txt && !txt.startsWith('正在载入')) { appearedAt = Math.round(performance.now() - t0); break; }
    await new Promise(r => setTimeout(r, 250));
  }
  const body = document.querySelector('.drawer-body .body');
  const finalLen = body ? body.textContent.trim().length : 0;
  return JSON.stringify({
    title,
    appearedAtMs: appearedAt,
    finalLen,
    lastText,
    timedOut: appearedAt === null
  });
})()`, (WAIT_S + 20) * 1000);

console.log(out);
try {
  const o = JSON.parse(out);
  if (o.timedOut) console.log(`\n⚠ ${WAIT_S} 秒内正文未出现——详情加载会「卡在正在载入」`);
  else console.log(`\n✓ 正文在 ${o.appearedAtMs} ms 出现，长度 ${o.finalLen}`);
} catch {}
api.close();
process.exit(0);
