/**
 * 轮询 GitHub Actions 上某个 tag 的 Android 构建，直到完成或超时。
 *
 * 用法: node scripts/watch-android-build.mjs [最多等待分钟=20] [tag=v1.5]
 *
 * ⚠ 必须按「本次开始之后创建的 run」过滤并按时间取最新的：
 *   之前只写 `.find(head_branch === tag)`，它会命中**历史上同名的旧 run**
 *   （v1.4 那次），于是脚本立刻报「completed / success」——
 *   实际新的构建还在排队。差一点就据此误判发布成功。
 */
const H = { 'User-Agent': 'better-news-monitor', Accept: 'application/vnd.github+json' };
const REPO = 'ysppwn721/better-news';
const MAX_MIN = Number(process.argv[2] || 20);
const TAG = process.argv[3] || 'v1.5';
const startedAt = Date.now();
const deadline = startedAt + MAX_MIN * 60000;

async function api(path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, { headers: H });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

let last = '';
let announced = false;
while (Date.now() < deadline) {
  let j;
  try {
    j = await api('/actions/runs?per_page=30');
  } catch (e) {
    console.log(`  （API 失败，重试）${e.message}`);
    await new Promise((r) => setTimeout(r, 20000));
    continue;
  }
  // 只看本次脚本启动之后创建的、tag 匹配的 APK 构建，取最新的一条
  const candidates = j.workflow_runs
    .filter((w) => (w.head_branch || '') === TAG && /APK/i.test(w.name || ''))
    .filter((w) => new Date(w.created_at).getTime() >= startedAt - 120000)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const run = candidates[0];
  if (!run) {
    if (!announced) { console.log(`未发现 ${TAG} 的新构建，继续等待…`); announced = true; }
    await new Promise((r) => setTimeout(r, 15000));
    continue;
  }

  const line = `${run.status} / ${run.conclusion || '-'}`;
  if (line !== last) { console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${line}  (run ${run.id})`); last = line; }

  if (run.status === 'completed') {
    console.log(`\n结论: ${run.conclusion}`);
    console.log(`日志: ${run.html_url}`);
    process.exit(run.conclusion === 'success' ? 0 : 1);
  }
  await new Promise((r) => setTimeout(r, 25000));
}
console.log('\n超时未完成，请到 Actions 页面查看:', `https://github.com/${REPO}/actions`);
process.exit(2);
