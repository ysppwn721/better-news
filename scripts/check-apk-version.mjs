/**
 * 校验 APK 内 app.js 是否包含最新的关键实现。
 * 用于确认「用户装的 APK 是否已包含修复」。
 * 用法: node scripts/check-apk-version.mjs <apk路径>
 */
import { existsSync, readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const apk = process.argv[2];
if (!apk || !existsSync(apk)) { console.error(`✗ 找不到 ${apk}`); process.exit(1); }

const buf = readFileSync(apk);

function extractAsset(assetName) {
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] !== 0x50 || buf[i + 1] !== 0x4b || buf[i + 2] !== 0x01 || buf[i + 3] !== 0x04) {
      // 中央目录
      if (buf[i] !== 0x50 || buf[i + 1] !== 0x4b || buf[i + 2] !== 0x01 || buf[i + 3] !== 0x02) continue;
    }
    const method = buf.readUInt16LE(i + 10);
    const compSize = buf.readUInt32LE(i + 20);
    const nameLen = buf.readUInt16LE(i + 28);
    const extraLen = buf.readUInt16LE(i + 30);
    const commentLen = buf.readUInt16LE(i + 32);
    const localOffset = buf.readUInt32LE(i + 42);
    if (nameLen <= 0 || nameLen > 400) continue;
    const name = buf.subarray(i + 46, i + 46 + nameLen).toString('utf8');
    if (name === assetName) {
      const lo = localOffset;
      const ln = buf.readUInt16LE(lo + 26);
      const ex = buf.readUInt16LE(lo + 28);
      const start = lo + 30 + ln + ex;
      const raw = buf.subarray(start, start + compSize);
      return method === 8 ? inflateRawSync(raw).toString('utf8') : raw.toString('utf8');
    }
    i += 45 + nameLen + extraLen + commentLen;
  }
  return null;
}

const appJs = extractAsset('assets/public/app.js');
if (!appJs) { console.error('✗ 包内找不到 assets/public/app.js'); process.exit(1); }
const indexHtml = extractAsset('assets/public/index.html') || '';
const appStore = extractAsset('assets/public/app-store.mjs') || '';
// 信源清单打进 shared.mjs（app-store 只做数据层，名字来自外部注入），
// 因此「学院栏目是否扩充」必须查 shared.mjs，查 app-store 会永远找不到。
const shared = extractAsset('assets/public/shared.mjs') || '';
// 关注/关键词/日程导出模块单独一个文件，app.js 用 import 引它
const watchSrc = extractAsset('assets/public/watch.mjs') || '';

// 版本号：AndroidManifest.xml 是二进制 XML，字符串存在字符串池里，
// 编码可能是 UTF-16LE 或 UTF-8。两种都找一遍，无需 aapt 即可确认包的版本。
const versionName = process.env.BN_EXPECT_VERSION || '1.5';
const encodings = {
  'UTF-16LE': Buffer.from([...versionName].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8])),
  UTF8: Buffer.from(versionName, 'utf8'),
};
const foundAs = Object.entries(encodings).find(([, needle]) => buf.indexOf(needle) !== -1)?.[0] || null;

console.log('=== APK 内关键实现检查 ===');
console.log(`  app.js       ${(appJs.length / 1024).toFixed(0)} KB`);
console.log(`  app-store.mjs ${(appStore.length / 1024).toFixed(0)} KB`);
console.log(`  index.html   ${(indexHtml.length / 1024).toFixed(0)} KB`);
console.log(`  versionName  ${foundAs ? `✓ 含 "${versionName}"（${foundAs}）` : `✗ 未找到 "${versionName}"`}`);
if (!foundAs) console.log('（若确认已升版本，用 BN_EXPECT_VERSION=x.y 覆盖期望值）');

