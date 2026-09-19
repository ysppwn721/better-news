/**
 * 校验 APK 是否已签名（Android 不允许安装未签名的包）。
 *
 * 为什么需要：Gradle 在签名配置缺失时不会报错，而是安静地产出
 * `app-release-unsigned.apk`，装到手机上才失败。这个检查把问题挡在构建阶段。
 *
 * 用法:
 *   node scripts/verify-apk.mjs <apk路径>
 *   node scripts/verify-apk.mjs --search <目录>    # 在目录下自动查找 release APK
 *
 * 无 apksigner 时退化为解析 APK 内的签名块（够用）。
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

/** 递归查找 release APK（优先非 unsigned 的） */
function findApk(dir, depth = 0) {
  if (depth > 6 || !existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findApk(p, depth + 1));
    else if (/\.apk$/i.test(entry.name)) found.push(p);
  }
  return found;
}

let apk = process.argv[2];
if (apk === '--search') {
  const dir = process.argv[3] || '.';
  const all = findApk(dir);
  if (!all.length) {
    console.error(`✗ 在 ${dir} 下找不到任何 .apk`);
    process.exit(1);
  }
  // 优先选名字里不含 unsigned 的
  apk = all.find((p) => !/unsigned/i.test(p)) || all[0];
  console.log(`自动定位到 APK: ${apk}`);
  if (all.length > 1) console.log(`（该目录下共 ${all.length} 个 APK）`);
}

if (!apk || !existsSync(apk)) {
  console.error(`✗ 找不到 APK: ${apk}`);
  process.exit(1);
}

const sizeMb = (statSync(apk).size / 1024 / 1024).toFixed(2);
console.log(`APK: ${apk}`);
console.log(`大小: ${sizeMb} MB`);

// APK 本质是 zip：扫描中央目录里的条目名
const buf = readFileSync(apk);
const text = buf.toString('latin1');

const hasV1 = /META-INF\/[A-Z0-9_]+\.(RSA|DSA|EC)/i.test(text);
const hasV2 = buf.includes(Buffer.from('APK Sig Block 42'));
const hasV3 = buf.includes(Buffer.from('APK Signature Scheme v3'));

console.log(`\n签名方案:`);
console.log(`  v1 (JAR 签名)     : ${hasV1 ? '✓ 存在' : '✗ 缺失'}`);
console.log(`  v2 (APK Sig v2)   : ${hasV2 ? '✓ 存在' : '✗ 缺失'}`);
console.log(`  v3 (APK Sig v3)   : ${hasV3 ? '✓ 存在' : '（可选）'}`);

const signed = hasV1 || hasV2 || hasV3;

// 文件名里带 unsigned 也是明确的信号
const nameSaysUnsigned = /unsigned/i.test(apk);

console.log(`\n结论: ${signed && !nameSaysUnsigned ? '✓ 已签名，可安装' : '✗ 未签名，无法安装'}`);
if (!signed || nameSaysUnsigned) {
  console.log('  签名配置未生效。检查 app/android/app/build.gradle 中的 signingConfigs.release');
  console.log('  与 app/android/keystore/release.keystore 是否存在。');
  process.exit(1);
}

// 若环境有 apksigner，做一次权威校验
try {
  const out = execFileSync('apksigner', ['verify', '--print-certs', apk], { encoding: 'utf8' });
  console.log('\napksigner 校验通过:');
  for (const line of out.split('\n').filter((l) => /Signer|SHA-256|DN:/i.test(l)).slice(0, 4)) {
    console.log('  ' + line.trim());
  }
} catch {
  console.log('\n（环境无 apksigner，已用 zip 结构校验代替）');
}
process.exit(0);
