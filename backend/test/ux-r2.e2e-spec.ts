/**
 * 第二轮修复 R2（销售 / 计划 / 采购 / 财务）：
 *   A-N1 订单变更通知计划员、工单“与订单不符”与一键调整；E-N1 大额采购单厂长审批；E-N3 金蝶凭证拆分增值税、制单人 = 导出人；
 *   A-N2 上次成交价排除备品/异常低价；F-PMC-07 客供料通知；F-BUY-08 MRP 采购单同物料合并；E-28 银行账户/发票号；E-N10 流水银行到账；
 *   F-SAL-10 / N7 订单“已排产”与最早交期。
 */
import { addDays, fmtDate, today } from '../src/common/dates';
import { splitTax, taxRateOf } from '../src/erp/finance.service';
import { woMismatches } from '../src/erp/so-plan';
import { bootApp, SIG } from './harness';

let t: Awaited<ReturnType<typeof bootApp>>;
beforeAll(async () => (t = await bootApp()));
beforeEach(() => t.reset());
afterAll(() => t.close());

const d = (n: number) => fmtDate(addDays(today(), n))!;
const so = (q: string) => t.api.as('sales').find('/api/sales-orders', { q });

describe('A-N1 订单变更联动计划员', () => {
  test('变更后通知计划员；工单标“与订单不符”，列表可筛选，一键按订单同步', async () => {
    const { api } = t;
    const s = await so('LUM-PO-26-118');
    const gen = await api.as('pmc').ok('post', `/api/sales-orders/${s.id}/create-work-orders`);
    const wo = await api.as('pmc').find('/api/work-orders', { q: gen.work_orders[0] });
    expect(await woMismatches(t.db.client as any)).toEqual([]);
    const line = (await api.as('sales').ok('get', `/api/sales-orders/${s.id}`)).lines[0];
    const r = await api.as('sales').ok('post', `/api/sales-orders/${s.id}/change`, { lines: [{ id: line.id, material_id: line.material_id, qty: 15, unit_price: 88 }], reason: '客户减量' });
    expect(r.notified).toEqual(['周计划']);
    expect(r.affected[0].message).toContain('计划员需调减 5');
    const mm = await woMismatches(t.db.client as any);
    expect(mm).toEqual([expect.objectContaining({ so_id: s.id, so_no: s.no, line_id: line.id, material_code: 'FG-RL300', so_qty: 15, wo_qty: 20, wo_ids: [wo.id], adjustable_ids: [wo.id] })]);
    expect(mm[0].changed_at).toBeTruthy();
    const list = await api.as('pmc').ok('get', '/api/kitting/work-order-list', { mismatch: '1' });
    expect(list.items.map((w: any) => [w.no, w.mismatch.so_qty, w.mismatch.wo_qty])).toEqual([[wo.no, 15, 20]]);
    const info = await api.as('pmc').ok('get', `/api/work-orders/${wo.id}/adjust-info`);
    expect(info.mismatch).toEqual({ so_qty: 15, wo_total: 20, suggest_qty: 15, cancel_suggested: false });
    // 计划工单直接改数量；已下达工单走调整
    await api.as('pmc').ok('put', `/api/work-orders/${wo.id}`, { material_id: wo.material_id, planned_qty: 15 });
    expect(await woMismatches(t.db.client as any)).toEqual([]);
    expect((await api.as('pmc').ok('get', '/api/kitting/work-order-list', { mismatch: '1' })).total).toBe(0);
    // 订单状态：只有计划工单时为“已排产”（production_state=SCHEDULED），下达后为生产中
    let detail = await api.as('sales').ok('get', `/api/sales-orders/${s.id}`);
    expect([detail.status, detail.production_state, detail.earliest_delivery, detail.delivery_count]).toEqual(['IN_PRODUCTION', 'SCHEDULED', d(20), 1]);
    await api.as('pmc').ok('post', `/api/work-orders/${wo.id}/release`);
    detail = (await api.as('sales').ok('get', '/api/sales-orders', { q: s.no })).items[0];
    expect(detail.production_state).toBe('PRODUCING');
  });
});

