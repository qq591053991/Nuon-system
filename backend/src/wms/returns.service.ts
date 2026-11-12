/**
 * 生产退料：工单多领/剩余的物料退回仓库（MaterialIssue.issue_type = 'RETURN'）。
 *
 *   returnableLots(tx, woId)                    → 工单各物料批次的已领/已退/待过账退料/可退数量
 *   createReturn(tx, user, woId, lines, remark?) → 退料单（草稿，单号 TL…）；每批次退料数量不能超过“已领 − 已退 − 未过账退料”
 *   confirmMaterialReturn(tx, inv, user, issueId) → 退料过账：库存加回“合格”（WO_RETURN），扣减工单已领数量
 *
 * 退料单过账/取消沿用领料单接口（POST /issues/:id/confirm、/cancel）；
 * WmsService.confirmIssue 遇到 RETURN 类型时委托给 confirmMaterialReturn（不改变领料过账逻辑）。
 */
import { Injectable } from '@nestjs/common';
import type { MaterialIssue, MaterialIssueLine } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { BizError, NotFound } from '../common/errors';
import { EPS, g, round } from '../common/num';
import { inc } from '../common/presenter';
import type { Tx } from '../common/prisma.service';
import { InventoryService, type Ref } from '../core/inventory.service';
import { NumberingService } from '../core/numbering.service';

/** 可退料的工单状态（已下达/生产中/已完工；已关闭的工单 DHR 已放行，不再改动用料记录） */
export const RETURNABLE_WO_STATUS = ['RELEASED', 'IN_PROGRESS', 'COMPLETED'];

export interface ReturnLineInput {
  material_id: number;
  lot_no?: string | null;
  location_id: number;
  qty: number;
  owner_customer_id?: number | null;
}

export interface ReturnableLot {
  material_id: number;
  material_code: string;
  material_name: string;
  material_spec: string | null;
  uom: string;
  lot_no: string;
  owner_customer_id: number | null;
  /** 最近一次领料的库位（退料默认退回原库位） */
  location_id: number;
  location_code: string | null;
  expiry_date: Date | null;
  issued_qty: number;
  returned_qty: number;
  pending_qty: number;
  returnable_qty: number;
}

export const keyOf = (materialId: number, lot: string, owner: number | null | undefined) => `${materialId}\u0000${lot}\u0000${owner ?? ''}`;

/** 工单各物料批次的领退汇总（按 物料 + 批次 + 货主） */
export async function lotLedger(tx: Tx, woId: number) {
  const lines = await tx.materialIssueLine.findMany({
    where: { issue: { wo_id: woId, status: { in: ['CONFIRMED', 'DRAFT'] } } },
    orderBy: { id: 'asc' },
    include: { issue: { select: { issue_type: true, status: true } }, material: true, location: true },
  });
  const map = new Map<string, ReturnableLot>();
  for (const ln of lines) {
    const k = keyOf(ln.material_id, ln.lot_no, ln.owner_customer_id);
    let r = map.get(k);
    if (!r) {
      r = {
        material_id: ln.material_id, material_code: ln.material.code, material_name: ln.material.name, material_spec: ln.material.spec,
        uom: ln.material.uom, lot_no: ln.lot_no, owner_customer_id: ln.owner_customer_id ?? null, location_id: ln.location_id,
        location_code: ln.location?.code ?? null, expiry_date: ln.expiry_date ?? null, issued_qty: 0, returned_qty: 0, pending_qty: 0, returnable_qty: 0,
      };
      map.set(k, r);
    }
    const isReturn = ln.issue.issue_type === 'RETURN';
    if (!isReturn && ln.issue.status === 'CONFIRMED') {
      r.issued_qty = round(r.issued_qty + ln.qty);
      r.location_id = ln.location_id;
      r.location_code = ln.location?.code ?? r.location_code;
      if (ln.expiry_date) r.expiry_date = ln.expiry_date;
    } else if (isReturn && ln.issue.status === 'CONFIRMED') r.returned_qty = round(r.returned_qty + ln.qty);
    else if (isReturn && ln.issue.status === 'DRAFT') r.pending_qty = round(r.pending_qty + ln.qty);
  }
  for (const r of map.values()) r.returnable_qty = Math.max(0, round(r.issued_qty - r.returned_qty - r.pending_qty));
  return map;
}

