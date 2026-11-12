/**
 * 汇率主数据（1 外币 = rate 本位币），在 master.module.ts 中注册。
 *  - 已被应收应付单据/收付款引用（单据日期落在该汇率适用区间内）的汇率不能修改汇率值/币别/生效日期，也不能删除（只能改备注）；
 *  - 与上一期汇率偏差超过 10% 时须确认（confirm_deviation: true），防止多输/少输小数位；
 *  - 列表附带：是否被引用、引用数量、上一期汇率与变动幅度。
 */
import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Prisma, type ExchangeRate } from '@prisma/client';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { dateOnly, fmtDate } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { dec, price6 } from '../common/money';
import { like, paginate } from '../common/paginate';
import { ser } from '../common/presenter';
import { PrismaService, type Tx } from '../common/prisma.service';
import { config } from '../config';

const PERMS = ['finance', 'master'];
/** 与上一期汇率偏差超过此比例需确认 */
export const RATE_DEVIATION_LIMIT = 0.1;

type Db = Tx | PrismaService['client'];

/**
 * 汇率被引用情况：
 *   已记账单据 / 收付款：同币别、记录的汇率 = 该汇率、日期 ≥ 生效日期（单据保存的是记账时的汇率值，之后新增的汇率不改变它引用的是哪一条）；
 *   尚未记账的单据：单据日期落在 [生效日期, 下一条生效日期) 内（记账时将使用该汇率）。
 */
async function referencesOf(c: Db, r: Pick<ExchangeRate, 'currency' | 'effective_date' | 'rate'>) {
  const next = await c.exchangeRate.findFirst({ where: { currency: r.currency, effective_date: { gt: r.effective_date } }, orderBy: { effective_date: 'asc' } });
  const win = { gte: r.effective_date, ...(next ? { lt: next.effective_date } : {}) };
  const [docs, pays] = await Promise.all([
    c.financeDoc.count({
      where: {
        currency: r.currency, status: { not: 'VOID' },
        OR: [{ exchange_rate: r.rate, doc_date: { gte: r.effective_date } }, { exchange_rate: null, doc_date: win }],
      },
    }),
    c.payment.count({ where: { doc: { currency: r.currency }, exchange_rate: r.rate, pay_date: { gte: r.effective_date }, status: 'VALID' } }),
  ]);
  return { docs, payments: pays, total: docs + pays };
}

async function previousOf(c: Db, currency: string, date: Date, selfId?: number) {
  return c.exchangeRate.findFirst({
    where: { currency, effective_date: { lt: date }, ...(selfId ? { id: { not: selfId } } : {}) },
    orderBy: { effective_date: 'desc' },
  });
}

const pct = (v: number) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

@Controller('exchange-rates')
export class ExchangeRateCrudController {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  private async annotate(rows: any[]) {
    const c = this.db.client;
    return Promise.all(
      rows.map(async (r) => {
        const eff = r.effective_date instanceof Date ? r.effective_date : dateOnly(r.effective_date)!;
        const [refs, prev] = await Promise.all([referencesOf(c, { currency: r.currency, effective_date: eff, rate: r.rate }), previousOf(c, r.currency, eff, r.id)]);
        const prevRate = prev ? dec(prev.rate).toNumber() : null;
        return {
          ...r,
          referenced: refs.total > 0,
          ref_docs: refs.docs,
          ref_payments: refs.payments,
          prev_rate: prevRate,
          prev_date: prev ? fmtDate(prev.effective_date) : null,
          change_pct: prevRate ? Math.round((Number(r.rate) / prevRate - 1) * 10000) / 10000 : null,
        };
      }),
    );
  }

  @Get()
  async list(@Query() q: Record<string, string>) {
    const where: Prisma.ExchangeRateWhereInput = {};
    if (q.q) where.OR = [{ currency: like(q.q) }, { remark: like(q.q) }];
    if (q.currency) where.currency = q.currency.trim().toUpperCase();
    const page = await paginate(this.db.client.exchangeRate, 'ExchangeRate', { where, orderBy: [{ effective_date: 'desc' }, { currency: 'asc' }] }, q);
    page.items = await this.annotate(page.items);
    return page;
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    const row = await this.db.client.exchangeRate.findUnique({ where: { id } });
    if (!row) throw new NotFound('汇率');
    return (await this.annotate([ser('ExchangeRate', row)]))[0];
  }

