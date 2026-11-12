/**
 * 好用性修复 G4（采购 / 财务）：
 *   读权限（采购单/财务 GET）、采购单审批后变更留痕、催货清单、按物料搜采购单、采购单位由采购维护并整包下单、未合格供应商中文提示；
 *   财务筛选、记账汇率与本位币、实收汇率/手续费/汇兑差异、超额转预收、作废回滚、合并收款按到期日分配、预收冲抵、
 *   账龄（截止日/区间/记账汇率口径/币别小计/下钻）、金蝶凭证引出借贷平衡、付款显示来料 IQC 状态、汇率引用保护与偏差确认。
 */
import { addDays, fmtDate, today } from '../src/common/dates';
import { bootApp } from './harness';

let t: Awaited<ReturnType<typeof bootApp>>;
beforeAll(async () => (t = await bootApp()));
beforeEach(() => t.reset());
afterAll(() => t.close());

const d = (n: number) => fmtDate(addDays(today(), n))!;

/** 新建并审批采购订单 */
async function approvedPo(supplierCode: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  const sup = await t.api.as('buyer').find('/api/suppliers', { q: supplierCode });
  const p = await t.api.as('buyer').ok('post', '/api/purchase-orders', { supplier_id: sup.id, lines, ...extra });
  return t.api.as('buyer').ok('post', `/api/purchase-orders/${p.id}/approve`);
}

describe('读权限', () => {
  test('采购单 GET 仅采购/计划/仓储/质量/财务可读；财务数据 GET 仅财务（厂长含）可读', async () => {
    const { api } = t;
    for (const u of ['buyer', 'pmc', 'wh', 'qc', 'qa', 'finance', 'manager']) expect((await api.as(u).get('/api/purchase-orders')).status).toBe(200);
    for (const u of ['op1', 'sales', 'engineer', 'admin']) expect((await api.as(u).get('/api/purchase-orders')).status).toBe(403);
    expect((await api.as('op1').get('/api/purchase/chase')).status).toBe(403);
    for (const url of ['/api/finance/docs', '/api/finance/summary', '/api/finance/payments', '/api/finance/voucher?period=2026-11']) {
      expect((await api.as('finance').get(url)).status).toBe(200);
      expect((await api.as('manager').get(url)).status).toBe(200);
      for (const u of ['op1', 'buyer', 'sales', 'admin']) expect((await api.as(u).get(url)).status).toBe(403);
    }
    // 汇率一览：财务与主数据维护可读
    expect((await api.as('engineer').get('/api/finance/currencies')).status).toBe(200);
    expect((await api.as('op1').get('/api/finance/currencies')).status).toBe(403);
  });
});

