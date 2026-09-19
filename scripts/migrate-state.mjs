// 批量迁移：stateStore 的调用从「传 id」改为「传条目对象」
// 背景：已读/收藏的键从数据库 id 改为 URL 哈希，调用方需传整个条目
import { readFileSync, writeFileSync } from 'node:fs';

const path = 'public/app.js';
let s = readFileSync(path, 'utf8');
const before = s;

const replacements = [
  [/stateStore\.isRead\((\w+)\.id\)/g, 'stateStore.isRead($1)'],
  [/stateStore\.isStarred\((\w+)\.id\)/g, 'stateStore.isStarred($1)'],
  [/stateStore\.setRead\((\w+)\.id,\s*/g, 'stateStore.setRead($1, '],
  [/stateStore\.setStarred\((\w+)\.id,\s*/g, 'stateStore.setStarred($1, '],
  // markAllRead 现在接收条目数组
  [/stateStore\.markAllRead\(list\.map\(\(i\) => i\.id\)\)/g, 'stateStore.markAllRead(list)'],
  // 清除已读改用封装方法（它会清理 localStorage 键）
  [/stateStore\.readIds\.clear\(\);\s*\n\s*local\.set\('readIds', \[\]\);/g, 'stateStore.clearRead();'],
];

for (const [re, to] of replacements) s = s.replace(re, to);

writeFileSync(path, s, 'utf8');

console.log('已迁移:', s !== before ? '是' : '否（无匹配）');
console.log('\n剩余仍传 .id 的调用点（应为空）:');
const left = [...s.matchAll(/stateStore\.(isRead|isStarred|setRead|setStarred)\([^)]*\.id/g)];
console.log(left.length ? left.map((m) => `  ${m[0]}`).join('\n') : '  （无）');
