#!/usr/bin/env node
/**
 * 启用 GitHub Pages（使用 GitHub Actions 作为发布源），并等待站点上线。
 *
 * 为什么需要脚本：Pages 默认未启用，configure-pages 动作会报 Not Found。
 * 通过 REST API 启用比在工作流里加 enablement: true 更可控，
 * 且能在本地直接验证结果。
 *
 * 用法: node scripts/enable-pages.mjs [owner/repo]
 */
const repo = process.argv[2] || 'ysppwn721/better-news';

// 从 git 凭据管理器取令牌
const { spawn } = await import('node:child_process');
const cred = await new Promise((resolve) => {
  const c = spawn('git', ['credential', 'fill'], { windowsHide: true });
  let o = '';
  c.stdout.on('data', (d) => { o += d; });
  c.on('close', () => resolve({ pass: (o.match(/^password=(.+)$/m) || [])[1]?.trim() }));
  c.stdin.write('protocol=https\nhost=github.com\n\n');
  c.stdin.end();
});

if (!cred.pass) {
  console.error('✗ 未取到 GitHub 凭据');
  process.exit(1);
}

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cred.pass}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'better-news-deploy',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 300) }; }
  return { status: res.status, ok: res.ok, body };
};

console.log(`① 检查 ${repo} 的 Pages 状态…`);
let cur = await api(`/repos/${repo}/pages`);
if (cur.ok) {
  console.log(`  · 已启用：${cur.body.html_url}（build_type=${cur.body.build_type}）`);
} else {
  console.log('  · 未启用，正在创建…');
  // source 用对象形式；build_type=workflow 表示由 Actions 发布
  const created = await api(`/repos/${repo}/pages`, {
    method: 'POST',
    body: JSON.stringify({ build_type: 'workflow' }),
  });
  if (!created.ok) {
    console.error(`✗ 启用失败（HTTP ${created.status}）：${JSON.stringify(created.body).slice(0, 400)}`);
    console.error('  若提示权限不足，令牌需要 repo + pages 权限；可改用仓库 Settings → Pages 手动启用（Source 选 GitHub Actions）。');
    process.exit(1);
  }
  console.log(`  ✓ 已启用：${created.body.html_url}`);
}

// 等待站点可访问
const siteUrl = (await api(`/repos/${repo}/pages`)).body?.html_url;
if (!siteUrl) {
  console.error('✗ 无法获取站点地址');
  process.exit(1);
}
console.log(`\n② 站点地址：${siteUrl}`);
console.log('  （首次发布需要 1～3 分钟，可运行 deploy.yml 工作流触发发布）');
