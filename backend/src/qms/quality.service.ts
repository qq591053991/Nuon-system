/**
 * 质量服务：来料检验（AQL 抽样 + 逐项检验 + 电子签名判定 → 库存质量状态自动转换）、NCR 评审处置与关闭。
 *
 * 导出方法（tx = 事务客户端；关联对象既可传 id 也可传带 id 的记录）：
 *   createIqc(tx, { receipt, line, material, username }): Promise<Inspection>
 *       为待检收货行创建 IQC 检验单（AQL 抽样方案 + 检验项目），并回写 receipt_line.inspection_id。
 *       检验项目：物料已维护检验规范（qms_material_inspection_item 启用项，按 seq）则按规范，否则按物料类型的默认模板；
 *       项目的名称、标准、方法、类型（定性/定量）、上下限、单位全部随检验单保存（快照），规范日后修改不影响已建检验单。
 *   iqcItemsFor(tx, material)          该物料 IQC 应检项目（规范优先，其次默认模板）
 *   submitInspection(tx, user, insp, { items, defect_qty, concession, remark, sig })
 *       提交检验结果：逐项校验（定量项按上下限自动判定、定性项须人工确认）；让步接收仅限 QA；电子签名；
 *       待检库存 → 合格/不合格；不合格或让步自动开具 NCR（带处置期限）
 *   dispositionNcr(tx, user, ncr, disposition, remark, sig)
 *       NCR 评审处置（REWORK/SCRAP/USE_AS_IS/RETURN），QA 电子签名。来料“退货”只生成退供应商单（待仓管出库），不立即扣库存
 *   closeBlocker(tx, ncr) / closeNcr(tx, user, ncr, { capa_id, sig })
 *       关闭前检查（返工须复测合格、重检须完成、退供应商单须已出库、客户退货单须已关闭）+ QA 电子签名“NCR关闭”
 *
 * 在 Nest 容器外（如演示数据脚本）手工构造：
 *   new QualityService(new InventoryService(), new NumberingService(), new EsignService(new AuthService(db)))
 */
import { Injectable } from '@nestjs/common';
import type { Inspection, InspectionItem, Material, Ncr, Receipt, ReceiptLine } from '@prisma/client';
import { userPermissions } from '../auth/roles';
import type { CurrentUser } from '../common/context';
import { BizError, NotFound } from '../common/errors';
import { EPS, g, round } from '../common/num';
import { inc } from '../common/presenter';
import type { Tx } from '../common/prisma.service';
import { samplingPlan } from '../core/aql';
import { EsignService, type SignatureDto } from '../core/esign.service';
import { InventoryService, type Ref } from '../core/inventory.service';
import { NumberingService } from '../core/numbering.service';
import { itemDefects, ncrDueDate, outOf } from './qms-rules';

type IdRef = number | { id: number };
const idOf = (x: IdRef) => (typeof x === 'number' ? x : x.id);

export { NCR_DUE_DAYS, ncrDueDate, effectiveDue, overdueWhere, parseSamples, itemDefects } from './qms-rules';

// ---------------------------------------------------------------- 检验项目
export type ItemType = 'QUAL' | 'QUANT';

/** 检验项目定义（规范或默认模板） */
export interface IqcItemDef {
  name: string;
  standard: string | null;
  method: string | null;
  item_type: ItemType;
  lower: number | null;
  upper: number | null;
  unit: string | null;
  spec_item_id: number | null;
}

/** 定量项至少录入的件数（样本量更小时取样本量） */
export const QUANT_MIN_SAMPLES = 5;
export const quantRequired = (sampleSize: number | null | undefined) => Math.max(1, Math.min(sampleSize || 1, QUANT_MIN_SAMPLES));

const qual = (name: string, standard: string, method: string | null = null): IqcItemDef => ({
  name, standard, method, item_type: 'QUAL', lower: null, upper: null, unit: null, spec_item_id: null,
});
const quant = (name: string, standard: string, lower: number, upper: number, unit: string, method: string | null = null): IqcItemDef => ({
  name, standard, method, item_type: 'QUANT', lower: round(lower, 4), upper: round(upper, 4), unit, spec_item_id: null,
});

