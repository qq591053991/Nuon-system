/**
 * 采购订单行金额与采购单位换算（手工下单与 MRP 转单共用）。
 * 约定：PurchaseOrderLine.qty / unit_price 始终是库存单位；purchase_qty / purchase_uom / purchase_price 仅记录下单单位信息。
 *   1 采购单位 = Material.purchase_factor 库存单位（如 1 卷 = 4000 PCS）
 *   qty = purchase_qty × 换算率；unit_price = purchase_price ÷ 换算率（6 位）；amount = purchase_qty × purchase_price（2 位）
 */
import type { Material } from '@prisma/client';
import { BizError } from '../common/errors';
import { dec, lineAmount, price6, type MoneyLike } from '../common/money';
import { EPS, round } from '../common/num';

export interface PoLineInput {
  qty?: number | null;
  unit_price?: MoneyLike;
  purchase_qty?: number | null;
  purchase_uom?: string | null;
  purchase_price?: MoneyLike;
}

export interface PoLineCalc {
  qty: number;
  unit_price: number;
  amount: number;
  purchase_uom: string | null;
  purchase_qty: number | null;
  purchase_price: number | null;
}

type Mat = Pick<Material, 'code' | 'uom' | 'purchase_uom' | 'purchase_factor'>;

/** 物料是否设置了与库存单位不同的采购单位 */
export const hasPurchaseUnit = (m: Mat): boolean =>
  !!m.purchase_uom && m.purchase_uom.trim() !== '' && m.purchase_uom !== m.uom && m.purchase_factor > 0;

/** 库存单位数量 → 采购单位数量（向上取整到整数采购单位） */
export const purchaseUnitsFor = (m: Mat, stockQty: number): number => Math.max(1, Math.ceil(round(stockQty / m.purchase_factor, 6) - EPS));

/** 校验并计算采购订单行（no = 行号，用于提示） */
export function calcPoLine(m: Mat, ln: PoLineInput, no: number): PoLineCalc {
  const uom = (ln.purchase_uom ?? '').trim() || (ln.purchase_qty ? (m.purchase_uom ?? '').trim() : '');
  if (ln.purchase_qty && uom && uom !== m.uom) {
    if (!hasPurchaseUnit(m)) throw new BizError(`第 ${no} 行 ${m.code} 未设置采购单位，请按库存单位（${m.uom}）录入数量`);
    if (uom !== m.purchase_uom) throw new BizError(`第 ${no} 行 ${m.code} 的采购单位为 ${m.purchase_uom}，不能按 ${uom} 下单`);
    const factor = m.purchase_factor;
    // 采购单位是包装单位（卷/包/箱…）：只能整包下单，不出现 1.09 卷
    if (Math.abs(ln.purchase_qty - Math.round(ln.purchase_qty)) > 1e-6) {
      throw new BizError(
        `第 ${no} 行 ${m.code} 按${uom}下单须为整数${uom}（填写了 ${round(ln.purchase_qty, 4)} ${uom}，1 ${uom} = ${round(factor, 4)} ${m.uom}）。` +
          `请改为 ${Math.ceil(ln.purchase_qty - EPS)} ${uom}，或改按 ${m.uom} 下单`,
      );
    }
    const hasPrice = ln.purchase_price !== null && ln.purchase_price !== undefined;
    const pp = price6(hasPrice ? ln.purchase_price : dec(ln.unit_price).times(factor));
    return {
      qty: round(ln.purchase_qty * factor),
      unit_price: price6(dec(pp).div(factor)),
      amount: lineAmount(ln.purchase_qty, pp),
      purchase_uom: uom,
      purchase_qty: round(ln.purchase_qty),
      purchase_price: pp,
    };
  }
  // 按库存单位下单（未传采购数量，或采购单位与库存单位相同）
  const qty = ln.purchase_qty && uom === m.uom ? ln.purchase_qty : ln.qty;
  if (!qty || qty <= 0) throw new BizError(`第 ${no} 行请填写数量`);
  const price = price6(ln.purchase_qty && uom === m.uom && ln.purchase_price !== null && ln.purchase_price !== undefined ? ln.purchase_price : ln.unit_price);
  return { qty: round(qty), unit_price: price, amount: lineAmount(qty, price), purchase_uom: null, purchase_qty: null, purchase_price: null };
}
