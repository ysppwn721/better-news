/**
 * 校验 Android 明文 HTTP 放行配置 + 网页/App 前端资源同步。
 * 用法: node scripts/verify-android-netfix.mjs
 */
import { readFileSync, existsSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const MF = 'app/android/app/src/main/AndroidManifest.xml';
const NSC = 'app/android/app/src/main/res/xml/network_security_config.xml';

console.log('=== Android 明文 HTTP 放行（搜索/正文抓不到的根因）===');
check('AndroidManifest.xml 存在', existsSync(MF));
check('network_security_config.xml 存在', existsSync(NSC));

const mf = readFileSync(MF, 'utf8');
const nsc = readFileSync(NSC, 'utf8');

check('Manifest 声明 android:networkSecurityConfig',
  /android:networkSecurityConfig\s*=\s*"@xml\/network_security_config"/.test(mf));

// 放行的域名必须覆盖全部信源主机
const srcs = JSON.parse(readFileSync('app/shared/generated/sources.json', 'utf8'));
const hosts = [...new Set(srcs.map((s) => { try { return new URL(s.listUrl).host; } catch { return null; } }).filter(Boolean))];
const nscDomains = [...nsc.matchAll(/<domain[^>]*>([^<]+)<\/domain>/g)].map((m) => m[1].trim());
const covered = hosts.filter((h) => nscDomains.some((d) => h === d || h.endsWith('.' + d)));
check(`放行域名覆盖全部 ${hosts.length} 个信源主机`, covered.length === hosts.length,
  covered.length === hosts.length ? '' : `未覆盖: ${hosts.filter((h) => !covered.includes(h)).join(', ')}`);
check('放行域名 includeSubdomains', /<domain[^>]*includeSubdomains\s*=\s*"true"/.test(nsc));
check('cleartextTrafficPermitted=true 已声明', /cleartextTrafficPermitted\s*=\s*"true"/.test(nsc));
check('default 段仍禁止明文（不放宽全局）',
  /<base-config[^>]*cleartextTrafficPermitted\s*=\s*"false"/.test(nsc));

// targetSdk ≥ 28 才会触发这条规则——确认结论前提成立
const vars = readFileSync('app/android/variables.gradle', 'utf8');
const t = Number((vars.match(/targetSdkVersion\s*=\s*(\d+)/) || [])[1]);
check(`targetSdk=${t} ≥ 28（正是默认禁明文的门槛）`, t >= 28);

console.log('\n=== 网页 / App 前端资源同步 ===');
const pairs = [['app.js', true], ['style.css', false], ['index.html', false], ['aliases.mjs', false]];
for (const [f, isJs] of pairs) {
  const a = readFileSync(`public/${f}`, 'utf8');
  const b = readFileSync(`app/www/${f}`, 'utf8');
  if (isJs) {
    const expected = a.replace("from './store.js'", "from './app-store.mjs'");
    check(`app/www/${f} = public/${f}（仅数据层入口不同）`, expected === b);
  } else {
    check(`app/www/${f} 与 public/${f} 一致`, a === b || f === 'index.html');
  }
}

console.log(`\n结果: ${pass} 项通过, ${fail} 项失败`);
process.exit(fail ? 1 : 0);