/** 从物料规格中取“标称±公差+单位”（如 660±5nm） */
export function specTolerance(text: string | null | undefined, unit?: string): { nominal: number; tol: number; unit: string } | null {
  const re = /(\d+(?:\.\d+)?)\s*(?:±|\+\/-)\s*(\d+(?:\.\d+)?)\s*([a-zA-Zμ%]+)?/g;
  for (const m of String(text ?? '').matchAll(re)) {
    const u = m[3] || unit || '';
    if (unit && u.toLowerCase() !== unit.toLowerCase()) continue;
    return { nominal: Number(m[1]), tol: Number(m[2]), unit: u };
  }
  return null;
}

/** 按物料类型的默认 IQC 检验项目（物料未维护检验规范时使用）；标准取自物料规格，避免与规格书冲突 */
export function defaultItems(m: Material): IqcItemDef[] {
  const code = (m.code || '').toUpperCase();
  const spec = m.spec ? `（${m.spec}）` : '';
  if (code.startsWith('LED') || (m.wavelength_nm && m.category === 'RAW')) {
    const tol = specTolerance(m.spec, 'nm') ?? (m.wavelength_nm && Number(m.wavelength_nm) ? { nominal: Number(m.wavelength_nm), tol: 5, unit: 'nm' } : null);
    const wl = tol
      ? quant('峰值波长抽测', `${tol.nominal}±${tol.tol}nm（按物料规格）`, tol.nominal - tol.tol, tol.nominal + tol.tol, 'nm', '光谱仪逐件测量')
      : qual('峰值波长抽测', `符合物料规格${spec}`, '光谱仪测量');
    return [
      qual('外观', '无破损、无氧化、编带完好', '目视'),
      qual('规格标识核对', `型号/波长/BIN 与物料规格${spec}一致`, '核对标签与规格书'),
      wl,
      qual('湿敏包装', '真空包装完好，湿度卡未变色', '目视'),
    ];
  }
  if (code.startsWith('PSU')) {
    const v = /(\d+(?:\.\d+)?)\s*V/i.exec(`${m.code} ${m.name}`);
    const volt = v ? Number(v[1]) : null;
    return [
      qual('外观', '无破损、标签清晰', '目视'),
      volt ? quant('输出电压', `额定 ${volt}V ±5%`, volt * 0.95, volt * 1.05, 'V', '万用表空载测量') : qual('输出电压', '额定值 ±5%', '万用表测量'),
      qual('安规认证核对', 'IEC 60601-1 证书有效', '核对证书'),
    ];
  }
  if (code.startsWith('PCB')) return [qual('外观', '无划伤、无起泡、阻焊完好', '目视'), qual('尺寸', `符合图纸${spec}`, '卡尺'), qual('可焊性', '上锡良好', '试焊')];
  if (m.category === 'PACKAGING') return [qual('外观/印刷', '颜色、文字与客户批准样一致', '对样'), qual('尺寸', `符合图纸${spec}`, '卷尺/卡尺')];
  return [qual('外观', '无破损、无污渍', '目视'), qual('规格核对', `与采购规格一致${spec}`, '核对'), qual('尺寸', '符合图纸', '卡尺')];
}

/** 兼容旧接口：默认模板的 [名称, 标准] */
export function itemsFor(m: Material): [string, string][] {
  return defaultItems(m).map((d) => [d.name, d.standard ?? '']);
}

/** 不需要来料检验的物料（成品、半成品或主数据设为免检） */
export const iqcExempt = (m: Pick<Material, 'iqc_required' | 'category'>) => !m.iqc_required || m.category === 'FINISHED' || m.category === 'SEMI';

export const DISPOSITION_TEXT: Record<string, string> = { REWORK: '返工/返修', SCRAP: '报废', USE_AS_IS: '让步接收', RETURN: '退货' };

