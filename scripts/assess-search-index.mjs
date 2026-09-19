// 评估把正文纳入搜索索引的可行性
import { Store } from '../src/store/db.mjs';

const store = new Store();
const total = store.db.prepare('SELECT COUNT(*) AS c FROM items').get().c;
const withBody = store.db.prepare("SELECT COUNT(*) AS c FROM items WHERE length(COALESCE(body_text,'')) > 100").get().c;
const avgRow = store.db.prepare("SELECT AVG(length(COALESCE(body_text,''))) AS a FROM items WHERE length(COALESCE(body_text,'')) > 100").get();
const maxRow = store.db.prepare("SELECT MAX(length(COALESCE(body_text,''))) AS m FROM items").get();
const sumRow = store.db.prepare("SELECT SUM(length(COALESCE(body_text,''))) AS s FROM items").get();

console.log('=== 正文可用性 ===');
console.log(`  条目总数: ${total}`);
console.log(`  有正文(>100字): ${withBody}（${Math.round(withBody / total * 100)}%）`);
console.log(`  平均正文长度: ${Math.round(avgRow.a || 0)} 字`);
console.log(`  最长正文: ${maxRow.m} 字`);
console.log(`  正文总字符数: ${sumRow.s}（约 ${(sumRow.s / 1024).toFixed(0)} KB）`);

console.log('\n=== 「困难认定」在正文中的出现情况 ===');
const hard = store.db.prepare("SELECT COUNT(*) AS c FROM items WHERE body_text LIKE '%困难%' AND body_text LIKE '%认定%'").get().c;
const exact = store.db.prepare("SELECT COUNT(*) AS c FROM items WHERE body_text LIKE '%困难认定%'").get().c;
console.log(`  正文同时含「困难」和「认定」: ${hard} 条`);
console.log(`  正文含连续「困难认定」: ${exact} 条`);

console.log('\n=== 若把正文纳入搜索，索引体积估算 ===');
for (const cap of [500, 1000, 1500, 2000]) {
  const bytes = store.db.prepare(
    `SELECT SUM(length(substr(COALESCE(body_text,''), 1, ${cap}))) AS s FROM items`,
  ).get().s || 0;
  console.log(`  每篇截取 ${String(cap).padStart(4)} 字 → 索引约 ${(bytes / 1024 / 1024).toFixed(2)} MB`);
}

store.close();
