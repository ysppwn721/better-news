/**
 * 关闭本地服务自带的定时抓取（与 Windows 计划任务那两个抓取器之二）。
 *
 * 为什么走 API 而不是改代码/重启：PUT /api/settings 会写 config/settings.json
 * 并调用 scheduleCron()（先 stop 旧任务，再按新设置决定是否重建），
 * 因此**无需重启服务**即可停止定时抓取——服务本身还能照常用来浏览。
 *
 * 用法: node scripts/disable-cron.mjs [--show]
 */
const BASE = process.env.BN_BASE || 'http://127.0.0.1:5178';

const get = async () => {
  const r = await fetch(`${BASE}/api/settings`);
  if (!r.ok) throw new Error(`读取设置失败 HTTP ${r.status}`);
  return r.json();
};

if (process.argv.includes('--show')) {
  const s = await get();
  console.log('当前设置：');
  console.log(`  autoFetch     : ${s.autoFetch}`);
  console.log(`  cron          : ${JSON.stringify(s.cron)}`);
  console.log(`  fetchColleges : ${s.fetchColleges}`);
  process.exit(0);
}

const before = await get();
console.log('修改前：autoFetch =', before.autoFetch, '| cron =', JSON.stringify(before.cron));

const r = await fetch(`${BASE}/api/settings`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  // autoFetch:false → scheduleCron() 里 `if (!settings.autoFetch ...) return;` 直接返回，
  // 于是旧任务被 stop 且不再重建；cron 一并置空，双保险。
  body: JSON.stringify({ autoFetch: false, cron: '' }),
});
if (!r.ok) {
  console.error('✗ 修改失败 HTTP', r.status, (await r.text()).slice(0, 200));
  process.exit(1);
}
const { settings } = await r.json();
console.log('修改后：autoFetch =', settings.autoFetch, '| cron =', JSON.stringify(settings.cron));

// 复核：确实落盘了
const after = await get();
console.log('复核  ：autoFetch =', after.autoFetch, '| cron =', JSON.stringify(after.cron));
console.log(after.autoFetch === false ? '\n✓ 服务端定时抓取已关闭（无需重启）' : '\n✗ 未生效，请检查');