describe('E-N1 大额采购单须厂长审批', () => {
  test('采购员只能提交审批；厂长电子签名批准或退回；小额仍由采购员审批', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const sup = await api.find('/api/suppliers', { q: 'S004' });
    const mk = (qty: number) => api.as('buyer').ok('post', '/api/purchase-orders', { supplier_id: sup.id, lines: [{ material_id: ref.m['STAND-BL100'], qty, unit_price: 160 }] });
    const big = await mk(400); // 64,000 ≥ 50,000
    let r = await api.as('buyer').post(`/api/purchase-orders/${big.id}/approve`, {});
    expect(r.status).toBe(400);
    expect(r.body.detail).toBe(`采购单 ${big.no} 金额折合 CNY 64,000.00 ≥ 大额审批标准 50,000，须厂长审批：请点【提交审批】`);
    const sub = await api.as('buyer').ok('post', `/api/purchase-orders/${big.id}/submit`);
    expect([sub.status, sub.approval.big, sub.approval.base_amount]).toEqual(['SUBMITTED', true, 64000]);
    expect((await api.as('buyer').put(`/api/purchase-orders/${big.id}`, { supplier_id: sup.id, lines: [{ material_id: ref.m['STAND-BL100'], qty: 1, unit_price: 1 }] })).body.detail).toContain('已提交厂长审批，不能修改');
    expect((await api.as('buyer').post(`/api/purchase-orders/${big.id}/approve`, {})).body.detail).toContain('已提交厂长审批');
    expect((await api.as('buyer').post(`/api/purchase-orders/${big.id}/reject`, { reason: 'x', signature: SIG })).status).toBe(403);
    expect((await api.as('manager').post(`/api/purchase-orders/${big.id}/approve`, {})).body.detail).toContain('此操作需要电子签名（大额采购单审批）');
    expect((await api.as('manager').post(`/api/purchase-orders/${big.id}/reject`, { reason: '', signature: SIG })).body.detail).toContain('请填写退回原因');
    const back = await api.as('manager').ok('post', `/api/purchase-orders/${big.id}/reject`, { reason: '单价偏高，请再议价', signature: SIG });
    expect(back.status).toBe('DRAFT');
    const changes = await api.as('buyer').ok('get', `/api/purchase-orders/${big.id}/changes`);
    expect(changes.map((c: any) => c.reason)).toEqual(['单价偏高，请再议价', '大额采购单提交厂长审批']);
    await api.as('buyer').ok('post', `/api/purchase-orders/${big.id}/submit`);
    const ok = await api.as('manager').ok('post', `/api/purchase-orders/${big.id}/approve`, { signature: SIG });
    expect([ok.status, ok.approved_by]).toEqual(['APPROVED', '王厂长']);
    const sigs = await db.base.eSignature.findMany({ where: { entity: 'erp_purchase_order', entity_id: big.id }, orderBy: { id: 'asc' } });
    expect(sigs.map((x) => [x.meaning, x.username])).toEqual([['大额采购单退回', 'manager'], ['大额采购单审批', 'manager']]);
    // 小额：采购员直接审批；不能“提交审批”
    const small = await mk(10);
    expect((await api.as('buyer').post(`/api/purchase-orders/${small.id}/submit`)).body.detail).toContain('未达大额审批标准');
    expect((await api.as('buyer').ok('post', `/api/purchase-orders/${small.id}/approve`, {})).status).toBe('APPROVED');
    expect((await api.as('buyer').ok('get', '/api/purchase-orders/approval-rule', { amount: 50000, currency: 'CNY' })).big).toBe(true);
    expect((await api.as('buyer').ok('get', '/api/purchase-orders/approval-rule', { amount: 49999, currency: 'CNY' })).big).toBe(false);
  });
});

