/**
 * 条码解析：支持纯序列号/批号、GS1 人工可读格式“(01)…(11)…(10)批号(21)序列号”，
 * 以及 DataMatrix 扫描头输出的 GS1 原始串（以 ]d2 开头、用 GS 字符 \x1d 分隔、无括号）。
 */
export interface ScanResult {
  raw: string;
  /** 主值：有 (21) 序列号时为序列号，否则为原始码 */
  code: string;
  gtin?: string;
  lot?: string;
  sn?: string;
  mfg?: string;
  exp?: string;
}

const FIXED: Record<string, number> = { '00': 18, '01': 14, '02': 14, '11': 6, '13': 6, '15': 6, '17': 6 };

function parseGs1Raw(s: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    const ai = s.slice(i, i + 2);
    if (!/^\d\d$/.test(ai)) return null;
    i += 2;
    if (FIXED[ai]) {
      out[ai] = s.slice(i, i + FIXED[ai]);
      i += FIXED[ai];
    } else if (ai === '10' || ai === '21') {
      const end = s.indexOf('\x1d', i);
      out[ai] = s.slice(i, end < 0 ? undefined : end);
      i = end < 0 ? s.length : end + 1;
    } else {
      return null; // 不认识的 AI：按普通条码处理
    }
    if (s[i] === '\x1d') i += 1;
  }
  return out['01'] ? out : null;
}

export function parseScan(input: string): ScanResult {
  const raw = (input ?? '').replace(/[\r\n]+$/, '');
  let s = raw.trim();
  // 人工可读格式 (01)…(21)…
  if (s.startsWith('(')) {
    const parts: Record<string, string> = {};
    for (const m of s.matchAll(/\((\d{2,4})\)([^(]*)/g)) parts[m[1]] = m[2].trim();
    if (parts['01'] || parts['21'] || parts['10']) {
      return { raw, code: parts['21'] || parts['10'] || s, gtin: parts['01'], lot: parts['10'], sn: parts['21'], mfg: parts['11'], exp: parts['17'] };
    }
  }
  // GS1 原始串：去掉符号标识 ]d2 / ]C1 等
  s = s.replace(/^\][A-Za-z]\d/, '');
  if (/^01\d{14}/.test(s)) {
    const p = parseGs1Raw(s);
    if (p) return { raw, code: p['21'] || p['10'] || s, gtin: p['01'], lot: p['10'], sn: p['21'], mfg: p['11'], exp: p['17'] };
  }
  return { raw, code: s };
}
