/**
 * 从一次成功的 Actions 构建里取回 APK 产物，并用它创建/替换 GitHub Release。
 *
 * 为什么需要这个脚本：删除并重推同名 tag 时，CI 里的
 * `gh release view` → `gh release create` 会和 tag 重建竞争，
 * 出现过「步骤显示 success 但 Release 根本没建出来」的情况
 * （v1.5 就踩到了：jobs 里「发布到 Releases」是绿的，/releases 里却没有 v1.5）。
 * 这时不该重推 tag 再赌一次，而应该把**已经构建并校验过的产物**直接发布出去。
 *
 * 用法: node scripts/publish-apk-from-run.mjs <runId> <tag>
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const runId = process.argv[2];
const tag = process.argv[3] || 'v1.5';
const REPO = 'ysppwn721/better-news';
if (!runId) { console.error('用法: node scripts/publish-apk-from-run.mjs <runId> <tag>'); process.exit(1); }

// 取 git 凭据管理器里的令牌（与 release-apk.mjs 一致，无需 gh 登录）
const cred = await new Promise((res) => {
  const c = spawn('git', ['credential', 'fill'], { windowsHide: true });
  let o = '';
  c.stdout.on('data', (d) => { o += d; });
  c.on('close', () => res((o.match(/^password=(.+)$/m) || [])[1]?.trim()));
  c.stdin.write('protocol=https\nhost=github.com\n\n');
  c.stdin.end();
});
if (!cred) { console.error('✗ 取不到 GitHub 凭据'); process.exit(1); }
const H = {
  Authorization: `Bearer ${cred}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'better-news-publish',
  'X-GitHub-Api-Version': '2022-11-28',
};

console.log(`① 查询构建 ${runId} 的产物…`);
const artRes = await fetch(`https://api.github.com/repos/${REPO}/actions/runs/${runId}/artifacts`, { headers: H });
const arts = await artRes.json();
const art = (arts.artifacts || []).find((a) => /apk/i.test(a.name));
if (!art) { console.error('✗ 该构建没有 APK 产物:', JSON.stringify(arts).slice(0, 300)); process.exit(1); }
console.log(`   ${art.name}  ${(art.size_in_bytes / 1048576).toFixed(2)}MB  (${art.expired ? '已过期' : '可用'})`);
if (art.expired) { console.error('✗ 产物已过期，请重新构建'); process.exit(1); }

console.log('② 下载产物 zip…');
const zipRes = await fetch(art.archive_download_url, { headers: { ...H, Accept: 'application/vnd.github+json' }, redirect: 'follow' });
if (!zipRes.ok) { console.error('✗ 下载失败 HTTP', zipRes.status); process.exit(1); }
const zipBuf = Buffer.from(await zipRes.arrayBuffer());
const tmp = resolve('dist/_artifact.zip');
mkdirSync('dist', { recursive: true });
writeFileSync(tmp, zipBuf);
console.log(`   ${(zipBuf.length / 1048576).toFixed(2)}MB`);

console.log('③ 解包取 APK…');
// 产物 zip 里就是一个 APK（可能有嵌套目录），用 Expand-Archive 更省事
const dir = resolve('dist/_artifact');
const { rmSync } = await import('node:fs');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
await new Promise((res, rej) => {
  const ps = spawn('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -Path '${tmp}' -DestinationPath '${dir}' -Force`], { stdio: 'ignore' });
  ps.on('close', (c) => (c === 0 ? res() : rej(new Error('解包失败'))));
});
const { readdirSync } = await import('node:fs');
let apkPath = null;
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = resolve(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.apk$/i.test(e.name)) apkPath = p;
  }
};
walk(dir);
if (!apkPath) { console.error('✗ 产物里没有 .apk'); process.exit(1); }
console.log(`   ${apkPath}  ${(statSync(apkPath).size / 1048576).toFixed(2)}MB`);

// 发布前先本地校验一遍（与 CI 的校验互为补充，这里是发布前的最后一道）
console.log('④ 发布前校验 APK…');
for (const [label, args] of [
  ['签名', ['scripts/verify-apk.mjs', apkPath]],
  ['内容+明文放行', ['scripts/inspect-apk.mjs', apkPath]],
  ['实现断言', ['scripts/check-apk-version.mjs', apkPath]],
]) {
  const code = await new Promise((res) => {
    const p = spawn('node', args, { stdio: 'inherit' });
    p.on('close', res);
  });
  if (code !== 0) { console.error(`✗ ${label} 校验未通过，中止发布`); process.exit(1); }
}

console.log('⑤ 创建 / 更新 Release…');
const relRes = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers: H });
let rel = relRes.ok ? await relRes.json() : null;

const NOTES = `## 中北通知 ${tag}

**安装**：下载 \`app-release.apk\`，点击安装（首次需允许「安装未知来源应用」）。已装旧版可直接覆盖。

### 本版内容

- **我的关注**：只提醒跟你有关的事。卡片上点「🔖 关注」加入清单；
  **关键词关注**（加「选课」「综测」「推免」「开题」）命中就自动进清单并提醒。
  无关的可以一键清掉（「清掉自动加入的」会保留你手动关注的那几条）。
- **手机日程提醒**：关注清单可导出 \`.ics\` 导入**系统日历**，到点由系统提醒——
  不用 App 常驻、不用电脑开机、不用推送服务端。
- **修「点刷新后按钮一直转」**：根因是刷新按钮的转动状态被两处代码分别设置
  （点击处理与每 2 秒的状态轮询互相覆盖），现在统一由真实抓取状态驱动。
- **修 App 抓不到数据**（v1.4）：Android 9+ 默认禁止明文 HTTP，而学校 113 个信源里
  96 个只有 \`http://\`。已只对 \`nuc.edu.cn\` 放行明文（其余仍强制 HTTPS）。
- **计算机学院专栏补全**（v1.4）：5 个栏目 → 16 个栏目（134 → 262 条）。

### 技术说明

学校站点不返回 CORS 头，浏览器无法直接抓取，App 通过原生网络栈
（CapacitorHttp）绕开同源策略，因此可以自己抓、不需要服务器。
`;

if (!rel) {
  const created = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag, name: `中北通知 ${tag}`, body: NOTES,
      draft: false, prerelease: false,
      // 不传 target_commitish：tag 已存在，GitHub 会自动用它指向的提交，
      // 传错反而会把 tag 移到别的提交上。
    }),
  });
  rel = await created.json();
  if (!created.ok) { console.error('✗ 创建 Release 失败:', JSON.stringify(rel).slice(0, 300)); process.exit(1); }
  console.log(`   ✓ 已创建 ${rel.html_url}`);
} else {
  console.log(`   · 已存在，更新说明与附件：${rel.html_url}`);
  await fetch(`https://api.github.com/repos/${REPO}/releases/${rel.id}`, {
    method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: NOTES }),
  });
}

// 上传附件（同名先删）
const data = readFileSync(apkPath);
const name = 'app-release.apk';
const old = (rel.assets || []).find((a) => a.name === name);
if (old) {
  await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${old.id}`, { method: 'DELETE', headers: H });
  console.log('   · 已删除同名旧附件');
}
const up = await fetch(
  `https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`,
  {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': String(data.length) },
    body: data,
  },
);
const uploaded = await up.json();
if (!up.ok) { console.error('✗ 上传失败:', JSON.stringify(uploaded).slice(0, 300)); process.exit(1); }

console.log(`\n✓ 已发布：${uploaded.browser_download_url}`);
console.log(`  Release：${rel.html_url}`);
