/**
 * 应收(AR) / 应付(AP) / 预收(PR) / 预付(PP)：
 *   单据查询（往来单位/期间/币别/状态筛选、排序）、记账汇率与本位币、收付款（实收汇率/手续费/汇兑差异）、
 *   合并收付款（按到期日自动分配）、超额转预收、预收冲抵、作废（核销回滚）、账龄（截止日/区间/两种汇率口径/下钻）、金蝶凭证引出。
 * 单据由发货/采购收货自动生成；记账汇率 = 单据日期适用汇率（缺汇率时暂不记账，补录汇率后自动补记）。
 */
import { Injectable } from '@nestjs/common';
import type { FinanceDoc, Payment, Prisma } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { addDays, dateOnly, daysBetween, fmtDate, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { dec, money, MoneySum, subMoney } from '../common/money';
import { inList, like, paginate, sortArg } from '../common/paginate';
import { inc, ser } from '../common/presenter';
import { PrismaService, type Tx } from '../common/prisma.service';
import { config } from '../config';
import { NumberingService } from '../core/numbering.service';
import { atRate, bookingOf, CurrencyTotals, normCurrency, RateBook, settleBase } from './currency';
import type { PaymentDto } from './erp.dto';

const CH = ['payments'];
type Kind = 'AR' | 'AP';
/** 单据类型 → 收/付方向（预收归应收方向，预付归应付方向） */
export const KIND_OF: Record<string, Kind> = { AR: 'AR', PR: 'AR', AP: 'AP', PP: 'AP' };
/** 超额收付款转入的预收/预付单类型 */
export const ADV_OF: Record<Kind, 'PR' | 'PP'> = { AR: 'PR', AP: 'PP' };
const OPEN = ['OPEN', 'PARTIAL'];
/** 预收冲抵 / 预付冲抵的结算方式（不经银行） */
export const OFFSET_METHOD = { AR: '预收冲抵', AP: '预付冲抵' } as const;
const ADV_SIDE_METHOD = { AR: '冲抵应收', AP: '冲抵应付' } as const;
const TEXT = {
  AR: { partner: '客户', doc: '应收', pay: '收款', adv: '预收款', open: '未结应收' },
  AP: { partner: '供应商', doc: '应付', pay: '付款', adv: '预付款', open: '未结应付' },
};

/**
 * 金蝶凭证引出的科目映射（假设：中国企业会计准则科目表）。应收/应付单按往来单位税率拆分增值税：
 *   应收 借 应收账款（价税合计）/ 贷 主营业务收入（不含税）+ 应交税费-应交增值税（销项税额）；
 *   应付 借 原材料（不含税）+ 应交税费-应交增值税（进项税额）/ 贷 应付账款（价税合计）。
 * 可用环境变量 KINGDEE_ACCOUNTS（JSON，如 {"FEE":{"code":"6603.01","name":"财务费用-手续费"}}）按企业科目表覆盖。
 */
export const ACCOUNTS: Record<string, { code: string; name: string; aux?: string }> = {
  AR: { code: '1122', name: '应收账款', aux: '客户' },
  AP: { code: '2202', name: '应付账款', aux: '供应商' },
  PR: { code: '2203', name: '预收账款', aux: '客户' },
  PP: { code: '1123', name: '预付账款', aux: '供应商' },
  REVENUE: { code: '6001', name: '主营业务收入' },
  MATERIAL: { code: '1403', name: '原材料' },
  VAT_OUT: { code: '2221.01.05', name: '应交税费-应交增值税（销项税额）' },
  VAT_IN: { code: '2221.01.01', name: '应交税费-应交增值税（进项税额）' },
  BANK: { code: '1002', name: '银行存款' },
  FEE: { code: '6603.02', name: '财务费用-手续费' },
  FX: { code: '6603.03', name: '财务费用-汇兑损益' },
};
try {
  Object.assign(ACCOUNTS, JSON.parse(process.env.KINGDEE_ACCOUNTS || '{}'));
} catch {
  /* 配置格式错误时沿用默认科目 */
}

/** 账龄区间：边界天数（默认 30/90 → 未到期、1-30天、31-90天、90天以上） */
export function agingBuckets(raw?: string): { edges: number[]; labels: string[] } {
  const edges = [...new Set(String(raw || '30,90').split(',').map((x) => Math.round(Number(x))).filter((x) => x > 0))].sort((a, b) => a - b).slice(0, 8);
  if (!edges.length) edges.push(30, 90);
  const labels = ['未到期'];
  edges.forEach((e, i) => labels.push(`${i === 0 ? 1 : edges[i - 1] + 1}-${e}天`));
  labels.push(`${edges[edges.length - 1]}天以上`);
  return { edges, labels };
}

/** 期间（YYYY-MM）或日期范围 → [from, to] */
function periodRange(q: Record<string, string>): { from: Date | null; to: Date | null } {
  if (q.period) {
    const m = /^(\d{4})-(\d{1,2})$/.exec(q.period.trim());
    if (!m) throw new BizError(`期间格式应为 YYYY-MM，如 2026-11（收到：${q.period}）`);
    const from = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
    const to = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0));
    return { from, to };
  }
  return { from: dateOnly(q.date_from), to: dateOnly(q.date_to) };
}

/**
 * 往来单位税率：取客户/供应商主数据的税率；未设时，外币结算的客户视为出口（零税率），其余用默认税率 DEFAULT_VAT_RATE（0.13）。
 */
export const taxRateOf = (p: { tax_rate?: Prisma.Decimal | number | null; currency?: string | null } | null | undefined, kind: 'AR' | 'AP' = 'AR'): number => {
  if (p && p.tax_rate !== null && p.tax_rate !== undefined) return Number(p.tax_rate);
  if (kind === 'AR' && p?.currency && p.currency.toUpperCase() !== config.baseCurrency) return 0;
  return config.defaultVatRate;
};

/** 价税合计拆分：不含税 = 合计 ÷ (1 + 税率)（四舍五入到分），税额 = 合计 − 不含税 */
export function splitTax(gross: number | null, rate: number): { net: number | null; tax: number | null } {
  if (gross === null) return { net: null, tax: null };
  const net = money(dec(gross).div(dec(1).plus(rate)));
  return { net, tax: subMoney(gross, net) };
}

const partnerOf = (d: { customer?: { name: string; code: string } | null; supplier?: { name: string; code: string } | null }) =>
  d.customer ? { name: d.customer.name, code: d.customer.code } : d.supplier ? { name: d.supplier.name, code: d.supplier.code } : { name: null, code: null };

