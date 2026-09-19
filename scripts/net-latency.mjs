/**
 * 比较不同出口 IP 对学校站点的可达性与延迟。
 *
 * 用途：判断「手机 App 自己抓取」是否可行。
 * 手机的蜂窝网络出口（中国移动/联通/电信）若与家宽同样能直连学校站点，
 * 则 App 可以自行抓取，不再需要服务器或电脑常开。
 *
 * 本脚本从本机发起，测的是「本机到各站点的真实延迟分布」，
 * 并顺带输出本机公网出口信息，用于与手机侧对比。
 */
import { HttpClient } from '../src/core/http.mjs';

const targets = [
  ['主站通知公告', 'https://www.nuc.edu.cn/index/tzgg.htm'],
  ['学工部通知', 'https://xsgzb.nuc.edu.cn/index/tzgg.htm'],
  ['教务部通知', 'http://jwc.nuc.edu.cn/index/tzgg.htm'],
  ['研究生院通知', 'http://grs.nuc.edu.cn/index/tzgg.htm'],
  ['计算机学院通知', 'http://cst.nuc.edu.cn/xwzx/tzgg.htm'],
  ['校团委', 'https://tw.nuc.edu.cn/', true],
];

const client = new HttpClient({ timeoutMs: 30000, retries: 0, minIntervalMs: 0 });

console.log('=== 本机出口信息 ===');
try {
  const res = await fetch('https://cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  const get = (k) => (text.match(new RegExp(`^${k}=(.+)$`, 'm')) || [])[1];
  console.log(`  IP: ${get('ip')}  地区: ${get('loc')}  出口节点: ${get('colo')}`);
} catch (e) {
  console.log('  获取失败:', e.message);
}

console.log('\n=== 学校站点可达性（本机 = 中国大陆家宽）===');
const times = [];
for (const [name, url] of targets) {
  const t0 = Date.now();
  try {
    const { html } = await client.fetchHtml(url);
    const ms = Date.now() - t0;
    times.push(ms);
    console.log(`  ✓ ${name.padEnd(14, '　')} ${String(ms).padStart(6)}ms  ${html.length} 字节`);
  } catch (e) {
    console.log(`  ✗ ${name.padEnd(14, '　')}  失败: ${e.message.slice(0, 60)}`);
  }
}

if (times.length) {
  times.sort((a, b) => a - b);
  console.log(`\n  延迟: 最快 ${times[0]}ms, 中位 ${times[Math.floor(times.length / 2)]}ms, 最慢 ${times[times.length - 1]}ms`);
  const total = times.reduce((a, b) => a + b, 0);
  console.log(`  串行抓 49 个信源预计耗时: ${(total / times.length * 49 / 1000).toFixed(0)} 秒（并行可大幅缩短）`);
}

console.log('\n=== 结论 ===');
console.log('  若手机蜂窝网络同样能直连这些站点，则 App 可自行抓取，无需服务器。');
console.log('  验证方法：用手机浏览器打开 http://cst.nuc.edu.cn/xwzx/tzgg.htm 能正常显示即通过。');
