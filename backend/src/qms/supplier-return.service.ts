/**
 * 退供应商单（wms_supplier_return）：来料 NCR 处置为“退货”时由 QualityService 生成（PENDING 待出库），
 * 此时库存保持“不合格”隔离状态、不扣账；仓管实物出库确认（ship）时才通过 InventoryService 扣减库存（流水 RETURN_SUPPLIER）；
 * 供应商拒收等情况由 QA 取消（cancel，电子签名），NCR 退回“待处置”重新评审。
 */
import { Injectable } from '@nestjs/common';
import type { SupplierReturn } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { BizError, NotFound } from '../common/errors';
import { EPS, g, round } from '../common/num';
import { ser } from '../common/presenter';
import type { Tx } from '../common/prisma.service';
import { EsignService, type SignatureDto } from '../core/esign.service';
import { InventoryService, type Ref } from '../core/inventory.service';

@Injectable()
export class SupplierReturnService {
  constructor(private readonly inv: InventoryService, private readonly esign: EsignService) {}

  async load(tx: Tx, id: number, lock = false): Promise<SupplierReturn> {
    if (lock) await tx.$queryRaw`SELECT id FROM wms_supplier_return WHERE id = ${id} FOR UPDATE`;
    const r = await tx.supplierReturn.findUnique({ where: { id } });
    if (!r) throw new NotFound('退供应商单');
    return r;
  }

  /** 该退货批次当前的“不合格”库存（按库位） */
  async stockOf(tx: Tx, r: SupplierReturn) {
    return tx.stock.findMany({
      where: { material_id: r.material_id, lot_no: r.lot_no, status: 'REJECTED', owner_customer_id: r.owner_customer_id ?? null, qty: { gt: EPS } },
      orderBy: { id: 'asc' }, include: { location: true },
    });
  }

  /** 仓管出库确认：从“不合格”库存扣减退货数量（按库位顺序），记流水 RETURN_SUPPLIER */
  async ship(tx: Tx, user: CurrentUser, id: number, a: { remark?: string | null; carrier?: string | null }) {
    const r = await this.load(tx, id, true);
    if (r.status !== 'PENDING') throw new BizError(`退供应商单 ${r.no} 状态为【${r.status === 'SHIPPED' ? '已出库' : '已取消'}】，不能出库`);
    const stocks = await this.stockOf(tx, r);
    const have = round(stocks.reduce((s, x) => s + x.qty, 0));
    if (have + EPS < r.qty) {
      throw new BizError(`批次 ${r.lot_no || '-'} 的“不合格”库存只有 ${g(have)}，少于退货数量 ${g(r.qty)}，请核对库存（如已部分报废，请联系 QA 取消本单后重新处置）`);
    }
    const ref: Ref = { ref_type: 'SUPPLIER_RETURN', ref_id: r.id, ref_no: r.no, username: user.username, remark: `退供应商出库${a.remark ? '：' + a.remark : ''}`.slice(0, 250) };
    let remain = r.qty;
    for (const st of stocks) {
      if (remain <= EPS) break;
      const q = round(Math.min(st.qty, remain));
      await this.inv.removeStock(tx, {
        material_id: st.material_id, location_id: st.location_id, lot_no: st.lot_no, status: 'REJECTED', qty: q,
        owner_customer_id: st.owner_customer_id, move_type: 'RETURN_SUPPLIER', ref,
      });
      remain = round(remain - q);
    }
    const remark = [r.remark, a.carrier ? `承运/单号：${a.carrier}` : null, a.remark ? `出库备注：${a.remark}` : null].filter(Boolean).join('；') || null;
    return tx.supplierReturn.update({ where: { id }, data: { status: 'SHIPPED', shipped_by: user.full_name, shipped_at: new Date(), remark } });
  }

