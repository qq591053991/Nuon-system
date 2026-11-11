/**
 * 质量服务：来料检验（AQL 抽样 + 电子签名判定 → 库存质量状态自动转换）、NCR 评审处置。
 *
 * 导出方法（tx = 事务客户端；关联对象既可传 id 也可传带 id 的记录）：
 *   createIqc(tx, { receipt, line, material, username }): Promise<Inspection>
 *       为待检收货行创建 IQC 检验单（AQL 抽样方案 + 检验项目），并回写 receipt_line.inspection_id。
 *       检验项目：物料已维护检验规范（qms_material_inspection_item 启用项，按 seq）则按规范，否则按物料类型的默认模板
 *   iqcItemsFor(tx, material): Promise<{ name, standard, method }[]>   该物料 IQC 应检项目（规范优先，其次默认模板）
 *   submitInspection(tx, user, insp, { items, defect_qty, concession, remark, sig }): Promise<Inspection & { items }>
 *       提交检验结果：让步接收仅限 QA；电子签名；待检库存 → 合格/不合格；不合格或让步自动开具 NCR
 *   dispositionNcr(tx, user, ncr, disposition, remark, sig): Promise<Ncr>
 *       NCR 评审处置（REWORK/SCRAP/USE_AS_IS/RETURN），QA 电子签名
 *
 * 在 Nest 容器外（如演示数据脚本）手工构造：
 *   new QualityService(new InventoryService(), new NumberingService(), new EsignService(new AuthService(db)))
 */
import { Injectable } from '@nestjs/common';
import type { Inspection, InspectionItem, Material, Ncr, Receipt, ReceiptLine } from '@prisma/client';
import { userPermissions } from '../auth/roles';
import type { CurrentUser } from '../common/context';
import { BizError, NotFound } from '../common/errors';
import { EPS, round } from '../common/num';
import { inc } from '../common/presenter';
import type { Tx } from '../common/prisma.service';
import { samplingPlan } from '../core/aql';
import { EsignService, type SignatureDto } from '../core/esign.service';
import { InventoryService, type Ref } from '../core/inventory.service';
import { NumberingService } from '../core/numbering.service';

type IdRef = number | { id: number };
const idOf = (x: IdRef) => (typeof x === 'number' ? x : x.id);

export const DEFAULT_IQC_ITEMS: Record<string, [string, string][]> = {
  LED: [['外观', '无破损、无氧化、编带完好'], ['规格标识核对', '型号/波长/BIN 与规格书一致'],
    ['峰值波长抽测', '符合规格书 ±5nm'], ['湿敏包装', '真空包装完好，湿度卡未变色']],
  PSU: [['外观', '无破损、标签清晰'], ['输出电压', '额定值 ±5%'], ['安规认证核对', 'IEC 60601-1 证书有效']],
  PCB: [['外观', '无划伤、无起泡、阻焊完好'], ['尺寸', '符合图纸'], ['可焊性', '上锡良好']],
  PACKAGING: [['外观/印刷', '颜色、文字与客户批准样一致'], ['尺寸', '符合图纸']],
  DEFAULT: [['外观', '无破损、无污渍'], ['规格核对', '与采购规格一致'], ['尺寸', '符合图纸']],
};

/** 按物料类型的默认 IQC 检验项目（物料未维护检验规范时使用） */
export function itemsFor(m: Material): [string, string][] {
  const code = (m.code || '').toUpperCase();
  if (code.startsWith('LED') || (m.wavelength_nm && m.category === 'RAW')) return DEFAULT_IQC_ITEMS.LED;
  if (code.startsWith('PSU')) return DEFAULT_IQC_ITEMS.PSU;
  if (code.startsWith('PCB')) return DEFAULT_IQC_ITEMS.PCB;
  if (m.category === 'PACKAGING') return DEFAULT_IQC_ITEMS.PACKAGING;
  return DEFAULT_IQC_ITEMS.DEFAULT;
}

export const DISPOSITION_TEXT: Record<string, string> = { REWORK: '返工/返修', SCRAP: '报废', USE_AS_IS: '让步接收', RETURN: '退货' };

