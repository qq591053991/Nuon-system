/**
 * 客户退货（RMA）：
 *   create(tx, user, args) → 登记退货（单号 TH…）：退货品入库为“冻结(HOLD)”，序列号状态 → RETURNED（保留客户），
 *                            自动开具 NCR（来源 CUSTOMER）并关联 ncr_id
 *   close(tx, user, id, args) → 关闭退货单（QA 电子签名）：关联 NCR 必须已评审处置，按处置结果执行冻结库存：
 *        SCRAP 报废出库（序列号 SCRAPPED）；RETURN 返还客户出库（序列号 SHIPPED）；
 *        REWORK（返修完成）/ USE_AS_IS 冻结 → 合格（序列号 IN_STOCK），可指定上架库位
 *   enrich(rows) → 补充 customer_name / so_no / shipment_no / ncr_no / ncr_status / 行 location_code、序列号状态
 */
import { Injectable } from '@nestjs/common';
import type { CustomerReturn, CustomerReturnLine } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { round } from '../common/num';
import { inc, ser } from '../common/presenter';
import type { Tx } from '../common/prisma.service';
import { EsignService, type SignatureDto } from '../core/esign.service';
import { InventoryService, type Ref } from '../core/inventory.service';
import { NumberingService } from '../core/numbering.service';

export interface CustomerReturnLineInput {
  material_id: number;
  sn?: string | null;
  lot_no?: string | null;
  qty: number;
  location_id: number;
}

export interface CustomerReturnArgs {
  customer_id: number;
  so_id?: number | null;
  shipment_id?: number | null;
  reason: string;
  return_date?: Date | null;
  remark?: string | null;
  lines: CustomerReturnLineInput[];
}

export interface CloseReturnArgs {
  /** 处置为返修/让步时，合格品上架库位（默认原库位） */
  location_id?: number | null;
  remark?: string | null;
  sig: SignatureDto | null | undefined;
}

const DISPOSITION_TEXT: Record<string, string> = { REWORK: '返修后转合格', SCRAP: '报废', USE_AS_IS: '让步接收转合格', RETURN: '返还客户' };

@Injectable()
export class CustomerReturnsService {
  constructor(
    private readonly inv: InventoryService,
    private readonly numbering: NumberingService,
    private readonly esign: EsignService,
  ) {}