export interface InspectionItemInput {
  id?: number | null;
  name: string;
  standard?: string | null;
  value?: string | null;
  result?: string | null;
  /** 定量项逐件实测值 */
  sample_values?: (number | null)[] | null;
  /** 定性项已人工确认 */
  checked?: boolean | null;
  /** 定性项判不合格时的不良件数 */
  defect_qty?: number | null;
  /** 检验员临时增加的项目：类型与上下限 */
  item_type?: string | null;
  lower?: number | null;
  upper?: number | null;
  unit?: string | null;
}

export interface SubmitInspectionArgs {
  /** 逐项检验结果。为 null/undefined 时（旧接口调用）不做逐项校验，仅按不良数判定 */
  items?: InspectionItemInput[] | null;
  defect_qty: number;
  concession: boolean;
  remark?: string | null;
  sig: SignatureDto | null | undefined;
}

@Injectable()
export class QualityService {
  constructor(
    private readonly inv: InventoryService,
    private readonly numbering: NumberingService,
    private readonly esign: EsignService,
  ) {}

  /** 物料的 IQC 检验项目：已维护检验规范（启用项，按序号）则按规范；否则按物料类型的默认模板 */
  async iqcItemsFor(tx: Tx, material: Material): Promise<IqcItemDef[]> {
    const spec = await tx.materialInspectionItem.findMany({
      where: { material_id: material.id, is_active: true }, orderBy: [{ seq: 'asc' }, { id: 'asc' }],
    });
    if (spec.length) {
      return spec.map((s) => ({
        name: s.name, standard: s.standard ?? null, method: s.method ?? null, spec_item_id: s.id,
        item_type: s.item_type === 'QUANT' ? 'QUANT' : 'QUAL', lower: s.lower ?? null, upper: s.upper ?? null, unit: s.unit ?? null,
      }));
    }
    return defaultItems(material);
  }

  /** 为待检收货行创建 IQC 检验单（AQL 抽样方案 + 检验规范/默认检验项目），并回写 receipt_line.inspection_id */
  async createIqc(tx: Tx, a: { receipt: Receipt; line: ReceiptLine; material: Material; username: string }): Promise<Inspection> {
    const { receipt, line, material } = a;
    const plan = samplingPlan(line.qty, material.aql || 1.0);
    const items = await this.iqcItemsFor(tx, material);
    const insp = await tx.inspection.create({
      data: {
        no: await this.numbering.nextNo(tx, 'IQC'), insp_type: 'IQC', material_id: material.id, lot_no: line.lot_no,
        location_id: line.location_id, owner_customer_id: material.owner_customer_id ?? null, receipt_id: receipt.id,
        receipt_line_id: line.id, supplier_id: receipt.supplier_id ?? null, lot_qty: line.qty, aql: plan.aql,
        code_letter: plan.code_letter, sample_size: plan.sample_size, accept_num: plan.accept_num, reject_num: plan.reject_num,
        status: 'PENDING', created_by: a.username,
        // 检验项目（名称/标准/方法/类型/上下限/单位）随检验单一起保存：规范日后修改不影响已生成的检验记录
        items: {
          create: items.map((d) => ({
            name: d.name, standard: d.standard, method: d.method, spec_item_id: d.spec_item_id, item_type: d.item_type,
            lower: d.lower, upper: d.upper, unit: d.unit, result: 'PASS', checked: false,
          })),
        },
      },
    });
    await tx.receiptLine.update({ where: { id: line.id }, data: { inspection_id: insp.id } });
    return insp;
  }

