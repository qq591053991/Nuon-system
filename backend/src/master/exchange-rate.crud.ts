/** 汇率主数据（1 外币 = rate 本位币）：通用 CRUD 配置，在 master.module.ts 中注册 */
import { crudController } from '../common/crud';
import { fmtDate } from '../common/dates';
import { BizError } from '../common/errors';
import { price6 } from '../common/money';
import { config } from '../config';

export const ExchangeRateCrudController = crudController({
  model: 'ExchangeRate',
  prefix: 'exchange-rates',
  perm: ['finance', 'master'],
  label: '汇率',
  search: ['currency', 'remark'],
  filters: ['currency'],
  orderBy: [{ effective_date: 'desc' }, { currency: 'asc' }],
  validate: async (tx, r, data) => {
    const c = String(r.currency ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw new BizError('币别请填写 3 位字母代码，如 USD');
    if (c === config.baseCurrency) throw new BizError(`${c} 是本位币，无需维护汇率`);
    if (data.currency !== undefined) data.currency = c;
    if (!(Number(r.rate) > 0)) throw new BizError('汇率必须大于 0');
    if (data.rate !== undefined) data.rate = price6(data.rate);
    if (r.effective_date) {
      const dup = await tx.exchangeRate.findFirst({
        where: { currency: c, effective_date: r.effective_date, ...(r.id ? { id: { not: r.id } } : {}) },
      });
      if (dup) throw new BizError(`${c} 在 ${fmtDate(r.effective_date)} 已有汇率，请直接修改该条记录`);
    }
  },
});
