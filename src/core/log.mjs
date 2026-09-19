/** 极简分级日志：抓取任务量大，默认只出 info，调试用 DEBUG=1 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const current = LEVELS[(process.env.LOG_LEVEL || '').toLowerCase()] ?? (process.env.DEBUG ? 10 : 20);

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

function emit(level, args) {
  if (LEVELS[level] < current) return;
  const tag = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[level];
  const line = `[${stamp()}] ${tag} `;
  if (level === 'error') console.error(line, ...args);
  else if (level === 'warn') console.warn(line, ...args);
  else console.log(line, ...args);
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
};
