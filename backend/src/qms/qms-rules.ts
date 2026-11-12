/**
 * 质量规则（供 presenter 与各服务共用，只依赖 common 工具）：
 *   NCR 处置期限（按严重度）、超期判断；NCR 关闭条件检查与“可关闭 NCR”清单；检验项目逐件值解析与不良件数。
 *
 *   closableNcrIds(db)        已满足关闭条件（处置已执行完毕）、仍未关闭的 NCR id（QA 待办“可关闭的 NCR”、NCR 列表 ?closable=1）
 *   ncrCloseBlocker(tx, ncr)  不能关闭的原因（可关闭返回 null）
 */
import type { Ncr } from '@prisma/client';
import { addDays, dateOnly, fmtDate, localDateStr, today } from '../common/dates';
import { EPS, g } from '../common/num';
import type { Tx } from '../common/prisma.service';

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

interface ItemLike {
  item_type?: string | null; sample_values?: string | null; lower?: number | null; upper?: number | null; result?: string | null;
  /** 本项不良件数（正式字段；旧数据可能存于 sample_values 的 {"defects": n}） */
  defect_qty?: number | null;
}

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

/** 检验项目的不良件数：定量项 = 超限件数；定性项 = 录入的不良数（defect_qty 字段，旧数据兼容 sample_values） */
export function itemDefects(it: ItemLike): number {
  const s = parseSamples(it);
  if (it.item_type === 'QUANT') return s.values.filter((x) => outOf(x, it.lower, it.upper)).length;
  if (it.result !== 'FAIL') return 0;
  return it.defect_qty ? it.defect_qty : s.defects ?? 0;
}

// ---------------------------------------------------------------- NCR 关闭条件
/**
 * NCR 关闭前检查：返回不能关闭的原因（可关闭时返回 null）
 *   制程返工：该序列号须在不合格工序复测合格（批量报工：复测合格数量 ≥ NCR 数量）；
 *   来料挑选重检：重新检验单须已判定；来料退货：退供应商单须已出库；客户来源：关联客户退货单须已关闭。
 */
export async function ncrCloseBlocker(tx: Tx, ncr: Ncr): Promise<string | null> {
  if (ncr.status !== 'DISPOSITIONED') return ncr.status === 'OPEN' ? '尚未评审处置' : '已关闭';
  const after = ncr.disposition_at ?? ncr.created_at;
  if (ncr.source === 'PROCESS' && ncr.disposition === 'REWORK' && ncr.wo_id && ncr.op_seq !== null) {
    const op = `工序 ${ncr.op_seq}${ncr.op_name ? ` ${ncr.op_name}` : ''}`;
    if (ncr.sn) {
      const sn = await tx.serialNumber.findUnique({ where: { sn: ncr.sn } });
      if (!sn) return null;
      const ok = await tx.operationRecord.findFirst({ where: { sn_id: sn.id, seq: ncr.op_seq, result: 'PASS', ts: { gt: after } } });
      if (!ok) return `返工后尚未复测合格（序列号 ${ncr.sn} 需重新通过${op}）`;
    } else {
      const r = await tx.operationRecord.aggregate({ where: { wo_id: ncr.wo_id, sn_id: null, seq: ncr.op_seq, result: 'PASS', ts: { gt: after } }, _sum: { qty: true } });
      const done = r._sum.qty ?? 0;
      if (done + EPS < ncr.qty) return `返工数量 ${g(ncr.qty)} 尚未全部复测合格（${op}已复测合格 ${g(done)}）`;
    }
  }
  if (ncr.source === 'IQC' && ncr.disposition === 'REWORK' && ncr.material_id) {
    const re = await tx.inspection.findFirst({
      where: { material_id: ncr.material_id, lot_no: ncr.lot_no || '', id: { gt: ncr.inspection_id ?? 0 } }, orderBy: { id: 'desc' },
    });
    if (re && re.status === 'PENDING') return `挑选后重新检验尚未完成（检验单 ${re.no} 待检验）`;
  }
  if (ncr.disposition === 'RETURN') {
    const sr = await tx.supplierReturn.findFirst({ where: { ncr_id: ncr.id, status: { not: 'CANCELLED' } }, orderBy: { id: 'desc' } });
    if (sr && sr.status === 'PENDING') return `退供应商单 ${sr.no} 尚未出库（仓管出库确认后才能关闭）`;
  }
  if (ncr.source === 'CUSTOMER') {
    const rma = await tx.customerReturn.findFirst({ where: { ncr_id: ncr.id, status: { not: 'CLOSED' } } });
    if (rma) return `关联客户退货单 ${rma.no} 尚未关闭`;
  }
  return null;
}

/** 已满足关闭条件（处置已执行完毕）、仍未关闭的 NCR id（按 id 升序） */
export async function closableNcrIds(db: Tx): Promise<number[]> {
  const rows = await db.ncr.findMany({ where: { status: 'DISPOSITIONED' }, orderBy: { id: 'asc' } });
  const out: number[] = [];
  for (const n of rows) if (!(await ncrCloseBlocker(db, n))) out.push(n.id);
  return out;
}

/** 账号 → 姓名（列表显示“开具人/登记人”用姓名） */
export async function fullNames(db: Tx, usernames: (string | null | undefined)[]): Promise<Map<string, string>> {
  const list = [...new Set(usernames.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  const rows = await db.user.findMany({ where: { username: { in: list } }, select: { username: true, full_name: true } });
  return new Map(rows.map((u) => [u.username, u.full_name]));
}

/** CAPA 默认完成期限（天，按来源）：客诉/NCR 30 天、审核发现 60 天、其他 30 天 */
export const CAPA_DUE_DAYS: Record<string, number> = { COMPLAINT: 30, NCR: 30, AUDIT: 60, OTHER: 30 };
export const capaDueDate = (source: string | null | undefined, from: Date = today()) => addDays(from, CAPA_DUE_DAYS[source || 'NCR'] ?? 30);