export interface Allocation { doc_id: number; amount: number }
interface SettleInput {
  kind: Kind;
  partner_id: number;
  currency: string;
  /** 核销合计（原币）；应收含银行手续费 */
  amount: number;
  fee_amount?: number | null;
  exchange_rate?: number | null;
  pay_date?: string | null;
  method?: string | null;
  reference?: string | null;
  remark?: string | null;
  /** 收付款银行账户（如 中国银行 6217…1234） */
  bank_account?: string | null;
  allocations?: Allocation[] | null;
  as_advance?: boolean;
}

type DocWithPartner = FinanceDoc & { customer: { name: string; code: string } | null; supplier: { name: string; code: string } | null };

@Injectable()
export class FinanceService {
  constructor(private readonly db: PrismaService, private readonly numbering: NumberingService) {}

  // ======================= 记账汇率 =======================

  /** 补记尚未记账的单据（单据日期适用汇率；缺汇率的保持未记账） */
  async bookPending(): Promise<void> {
    const pending = await this.db.client.financeDoc.count({ where: { exchange_rate: null, status: { not: 'VOID' } } });
    if (!pending) return;
    const book = await RateBook.load(this.db.client);
    await this.db.tx(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(424201)`; // 并发打开多个财务页面时只补记一次
      const docs = await tx.financeDoc.findMany({ where: { exchange_rate: null, status: { not: 'VOID' } } });
      for (const d of docs) {
        const b = bookingOf(book, d.amount, d.currency, d.doc_date);
        if (b.exchange_rate !== null) await tx.financeDoc.update({ where: { id: d.id }, data: b });
      }
    });
  }

  /** 单据的记账汇率（未记账时按单据日期即时记账） */
  private async bookRate(tx: Tx, d: FinanceDoc, book: RateBook): Promise<number | null> {
    if (d.exchange_rate !== null) return d.exchange_rate.toNumber();
    const b = bookingOf(book, d.amount, d.currency, d.doc_date);
    if (b.exchange_rate === null) return null;
    await tx.financeDoc.update({ where: { id: d.id }, data: b });
    return b.exchange_rate;
  }

  // ======================= 查询 =======================

  private docWhere(q: Record<string, string>): Prisma.FinanceDocWhereInput {
    const and: Prisma.FinanceDocWhereInput[] = [];
    const where: Prisma.FinanceDocWhereInput = { AND: and };
    if (q.doc_type) where.doc_type = inList(q.doc_type);
    where.status = q.status ? inList(q.status) : { not: 'VOID' };
    if (q.q) {
      const s = like(q.q);
      and.push({
        OR: [
          { no: s }, { ref_no: s }, { remark: s },
          { customer: { OR: [{ name: s }, { code: s }, { short_name: s }] } },
          { supplier: { OR: [{ name: s }, { code: s }, { short_name: s }] } },
        ],
      });
    }
    const pid = Number(q.partner_id) || 0;
    if (pid) {
      const kind = KIND_OF[String(q.doc_type || '').split(',')[0]];
      and.push(kind === 'AR' ? { customer_id: pid } : kind === 'AP' ? { supplier_id: pid } : { OR: [{ customer_id: pid }, { supplier_id: pid }] });
    }
    if (Number(q.customer_id)) and.push({ customer_id: Number(q.customer_id) });
    if (Number(q.supplier_id)) and.push({ supplier_id: Number(q.supplier_id) });
    if (q.currency) where.currency = inList(q.currency.toUpperCase());
    const { from, to } = periodRange(q);
    if (from || to) where.doc_date = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    if (q.due_to) and.push({ due_date: { lte: dateOnly(q.due_to)! } });
    if (q.overdue === '1' || q.overdue === 'true') and.push({ due_date: { lt: today() }, status: { in: OPEN } });
    // N 天内到期（含已逾期）的未结单据
    if (q.due_within !== undefined && q.due_within !== '' && Number.isFinite(Number(q.due_within))) {
      and.push({ due_date: { lte: addDays(today(), Number(q.due_within)) }, status: { in: OPEN } });
    }
    return where;
  }

  /** 补充：往来单位编码、本位币余额、来料 IQC 状态（应付） */
  private async decorate(items: any[]): Promise<any[]> {
    const receiptNos = items.filter((d) => d.doc_type === 'AP' && d.ref_type === 'RECEIPT' && d.ref_no).map((d) => d.ref_no as string);
    const iqc = await this.iqcOf(receiptNos);
    return items.map((d) => {
      const rate = d.exchange_rate === null || d.exchange_rate === undefined ? null : Number(d.exchange_rate);
      return {
        ...d,
        kind: KIND_OF[d.doc_type] ?? d.doc_type,
        base_balance: rate === null ? null : atRate(d.balance, rate),
        valid_payments: (d.payments || []).filter((p: any) => p.status !== 'VOID').length,
        iqc: d.doc_type === 'AP' ? (iqc.get(d.ref_no) ?? null) : undefined,
      };
    });
  }

  /** 入库单 → 来料检验状态（付款前提示） */
  async iqcOf(receiptNos: string[]): Promise<Map<string, { status: string; text: string; lines: any[] }>> {
    const out = new Map<string, { status: string; text: string; lines: any[] }>();
    if (!receiptNos.length) return out;
    const rcs = await this.db.client.receipt.findMany({ where: { no: { in: [...new Set(receiptNos)] } }, include: { lines: { include: { material: true }, orderBy: { line_no: 'asc' } } } });
    const inspIds = rcs.flatMap((r) => r.lines.map((l) => l.inspection_id).filter((x): x is number => !!x));
    const insps = new Map((await this.db.client.inspection.findMany({ where: { id: { in: inspIds } } })).map((i) => [i.id, i]));
    for (const rc of rcs) {
      const lines = rc.lines.map((l) => {
        const ins = l.inspection_id ? insps.get(l.inspection_id) : undefined;
        return {
          material_code: l.material.code, material_name: l.material.name, lot_no: l.lot_no, qty: l.qty, uom: l.material.uom,
          inspection_id: ins?.id ?? null, inspection_no: ins?.no ?? null, status: ins ? ins.status : 'EXEMPT',
        };
      });
      const has = (s: string) => lines.some((l) => l.status === s);
      const status = has('REJECTED') ? 'REJECTED' : has('PENDING') ? 'PENDING' : has('CONCESSION') ? 'CONCESSION' : lines.every((l) => l.status === 'EXEMPT') ? 'EXEMPT' : 'PASSED';
      const text = { REJECTED: '来料检验不合格', PENDING: '来料待检验', CONCESSION: '让步接收', EXEMPT: '免检', PASSED: '来料检验合格' }[status]!;
      out.set(rc.no, { status, text, lines });
    }
    return out;
  }

  async list(q: Record<string, string>) {
    await this.bookPending();
    const page = await paginate(this.db.client.financeDoc, 'FinanceDoc', { where: this.docWhere(q), orderBy: { id: 'desc' }, children: CH }, q);
    page.items = await this.decorate(page.items);
    return page;
  }

  async get(id: number) {
    await this.bookPending();
    const d = await this.db.client.financeDoc.findUnique({ where: { id }, include: inc('FinanceDoc', CH) });
    if (!d) throw new NotFound('单据');
    return (await this.decorate([ser('FinanceDoc', d, CH)]))[0];
  }

  /** 收付款流水（含已作废，可筛选） */
  async payments(q: Record<string, string>) {
    const and: Prisma.PaymentWhereInput[] = [];
    const where: Prisma.PaymentWhereInput = { AND: and };
    if (q.status) where.status = inList(q.status);
    const doc: Prisma.FinanceDocWhereInput = {};
    if (q.doc_type) doc.doc_type = inList(q.doc_type);
    if (q.kind === 'AR' || q.kind === 'AP') doc.doc_type = { in: Object.keys(KIND_OF).filter((k) => KIND_OF[k] === q.kind) };
    const pid = Number(q.partner_id) || 0;
    const pk = q.kind === 'AR' || q.kind === 'AP' ? q.kind : KIND_OF[String(q.doc_type || '').split(',')[0]];
    if (pid) Object.assign(doc, pk === 'AR' ? { customer_id: pid } : pk === 'AP' ? { supplier_id: pid } : { OR: [{ customer_id: pid }, { supplier_id: pid }] });
    if (q.currency) doc.currency = inList(q.currency.toUpperCase());
    where.doc = doc;
    const { from, to } = periodRange(q);
    if (from || to) where.pay_date = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    if (q.q) {
      const s = like(q.q);
      and.push({
        OR: [
          { receipt_no: s }, { reference: s }, { remark: s }, { doc: { no: s } },
          { doc: { customer: { name: s } } }, { doc: { supplier: { name: s } } },
        ],
      });
    }
    const page = Math.max(Number(q.page) || 1, 1);
    const size = Math.min(Math.max(Number(q.page_size) || 20, 1), 5000);
    const c = this.db.client;
    const [total, rows] = await Promise.all([
      c.payment.count({ where }),
      c.payment.findMany({
        where, orderBy: sortArg('Payment', q, [{ pay_date: 'desc' }, { id: 'desc' }]), skip: (page - 1) * size, take: size,
        include: { doc: { include: { customer: true, supplier: true } } },
      }),
    ]);
    // 银行到账金额：应收 = 核销 − 手续费，应付 = 核销 + 手续费；冲抵记录不经银行为 0。同一收付款单号超额转入的预收/预付单一并列出
    const receiptNos = [...new Set(rows.map((r) => r.receipt_no).filter((x): x is string => !!x))];
    const advs = receiptNos.length
      ? await c.financeDoc.findMany({ where: { doc_type: { in: ['PR', 'PP'] }, ref_type: 'PAYMENT', ref_no: { in: receiptNos } }, select: { no: true, ref_no: true, amount: true, status: true } })
      : [];
    const firstOf = new Map<string, number>();
    rows.forEach((r) => r.receipt_no && !firstOf.has(r.receipt_no) && firstOf.set(r.receipt_no, r.id));
    const items = rows.map(({ doc: d, ...p }) => {
      const pt = partnerOf(d);
      const kind = KIND_OF[d.doc_type];
      const offset = Object.values(OFFSET_METHOD).includes(p.method as any) || d.doc_type === 'PR' || d.doc_type === 'PP';
      const amount = money(p.amount);
      const fee = money(p.fee_amount);
      const adv = p.receipt_no && firstOf.get(p.receipt_no) === p.id ? advs.find((a) => a.ref_no === p.receipt_no) : undefined;
      const bank = offset ? 0 : kind === 'AR' ? subMoney(amount, fee) : money(amount + fee);
      return {
        ...ser('Payment', p), doc_no: d.no, doc_type: d.doc_type, kind, currency: d.currency, booking_rate: d.exchange_rate,
        partner_name: pt.name, partner_code: pt.code, ref_no: d.ref_no,
        bank_amount: adv && adv.status !== 'VOID' ? money(bank + money(adv.amount)) : bank,
        advance_no: adv?.no ?? null, advance_amount: adv ? money(adv.amount) : null,
      };
    });
    return { items, total, page, page_size: size };
  }

  /** 应收单登记发票号/开票日期（金蝶凭证摘要带发票号） */
  setInvoice(id: number, b: { invoice_no?: string | null; invoice_date?: string | null }) {
    return this.db.tx(async (tx) => {
      const d = await tx.financeDoc.findUnique({ where: { id } });
      if (!d) throw new NotFound('单据');
      if (d.status === 'VOID') throw new BizError(`${d.no} 已作废`);
      const no = (b.invoice_no ?? '').trim() || null;
      const row = await tx.financeDoc.update({
        where: { id }, data: { invoice_no: no, invoice_date: no ? (dateOnly(b.invoice_date) ?? today()) : null }, include: inc('FinanceDoc', CH),
      });
      return (await this.decorate([ser('FinanceDoc', row, CH)]))[0];
    });
  }

  // ======================= 收付款 =======================

  /** 单张单据登记收付款（超额部分可转预收/预付） */
  addPayment(id: number, b: PaymentDto, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM fin_doc WHERE id = ${id} FOR UPDATE`;
      const d = await tx.financeDoc.findUnique({ where: { id } });
      if (!d) throw new NotFound('单据');
      const kind = KIND_OF[d.doc_type];
      if (!kind || d.doc_type !== kind) throw new BizError(`${d.no} 是${TEXT[kind ?? 'AR'].adv}单，不能直接登记收付款；请在${TEXT[kind ?? 'AR'].doc}单上选择“用${TEXT[kind ?? 'AR'].adv}冲抵”`);
      if (d.status === 'VOID') throw new BizError(`${d.no} 已作废`);
      const amount = money(b.amount);
      if (amount <= 0) throw new BizError('金额必须大于 0');
      const balance = subMoney(d.amount, d.paid_amount);
      if (amount > balance && !b.as_advance) {
        throw new BizError(`金额超过未结余额 ${balance.toFixed(2)}（超出 ${subMoney(amount, balance).toFixed(2)}）。如${TEXT[kind].partner}多付，请选择“超出部分转${TEXT[kind].adv}”`);
      }
      const apply = Math.min(amount, Math.max(balance, 0));
      await this.post(tx, user, {
        kind, partner_id: (kind === 'AR' ? d.customer_id : d.supplier_id)!, currency: d.currency, amount, fee_amount: b.fee_amount, exchange_rate: b.exchange_rate,
        pay_date: b.pay_date, method: b.method, reference: b.reference, remark: b.remark, bank_account: b.bank_account, as_advance: !!b.as_advance,
        allocations: apply > 0 ? [{ doc_id: d.id, amount: apply }] : [],
      });
      const row = await tx.financeDoc.findUnique({ where: { id }, include: inc('FinanceDoc', CH) });
      return ser('FinanceDoc', row, CH);
    });
  }

  /** 合并收付款：一笔银行流水核销多张单据（未指定分配时按到期日先后自动分配）；dry_run 只返回分配方案 */
  async settle(b: SettleInput & { dry_run?: boolean }, user: CurrentUser) {
    if (b.dry_run) return this.plan(this.db.client as unknown as Tx, b);
    return this.db.tx(async (tx) => this.post(tx, user, b));
  }

  /** 计算分配方案（不写库） */
  private async plan(tx: Tx, b: SettleInput) {
    const kind = b.kind;
    const currency = normCurrency(b.currency);
    const amount = money(b.amount);
    if (!(amount > 0)) throw new BizError('金额必须大于 0');
    const docs = (await tx.financeDoc.findMany({
      where: { doc_type: kind, currency, status: { in: OPEN }, ...(kind === 'AR' ? { customer_id: b.partner_id } : { supplier_id: b.partner_id }) },
      orderBy: [{ due_date: { sort: 'asc', nulls: 'last' } }, { doc_date: 'asc' }, { id: 'asc' }],
    })) as FinanceDoc[];
    const byId = new Map(docs.map((d) => [d.id, d]));
    const openTotal = new MoneySum();
    docs.forEach((d) => openTotal.add(subMoney(d.amount, d.paid_amount)));
    const allocs: { doc: FinanceDoc; amount: number }[] = [];
    if (b.allocations) {
      const seen = new Set<number>();
      for (const a of b.allocations) {
        const d = byId.get(a.doc_id);
        if (!d) throw new BizError(`单据 ID ${a.doc_id} 不是该${TEXT[kind].partner}的${currency}${TEXT[kind].open}，不能核销`);
        if (seen.has(d.id)) throw new BizError(`${d.no} 重复分配`);
        seen.add(d.id);
        const v = money(a.amount);
        if (v <= 0) continue;
        const bal = subMoney(d.amount, d.paid_amount);
        if (v > bal) throw new BizError(`${d.no} 分配 ${v.toFixed(2)} 超过其未结余额 ${bal.toFixed(2)}`);
        allocs.push({ doc: d, amount: v });
      }
    } else {
      let left = amount;
      for (const d of docs) {
        if (left <= 0) break;
        const v = Math.min(left, subMoney(d.amount, d.paid_amount));
        if (v <= 0) continue;
        allocs.push({ doc: d, amount: v });
        left = subMoney(left, v);
      }
    }
    const used = new MoneySum();
    allocs.forEach((a) => used.add(a.amount));
    const excess = subMoney(amount, used.value);
    if (excess < 0) throw new BizError(`分配合计 ${used.value.toFixed(2)} 超过${TEXT[kind].pay}金额 ${amount.toFixed(2)}`);
    return {
      kind, currency, amount, open_total: openTotal.value, applied: used.value, excess,
      allocations: allocs.map((a) => ({
        doc_id: a.doc.id, no: a.doc.no, doc_date: fmtDate(a.doc.doc_date), due_date: fmtDate(a.doc.due_date), ref_no: a.doc.ref_no,
        balance: subMoney(a.doc.amount, a.doc.paid_amount), amount: a.amount, balance_after: subMoney(subMoney(a.doc.amount, a.doc.paid_amount), a.amount),
      })),
      _docs: allocs,
    };
  }

  /** 写入一笔收付款（同一收付款单号下的多条核销 + 可选的预收/预付） */
  private async post(tx: Tx, user: CurrentUser, b: SettleInput) {
    const kind = b.kind;
    const t = TEXT[kind];
    const partnerId = Number(b.partner_id);
    if (!partnerId) throw new BizError(`请选择${t.partner}`);
    if (kind === 'AR' ? !(await tx.customer.findUnique({ where: { id: partnerId } })) : !(await tx.supplier.findUnique({ where: { id: partnerId } }))) throw new NotFound(t.partner);
    // 锁定该往来单位的未结单据，避免并发超额核销
    const ids = (await tx.financeDoc.findMany({
      where: { doc_type: kind, status: { in: OPEN }, ...(kind === 'AR' ? { customer_id: partnerId } : { supplier_id: partnerId }) }, select: { id: true },
    })).map((x) => x.id);
    if (ids.length) await tx.$queryRawUnsafe(`SELECT id FROM fin_doc WHERE id IN (${ids.map(Number).join(',')}) FOR UPDATE`);
    const p = await this.plan(tx, b);
    if (p.excess > 0 && !b.as_advance) {
      throw new BizError(
        `${t.pay}金额 ${p.amount.toFixed(2)} 超过该${t.partner} ${p.currency} ${t.open}合计 ${p.open_total.toFixed(2)}（超出 ${p.excess.toFixed(2)}）。如${t.partner}多付/预付，请选择“超出部分转${t.adv}”`,
      );
    }
    const fee = money(b.fee_amount ?? 0);
    if (fee < 0) throw new BizError('手续费不能为负数');
    if (fee > 0 && !p._docs.length) throw new BizError(`没有可核销的${t.doc}单时不能填写手续费；如为${t.adv}，请按实际到账金额登记`);
    if (kind === 'AR' && fee > p.applied) throw new BizError(`手续费 ${fee.toFixed(2)} 不能大于核销金额 ${p.applied.toFixed(2)}`);
    const payDate = dateOnly(b.pay_date) ?? today();
    const book = await RateBook.load(tx);
    const currency = p.currency;
    let rate: number | null = b.exchange_rate ? Number(b.exchange_rate) : null;
    if (!rate) rate = book.rate(currency, payDate)?.rate ?? null;
    if (!rate) throw new BizError(`缺少 ${currency} 在 ${fmtDate(payDate)} 适用的汇率：请填写${kind === 'AR' ? '实收' : '实付'}汇率，或先在“汇率”中维护`);
    if (currency === book.base) rate = 1;
    const receiptNo = await this.numbering.nextNo(tx, kind === 'AR' ? 'SK' : 'FK');
    let feeLeft = fee;
    const created: Payment[] = [];
    for (const a of p._docs) {
      const bookRate = (await this.bookRate(tx, a.doc, book)) ?? rate;
      // 应收手续费从货款中扣除：依次分摊到各张单据；应付手续费另付，全部记在第一条
      const f = kind === 'AR' ? Math.min(feeLeft, a.amount) : created.length === 0 ? fee : 0;
      feeLeft = subMoney(feeLeft, f);
      const s = settleBase(kind, a.amount, f, rate, bookRate);
      created.push(
        await tx.payment.create({
          data: {
            doc_id: a.doc.id, pay_date: payDate, amount: a.amount, exchange_rate: rate, base_amount: s.base_amount, fee_amount: f, fx_diff: s.fx_diff,
            receipt_no: receiptNo, status: 'VALID', method: b.method === undefined ? '银行转账' : b.method, reference: b.reference ?? null, remark: b.remark ?? null, created_by: user.username,
            bank_account: b.bank_account?.trim() || null,
          },
        }),
      );
      await this.recalc(tx, a.doc.id);
    }
    let advance: FinanceDoc | null = null;
    if (p.excess > 0) {
      const advType = ADV_OF[kind];
      advance = await tx.financeDoc.create({
        data: {
          no: await this.numbering.nextNo(tx, advType === 'PR' ? 'YS' : 'YF'), doc_type: advType,
          customer_id: kind === 'AR' ? partnerId : null, supplier_id: kind === 'AP' ? partnerId : null,
          ref_type: 'PAYMENT', ref_no: receiptNo, doc_date: payDate, due_date: null, currency, amount: p.excess, exchange_rate: rate,
          base_amount: atRate(p.excess, rate), status: 'OPEN', created_by: user.username,
          remark: `${t.pay} ${receiptNo} 超出${t.open}部分转${t.adv}${b.reference ? `（流水号 ${b.reference}）` : ''}`,
        },
      });
    }
    return {
      receipt_no: receiptNo, kind, currency, exchange_rate: rate, pay_date: fmtDate(payDate), amount: p.amount, fee_amount: fee,
      payments: created.map((x) => ser('Payment', x)), allocations: p.allocations, advance: advance ? ser('FinanceDoc', advance) : null,
    };
  }

  /** 已收/付金额 = 有效收付款合计；状态随之更新 */
  private async recalc(tx: Tx, docId: number) {
    const d = await tx.financeDoc.findUnique({ where: { id: docId } });
    if (!d || d.status === 'VOID') return;
    const agg = await tx.payment.aggregate({ where: { doc_id: docId, status: 'VALID' }, _sum: { amount: true } });
    const paid = money(agg._sum.amount ?? 0);
    const status = paid > 0 && dec(paid).gte(d.amount) ? 'PAID' : paid > 0 ? 'PARTIAL' : 'OPEN';
    if (!dec(paid).equals(d.paid_amount) || status !== d.status) await tx.financeDoc.update({ where: { id: docId }, data: { paid_amount: paid, status } });
  }

  /** 预收/预付冲抵应收/应付（不经银行） */
  applyAdvance(id: number, b: { advance_id: number; amount?: number | null; remark?: string | null }, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM fin_doc WHERE id IN (${id}, ${b.advance_id}) FOR UPDATE`;
      const d = await tx.financeDoc.findUnique({ where: { id } });
      const adv = await tx.financeDoc.findUnique({ where: { id: b.advance_id } });
      if (!d) throw new NotFound('单据');
      if (!adv) throw new NotFound('预收/预付单');
      const kind = KIND_OF[d.doc_type];
      if (d.doc_type !== kind || adv.doc_type !== ADV_OF[kind]) throw new BizError(`只能用${TEXT[kind].adv}冲抵${TEXT[kind].doc}单`);
      const same = kind === 'AR' ? d.customer_id === adv.customer_id : d.supplier_id === adv.supplier_id;
      if (!same || normCurrency(d.currency) !== normCurrency(adv.currency)) throw new BizError(`${adv.no} 与 ${d.no} 的${TEXT[kind].partner}或币别不一致，不能冲抵`);
      const bal = subMoney(d.amount, d.paid_amount);
      const advBal = subMoney(adv.amount, adv.paid_amount);
      if (adv.status === 'VOID' || advBal <= 0) throw new BizError(`${adv.no} 没有可用余额`);
      const amount = money(b.amount ?? Math.min(bal, advBal));
      if (amount <= 0) throw new BizError('冲抵金额必须大于 0');
      if (amount > bal) throw new BizError(`冲抵金额 ${amount.toFixed(2)} 超过 ${d.no} 未结余额 ${bal.toFixed(2)}`);
      if (amount > advBal) throw new BizError(`冲抵金额 ${amount.toFixed(2)} 超过 ${adv.no} 可用余额 ${advBal.toFixed(2)}`);
      const book = await RateBook.load(tx);
      const advRate = adv.exchange_rate?.toNumber() ?? book.rate(adv.currency, adv.doc_date)?.rate ?? 1;
      const docRate = (await this.bookRate(tx, d, book)) ?? advRate;
      const no = await this.numbering.nextNo(tx, 'HX');
      const s = settleBase(kind, amount, 0, advRate, docRate);
      const common = { pay_date: today(), amount, exchange_rate: advRate, fee_amount: 0, receipt_no: no, status: 'VALID', remark: b.remark ?? null, created_by: user.username };
      await tx.payment.create({ data: { ...common, doc_id: d.id, base_amount: s.base_amount, fx_diff: s.fx_diff, method: OFFSET_METHOD[kind], reference: adv.no } });
      await tx.payment.create({ data: { ...common, doc_id: adv.id, base_amount: atRate(amount, advRate), fx_diff: 0, method: ADV_SIDE_METHOD[kind], reference: d.no } });
      await this.recalc(tx, d.id);
      await this.recalc(tx, adv.id);
      const row = await tx.financeDoc.findUnique({ where: { id }, include: inc('FinanceDoc', CH) });
      return ser('FinanceDoc', row, CH);
    });
  }

  /**
   * 作废收付款：同一收付款单号下的全部核销一起作废（一笔银行流水为一个整体），已收/付金额回滚；
   * 该笔款转出的预收/预付单一并作废（已被冲抵的需先作废冲抵记录）。
   */
  voidPayment(paymentId: number, reason: string, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const why = String(reason ?? '').trim();
      if (why.length < 2) throw new BizError('请填写作废原因（如：登错客户、金额录错、银行退汇）');
      const p = await tx.payment.findUnique({ where: { id: paymentId }, include: { doc: true } });
      if (!p) throw new NotFound('收付款记录');
      if (p.status === 'VOID') throw new BizError(`该笔${TEXT[KIND_OF[p.doc.doc_type] ?? 'AR'].pay}已于 ${p.voided_at ? fmtDate(p.voided_at) : ''} 作废`);
      const group = p.receipt_no ? await tx.payment.findMany({ where: { receipt_no: p.receipt_no, status: 'VALID' }, include: { doc: true } }) : [p];
      const docIds = [...new Set(group.map((x) => x.doc_id))];
      const advDocs = p.receipt_no
        ? await tx.financeDoc.findMany({ where: { ref_type: 'PAYMENT', ref_no: p.receipt_no, doc_type: { in: ['PR', 'PP'] }, status: { not: 'VOID' } } })
        : [];
      const lockIds = [...docIds, ...advDocs.map((x) => x.id)];
      await tx.$queryRawUnsafe(`SELECT id FROM fin_doc WHERE id IN (${lockIds.map(Number).join(',')}) FOR UPDATE`);
      for (const a of advDocs) {
        const fresh = await tx.financeDoc.findUnique({ where: { id: a.id } });
        if (fresh && fresh.paid_amount.gt(0)) {
          const used = await tx.payment.findMany({ where: { doc_id: a.id, status: 'VALID' } });
          throw new BizError(`该笔款转出的${TEXT[KIND_OF[a.doc_type]].adv} ${a.no} 已冲抵 ${fresh.paid_amount.toFixed(2)}，请先作废冲抵记录（${[...new Set(used.map((u) => u.receipt_no))].join('、')}）`);
        }
      }
      const now = new Date();
      for (const x of group) {
        await tx.payment.update({ where: { id: x.id }, data: { status: 'VOID', void_reason: why, voided_by: user.full_name || user.username, voided_at: now } });
      }
      for (const a of advDocs) await tx.financeDoc.update({ where: { id: a.id }, data: { status: 'VOID', remark: `${a.remark ?? ''}（随 ${p.receipt_no} 作废：${why}）`.slice(0, 1000) } });
      for (const id of docIds) await this.recalc(tx, id);
      return {
        receipt_no: p.receipt_no, voided: group.length, reason: why,
        docs: (await tx.financeDoc.findMany({ where: { id: { in: docIds } }, include: inc('FinanceDoc') })).map((d) => ser('FinanceDoc', d)),
        advances_voided: advDocs.map((a) => a.no),
      };
    });
  }

  // ======================= 账龄 =======================

  /**
   * 应收应付账龄：按往来单位 + 币别、逾期天数分段（原币），另给本位币合计与币别小计。
   *   as_of：截止日（只统计该日及以前的单据与有效收付款，默认今天）
   *   basis：closing = 期末汇率（截止日适用汇率，默认）；booking = 记账汇率（单据入账时的汇率）
   *   buckets：区间边界天数，如 30,60,90,180
   *   detail=1：每行附带明细单据（下钻）
   * 缺汇率的币别不计入本位币合计，在 missing_rates 中列出。
   */
  async summary(q: Record<string, string> = {}) {
    await this.bookPending();
    const t = today();
    const asOf = dateOnly(q.as_of) ?? t;
    const basis = q.basis === 'booking' ? 'booking' : 'closing';
    const { edges, labels } = agingBuckets(q.buckets);
    const detail = q.detail === '1' || q.detail === 'true';
    const docs = await this.db.client.financeDoc.findMany({
      where: { doc_type: { in: ['AR', 'AP'] }, doc_date: { lte: asOf }, status: asOf.getTime() >= t.getTime() ? { in: OPEN } : { not: 'VOID' } },
      orderBy: [{ due_date: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      // 截止日余额 = 当前余额 + 截止日之后登记的有效收付款（兼容没有收付款明细、直接导入已收金额的期初单据）
      include: { customer: true, supplier: true, payments: { where: { status: 'VALID', pay_date: { gt: asOf } }, select: { amount: true } } },
    });
    const book = await RateBook.load(this.db.client);
    const keys = [...labels, 'total'];
    type Acc = { partner: string | null; partner_id: number | null; partner_code: string | null; currency: string; sums: Record<string, MoneySum>; base: Record<string, MoneySum>; missing: boolean; docs: any[] };
    const groups: Record<string, Map<string, Acc>> = { AR: new Map(), AP: new Map() };
    const sums = () => Object.fromEntries(keys.map((k) => [k, new MoneySum()]));
    for (const d of docs as DocWithPartner[]) {
      const group = groups[d.doc_type];
      if (!group) continue;
      const later = new MoneySum();
      (d as any).payments.forEach((p: { amount: any }) => later.add(p.amount));
      const balance = money(dec(d.amount).minus(d.paid_amount).plus(later.value));
      if (balance <= 0) continue;
      const overdue = d.due_date ? daysBetween(asOf, d.due_date) : 0;
      let bi = 0;
      if (overdue > 0) {
        const i = edges.findIndex((e) => overdue <= e);
        bi = i < 0 ? labels.length - 1 : i + 1;
      }
      const bucket = labels[bi];
      const pt = partnerOf(d);
      const currency = normCurrency(d.currency);
      const key = JSON.stringify([pt.name || '-', currency]);
      let acc = group.get(key);
      if (!acc) {
        acc = { partner: pt.name, partner_code: pt.code, partner_id: d.customer_id ?? d.supplier_id, currency, sums: sums(), base: sums(), missing: false, docs: [] };
        group.set(key, acc);
      }
      acc.sums[bucket].add(balance);
      acc.sums.total.add(balance);
      const rate = basis === 'booking' ? (d.exchange_rate?.toNumber() ?? book.rate(currency, d.doc_date)?.rate ?? null) : book.rate(currency, asOf)?.rate ?? null;
      const baseBal = rate === null ? null : atRate(balance, rate);
      if (baseBal === null) acc.missing = true;
      else {
        acc.base[bucket].add(baseBal);
        acc.base.total.add(baseBal);
      }
      if (detail) {
        acc.docs.push({
          id: d.id, no: d.no, doc_type: d.doc_type, ref_no: d.ref_no, ref_type: d.ref_type, doc_date: fmtDate(d.doc_date), due_date: fmtDate(d.due_date),
          overdue_days: Math.max(overdue, 0), bucket, amount: money(d.amount), balance, rate, base_balance: baseBal,
        });
      }
    }
    const build = (group: Map<string, Acc>) => {
      const rows: Record<string, any>[] = [];
      const base: Record<string, MoneySum> = sums();
      const byCur = new CurrencyTotals();
      const missing = new Set<string>();
      const subs = new Map<string, { currency: string; sums: Record<string, MoneySum>; base: Record<string, MoneySum>; missing: boolean; rows: number }>();
      for (const acc of group.values()) {
        const row: Record<string, any> = { partner: acc.partner, currency: acc.currency };
        for (const k of keys) row[k] = acc.sums[k].value;
        if (basis === 'closing') {
          // 期末汇率：按行合计折算（与历史口径一致）
          row.total_base = book.toBase(row.total, acc.currency, asOf);
          if (row.total_base === null) missing.add(acc.currency);
          else for (const k of keys) base[k].add(book.toBase(row[k], acc.currency, asOf));
        } else {
          row.total_base = acc.missing ? null : acc.base.total.value;
          if (acc.missing) missing.add(acc.currency);
          else for (const k of keys) base[k].add(acc.base[k].value);
        }
        if (detail) {
          Object.assign(row, {
            partner_id: acc.partner_id, partner_code: acc.partner_code, docs: acc.docs,
            base_buckets: row.total_base === null ? null : Object.fromEntries(keys.map((k) => [k, basis === 'closing' ? book.toBase(row[k], acc.currency, asOf) : acc.base[k].value])),
          });
        }
        byCur.add(acc.currency, row.total);
        let sub = subs.get(acc.currency);
        if (!sub) subs.set(acc.currency, (sub = { currency: acc.currency, sums: sums(), base: sums(), missing: false, rows: 0 }));
        sub.rows += 1;
        for (const k of keys) sub.sums[k].add(row[k]);
        if (row.total_base === null) sub.missing = true;
        else sub.base.total.add(row.total_base);
        rows.push(row);
      }
      const totals: Record<string, any> = { currency: book.base };
      for (const k of keys) totals[k] = base[k].value;
      totals.by_currency = byCur.byCurrency(book.base);
      totals.missing_rates = [...missing].sort();
      const subtotals = [...subs.values()]
        .sort((a, b) => (a.currency === book.base ? -1 : b.currency === book.base ? 1 : a.currency.localeCompare(b.currency)))
        .map((s) => ({ currency: s.currency, rows: s.rows, ...Object.fromEntries(keys.map((k) => [k, s.sums[k].value])), total_base: s.missing ? null : s.base.total.value }));
      return { rows, totals, subtotals };
    };
    const ar = build(groups.AR);
    const ap = build(groups.AP);
    return {
      base_currency: book.base,
      rate_date: fmtDate(asOf),
      as_of: fmtDate(asOf),
      basis,
      buckets: labels,
      AR: ar.rows,
      AP: ap.rows,
      totals: { AR: ar.totals, AP: ap.totals },
      subtotals: { AR: ar.subtotals, AP: ap.subtotals },
      missing_rates: [...new Set([...ar.totals.missing_rates, ...ap.totals.missing_rates])].sort(),
    };
  }

  /** 本位币与当前适用汇率（前端显示用） */
  async currencies() {
    const book = await RateBook.load(this.db.client);
    return { base_currency: book.base, rate_date: fmtDate(today()), rates: book.latest() };
  }

  // ======================= 金蝶凭证引出 =======================

  /**
   * 按期间生成凭证分录（金蝶凭证引入格式：日期、凭证字、凭证号、分录号、摘要、科目、核算维度、币别、汇率、原币、借方、贷方…）。
   *   应收单：借 应收账款 / 贷 主营业务收入；应付单：借 原材料 / 贷 应付账款；
   *   收款：借 银行存款、财务费用-手续费 / 贷 应收账款（记账汇率）、预收账款，差额 → 财务费用-汇兑损益；付款反之；
   *   预收/预付冲抵：借 预收账款 / 贷 应收账款（应付反之）；
   *   本期作废的以前期间收付款：生成红字冲销凭证（金额取负）。
   */
  async voucher(q: Record<string, string>, user?: CurrentUser) {
    await this.bookPending();
    const { from, to } = periodRange(q);
    if (!from || !to) throw new BizError('请选择会计期间（如 2026-11）或起止日期');
    const c = this.db.client;
    const book = await RateBook.load(c);
    const warnings: string[] = [];
    type Line = { account: keyof typeof ACCOUNTS; partner?: { code: string | null; name: string | null } | null; currency: string; rate: number | null; fc: number; debit?: number | null; credit?: number | null; summary: string };
    type V = { date: Date; key: string; biz_no: string; method?: string | null; reference?: string | null; maker: string | null; lines: Line[] };
    const vouchers: V[] = [];

    // 1) 应收 / 应付单
    const docs = (await c.financeDoc.findMany({
      where: { doc_type: { in: ['AR', 'AP'] }, status: { not: 'VOID' }, doc_date: { gte: from, lte: to } },
      include: { customer: true, supplier: true }, orderBy: [{ doc_date: 'asc' }, { id: 'asc' }],
    })) as DocWithPartner[];
    for (const d of docs) {
      const pt = partnerOf(d);
      const rate = d.exchange_rate?.toNumber() ?? null;
      const base = d.base_amount !== null ? money(d.base_amount) : null;
      if (base === null) warnings.push(`${d.no} 缺少 ${d.currency} 在 ${fmtDate(d.doc_date)} 的汇率，本位币金额为空，请先维护汇率`);
      const fc = money(d.amount);
      const taxRate = d.doc_type === 'AR' ? taxRateOf((d as any).customer, 'AR') : taxRateOf((d as any).supplier, 'AP');
      const pct = `${Math.round(taxRate * 10000) / 100}%`;
      const summary = (d.doc_type === 'AR' ? `应收 ${d.no} ${pt.name ?? ''} 税率${pct} ${d.invoice_no ? `发票${d.invoice_no} ` : ''}${d.remark ?? ''}` : `应付 ${d.no} ${pt.name ?? ''} 税率${pct} ${d.remark ?? ''}`).trim();
      const b = splitTax(base, taxRate);
      const f = splitTax(fc, taxRate);
      const taxLine = (account: 'VAT_OUT' | 'VAT_IN', side: 'debit' | 'credit'): Line[] => (f.tax ? [{ account, currency: d.currency, rate, fc: f.tax, [side]: b.tax, summary }] : []);
      vouchers.push({
        date: d.doc_date, key: `1-${d.no}`, biz_no: d.no, maker: user?.full_name ?? d.created_by,
        lines:
          d.doc_type === 'AR'
            ? [
                { account: 'AR', partner: pt, currency: d.currency, rate, fc, debit: base, summary },
                { account: 'REVENUE', currency: d.currency, rate, fc: f.net!, credit: b.net, summary },
                ...taxLine('VAT_OUT', 'credit'),
              ]
            : [
                { account: 'MATERIAL', currency: d.currency, rate, fc: f.net!, debit: b.net, summary },
                ...taxLine('VAT_IN', 'debit'),
                { account: 'AP', partner: pt, currency: d.currency, rate, fc, credit: base, summary },
              ],
      });
    }

    // 2) 收付款（按收付款单号合并为一张凭证）+ 3) 本期作废的以前期间收付款（红字冲销）
    const pays = await c.payment.findMany({
      where: {
        OR: [
          { status: 'VALID', pay_date: { gte: from, lte: to } },
          { status: 'VOID', pay_date: { lt: from }, voided_at: { gte: from, lt: new Date(to.getTime() + 86400000) } },
        ],
      },
      include: { doc: { include: { customer: true, supplier: true } } },
      orderBy: [{ pay_date: 'asc' }, { id: 'asc' }],
    });
    const groups = new Map<string, typeof pays>();
    for (const p of pays) {
      const k = `${p.status}|${p.receipt_no ?? `P${p.id}`}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(p);
    }
    const advDocs = await c.financeDoc.findMany({
      where: { doc_type: { in: ['PR', 'PP'] }, ref_type: 'PAYMENT', ref_no: { in: [...new Set(pays.map((p) => p.receipt_no).filter((x): x is string => !!x))] } },
      include: { customer: true, supplier: true },
    });
    for (const [k, ps] of groups) {
      const reversal = k.startsWith('VOID|');
      const first = ps[0];
      const kind = KIND_OF[first.doc.doc_type] ?? 'AR';
      const t = TEXT[kind];
      const sign = reversal ? -1 : 1;
      const S = (v: number | null | undefined) => (v === null || v === undefined ? null : money(sign * v));
      const currency = first.doc.currency;
      const rate = first.exchange_rate?.toNumber() ?? null;
      const pt = partnerOf(first.doc);
      const offset = ps.some((p) => Object.values(OFFSET_METHOD).includes(p.method as any));
      const docNos = [...new Set(ps.filter((p) => KIND_OF[p.doc.doc_type] === p.doc.doc_type).map((p) => p.doc.no))].join('、');
      let summary = offset ? `${t.adv}冲抵 ${first.receipt_no ?? ''} ${pt.name ?? ''} ${docNos}` : `${t.pay} ${first.receipt_no ?? ''} ${pt.name ?? ''} 核销 ${docNos || '-'}`;
      if (reversal) summary = `冲销：${summary}（作废原因：${first.void_reason ?? ''}）`;
      const lines: Line[] = [];
      const bankFc = new MoneySum();
      const bankBase = new MoneySum();
      const feeFc = new MoneySum();
      const feeBase = new MoneySum();
      for (const p of ps) {
        const pr = p.exchange_rate?.toNumber() ?? 1;
        const amount = money(p.amount);
        const fee = money(p.fee_amount);
        const gross = atRate(amount, pr);
        const fb = atRate(fee, pr);
        const dt = p.doc.doc_type;
        if (dt === 'AR' || dt === 'AP') {
          const booked = money(dec(gross).minus(kind === 'AR' ? p.fx_diff : dec(p.fx_diff).negated()));
          const bookRate = p.doc.exchange_rate?.toNumber() ?? null;
          lines.push({ account: dt, partner: partnerOf(p.doc), currency, rate: bookRate, fc: S(amount)!, ...(kind === 'AR' ? { credit: S(booked) } : { debit: S(booked) }), summary });
          if (!Object.values(OFFSET_METHOD).includes(p.method as any)) {
            bankFc.add(kind === 'AR' ? amount - fee : amount + fee);
            bankBase.add(p.base_amount ?? 0);
            feeFc.add(fee);
            feeBase.add(fb);
          }
        } else {
          // 预收/预付侧的冲抵记录：借 预收账款（应付方向：贷 预付账款）
          lines.push({ account: dt as 'PR' | 'PP', partner: partnerOf(p.doc), currency, rate: pr, fc: S(amount)!, ...(kind === 'AR' ? { debit: S(money(p.base_amount ?? gross)) } : { credit: S(money(p.base_amount ?? gross)) }), summary });
        }
      }
      for (const a of advDocs.filter((x) => x.ref_no === first.receipt_no && (reversal || x.status !== 'VOID'))) {
        const ab = money(a.base_amount ?? 0);
        lines.push({ account: a.doc_type as 'PR' | 'PP', partner: partnerOf(a), currency, rate: a.exchange_rate?.toNumber() ?? rate, fc: S(money(a.amount))!, ...(kind === 'AR' ? { credit: S(ab) } : { debit: S(ab) }), summary });
        bankFc.add(money(a.amount));
        bankBase.add(ab);
      }
      if (feeFc.value) lines.push({ account: 'FEE', currency, rate, fc: S(feeFc.value)!, debit: S(feeBase.value), summary });
      if (bankFc.value || bankBase.value) lines.unshift({ account: 'BANK', currency, rate, fc: S(bankFc.value)!, ...(kind === 'AR' ? { debit: S(bankBase.value) } : { credit: S(bankBase.value) }), summary });
      // 汇兑损益 = 借贷差额（收益记贷方，损失记借方）
      const dr = new MoneySum();
      const cr = new MoneySum();
      lines.forEach((l) => {
        dr.add(l.debit ?? 0);
        cr.add(l.credit ?? 0);
      });
      const diff = subMoney(dr.value, cr.value);
      if (diff !== 0) lines.push({ account: 'FX', currency: book.base, rate: 1, fc: Math.abs(diff), ...(diff > 0 ? { credit: diff } : { debit: -diff }), summary });
      vouchers.push({
        date: reversal ? dateOnly(first.voided_at!)! : first.pay_date, key: `2-${first.receipt_no ?? first.id}${reversal ? '-R' : ''}`, biz_no: first.receipt_no ?? `#${first.id}`,
        method: first.method, reference: first.reference, maker: user?.full_name ?? (reversal ? first.voided_by : first.created_by), lines,
      });
    }

    vouchers.sort((a, b) => a.date.getTime() - b.date.getTime() || a.key.localeCompare(b.key));
    const items: Record<string, any>[] = [];
    vouchers.forEach((v, vi) => {
      v.lines.forEach((l, li) => {
        const acct = ACCOUNTS[l.account];
        items.push({
          date: fmtDate(v.date), year: v.date.getUTCFullYear(), period: v.date.getUTCMonth() + 1, word: '记', voucher_no: vi + 1, entry_no: li + 1,
          summary: l.summary.slice(0, 200), account_code: acct.code, account_name: acct.name,
          aux_type: l.partner ? (acct.aux ?? '') : '', partner_code: l.partner?.code ?? '', partner_name: l.partner?.name ?? '',
          currency: l.currency, rate: l.rate, amount_fc: l.fc, debit: l.debit ?? 0, credit: l.credit ?? 0,
          method: v.method ?? '', reference: v.reference ?? '', biz_no: v.biz_no, maker: v.maker ?? '',
        });
      });
    });
    const dr = new MoneySum();
    const cr = new MoneySum();
    items.forEach((x) => {
      dr.add(x.debit);
      cr.add(x.credit);
    });
    return {
      items, total: items.length, page: 1, page_size: items.length, from: fmtDate(from), to: fmtDate(to), vouchers: vouchers.length,
      debit_total: dr.value, credit_total: cr.value, warnings,
      accounts: Object.entries(ACCOUNTS).map(([k, v]) => ({ key: k, ...v })),
    };
  }
}