describe('E-N3 金蝶凭证拆分增值税', () => {
  test('税率取值与拆分', () => {
    expect(splitTax(113, 0.13)).toEqual({ net: 100, tax: 13 });
    expect(splitTax(1750, 0.13)).toEqual({ net: 1548.67, tax: 201.33 });
    expect(splitTax(100, 0)).toEqual({ net: 100, tax: 0 });
    expect(taxRateOf({ tax_rate: null, currency: 'CNY' }, 'AR')).toBe(0.13);
    expect(taxRateOf({ tax_rate: null, currency: 'USD' }, 'AR')).toBe(0); // 外币客户未设税率 = 出口零税率
    expect(taxRateOf({ tax_rate: 0.06 as any }, 'AP')).toBe(0.06);
  });

  test('应付：借 原材料（不含税）+ 进项税 / 贷 应付；应收：贷 收入（不含税）+ 销项税；制单人 = 导出人', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const sup = await api.find('/api/suppliers', { q: 'S001' });
    const po = await api.as('buyer').ok('post', '/api/purchase-orders', { supplier_id: sup.id, lines: [{ material_id: ref.m['LED-660-3030'], qty: 1000, unit_price: 0.35 }] });
    await api.as('buyer').ok('post', `/api/purchase-orders/${po.id}/approve`, {});
    await api.as('wh').ok('post', `/api/purchase-orders/${po.id}/receive`, { confirm_placement: true, lines: [{ po_line_id: po.lines[0].id, qty: 1000, location_id: ref.loc['DRY-01'] }] });
    const c2 = await api.find('/api/customers', { q: 'C002' });
    const c1 = await api.find('/api/customers', { q: 'C001' });
    for (const [c, cur, amount, rate, no] of [[c2, 'CNY', 1130, 1, 'AR-T1'], [c1, 'USD', 100, 7.1, 'AR-T2']] as const) {
      await db.base.financeDoc.create({ data: { no, doc_type: 'AR', customer_id: c.id, doc_date: today(), currency: cur, amount, exchange_rate: rate, base_amount: amount * rate, status: 'OPEN', invoice_no: no === 'AR-T1' ? 'FP001' : null } });
    }
    const period = fmtDate(today())!.slice(0, 7);
    const v = await api.as('finance').ok('get', '/api/finance/voucher', { period });
    expect(v.debit_total).toBe(v.credit_total);
    const of = (biz: string) => v.items.filter((x: any) => x.biz_no === biz).map((x: any) => [x.account_code, x.debit, x.credit, x.amount_fc]);
    const ap = v.items.find((x: any) => x.account_code === '2202');
    expect(of(ap.biz_no)).toEqual([['1403', 309.73, 0, 309.73], ['2221.01.01', 40.27, 0, 40.27], ['2202', 0, 350, 350]]);
    expect(of('AR-T1')).toEqual([['1122', 1130, 0, 1130], ['6001', 0, 1000, 1000], ['2221.01.05', 0, 130, 130]]);
    expect(of('AR-T2')).toEqual([['1122', 710, 0, 100], ['6001', 0, 710, 100]]); // 出口零税率，不出税额分录
    expect(v.items.every((x: any) => x.maker === '钱财务')).toBe(true);
    expect(v.items.find((x: any) => x.biz_no === 'AR-T1').summary).toContain('税率13% 发票FP001');
    // 供应商设 6% 税率
    await api.as('engineer').ok('put', `/api/suppliers/${sup.id}`, { tax_rate: 0.06 });
    const v2 = await api.as('finance').ok('get', '/api/finance/voucher', { period });
    expect(v2.items.filter((x: any) => x.biz_no === ap.biz_no).map((x: any) => [x.account_code, x.debit, x.credit])).toEqual([['1403', 330.19, 0], ['2221.01.01', 19.81, 0], ['2202', 0, 350]]);
    // E-28 发票号、收款银行账户；E-N10 流水显示银行到账与预收
    const ar = await db.base.financeDoc.findFirstOrThrow({ where: { no: 'AR-T1' } });
    const inv = await api.as('finance').ok('put', `/api/finance/docs/${ar.id}/invoice`, { invoice_no: 'FP-2026-0001', invoice_date: d(0) });
    expect([inv.invoice_no, inv.invoice_date]).toEqual(['FP-2026-0001', d(0)]);
    await api.as('finance').ok('post', `/api/finance/docs/${ar.id}/payments`, { amount: 1200, fee_amount: 30, as_advance: true, bank_account: '中国银行 6217***1234', reference: 'TT001' });
    const flow = (await api.as('finance').ok('get', '/api/finance/payments', { q: 'TT001' })).items[0];
    expect([flow.amount, flow.fee_amount, flow.bank_amount, flow.advance_amount, flow.bank_account]).toEqual([1130, 30, 1170, 70, '中国银行 6217***1234']);
    expect(flow.advance_no).toMatch(/^YS/);
  });
});

