/**
 * 校验「spin 断言」本身是否正确 —— 断言写错比漏测更费时间。
 *
 * 对同一份代码给出两种期望：
 *   · 已修好的版本（flip 之后）：不应命中缺陷签名，且两个 toggle 都在
 *   · 故意退回旧写法：必须命中缺陷签名
 *
 * 用法: node scripts/test-spin-guard.mjs
 */
import { readFileSync } from 'node:fs';

const BUG = /classList\.(?:add|remove)\((?:sp|'spin')/;
const OK1 = /classList\.toggle\('spin',\s*spinning\)/;
const OK2 = /classList\.toggle\('spin',\s*!!refreshingSnapshot\)/;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  ok ? pass++ : fail++;
};

console.log('=== 当前源码（已修）===');
const src = readFileSync('public/app.js', 'utf8');
check('不含缺陷签名（手动 add/remove spin）', !BUG.test(src),
  BUG.test(src) ? `命中: ${(src.match(BUG) || [])[0]}` : '');
check('刷新按钮由 toggle(状态) 驱动', OK1.test(src));
check('「检查更新」按钮由状态驱动', OK2.test(src));

console.log('\n=== 反向：把旧写法塞回去，断言必须报错 ===');
// 旧代码是两处：点击处理自己加/清 → updateSubtitle 也加/清
const legacy = src
  .replace(/if \(btn\) btn\.classList\.toggle\('spin', spinning\);/, "if (spinning) btn.classList.add('spin');")
  + "\n// legacy\nbtn.classList.remove('spin');\n";
check('旧写法被识别为缺陷', BUG.test(legacy), `命中: ${(legacy.match(BUG) || [])[0]}`);
check('旧写法下 toggle(状态) 断言失败', !OK1.test(legacy));

console.log('\n=== 反向：注释里的反例写法也应被抓到（刻意的）===');
const withComment = src.replace('直接加 spin', "btn.classList.add('spin')");
check('正文出现 add(\'spin\') 即判为缺陷', BUG.test(withComment));

console.log(`\n结果: ${pass} 项通过, ${fail} 项失败`);
process.exit(fail ? 1 : 0);
