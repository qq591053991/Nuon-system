/**
 * 生产执行核心：工单下达（BOM/工艺快照、批号、序列号+UDI）、工位报工（防跳站、设备校准校验、
 * 测试数据自动判定、不合格自动开 NCR）、完工入库、DHR 汇编与产品放行。
 */
import { Injectable } from '@nestjs/common';
import type { Equipment, Ncr, ProductRelease, SerialNumber, WorkOrder, WorkOrderOperation } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { addDays, fmtDate, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { EPS, g, round } from '../common/num';
import type { Tx } from '../common/prisma.service';
import { config } from '../config';
import { activateDueBoms, releasedBom, releasedRouting } from '../core/engineering';
import { EsignService, type SignatureDto } from '../core/esign.service';
import { InventoryService, STATUS_TEXT as STOCK_STATUS_TEXT, type Ref } from '../core/inventory.service';
import { NumberingService } from '../core/numbering.service';
import { buildUdi } from '../core/udi';
import { keyPartRows } from './key-parts';

export const DISCRETE_UOM = new Set(['PCS', 'PC', 'EA', 'SET', '个', '台', '只', '套', '片', '件', '张', '根', '块', '颗', '盒', '本']);
export const OP_TYPE_TEXT: Record<string, string> = {
  SMT: 'SMT贴片', ASSEMBLY: '组装', TEST_OPTICAL: '光学性能测试', AGING: '老化',
  TEST_SAFETY: '安规测试', INSPECTION: '检验', PACKING: '包装', OTHER: '其他',
};

/** 工序测试规格（工单下达时从工艺路线快照到 params_json） */
export interface OpParam {
  code: string; name: string; unit: string | null; lower: number | null; upper: number | null; target: number | null;
  /** NUMBER = 数值；OKNG = 合格判定（值 1 = OK，0 = NG） */
  param_type?: string | null;
  /** 小数位数（录入限制） */
  decimals?: number | null;
  /** 合理输入范围：超出视为录入错误（拦截，不判不合格） */
  min_valid?: number | null;
  max_valid?: number | null;
}
export interface JudgedValue extends OpParam { value: number; result: 'PASS' | 'FAIL' }

/** OK/NG 判定型测试项在测试数据中的单位标记（值 1 = OK，0 = NG） */
export const OKNG_UNIT = 'OK/NG';

export const EQUIPMENT_TYPE_TEXT: Record<string, string> = { PRODUCTION: '生产设备', TEST: '检测仪器', AGING: '老化设备' };
/** 设备未设置“适用工序”时按设备类型推断（检测仪器只能用于测试/检验工序，老化设备只能用于老化工序） */
const EQUIPMENT_TYPE_OPS: Record<string, string[]> = { TEST: ['TEST_OPTICAL', 'TEST_SAFETY', 'INSPECTION'], AGING: ['AGING'] };

/**
 * 设备能否用于该工序（F08）：设备台账设置了“适用工序类型”时按其判断；未设置时按设备类型推断，
 * 且设备与工序都指定了工作中心时须一致。可用返回 null，否则返回中文原因。
 */
export function equipmentMismatch(
  eq: { code: string; name: string; equipment_type: string; op_types?: string | null; work_center_id?: number | null },
  op: { name: string; op_type: string; work_center_id?: number | null },
): string | null {
  const typeText = OP_TYPE_TEXT[op.op_type] ?? op.op_type;
  const opText = op.name === typeText ? `【${op.name}】` : `【${op.name}】（${typeText}）`;
  const list = (eq.op_types || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (list.length) {
    return list.includes(op.op_type) ? null : `设备 ${eq.code} ${eq.name} 适用于【${list.map((t) => OP_TYPE_TEXT[t] ?? t).join('、')}】工序，不能用于${opText}`;
  }
  const allowed = EQUIPMENT_TYPE_OPS[eq.equipment_type];
  if (allowed && !allowed.includes(op.op_type)) return `设备 ${eq.code} ${eq.name} 是${EQUIPMENT_TYPE_TEXT[eq.equipment_type] ?? eq.equipment_type}，不能用于${opText}`;
  if (eq.work_center_id && op.work_center_id && eq.work_center_id !== op.work_center_id) {
    return `设备 ${eq.code} ${eq.name} 属于其他工作中心，不能用于${opText}；如确需共用，请由设备管理员在设备台账中设置“适用工序”`;
  }
  return null;
}

/** 不良现象代码（工位判不合格时点选，按工序类型） */
export const DEFECT_CODES: Record<string, { code: string; name: string }[]> = {
  SMT: [{ code: 'SMT-SOLDER', name: '虚焊/连锡' }, { code: 'SMT-MISSING', name: '缺件/错件' }, { code: 'SMT-SHIFT', name: '偏移/立碑' }],
  ASSEMBLY: [
    { code: 'ASM-SCRATCH', name: '外观划伤/脏污' }, { code: 'ASM-GAP', name: '装配缝隙/松动' }, { code: 'ASM-SCREW', name: '螺丝缺失/滑牙' },
    { code: 'ASM-CABLE', name: '线材压伤/接插不良' }, { code: 'ASM-KEY', name: '按键失灵' }, { code: 'ASM-POWER', name: '不开机/无显示' },
  ],
  TEST_OPTICAL: [
    { code: 'OPT-WL', name: '波长超差' }, { code: 'OPT-IRR-LOW', name: '辐照度偏低' }, { code: 'OPT-IRR-HIGH', name: '辐照度偏高' },
    { code: 'OPT-LED', name: '灯珠不亮/闪烁' }, { code: 'OPT-UNIFORM', name: '均匀度不良' },
  ],
  AGING: [{ code: 'AGE-CRASH', name: '老化中死机/重启' }, { code: 'AGE-DROP', name: '光衰超差' }, { code: 'AGE-TEMP', name: '温升异常' }, { code: 'AGE-LED', name: '灯珠失效' }],
  TEST_SAFETY: [{ code: 'SAFE-HIPOT', name: '耐压击穿/漏电超标' }, { code: 'SAFE-EARTH', name: '接地电阻超标' }, { code: 'SAFE-INSUL', name: '绝缘不良' }],
  INSPECTION: [
    { code: 'FQC-SCRATCH', name: '外观划伤/脏污' }, { code: 'FQC-LABEL', name: '标签错误/缺失' }, { code: 'FQC-FUNC', name: '功能异常' },
    { code: 'FQC-ACC', name: '配件缺失' }, { code: 'FQC-DOC', name: '说明书/铭牌不符' },
  ],
  PACKING: [{ code: 'PACK-DAMAGE', name: '包装破损' }, { code: 'PACK-ACC', name: '配件缺失' }, { code: 'PACK-LABEL', name: '标签错误' }],
};
const DEFECT_OTHER = { code: 'OTHER', name: '其他（请说明）' };
export const defectCodes = (opType: string | null | undefined) => [...(DEFECT_CODES[opType || ''] ?? []), DEFECT_OTHER];

/** QA 返工处置意见要求更换零件（此时重测前必须先登记返工换件） */
export const REWORK_PARTS_RE = /更换|换件|换新|替换|换上|换掉|换一/;
export type WoOp = WorkOrderOperation & { work_center?: { name: string } | null };

export interface KeyPartInput { lot_no?: string | null; part_sn?: string | null }
export interface ReportSerialArgs {
  sn: string;
  seq?: number | null;
  result?: string | null;
  /** 判不合格时点选的不良现象代码（见 DEFECT_CODES） */
  defect_code?: string | null;
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

/** 返工换件：拆下的零件（批号/部件序列号可选，用于记录拆下的是哪一个） */
export interface ReworkRemovedInput { material_id: number; lot_no?: string | null; part_sn?: string | null; remark?: string | null }
/** 返工换件：装上的零件（从合格库存补领；未指定库位时按 FEFO 在该批次的合格库存中扣减） */
export interface ReworkInstalledInput {
  material_id: number;
  lot_no: string;
  location_id?: number | null;
  qty?: number | null;
  part_sn?: string | null;
  remark?: string | null;
}
export interface ReworkPartsArgs { sn: string; removed?: ReworkRemovedInput[] | null; installed?: ReworkInstalledInput[] | null; remark?: string | null }

/** 分批放行：序列号产品按序列号（为空 = 全部可放行；或按 qty 取前 N 台），批量产品按数量（为空 = 全部可放行数量） */
export interface ReleaseBatchArgs { serials?: string[] | null; qty?: number | null; approve: boolean; reason?: string | null; sig: SignatureDto | null | undefined }

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

/** 数字的小数位数（按十进制文本） */
const decimalsOf = (v: number) => {
  const s = String(v);
  if (/e-/i.test(s)) return Number(s.split(/e-/i)[1]) + ((s.split(/e/i)[0].split('.')[1] || '').length);
  return (s.split('.')[1] || '').length;
};

/** 合理范围文本 */
export const validRangeText = (p: { min_valid?: number | null; max_valid?: number | null; unit?: string | null }) =>
  `${p.min_valid ?? '不限'} ~ ${p.max_valid ?? '不限'}${p.unit ? ` ${p.unit}` : ''}`;

/**
 * 测试数据自动判定：逐项与上下限比较。
 * - OK/NG 型：1 = OK（合格），0 = NG（不合格）；
 * - 超出合理范围 / 小数位过多 = 录入错误，直接拦截（不是不合格判定），防止拼接/错位的数值写进 DHR（C-F01）。
 */
export function judge(params: OpParam[], values: Record<string, number | null | undefined>): JudgedValue[] {
  return params.map((p) => {
    const raw = values[p.code];
    const v = raw === null || raw === undefined || (raw as unknown) === '' ? null : Number(raw);
    const okng = p.param_type === 'OKNG';
    if (v === null || Number.isNaN(v)) throw new BizError(okng ? `请判定测试项【${p.name}】（OK / NG）` : `请录入测试项【${p.name}】的测量值`);
    if (okng) {
      if (v !== 0 && v !== 1) throw new BizError(`测试项【${p.name}】只能判定 OK 或 NG`);
      return { ...p, unit: OKNG_UNIT, lower: null, upper: null, target: null, value: v, result: v === 1 ? 'PASS' : 'FAIL' };
    }
    if ((p.min_valid !== null && p.min_valid !== undefined && v < p.min_valid - EPS) || (p.max_valid !== null && p.max_valid !== undefined && v > p.max_valid + EPS)) {
      throw new BizError(`录入错误：【${p.name}】${g(v)}${p.unit || ''} 超出合理范围（${validRangeText(p)}），请复测后重新录入（不是不合格判定）`);
    }
    if (p.decimals !== null && p.decimals !== undefined && decimalsOf(v) > p.decimals) {
      throw new BizError(`录入错误：【${p.name}】最多 ${p.decimals} 位小数，实际录入 ${g(v)}，请核对后重新录入`);
    }
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
const SN_STATUS_TEXT: Record<string, string> = { COMPLETED: '完工待入库', IN_STOCK: '在库', SHIPPED: '已发货', RETURNED: '客户退回' };
const WO_STATUS_TEXT: Record<string, string> = { PLANNED: '计划', COMPLETED: '已完工', CLOSED: '已关闭', CANCELLED: '已取消' };

@Injectable()
export class ProductionService {
  constructor(
    private readonly numbering: NumberingService,
    private readonly inv: InventoryService,
    private readonly esign: EsignService,
  ) {}

  /** 读取工单；lock=true 时先锁定工单行（SELECT ... FOR UPDATE），防止并发报工/入库造成数量丢失更新或重复下达 */
  async getWo(tx: Tx, woId: number, lock = false) {
    if (lock) await tx.$queryRaw`SELECT id FROM mes_work_order WHERE id = ${woId} FOR NO KEY UPDATE`;
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
    const wo = await this.getWo(tx, woId, true);
    if (wo.status !== 'PLANNED') throw new BizError('只有“计划”状态的工单才能下达');
    const product = wo.material;
    // 生效日期已到的新版 BOM 先转为已发布（D#18）
    await activateDueBoms(tx, product.id);
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
      const params: OpParam[] = op.params.map((p) => ({
        code: p.code, name: p.name, unit: p.unit, lower: p.lower, upper: p.upper, target: p.target,
        param_type: p.param_type || 'NUMBER', decimals: p.decimals ?? null, min_valid: p.min_valid ?? null, max_valid: p.max_valid ?? null,
      }));
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
    const bad = equipmentMismatch(eq, op);
    if (bad) throw new BizError(`${bad}，请选择适用于本工序的设备`);
    return eq;
  }

  /** 设备在工位上能否选用：不可用时返回原因（状态 / 校准过期 / 不适用本工序） */
  equipmentIssue(eq: Equipment, op?: { name: string; op_type: string; work_center_id?: number | null } | null): string | null {
    if (eq.status !== 'NORMAL') return `状态为【${eq.status === 'MAINTENANCE' ? '维修中' : eq.status === 'DISABLED' ? '停用' : eq.status}】`;
    if (eq.calibration_required && (!eq.next_calibration_date || eq.next_calibration_date.getTime() < today().getTime())) {
      return `校准已过期（有效期至 ${fmtDate(eq.next_calibration_date) ?? '未校准'}）`;
    }
    return op ? equipmentMismatch(eq, op) : null;
  }

  /**
   * 人员上岗资质（GMP：人员经培训考核合格后上岗）：报工人须持有该工序代码（或 *）的有效资质——
   * 启用、已生效、未过期，且等级不是“培训中”。可用环境变量 REQUIRE_QUALIFICATION=0 关闭。
   */
  async checkQualification(tx: Tx, user: CurrentUser, op: { code: string; name: string }) {
    if (!config.requireQualification) return;
    const t = today().getTime();
    const rows = await tx.qualification.findMany({ where: { user_id: user.id, is_active: true, op_code: { in: [op.code, '*'] } } });
    const effective = rows.filter((q) => q.certified_at.getTime() <= t && (!q.expires_at || q.expires_at.getTime() >= t));
    if (effective.some((q) => q.level !== 'TRAINEE')) return;
    const label = `${op.code} ${op.name}`;
    if (effective.length) throw new BizError(`您在工序【${label}】仍为培训期，尚未取得独立上岗资质，请完成考核后由质量部登记`);
    const expired = rows.filter((q) => q.expires_at && q.expires_at.getTime() < t).sort((a, b) => b.expires_at!.getTime() - a.expires_at!.getTime())[0];
    if (expired) throw new BizError(`您的工序【${label}】上岗资质已于 ${fmtDate(expired.expires_at)} 过期，请联系质量部重新培训考核`);
    throw new BizError(`您尚未取得工序【${label}】的上岗资质，请联系质量部培训考核`);
  }

  /** 已领用（过账）到工单、且未全部退回的某物料批次 */
  async issuedLots(tx: Tx, woId: number, materialId: number): Promise<Set<string>> {
    const rows = await tx.materialIssueLine.findMany({
      where: { material_id: materialId, issue: { wo_id: woId, status: 'CONFIRMED' } },
      select: { lot_no: true, qty: true, issue: { select: { issue_type: true } } },
    });
    const net = new Map<string, number>();
    for (const r of rows) net.set(r.lot_no, round((net.get(r.lot_no) ?? 0) + (r.issue.issue_type === 'RETURN' ? -r.qty : r.qty), 4));
    return new Set([...net].filter(([, q]) => q > EPS).map(([lot]) => lot));
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
    const found = await this.getSn(tx, a.sn);
    const wo = await this.getWo(tx, found.wo_id, true);
    const sn = (await tx.serialNumber.findUnique({ where: { id: found.id } }))!; // 锁定工单后重新读取
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
    await this.checkQualification(tx, user, op);
    // 返工重测：QA 处置意见要求换件时，必须先登记返工换件（拆下/装上），保证单台追溯完整（F17）
    if (this.underRework(sn) && sn.ng_seq === op.seq) {
      const rn = await this.reworkNcr(tx, sn);
      if (rn && REWORK_PARTS_RE.test(rn.disposition_remark || '')) {
        const n = await tx.keyPartBinding.count({ where: { sn_id: sn.id, ncr_id: rn.id, action: { in: ['REMOVE', 'INSTALL'] } } });
        if (!n) {
          throw new BizError(`QA 处置意见要求更换零件（“${rn.disposition_remark}”），请先在【返工换件】中登记拆下/装上的零件，再重新测试（${rn.no}）`);
        }
      }
    }
    // 判不合格：点选不良现象或填写原因（F16）
    const defect = a.defect_code ? defectCodes(op.op_type).find((d) => d.code === a.defect_code) : null;
    if (a.defect_code && !defect) throw new BizError(`不良现象代码 ${a.defect_code} 不适用于工序【${op.name}】`);
    if (a.result === 'FAIL' && !defect && !a.remark?.trim()) throw new BizError('判不合格请选择不良现象或填写原因');
    if (defect?.code === 'OTHER' && !a.remark?.trim()) throw new BizError('选择“其他”时请说明不良现象');
    const remark = [defect && defect.code !== 'OTHER' ? `【${defect.name}】` : null, a.remark?.trim() || null].filter(Boolean).join(' ').slice(0, 256) || null;
    const eq = await this.checkEquipment(tx, op, a.equipment_id);
    const params = opParams(op);
    const vals = a.values || {};
    // 人工判不合格（如灯珠不亮无法测量）时只记录已测的项
    const toJudge = a.result === 'FAIL' ? params.filter((p) => vals[p.code] !== null && vals[p.code] !== undefined && (vals[p.code] as unknown) !== '') : params;
    const judged = toJudge.length ? judge(toJudge, vals) : [];
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
        remark,
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
      const fails = judged
        .filter((j) => j.result === 'FAIL')
        .map((j) => (j.unit === OKNG_UNIT ? `${j.name}=NG` : `${j.name}=${g(j.value)}${j.unit || ''}(规格 ${specText(j)})`));
      const desc = `工序【${op.seq} ${op.name}】判定不合格。` + fails.join('；') + (remark ? ` 不良现象/备注：${remark}` : '');
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
    const wo = await this.getWo(tx, woId, true);
    const good = Number(a.good_qty || 0);
    const ng = Number(a.ng_qty || 0);
    if (wo.material.serial_control) throw new BizError('序列号管理的产品请逐台扫码报工');
    if (!ACTIVE.includes(wo.status)) throw new BizError(`工单 ${wo.no} 状态为【${wo.status}】，不能报工`);
    if (good < 0 || ng < 0 || good + ng <= 0) throw new BizError('报工数量必须大于 0');
    const ops = await this.woOps(tx, wo.id);
    const idx = ops.findIndex((o) => o.seq === a.seq);
    if (idx < 0) throw new BizError('工序不存在');
    const op = ops[idx];
    await this.checkQualification(tx, user, op);
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
  /**
   * 工位扫码：产品、工单、工序进度、下一道工序及测试规格、生产履历。
   * stationOp = 本工位锁定的工序编码时，附带 station 判定（F04）：能否在本工位作业；不能时说明原因、
   * 已由谁何时在本工位测过、应送往哪道工序（工位直接整块红色提示，不显示录入表）。
   */
  async scanSerial(tx: Tx, snText: string, stationOp?: string | null) {
    const sn = await this.getSn(tx, snText);
    const wo = await tx.workOrder.findUniqueOrThrow({ where: { id: sn.wo_id }, include: { material: true, customer: true } });
    const ops = await this.woOps(tx, wo.id);
    const nxt = ['CREATED', 'IN_PROCESS'].includes(sn.status) ? nextOperation(ops, sn) : null;
    const recs = await tx.operationRecord.findMany({
      where: { sn_id: sn.id }, orderBy: { id: 'asc' }, include: { equipment: true, values: { orderBy: { id: 'asc' } } },
    });
    const openNcr = await tx.ncr.findFirst({ where: { sn: sn.sn, status: 'OPEN' }, orderBy: { id: 'asc' } });
    const kpm = nxt?.key_part_material_id ? await tx.material.findUnique({ where: { id: nxt.key_part_material_id } }) : null;
    const reworkNcr = this.underRework(sn) ? await this.reworkNcr(tx, sn) : null;
    const reworkOp = reworkNcr ? ops.find((o) => o.seq === sn.ng_seq) : null;
    const keyParts = await keyPartRows(tx, { sn_id: sn.id });
    // 作业指导附件（挂在工艺路线工序上，按工序编码对应）
    const rop = nxt && wo.routing_id ? await tx.routingOperation.findFirst({ where: { routing_id: wo.routing_id, code: nxt.code } }) : null;
    const attachments = rop
      ? (await tx.attachment.findMany({ where: { entity: 'eng_routing_op', entity_id: rop.id }, orderBy: { id: 'asc' } }))
          .map((a) => ({ id: a.id, filename: a.filename, content_type: a.content_type, size: a.size }))
      : [];
    const p = wo.material;
    return {
      sn: sn.sn, udi: sn.udi, status: sn.status, lot_no: sn.lot_no, last_seq: sn.last_seq,
      wo: {
        id: wo.id, no: wo.no, status: wo.status, planned_qty: wo.planned_qty, completed_qty: wo.completed_qty, customer_name: wo.customer?.name ?? null,
        routing_id: wo.routing_id,
      },
      product: { id: p.id, code: p.code, name: p.name, model: p.model, spec: p.spec },
      operations: ops.map((o) => ({ seq: o.seq, code: o.code, name: o.name, op_type: o.op_type, done: o.seq <= (sn.last_seq || 0) })),
      next_operation: nxt ? { ...opDict(nxt)!, attachments } : null,
      key_part_material: kpm ? { id: kpm.id, code: kpm.code, name: kpm.name } : null,
      open_ncr: openNcr?.no ?? null,
      /** 判不合格时可点选的不良现象（按下一道工序类型） */
      defect_codes: defectCodes(nxt?.op_type),
      /** 本工位判定（传入 op 时） */
      station: stationOp ? this.stationCheck(sn, wo, ops, nxt, recs, openNcr?.no ?? null, stationOp) : null,
      /** 返工中（NCR 处置为返工、尚未重新测试通过）：可登记返工换件 */
      rework: reworkNcr
        ? {
            ncr_id: reworkNcr.id, ncr_no: reworkNcr.no, ng_seq: sn.ng_seq, op_name: reworkOp?.name ?? reworkNcr.op_name,
            description: reworkNcr.description, disposition_remark: reworkNcr.disposition_remark,
            /** QA 意见要求换件：重测前必须先登记 */
            require_parts: REWORK_PARTS_RE.test(reworkNcr.disposition_remark || ''),
            /** 本次返工已登记的换件条数 */
            registered: keyParts.filter((k) => k.ncr_id === reworkNcr.id && k.action !== 'BIND').length,
            /** 拆下件候选：本机已绑定的关键件 + 工单 BOM 用料（含已领批次），供工位一键选择 */
            candidates: await this.reworkCandidates(tx, wo.id, keyParts),
          }
        : null,
      /** 关键件绑定与返工换件记录（BIND/REMOVE/INSTALL） */
      key_parts: keyParts,
      history: recs.map((r) => ({
        ts: r.ts, seq: r.seq, op_name: r.op_name, result: r.result, operator_name: r.operator_name,
        equipment_code: r.equipment?.code ?? null, is_rework: r.is_rework, remark: r.remark,
        values: r.values.map((v) => ({ name: v.name, value: v.value, unit: v.unit, result: v.result })),
      })),
    };
  }

  /** 本工位能否对该序列号作业；不能时给出整块提示的标题与说明 */
  private stationCheck(
    sn: SerialNumber, wo: WorkOrder, ops: WoOp[], nxt: WoOp | null,
    recs: { ts: Date; seq: number; result: string; operator_name: string | null }[], openNcr: string | null, stationOp: string,
  ) {
    const code = stationOp.trim().toUpperCase();
    const target = ops.find((o) => o.code.toUpperCase() === code) ?? null;
    const at = (d: Date) => new Intl.DateTimeFormat('zh-CN', {
      timeZone: config.timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d).replace(/\//g, '-');
    const last = (seq: number) => [...recs].reverse().find((r) => r.seq === seq) ?? null;
    const tested = target ? last(target.seq) : null;
    const testedText = tested
      ? `该序列号已于 ${at(tested.ts)} 由 ${tested.operator_name ?? '-'} 在【${target!.seq} ${target!.name}】测过（${tested.result === 'PASS' ? '合格' : '不合格'}）`
      : null;
    const sendTo = nxt ? { seq: nxt.seq, code: nxt.code, name: nxt.name } : null;
    const out = (kind: string, title: string, message: string) => ({
      ok: false, kind, title, message, op_code: code, op_name: target?.name ?? null, send_to: sendTo,
      tested: tested ? { ts: tested.ts, operator_name: tested.operator_name, result: tested.result, seq: tested.seq } : null,
    });
    if (sn.status === 'SCRAPPED') return out('SCRAPPED', '该产品已报废', '已报废的产品禁止继续生产，请放入报废品区');
    if (sn.status === 'NG') return out('NG', '该产品不合格，待 QA 处置', `存在未处置的不合格报告 ${openNcr ?? ''}，请贴不良标识放入不良品区，等待 QA 评审处置（返工/报废）`);
    if (['COMPLETED', 'IN_STOCK', 'SHIPPED'].includes(sn.status)) {
      return out('DONE', '该产品已完成全部工序', `${testedText ? `${testedText}；` : ''}当前状态：${SN_STATUS_TEXT[sn.status] ?? sn.status}，无需再测`);
    }
    if (!ACTIVE.includes(wo.status)) return out('WO', `工单 ${wo.no} 不能报工`, `工单当前为【${WO_STATUS_TEXT[wo.status] ?? wo.status}】，请联系计划员`);
    if (!target) {
      return out('NOT_IN_ROUTING', '该产品不经过本工位', `产品工艺路线中没有本工位工序【${code}】${sendTo ? `，应送往【${sendTo.seq} ${sendTo.name}】工序` : ''}`);
    }
    if (!nxt) return out('DONE', '该产品没有待执行的工序', testedText ?? '请核对序列号');
    if (nxt.seq === target.seq) return { ok: true, kind: 'OK', title: '', message: '', op_code: code, op_name: target.name, send_to: sendTo, tested: null };
    if (nxt.seq > target.seq) {
      return out('PASSED', '该序列号已过本工位', `${testedText ?? `该产品已通过【${target.seq} ${target.name}】`}，应送往【${nxt.seq} ${nxt.name}】工序`);
    }
    return out('EARLY', '工序未到，禁止跳站', `该产品尚未完成【${nxt.seq} ${nxt.name}】，应先送往【${nxt.seq} ${nxt.name}】工序`);
  }

  /** 返工拆下件候选：本机已绑定的关键件（带批号/部件序列号）+ 工单 BOM 用料（带已领批次） */
  private async reworkCandidates(tx: Tx, woId: number, keyParts: { action: string; material_id: number; material_code: string | null; material_name: string | null; lot_no: string | null; part_sn: string | null }[]) {
    const out: { material_id: number; code: string; name: string; source: 'BIND' | 'BOM'; lot_no: string | null; part_sn: string | null; lots: string[] }[] = [];
    for (const k of keyParts.filter((x) => x.action === 'BIND' || x.action === 'INSTALL')) {
      out.push({ material_id: k.material_id, code: k.material_code ?? '', name: k.material_name ?? '', source: 'BIND', lot_no: k.lot_no, part_sn: k.part_sn, lots: k.lot_no ? [k.lot_no] : [] });
    }
    const mats = await tx.workOrderMaterial.findMany({ where: { wo_id: woId }, orderBy: { id: 'asc' }, include: { material: true } });
    for (const m of mats) {
      if (out.some((o) => o.material_id === m.material_id)) continue;
      const lots = [...(await this.issuedLots(tx, woId, m.material_id))].sort();
      out.push({ material_id: m.material_id, code: m.material.code, name: m.material.name, source: 'BOM', lot_no: lots.length === 1 ? lots[0] : null, part_sn: null, lots });
    }
    return out;
  }

  /** 关键件扫码即时校验（F15）：批号须是本工单已领用的批次 */
  async checkKeyPart(tx: Tx, snText: string, lotNo: string) {
    const sn = await this.getSn(tx, snText);
    const wo = await tx.workOrder.findUniqueOrThrow({ where: { id: sn.wo_id } });
    const op = nextOperation(await this.woOps(tx, wo.id), sn);
    if (!op?.key_part_material_id) return { ok: true, message: null };
    const lot = (lotNo || '').trim();
    if (!lot) return { ok: false, message: '请扫描关键件批号' };
    const lots = await this.issuedLots(tx, wo.id, op.key_part_material_id);
    if (lots.size && !lots.has(lot)) {
      return { ok: false, message: `关键件批号 ${lot} 未领用到工单 ${wo.no}（已领批次：${[...lots].sort().join(', ')}），请核对后重扫` };
    }
    return { ok: true, message: null };
  }

  // ---------------- 返工换件 ----------------
  /** 返工中：NCR 处置为返工后（ng_seq 保留、状态回到在制），在重新通过该工序之前 */
  underRework(sn: SerialNumber): boolean {
    return sn.ng_seq !== null && sn.ng_seq !== undefined && sn.status === 'IN_PROCESS';
  }

  /** 该序列号最近一张“返工”处置的 NCR */
  reworkNcr(tx: Tx, sn: SerialNumber): Promise<Ncr | null> {
    return tx.ncr.findFirst({ where: { sn: sn.sn, disposition: 'REWORK', status: { in: ['DISPOSITIONED', 'CLOSED'] } }, orderBy: { id: 'desc' } });
  }

  /**
   * 返工换件登记（单台追溯）：拆下的零件记 REMOVE；装上的零件记 INSTALL，并从合格库存补领（REWORK_ISSUE，关联 NCR）——
   * 批次须为合格状态、未过期、不在不合格品区，客供料只能用于该客户的工单；物料在工单 BOM 中时累加工单已领数量。
   */
  async reworkParts(tx: Tx, user: CurrentUser, a: ReworkPartsArgs) {
    const found = await this.getSn(tx, a.sn);
    const wo = await this.getWo(tx, found.wo_id, true);
    const sn = (await tx.serialNumber.findUnique({ where: { id: found.id } }))!;
    if (!this.underRework(sn)) {
      throw new BizError(`${sn.sn} 不在返工中：只有 NCR 处置为“返工”、尚未重新通过不合格工序的产品才能登记返工换件`);
    }
    if (!ACTIVE.includes(wo.status)) throw new BizError(`工单 ${wo.no} 状态为【${wo.status}】，不能登记返工换件`);
    const ncr = await this.reworkNcr(tx, sn);
    if (!ncr) throw new BizError(`未找到 ${sn.sn} 的返工处置 NCR，请先由 QA 评审处置为“返工”`);
    const removed = (a.removed ?? []).filter(Boolean);
    const installed = (a.installed ?? []).filter(Boolean);
    if (!removed.length && !installed.length) throw new BizError('请登记拆下或装上的零件');
    const now = new Date();
    const clean = (v?: string | null) => (v && v.trim() ? v.trim() : null);
    const note = (r?: string | null) => [clean(r), clean(a.remark)].filter(Boolean).join('；') || null;
    const created: number[] = [];

    for (const r of removed) {
      const m = await tx.material.findUnique({ where: { id: r.material_id } });
      if (!m) throw new NotFound('物料');
      const kp = await tx.keyPartBinding.create({
        data: {
          ts: now, sn_id: sn.id, material_id: m.id, lot_no: clean(r.lot_no), part_sn: clean(r.part_sn), operator: user.username,
          action: 'REMOVE', ncr_id: ncr.id, remark: note(r.remark),
        },
      });
      created.push(kp.id);
    }

    const ref: Ref = { ref_type: 'NCR', ref_id: ncr.id, ref_no: ncr.no, username: user.username, remark: `返工换件 ${sn.sn}（工单 ${wo.no}）` };
    const t = today().getTime();
    for (const r of installed) {
      const m = await tx.material.findUnique({ where: { id: r.material_id } });
      if (!m) throw new NotFound('物料');
      const lot = (r.lot_no || '').trim();
      if (!lot && m.lot_control) throw new BizError(`请扫描装上零件 ${m.code} 的批号`);
      const qty = r.qty === null || r.qty === undefined ? 1 : Number(r.qty);
      if (!(qty > 0)) throw new BizError(`${m.code} 数量必须大于 0`);
      if (m.owner_customer_id && m.owner_customer_id !== wo.customer_id) throw new BizError(`${m.code} 为其他客户的客供料，不能用于本工单`);
      const rows = await tx.stock.findMany({
        where: { material_id: m.id, lot_no: lot, qty: { gt: EPS }, ...(r.location_id ? { location_id: r.location_id } : {}) },
        include: { location: true },
        orderBy: { id: 'asc' },
      });
      if (!rows.length) throw new BizError(`批次 ${lot || '-'} 没有 ${m.code} 的库存${r.location_id ? '（所选库位）' : ''}`);
      const ok = rows.filter((s) => s.status === 'AVAILABLE');
      if (!ok.length) {
        throw new BizError(`批次 ${lot} 质量状态为【${[...new Set(rows.map((s) => s.status))].map((x) => STOCK_STATUS_TEXT[x] ?? x).join('/')}】，不能用于返工`);
      }
      const ownerOk = ok.filter((s) => s.owner_customer_id === null || s.owner_customer_id === wo.customer_id);
      if (!ownerOk.length) throw new BizError(`批次 ${lot} 为其他客户的客供料，不能用于本工单`);
      const notRej = ownerOk.filter((s) => s.location.location_type !== 'REJECT');
      if (!notRej.length) throw new BizError(`批次 ${lot} 位于不合格品区，不能使用`);
      const fresh = notRej.filter((s) => !s.expiry_date || s.expiry_date.getTime() >= t);
      if (!fresh.length) throw new BizError(`批次 ${lot} 已过期（${fmtDate(notRej[0].expiry_date)}），禁止使用`);
      // 指定库位：只从该库位扣；否则按先到期先出在该批次的合格库存中扣减
      fresh.sort((x, y) => (x.expiry_date?.getTime() ?? Infinity) - (y.expiry_date?.getTime() ?? Infinity) || x.id - y.id);
      const have = round(fresh.reduce((s, x) => s + x.qty, 0));
      if (have + EPS < qty) throw new BizError(`库存不足：${m.code} 批次 ${lot} 合格可用 ${g(have)}，需要 ${g(qty)}`);
      let remain = qty;
      for (const st of fresh) {
        if (remain <= EPS) break;
        const q = round(Math.min(st.qty, remain));
        await this.inv.removeStock(tx, {
          material_id: m.id, location_id: st.location_id, lot_no: lot, status: 'AVAILABLE', qty: q,
          owner_customer_id: st.owner_customer_id, move_type: 'REWORK_ISSUE', ref,
        });
        remain = round(remain - q);
      }
      const wm = await tx.workOrderMaterial.findFirst({ where: { wo_id: wo.id, material_id: m.id } });
      if (wm) await tx.workOrderMaterial.update({ where: { id: wm.id }, data: { issued_qty: round((wm.issued_qty || 0) + qty) } });
      const kp = await tx.keyPartBinding.create({
        data: {
          ts: now, sn_id: sn.id, material_id: m.id, lot_no: lot || null, part_sn: clean(r.part_sn), operator: user.username,
          action: 'INSTALL', ncr_id: ncr.id, remark: [qty !== 1 ? `数量 ${g(qty)} ${m.uom}` : null, note(r.remark)].filter(Boolean).join('；') || null,
        },
      });
      created.push(kp.id);
    }
    return {
      sn: sn.sn, ncr_no: ncr.no, removed: removed.length, installed: installed.length,
      key_parts: await keyPartRows(tx, { sn_id: sn.id }),
      created_ids: created,
    };
  }

  // ---------------- 完工入库 ----------------
  /** 完工入库：成品进入成品仓，质量状态为“待放行”（QUARANTINE），DHR 审核放行后才可发货。返回入库单 id */
  async fgReceipt(tx: Tx, user: CurrentUser, woId: number, locationId: number, qty?: number | null): Promise<number> {
    const wo = await this.getWo(tx, woId, true);
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
      where: { issue: { wo_id: wo.id, status: 'CONFIRMED' } }, orderBy: { id: 'asc' }, include: { material: true, issue: true },
    });
    const ncrs = await tx.ncr.findMany({ where: { wo_id: wo.id }, orderBy: { id: 'asc' } });
    // 返工换件补领（REWORK_ISSUE，关联本工单的 NCR）也计入物料批次追溯
    const reworkMoves = ncrs.length
      ? await tx.stockMove.findMany({
          where: { move_type: 'REWORK_ISSUE', ref_type: 'NCR', ref_id: { in: ncrs.map((n) => n.id) } }, orderBy: { id: 'asc' }, include: { material: true },
        })
      : [];
    const matRows = new Map<string, Record<string, any>>();
    const lines = [
      // 退料单冲减领用数量
      ...issues.map((ln) => ({ ...ln, qty: ln.issue.issue_type === 'RETURN' ? -ln.qty : ln.qty, source: 'ISSUE' })),
      ...reworkMoves.map((mv) => ({ material_id: mv.material_id, material: mv.material, lot_no: mv.lot_no, qty: mv.qty, owner_customer_id: mv.owner_customer_id, source: 'REWORK' })),
    ];
    for (const ln of lines) {
      const k = `${ln.material_id}\u0000${ln.lot_no}\u0000${ln.source}`;
      let row = matRows.get(k);
      if (!row) {
        row = {
          material_code: ln.material.code, material_name: ln.material.name, lot_no: ln.lot_no, qty: 0, customer_supplied: !!ln.owner_customer_id,
          source: ln.source,
        };
        const insp = await tx.inspection.findFirst({
          where: { material_id: ln.material_id, lot_no: ln.lot_no }, orderBy: { id: 'desc' }, include: { supplier: true },
        });
        Object.assign(row, { iqc_no: insp?.no ?? null, iqc_status: insp?.status ?? null, supplier_name: insp?.supplier?.name ?? null });
        matRows.set(k, row);
      }
      row.qty = round(row.qty + ln.qty, 4);
    }
    const sns = await tx.serialNumber.findMany({ where: { wo_id: wo.id }, orderBy: { sn: 'asc' }, include: { release: true } });
    const records = await tx.operationRecord.findMany({
      where: { wo_id: wo.id }, orderBy: { id: 'asc' }, include: { serial: true, equipment: true, values: { orderBy: { id: 'asc' } } },
    });
    const eqIds = [...new Set(records.map((r) => r.equipment_id).filter((x): x is number => !!x))];
    const equipment = eqIds.length ? await tx.equipment.findMany({ where: { id: { in: eqIds } }, orderBy: { id: 'asc' } }) : [];
    const releases = await this.releaseList(tx, wo.id);
    const sigs = await tx.eSignature.findMany({
      where: {
        OR: [
          { entity: 'mes_work_order', entity_id: wo.id },
          ...(releases.length ? [{ entity: 'mes_product_release', entity_id: { in: releases.map((r) => r.id) } }] : []),
        ],
      },
      orderBy: { id: 'asc' },
    });
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
        received_qty: wo.received_qty, released_qty: wo.released_qty, actual_start: wo.actual_start, actual_end: wo.actual_end,
        so_no: wo.sales_order?.no ?? null, customer_name: wo.customer?.name ?? null, bom_version: wo.bom?.version ?? null,
        routing_version: wo.routing?.version ?? null, serial_control: p.serial_control, uom: p.uom,
      },
      product: { code: p.code, name: p.name, model: p.model, spec: p.spec, registration_no: p.registration_no, device_class: p.device_class, gtin: p.gtin },
      materials: [...matRows.values()].filter((r) => r.qty > EPS), // 已全部退回的批次不计入
      operations: ops,
      serials: sns.map((s) => ({ sn: s.sn, udi: s.udi, status: s.status, release_no: s.release?.no ?? null, release_status: s.release?.status ?? null })),
      records: records.map((r) => ({
        ts: r.ts, sn: r.serial?.sn ?? null, seq: r.seq, op_name: r.op_name, result: r.result, qty: r.qty,
        operator_name: r.operator_name, equipment_code: r.equipment?.code ?? null, is_rework: r.is_rework,
        values: r.values.map((v) => ({ name: v.name, value: v.value, unit: v.unit, lower: v.lower, upper: v.upper, result: v.result })),
      })),
      /** 关键件绑定 + 返工换件（拆下/装上，关联 NCR） */
      key_parts: await keyPartRows(tx, { serial: { wo_id: wo.id } }),
      equipment: equipment.map((e) => ({
        code: e.code, name: e.name, calibration_required: e.calibration_required,
        last_calibration_date: e.last_calibration_date, next_calibration_date: e.next_calibration_date,
      })),
      ncrs: ncrs.map((n) => ({ no: n.no, sn: n.sn, op_name: n.op_name, description: n.description, status: n.status, disposition: n.disposition })),
      releases,
      release_summary: await this.releaseSummary(tx, wo.id),
      signatures: sigs.map((s) => ({ ts: s.ts, full_name: s.full_name, meaning: s.meaning, reason: s.reason, doc_no: s.doc_no })),
      checks: await this.dhrChecks(tx, wo.id),
    };
  }

  // ---------------- 产品放行（分批 / 整单） ----------------
  /** 工单的放行批记录（含序列号清单），按时间顺序 */
  async releaseList(tx: Tx, woId: number) {
    const rows = await tx.productRelease.findMany({
      where: { wo_id: woId }, orderBy: { id: 'asc' }, include: { serials: { orderBy: { sn: 'asc' }, select: { sn: true } } },
    });
    return rows.map(({ serials, ...r }) => ({ ...r, sn_list: serials.map((s) => s.sn) }));
  }

  /** 已拒绝放行（冻结）的数量 */
  private async rejectedQty(tx: Tx, woId: number): Promise<number> {
    const r = await tx.productRelease.aggregate({ where: { wo_id: woId, status: 'REJECTED' }, _sum: { qty: true } });
    return round(r._sum.qty ?? 0);
  }

  /** 最后一道工序号（序列号已完成全部工序的判定） */
  private async lastSeq(tx: Tx, woId: number): Promise<number> {
    const r = await tx.workOrderOperation.aggregate({ where: { wo_id: woId }, _max: { seq: true } });
    return r._max.seq ?? 0;
  }

  /** 可放行的序列号：已完工入库、完成全部工序、尚未进入任何放行批；有未处置 NCR 的单独列出 */
  private async eligibleSerials(tx: Tx, woId: number) {
    const last = await this.lastSeq(tx, woId);
    const sns = await tx.serialNumber.findMany({
      where: { wo_id: woId, status: 'IN_STOCK', release_id: null },
      orderBy: [{ completed_at: 'asc' }, { sn: 'asc' }],
      include: { location: true },
    });
    const open = sns.length ? await tx.ncr.findMany({ where: { sn: { in: sns.map((s) => s.sn) }, status: 'OPEN' }, orderBy: { id: 'asc' } }) : [];
    const ncrOf = new Map(open.map((n) => [n.sn!, n.no]));
    const eligible: typeof sns = [];
    const blocked: { sn: string; reason: string }[] = [];
    for (const s of sns) {
      if (ncrOf.has(s.sn)) blocked.push({ sn: s.sn, reason: `存在未处置的不合格（${ncrOf.get(s.sn)}）` });
      else if ((s.last_seq || 0) < last) blocked.push({ sn: s.sn, reason: '未完成全部工序' });
      else eligible.push(s);
    }
    return { eligible, blocked };
  }

  /** 放行概况：已入库 / 已放行 / 已拒绝 / 可放行，以及可放行的序列号清单 */
  async releaseSummary(tx: Tx, woId: number) {
    const wo = await tx.workOrder.findUnique({ where: { id: woId }, include: { material: true } });
    if (!wo) throw new NotFound('生产工单');
    const rejected = await this.rejectedQty(tx, wo.id);
    const serial = wo.material.serial_control;
    const open = wo.dhr_status === 'OPEN' && ['IN_PROGRESS', 'COMPLETED'].includes(wo.status);
    let releasable = 0;
    let serials: Record<string, any>[] = [];
    let blocked: { sn: string; reason: string }[] = [];
    let openNcr = 0;
    if (serial) {
      const e = await this.eligibleSerials(tx, wo.id);
      serials = e.eligible.map((s) => ({ sn: s.sn, udi: s.udi, completed_at: s.completed_at, location_code: s.location?.code ?? null }));
      blocked = e.blocked;
      releasable = open ? serials.length : 0;
    } else {
      openNcr = await tx.ncr.count({ where: { wo_id: wo.id, status: 'OPEN' } });
      releasable = open ? Math.max(0, round((wo.received_qty || 0) - (wo.released_qty || 0) - rejected)) : 0;
    }
    return {
      serial_control: serial, uom: wo.material.uom, status: wo.status, dhr_status: wo.dhr_status,
      completed_qty: wo.completed_qty, received_qty: wo.received_qty, released_qty: wo.released_qty, rejected_qty: rejected,
      releasable_qty: releasable, serials: open ? serials : [], blocked, open_ncr: openNcr,
    };
  }

  /**
   * 把成品批次中指定数量的“待放行”库存转为合格（放行）或冻结（拒绝）：优先从序列号所在库位转，不足时从该批次其他库位补足；
   * 只转本次放行的数量（不影响同批号其他待放行库存，如尚未审核的批、退货品）。
   */
  private async moveReleaseQty(tx: Tx, wo: WorkOrder, qty: number, toStatus: string, moveType: string, ref: Ref, prefer = new Map<number, number>()) {
    const lot = wo.lot_no || '';
    const rows = await tx.stock.findMany({
      where: { material_id: wo.material_id, lot_no: lot, status: 'QUARANTINE', owner_customer_id: null, qty: { gt: EPS } }, orderBy: { id: 'asc' },
    });
    const have = new Map<number, number>();
    for (const r of rows) have.set(r.location_id, round((have.get(r.location_id) ?? 0) + r.qty));
    const plan = new Map<number, number>();
    let remain = round(qty);
    const take = (loc: number, want: number) => {
      const q = round(Math.min(have.get(loc) ?? 0, want));
      if (q <= EPS) return;
      have.set(loc, round(have.get(loc)! - q));
      plan.set(loc, round((plan.get(loc) ?? 0) + q));
      remain = round(remain - q);
    };
    for (const [loc, q] of prefer) if (remain > EPS) take(loc, Math.min(q, remain));
    for (const loc of [...have.keys()]) if (remain > EPS) take(loc, remain);
    if (remain > EPS) {
      throw new BizError(`成品批次 ${lot || '-'} 的“待放行”库存不足：本次 ${g(qty)}，缺 ${g(remain)}（请核对完工入库与库存调整记录）`);
    }
    for (const [loc, q] of plan) {
      await this.inv.moveStock(tx, {
        material_id: wo.material_id, lot_no: lot, qty: q, from_location_id: loc, to_location_id: loc,
        from_status: 'QUARANTINE', to_status: toStatus, move_type: moveType, ref,
      });
    }
  }

  /** 创建放行批：写放行记录、序列号归批、转换库存状态（不含电子签名与工单数量更新） */
  private async createRelease(
    tx: Tx, user: CurrentUser, wo: WorkOrder, units: { id: number; location_id: number | null }[], qty: number, approve: boolean, reason: string | null,
  ): Promise<ProductRelease> {
    const rel = await tx.productRelease.create({
      data: {
        no: await this.numbering.nextNo(tx, 'FX'), wo_id: wo.id, qty, status: approve ? 'RELEASED' : 'REJECTED', reason,
        released_by: user.full_name, released_at: new Date(), created_by: user.username,
      },
    });
    if (units.length) await tx.serialNumber.updateMany({ where: { id: { in: units.map((u) => u.id) } }, data: { release_id: rel.id } });
    const prefer = new Map<number, number>();
    for (const u of units) if (u.location_id) prefer.set(u.location_id, (prefer.get(u.location_id) ?? 0) + 1);
    const ref: Ref = {
      ref_type: 'PRODUCT_RELEASE', ref_id: rel.id, ref_no: rel.no, username: user.username,
      remark: `工单 ${wo.no} ${approve ? '放行' : '拒绝放行（冻结）'}${reason ? '：' + reason : ''}`.slice(0, 250),
    };
    await this.moveReleaseQty(tx, wo, qty, approve ? 'AVAILABLE' : 'HOLD', approve ? 'FG_RELEASE' : 'STATUS_CHANGE', ref, prefer);
    return rel;
  }

  /** 已完工、全部入库且全部放行 → DHR 已放行、工单关闭（须满足整单放行检查） */
  private async maybeCloseAfterRelease(tx: Tx, wo: WorkOrder, releasedQty: number, upd: Record<string, any>) {
    if (wo.status !== 'COMPLETED') return;
    const received = wo.received_qty || 0;
    if (received + EPS < (wo.completed_qty || 0) || releasedQty + EPS < received) return;
    const bad = (await this.dhrChecks(tx, wo.id)).filter((c) => !c.ok);
    if (!bad.length) Object.assign(upd, { dhr_status: 'RELEASED', status: 'CLOSED' });
  }

  /**
   * DHR 分批放行（QA 电子签名“产品放行（分批）”）：
   *   序列号产品：放行所选的已入库、未放行序列号（默认全部可放行；或按 qty 取完工最早的 N 台）；
   *   批量产品：放行数量 ≤ 已入库 − 已放行 − 已拒绝。
   * 每批校验：产品已完成全部工序；这些产品（批量产品为整张工单）没有未处置 NCR；物料已领 ≥ 单耗 × 放行后累计数量。
   * 批准 → 该数量成品 待放行→合格，可发货；拒绝 → 冻结（HOLD）。全部入库产品都放行且工单已完工 → DHR 已放行、工单关闭。
   */
  async releaseBatch(tx: Tx, user: CurrentUser, woId: number, a: ReleaseBatchArgs) {
    const wo = await this.getWo(tx, woId, true);
    if (wo.dhr_status === 'RELEASED') throw new BizError('该批已全部放行');
    if (wo.dhr_status === 'REJECTED') throw new BizError('该工单 DHR 已整批拒绝放行（成品已冻结），不能再分批放行');
    if (!['IN_PROGRESS', 'COMPLETED'].includes(wo.status)) throw new BizError(`工单 ${wo.no} 状态为【${wo.status}】，不能放行`);
    const reason = a.reason?.trim() || a.sig?.reason?.trim() || null;
    if (!a.approve && !reason) throw new BizError('拒绝放行须填写原因');
    const released = wo.released_qty || 0;
    let units: SerialNumber[] = [];
    let qty: number;
    if (wo.material.serial_control) {
      const picked = [...new Set((a.serials ?? []).map((s) => (s || '').trim()).filter(Boolean))];
      if (picked.length) {
        const last = await this.lastSeq(tx, wo.id);
        const rows = await tx.serialNumber.findMany({ where: { sn: { in: picked } }, include: { release: true } });
        const bySn = new Map(rows.map((r) => [r.sn, r]));
        for (const s of picked) {
          const r = bySn.get(s);
          if (!r || r.wo_id !== wo.id) throw new BizError(`序列号 ${s} 不属于工单 ${wo.no}`);
          if (r.release) throw new BizError(`序列号 ${s} 已在放行批 ${r.release.no} 中（${r.release.status === 'RELEASED' ? '已放行' : '已拒绝'}）`);
          if (r.status !== 'IN_STOCK') throw new BizError(`序列号 ${s} 状态为【${r.status}】，只有已完工入库的产品才能放行`);
          if ((r.last_seq || 0) < last) throw new BizError(`序列号 ${s} 未完成全部工序，不能放行`);
          units.push(r);
        }
      } else {
        units = (await this.eligibleSerials(tx, wo.id)).eligible;
        if (a.qty) {
          const n = Math.trunc(Number(a.qty));
          if (n <= 0 || Math.abs(n - Number(a.qty)) > EPS) throw new BizError('序列号产品的放行数量必须为正整数');
          if (units.length < n) throw new BizError(`可放行的产品只有 ${units.length} 台（需已完工入库、无未处置 NCR）`);
          units = units.slice(0, n);
        }
      }
      if (!units.length) throw new BizError('没有可放行的产品（需已完工入库、完成全部工序且尚未放行）');
      if (a.approve) {
        const open = await tx.ncr.findMany({ where: { sn: { in: units.map((u) => u.sn) }, status: 'OPEN' }, orderBy: { id: 'asc' } });
        if (open.length) throw new BizError(`序列号 ${open.map((n) => `${n.sn}（${n.no}）`).join('、')} 存在未处置的不合格（NCR），不能放行`);
      }
      qty = units.length;
    } else {
      const avail = Math.max(0, round((wo.received_qty || 0) - released - (await this.rejectedQty(tx, wo.id))));
      qty = a.qty ? round(Number(a.qty)) : avail;
      if (qty <= EPS) throw new BizError(`没有可放行的数量（已入库 ${g(wo.received_qty)}，已放行 ${g(released)}）`);
      if (qty > avail + EPS) throw new BizError(`放行数量超出：可放行 ${g(avail)} ${wo.material.uom}（已入库 − 已放行 − 已拒绝）`);
      if (a.approve) {
        const open = await tx.ncr.count({ where: { wo_id: wo.id, status: 'OPEN' } });
        if (open) throw new BizError(`工单 ${wo.no} 有 ${open} 条未处置的不合格（NCR），不能放行`);
      }
    }
    const after = round(released + qty);
    if (a.approve) {
      const mats = await tx.workOrderMaterial.findMany({ where: { wo_id: wo.id }, orderBy: { id: 'asc' }, include: { material: true } });
      const short = mats.filter((m) => (m.issued_qty || 0) + EPS < (m.qty_per || 0) * after);
      if (short.length) {
        throw new BizError('物料未按 BOM 足额领用，不能放行：' + short.map((m) => `${m.material.code} 已领 ${g(m.issued_qty)} < 应耗 ${g(round(m.qty_per * after))}`).join('；'));
      }
    }
    const rel = await this.createRelease(tx, user, wo, units, qty, a.approve, reason);
    await this.esign.sign(tx, user, a.sig, a.approve ? '产品放行（分批）' : '产品放行（分批拒绝）', 'mes_product_release', rel.id, rel.no);
    const upd: Record<string, any> = {};
    if (a.approve) {
      upd.released_qty = after;
      await this.maybeCloseAfterRelease(tx, wo, after, upd);
    }
    const woNew = Object.keys(upd).length ? await tx.workOrder.update({ where: { id: wo.id }, data: upd }) : wo;
    return {
      release: { ...rel, sn_list: units.map((u) => u.sn).sort() },
      wo_status: woNew.status, dhr_status: woNew.dhr_status, released_qty: woNew.released_qty,
    };
  }

  /**
   * DHR 整单审核（QA 电子签名）= 把剩余未放行的已入库成品一次放行：
   *   批准 → 须通过全部检查（已完工、足额领料、无未处置 NCR、全部入库），剩余待放行成品转合格，DHR 已放行、工单关闭；
   *   拒绝 → 剩余待放行成品冻结（HOLD），DHR 拒绝放行。
   */
  async releaseDhr(tx: Tx, user: CurrentUser, woId: number, approve: boolean, sig: SignatureDto | null | undefined, reason?: string | null): Promise<WorkOrder> {
    const wo = await this.getWo(tx, woId, true);
    if (wo.dhr_status === 'RELEASED') throw new BizError('该批已放行');
    if (!approve && wo.dhr_status === 'REJECTED') throw new BizError('该批已拒绝放行');
    if (approve) {
      const bad = (await this.dhrChecks(tx, wo.id)).filter((c) => !c.ok).map((c) => c.item);
      if (bad.length) throw new BizError('DHR 审核未通过，不能放行：' + bad.join('；'));
    }
    await this.esign.sign(tx, user, sig, approve ? '产品放行（DHR审核批准）' : '产品放行（DHR审核拒绝）', 'mes_work_order', wo.id, wo.no);
    const released = wo.released_qty || 0;
    let units: SerialNumber[] = [];
    let qty: number;
    if (wo.material.serial_control) {
      units = await tx.serialNumber.findMany({ where: { wo_id: wo.id, status: 'IN_STOCK', release_id: null }, orderBy: { sn: 'asc' } });
      qty = units.length;
    } else {
      qty = Math.max(0, round((wo.received_qty || 0) - released - (await this.rejectedQty(tx, wo.id))));
    }
    const text = approve ? '整单放行（剩余全部）' : '整单拒绝放行';
    if (qty > EPS) await this.createRelease(tx, user, wo, units, qty, approve, [text, reason?.trim()].filter(Boolean).join('：'));
    if (approve) return tx.workOrder.update({ where: { id: wo.id }, data: { dhr_status: 'RELEASED', status: 'CLOSED', released_qty: round(released + qty) } });
    return tx.workOrder.update({ where: { id: wo.id }, data: { dhr_status: 'REJECTED' } });
  }
}
