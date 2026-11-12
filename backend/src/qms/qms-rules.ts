/**
 * 质量规则（无依赖的纯函数，供 presenter 与各服务共用）：
 *   NCR 处置期限（按严重度）、超期判断；检验项目逐件值解析与不良件数。
 */
import { addDays, dateOnly, fmtDate, localDateStr, today } from '../common/dates';
import { EPS } from '../common/num';

/** NCR 处置期限（自开具日起的天数，按严重度）：致命 3 天、严重 7 天、轻微 14 天 */
export const NCR_DUE_DAYS: Record<string, number> = { CRITICAL: 3, MAJOR: 7, MINOR: 14 };
export const dueDays = (severity: string | null | undefined) => NCR_DUE_DAYS[severity || 'MAJOR'] ?? 7;

/** 新开 NCR 的处置期限（其他模块开具 NCR 时也可调用：due_date: ncrDueDate(severity)） */
export const ncrDueDate = (severity: string | null | undefined, from: Date = today()) => addDays(from, dueDays(severity));

/** NCR 的有效处置期限：已设定的期限；未设定（如工位自动开具）按开具日 + 严重度天数 */
export function effectiveDue(n: { due_date?: Date | null; created_at?: Date | null; severity?: string | null }): Date {
  if (n.due_date) return dateOnly(n.due_date)!;
  return addDays(dateOnly(localDateStr(n.created_at ?? new Date()))!, dueDays(n.severity));
}

/** NCR 计算字段：due_on（有效期限）、days_left（剩余天数，负数=超期）、overdue（待处置且已超期） */
export function ncrDueView(n: { due_date?: Date | null; created_at?: Date | null; severity?: string | null; status?: string | null }) {
  const due = effectiveDue(n);
  const left = Math.round((due.getTime() - today().getTime()) / 86400000);
  return { due_on: fmtDate(due), days_left: n.status === 'OPEN' ? left : null, overdue: n.status === 'OPEN' && left < 0 };
}

/** 超期 NCR 的查询条件（待处置且有效期限早于今天） */
export function overdueWhere(t: Date = today()) {
  const created = (sev: unknown, n: number) => ({ due_date: null, severity: sev, created_at: { lt: addDays(t, -n) } });
  return {
    status: 'OPEN',
    OR: [
      { due_date: { lt: t } },
      created('CRITICAL', NCR_DUE_DAYS.CRITICAL),
      created('MINOR', NCR_DUE_DAYS.MINOR),
      created({ notIn: ['CRITICAL', 'MINOR'] }, NCR_DUE_DAYS.MAJOR),
    ],
  };
}

interface ItemLike { item_type?: string | null; sample_values?: string | null; lower?: number | null; upper?: number | null; result?: string | null }

export const outOf = (x: number, lo: number | null | undefined, up: number | null | undefined) =>
  (lo !== null && lo !== undefined && x < lo - EPS) || (up !== null && up !== undefined && x > up + EPS);

/** 解析检验项目逐件值：定量项为数字数组；定性项为 {defects: n}（该项不良件数） */
export function parseSamples(it: ItemLike): { values: number[]; defects: number | null } {
  if (!it.sample_values) return { values: [], defects: null };
  try {
    const v = JSON.parse(it.sample_values);
    if (Array.isArray(v)) return { values: v.filter((x) => typeof x === 'number' && Number.isFinite(x)), defects: null };
    if (v && typeof v === 'object' && Number.isFinite(Number(v.defects))) return { values: [], defects: Number(v.defects) };
  } catch {
    /* 非 JSON：忽略 */
  }
  return { values: [], defects: null };
}

/** 检验项目的不良件数：定量项 = 超限件数；定性项 = 录入的不良数 */
export function itemDefects(it: ItemLike): number {
  const s = parseSamples(it);
  if (it.item_type === 'QUANT') return s.values.filter((x) => outOf(x, it.lower, it.upper)).length;
  return it.result === 'FAIL' ? s.defects ?? 0 : 0;
}