  /** 登记客户退货：冻结入库 + 序列号 RETURNED + 自动开具客诉来源 NCR */
  async create(tx: Tx, user: CurrentUser, a: CustomerReturnArgs): Promise<CustomerReturn & { lines: CustomerReturnLine[] }> {
    const customer = await tx.customer.findUnique({ where: { id: a.customer_id } });
    if (!customer) throw new NotFound('客户');
    const reason = (a.reason ?? '').trim();
    if (!reason) throw new BizError('请填写退货原因');
    if (a.so_id) {
      const so = await tx.salesOrder.findUnique({ where: { id: a.so_id } });
      if (!so) throw new NotFound('销售订单');
      if (so.customer_id !== customer.id) throw new BizError(`销售订单 ${so.no} 不是该客户的订单`);
    }
    if (a.shipment_id) {
      const sh = await tx.shipment.findUnique({ where: { id: a.shipment_id } });
      if (!sh) throw new NotFound('发货单');
      if (sh.customer_id !== customer.id) throw new BizError(`发货单 ${sh.no} 不是发给该客户的`);
      if (sh.status !== 'SHIPPED') throw new BizError(`发货单 ${sh.no} 尚未发货`);
    }
    if (!a.lines?.length) throw new BizError('请至少录入一行退货明细');

    const out: { material_id: number; sn: string | null; lot_no: string; qty: number; location_id: number; serial_id: number | null }[] = [];
    const seen = new Set<string>();
    for (const ln of a.lines) {
      const m = await tx.material.findUnique({ where: { id: ln.material_id } });
      if (!m) throw new NotFound('物料');
      const loc = await tx.location.findUnique({ where: { id: ln.location_id } });
      if (!loc || !loc.is_active) throw new BizError(`${m.code} 请选择有效的退货入库库位`);
      const qty = round(Number(ln.qty || 0));
      if (!(qty > 0)) throw new BizError(`${m.code} 退货数量必须大于 0`);
      const snText = (ln.sn ?? '').trim();
      if (m.serial_control && !snText) throw new BizError(`${m.code} 为序列号管理产品，请逐台登记序列号`);
      if (snText) {
        if (seen.has(snText)) throw new BizError(`序列号 ${snText} 重复`);
        seen.add(snText);
        if (qty !== 1) throw new BizError(`按序列号退货时数量必须为 1（${snText}）`);
        const sn = await tx.serialNumber.findUnique({ where: { sn: snText } });
        if (!sn || sn.material_id !== m.id) throw new BizError(`序列号 ${snText} 不存在或不是物料 ${m.code}`);
        if (sn.status !== 'SHIPPED') throw new BizError(`序列号 ${snText} 状态为【${sn.status}】，不是已发货产品，不能登记客户退货`);
        if (sn.customer_id && sn.customer_id !== customer.id) throw new BizError(`序列号 ${snText} 不是发给该客户的产品`);
        if (a.shipment_id && sn.shipment_id !== a.shipment_id) throw new BizError(`序列号 ${snText} 不属于所选发货单`);
        out.push({ material_id: m.id, sn: snText, lot_no: sn.lot_no ?? '', qty: 1, location_id: loc.id, serial_id: sn.id });
      } else {
        const lot = (ln.lot_no ?? '').trim();
        if (m.lot_control && !lot) throw new BizError(`${m.code} 请填写退货批号（用于追溯）`);
        out.push({ material_id: m.id, sn: null, lot_no: lot, qty, location_id: loc.id, serial_id: null });
      }
    }

    const no = await this.numbering.nextNo(tx, 'TH');
    const rma = await tx.customerReturn.create({
      data: {
        no, customer_id: customer.id, so_id: a.so_id ?? null, shipment_id: a.shipment_id ?? null, status: 'RECEIVED',
        return_date: a.return_date ?? today(), reason, remark: a.remark ?? null, created_by: user.username,
        lines: { create: out.map(({ serial_id: _s, ...l }) => l) },
      },
    });
    const ref: Ref = { ref_type: 'CUSTOMER_RETURN', ref_id: rma.id, ref_no: rma.no, username: user.username, remark: `客户退货：${customer.name}` };
    for (const l of out) {
      // 退货品一律冻结，待 QA 评审处置（不能被领用/发货）
      await this.inv.addStock(tx, {
        material_id: l.material_id, location_id: l.location_id, lot_no: l.lot_no, status: 'HOLD', qty: l.qty, move_type: 'CUSTOMER_RETURN', ref,
      });
      if (l.serial_id) await tx.serialNumber.update({ where: { id: l.serial_id }, data: { status: 'RETURNED', location_id: l.location_id } });
    }
    // 自动开具 NCR（来源：客户），关联退货单
    const mats = await tx.material.findMany({ where: { id: { in: [...new Set(out.map((l) => l.material_id))] } } });
    const code = new Map(mats.map((m) => [m.id, m.code]));
    const lots = [...new Set(out.map((l) => l.lot_no).filter(Boolean))];
    const sns = out.map((l) => l.sn).filter((s): s is string => !!s);
    const detail = out.map((l) => `${code.get(l.material_id)}${l.sn ? ` SN ${l.sn}` : l.lot_no ? ` 批号 ${l.lot_no}` : ''} ×${l.qty}`).join('、');
    const ncr = await tx.ncr.create({
      data: {
        no: await this.numbering.nextNo(tx, 'NCR'), source: 'CUSTOMER', severity: 'MAJOR', status: 'OPEN',
        material_id: mats.length === 1 ? mats[0].id : out[0].material_id, lot_no: lots.length === 1 ? lots[0] : null,
        sn: sns.length === 1 ? sns[0] : null, customer_id: customer.id, qty: round(out.reduce((s, l) => s + l.qty, 0)),
        description: `客户退货 ${no}（${customer.name}）：${reason}；退货明细：${detail}`.slice(0, 4000), created_by: user.username,
      },
    });
    await tx.customerReturn.update({ where: { id: rma.id }, data: { ncr_id: ncr.id } });
    return (await tx.customerReturn.findUnique({ where: { id: rma.id }, include: inc('CustomerReturn', ['lines']) })) as any;
  }

