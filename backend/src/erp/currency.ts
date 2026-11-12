/**
 * 多币别：汇率表 md_exchange_rate（1 外币 = rate 本位币），本位币由环境变量 BASE_CURRENCY 决定（默认 CNY）。
 * 折算规则：取“生效日期 ≤ 业务日期”的最近一条汇率；本位币汇率恒为 1；找不到汇率时不折算，并报告缺失的币别。
 *
 *   const book = await RateBook.load(tx);
 *   book.toBase(1760, 'USD', today())   → 12496（缺汇率返回 null，book.missing 记下 'USD'）
 *   await convertToBase(tx, 1760, 'USD', date) → { amount, rate, effective_date, missing }
 */
import type { Prisma } from '@prisma/client';
import { fmtDate, today } from '../common/dates';
import { dec, money, MoneySum, type MoneyLike } from '../common/money';
import { config } from '../config';

/** 本位币 */
export const baseCurrency = (): string => config.baseCurrency;

/** 币别代码规范化（空 = 本位币） */
export const normCurrency = (c?: string | null): string => (c || '').trim().toUpperCase() || config.baseCurrency;

interface RateRow { currency: string; rate: Prisma.Decimal | number; effective_date: Date }
type RateReader = { exchangeRate: { findMany(args: any): Promise<RateRow[]> } };

export interface RateHit { rate: number; effective_date: string | null }

export class RateBook {
  /** 币别 → 汇率（按生效日期降序） */
  private readonly rates = new Map<string, { t: number; rate: Prisma.Decimal; date: Date }[]>();
  /** 折算过程中缺少汇率的币别 */
  readonly missing = new Set<string>();

  constructor(rows: RateRow[], readonly base: string = config.baseCurrency) {
    for (const r of rows) {
      const c = normCurrency(r.currency);
      if (!this.rates.has(c)) this.rates.set(c, []);
      this.rates.get(c)!.push({ t: r.effective_date.getTime(), rate: dec(r.rate), date: r.effective_date });
    }
    for (const list of this.rates.values()) list.sort((a, b) => b.t - a.t);
  }

  static async load(db: RateReader, base: string = config.baseCurrency): Promise<RateBook> {
    return new RateBook(await db.exchangeRate.findMany({ orderBy: [{ currency: 'asc' }, { effective_date: 'desc' }] }), base);
  }

  /** 某日适用的汇率；本位币 → 1；缺失 → null */
  rate(currency: string | null | undefined, date: Date = today()): RateHit | null {
    const c = normCurrency(currency);
    if (c === this.base) return { rate: 1, effective_date: null };
    const hit = this.rates.get(c)?.find((r) => r.t <= date.getTime());
    return hit ? { rate: hit.rate.toNumber(), effective_date: fmtDate(hit.date) } : null;
  }

  /** 折算为本位币（四舍五入到分）；缺汇率返回 null 并记入 missing */
  toBase(amount: MoneyLike, currency: string | null | undefined, date: Date = today()): number | null {
    const c = normCurrency(currency);
    if (c === this.base) return money(amount);
    const hit = this.rates.get(c)?.find((r) => r.t <= date.getTime());
    if (!hit) {
      this.missing.add(c);
      return null;
    }
    return money(dec(amount).times(hit.rate));
  }

  /** 最新汇率一览（每个币别生效日期 ≤ date 的最近一条） */
  latest(date: Date = today()): { currency: string; rate: number; effective_date: string | null }[] {
    const out: { currency: string; rate: number; effective_date: string | null }[] = [];
    for (const c of [...this.rates.keys()].sort()) {
      const hit = this.rate(c, date);
      if (hit) out.push({ currency: c, ...hit });
    }
    return out;
  }
}

/** 单笔折算：amount 为 null 表示缺汇率 */
export async function convertToBase(db: RateReader, amount: MoneyLike, currency: string | null | undefined, date: Date = today()) {
  const book = await RateBook.load(db);
  const hit = book.rate(currency, date);
  return {
    currency: normCurrency(currency),
    base_currency: book.base,
    amount: book.toBase(amount, currency, date),
    rate: hit?.rate ?? null,
    effective_date: hit?.effective_date ?? null,
    missing: !hit,
  };
}

/** 按币别累计金额，并折算本位币合计（缺汇率的币别不计入本位币合计，单独报告） */
export class CurrencyTotals {
  private readonly sums = new Map<string, MoneySum>();

  add(currency: string | null | undefined, amount: MoneyLike): this {
    const c = normCurrency(currency);
    if (!this.sums.has(c)) this.sums.set(c, new MoneySum());
    this.sums.get(c)!.add(amount);
    return this;
  }

  /** [{currency, amount}]，本位币排在最前 */
  byCurrency(base: string = config.baseCurrency): { currency: string; amount: number }[] {
    return [...this.sums.entries()]
      .map(([currency, s]) => ({ currency, amount: s.value }))
      .sort((a, b) => (a.currency === base ? -1 : b.currency === base ? 1 : a.currency.localeCompare(b.currency)));
  }

  /** 本位币合计与缺汇率的币别 */
  toBase(book: RateBook, date: Date = today()): { amount: number; missing: string[] } {
    const total = new MoneySum();
    const missing: string[] = [];
    for (const { currency, amount } of this.byCurrency(book.base)) {
      const v = book.toBase(amount, currency, date);
      if (v === null) missing.push(currency);
      else total.add(v);
    }
    return { amount: total.value, missing };
  }
}

/**
 * 记账汇率与本位币金额（应收应付生成时写入 fin_doc.exchange_rate / base_amount）：
 * 取单据日期适用的汇率；本位币 → 1；缺汇率 → 两者均为 null（报表提示“缺汇率”，补录汇率后自动补记）。
 */
export function bookingOf(book: RateBook, amount: MoneyLike, currency: string | null | undefined, date: Date): { exchange_rate: number | null; base_amount: number | null } {
  const hit = book.rate(currency, date);
  if (!hit) return { exchange_rate: null, base_amount: null };
  return { exchange_rate: hit.rate, base_amount: money(dec(amount).times(hit.rate)) };
}

/** 按指定汇率折算本位币（四舍五入到分） */
export const atRate = (amount: MoneyLike, rate: MoneyLike): number => money(dec(amount).times(dec(rate)));

/**
 * 收付款的本位币与汇兑差异（汇兑差异以“收益为正”）：
 *   应收（AR）：手续费含在核销金额内（银行从货款中扣除）→ 银行到账 = (核销 − 手续费) × 实收汇率
 *   应付（AP）：手续费为我方另付 → 银行付出 = (核销 + 手续费) × 实付汇率
 *   汇兑差异 = 核销 × 实收汇率 − 核销 × 记账汇率（应收），应付取相反数。
 * 各项先按分取整，再相减，保证凭证借贷平衡：银行 ± 手续费 = 冲销往来 ± 汇兑差异。
 */
export function settleBase(kind: 'AR' | 'AP', amount: MoneyLike, fee: MoneyLike, payRate: MoneyLike, bookRate: MoneyLike) {
  const gross = atRate(amount, payRate);
  const booked = atRate(amount, bookRate);
  const feeBase = atRate(fee, payRate);
  if (kind === 'AR') return { gross, booked, fee_base: feeBase, base_amount: money(dec(gross).minus(feeBase)), fx_diff: money(dec(gross).minus(booked)) };
  return { gross, booked, fee_base: feeBase, base_amount: money(dec(gross).plus(feeBase)), fx_diff: money(dec(booked).minus(gross)) };
}