describe('采购', () => {
  test('未合格供应商审批：中文状态并指明找质量部评审', async () => {
    const { api } = t;
    const ref = await api.ids();
    const sup = await api.as('buyer').find('/api/suppliers', { q: 'S006' });
    const p = await api.as('buyer').ok('post', '/api/purchase-orders', { supplier_id: sup.id, lines: [{ material_id: ref.m['LED-660-3030'], qty: 1000, unit_price: 0.35 }] });
    const r = await api.as('buyer').post(`/api/purchase-orders/${p.id}/approve`);
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('当前为“待评审”');
    expect(r.body.detail).toContain('请联系质量部完成供应商评审');
    expect(r.body.detail).not.toContain('PENDING');
  });

  test('审批后变更交期/供应商回复交期/单价/数量：必须填原因，留痕可查，数量不能小于已收', async () => {
    const { api } = t;
    const ref = await api.ids();
    const po = await approvedPo('S004', [
      { material_id: ref.m['HSG-RL300-U'], qty: 100, unit_price: 12, expected_date: d(5) },
      { material_id: ref.m['HSG-RL300-D'], qty: 100, unit_price: 10, expected_date: d(5) },
    ]);
    const [l1, l2] = po.lines;
    // 原因必填
    let r = await api.as('buyer').post(`/api/purchase-orders/${po.id}/change`, { reason: '', lines: [{ id: l1.id, promised_date: d(8) }] });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('变更原因');
    // 无权限
    expect((await api.as('wh').post(`/api/purchase-orders/${po.id}/change`, { reason: '测试', lines: [{ id: l1.id, promised_date: d(8) }] })).status).toBe(403);
    const ch = await api.as('buyer').ok('post', `/api/purchase-orders/${po.id}/change`, {
      reason: '供应商回复模具维修推迟一周',
      lines: [{ id: l1.id, promised_date: d(12), unit_price: 12.5 }, { id: l2.id, expected_date: d(9), qty: 120 }],
    });
    expect(ch.status).toBe('APPROVED');
    expect(ch.lines[0].promised_date).toBe(d(12));
    expect([ch.lines[0].unit_price, ch.lines[0].amount]).toEqual([12.5, 1250]);
    expect([ch.lines[1].qty, ch.lines[1].amount, ch.lines[1].expected_date]).toEqual([120, 1200, d(9)]);
    expect(ch.total_amount).toBe(2450);
    expect(ch.change.items).toEqual([
      `第 1 行 HSG-RL300-U 供应商回复交期 - → ${d(12)}`,
      '第 1 行 HSG-RL300-U 单价 12 → 12.5 /PCS',
      `第 2 行 HSG-RL300-D 预计到货 ${d(5)} → ${d(9)}`,
      '第 2 行 HSG-RL300-D 数量 100 → 120 PCS',
    ]);
    const hist = await api.as('qa').ok('get', `/api/purchase-orders/${po.id}/changes`);
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ username: 'buyer', reason: '供应商回复模具维修推迟一周' });
    expect(hist[0].items).toHaveLength(4);
    // 字段级审计也自动记录
    const logs = (await api.as('admin').ok('get', '/api/system/audit-logs', { entity: 'erp_purchase_order_line', entity_id: l1.id })).items;
    expect(logs.some((x: any) => String(x.changes).includes('12.5'))).toBe(true);
    // 没有变化 → 提示
    r = await api.as('buyer').post(`/api/purchase-orders/${po.id}/change`, { reason: '再改一次', lines: [{ id: l1.id, promised_date: d(12) }] });
    expect(r.body.detail).toBe('没有需要变更的内容');
    // 收货 60 后，数量不能改到 50
    await api.as('wh').ok('post', `/api/purchase-orders/${po.id}/receive`, { lines: [{ po_line_id: l1.id, qty: 60, location_id: ref.loc['RAW-A02'] }] });
    r = await api.as('buyer').post(`/api/purchase-orders/${po.id}/change`, { reason: '减量', lines: [{ id: l1.id, qty: 50 }] });
    expect(r.body.detail).toContain('数量不能小于已收货数量 60 PCS');
    // 数量减到已收 → 该行到齐；单价变更提示已收部分应付不变
    const ch2 = await api.as('buyer').ok('post', `/api/purchase-orders/${po.id}/change`, { reason: '供应商调价', lines: [{ id: l1.id, qty: 60, unit_price: 13 }] });
    expect(ch2.status).toBe('PARTIAL_RECEIVED');
    expect(ch2.change.items[1]).toContain('应付单按原价已生成');
    // 草稿不能走变更
    const sup = await api.as('buyer').find('/api/suppliers', { q: 'S004' });
    const draft = await api.as('buyer').ok('post', '/api/purchase-orders', { supplier_id: sup.id, lines: [{ material_id: ref.m['HSG-RL300-U'], qty: 1, unit_price: 1 }] });
    r = await api.as('buyer').post(`/api/purchase-orders/${draft.id}/change`, { reason: '测试', expected_date: d(3) });
    expect(r.body.detail).toBe('草稿状态请直接修改订单');
  });

  test('催货清单：未交数量、回复交期优先、逾期天数、筛选排序；采购单按物料搜索/逾期筛选', async () => {
    const { api } = t;
    const ref = await api.ids();
    const a = await approvedPo('S004', [
      { material_id: ref.m['HSG-RL300-U'], qty: 100, unit_price: 12, expected_date: d(-5) },
      { material_id: ref.m['HSG-RL300-D'], qty: 100, unit_price: 10, expected_date: d(-5) },
    ]);
    const b = await approvedPo('S003', [{ material_id: ref.m['PSU-24V-5A'], qty: 50, unit_price: 45, expected_date: d(2) }]);
    await approvedPo('S002', [{ material_id: ref.m['PCB-AL-300'], qty: 10, unit_price: 18, expected_date: d(20) }]);
    await api.as('wh').ok('post', `/api/purchase-orders/${a.id}/receive`, { lines: [{ po_line_id: a.lines[0].id, qty: 60, location_id: ref.loc['RAW-A02'] }] });
    // 下壳供应商回复 3 天后到（不再算逾期）
    await api.as('buyer').ok('post', `/api/purchase-orders/${a.id}/change`, { reason: '供应商回复交期', lines: [{ id: a.lines[1].id, promised_date: d(3) }] });
    const all = await api.as('buyer').ok('get', '/api/purchase/chase');
    expect(all.counts).toMatchObject({ total: 4, overdue: 1, due_soon: 2 });
    const first = all.items[0];
    expect([first.po_no, first.material_code, first.open_qty, first.overdue_days, first.state, first.due_date]).toEqual([a.no, 'HSG-RL300-U', 40, 5, 'OVERDUE', d(-5)]);
    expect(first.open_amount).toBe(480);
    const down = all.items.find((x: any) => x.material_code === 'HSG-RL300-D');
    expect([down.state, down.promised_date, down.due_date, down.overdue_days]).toEqual(['DUE_SOON', d(3), d(3), 0]);
    const overdue = await api.as('buyer').ok('get', '/api/purchase/chase', { overdue: 1 });
    expect(overdue.items.map((x: any) => x.material_code)).toEqual(['HSG-RL300-U']);
    const sorted = await api.as('buyer').ok('get', '/api/purchase/chase', { sort: 'open_qty', order: 'asc' });
    expect(sorted.items.map((x: any) => x.open_qty)).toEqual([10, 40, 50, 100]);
    const bySup = await api.as('buyer').ok('get', '/api/purchase/chase', { supplier_id: b.supplier_id });
    expect(bySup.items.map((x: any) => x.po_no)).toEqual([b.no]);
    // 采购单按物料编码搜索、逾期筛选
    expect((await api.as('buyer').ok('get', '/api/purchase-orders', { q: 'PSU-24V' })).items.map((x: any) => x.no)).toEqual([b.no]);
    expect((await api.as('buyer').ok('get', '/api/purchase-orders', { material: '下壳' })).items.map((x: any) => x.no)).toEqual([a.no]);
    expect((await api.as('buyer').ok('get', '/api/purchase-orders', { overdue: 1 })).items.map((x: any) => x.no)).toEqual([a.no]);
    // 排序
    const s = await api.as('buyer').ok('get', '/api/purchase-orders', { sort: 'total_amount', order: 'asc' });
    expect(s.items.map((x: any) => x.total_amount)).toEqual([180, 2200, 2250]);
  });

  test('采购维护物料采购属性；按采购单位只能整包下单；最近采购价', async () => {
    const { api } = t;
    const ref = await api.ids();
    const led = ref.m['LED-660-3030'];
    expect((await api.as('sales').put(`/api/purchase/materials/${led}`, { purchase_uom: '卷', purchase_factor: 4000 })).status).toBe(403);
    let r = await api.as('buyer').put(`/api/purchase/materials/${led}`, { purchase_uom: '卷' });
    expect(r.body.detail).toBe('1 卷 = 1 PCS 时无需设置采购单位，请清空采购单位');
    const m = await api.as('buyer').ok('put', `/api/purchase/materials/${led}`, { purchase_uom: '卷', purchase_factor: 4000, lead_time_days: 20, min_order_qty: 4000 });
    expect([m.purchase_uom, m.purchase_factor, m.lead_time_days, m.min_order_qty]).toEqual(['卷', 4000, 20, 4000]);
    r = await api.as('buyer').put(`/api/purchase/materials/${ref.m['PKG-RL300-BOX']}`, { purchase_uom: '箱', purchase_factor: 50 });
    expect(r.body.detail).toContain('客供料');
    const sup = await api.as('buyer').find('/api/suppliers', { q: 'S001' });
    r = await api.as('buyer').post('/api/purchase-orders', { supplier_id: sup.id, lines: [{ material_id: led, purchase_qty: 1.0908, purchase_price: 1400 }] });
    expect(r.status).toBe(400);
    expect(r.body.detail).toBe('第 1 行 LED-660-3030 按卷下单须为整数卷（填写了 1.0908 卷，1 卷 = 4000 PCS）。请改为 2 卷，或改按 PCS 下单');
    const p = await api.as('buyer').ok('post', '/api/purchase-orders', { supplier_id: sup.id, lines: [{ material_id: led, purchase_qty: 2, purchase_price: 1400 }] });
    expect([p.lines[0].qty, p.lines[0].amount]).toEqual([8000, 2800]);
    await api.as('buyer').ok('post', `/api/purchase-orders/${p.id}/approve`);
    const list = await api.as('buyer').ok('get', '/api/purchase/materials', { q: 'LED-660' });
    expect(list.items[0]).toMatchObject({ code: 'LED-660-3030', purchase_uom: '卷', last_price: 0.35, last_purchase_price: 1400, last_po_no: p.no });
    // 清空采购单位
    const cleared = await api.as('buyer').ok('put', `/api/purchase/materials/${led}`, { purchase_uom: null });
    expect([cleared.purchase_uom, cleared.purchase_factor]).toEqual([null, 1]);
  });
});

