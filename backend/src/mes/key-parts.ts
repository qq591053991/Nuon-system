/**
 * 关键件 / 返工换件记录的统一输出（工位扫码履历、单台追溯、DHR 共用）。
 * action：BIND = 装配绑定；REMOVE = 返工拆下；INSTALL = 返工装上（自合格库存补领，流水 REWORK_ISSUE）。
 */
import type { Prisma } from '@prisma/client';
import type { Tx } from '../common/prisma.service';

export const KEY_PART_ACTION_TEXT: Record<string, string> = { BIND: '装配绑定', REMOVE: '返工拆下', INSTALL: '返工装上' };

export interface KeyPartRow {
  id: number;
  ts: Date;
  sn: string | null;
  action: string;
  action_text: string;
  material_id: number;
  material_code: string | null;
  material_name: string | null;
  lot_no: string | null;
  part_sn: string | null;
  operator: string | null;
  operator_name: string | null;
  ncr_id: number | null;
  ncr_no: string | null;
  record_id: number | null;
  remark: string | null;
}

/** 查询关键件记录并补全物料、操作人姓名、NCR 编号（按时间顺序） */
export async function keyPartRows(tx: Tx, where: Prisma.KeyPartBindingWhereInput): Promise<KeyPartRow[]> {
  const kps = await tx.keyPartBinding.findMany({ where, orderBy: { id: 'asc' }, include: { material: true, serial: true } });
  if (!kps.length) return [];
  const usernames = [...new Set(kps.map((k) => k.operator).filter((x): x is string => !!x))];
  const ncrIds = [...new Set(kps.map((k) => k.ncr_id).filter((x): x is number => !!x))];
  const users = usernames.length ? await tx.user.findMany({ where: { username: { in: usernames } }, select: { username: true, full_name: true } }) : [];
  const ncrs = ncrIds.length ? await tx.ncr.findMany({ where: { id: { in: ncrIds } }, select: { id: true, no: true } }) : [];
  const nameOf = new Map(users.map((u) => [u.username, u.full_name]));
  const ncrNo = new Map(ncrs.map((n) => [n.id, n.no]));
  return kps.map((k) => ({
    id: k.id, ts: k.ts, sn: k.serial?.sn ?? null, action: k.action, action_text: KEY_PART_ACTION_TEXT[k.action] ?? k.action,
    material_id: k.material_id, material_code: k.material?.code ?? null, material_name: k.material?.name ?? null,
    lot_no: k.lot_no, part_sn: k.part_sn, operator: k.operator, operator_name: k.operator ? nameOf.get(k.operator) ?? k.operator : null,
    ncr_id: k.ncr_id, ncr_no: k.ncr_id ? ncrNo.get(k.ncr_id) ?? null : null, record_id: k.record_id, remark: k.remark,
  }));
}
