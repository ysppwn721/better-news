/**
 * 截止时间识别：从通知正文里找出「截止/截至 … 日期」这类硬性时间要求。
 *
 * 为什么单独成模块：服务端（生成 /api/deadlines）与静态导出器都要用，
 * 抽出来可以避免导出脚本被迫加载 express / node-cron。
 */

const DATE_IN_TEXT =
  /(20\d{2}\s*[年\-/.]\s*\d{1,2}\s*[月\-/.]\s*\d{1,2}\s*日?|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/;

/**
 * 从一段文本中提取截止时间线索
 * @param {string} text
 * @returns {Array<{date: string, hint: string}>} date 为 YYYY-MM-DD
 */
export function extractDeadlines(text) {
  const out = [];
  if (!text) return out;
  const re = new RegExp(
    `(截止|截至|不迟于|务必于|逾期不[予再]|最后期限|报送时间|提交时间)[^。；\\n]{0,40}?${DATE_IN_TEXT.source}`,
    'g',
  );
  const year = new Date().getFullYear();
  let m;
  while ((m = re.exec(text))) {
    const iso = toIso(m[2], year);
    if (!iso) continue;
    const hint = text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 10)
      .replace(/\s+/g, ' ').trim();
    if (!out.some((x) => x.date === iso)) out.push({ date: iso, hint: hint.slice(0, 90) });
  }
  return out;
}

function toIso(raw, fallbackYear) {
  let mm = raw.match(/(20\d{2})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})/);
  if (mm) return `${mm[1]}-${pad(mm[2])}-${pad(mm[3])}`;
  mm = raw.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (mm) return `${fallbackYear}-${pad(mm[1])}-${pad(mm[2])}`;
  return null;
}

const pad = (n) => String(Number(n)).padStart(2, '0');

/** 距离截止日还有几天（当天算 0，已过为负） */
export function daysUntil(isoDate) {
  const target = new Date(`${isoDate}T23:59:59+08:00`);
  return Math.ceil((target - Date.now()) / 86400000);
}

/** 把「剩 N 天」渲染成易读文案 */
export function daysLeftText(days) {
  if (days < 0) return '已截止';
  if (days === 0) return '今天截止';
  if (days === 1) return '明天截止';
  return `剩 ${days} 天`;
}
