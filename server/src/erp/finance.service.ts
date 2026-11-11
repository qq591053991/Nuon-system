/** 应收(AR) / 应付(AP)：单据查询、登记收付款、账龄汇总（单据由发货/采购收货自动生成） */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { dateOnly, daysBetween, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { round, round2 } from '../common/num';
import { inList, like, paginate } from '../common/paginate';
import { inc, ser } from '../common/presenter';
import { PrismaService } from '../common/prisma.service';
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
      const balance = round((d.amount || 0) - (d.paid_amount || 0), 4);
      if (b.amount > balance + 0.005) throw new BizError(`金额超过未结余额 ${balance.toFixed(2)}`);
      const paid = round2((d.paid_amount || 0) + b.amount);
      const row = await tx.financeDoc.update({
        where: { id },
        data: {
          paid_amount: paid,
          status: paid + 0.005 >= d.amount ? 'PAID' : 'PARTIAL',
          payments: {
            create: {
              pay_date: dateOnly(b.pay_date) ?? today(), amount: b.amount, method: b.method, reference: b.reference ?? null,
              remark: b.remark ?? null, created_by: user.username,
            },
          },
        },
        include: inc('FinanceDoc', CH),
      });
      return ser('FinanceDoc', row, CH);
    });
  }

  /** 应收应付账龄汇总：按往来单位、逾期天数分段 */
  async summary() {
    const docs = await this.db.client.financeDoc.findMany({ where: { status: { not: 'PAID' } }, orderBy: { id: 'asc' }, include: { customer: true, supplier: true } });
    const t = today();
    const out: Record<string, Map<string, Record<string, any>>> = { AR: new Map(), AP: new Map() };
    for (const d of docs) {
      const group = out[d.doc_type];
      if (!group) continue;
      const overdue = d.due_date ? daysBetween(t, d.due_date) : 0;
      const bucket = overdue <= 0 ? BUCKETS[0] : overdue <= 30 ? BUCKETS[1] : overdue <= 90 ? BUCKETS[2] : BUCKETS[3];
      const partner: string | null = d.customer ? d.customer.name : (d.supplier?.name ?? null);
      const key = partner || '-';
      let row = group.get(key);
      if (!row) {
        row = { partner, [BUCKETS[0]]: 0, [BUCKETS[1]]: 0, [BUCKETS[2]]: 0, [BUCKETS[3]]: 0, total: 0 };
        group.set(key, row);
      }
      const balance = round((d.amount || 0) - (d.paid_amount || 0), 4);
      row[bucket] = round2(row[bucket] + balance);
      row.total = round2(row.total + balance);
    }
    return { AR: [...out.AR.values()], AP: [...out.AP.values()] };
  }
}
