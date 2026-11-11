/**
 * 金额计算（十进制精确）：金额字段为 Prisma.Decimal（Decimal(18,2)），单价 Decimal(18,6)。
 * 浮点数相乘/累加会产生分位误差（如 3 × 1.115 = 3.3449999…），这里统一用 Decimal 运算后四舍五入（ROUND_HALF_UP）。
 * 规则：数量 × 单价 → lineAmount()；多行求和 → MoneySum / sumMoney()；写入金额前 money()；写入单价前 price6()。
 */
import { Prisma } from '@prisma/client';

export type MoneyLike = Prisma.Decimal | number | string | null | undefined;

const HALF_UP = Prisma.Decimal.ROUND_HALF_UP;

/** 任意数值 → Decimal（null/undefined/NaN → 0） */
export function dec(v: MoneyLike): Prisma.Decimal {
  if (v === null || v === undefined || v === '') return new Prisma.Decimal(0);
  if (v instanceof Prisma.Decimal) return v;
  if (typeof v === 'number' && !Number.isFinite(v)) return new Prisma.Decimal(0);
  return new Prisma.Decimal(v);
}

/** 金额：四舍五入到分 */
export const money = (v: MoneyLike): number => dec(v).toDecimalPlaces(2, HALF_UP).toNumber();

/** 单价：四舍五入到 6 位（与 Decimal(18,6) 一致） */
export const price6 = (v: MoneyLike): number => dec(v).toDecimalPlaces(6, HALF_UP).toNumber();

/** 行金额 = 数量 × 单价（十进制精确乘法后四舍五入到分） */
export const lineAmount = (qty: MoneyLike, price: MoneyLike): number => dec(qty).times(dec(price)).toDecimalPlaces(2, HALF_UP).toNumber();

/** 金额累加器（十进制精确） */
export class MoneySum {
  private v = new Prisma.Decimal(0);
  add(x: MoneyLike): this {
    this.v = this.v.plus(dec(x));
    return this;
  }
  get value(): number {
    return this.v.toDecimalPlaces(2, HALF_UP).toNumber();
  }
}

/** 金额求和（每项先按原值精确相加，最后四舍五入到分） */
export function sumMoney(values: Iterable<MoneyLike>): number {
  const s = new MoneySum();
  for (const v of values) s.add(v);
  return s.value;
}

/** a − b（金额） */
export const subMoney = (a: MoneyLike, b: MoneyLike): number => dec(a).minus(dec(b)).toDecimalPlaces(2, HALF_UP).toNumber();

/**
 * 采购订单行按收货数量计算应付金额：
 *   有采购单位（purchase_qty/purchase_price）时按“收货数量 ÷ 换算率 × 采购单价”，保证整行收齐时应付 = 订单行金额；
 *   否则按“收货数量 × 库存单位单价”。
 */
export function poReceiptAmount(
  pl: { qty: number; unit_price: MoneyLike; purchase_qty?: number | null; purchase_price?: MoneyLike },
  receivedQty: number,
): number {
  if (pl.purchase_qty && pl.purchase_price !== null && pl.purchase_price !== undefined && pl.qty) {
    return dec(receivedQty).times(dec(pl.purchase_qty)).div(dec(pl.qty)).times(dec(pl.purchase_price)).toDecimalPlaces(2, HALF_UP).toNumber();
  }
  return lineAmount(receivedQty, pl.unit_price);
}
