/**
 * 轮询 GitHub Actions 上 v1.4 的 Android 构建，直到完成或超时。
 * 用法: node scripts/watch-android-build.mjs [最多等待分钟=20]
 */
const H = { 'User-Agent': 'better-news-monitor', Accept: 'application/vnd.github+json' };
const REPO = 'ysppwn721/better-news';
const MAX_MIN = Number(process.argv[2] || 20);
const deadline = Date.now() + MAX_MIN * 60000;

async function api(path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, { headers: H });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

let last = '';
while (Date.now() < deadline) {
  let j;
  try {
    j = await api('/actions/runs?per_page=10');
  } catch (e) {
    console.log(`  （API 失败，重试）${e.message}`);
    await new Promise((r) => setTimeout(r, 20000));
    continue;
  }
  const run = j.workflow_runs.find((w) => (w.head_branch || '') === 'v1.4' && /APK/i.test(w.name || ''));
  if (!run) { console.log('未找到 v1.4 的构建'); await new Promise((r) => setTimeout(r, 15000)); continue; }

  const line = `${run.status} / ${run.conclusion || '-'}`;
  if (line !== last) { console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${line}`); last = line; }

  if (run.status === 'completed') {
    console.log(`\n结论: ${run.conclusion}`);
    console.log(`日志: ${run.html_url}`);
    process.exit(run.conclusion === 'success' ? 0 : 1);
  }
  await new Promise((r) => setTimeout(r, 25000));
}
console.log('\n超时未完成，请到 Actions 页面查看:', `https://github.com/${REPO}/actions`);
process.exit(2);