/** 退回库位必须是合格品库位（不合格品仓/区不接收退料；不良物料请开具 NCR），且货主与仓库匹配（自有料不进客供料仓、客供料不进自有仓） */
async function checkReturnLocation(tx: Tx, locationId: number, inv?: InventoryService, materialId?: number, owner?: number | null) {
  const loc = await tx.location.findUnique({ where: { id: locationId }, include: { warehouse: true } });
  if (!loc || !loc.is_active) throw new BizError('退料库位不存在或已停用');
  if (loc.location_type === 'REJECT' || loc.warehouse?.warehouse_type === 'REJECT') {
    throw new BizError(`库位 ${loc.code} 为不合格品区：退料只退回合格品库位，不良物料请开具 NCR 处理`);
  }
  if (inv && materialId) {
    const place = await inv.checkPlacement(tx, { material_id: materialId, location_id: locationId, owner_customer_id: owner ?? null });
    if (place.errors.length) throw new BizError(place.errors.join('；'));
  }
  return loc;
}

/** 退料单过账：每行加回“合格”库存（WO_RETURN，保留有效期/供应商批次），扣减工单已领数量。工单行加锁，防止并发超退。 */
export async function confirmMaterialReturn(tx: Tx, inv: InventoryService, user: CurrentUser, issueId: number): Promise<MaterialIssue & { lines: MaterialIssueLine[] }> {
  const head = await tx.materialIssue.findUnique({ where: { id: issueId } });
  if (!head) throw new NotFound('退料单');
  if (head.issue_type !== 'RETURN') throw new BizError('不是退料单');
  await tx.$queryRaw`SELECT id FROM mes_work_order WHERE id = ${head.wo_id} FOR NO KEY UPDATE`;
  const issue = await tx.materialIssue.findUnique({
    where: { id: issueId },
    include: { lines: { orderBy: { id: 'asc' }, include: { material: true } }, work_order: { include: { materials: true } } },
  });
  if (!issue) throw new NotFound('退料单');
  if (issue.status !== 'DRAFT') throw new BizError('退料单已过账或已取消');
  const wo = issue.work_order;
  if (!RETURNABLE_WO_STATUS.includes(wo.status)) throw new BizError('工单状态不允许退料（仅已下达/生产中/已完工的工单可退料）');
  const woMats = new Map(wo.materials.map((m) => [m.material_id, m]));
  // 过账前按已过账数据复核：本单每批次退料 ≤ 已领 − 已退
  const ledger = await lotLedger(tx, wo.id);
  const want = new Map<string, number>();
  for (const ln of issue.lines) {
    const k = keyOf(ln.material_id, ln.lot_no, ln.owner_customer_id);
    want.set(k, round((want.get(k) ?? 0) + ln.qty));
  }
  for (const ln of issue.lines) {
    const k = keyOf(ln.material_id, ln.lot_no, ln.owner_customer_id);
    const r = ledger.get(k);
    const can = r ? round(r.issued_qty - r.returned_qty) : 0;
    if ((want.get(k) ?? 0) > can + EPS) {
      throw new BizError(`退料数量超过已领数量：${ln.material.code} 批次[${ln.lot_no || '-'}] 已领 ${g(r?.issued_qty ?? 0)}，已退 ${g(r?.returned_qty ?? 0)}，本单退料 ${g(want.get(k) ?? 0)}`);
    }
  }
  const ref: Ref = { ref_type: 'ISSUE', ref_id: issue.id, ref_no: issue.no, username: user.username, remark: `工单 ${wo.no} 退料` };
  for (const ln of issue.lines) {
    const wm = woMats.get(ln.material_id);
    if (!wm) throw new BizError(`${ln.material.code} 不是本工单物料`);
    await checkReturnLocation(tx, ln.location_id, inv, ln.material_id, ln.owner_customer_id);
    // 批次属性（生产日期/有效期/供应商批次）取自来料记录，退回后与原批次一致
    const rl = await tx.receiptLine.findFirst({
      where: { material_id: ln.material_id, lot_no: ln.lot_no }, orderBy: { id: 'asc' }, include: { receipt: true },
    });
    await inv.addStock(tx, {
      material_id: ln.material_id, location_id: ln.location_id, lot_no: ln.lot_no, status: 'AVAILABLE', qty: ln.qty,
      owner_customer_id: ln.owner_customer_id ?? null, move_type: 'WO_RETURN', ref,
      mfg_date: rl?.mfg_date ?? null, expiry_date: ln.expiry_date ?? rl?.expiry_date ?? null,
      supplier_id: rl?.receipt.supplier_id ?? null, supplier_lot: rl?.supplier_lot ?? null,
    });
    const left = round((wm.issued_qty || 0) - ln.qty);
    if (left < -EPS) throw new BizError(`${ln.material.code} 退料数量超过工单已领数量 ${g(wm.issued_qty)}`);
    wm.issued_qty = Math.max(0, left);
    await tx.workOrderMaterial.update({ where: { id: wm.id }, data: { issued_qty: wm.issued_qty } });
  }
  return (await tx.materialIssue.update({
    where: { id: issueId },
    data: { status: 'CONFIRMED', confirmed_by: user.full_name, confirmed_at: new Date() },
    include: inc('MaterialIssue', ['lines']),
  })) as any;
}

