/**
 * 工单下达后调整（A9）：已下达 / 生产中的工单，未开工部分可以调数量、调计划日期。
 *   - 数量下限 = 已开工数量（序列号产品：已过站/不良/报废的序列号数；批量产品：首道工序已报数量与完工+报废的较大者）；
 *   - 序列号产品：调减时作废未开工的序列号（从最大号开始），调增时按原批号补发序列号与 UDI；
 *   - 用料需求按下达时锁定的 BOM 重算；已领超出新需求时提醒退料；
 *   - 调到等于完工 + 报废时工单转为“已完工”；
 *   - 关联订单行时，工单合计超过订单数量给出提醒；
 *   - 字段级变更由审计追踪自动记录，调整原因另记一条审计。
 */
import { Injectable } from '@nestjs/common';
import type { CurrentUser } from '../common/context';
import { addDays, dateOnly, fmtDate, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { EPS, g, round } from '../common/num';
import { inc, ser } from '../common/presenter';
import { PrismaService, type Tx } from '../common/prisma.service';
import { NumberingService } from '../core/numbering.service';
import { buildUdi } from '../core/udi';
import { auditReason } from './sales.service';
import { isDiscreteUom } from './so-plan';

export interface WoAdjustArgs {
  planned_qty?: number | null;
  planned_start?: string | null;
  planned_end?: string | null;
  reason?: string | null;
  preview?: boolean;
}

@Injectable()
export class WoAdjustService {
  constructor(private readonly db: PrismaService, private readonly numbering: NumberingService) {}

  /** 已开工数量与序列号情况 */
  private async progress(tx: Tx, woId: number) {
    const wo = await tx.workOrder.findUnique({ where: { id: woId }, include: { material: true, operations: { orderBy: { seq: 'asc' } }, materials: { include: { material: true } } } });
    if (!wo) throw new NotFound('生产工单');
    let started = round((wo.completed_qty || 0) + (wo.scrap_qty || 0));
    let active = wo.planned_qty;
    let unstarted: { id: number; sn: string }[] = [];
    if (wo.material.serial_control) {
      const sns = await tx.serialNumber.findMany({ where: { wo_id: wo.id }, orderBy: { sn: 'asc' } });
      const voided = (s: (typeof sns)[number]) => s.status === 'SCRAPPED' && (s.last_seq || 0) === 0 && s.ng_seq === null;
      const live = sns.filter((s) => !voided(s));
      unstarted = live.filter((s) => s.status === 'CREATED' && (s.last_seq || 0) === 0 && s.ng_seq === null).map((s) => ({ id: s.id, sn: s.sn }));
      active = live.length;
      started = Math.max(started, live.length - unstarted.length);
    } else if (wo.operations.length) {
      const first = wo.operations[0];
      started = Math.max(started, round((first.good_qty || 0) + (first.ng_qty || 0)));
    }
    const pending = await tx.materialIssueLine.groupBy({ by: ['material_id'], where: { issue: { wo_id: wo.id, status: 'DRAFT', issue_type: 'ISSUE' } }, _sum: { qty: true } });
    return { wo, started, active, unstarted, pending: new Map(pending.map((p) => [p.material_id, p._sum.qty ?? 0])) };
  }

  /** 调整前的信息：可调范围 */
  async info(id: number) {
    const p = await this.progress(this.db.client, id);
    const { wo } = p;
    const adjustable = ['RELEASED', 'IN_PROGRESS'].includes(wo.status);
    let so_line: { so_id: number; so_no: string; line_no: number; qty: number; other_wo_qty: number } | null = null;
    if (wo.so_line_id) {
      const ln = await this.db.client.salesOrderLine.findUnique({ where: { id: wo.so_line_id }, include: { order: true } });
      const others = await this.db.client.workOrder.findMany({ where: { so_line_id: wo.so_line_id, id: { not: wo.id }, status: { not: 'CANCELLED' } } });
      if (ln) so_line = { so_id: ln.order_id, so_no: ln.order.no, line_no: ln.line_no, qty: ln.qty, other_wo_qty: round(others.reduce((s, w) => s + w.planned_qty, 0)) };
    }
    const minQty = Math.max(p.started, wo.material.serial_control ? 1 : EPS);
    // 与订单不符：订单数量 ≠ 关联工单合计 → 建议本工单调到“订单数量 − 其他工单”（不少于已开工数量）
    let mismatch: { so_qty: number; wo_total: number; suggest_qty: number; cancel_suggested: boolean } | null = null;
    if (so_line && ['PLANNED', 'RELEASED', 'IN_PROGRESS'].includes(wo.status)) {
      const total = round(so_line.other_wo_qty + wo.planned_qty);
      if (Math.abs(total - so_line.qty) > EPS) {
        const target = round(so_line.qty - so_line.other_wo_qty);
        mismatch = { so_qty: so_line.qty, wo_total: total, suggest_qty: Math.max(target, minQty), cancel_suggested: target <= EPS && p.started <= EPS };
      }
    }
    return {
      mismatch,
      wo_id: wo.id, wo_no: wo.no, status: wo.status, adjustable, planned_qty: wo.planned_qty, min_qty: minQty,
      started: p.started, completed_qty: wo.completed_qty, scrap_qty: wo.scrap_qty, unstarted_serials: p.unstarted.length,
      serial_control: wo.material.serial_control, uom: wo.material.uom, planned_start: fmtDate(wo.planned_start), planned_end: fmtDate(wo.planned_end),
      so_line,
      message: adjustable ? null : wo.status === 'PLANNED' ? '计划状态的工单请直接【修改】' : '已完工/关闭/取消的工单不能调整',
    };
  }

  adjust(id: number, a: WoAdjustArgs, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM mes_work_order WHERE id = ${id} FOR NO KEY UPDATE`;
      const p = await this.progress(tx, id);
      const { wo } = p;
      if (wo.status === 'PLANNED') throw new BizError('计划状态的工单请直接【修改】，不需要走调整');
      if (!['RELEASED', 'IN_PROGRESS'].includes(wo.status)) throw new BizError('只有已下达、生产中的工单可以调整');
      const warnings: string[] = [];
      const changes: string[] = [];
      const product = wo.material;
      const qty = a.planned_qty ?? wo.planned_qty;
      if (!(qty > 0)) throw new BizError('计划数量必须大于 0');
      if (product.serial_control && Math.abs(qty - Math.round(qty)) > EPS) throw new BizError('序列号管理的产品，工单数量必须为整数');
      if (qty < p.started - EPS) {
        throw new BizError(`已开工 ${g(p.started)} ${product.uom}（完工 ${g(wo.completed_qty)}、报废 ${g(wo.scrap_qty)}${product.serial_control ? `、在制 ${g(p.started - (wo.completed_qty || 0) - (wo.scrap_qty || 0))}` : ''}），数量不能少于 ${g(p.started)}`);
      }
      const start = a.planned_start === undefined ? wo.planned_start : dateOnly(a.planned_start);
      const end = a.planned_end === undefined ? wo.planned_end : dateOnly(a.planned_end);
      if (start && end && end.getTime() < start.getTime()) throw new BizError('计划完工日期不能早于计划开工日期');
      if (Math.abs(qty - wo.planned_qty) > EPS) changes.push(`数量 ${g(wo.planned_qty)} → ${g(qty)}`);
      if (fmtDate(start) !== fmtDate(wo.planned_start)) changes.push(`计划开工 ${fmtDate(wo.planned_start) ?? '空'} → ${fmtDate(start) ?? '空'}`);
      if (fmtDate(end) !== fmtDate(wo.planned_end)) changes.push(`计划完工 ${fmtDate(wo.planned_end) ?? '空'} → ${fmtDate(end) ?? '空'}`);
      if (end && end.getTime() < today().getTime()) warnings.push('计划完工日期早于今天');

      // 用料需求按锁定的 BOM 重算
      const bom = wo.bom_id ? await tx.bom.findUnique({ where: { id: wo.bom_id }, include: { lines: true } }) : null;
      const reqUpd: { id: number; required_qty: number }[] = [];
      for (const m of wo.materials) {
        const ln = bom?.lines.find((l) => l.component_id === m.material_id);
        const req = ln ? qty * ln.qty_per * (1 + (ln.scrap_rate || 0)) : (m.required_qty / (wo.planned_qty || 1)) * qty;
        const newReq = isDiscreteUom(m.material.uom) ? Math.ceil(req - EPS) : round(req);
        if (Math.abs(newReq - m.required_qty) > EPS) reqUpd.push({ id: m.id, required_qty: newReq });
        const taken = (m.issued_qty || 0) + (p.pending.get(m.material_id) ?? 0);
        if (taken > newReq + EPS) warnings.push(`${m.material.code} 已领/待领 ${g(taken)}，超过新需求 ${g(newReq)}：多出的 ${g(taken - newReq)} 请办理生产退料`);
      }
      if (wo.so_line_id && qty > wo.planned_qty + EPS) {
        const ln = await tx.salesOrderLine.findUnique({ where: { id: wo.so_line_id }, include: { order: true } });
        const others = await tx.workOrder.findMany({ where: { so_line_id: wo.so_line_id, id: { not: wo.id }, status: { not: 'CANCELLED' } } });
        const total = round(others.reduce((s, w) => s + w.planned_qty - (w.scrap_qty || 0), 0) + qty - (wo.scrap_qty || 0));
        if (ln && total > ln.qty + EPS) warnings.push(`订单 ${ln.order.no} 第${ln.line_no}行只订了 ${g(ln.qty)}，调整后工单合计 ${g(total)}，多出 ${g(total - ln.qty)} 将入库为库存`);
      }
      const delta = round(qty - wo.planned_qty);
      if (product.serial_control && delta < -EPS) {
        const n = Math.round(-delta);
        if (n > p.unstarted.length) throw new BizError(`未开工的序列号只有 ${p.unstarted.length} 个，最多减少 ${p.unstarted.length}`);
        changes.push(`作废未开工序列号 ${n} 个`);
      }
      if (product.serial_control && delta > EPS) changes.push(`补发序列号 ${Math.round(delta)} 个`);
      if (!changes.length) throw new BizError('没有修改任何内容');
      if (a.preview) return { changes, warnings, work_order: null };
      if (!a.reason?.trim()) throw new BizError('请填写调整原因（如：客户订单减少 5 台）');

      if (product.serial_control && delta < -EPS) {
        const victims = [...p.unstarted].sort((x, y) => y.sn.localeCompare(x.sn)).slice(0, Math.round(-delta));
        await tx.serialNumber.updateMany({ where: { id: { in: victims.map((v) => v.id) } }, data: { status: 'SCRAPPED' } });
      }
      if (product.serial_control && delta > EPS) {
        const mfg = today();
        const exp = product.shelf_life_days ? addDays(mfg, product.shelf_life_days) : null;
        const prefix = (product.sn_prefix || product.code.replace(/-/g, '').slice(0, 6)).toUpperCase();
        const ymd = fmtDate(mfg)!.slice(2).replace(/-/g, '');
        const key = `SN-${prefix}${ymd}`;
        for (let i = 0; i < Math.round(delta); i++) {
          const sn = `${prefix}${ymd}${String(await this.numbering.nextSeq(tx, key)).padStart(4, '0')}`;
          await tx.serialNumber.create({
            data: {
              sn, wo_id: wo.id, material_id: product.id, lot_no: wo.lot_no, status: 'CREATED', created_by: user.username,
              udi: buildUdi(product.gtin, { mfg_date: mfg, expiry_date: exp, lot: wo.lot_no, serial: sn }),
            },
          });
        }
      }
      for (const r of reqUpd) await tx.workOrderMaterial.update({ where: { id: r.id }, data: { required_qty: r.required_qty } });
      const upd: Record<string, any> = { planned_qty: qty, planned_start: start, planned_end: end };
      if (wo.status === 'IN_PROGRESS' && (wo.completed_qty || 0) + (wo.scrap_qty || 0) >= qty - EPS) {
        upd.status = 'COMPLETED';
        upd.actual_end = new Date();
        warnings.push('完工 + 报废已达到新的计划数量，工单已转为“已完工”');
      }
      await tx.workOrder.update({ where: { id }, data: upd });
      await auditReason(tx, user, 'mes_work_order', id, `工单调整：${changes.join('；')}。原因：${a.reason.trim()}`);
      const row = await tx.workOrder.findUniqueOrThrow({ where: { id }, include: inc('WorkOrder', ['materials', 'operations']) });
      return { changes, warnings, work_order: ser('WorkOrder', row, ['materials', 'operations']) };
    });
  }
}
