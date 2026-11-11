import { BizError } from './errors';
import { config } from '../config';

/** 工厂本地时区的日期字符串 YYYY-MM-DD */
export function localDateStr(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** 纯日期（@db.Date）统一用 UTC 零点的 Date 表示 */
export function dateOnly(s: string | Date | null | undefined): Date | null {
  if (s === null || s === undefined || s === '') return null;
  if (s instanceof Date) return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()));
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(s).trim().replace(/\//g, '-'));
  if (!m) throw new BizError(`日期格式错误：${s}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) throw new BizError(`日期不存在：${s}`);
  return d;
}

/** 今天（工厂时区）的纯日期 */
export const today = (): Date => dateOnly(localDateStr())!;

export const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86400000);

export const fmtDate = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

/** yyMMdd（工厂时区），用于单据号、批号、序列号 */
export const yymmdd = (d: Date = new Date()): string => localDateStr(d).slice(2).replace(/-/g, '');

export const daysBetween = (a: Date, b: Date): number => Math.round((a.getTime() - b.getTime()) / 86400000);

/** 纯日期字段名（序列化为 YYYY-MM-DD，其余 Date 输出 ISO 时间） */
export const DATE_FIELDS = new Set([
  'order_date', 'delivery_date', 'expected_date', 'effective_date', 'qualification_expiry', 'quality_agreement_expiry',
  'last_calibration_date', 'next_calibration_date', 'calibration_date', 'next_due_date', 'mfg_date', 'expiry_date',
  'receipt_date', 'ship_date', 'doc_date', 'due_date', 'pay_date', 'planned_start', 'planned_end',
]);
