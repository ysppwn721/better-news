/**
 * 读取 CI 中指定步骤的日志（UTF-8 解码，按步骤名过滤）。
 * 用法: node scripts/ci-log.mjs <workflowFile> <步骤关键字> [上下文行数]
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const wf = process.argv[2] || 'android.yml';
const keyword = process.argv[3] || '构建 APK';
const ctx = Number(process.argv[4] || 120);

const cred = await new Promise((resolve) => {
  const c = spawn('git', ['credential', 'fill'], { windowsHide: true });
  let o = '';
  c.stdout.on('data', (d) => { o += d; });
  c.on('close', () => resolve((o.match(/^password=(.+)$/m) || [])[1]?.trim()));
  c.stdin.write('protocol=https\nhost=github.com\n\n');
  c.stdin.end();
});
const H = { Authorization: `Bearer ${cred}`, Accept: 'application/vnd.github+json', 'User-Agent': 'bn' };
const API = 'https://api.github.com/repos/ysppwn721/better-news';

const wfs = (await (await fetch(`${API}/actions/workflows`, { headers: H })).json()).workflows;
const target = wfs.find((w) => w.path.endsWith(wf));
if (!target) { console.error(`未找到工作流 ${wf}`); process.exit(1); }

const runs = (await (await fetch(`${API}/actions/workflows/${target.id}/runs?per_page=5`, { headers: H })).json()).workflow_runs;
const run = runs[0];
console.log(`工作流 ${wf} 运行 #${run.run_number}  ${run.status}/${run.conclusion}\n`);

const jobs = (await (await fetch(`${API}/actions/runs/${run.id}/jobs`, { headers: H })).json()).jobs;
const jobId = jobs[0].id;
const buf = Buffer.from(await (await fetch(`${API}/actions/jobs/${jobId}/logs`, { headers: H })).arrayBuffer());
const lines = new TextDecoder('utf-8').decode(buf).split('\n')
  .map((l) => l.replace(/^\S+Z\s*/, '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\r$/, ''));

// 定位到包含关键字的分组
let start = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes(`##[group]`) && lines[i].includes(keyword)) { start = i; break; }
}
if (start < 0) {
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(keyword)) { start = i; break; }
}
if (start < 0) {
  console.log(`未定位到步骤「${keyword}」，输出最后 ${ctx} 行：`);
  console.log(lines.slice(-ctx).join('\n'));
} else {
  // 找到该分组结束
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].includes('##[endgroup]')) { end = i + 1; break; }
  }
  // 失败信息常在 endgroup 之后，多取一些
  end = Math.min(lines.length, end + ctx);
  const seg = lines.slice(start, end);
  writeFileSync('.dsh-vision-router/ci-log.txt', seg.join('\n'), 'utf8');
  console.log(seg.join('\n'));
  console.log('\n(完整片段已写入 .dsh-vision-router/ci-log.txt)');
}