  /** 逐项校验并保存检验结果（严格模式：每个项目都须完成） */
  private async saveItems(tx: Tx, insp: Inspection & { items: InspectionItem[] }, input: InspectionItemInput[]) {
    const need = quantRequired(insp.sample_size);
    const n = insp.sample_size || 0;
    const byId = new Map(input.filter((x) => x.id).map((x) => [Number(x.id), x]));
    const rows: { id?: number; data: Record<string, any> }[] = [];
    const check = (name: string, type: string, lower: number | null, upper: number | null, it: InspectionItemInput | undefined) => {
      if (!it) throw new BizError(`检验项目“${name}”未填写，请逐项完成检验后再提交`);
      if (type === 'QUANT') {
        const raw = (it.sample_values ?? []).filter((v) => v !== null && v !== undefined && String(v) !== '');
        const vals = raw.map(Number);
        if (vals.some((v) => !Number.isFinite(v))) throw new BizError(`检验项目“${name}”的实测值必须是数字`);
        if (vals.length < need) throw new BizError(`检验项目“${name}”是定量项：需录入至少 ${need} 件实测值（已录 ${vals.length} 件）`);
        if (n && vals.length > n) throw new BizError(`检验项目“${name}”录入了 ${vals.length} 件，超过样本量 ${n}`);
        const bad = vals.filter((v) => outOf(v, lower, upper));
        return {
          item_type: 'QUANT', sample_values: JSON.stringify(vals.map((v) => round(v, 6))), checked: true,
          result: bad.length ? 'FAIL' : 'PASS', defects: bad.length,
          value: (it.value ?? '').trim() || `${vals.length} 件 ${g(Math.min(...vals))}~${g(Math.max(...vals))}${bad.length ? `，${bad.length} 件超限` : ''}`,
        };
      }
      if (!it.checked || !['PASS', 'FAIL'].includes(String(it.result))) throw new BizError(`检验项目“${name}”尚未确认，请点选“合格”或“不合格”`);
      const fail = it.result === 'FAIL';
      const d = fail ? Math.trunc(Number(it.defect_qty ?? 0)) : 0;
      if (!Number.isFinite(d) || d < 0) throw new BizError(`检验项目“${name}”的不良数无效`);
      if (n && d > n) throw new BizError(`检验项目“${name}”的不良数 ${d} 超过样本量 ${n}`);
      return { item_type: 'QUAL', sample_values: fail && d ? JSON.stringify({ defects: d }) : null, checked: true, result: it.result!, defects: d, value: (it.value ?? '').trim() || null };
    };
    const results: { name: string; result: string; defects: number; values?: string }[] = [];
    for (const obj of insp.items) {
      const r = check(obj.name, obj.item_type, obj.lower, obj.upper, byId.get(obj.id));
      results.push({ name: obj.name, result: r.result, defects: r.defects });
      rows.push({ id: obj.id, data: { value: r.value?.slice(0, 128) ?? null, result: r.result, checked: true, sample_values: r.sample_values } });
    }
    // 检验员临时增加的项目
    for (const it of input.filter((x) => !x.id)) {
      const name = (it.name || '').trim();
      if (!name) throw new BizError('请填写自定义检验项目的名称');
      const type = it.item_type === 'QUANT' ? 'QUANT' : 'QUAL';
      const lower = it.lower ?? null;
      const upper = it.upper ?? null;
      if (type === 'QUANT' && lower === null && upper === null) throw new BizError(`检验项目“${name}”是定量项，请填写下限或上限`);
      const r = check(name, type, lower, upper, it);
      results.push({ name, result: r.result, defects: r.defects });
      rows.push({
        data: {
          inspection_id: insp.id, name: name.slice(0, 64), standard: it.standard?.trim() || null, item_type: type, lower, upper,
          unit: it.unit?.trim() || null, value: r.value?.slice(0, 128) ?? null, result: r.result, checked: true, sample_values: r.sample_values,
        },
      });
    }
    for (const r of rows) {
      if (r.id) await tx.inspectionItem.update({ where: { id: r.id }, data: r.data });
      else await tx.inspectionItem.create({ data: r.data as any });
    }
    return results;
  }