describe('A-N2 上次成交价 / F-PMC-07 客供料通知 / F-BUY-08 同物料合并', () => {
  test('上次成交价排除备品行与异常低价，取主行，返回最近 3 次', async () => {
    const { api } = t;
    const ref = await api.ids();
    const c1 = await api.find('/api/customers', { q: 'C001' });
    const mid = ref.m['FG-RL300'];
    const mk = async (lines: any[]) => {
      const o = await api.as('sales').ok('post', '/api/sales-orders', { customer_id: c1.id, currency: 'USD', lines });
      await api.as('sales').ok('post', `/api/sales-orders/${o.id}/confirm`);
      return o;
    };
    const o1 = await mk([{ material_id: mid, qty: 2, unit_price: 80, remark: '备品' }, { material_id: mid, qty: 150, unit_price: 86 }]);
    const lp = await api.as('sales').ok('get', '/api/sales-orders/last-prices', { customer_id: c1.id, material_ids: `${mid}` });
    expect([lp[mid].unit_price, lp[mid].so_no, lp[mid].qty]).toEqual([86, o1.no, 150]);
    expect(lp[mid].recent.map((x: any) => x.unit_price)).toEqual([86, 88]);
    expect(lp[mid].skipped).toEqual([expect.objectContaining({ unit_price: 80, why: '备品/赠品/样品行' })]);
    await mk([{ material_id: mid, qty: 5, unit_price: 40 }]); // 补偿特价：低于中位价 70%
    const lp2 = await api.as('sales').ok('get', '/api/sales-orders/last-prices', { customer_id: c1.id, material_ids: `${mid}` });
    expect(lp2[mid].unit_price).toBe(86);
    expect(lp2[mid].skipped.some((x: any) => x.unit_price === 40 && x.why.startsWith('异常低价'))).toBe(true);
  });

  test('客供料建议标记已通知并返回按客户分组的通知；MRP 转采购单同物料合并为一行', async () => {
    const { api } = t;
    const s = await so('LUM-PO-26-131');
    await api.as('sales').ok('post', `/api/sales-orders/${s.id}/confirm`);
    const run = await api.as('pmc').ok('post', '/api/mrp/run');
    const cs = run.suggestions.filter((x: any) => x.action === 'CUSTOMER_SUPPLY');
    const buy = run.suggestions.filter((x: any) => x.action === 'PURCHASE' && !x.exception);
    expect((await api.as('pmc').post('/api/mrp/suggestions/notify', { suggestion_ids: [buy[0].id] })).body.detail).toContain('只有客供料建议可以生成客户供料通知');
    const n = await api.as('pmc').ok('post', '/api/mrp/suggestions/notify', { suggestion_ids: cs.map((x: any) => x.id) });
    expect(n.notified_by).toBe('周计划');
    expect(n.notices).toHaveLength(1);
    expect(n.notices[0].customer_name).toBe('Lumina Health Inc.');
    expect(n.notices[0].items.map((i: any) => i.material_code).sort()).toEqual([...new Set(cs.map((x: any) => x.material_code))].sort());
    expect(n.notices[0].items[0].for_orders.length).toBeGreaterThan(0);
    const again = await api.as('pmc').ok('get', `/api/mrp/runs/${run.id}`);
    expect(again.suggestions.filter((x: any) => x.action === 'CUSTOMER_SUPPLY').every((x: any) => x.notified_at && x.notified_by === '周计划')).toBe(true);
    // 同一供应商、同一物料的多周建议合并成一行（数量合计、到货日取最早、备注写分批需求）
    const byMat = new Map<string, any[]>();
    for (const x of buy) byMat.set(x.material_code, [...(byMat.get(x.material_code) ?? []), x]);
    const multi = [...byMat.values()].find((g) => g.length > 1)!;
    expect(multi).toBeTruthy();
    const conv = await api.as('pmc').ok('post', '/api/mrp/convert', { suggestion_ids: multi.map((x) => x.id) });
    const po = await api.as('buyer').find('/api/purchase-orders', { q: conv.purchase_orders[0] });
    expect(po.lines).toHaveLength(1);
    expect(po.lines[0].qty).toBe(multi.reduce((a, x) => a + x.suggested_qty, 0));
    expect(po.lines[0].remark).toMatch(/^分批需求：/);
  });
});
