/**
 * 提取 CI 日志里的「真实错误行」：过滤 Gradle 的 Java 栈帧噪音。
 * 用法: node scripts/ci-errors.mjs <workflowFile>
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const wf = process.argv[2] || 'android.yml';
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
const runs = (await (await fetch(`${API}/actions/workflows/${target.id}/runs?per_page=3`, { headers: H })).json()).workflow_runs;
const run = runs[0];
console.log(`运行 #${run.run_number}  ${run.status}/${run.conclusion}`);
console.log(run.html_url + '\n');

const jobs = (await (await fetch(`${API}/actions/runs/${run.id}/jobs`, { headers: H })).json()).jobs;
const buf = Buffer.from(await (await fetch(`${API}/actions/jobs/${jobs[0].id}/logs`, { headers: H })).arrayBuffer());
const all = new TextDecoder('utf-8').decode(buf).split('\n')
  .map((l) => l.replace(/^\S+Z\s*/, '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\r$/, ''));

mkdirSync('.dsh-vision-router', { recursive: true });
writeFileSync('.dsh-vision-router/ci-full.log', all.join('\n'), 'utf8');

// 丢掉 Java 栈帧、下载进度、空行
const noise = /^\s*(at |\.\.\.|> Task|Download |Caching|Watching|Starting a Gradle|Daemon|Welcome|For more|To honour|Deprecated|Deprecation|\(node:\d+\)|Consolidate|Calculating|Note:|Use '--|See http|\||\+---|\\---)/;
const interesting = all.filter((l) => l.trim() && !noise.test(l));

// 只保留失败附近的段落
const errIdx = [];
interesting.forEach((l, i) => {
  if (/FAILURE:|FAILED|error:|Error:|What went wrong|Execution failed|Could not|Caused by|A problem occurred|requires|Unsupported|not found|No such|missing/i.test(l)) {
    errIdx.push(i);
  }
});

console.log('=== 关键错误行 ===');
if (!errIdx.length) {
  console.log('（未匹配到关键字，输出最后 60 行非栈帧内容）');
  console.log(interesting.slice(-60).join('\n'));
} else {
  // 取前 6 个位置附近的内容（去重、避免重复打印同一段）
  const printed = new Set();
  for (const i of errIdx.slice(0, 12)) {
    for (let k = Math.max(0, i - 2); k <= Math.min(interesting.length - 1, i + 3); k++) {
      if (printed.has(k)) continue;
      printed.add(k);
      console.log('  ' + interesting[k].slice(0, 220));
    }
    console.log('  ---');
  }
}
console.log('\n完整日志: .dsh-vision-router/ci-full.log');