  /** 提交检验结果（电子签名）：合格/让步 → 库存转合格；不合格 → 库存转不合格并自动开具 NCR */
  async submitInspection(tx: Tx, user: CurrentUser, inspRef: IdRef, a: SubmitInspectionArgs): Promise<Inspection & { items: InspectionItem[] }> {
    const id = idOf(inspRef);
    const insp = await tx.inspection.findUnique({ where: { id }, include: { items: { orderBy: { id: 'asc' } } } });
    if (!insp) throw new NotFound('检验单');
    if (insp.status !== 'PENDING') throw new BizError('该检验单已判定');
    const defect = a.defect_qty ?? 0;
    if (defect < 0) throw new BizError('不良数不能为负');
    if (insp.sample_size && defect > insp.sample_size) throw new BizError(`不良数 ${defect} 超过样本量 ${insp.sample_size}`);
    if (Array.isArray(a.items)) {
      const results = await this.saveItems(tx, insp, a.items);
      const fails = results.filter((r) => r.result === 'FAIL');
      // 不良数必须关联到检验项目
      if (defect > 0 && !fails.length) {
        throw new BizError(`不良数 ${defect} 件未关联检验项目：请在出现不良的检验项目上判定“不合格”并填写不良数`);
      }
      const maxItem = Math.max(0, ...fails.map((f) => f.defects));
      if (defect < maxItem) {
        const f = fails.find((x) => x.defects === maxItem)!;
        throw new BizError(`样本不良数（${defect}）少于检验项目“${f.name}”的不良数（${maxItem}），请核对`);
      }
    }
    const items = await tx.inspectionItem.findMany({ where: { inspection_id: insp.id }, orderBy: { id: 'asc' } });
    const itemFail = items.some((i) => i.result === 'FAIL');
    const accept = defect <= (insp.accept_num ?? 0) && !itemFail;
    const concession = !!a.concession && !accept;
    if (concession && !userPermissions(user).has('qa')) throw new BizError('让步接收需由 QA 批准');
    const status = accept ? 'PASSED' : concession ? 'CONCESSION' : 'REJECTED';
    const meaning = ({ PASSED: 'IQC检验判定：合格', REJECTED: 'IQC检验判定：不合格', CONCESSION: 'IQC让步接收批准' } as Record<string, string>)[status];
    await this.esign.sign(tx, user, a.sig, meaning, 'qms_inspection', insp.id, insp.no);
    await tx.inspection.update({
      where: { id },
      data: { defect_qty: defect, status, inspector: user.full_name, inspected_at: new Date(), result_remark: a.remark ?? null },
    });
    const ref: Ref = { ref_type: 'INSPECTION', ref_id: insp.id, ref_no: insp.no, username: user.username, remark: meaning };
    const kw = {
      material_id: insp.material_id, lot_no: insp.lot_no, from_status: 'QUARANTINE',
      owner_customer_id: insp.owner_customer_id, location_id: insp.location_id, ref,
    };
    if (status === 'PASSED' || status === 'CONCESSION') {
      await this.inv.changeLotStatus(tx, { ...kw, to_status: 'AVAILABLE', move_type: 'IQC_RELEASE' });
    } else {
      await this.inv.changeLotStatus(tx, { ...kw, to_status: 'REJECTED', move_type: 'IQC_REJECT' });
    }
    if (status !== 'PASSED') {
      const fails = items
        .filter((i) => i.result === 'FAIL')
        .map((i) => {
          const d = itemDefects(i);
          return d ? `${i.name}（${d} 件${i.item_type === 'QUANT' ? '超限' : ''}）` : i.name;
        })
        .join('、');
      const description =
        `来料检验 ${insp.no}：抽样 ${insp.sample_size}，不良 ${defect}（Ac=${insp.accept_num}）` +
        (fails ? `；不合格项目：${fails}` : '') + (a.remark ? `；${a.remark}` : '');
      await tx.ncr.create({
        data: {
          no: await this.numbering.nextNo(tx, 'NCR'), source: 'IQC', severity: 'MAJOR', material_id: insp.material_id,
          lot_no: insp.lot_no, inspection_id: insp.id, supplier_id: insp.supplier_id, qty: insp.lot_qty, description,
          created_by: user.username, due_date: ncrDueDate('MAJOR'),
          ...(status === 'CONCESSION'
            ? { status: 'DISPOSITIONED', disposition: 'USE_AS_IS', disposition_by: user.full_name, disposition_at: new Date(), disposition_remark: a.remark || '让步接收' }
            : { status: 'OPEN' }),
        },
      });
    }
    return (await tx.inspection.findUnique({ where: { id }, include: inc('Inspection', ['items']) })) as any;
  }