const checks = [
  ['置顶聚合 prioritySourceIds', /prioritySourceIds/, appJs],
  ['resetView 清空 filters', /function resetView[\s\S]{0,400}?filters\.clear\(\)/, appJs],
  // 搜索已从「terms.every + title.includes」升级为别名感知的 titleMatches()
  // （标题写「综合素质测评」，学生搜「综测」）。旧断言会误判新版为「缺失」。
  ['纯标题搜索 + 别名（titleMatches）', /titleMatches\(item\.title,\s*q\)/, appJs],
  ['别名表已随包发布（aliases.mjs）', /SEARCH_ALIASES|ALIAS_MAP/, extractAsset('assets/public/aliases.mjs') || appJs],
  ['搜索不再用摘要兜底', /const excerpt = \(item\.excerpt/, appJs, true],
  ['抓取完成通知界面（onChange 回调）', /onChange/, appStore],
  ['抓取进度提示', /正在抓取最新通知|正在更新/, appJs],
  ['刷新按钮图标为元素（只转图标）', /class="btn-icon"/, indexHtml],
  // 抓取引擎侧：翻页按「下页」链接、正文非空才覆盖、失败重试
  ['翻页读「下页」链接（collectListPages）', /collectListPages|nextPageUrl/, appStore],
  ['正文非空才覆盖（不清空已有正文）', /bodyText:\s*item\.bodyText\s*\|\|\s*existing\.bodyText/, appStore],
  ['抓取失败重试', /attempts/, appStore],
  // v1.3：「看着一直在抓取」的两处修复
  ['分批入库后通知界面（onBatch）', /onBatch/, appStore],
  ['后台补正文单独标记（background）', /background:\s*background|runtime\.background/, appStore],
  ['界面区分「后台补正文」阶段', /st\?\.background/, appJs],
  // v1.4：学院专栏抓全 + 详情兜底
  //
  // ⚠ 这里必须断言 **URL 路径** 而不是栏目中文名：
  //   esbuild 会把内嵌 JSON 里的中文转成 \uXXXX 转义（`团学动态` → `\u56E2\u5B66...`），
  //   所以按中文字面量搜永远搜不到，会误判成「未包含」。URL 路径不会被转义。
  ['学院栏目已扩充（团学动态 xsgz/txdt）', /xsgz\/txdt/, shared],
  ['学院栏目已扩充（教育管理 yjspy/jygl）', /yjspy\/jygl/, shared],
  ['学院栏目已扩充（学位管理 yjspy/xwgl）', /yjspy\/xwgl/, shared],
  ['学院栏目已扩充（招生信息 zsxx.htm）', /zsxx\.htm/, shared],
  ['学院栏目已扩充（工会工作 dqgz/ghgz）', /dqgz\/ghgz/, shared],
  ['学院栏目 id 至少到 col-cst-15', /col-cst-15/, shared],
  ['详情「未抓取到正文」兜底块', /nocontent-box/, appJs],
  ['兜底块提供原文按钮', /查看官网原文|\\u67E5\\u770B\\u5B98\\u7F51\\u539F\\u6587/, appJs],
  // v1.5：我的关注 / 关键词提醒 / 日程导出 / 刷新按钮不再一直转
  ['关注模块已随包发布（watch.mjs）', /loadWatched|resolveWatchList/, watchSrc],
  ['关注清单 localStorage 键', /['"]watched['"]/, watchSrc],
  ['关键词关注', /watchKeywords|addKeyword/, watchSrc],
  ['ICS 日程导出', /BEGIN:VCALENDAR/, watchSrc],
  ['日历待办闹钟（VALARM）', /BEGIN:VALARM/, watchSrc],
  ['卡片上的关注按钮', /watch-btn/, appJs],
  ['关注面板入口（底栏 watch）', /data-target="watch"|btnWatch/, indexHtml],
  ['刷新按钮状态单一来源（修 bug）', /syncFetchButton/, appJs],
  ['不再把「已在抓取中」当错误弹提示', /已在抓取中，稍候即可/, appJs],
  // 防回归：spin 类**只能**由 syncFetchButton 用 toggle('spin', 状态) 设置。
  //
  // 真正要抓的缺陷签名是「不带状态参数」的写法：
  //     classList.add('spin')        ← 旧代码：点击处理自己加
  //     classList.remove('spin')     ← 旧代码：updateSubtitle 自己清
  // 正确写法一定带第二参数：classList.toggle('spin', spinning)。
  //
  // 所以正则写成 `add|remove` + 左括号后**紧跟 sp|'spin'**：
  //   · 注释里作为反例写的 `btn.classList.add('spin')` 同样会被抓到——
  //     这是刻意的，正文里不该再出现这种写法（已改成「直接加 spin」）；
  //   · 但 `classList.toggle('spin', ...)` 不会被误伤。
  // 第一版曾用 /toggle\('spin'/ 计数断言，结果把两个按钮的合法调用都算进去，
  // 把已修好的包判成没修——这类「断言写错」比漏测更费时间。
  ['spin 类不再被手动 add/remove', /classList\.(?:add|remove)\((?:sp|'spin')/, appJs, true],
  ['刷新按钮由 toggle(状态) 驱动', /classList\.toggle\('spin',\s*spinning\)/, appJs],
  ['「检查更新」按钮同样由状态驱动', /classList\.toggle\('spin',\s*!!refreshingSnapshot\)/, appJs],
];

let stale = 0;
for (const [label, re, target, shouldBeAbsent, expectCount] of checks) {
  const all = target.match(re) || [];
  let ok;
  let extra = '';
  if (expectCount != null) {
    ok = all.length === expectCount;
    extra = `（出现 ${all.length} 次，应为 ${expectCount} 次）`;
  } else {
    const present = all.length > 0;
    ok = shouldBeAbsent ? !present : present;
  }
  if (!ok) stale++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra}${shouldBeAbsent ? '（应为不存在）' : ''}`);
}

// 提取 search 函数片段，人工核对
const si = appJs.indexOf('function matchScore');
if (si >= 0) {
  console.log('\n=== 包内 matchScore 实现 ===');
  console.log(appJs.slice(si, si + 420).split('\n').map((l) => '  ' + l).join('\n'));
}

console.log(`\n结论: ${stale === 0 ? '✓ 已包含全部最新修复' : `✗ 有 ${stale} 项缺失（APK 是旧版或构建未同步）`}`);
process.exit(stale === 0 ? 0 : 1);
