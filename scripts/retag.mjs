// 规则迭代后的本地重打标：把新规则应用到已入库条目，输出前后对比
import { Store } from '../src/store/db.mjs';
import { analyze } from '../src/core/keywords.mjs';

const dry = process.argv.includes('--dry');
const store = new Store();
const res = store.retagAll(analyze, { dryRun: dry });
console.log(`${dry ? '[试运行] ' : ''}共 ${res.total} 条，${res.changed} 条标签发生变化\n`);
for (const s of res.samples) {
  console.log(`  ${s.title.slice(0, 40)}`);
  console.log(`    改前: ${s.before.join(' ') || '(无)'}`);
  console.log(`    改后: ${s.after.join(' ') || '(无)'}`);
}
store.close();