  /** NCR 评审处置（QA 电子签名）。过程不合格只能返工/报废；来料不合格可让步、返工（重新检验）、退货、报废 */
  async dispositionNcr(tx: Tx, user: CurrentUser, ncrRef: IdRef, disposition: string, remark: string | null | undefined, sig: SignatureDto | null | undefined): Promise<Ncr> {
    const id = idOf(ncrRef);
    const ncr = await tx.ncr.findUnique({ where: { id } });
    if (!ncr) throw new NotFound('NCR');
    if (ncr.status !== 'OPEN') throw new BizError('该 NCR 已处置');
    if (!DISPOSITION_TEXT[disposition]) throw new BizError('处置方式无效');
    const ref: Ref = { ref_type: 'NCR', ref_id: ncr.id, ref_no: ncr.no, username: user.username, remark: `NCR处置：${DISPOSITION_TEXT[disposition]}` };
    if (ncr.source === 'PROCESS') {
      if (disposition !== 'REWORK' && disposition !== 'SCRAP') {
        throw new BizError('生产过程不合格品只能“返工”或“报废”，不允许让步放行（医疗器械安全要求）');
      }
      // 先锁定工单行，避免与并发报工同时修改报废数/完工状态
      if (ncr.wo_id) await tx.$queryRaw`SELECT id FROM mes_work_order WHERE id = ${ncr.wo_id} FOR NO KEY UPDATE`;
      const wo = ncr.wo_id ? await tx.workOrder.findUnique({ where: { id: ncr.wo_id }, include: { operations: true } }) : null;
      if (!wo) throw new NotFound('工单');
      let scrap = wo.scrap_qty || 0;
      if (ncr.sn) {
        const sn = await tx.serialNumber.findUnique({ where: { sn: ncr.sn } });
        if (!sn) throw new NotFound(`序列号 ${ncr.sn} `);
        // 返工：ng_seq 保留，重新过该工序时标记为返工
        await tx.serialNumber.update({ where: { id: sn.id }, data: { status: disposition === 'REWORK' ? 'IN_PROCESS' : 'SCRAPPED' } });
        if (disposition === 'SCRAP') scrap = scrap + 1;
      } else {
        // 批量报工：返工 → 释放该工序的不良数量，可重新报工；报废 → 保持占用并计入工单报废数
        const op = wo.operations.find((o) => o.seq === ncr.op_seq);
        if (disposition === 'REWORK' && op) {
          await tx.workOrderOperation.update({ where: { id: op.id }, data: { ng_qty: round((op.ng_qty || 0) - ncr.qty) } });
        }
        if (disposition === 'SCRAP') scrap = round(scrap + ncr.qty);
      }
      const data: Record<string, any> = {};
      if (disposition === 'SCRAP') {
        data.scrap_qty = scrap;
        if (['RELEASED', 'IN_PROGRESS'].includes(wo.status) && (wo.completed_qty || 0) + scrap >= wo.planned_qty - EPS) {
          data.status = 'COMPLETED';
          data.actual_end = new Date();
        }
        await tx.workOrder.update({ where: { id: wo.id }, data });
      }
    } else if (ncr.source === 'IQC') {
      const insp = ncr.inspection_id ? await tx.inspection.findUnique({ where: { id: ncr.inspection_id }, include: { material: true } }) : null;
      const owner = insp?.owner_customer_id ?? null;
      const kw = {
        material_id: ncr.material_id!, lot_no: ncr.lot_no || '', from_status: 'REJECTED',
        owner_customer_id: owner, location_id: insp?.location_id ?? null, ref,
      };
      if (disposition === 'USE_AS_IS') {
        await this.inv.changeLotStatus(tx, { ...kw, to_status: 'AVAILABLE', move_type: 'STATUS_CHANGE' });
      } else if (disposition === 'REWORK') {
        // 挑选/返工后重新检验
        await this.inv.changeLotStatus(tx, { ...kw, to_status: 'QUARANTINE', move_type: 'STATUS_CHANGE' });
        if (insp) {
          const rc = insp.receipt_id ? await tx.receipt.findUnique({ where: { id: insp.receipt_id } }) : null;
          const line = insp.receipt_line_id ? await tx.receiptLine.findUnique({ where: { id: insp.receipt_line_id } }) : null;
          if (rc && line) await this.createIqc(tx, { receipt: rc, line, material: insp.material, username: user.username });
        }
      } else if (disposition === 'RETURN') {
        // 退货：只生成退供应商单（库存保持“不合格”隔离状态），仓管出库确认后才扣减库存
        const stocks = await tx.stock.findMany({ where: { material_id: ncr.material_id!, lot_no: ncr.lot_no || '', status: 'REJECTED', owner_customer_id: owner } });
        const qty = round(stocks.reduce((s, x) => s + x.qty, 0));
        if (qty <= EPS) throw new BizError(`批次 ${ncr.lot_no || '-'} 已没有“不合格”库存，无法退货（请核对库存或改为其他处置）`);
        await tx.supplierReturn.create({
          data: {
            no: await this.numbering.nextNo(tx, 'SR'), supplier_id: ncr.supplier_id ?? insp?.supplier_id ?? (owner ? null : insp?.material.default_supplier_id ?? null), ncr_id: ncr.id,
            material_id: ncr.material_id!, lot_no: ncr.lot_no || '', qty, owner_customer_id: owner, status: 'PENDING',
            remark: remark ?? null, created_by: user.username,
          },
        });
      } else {
        // SCRAP：从不合格库存中报废出库
        const stocks = await tx.stock.findMany({
          where: { material_id: ncr.material_id!, lot_no: ncr.lot_no || '', status: 'REJECTED' },
          orderBy: { id: 'asc' },
        });
        for (const st of stocks) {
          await this.inv.removeStock(tx, {
            material_id: st.material_id, location_id: st.location_id, lot_no: st.lot_no, status: 'REJECTED', qty: st.qty,
            owner_customer_id: st.owner_customer_id, move_type: 'SCRAP', ref,
          });
        }
      }
    }
    await this.esign.sign(tx, user, sig, `不合格品评审处置：${DISPOSITION_TEXT[disposition]}`, 'qms_ncr', ncr.id, ncr.no);
    return tx.ncr.update({
      where: { id },
      data: { status: 'DISPOSITIONED', disposition, disposition_remark: remark ?? null, disposition_by: user.full_name, disposition_at: new Date() },
      include: inc('Ncr'),
    });
  }