  /** 关闭退货单（QA 电子签名）：按关联 NCR 的处置结果执行冻结库存与序列号状态 */
  async close(tx: Tx, user: CurrentUser, id: number, a: CloseReturnArgs): Promise<CustomerReturn & { lines: CustomerReturnLine[] }> {
    const rma = await tx.customerReturn.findUnique({ where: { id }, include: { lines: { orderBy: { id: 'asc' } } } });
    if (!rma) throw new NotFound('客户退货单');
    if (rma.status !== 'RECEIVED') throw new BizError('退货单已关闭');
    const ncr = rma.ncr_id ? await tx.ncr.findUnique({ where: { id: rma.ncr_id } }) : null;
    if (!ncr || ncr.status === 'OPEN' || !ncr.disposition) throw new BizError('请先由 QA 对关联 NCR 完成评审处置，再关闭退货单');
    const disp = ncr.disposition;
    const toAvailable = disp === 'REWORK' || disp === 'USE_AS_IS';
    if (toAvailable) {
      // 转合格的退货品必须上架到合格品库位（退货时通常放在不合格品区，需指定上架库位）
      for (const locId of new Set(rma.lines.map((l) => a.location_id || l.location_id))) {
        const loc = await tx.location.findUnique({ where: { id: locId }, include: { warehouse: true } });
        if (!loc || !loc.is_active) throw new BizError('上架库位不存在或已停用');
        if (loc.location_type === 'REJECT' || loc.warehouse?.warehouse_type === 'REJECT') {
          throw new BizError(`处置为“${DISPOSITION_TEXT[disp]}”：退货品将转为合格，请选择合格品上架库位（不能留在不合格品区 ${loc.code}）`);
        }
      }
    }
    await this.esign.sign(tx, user, a.sig, `客户退货关闭（${DISPOSITION_TEXT[disp] ?? disp}）`, 'wms_customer_return', rma.id, rma.no);
    const ref: Ref = { ref_type: 'CUSTOMER_RETURN', ref_id: rma.id, ref_no: rma.no, username: user.username, remark: `客户退货处置：${DISPOSITION_TEXT[disp] ?? disp}（${ncr.no}）` };
    for (const l of rma.lines) {
      const key = { material_id: l.material_id, location_id: l.location_id, lot_no: l.lot_no, status: 'HOLD', qty: l.qty, ref };
      let snData: Record<string, any> | null = null;
      if (disp === 'SCRAP') {
        await this.inv.removeStock(tx, { ...key, move_type: 'SCRAP' });
        snData = { status: 'SCRAPPED', location_id: null };
      } else if (disp === 'RETURN') {
        await this.inv.removeStock(tx, { ...key, move_type: 'RETURN_TO_CUSTOMER' });
        snData = { status: 'SHIPPED', location_id: null, shipped_at: new Date() };
      } else {
        const to = a.location_id || l.location_id;
        await this.inv.moveStock(tx, {
          material_id: l.material_id, lot_no: l.lot_no, qty: l.qty, from_location_id: l.location_id, to_location_id: to,
          from_status: 'HOLD', to_status: 'AVAILABLE', move_type: 'STATUS_CHANGE', ref,
        });
        snData = { status: 'IN_STOCK', location_id: to };
      }
      if (l.sn && snData) {
        const sn = await tx.serialNumber.findUnique({ where: { sn: l.sn } });
        if (sn && sn.status === 'RETURNED') await tx.serialNumber.update({ where: { id: sn.id }, data: snData });
      }
    }
    await tx.customerReturn.update({
      where: { id },
      data: { status: 'CLOSED', remark: a.remark ? [rma.remark, `关闭：${a.remark}`].filter(Boolean).join('\n') : rma.remark },
    });
    return (await tx.customerReturn.findUnique({ where: { id }, include: inc('CustomerReturn', ['lines']) })) as any;
  }

  /** 序列化并补充关联名称（客户、订单、发货单、NCR、库位、序列号当前状态） */
  async enrich(tx: Tx, rows: any[], withLines = true): Promise<any[]> {
    const ids = (f: (r: any) => number | null | undefined) => [...new Set(rows.map(f).filter((x): x is number => !!x))];
    const lines = withLines ? rows.flatMap((r) => r.lines ?? []) : [];
    const [customers, sos, shipments, ncrs, locs, serials] = await Promise.all([
      tx.customer.findMany({ where: { id: { in: ids((r) => r.customer_id) } } }),
      tx.salesOrder.findMany({ where: { id: { in: ids((r) => r.so_id) } } }),
      tx.shipment.findMany({ where: { id: { in: ids((r) => r.shipment_id) } } }),
      tx.ncr.findMany({ where: { id: { in: ids((r) => r.ncr_id) } } }),
      tx.location.findMany({ where: { id: { in: [...new Set(lines.map((l: any) => l.location_id))] } } }),
      tx.serialNumber.findMany({ where: { sn: { in: lines.map((l: any) => l.sn).filter(Boolean) } } }),
    ]);
    const c = new Map(customers.map((x) => [x.id, x]));
    const so = new Map(sos.map((x) => [x.id, x]));
    const sh = new Map(shipments.map((x) => [x.id, x]));
    const n = new Map(ncrs.map((x) => [x.id, x]));
    const loc = new Map(locs.map((x) => [x.id, x]));
    const sn = new Map(serials.map((x) => [x.sn, x]));
    return rows.map((r) => {
      const o = ser('CustomerReturn', r, withLines ? ['lines'] : []);
      const ncr = r.ncr_id ? n.get(r.ncr_id) : null;
      Object.assign(o, {
        customer_name: c.get(r.customer_id)?.name ?? null,
        so_no: r.so_id ? so.get(r.so_id)?.no ?? null : null,
        shipment_no: r.shipment_id ? sh.get(r.shipment_id)?.no ?? null : null,
        ncr_no: ncr?.no ?? null,
        ncr_status: ncr?.status ?? null,
        ncr_disposition: ncr?.disposition ?? null,
        total_qty: round((r.lines ?? []).reduce((s: number, l: any) => s + l.qty, 0)),
      });
      if (withLines) {
        for (const l of o.lines ?? []) {
          l.location_code = loc.get(l.location_id)?.code ?? null;
          l.sn_status = l.sn ? sn.get(l.sn)?.status ?? null : null;
        }
      }
      return o;
    });
  }
}
