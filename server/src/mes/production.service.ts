/**
 * 生产执行核心：工单下达（BOM/工艺快照、批号、序列号+UDI）、工位报工（防跳站、设备校准校验、
 * 测试数据自动判定、不合格自动开 NCR）、完工入库、DHR 汇编与产品放行。
 */
import { Injectable } from '@nestjs/common';
import type { Equipment, SerialNumber, WorkOrder, WorkOrderOperation } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { addDays, fmtDate, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { EPS, g, round } from '../common/num';
import type { Tx } from '../common/prisma.service';
import { releasedBom, releasedRouting } from '../core/engineering';
import { EsignService, type SignatureDto } from '../core/esign.service';
import { InventoryService, type Ref } from '../core/inventory.service';
import { NumberingService } from '../core/numbering.service';
import { buildUdi } from '../core/udi';

export const DISCRETE_UOM = new Set(['PCS', 'PC', 'EA', 'SET', '个', '台', '只', '套', '片', '件', '张', '根', '块', '颗', '盒', '本']);
export const OP_TYPE_TEXT: Record<string, string> = {
  SMT: 'SMT贴片', ASSEMBLY: '组装', TEST_OPTICAL: '光学性能测试', AGING: '老化',
  TEST_SAFETY: '安规测试', INSPECTION: '检验', PACKING: '包装', OTHER: '其他',
};

/** 工序测试规格（工单下达时从工艺路线快照到 params_json） */
export interface OpParam { code: string; name: string; unit: string | null; lower: number | null; upper: number | null; target: number | null }
export interface JudgedValue extends OpParam { value: number; result: 'PASS' | 'FAIL' }
export type WoOp = WorkOrderOperation & { work_center?: { name: string } | null };

export interface KeyPartInput { lot_no?: string | null; part_sn?: string | null }
export interface ReportSerialArgs {
  sn: string;
  seq?: number | null;
  result?: string | null;
  values?: Record<string, number | null | undefined> | null;
  equipment_id?: number | null;
  remark?: string | null;
  key_parts?: KeyPartInput[] | null;
}
export interface ReportBatchArgs {
  seq: number;
  good_qty?: number | null;
  ng_qty?: number | null;
  values?: Record<string, number | null | undefined> | null;
  equipment_id?: number | null;
  remark?: string | null;
}

/** 需求数量取整：离散计量单位向上取整，其余保留 4 位 */
export function roundReq(qty: number, uom: string | null | undefined): number {
  if (DISCRETE_UOM.has((uom || '').toUpperCase()) || DISCRETE_UOM.has(uom || '')) return Math.ceil(qty - EPS);
  return round(qty, 4);
}

export const opParams = (op: { params_json?: string | null }): OpParam[] => (op.params_json ? JSON.parse(op.params_json) : []);

/** 序列号的下一道工序（按工序号顺序，第一个大于已完成工序号的工序） */
export function nextOperation<T extends { seq: number }>(ops: T[], sn: { last_seq?: number | null }): T | null {
  return [...ops].sort((a, b) => a.seq - b.seq).find((o) => o.seq > (sn.last_seq || 0)) ?? null;
}

export function opDict(op: WoOp | null | undefined) {
  if (!op) return null;
  return {
    id: op.id, seq: op.seq, code: op.code, name: op.name, op_type: op.op_type,
    op_type_text: OP_TYPE_TEXT[op.op_type] ?? op.op_type, requires_equipment: op.requires_equipment,
    key_part_material_id: op.key_part_material_id, work_center_id: op.work_center_id,
    work_center_name: op.work_center?.name ?? null, sop_no: op.sop_no, instructions: op.instructions,
    params: opParams(op), good_qty: op.good_qty, ng_qty: op.ng_qty,
  };
}

/** 测试数据自动判定：逐项与上下限比较 */
export function judge(params: OpParam[], values: Record<string, number | null | undefined>): JudgedValue[] {
  return params.map((p) => {
    const raw = values[p.code];
    const v = raw === null || raw === undefined || (raw as unknown) === '' ? null : Number(raw);
    if (v === null || Number.isNaN(v)) throw new BizError(`请录入测试项【${p.name}】的测量值`);
    const ok = (p.lower === null || p.lower === undefined || v >= p.lower - EPS) && (p.upper === null || p.upper === undefined || v <= p.upper + EPS);
    return { ...p, value: v, result: ok ? 'PASS' : 'FAIL' };
  });
}

export function specText(p: { lower?: number | null; upper?: number | null; unit?: string | null }): string {
  const lo = p.lower ?? null;
  const up = p.upper ?? null;
  const unit = p.unit || '';
  if (lo !== null && up !== null) return `${g(lo)}~${g(up)}${unit}`;
  if (lo !== null) return `≥${g(lo)}${unit}`;
  if (up !== null) return `≤${g(up)}${unit}`;
  return '-';
}

const ACTIVE = ['RELEASED', 'IN_PROGRESS'];

@Injectable()
export class ProductionService {
  constructor(
    private readonly numbering: NumberingService,
    private readonly inv: InventoryService,
    private readonly esign: EsignService,
  ) {}

  async getWo(tx: Tx, woId: number) {
    const wo = await tx.workOrder.findUnique({ where: { id: woId }, include: { material: true } });
    if (!wo) throw new NotFound('生产工单');
    return wo;
  }

  /** 工单工序（按工序号排序，含工作中心） */
  woOps(tx: Tx, woId: number): Promise<WoOp[]> {
    return tx.workOrderOperation.findMany({ where: { wo_id: woId }, orderBy: { seq: 'asc' }, include: { work_center: true } });
  }

  async getSn(tx: Tx, snText: string | null | undefined): Promise<SerialNumber> {
    const sn = await tx.serialNumber.findUnique({ where: { sn: (snText || '').trim() } });
    if (!sn) throw new BizError(`序列号 ${snText} 不存在`);
    return sn;
  }

  // ---------------- 工单下达 ----------------
  async releaseWorkOrder(tx: Tx, woId: number, user: CurrentUser): Promise<WorkOrder> {
    const wo = await this.getWo(tx, woId);
    if (wo.status !== 'PLANNED') throw new BizError('只有“计划”状态的工单才能下达');
    const product = wo.material;
    const bom = wo.bom_id
      ? await tx.bom.findUnique({ where: { id: wo.bom_id }, include: { lines: { include: { component: true }, orderBy: { line_no: 'asc' } } } })
      : await releasedBom(tx, product.id);
    if (!bom || bom.status !== 'RELEASED') throw new BizError(`产品 ${product.code} 没有已发布的 BOM，不能下达（GMP：只能使用受控版本）`);
    const routing = wo.routing_id
      ? await tx.routing.findUnique({
          where: { id: wo.routing_id },
          include: { operations: { orderBy: { seq: 'asc' }, include: { params: { orderBy: { id: 'asc' } } } } },
        })
      : await releasedRouting(tx, product.id);
    if (!routing || routing.status !== 'RELEASED') throw new BizError(`产品 ${product.code} 没有已发布的工艺路线，不能下达`);
    if (!routing.operations.length) throw new BizError('工艺路线没有工序');
    if (product.serial_control && Math.abs(wo.planned_qty - Math.round(wo.planned_qty)) > EPS) throw new BizError('序列号管理的产品，工单数量必须为整数');
    if (product.customer_id && wo.customer_id && product.customer_id !== wo.customer_id) throw new BizError('工单客户与产品所属客户不一致');

    // 1) 用料需求快照
    await tx.workOrderMaterial.deleteMany({ where: { wo_id: wo.id } });
    for (const ln of bom.lines) {
      const req = wo.planned_qty * ln.qty_per * (1 + (ln.scrap_rate || 0));
      await tx.workOrderMaterial.create({
        data: { wo_id: wo.id, material_id: ln.component_id, qty_per: ln.qty_per, required_qty: roundReq(req, ln.component.uom), issued_qty: 0 },
      });
    }
    // 2) 工序快照（含测试规格）
    await tx.workOrderOperation.deleteMany({ where: { wo_id: wo.id } });
    for (const op of routing.operations) {
      const params: OpParam[] = op.params.map((p) => ({ code: p.code, name: p.name, unit: p.unit, lower: p.lower, upper: p.upper, target: p.target }));
      await tx.workOrderOperation.create({
        data: {
          wo_id: wo.id, seq: op.seq, code: op.code, name: op.name, op_type: op.op_type, work_center_id: op.work_center_id,
          requires_equipment: op.requires_equipment, key_part_material_id: op.key_part_material_id,
          sop_no: op.sop_no, instructions: op.instructions, params_json: JSON.stringify(params),
        },
      });
    }
    // 3) 生产批号
    const lotNo = wo.lot_no || (await this.numbering.nextNo(tx, 'B'));
    // 4) 序列号 + UDI
    if (product.serial_control) {
      const mfg = today();
      const exp = product.shelf_life_days ? addDays(mfg, product.shelf_life_days) : null;
      const prefix = (product.sn_prefix || product.code.replace(/-/g, '').slice(0, 6)).toUpperCase();
      const ymd = fmtDate(mfg)!.slice(2).replace(/-/g, '');
      const key = `SN-${prefix}${ymd}`;
      for (let i = 0; i < Math.round(wo.planned_qty); i++) {
        const sn = `${prefix}${ymd}${String(await this.numbering.nextSeq(tx, key)).padStart(4, '0')}`;
        await tx.serialNumber.create({
          data: {
            sn, wo_id: wo.id, material_id: product.id, lot_no: lotNo, status: 'CREATED', created_by: user.username,
            udi: buildUdi(product.gtin, { mfg_date: mfg, expiry_date: exp, lot: lotNo, serial: sn }),
          },
        });
      }
    }
    return tx.workOrder.update({
      where: { id: wo.id },
      data: {
        bom_id: bom.id, routing_id: routing.id, customer_id: wo.customer_id || product.customer_id,
        lot_no: lotNo, status: 'RELEASED', released_by: user.username,
      },
    });
  }

  // ---------------- 报工 ----------------
  private async checkEquipment(tx: Tx, op: WoOp, equipmentId: number | null | undefined): Promise<Equipment | null> {
    if (!equipmentId) {
      if (op.requires_equipment) throw new BizError(`工序【${op.name}】必须选择/扫描所用设备仪器`);
      return null;
    }
    const eq = await tx.equipment.findUnique({ where: { id: equipmentId } });
    if (!eq) throw new NotFound('设备');
    if (eq.status !== 'NORMAL') throw new BizError(`设备 ${eq.code} 当前状态为【${eq.status}】，不可用于生产`);
    if (eq.calibration_required && (!eq.next_calibration_date || eq.next_calibration_date.getTime() < today().getTime())) {
      throw new BizError(`设备 ${eq.code} ${eq.name} 校准已过期（有效期至 ${fmtDate(eq.next_calibration_date) ?? '-'}），禁止使用，请联系计量管理员`);
    }
    return eq;
  }

  /** 已领用（过账）到工单的某物料批次 */
  private async issuedLots(tx: Tx, woId: number, materialId: number): Promise<Set<string>> {
    const rows = await tx.materialIssueLine.findMany({
      where: { material_id: materialId, issue: { wo_id: woId, status: 'CONFIRMED' } },
      select: { lot_no: true },
    });
    return new Set(rows.map((r) => r.lot_no));
  }

  /** 开工：首次报工时工单转为“生产中” */
  private start(wo: WorkOrder, upd: Record<string, any>) {
    if ((upd.status ?? wo.status) === 'RELEASED') {
      upd.status = 'IN_PROGRESS';
      upd.actual_start = new Date();
    }
  }

  /** 完工+报废 ≥ 计划数 → 工单完工 */
  private maybeComplete(wo: WorkOrder, upd: Record<string, any>) {
    const completed = upd.completed_qty ?? wo.completed_qty ?? 0;
    const status = upd.status ?? wo.status;
    if (completed + (wo.scrap_qty || 0) >= wo.planned_qty - EPS && ACTIVE.includes(status)) {
      upd.status = 'COMPLETED';
      upd.actual_end = new Date();
    }
  }

  /** 序列号过站报工：防跳站、设备校准校验、测试数据自动判定、关键件绑定、不合格自动开 NCR */
  async reportSerial(tx: Tx, user: CurrentUser, a: ReportSerialArgs) {
    const sn = await this.getSn(tx, a.sn);
    const wo = await this.getWo(tx, sn.wo_id);
    if (!ACTIVE.includes(wo.status)) throw new BizError(`工单 ${wo.no} 状态为【${wo.status}】，不能报工`);
    if (sn.status === 'NG') throw new BizError(`${sn.sn} 存在未处置的不合格（NCR），请先由 QA 评审处置（返工/报废）`);
    if (['COMPLETED', 'IN_STOCK', 'SHIPPED'].includes(sn.status)) throw new BizError(`${sn.sn} 已完成全部工序`);
    if (sn.status === 'SCRAPPED') throw new BizError(`${sn.sn} 已报废`);
    const ops = await this.woOps(tx, wo.id);
    const op = nextOperation(ops, sn);
    if (!op) throw new BizError('没有待执行的工序');
    if (a.seq !== null && a.seq !== undefined && a.seq !== op.seq) {
      const cur = ops.find((o) => o.seq === a.seq);
      throw new BizError(`防呆拦截：${sn.sn} 的下一道工序是【${op.seq} ${op.name}】，当前工位【${cur ? cur.name : a.seq}】不能报工（禁止跳站/重复过站）`);
    }
    const eq = await this.checkEquipment(tx, op, a.equipment_id);
    const params = opParams(op);
    const judged = params.length ? judge(params, a.values || {}) : [];
    const final = a.result === 'FAIL' || judged.some((j) => j.result === 'FAIL') ? 'FAIL' : 'PASS';

    // 关键件绑定校验
    const bindings: { material_id: number; lot_no: string | null; part_sn: string | null }[] = [];
    if (op.key_part_material_id) {
      const kp = (a.key_parts || []).find((k) => k.lot_no || k.part_sn);
      if (!kp) {
        const km = await tx.material.findUnique({ where: { id: op.key_part_material_id } });
        throw new BizError(`工序【${op.name}】需扫描关键件【${km?.code} ${km?.name}】的批号或序列号`);
      }
      const lots = await this.issuedLots(tx, wo.id, op.key_part_material_id);
      if (kp.lot_no && lots.size && !lots.has(kp.lot_no)) {
        throw new BizError(`关键件批号 ${kp.lot_no} 未领用到工单 ${wo.no}（已领批次：${[...lots].sort().join(', ')}）`);
      }
      bindings.push({ material_id: op.key_part_material_id, lot_no: kp.lot_no ?? null, part_sn: kp.part_sn ?? null });
    }

    const rec = await tx.operationRecord.create({
      data: {
        ts: new Date(), wo_id: wo.id, sn_id: sn.id, seq: op.seq, op_code: op.code, op_name: op.name, result: final, qty: 1,
        operator: user.username, operator_name: user.full_name, equipment_id: eq?.id ?? null, is_rework: sn.ng_seq === op.seq,
        remark: a.remark ?? null,
        values: {
          create: judged.map((j) => ({ code: j.code, name: j.name, unit: j.unit ?? null, value: j.value, lower: j.lower ?? null, upper: j.upper ?? null, result: j.result })),
        },
      },
    });
    for (const b of bindings) {
      await tx.keyPartBinding.create({ data: { ts: new Date(), sn_id: sn.id, record_id: rec.id, operator: user.username, ...b } });
    }
    const woUpd: Record<string, any> = {};
    const snUpd: Record<string, any> = {};
    const opUpd: Record<string, any> = {};
    this.start(wo, woUpd);
    let ncrNo: string | null = null;
    if (final === 'PASS') {
      opUpd.good_qty = (op.good_qty || 0) + 1;
      Object.assign(snUpd, { last_seq: op.seq, ng_seq: null, status: 'IN_PROCESS' });
      if (!nextOperation(ops, { last_seq: op.seq })) {
        Object.assign(snUpd, { status: 'COMPLETED', completed_at: new Date() });
        woUpd.completed_qty = (wo.completed_qty || 0) + 1;
        this.maybeComplete(wo, woUpd);
      }
    } else {
      opUpd.ng_qty = (op.ng_qty || 0) + 1;
      Object.assign(snUpd, { status: 'NG', ng_seq: op.seq });
      const fails = judged.filter((j) => j.result === 'FAIL').map((j) => `${j.name}=${g(j.value)}${j.unit || ''}(规格 ${specText(j)})`);
      const desc = `工序【${op.seq} ${op.name}】判定不合格。` + fails.join('；') + (a.remark ? ` 备注：${a.remark}` : '');
      ncrNo = await this.numbering.nextNo(tx, 'NCR');
      await tx.ncr.create({
        data: {
          no: ncrNo, source: 'PROCESS', severity: 'MAJOR', material_id: wo.material_id, lot_no: wo.lot_no, sn: sn.sn, wo_id: wo.id,
          op_seq: op.seq, op_name: op.name, customer_id: wo.customer_id, qty: 1, description: desc, status: 'OPEN', created_by: user.username,
        },
      });
    }
    await tx.workOrderOperation.update({ where: { id: op.id }, data: opUpd });
    const snNew = await tx.serialNumber.update({ where: { id: sn.id }, data: snUpd });
    const woNew = Object.keys(woUpd).length ? await tx.workOrder.update({ where: { id: wo.id }, data: woUpd }) : wo;
    const nxt = snNew.status === 'IN_PROCESS' ? nextOperation(ops, snNew) : null;
    return {
      record_id: rec.id, result: final, sn: sn.sn, sn_status: snNew.status, values: judged, ncr_no: ncrNo,
      next_operation: nxt ? opDict(nxt) : null, wo_no: wo.no, wo_completed_qty: woNew.completed_qty, wo_status: woNew.status,
    };
  }

  /** 非序列号产品按批量报工；本工序合格+不合格数量不得超过上道工序合格数量（防超报）。 */
  async reportBatch(tx: Tx, user: CurrentUser, woId: number, a: ReportBatchArgs) {
    const wo = await this.getWo(tx, woId);
    const good = Number(a.good_qty || 0);
    const ng = Number(a.ng_qty || 0);
    if (wo.material.serial_control) throw new BizError('序列号管理的产品请逐台扫码报工');
    if (!ACTIVE.includes(wo.status)) throw new BizError(`工单 ${wo.no} 状态为【${wo.status}】，不能报工`);
    if (good < 0 || ng < 0 || good + ng <= 0) throw new BizError('报工数量必须大于 0');
    const ops = await this.woOps(tx, wo.id);
    const idx = ops.findIndex((o) => o.seq === a.seq);
    if (idx < 0) throw new BizError('工序不存在');
    const op = ops[idx];
    const upstream = idx === 0 ? wo.planned_qty : ops[idx - 1].good_qty;
    const avail = round(upstream - (op.good_qty || 0) - (op.ng_qty || 0), 4);
    if (good + ng > avail + EPS) throw new BizError(`报工数量超出：工序【${op.name}】可报数量 ${g(avail)}`);
    const eq = await this.checkEquipment(tx, op, a.equipment_id);
    const params = opParams(op);
    const judged = params.length && good > 0 ? judge(params, a.values || {}) : [];
    if (judged.some((j) => j.result === 'FAIL')) throw new BizError('抽测数据超出规格，不能按合格报工，请将不合格数量报为 NG');
    const woUpd: Record<string, any> = {};
    this.start(wo, woUpd);
    const out: Record<string, any> = {};
    for (const [res, q] of [['PASS', good], ['FAIL', ng]] as const) {
      if (q <= 0) continue;
      await tx.operationRecord.create({
        data: {
          ts: new Date(), wo_id: wo.id, seq: op.seq, op_code: op.code, op_name: op.name, result: res, qty: q,
          operator: user.username, operator_name: user.full_name, equipment_id: eq?.id ?? null, remark: a.remark ?? null,
          ...(res === 'PASS' && judged.length
            ? { values: { create: judged.map((j) => ({ code: j.code, name: j.name, unit: j.unit ?? null, value: j.value, lower: j.lower ?? null, upper: j.upper ?? null, result: j.result })) } }
            : {}),
        },
      });
    }
    const opNew = await tx.workOrderOperation.update({
      where: { id: op.id },
      data: { good_qty: round((op.good_qty || 0) + good, 4), ng_qty: round((op.ng_qty || 0) + ng, 4) },
      include: { work_center: true },
    });
    if (ng > 0) {
      const no = await this.numbering.nextNo(tx, 'NCR');
      await tx.ncr.create({
        data: {
          no, source: 'PROCESS', material_id: wo.material_id, lot_no: wo.lot_no, wo_id: wo.id, op_seq: op.seq, op_name: op.name,
          customer_id: wo.customer_id, qty: ng, description: `工序【${op.seq} ${op.name}】不合格 ${g(ng)} ${wo.material.uom}。${a.remark || ''}`,
          status: 'OPEN', created_by: user.username,
        },
      });
      out.ncr_no = no;
    }
    if (idx === ops.length - 1 && good > 0) {
      woUpd.completed_qty = round((wo.completed_qty || 0) + good, 4);
      this.maybeComplete(wo, woUpd);
    }
    const woNew = Object.keys(woUpd).length ? await tx.workOrder.update({ where: { id: wo.id }, data: woUpd }) : wo;
    return { ...out, wo_no: wo.no, op: opDict(opNew), wo_completed_qty: woNew.completed_qty, wo_status: woNew.status };
  }

  // ---------------- 工位扫码 ----------------
  async scanSerial(tx: Tx, snText: string) {
    const sn = await this.getSn(tx, snText);
    const wo = await tx.workOrder.findUniqueOrThrow({ where: { id: sn.wo_id }, include: { material: true, customer: true } });
    const ops = await this.woOps(tx, wo.id);
    const nxt = ['CREATED', 'IN_PROCESS'].includes(sn.status) ? nextOperation(ops, sn) : null;
    const recs = await tx.operationRecord.findMany({
      where: { sn_id: sn.id }, orderBy: { id: 'asc' }, include: { equipment: true, values: { orderBy: { id: 'asc' } } },
    });
    const openNcr = await tx.ncr.findFirst({ where: { sn: sn.sn, status: 'OPEN' }, orderBy: { id: 'asc' } });
    const kpm = nxt?.key_part_material_id ? await tx.material.findUnique({ where: { id: nxt.key_part_material_id } }) : null;
    const p = wo.material;
    return {
      sn: sn.sn, udi: sn.udi, status: sn.status, lot_no: sn.lot_no, last_seq: sn.last_seq,
      wo: { id: wo.id, no: wo.no, status: wo.status, planned_qty: wo.planned_qty, completed_qty: wo.completed_qty, customer_name: wo.customer?.name ?? null },
      product: { id: p.id, code: p.code, name: p.name, model: p.model, spec: p.spec },
      operations: ops.map((o) => ({ seq: o.seq, code: o.code, name: o.name, op_type: o.op_type, done: o.seq <= (sn.last_seq || 0) })),
      next_operation: opDict(nxt),
      key_part_material: kpm ? { id: kpm.id, code: kpm.code, name: kpm.name } : null,
      open_ncr: openNcr?.no ?? null,
      history: recs.map((r) => ({
        ts: r.ts, seq: r.seq, op_name: r.op_name, result: r.result, operator_name: r.operator_name,
        equipment_code: r.equipment?.code ?? null, is_rework: r.is_rework,
        values: r.values.map((v) => ({ name: v.name, value: v.value, unit: v.unit, result: v.result })),
      })),
    };
  }

  // ---------------- 完工入库 ----------------
  /** 完工入库：成品进入成品仓，质量状态为“待放行”（QUARANTINE），DHR 审核放行后才可发货。返回入库单 id */
  async fgReceipt(tx: Tx, user: CurrentUser, woId: number, locationId: number, qty?: number | null): Promise<number> {
    const wo = await this.getWo(tx, woId);
    if (!['IN_PROGRESS', 'COMPLETED'].includes(wo.status)) throw new BizError('工单未开工或已关闭，不能完工入库');
    const status = wo.dhr_status === 'RELEASED' ? 'AVAILABLE' : 'QUARANTINE';
    const t = today();
    const rc = await tx.receipt.create({
      data: { no: await this.numbering.nextNo(tx, 'RK'), receipt_type: 'PRODUCTION', wo_id: wo.id, customer_id: null, receipt_date: t, status: 'CONFIRMED', created_by: user.username },
    });
    const ref: Ref = { ref_type: 'RECEIPT', ref_id: rc.id, ref_no: rc.no, username: user.username, remark: `工单 ${wo.no} 完工入库` };
    const exp = wo.material.shelf_life_days ? addDays(t, wo.material.shelf_life_days) : null;
    let n: number;
    if (wo.material.serial_control) {
      let sns = await tx.serialNumber.findMany({ where: { wo_id: wo.id, status: 'COMPLETED' }, orderBy: { id: 'asc' } });
      if (qty) sns = sns.slice(0, Math.trunc(qty));
      if (!sns.length) throw new BizError('没有可入库的完工产品（需完成全部工序）');
      n = sns.length;
      for (const s of sns) await tx.serialNumber.update({ where: { id: s.id }, data: { status: 'IN_STOCK', location_id: locationId } });
    } else {
      const avail = round((wo.completed_qty || 0) - (wo.received_qty || 0), 4);
      n = qty ? qty : avail;
      if (n <= 0 || n > avail + EPS) throw new BizError(`可入库数量为 ${g(avail)}`);
    }
    await tx.receiptLine.create({
      data: { receipt_id: rc.id, line_no: 1, material_id: wo.material_id, qty: n, lot_no: wo.lot_no || '', location_id: locationId, status, mfg_date: t, expiry_date: exp },
    });
    await this.inv.addStock(tx, {
      material_id: wo.material_id, location_id: locationId, lot_no: wo.lot_no || '', status, qty: n, move_type: 'FG_RECEIPT', ref, mfg_date: t, expiry_date: exp,
    });
    await tx.workOrder.update({ where: { id: wo.id }, data: { received_qty: round((wo.received_qty || 0) + n, 4) } });
    return rc.id;
  }

  // ---------------- DHR ----------------
  async dhrChecks(tx: Tx, woId: number) {
    const wo = await tx.workOrder.findUniqueOrThrow({
      where: { id: woId }, include: { materials: { orderBy: { id: 'asc' }, include: { material: true } } },
    });
    const openNcr = await tx.ncr.count({ where: { wo_id: wo.id, status: 'OPEN' } });
    const done = wo.completed_qty || 0;
    const short = wo.materials.filter((m) => (m.issued_qty || 0) + EPS < (m.qty_per || 0) * done);
    return [
      {
        item: '工单已完工（完工+报废=计划数）', ok: ['COMPLETED', 'CLOSED'].includes(wo.status),
        detail: `完工 ${g(wo.completed_qty)} / 报废 ${g(wo.scrap_qty)} / 计划 ${g(wo.planned_qty)}`,
      },
      {
        item: '物料已按 BOM 足额领用（批次可追溯）', ok: !short.length,
        detail: short.map((m) => `${m.material.code} 已领 ${g(m.issued_qty)} < 应耗 ${g(m.qty_per * done)}`).join('；') || '全部满足',
      },
      { item: '无未处置的不合格品（NCR）', ok: openNcr === 0, detail: `未处置 NCR ${openNcr} 条` },
      {
        item: '完工产品已全部入库', ok: (wo.received_qty || 0) + EPS >= done,
        detail: `已入库 ${g(wo.received_qty)} / 完工 ${g(wo.completed_qty)}`,
      },
    ];
  }

  /** 电子器械生产记录（DHR）：一个工单（生产批）的完整生产/检验/放行记录。 */
  async buildDhr(tx: Tx, woId: number) {
    const wo = await tx.workOrder.findUnique({
      where: { id: woId }, include: { material: true, customer: true, sales_order: true, bom: true, routing: true },
    });
    if (!wo) throw new NotFound('生产工单');
    const p = wo.material;
    const issues = await tx.materialIssueLine.findMany({
      where: { issue: { wo_id: wo.id, status: 'CONFIRMED' } }, orderBy: { id: 'asc' }, include: { material: true },
    });
    const matRows = new Map<string, Record<string, any>>();
    for (const ln of issues) {
      const k = `${ln.material_id}\u0000${ln.lot_no}`;
      let row = matRows.get(k);
      if (!row) {
        row = { material_code: ln.material.code, material_name: ln.material.name, lot_no: ln.lot_no, qty: 0, customer_supplied: !!ln.owner_customer_id };
        const insp = await tx.inspection.findFirst({
          where: { material_id: ln.material_id, lot_no: ln.lot_no }, orderBy: { id: 'desc' }, include: { supplier: true },
        });
        Object.assign(row, { iqc_no: insp?.no ?? null, iqc_status: insp?.status ?? null, supplier_name: insp?.supplier?.name ?? null });
        matRows.set(k, row);
      }
      row.qty = round(row.qty + ln.qty, 4);
    }
    const sns = await tx.serialNumber.findMany({ where: { wo_id: wo.id }, orderBy: { sn: 'asc' } });
    const records = await tx.operationRecord.findMany({
      where: { wo_id: wo.id }, orderBy: { id: 'asc' }, include: { serial: true, equipment: true, values: { orderBy: { id: 'asc' } } },
    });
    const eqIds = [...new Set(records.map((r) => r.equipment_id).filter((x): x is number => !!x))];
    const equipment = eqIds.length ? await tx.equipment.findMany({ where: { id: { in: eqIds } }, orderBy: { id: 'asc' } }) : [];
    const ncrs = await tx.ncr.findMany({ where: { wo_id: wo.id }, orderBy: { id: 'asc' } });
    const sigs = await tx.eSignature.findMany({ where: { entity: 'mes_work_order', entity_id: wo.id }, orderBy: { id: 'asc' } });
    // 一次直通率：每个序列号在该工序的首次结果
    const firstPass = new Map<string, { seq: number; result: string }>();
    for (const r of records) {
      if (r.sn_id === null) continue;
      const k = `${r.seq}\u0000${r.sn_id}`;
      if (!firstPass.has(k)) firstPass.set(k, { seq: r.seq, result: r.result });
    }
    const ops = (await this.woOps(tx, wo.id)).map((o) => {
      const tried = [...firstPass.values()].filter((v) => v.seq === o.seq);
      const fpy = tried.length ? round((tried.filter((v) => v.result === 'PASS').length / tried.length) * 100, 1) : null;
      return { ...opDict(o)!, first_pass_yield: fpy };
    });
    return {
      work_order: {
        id: wo.id, no: wo.no, lot_no: wo.lot_no, status: wo.status, dhr_status: wo.dhr_status,
        planned_qty: wo.planned_qty, completed_qty: wo.completed_qty, scrap_qty: wo.scrap_qty,
        received_qty: wo.received_qty, actual_start: wo.actual_start, actual_end: wo.actual_end,
        so_no: wo.sales_order?.no ?? null, customer_name: wo.customer?.name ?? null, bom_version: wo.bom?.version ?? null,
        routing_version: wo.routing?.version ?? null,
      },
      product: { code: p.code, name: p.name, model: p.model, spec: p.spec, registration_no: p.registration_no, device_class: p.device_class, gtin: p.gtin },
      materials: [...matRows.values()],
      operations: ops,
      serials: sns.map((s) => ({ sn: s.sn, udi: s.udi, status: s.status })),
      records: records.map((r) => ({
        ts: r.ts, sn: r.serial?.sn ?? null, seq: r.seq, op_name: r.op_name, result: r.result, qty: r.qty,
        operator_name: r.operator_name, equipment_code: r.equipment?.code ?? null, is_rework: r.is_rework,
        values: r.values.map((v) => ({ name: v.name, value: v.value, unit: v.unit, lower: v.lower, upper: v.upper, result: v.result })),
      })),
      equipment: equipment.map((e) => ({
        code: e.code, name: e.name, calibration_required: e.calibration_required,
        last_calibration_date: e.last_calibration_date, next_calibration_date: e.next_calibration_date,
      })),
      ncrs: ncrs.map((n) => ({ no: n.no, sn: n.sn, op_name: n.op_name, description: n.description, status: n.status, disposition: n.disposition })),
      signatures: sigs.map((s) => ({ ts: s.ts, full_name: s.full_name, meaning: s.meaning, reason: s.reason })),
      checks: await this.dhrChecks(tx, wo.id),
    };
  }

  /** DHR 审核与产品放行（QA 电子签名）：批准 → 成品批次 待放行→合格、工单关闭；拒绝 → 冻结 */
  async releaseDhr(tx: Tx, user: CurrentUser, woId: number, approve: boolean, sig: SignatureDto | null | undefined, reason?: string | null): Promise<WorkOrder> {
    const wo = await this.getWo(tx, woId);
    if (wo.dhr_status === 'RELEASED') throw new BizError('该批已放行');
    if (approve) {
      const bad = (await this.dhrChecks(tx, wo.id)).filter((c) => !c.ok).map((c) => c.item);
      if (bad.length) throw new BizError('DHR 审核未通过，不能放行：' + bad.join('；'));
    }
    await this.esign.sign(tx, user, sig, approve ? '产品放行（DHR审核批准）' : '产品放行（DHR审核拒绝）', 'mes_work_order', wo.id, wo.no);
    const ref: Ref = { ref_type: 'WORK_ORDER', ref_id: wo.id, ref_no: wo.no, username: user.username, remark: reason ?? null };
    const base = { material_id: wo.material_id, lot_no: wo.lot_no || '', from_status: 'QUARANTINE', ref };
    if (approve) {
      await this.inv.changeLotStatus(tx, { ...base, to_status: 'AVAILABLE', move_type: 'FG_RELEASE' });
      return tx.workOrder.update({ where: { id: wo.id }, data: { dhr_status: 'RELEASED', status: 'CLOSED' } });
    }
    await this.inv.changeLotStatus(tx, { ...base, to_status: 'HOLD', move_type: 'STATUS_CHANGE' });
    return tx.workOrder.update({ where: { id: wo.id }, data: { dhr_status: 'REJECTED' } });
  }
}