  /**
   * NCR 关闭前检查：返回不能关闭的原因（可关闭时返回 null）
   *   制程返工：该序列号须在不合格工序复测合格（批量报工：复测合格数量 ≥ NCR 数量）；
   *   来料挑选重检：重新检验单须已判定；来料退货：退供应商单须已出库；客户来源：关联客户退货单须已关闭。
   */
  async closeBlocker(tx: Tx, ncr: Ncr): Promise<string | null> {
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

  /** 关闭 NCR（QA 电子签名“NCR关闭”）：先检查处置已执行完毕 */
  async closeNcr(tx: Tx, user: CurrentUser, ncrRef: IdRef, a: { capa_id?: number | null; sig: SignatureDto | null | undefined }): Promise<Ncr> {
    const id = idOf(ncrRef);
    const n = await tx.ncr.findUnique({ where: { id } });
    if (!n) throw new NotFound('NCR');
    if (n.status === 'CLOSED') throw new BizError(`${n.no} 已关闭`);
    if (n.status !== 'DISPOSITIONED') throw new BizError('NCR 需先完成处置');
    const block = await this.closeBlocker(tx, n);
    if (block) throw new BizError(`${n.no} 不能关闭：${block}`);
    if (a.capa_id && !(await tx.capa.findUnique({ where: { id: a.capa_id } }))) throw new NotFound('CAPA');
    await this.esign.sign(tx, user, a.sig, 'NCR关闭', 'qms_ncr', n.id, n.no);
    return tx.ncr.update({
      where: { id },
      data: { status: 'CLOSED', closed_by: user.full_name, closed_at: new Date(), ...(a.capa_id ? { capa_id: a.capa_id } : {}) },
      include: inc('Ncr'),
    });
  }
}