export interface InspectionItemInput {
  id?: number | null;
  name: string;
  standard?: string | null;
  value?: string | null;
  result?: string | null;
}

export interface SubmitInspectionArgs {
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
  async iqcItemsFor(tx: Tx, material: Material): Promise<{ name: string; standard: string | null; method: string | null; spec_item_id: number | null }[]> {
    const spec = await tx.materialInspectionItem.findMany({
      where: { material_id: material.id, is_active: true }, orderBy: [{ seq: 'asc' }, { id: 'asc' }],
    });
    if (spec.length) return spec.map((s) => ({ name: s.name, standard: s.standard ?? null, method: s.method ?? null, spec_item_id: s.id }));
    return itemsFor(material).map(([name, standard]) => ({ name, standard, method: null, spec_item_id: null }));
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
        // 检验方法与规范条目随检验单一起保存：规范日后修改不影响已生成的检验记录
        items: { create: items.map(({ name, standard, method, spec_item_id }) => ({ name, standard, method, spec_item_id, result: 'PASS' })) },
      },
    });
    await tx.receiptLine.update({ where: { id: line.id }, data: { inspection_id: insp.id } });
    return insp;
  }

  /** 提交检验结果（电子签名）：合格/让步 → 库存转合格；不合格 → 库存转不合格并自动开具 NCR */
  async submitInspection(tx: Tx, user: CurrentUser, inspRef: IdRef, a: SubmitInspectionArgs): Promise<Inspection & { items: InspectionItem[] }> {
    const id = idOf(inspRef);
    const insp = await tx.inspection.findUnique({ where: { id }, include: { items: { orderBy: { id: 'asc' } } } });
    if (!insp) throw new NotFound('检验单');
    if (insp.status !== 'PENDING') throw new BizError('该检验单已判定');
    const defect = a.defect_qty ?? 0;
    if (defect < 0) throw new BizError('不良数不能为负');
    if (a.items?.length) {
      const byId = new Map(insp.items.map((i) => [i.id, i]));
      for (const it of a.items) {
        const obj = it.id !== null && it.id !== undefined ? byId.get(it.id) : undefined;
        if (obj) {
          await tx.inspectionItem.update({ where: { id: obj.id }, data: { value: it.value ?? null, result: it.result ?? obj.result } });
        } else {
          await tx.inspectionItem.create({
            data: { inspection_id: insp.id, name: it.name, standard: it.standard ?? null, value: it.value ?? null, result: it.result ?? 'PASS' },
          });
        }
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
      const fails = items.filter((i) => i.result === 'FAIL').map((i) => i.name).join('、');
      const description =
        `来料检验 ${insp.no}：抽样 ${insp.sample_size}，不良 ${defect}（Ac=${insp.accept_num}）` +
        (fails ? `；不合格项目：${fails}` : '') + (a.remark ? `；${a.remark}` : '');
      await tx.ncr.create({
        data: {
          no: await this.numbering.nextNo(tx, 'NCR'), source: 'IQC', severity: 'MAJOR', material_id: insp.material_id,
          lot_no: insp.lot_no, inspection_id: insp.id, supplier_id: insp.supplier_id, qty: insp.lot_qty, description,
          created_by: user.username,
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
      const kw = {
        material_id: ncr.material_id!, lot_no: ncr.lot_no || '', from_status: 'REJECTED',
        owner_customer_id: insp?.owner_customer_id ?? null, location_id: insp?.location_id ?? null, ref,
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
      } else {
        // RETURN / SCRAP：从不合格库存中出库
        const stocks = await tx.stock.findMany({
          where: { material_id: ncr.material_id!, lot_no: ncr.lot_no || '', status: 'REJECTED' },
          orderBy: { id: 'asc' },
        });
        for (const st of stocks) {
          await this.inv.removeStock(tx, {
            material_id: st.material_id, location_id: st.location_id, lot_no: st.lot_no, status: 'REJECTED', qty: st.qty,
            owner_customer_id: st.owner_customer_id, move_type: disposition === 'RETURN' ? 'RETURN_SUPPLIER' : 'SCRAP', ref,
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
}
