/**
 * 发布 APK 到 GitHub Releases（用 git 凭据管理器里的令牌，无需 gh 认证）。
 *
 * 用法: node scripts/release-apk.mjs <apk路径> [tag]
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, basename } from 'node:path';

const apk = process.argv[2];
const tag = process.argv[3] || 'v1.0.0';
const REPO = 'ysppwn721/better-news';

if (!apk || !existsSync(apk)) {
  console.error(`✗ 找不到 APK: ${apk}`);
  process.exit(1);
}

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
  'User-Agent': 'better-news-release',
  'X-GitHub-Api-Version': '2022-11-28',
};

const NOTES = `## 中北大学通知 App

**安装**：下载下方 \`app-release.apk\` 到手机，点击安装。
首次安装需在系统设置中允许「安装未知来源应用」。

### 特性

- **App 自带抓取**：直连 49 个校内外信源（学校主页、学工部、教务部、研究生院、校团委 + 21 个学院）
- **不需要服务器**：也不需要电脑开机，打开 App 点刷新即可抓取
- **按栏目汇总**：党务工作 / 学生工作 / 教务选课 / 研究生 / 团学活动 / 学校主页 / 学院通知
- **计算机科学与技术学院置顶**
- 截止时间自动识别、关键词标签、已读收藏、全文搜索
- 数据存在手机本地，离线可看

### 技术说明

学校网站不返回 CORS 头，浏览器里的 JavaScript 无法跨域抓取。
App 通过 Capacitor 的原生网络栈发起请求（CapacitorHttp），绕开浏览器同源策略，
因此可以在手机上直接抓取，无需任何中转服务器。

实测：49 个信源全部成功，约 17 秒完成一轮抓取，671 条通知全部带发布日期。

### 首次使用建议

1. 打开 App，会自动抓取一次（约 20 秒，请保持网络畅通）
2. 在「设置」中开启「页面内提醒」，有新通知时会弹提示
3. 建议把 App 加入电池优化白名单，避免后台被限制
`;

console.log(`① 检查 Release ${tag} 是否已存在…`);
let rel = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers: H });
let relBody = rel.ok ? await rel.json() : null;

if (!relBody) {
  console.log('  创建 Release…');
  const created = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: `中北通知 ${tag}`,
      body: NOTES,
      draft: false,
      prerelease: false,
    }),
  });
  relBody = await created.json();
  if (!created.ok) {
    console.error(`✗ 创建失败（HTTP ${created.status}）：${JSON.stringify(relBody).slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`  ✓ 已创建：${relBody.html_url}`);
} else {
  console.log(`  · 已存在：${relBody.html_url}`);
}

// 上传附件（同名先删）
console.log('② 上传 APK…');
const name = basename(apk);
const existingAsset = (relBody.assets || []).find((a) => a.name === name);
if (existingAsset) {
  await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${existingAsset.id}`, {
    method: 'DELETE', headers: H,
  });
  console.log('  · 已删除同名旧附件');
}

const data = readFileSync(apk);
const upload = await fetch(
  `https://uploads.github.com/repos/${REPO}/releases/${relBody.id}/assets?name=${encodeURIComponent(name)}`,
  {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': String(data.length) },
    body: data,
  },
);
const uploaded = await upload.json();
if (!upload.ok) {
  console.error(`✗ 上传失败（HTTP ${upload.status}）：${JSON.stringify(uploaded).slice(0, 300)}`);
  process.exit(1);
}

const sizeMb = (statSync(apk).size / 1024 / 1024).toFixed(2);
console.log(`  ✓ 已上传 ${name}（${sizeMb} MB）`);
console.log(`\n下载地址：${uploaded.browser_download_url}`);
console.log(`Release：${relBody.html_url}`);