  /** QA 取消（如供应商拒收）：本单作废，NCR 退回“待处置”重新评审；库存不变（仍为不合格隔离） */
  async cancel(tx: Tx, user: CurrentUser, id: number, reason: string, sig: SignatureDto | null | undefined) {
    const r = await this.load(tx, id, true);
    if (r.status !== 'PENDING') throw new BizError(`退供应商单 ${r.no} 已${r.status === 'SHIPPED' ? '出库' : '取消'}，不能取消`);
    const why = (reason || '').trim();
    if (!why) throw new BizError('请填写取消原因（如：供应商拒收、改为报废）');
    await this.esign.sign(tx, user, { ...(sig as SignatureDto), reason: (sig?.reason || why).slice(0, 250) }, '退供应商单取消', 'wms_supplier_return', r.id, r.no);
    if (r.ncr_id) {
      const ncr = await tx.ncr.findUnique({ where: { id: r.ncr_id } });
      if (ncr && ncr.status === 'DISPOSITIONED' && ncr.disposition === 'RETURN') {
        const note = `【${new Date().toISOString().slice(0, 10)} 退供应商单 ${r.no} 已取消：${why}，退回重新评审】`;
        await tx.ncr.update({
          where: { id: ncr.id },
          data: {
            status: 'OPEN', disposition: null, disposition_by: null, disposition_at: null,
            disposition_remark: [ncr.disposition_remark, note].filter(Boolean).join('\n'),
          },
        });
      }
    }
    return tx.supplierReturn.update({ where: { id }, data: { status: 'CANCELLED', remark: [r.remark, `取消：${why}（${user.full_name}）`].filter(Boolean).join('；') } });
  }

  /** 序列化并补充物料、供应商、NCR、库存位置 */
  async enrich(tx: Tx, rows: SupplierReturn[], withStock = false) {
    const ids = (f: (r: SupplierReturn) => number | null | undefined) => [...new Set(rows.map(f).filter((x): x is number => !!x))];
    const [mats, sups, ncrs, custs] = await Promise.all([
      tx.material.findMany({ where: { id: { in: ids((r) => r.material_id) } } }),
      tx.supplier.findMany({ where: { id: { in: ids((r) => r.supplier_id) } } }),
      tx.ncr.findMany({ where: { id: { in: ids((r) => r.ncr_id) } }, include: { inspection: true } }),
      tx.customer.findMany({ where: { id: { in: ids((r) => r.owner_customer_id) } } }),
    ]);
    const m = new Map(mats.map((x) => [x.id, x]));
    const s = new Map(sups.map((x) => [x.id, x]));
    const n = new Map(ncrs.map((x) => [x.id, x]));
    const c = new Map(custs.map((x) => [x.id, x]));
    const out = [];
    for (const r of rows) {
      const mat = m.get(r.material_id);
      const sup = r.supplier_id ? s.get(r.supplier_id) : null;
      const ncr = r.ncr_id ? n.get(r.ncr_id) : null;
      const row: Record<string, any> = {
        ...ser('SupplierReturn', r),
        material_code: mat?.code ?? null, material_name: mat?.name ?? null, material_spec: mat?.spec ?? null, uom: mat?.uom ?? null,
        supplier_name: sup?.name ?? null, supplier_contact: sup?.contact ?? null, supplier_phone: sup?.phone ?? null, supplier_address: sup?.address ?? null,
        owner_customer_name: r.owner_customer_id ? c.get(r.owner_customer_id)?.name ?? null : null,
        ncr_no: ncr?.no ?? null, ncr_status: ncr?.status ?? null, ncr_description: ncr?.description ?? null,
        inspection_id: ncr?.inspection_id ?? null, inspection_no: ncr?.inspection?.no ?? null,
      };
      if (withStock || r.status === 'PENDING') {
        const st = await this.stockOf(tx, r);
        row.locations = st.map((x) => ({ location_id: x.location_id, location_code: x.location?.code ?? null, qty: x.qty }));
        row.stock_qty = round(st.reduce((a, x) => a + x.qty, 0));
      }
      out.push(row);
    }
    return out;
  }
}
