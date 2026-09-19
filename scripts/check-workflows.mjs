/**
 * 校验 GitHub Actions 工作流。
 *
 * 为什么需要：工作流 YAML 解析失败时，GitHub 不会报语法错误，
 * 而是表现为「运行记录里没有 job、没有日志」的假死状态——
 * 本项目就踩过：多行说明文本里的中文全角冒号「：」被 YAML 当成映射键分隔符，
 * 整个 workflow 解析失败，排查了很久。
 *
 * 用真正的 YAML 解析器（yaml 包）而不是手写规则，才能覆盖这类隐式语法问题。
 *
 * 用法：node scripts/check-workflows.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, '.github/workflows');

let YAML;
try {
  YAML = (await import('yaml')).default;
} catch {
  console.error('缺少 yaml 依赖：npm i -D yaml');
  process.exit(2);
}

if (!existsSync(DIR)) {
  console.log('没有 .github/workflows 目录，跳过');
  process.exit(0);
}

let failed = 0;
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));

for (const f of files) {
  const path = resolve(DIR, f);
  const raw = readFileSync(path, 'utf8');
  const problems = [];

  let doc = null;
  try {
    doc = YAML.parse(raw);
  } catch (e) {
    problems.push(`YAML 解析失败：${e.message.split('\n')[0]}`);
  }

  if (doc) {
    // 必需结构
    if (!doc.on) problems.push('缺少 on: 触发器');
    if (!doc.jobs || typeof doc.jobs !== 'object' || !Object.keys(doc.jobs).length) {
      problems.push('缺少 jobs 或 jobs 为空');
    }

    // 中文全角冒号常被误写成 YAML 语法（这是本项目踩过的坑）
    const suspicious = raw.split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /^\s*[^\s#][^:]*：/.test(l) && !l.trim().startsWith('#'));
    if (suspicious.length) {
      problems.push(`第 ${suspicious[0].n} 行出现全角冒号「：」，若在非引号环境中会被 YAML 误解析`);
    }

    // Tab 缩进
    raw.split('\n').forEach((l, i) => {
      if (/^\s*\t/.test(l)) problems.push(`第 ${i + 1} 行使用 Tab 缩进`);
    });

    // 每个 job 必须有 runs-on
    for (const [name, job] of Object.entries(doc.jobs || {})) {
      if (!job || typeof job !== 'object') { problems.push(`job "${name}" 定义异常`); continue; }
      if (!job['runs-on'] && !job.uses) problems.push(`job "${name}" 缺少 runs-on`);
    }

    // if 里引用 inputs.* 但没定义 workflow_dispatch
    const hasDispatch = !!doc.on?.workflow_dispatch;
    for (const l of raw.split('\n')) {
      if (/if:.*\binputs\./.test(l) && !hasDispatch) {
        problems.push('if 中引用了 inputs.*，但未定义 workflow_dispatch');
        break;
      }
    }
  }

  const ok = problems.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${f}`);
  for (const p of problems) console.log(`    ${p}`);
}

console.log(`\n检查 ${files.length} 个工作流，${failed} 个有问题`);
process.exit(failed ? 1 : 0);
