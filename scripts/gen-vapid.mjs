/**
 * 生成 Web Push 所需的 VAPID 密钥对（P-256 椭圆曲线）。
 *
 * 手工生成而不装 web-push：只需一个密钥对 + base64url 编码，
 * 用 Node 内置 crypto 即可，无需为一次性操作引入依赖。
 *
 * 用法：
 *   node scripts/gen-vapid.mjs
 *   node scripts/gen-vapid.mjs --json     # 输出便于粘贴的 JSON
 */

import { generateKeyPairSync, createPublicKey } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1', // NIST P-256，Web Push 规定的曲线
});

// 私钥：取 JWK 的 d 分量
const privJwk = privateKey.export({ format: 'jwk' });
// 公钥：未压缩点格式 0x04 || X(32) || Y(32) —— 浏览器 applicationServerKey 要求这种编码
const pubJwk = publicKey.export({ format: 'jwk' });
const raw = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(pubJwk.x, 'base64url'),
  Buffer.from(pubJwk.y, 'base64url'),
]);

const vapid = {
  publicKey: b64url(raw),
  privateKey: privJwk.d,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(vapid, null, 2));
} else {
  console.log('VAPID 密钥对已生成。请妥善保存私钥，不要提交到仓库。\n');
  console.log('VAPID_PUBLIC_KEY :', vapid.publicKey);
  console.log('VAPID_PRIVATE_KEY:', vapid.privateKey);
  console.log('\n写入 Cloudflare Worker（在 worker/ 目录执行）：');
  console.log(`  npx wrangler secret put VAPID_PUBLIC_KEY`);
  console.log(`  npx wrangler secret put VAPID_PRIVATE_KEY`);
  console.log(`  npx wrangler secret put VAPID_SUBJECT      # 填 mailto:你的邮箱`);
  console.log('\n本地测试用（可选，写入 .env 或直接 export）：');
  console.log(`  export VAPID_PUBLIC_KEY="${vapid.publicKey}"`);
  console.log(`  export VAPID_PRIVATE_KEY="${vapid.privateKey}"`);
}

// 自检：确认生成的公开点能被解析回来（防止编码错误导致浏览器订阅失败）
try {
  const keyObj = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: pubJwk.x, y: pubJwk.y },
    format: 'jwk',
  });
  if (!keyObj) throw new Error('公钥解析失败');
} catch (e) {
  console.error('\n⚠ 公钥自检失败:', e.message);
  process.exit(1);
}