@Injectable()
export class ReturnsService {
  constructor(private readonly inv: InventoryService, private readonly numbering: NumberingService) {}

  /** 工单已领物料批次及可退数量（可退 = 已领 − 已退 − 未过账退料） */
  async returnableLots(tx: Tx, woId: number): Promise<ReturnableLot[]> {
    if (!(await tx.workOrder.findUnique({ where: { id: woId } }))) throw new NotFound('工单');
    return [...(await lotLedger(tx, woId)).values()].filter((r) => r.issued_qty > EPS);
  }

  /** 生成退料单（草稿）：只能退本工单已领用的批次，数量不超过可退数量 */
  async createReturn(tx: Tx, user: CurrentUser, woId: number, lines: ReturnLineInput[], remark?: string | null): Promise<MaterialIssue & { lines: MaterialIssueLine[] }> {
    const wo = await tx.workOrder.findUnique({ where: { id: woId }, include: { materials: true } });
    if (!wo) throw new NotFound('工单');
    if (!RETURNABLE_WO_STATUS.includes(wo.status)) throw new BizError('工单状态不允许退料（仅已下达/生产中/已完工的工单可退料）');
    if (!lines?.length) throw new BizError('请至少录入一行退料明细');
    const woMatIds = new Set(wo.materials.map((m) => m.material_id));
    const ledger = await lotLedger(tx, wo.id);
    const want = new Map<string, number>();
    const out: { material_id: number; lot_no: string; location_id: number; owner_customer_id: number | null; qty: number; expiry_date: Date | null }[] = [];
    for (const ln of lines) {
      const qty = round(Number(ln.qty || 0));
      if (!(qty > 0)) throw new BizError('退料数量必须大于 0');
      if (!woMatIds.has(ln.material_id)) throw new BizError('非本工单物料，不能退料');
      const lot = (ln.lot_no ?? '').trim();
      // 货主未指定时按该批次领料记录确定（客供料退回客户货主名下）
      let owner = ln.owner_customer_id ?? null;
      let r = ledger.get(keyOf(ln.material_id, lot, owner));
      if (!r && ln.owner_customer_id === undefined) {
        const cands = [...ledger.values()].filter((x) => x.material_id === ln.material_id && x.lot_no === lot && x.issued_qty > EPS);
        if (cands.length === 1) {
          r = cands[0];
          owner = r.owner_customer_id;
        }
      }
      const m = await tx.material.findUnique({ where: { id: ln.material_id } });
      if (!r || r.issued_qty <= EPS) throw new BizError(`${m?.code ?? ln.material_id} 批次[${lot || '-'}] 未领用到本工单，不能退料`);
      await checkReturnLocation(tx, ln.location_id, this.inv, ln.material_id, owner);
      const k = keyOf(ln.material_id, lot, owner);
      const total = round((want.get(k) ?? 0) + qty);
      if (total > r.returnable_qty + EPS) {
        throw new BizError(
          `退料数量超过可退数量：${r.material_code} 批次[${lot || '-'}] 已领 ${g(r.issued_qty)}，已退 ${g(r.returned_qty)}，` +
            `未过账退料 ${g(r.pending_qty)}，最多还可退 ${g(r.returnable_qty)}，本次 ${g(total)}`,
        );
      }
      want.set(k, total);
      out.push({ material_id: ln.material_id, lot_no: lot, location_id: ln.location_id, owner_customer_id: owner, qty, expiry_date: r.expiry_date });
    }
    return (await tx.materialIssue.create({
      data: {
        no: await this.numbering.nextNo(tx, 'TL'), wo_id: wo.id, issue_type: 'RETURN', status: 'DRAFT', remark: remark ?? null,
        created_by: user.username, lines: { create: out },
      },
      include: inc('MaterialIssue', ['lines']),
    })) as any;
  }

  /** 退料过账（同 POST /issues/:id/confirm） */
  confirmReturn(tx: Tx, user: CurrentUser, issueId: number) {
    return confirmMaterialReturn(tx, this.inv, user, issueId);
  }
}
