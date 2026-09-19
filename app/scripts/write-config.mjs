// 重新生成 capacitor.config.json（确保 UTF-8 正确，中文应用名不乱码）
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(APP, 'capacitor.config.json');

const config = {
  appId: 'cn.edu.nuc.betternews',
  appName: '中北通知',
  webDir: 'www',
  android: {
    allowMixedContent: true,
    webContentsDebuggingEnabled: false,
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    // 关键：开启后 http(s) 请求走原生网络栈，绕过 CORS。
    // 学校站点不返回 Access-Control-Allow-Origin，WebView 里的 fetch 会被拦截，
    // 必须靠原生层发起请求。
    CapacitorHttp: { enabled: true },
    SplashScreen: {
      launchShowDuration: 800,
      backgroundColor: '#1a56c4',
      showSpinner: false,
    },
  },
};

writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf8');

// 自检：读回来确认中文正常
const back = JSON.parse(readFileSync(path, 'utf8'));
console.log(`已写入 capacitor.config.json`);
console.log(`  appName: ${back.appName}`);
console.log(`  中文是否正常: ${back.appName === '中北通知' ? '✓' : '✗ 仍乱码'}`);
console.log(`  CapacitorHttp: ${back.plugins.CapacitorHttp.enabled ? '已开启（CORS 绕过生效）' : '未开启'}`);