describe('财务', () => {
  const ids = async () => {
    const c1 = await t.api.as('finance').find('/api/customers', { q: 'C001' });
    const c2 = await t.api.as('finance').find('/api/customers', { q: 'C002' });
    const s1 = await t.api.as('finance').find('/api/suppliers', { q: 'S001' });
    return { c1, c2, s1 };
  };
  const doc = (no: string, x: Record<string, any>) =>
    t.db.base.financeDoc.create({ data: { no, doc_date: addDays(today(), -10), due_date: addDays(today(), 20), status: 'OPEN', ...x } as any });

  test('应收记账汇率与本位币；收款实收汇率 + 手续费 → 汇兑差异；超额转预收；作废回滚；预收冲抵', async () => {
    const { api } = t;
    const { c1 } = await ids();
    await api.as('finance').ok('post', '/api/exchange-rates', { currency: 'USD', rate: 7.0, effective_date: d(-20) });
    // USD 汇率：-20 天 7.0；-5 天 7.1（基础数据）
    const ar = await doc('AR-X1', { doc_type: 'AR', customer_id: c1.id, currency: 'USD', amount: 1000 });
    let list = await api.as('finance').ok('get', '/api/finance/docs', { doc_type: 'AR' });
    expect(list.items[0]).toMatchObject({ no: 'AR-X1', exchange_rate: 7, base_amount: 7000, base_balance: 7000, partner_code: 'C001' });
    // 收款 975 到账 + 25 手续费（核销 1000），实收汇率 7.1
    let r = await api.as('finance').post(`/api/finance/docs/${ar.id}/payments`, { amount: 1100, fee_amount: 25, exchange_rate: 7.1, reference: 'TT-1' });
    expect(r.body.detail).toContain('金额超过未结余额 1000.00（超出 100.00）');
    expect(r.body.detail).toContain('超出部分转预收款');
    let docRes = await api.as('finance').ok('post', `/api/finance/docs/${ar.id}/payments`, { amount: 1100, fee_amount: 25, exchange_rate: 7.1, reference: 'TT-1', as_advance: true });
    expect([docRes.status, docRes.paid_amount, docRes.balance]).toEqual(['PAID', 1000, 0]);
    const pay = docRes.payments[0];
    expect([pay.amount, pay.fee_amount, pay.exchange_rate, pay.base_amount, pay.fx_diff]).toEqual([1000, 25, 7.1, 6922.5, 100]); // (1000-25)×7.1；1000×(7.1-7.0)
    expect(pay.receipt_no).toMatch(/^SK\d{9}$/);
    const adv = (await api.as('finance').ok('get', '/api/finance/docs', { doc_type: 'PR' })).items[0];
    expect([adv.amount, adv.balance, adv.exchange_rate, adv.base_amount, adv.ref_no]).toEqual([100, 100, 7.1, 710, pay.receipt_no]);
    // 预收冲抵新的应收
    const ar2 = await doc('AR-X2', { doc_type: 'AR', customer_id: c1.id, currency: 'USD', amount: 300, doc_date: addDays(today(), -1) });
    docRes = await api.as('finance').ok('post', `/api/finance/docs/${ar2.id}/apply-advance`, { advance_id: adv.id });
    expect([docRes.paid_amount, docRes.status]).toEqual([100, 'PARTIAL']);
    expect(docRes.payments[0]).toMatchObject({ method: '预收冲抵', amount: 100, exchange_rate: 7.1, fx_diff: 0 });
    // 预收已被冲抵 → 原收款不能作废
    r = await api.as('finance').post(`/api/finance/payments/${pay.id}/void`, { reason: '登错客户' });
    expect(r.body.detail).toContain('已冲抵 100.00');
    // 先作废冲抵，再作废原收款
    const offset = docRes.payments[0];
    expect((await api.as('finance').post(`/api/finance/payments/${offset.id}/void`, { reason: '' })).status).toBe(400);
    expect((await api.as('buyer').post(`/api/finance/payments/${offset.id}/void`, { reason: '测试' })).status).toBe(403);
    await api.as('finance').ok('post', `/api/finance/payments/${offset.id}/void`, { reason: '冲抵错单' });
    const v = await api.as('finance').ok('post', `/api/finance/payments/${pay.id}/void`, { reason: '登错客户' });
    expect([v.voided, v.advances_voided]).toEqual([1, [adv.no]]);
    list = await api.as('finance').ok('get', '/api/finance/docs', { doc_type: 'AR', q: 'AR-X1' });
    expect([list.items[0].status, list.items[0].paid_amount]).toEqual(['OPEN', 0]);
    expect(list.items[0].payments[0]).toMatchObject({ status: 'VOID', void_reason: '登错客户', voided_by: '钱财务' });
    expect((await api.as('finance').ok('get', '/api/finance/docs', { doc_type: 'PR' })).total).toBe(0); // 作废的预收默认不显示
    r = await api.as('finance').post(`/api/finance/payments/${pay.id}/void`, { reason: '再次作废' });
    expect(r.body.detail).toContain('已于');
    // 流水：含作废记录，可按状态筛选
    const pays = await api.as('finance').ok('get', '/api/finance/payments', { kind: 'AR' });
    expect(pays.total).toBe(3); // 收款 1 + 预收冲抵 2（应收侧 + 预收侧），均已作废
    expect((await api.as('finance').ok('get', '/api/finance/payments', { status: 'VALID' })).total).toBe(0);
    expect(pays.items[0]).toHaveProperty('partner_name', c1.name);
  });

  test('合并收款：按到期日先后自动分配；预览不写库；超额需确认转预收', async () => {
    const { api } = t;
    const { c1, c2 } = await ids();
    const a1 = await doc('AR-M1', { doc_type: 'AR', customer_id: c1.id, currency: 'USD', amount: 500, due_date: addDays(today(), 10) });
    const a2 = await doc('AR-M2', { doc_type: 'AR', customer_id: c1.id, currency: 'USD', amount: 300, due_date: addDays(today(), -3) });
    await doc('AR-M3', { doc_type: 'AR', customer_id: c1.id, currency: 'USD', amount: 400, due_date: addDays(today(), 30) });
    await doc('AR-M4', { doc_type: 'AR', customer_id: c1.id, currency: 'CNY', amount: 999 }); // 不同币别不参与
    await doc('AR-M5', { doc_type: 'AR', customer_id: c2.id, currency: 'USD', amount: 999 }); // 其他客户不参与
    const body = { kind: 'AR', partner_id: c1.id, currency: 'USD', amount: 1000, fee_amount: 20, reference: 'TT-88' };
    const plan = await api.as('finance').ok('post', '/api/finance/receipts', { ...body, dry_run: true });
    expect(plan.allocations.map((x: any) => [x.no, x.amount, x.balance_after])).toEqual([['AR-M2', 300, 0], ['AR-M1', 500, 0], ['AR-M3', 200, 200]]);
    expect([plan.open_total, plan.excess]).toEqual([1200, 0]);
    expect((await api.as('finance').ok('get', '/api/finance/payments')).total).toBe(0);
    const res = await api.as('finance').ok('post', '/api/finance/receipts', body);
    expect(res.payments).toHaveLength(3);
    expect(new Set(res.payments.map((p: any) => p.receipt_no)).size).toBe(1);
    expect(res.payments.map((p: any) => p.fee_amount)).toEqual([20, 0, 0]);
    const docs = (await api.as('finance').ok('get', '/api/finance/docs', { partner_id: c1.id, doc_type: 'AR', currency: 'USD', sort: 'no', order: 'asc' })).items;
    expect(docs.map((x: any) => [x.no, x.status, x.balance])).toEqual([['AR-M1', 'PAID', 0], ['AR-M2', 'PAID', 0], ['AR-M3', 'PARTIAL', 200]]);
    // 超额：剩余 200，收 250 → 需确认
    let r = await api.as('finance').post('/api/finance/receipts', { kind: 'AR', partner_id: c1.id, currency: 'USD', amount: 250 });
    expect(r.body.detail).toContain('超过该客户 USD 未结应收合计 200.00（超出 50.00）');
    r = await api.as('finance').post('/api/finance/receipts', { kind: 'AR', partner_id: c1.id, currency: 'USD', amount: 250, as_advance: true });
    expect(r.status).toBe(200);
    expect(r.body.advance).toMatchObject({ doc_type: 'PR', amount: 50 });
    // 作废合并收款：三张应收一起回滚
    await api.as('finance').ok('post', `/api/finance/payments/${res.payments[1].id}/void`, { reason: '银行退汇' });
    const after = (await api.as('finance').ok('get', '/api/finance/docs', { partner_id: c1.id, doc_type: 'AR', currency: 'USD', sort: 'no', order: 'asc' })).items;
    expect(after.map((x: any) => [x.no, x.balance])).toEqual([['AR-M1', 500], ['AR-M2', 300], ['AR-M3', 200]]);
    expect(a1.id + a2.id).toBeGreaterThan(0);
  });

  test('财务列表筛选：往来单位、期间、币别、关键字（客户名/订单号）、逾期；导出所需字段', async () => {
    const { api } = t;
    const { c1, c2, s1 } = await ids();
    const m = today();
    const lastMonth = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() - 1, 15));
    await doc('AR-F1', { doc_type: 'AR', customer_id: c1.id, currency: 'USD', amount: 100, remark: '销售订单 SO261001001 发货', doc_date: lastMonth, due_date: addDays(today(), -2) });
    await doc('AR-F2', { doc_type: 'AR', customer_id: c2.id, currency: 'CNY', amount: 200 });
    await doc('AP-F1', { doc_type: 'AP', supplier_id: s1.id, currency: 'CNY', amount: 300 });
    const q = (x: Record<string, unknown>) => api.as('finance').ok('get', '/api/finance/docs', x).then((r: any) => r.items.map((i: any) => i.no).sort());
    expect(await q({ doc_type: 'AR', partner_id: c1.id })).toEqual(['AR-F1']);
    expect(await q({ q: 'Lumina' })).toEqual(['AR-F1']);
    expect(await q({ q: 'SO261001001' })).toEqual(['AR-F1']);
    expect(await q({ q: 'C002' })).toEqual(['AR-F2']);
    expect(await q({ currency: 'CNY' })).toEqual(['AP-F1', 'AR-F2']);
    expect(await q({ period: fmtDate(lastMonth)!.slice(0, 7) })).toEqual(['AR-F1']);
    expect(await q({ overdue: 1 })).toEqual(['AR-F1']);
    expect((await api.as('finance').get('/api/finance/docs', { period: '2026/13' })).body.detail).toContain('期间格式应为 YYYY-MM');
  });

  test('账龄：截止日、自定义区间、记账汇率 vs 期末汇率、币别小计、下钻明细', async () => {
    const { api } = t;
    const { c1, c2 } = await ids();
    await api.as('finance').ok('post', '/api/exchange-rates', { currency: 'USD', rate: 7.0, effective_date: d(-200) });
    await doc('AR-A1', { doc_type: 'AR', customer_id: c1.id, currency: 'USD', amount: 100, doc_date: addDays(today(), -100), due_date: addDays(today(), -70) }); // 记账 7.0，逾期 70 天
    await doc('AR-A2', { doc_type: 'AR', customer_id: c1.id, currency: 'USD', amount: 50, doc_date: addDays(today(), -1), due_date: addDays(today(), 40) }); // 记账 7.1
    await doc('AR-A3', { doc_type: 'AR', customer_id: c2.id, currency: 'CNY', amount: 80, doc_date: addDays(today(), -40), due_date: addDays(today(), -10) });
    const closing = await api.as('finance').ok('get', '/api/finance/summary', { buckets: '30,60,90', detail: 1 });
    expect(closing.buckets).toEqual(['未到期', '1-30天', '31-60天', '61-90天', '90天以上']);
    const lum = closing.AR.find((r: any) => r.partner === c1.name);
    expect([lum['未到期'], lum['61-90天'], lum.total, lum.total_base]).toEqual([50, 100, 150, 1065]); // 150 × 7.1
    expect(lum.docs.map((x: any) => [x.no, x.overdue_days, x.bucket])).toEqual([['AR-A1', 70, '61-90天'], ['AR-A2', 0, '未到期']]);
    const booking = await api.as('finance').ok('get', '/api/finance/summary', { basis: 'booking', detail: 1 });
    expect(booking.AR.find((r: any) => r.partner === c1.name).total_base).toBe(1055); // 100 × 7.0 + 50 × 7.1
    expect(booking.subtotals.AR).toEqual([
      expect.objectContaining({ currency: 'CNY', total: 80, total_base: 80, rows: 1 }),
      expect.objectContaining({ currency: 'USD', total: 150, total_base: 1055, rows: 1 }),
    ]);
    expect(booking.totals.AR.total).toBe(1135);
    // 截止日 40 天前：AR-A1 当时逾期 30 天；AR-A3 当日入账、未到期；AR-A2 尚未发生
    const past = await api.as('finance').ok('get', '/api/finance/summary', { as_of: d(-40) });
    expect(past.AR.map((r: any) => [r.partner, r.total, r['1-30天']])).toEqual([[c1.name, 100, 100], [c2.name, 80, 0]]);
    // 截止日之后的收款不影响截止日余额
    const a1 = (await api.as('finance').ok('get', '/api/finance/docs', { q: 'AR-A1' })).items[0];
    await api.as('finance').ok('post', `/api/finance/docs/${a1.id}/payments`, { amount: 100 });
    expect((await api.as('finance').ok('get', '/api/finance/summary', { as_of: d(-1) })).AR.find((r: any) => r.partner === c1.name).total).toBe(150); // 今天的收款不计入昨天
    expect((await api.as('finance').ok('get', '/api/finance/summary')).AR.find((r: any) => r.partner === c1.name).total).toBe(50);
  });

  test('付款前显示来料 IQC 状态；金蝶凭证引出借贷平衡（应付、付款含手续费、汇兑差异、红字冲销）', async () => {
    const { api } = t;
    const ref = await api.ids();
    const po = await approvedPo('S001', [{ material_id: ref.m['LED-660-3030'], qty: 1000, unit_price: 0.35 }], { currency: 'USD' });
    await api.as('wh').ok('post', `/api/purchase-orders/${po.id}/receive`, { lines: [{ po_line_id: po.lines[0].id, qty: 1000, location_id: ref.loc['DRY-01'] }] });
    const ap = (await api.as('finance').ok('get', '/api/finance/docs', { doc_type: 'AP' })).items[0];
    expect([ap.currency, ap.amount, ap.exchange_rate, ap.base_amount]).toEqual(['USD', 350, 7.1, 2485]); // 收货时即按收货日汇率记账
    expect(ap.iqc).toMatchObject({ status: 'PENDING', text: '来料待检验' });
    expect(ap.iqc.lines[0]).toMatchObject({ material_code: 'LED-660-3030', status: 'PENDING' });
    const one = await api.as('finance').ok('get', `/api/finance/docs/${ap.id}`);
    expect(one.iqc.status).toBe('PENDING');
    // 付款：实付汇率 7.2，手续费 USD 5（我方另付）→ 汇兑损失 35
    const paid = await api.as('finance').ok('post', `/api/finance/docs/${ap.id}/payments`, { amount: 350, fee_amount: 5, exchange_rate: 7.2 });
    expect(paid.payments[0]).toMatchObject({ base_amount: 2556, fx_diff: -35 }); // (350+5)×7.2；350×7.1−350×7.2
    const period = fmtDate(today())!.slice(0, 7);
    let v = await api.as('finance').ok('get', '/api/finance/voucher', { period });
    expect(v.debit_total).toBe(v.credit_total);
    expect(v.warnings).toEqual([]);
    const pay = v.items.filter((x: any) => x.summary.startsWith('付款'));
    expect(pay.map((x: any) => [x.account_code, x.debit, x.credit])).toEqual([
      ['1002', 0, 2556], ['2202', 2485, 0], ['6603.02', 36, 0], ['6603.03', 35, 0],
    ]);
    expect(pay[1]).toMatchObject({ aux_type: '供应商', partner_code: 'S001', currency: 'USD', amount_fc: 350, word: '记' });
    const apv = v.items.filter((x: any) => x.biz_no === ap.no);
    expect(apv.map((x: any) => [x.account_code, x.debit, x.credit, x.rate])).toEqual([['1403', 2485, 0, 7.1], ['2202', 0, 2485, 7.1]]);
    // 当期作废的当期付款不出凭证
    await api.as('finance').ok('post', `/api/finance/payments/${paid.payments[0].id}/void`, { reason: '重复登记' });
    v = await api.as('finance').ok('get', '/api/finance/voucher', { period });
    expect(v.items.some((x: any) => x.summary.startsWith('付款'))).toBe(false);
    // 以前期间的付款在本期作废 → 红字冲销
    const p2 = await api.as('finance').ok('post', `/api/finance/docs/${ap.id}/payments`, { amount: 100, pay_date: d(-40), exchange_rate: 7.1 });
    await api.as('finance').ok('post', `/api/finance/payments/${p2.payments.find((x: any) => x.status === 'VALID').id}/void`, { reason: '银行退回' });
    v = await api.as('finance').ok('get', '/api/finance/voucher', { date_from: d(-1), date_to: d(1) });
    const rev = v.items.filter((x: any) => x.summary.startsWith('冲销'));
    expect(rev.map((x: any) => [x.account_code, x.debit, x.credit])).toEqual([['1002', 0, -710], ['2202', -710, 0]]);
    expect(v.debit_total).toBe(v.credit_total);
    expect((await api.as('finance').get('/api/finance/voucher')).body.detail).toContain('会计期间');
  });

  test('汇率：被引用的不能改/删（可改备注）；与上一期偏差 >10% 需确认', async () => {
    const { api } = t;
    const { c1 } = await ids();
    const usd = (await api.as('finance').ok('get', '/api/exchange-rates')).items[0];
    expect(usd.referenced).toBe(false);
    await doc('AR-R1', { doc_type: 'AR', customer_id: c1.id, currency: 'USD', amount: 10, doc_date: addDays(today(), -1) });
    const list = (await api.as('finance').ok('get', '/api/exchange-rates')).items;
    expect(list[0]).toMatchObject({ referenced: true, ref_docs: 1 });
    let r = await api.as('finance').put(`/api/exchange-rates/${usd.id}`, { rate: 7.15 });
    expect(r.body.detail).toContain('已被 1 张应收应付单、0 笔收付款引用，不能修改');
    expect((await api.as('finance').ok('put', `/api/exchange-rates/${usd.id}`, { remark: '人行中间价' })).remark).toBe('人行中间价');
    r = await api.as('finance').del(`/api/exchange-rates/${usd.id}`);
    expect(r.body.detail).toContain('不能删除');
    // 偏差：71.0 vs 7.1
    r = await api.as('finance').post('/api/exchange-rates', { currency: 'USD', rate: 71, effective_date: d(0) });
    expect(r.body.detail).toContain('相差 +900.0%，超过 10%');
    const ok = await api.as('finance').ok('post', '/api/exchange-rates', { currency: 'USD', rate: 7.2, effective_date: d(0) });
    expect([ok.prev_rate, ok.change_pct]).toEqual([7.1, 0.0141]);
    r = await api.as('finance').put(`/api/exchange-rates/${ok.id}`, { rate: 8.2 });
    expect(r.body.detail).toContain('超过 10%');
    expect((await api.as('finance').ok('put', `/api/exchange-rates/${ok.id}`, { rate: 8.2, confirm_deviation: true })).rate).toBe(8.2);
    // 未被引用的可删除
    expect((await api.as('finance').ok('delete', `/api/exchange-rates/${ok.id}`)).ok).toBe(true);
  });
});
