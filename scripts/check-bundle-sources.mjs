/** 检查打好的 shared.mjs 里到底有没有新加的学院栏目信源。 */
import { readFileSync } from 'node:fs';

const f = process.argv[2] || 'app/www/shared.mjs';
const s = readFileSync(f, 'utf8');
console.log(`文件: ${f}  ${s.length} 字符\n`);

for (const n of ['cst.nuc.edu.cn', 'xsgz/txdt', 'yjspy/jygl', 'zjspy', 'zsxx.htm',
  'xwgl', 'txdt', 'kydt', 'ghgz', 'col-cst-5', 'col-cst-8', 'col-cst-11', 'col-cst-15']) {
  console.log(String(n).padEnd(20), s.split(n).length - 1);
}

const ids = [...new Set([...s.matchAll(/col-cst-(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
console.log(`\n包内 col-cst-N id: ${ids.join(', ')}`);

// 数一数信源对象个数（形如 id: "xxx"）
const srcIds = [...s.matchAll(/id:\s*"([a-z0-9-]+)"/gi)].map((m) => m[1]);
console.log(`信源 id 数量: ${srcIds.length}`);

// 中文是否被转义
console.log(`\n中文字面量（计算机）: ${s.includes('计算机')}`);
console.log(`转义形式 \\u8BA1\\u7B97: ${s.includes('\\u8BA1\\u7B97')}`);
const m = s.match(/[\s\S]{0,50}\\u8BA1\\u7B97[\s\S]{0,90}/);
if (m) console.log(`样例: ${JSON.stringify(m[0])}`);
