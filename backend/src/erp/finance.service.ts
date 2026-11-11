/** 应收(AR) / 应付(AP)：单据查询、登记收付款、账龄汇总（单据由发货/采购收货自动生成） */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { dateOnly, daysBetween, fmtDate, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { dec, money, MoneySum, subMoney } from '../common/money';
import { inList, like, paginate } from '../common/paginate';
import { inc, ser } from '../common/presenter';
import { PrismaService } from '../common/prisma.service';
import { CurrencyTotals, normCurrency, RateBook } from './currency';
import type { PaymentDto } from './erp.dto';

const CH = ['payments'];
const BUCKETS = ['未到期', '1-30天', '31-90天', '90天以上'] as const;

@Injectable()
export class FinanceService {
  constructor(private readonly db: PrismaService) {}

  list(q: Record<string, string>) {
    const where: Prisma.FinanceDocWhereInput = {};
    if (q.doc_type) where.doc_type = q.doc_type;
    if (q.status) where.status = inList(q.status);
    if (q.q) where.OR = [{ no: like(q.q) }, { ref_no: like(q.q) }];
    return paginate(this.db.client.financeDoc, 'FinanceDoc', { where, orderBy: { id: 'desc' }, children: CH }, q);
  }

  addPayment(id: number, b: PaymentDto, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const d = await tx.financeDoc.findUnique({ where: { id } });
      if (!d) throw new NotFound('单据');
      const amount = money(b.amount);
      if (amount <= 0) throw new BizError('金额必须大于 0');
      const balance = subMoney(d.amount, d.paid_amount);
      if (amount > balance) throw new BizError(`金额超过未结余额 ${balance.toFixed(2)}`);
      const paid = new MoneySum().add(d.paid_amount).add(amount).value;
      const row = await tx.financeDoc.update({
        where: { id },
        data: {
          paid_amount: paid,
          status: dec(paid).gte(d.amount) ? 'PAID' : 'PARTIAL',
          payments: {
            create: {
              pay_date: dateOnly(b.pay_date) ?? today(), amount, method: b.method, reference: b.reference ?? null,
              remark: b.remark ?? null, created_by: user.username,
            },
          },
        },
        include: inc('FinanceDoc', CH),
      });
      return ser('FinanceDoc', row, CH);
    });
  }

  /**
   * 应收应付账龄汇总：按往来单位 + 币别、逾期天数分段（原币金额），并给出本位币合计。
   * 本位币折算按报表日（今天）适用汇率；缺汇率的币别不计入本位币合计，在 missing_rates 中列出。
   */
  async summary() {
    const docs = await this.db.client.financeDoc.findMany({ where: { status: { not: 'PAID' } }, orderBy: { id: 'asc' }, include: { customer: true, supplier: true } });
    const t = today();
    const book = await RateBook.load(this.db.client);
    type Acc = { partner: string | null; currency: string; sums: Record<string, MoneySum> };
    const groups: Record<string, Map<string, Acc>> = { AR: new Map(), AP: new Map() };
    for (const d of docs) {
      const group = groups[d.doc_type];
      if (!group) continue;
      const overdue = d.due_date ? daysBetween(t, d.due_date) : 0;
      const bucket = overdue <= 0 ? BUCKETS[0] : overdue <= 30 ? BUCKETS[1] : overdue <= 90 ? BUCKETS[2] : BUCKETS[3];
      const partner: string | null = d.customer ? d.customer.name : (d.supplier?.name ?? null);
      const currency = normCurrency(d.currency);
      const key = JSON.stringify([partner || '-', currency]);
      let acc = group.get(key);
      if (!acc) {
        acc = { partner, currency, sums: Object.fromEntries([...BUCKETS, 'total'].map((k) => [k, new MoneySum()])) };
        group.set(key, acc);
      }
      const balance = subMoney(d.amount, d.paid_amount);
      acc.sums[bucket].add(balance);
      acc.sums.total.add(balance);
    }
    const build = (group: Map<string, Acc>) => {
      const rows: Record<string, any>[] = [];
      const base: Record<string, MoneySum> = Object.fromEntries([...BUCKETS, 'total'].map((k) => [k, new MoneySum()]));
      const byCur = new CurrencyTotals();
      const missing = new Set<string>();
      for (const acc of group.values()) {
        const row: Record<string, any> = { partner: acc.partner, currency: acc.currency };
        for (const k of [...BUCKETS, 'total']) row[k] = acc.sums[k].value;
        row.total_base = book.toBase(row.total, acc.currency, t);
        if (row.total_base === null) missing.add(acc.currency);
        else for (const k of [...BUCKETS, 'total']) base[k].add(book.toBase(row[k], acc.currency, t));
        byCur.add(acc.currency, row.total);
        rows.push(row);
      }
      const totals: Record<string, any> = { currency: book.base };
      for (const k of [...BUCKETS, 'total']) totals[k] = base[k].value;
      totals.by_currency = byCur.byCurrency(book.base);
      totals.missing_rates = [...missing].sort();
      return { rows, totals };
    };
    const ar = build(groups.AR);
    const ap = build(groups.AP);
    return {
      base_currency: book.base,
      rate_date: fmtDate(t),
      AR: ar.rows,
      AP: ap.rows,
      totals: { AR: ar.totals, AP: ap.totals },
      missing_rates: [...new Set([...ar.totals.missing_rates, ...ap.totals.missing_rates])].sort(),
    };
  }

  /** 本位币与当前适用汇率（前端显示用） */
  async currencies() {
    const book = await RateBook.load(this.db.client);
    return { base_currency: book.base, rate_date: fmtDate(today()), rates: book.latest() };
  }
}