  /** 校验并规范化：币别 3 位字母、非本位币、汇率 > 0（6 位）、同日不重复、与上一期偏差过大需确认 */
  private async check(tx: Tx, r: { id?: number; currency: string; rate: number; effective_date: Date | null }, confirm: boolean) {
    const c = String(r.currency ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw new BizError('币别请填写 3 位字母代码，如 USD');
    if (c === config.baseCurrency) throw new BizError(`${c} 是本位币，无需维护汇率`);
    if (!(Number(r.rate) > 0)) throw new BizError('汇率必须大于 0');
    if (!r.effective_date) throw new BizError('请填写生效日期');
    const dup = await tx.exchangeRate.findFirst({ where: { currency: c, effective_date: r.effective_date, ...(r.id ? { id: { not: r.id } } : {}) } });
    if (dup) throw new BizError(`${c} 在 ${fmtDate(r.effective_date)} 已有汇率，请直接修改该条记录`);
    const rate = price6(r.rate);
    const prev = await previousOf(tx, c, r.effective_date, r.id);
    if (prev && !confirm) {
      const p = dec(prev.rate).toNumber();
      const dev = rate / p - 1;
      if (Math.abs(dev) > RATE_DEVIATION_LIMIT) {
        throw new BizError(
          `${c} 汇率 ${rate} 与上一期 ${p}（${fmtDate(prev.effective_date)} 起）相差 ${pct(dev)}，超过 ${RATE_DEVIATION_LIMIT * 100}%。` +
            '请核对是否多输/少输了小数位；确认无误请勾选“确认偏差”后再保存。',
        );
      }
    }
    return { currency: c, rate };
  }

  private parse(body: Record<string, any>) {
    const out: { currency?: string; rate?: number; effective_date?: Date | null; remark?: string | null } = {};
    if (body.currency !== undefined) out.currency = String(body.currency ?? '');
    if (body.rate !== undefined) {
      if (body.rate === null || Number.isNaN(Number(body.rate))) throw new BizError('汇率必须为数字');
      out.rate = Number(body.rate);
    }
    if (body.effective_date !== undefined) out.effective_date = dateOnly(body.effective_date);
    if (body.remark !== undefined) out.remark = body.remark === null || body.remark === '' ? null : String(body.remark);
    return out;
  }

  private save<T>(fn: (tx: Tx) => Promise<T>) {
    return this.db.tx(fn).catch((e) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new BizError('同一币别同一生效日期只能有一条汇率，请直接修改该条记录');
      throw e;
    });
  }

  @Post()
  @Perms(...PERMS)
  async create(@Body() body: Record<string, any>, @User() user: CurrentUser) {
    const row = await this.save(async (tx) => {
      const d = this.parse(body);
      if (d.currency === undefined) throw new BizError('请选择币别');
      if (d.rate === undefined) throw new BizError('汇率必须大于 0');
      const v = await this.check(tx, { currency: d.currency, rate: d.rate, effective_date: d.effective_date ?? null }, !!body.confirm_deviation);
      return tx.exchangeRate.create({ data: { ...v, effective_date: d.effective_date!, remark: d.remark ?? null, created_by: user.username } });
    });
    return (await this.annotate([ser('ExchangeRate', row)]))[0];
  }

  @Put(':id')
  @Perms(...PERMS)
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: Record<string, any>) {
    const row = await this.save(async (tx) => {
      const cur = await tx.exchangeRate.findUnique({ where: { id } });
      if (!cur) throw new NotFound('汇率');
      const d = this.parse(body);
      const merged = { id, currency: d.currency ?? cur.currency, rate: d.rate ?? dec(cur.rate).toNumber(), effective_date: d.effective_date === undefined ? cur.effective_date : d.effective_date };
      const v = await this.check(tx, merged, !!body.confirm_deviation || (d.rate === undefined && d.effective_date === undefined));
      const changed = v.currency !== cur.currency || !dec(v.rate).equals(cur.rate) || merged.effective_date?.getTime() !== cur.effective_date.getTime();
      if (changed) {
        const refs = await referencesOf(tx, cur);
        if (refs.total > 0) {
          throw new BizError(
            `${cur.currency} ${fmtDate(cur.effective_date)} 起的汇率 ${dec(cur.rate).toNumber()} 已被 ${refs.docs} 张应收应付单、${refs.payments} 笔收付款引用，不能修改汇率、币别或生效日期（只能改备注）。` +
              '已入账单据按原汇率记账；如汇率有误，请新增一条正确的汇率（新的生效日期），并在备注中说明。',
          );
        }
      }
      return tx.exchangeRate.update({ where: { id }, data: { ...v, effective_date: merged.effective_date!, ...(d.remark !== undefined ? { remark: d.remark } : {}) } });
    });
    return (await this.annotate([ser('ExchangeRate', row)]))[0];
  }

  @Delete(':id')
  @Perms(...PERMS)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.db.tx(async (tx) => {
      const cur = await tx.exchangeRate.findUnique({ where: { id } });
      if (!cur) throw new NotFound('汇率');
      const refs = await referencesOf(tx, cur);
      if (refs.total > 0) {
        throw new BizError(`${cur.currency} ${fmtDate(cur.effective_date)} 起的汇率已被 ${refs.docs} 张应收应付单、${refs.payments} 笔收付款引用，不能删除`);
      }
      await tx.exchangeRate.delete({ where: { id } });
      return { ok: true };
    });
  }
}
