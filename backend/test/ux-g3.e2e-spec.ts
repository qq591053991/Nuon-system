/**
 * 好用性修复 G3（销售 / 计划 / MRP）：
 *   A1 订单撤销确认与变更（校验已发货/已排产、受影响工单、变更原因留痕）；
 *   A2 MRP 生产建议挂订单行、转工单关联订单、订单生成工单扣除已覆盖量、MRP 结果过期检查；
 *   A3 重跑 MRP 已转单量不重复建议，给“提前催交”例外；
 *   A4 齐套分析只读接口（订单/工单/批量/缺料筛选）；
 *   A9 订单生成工单按交期倒排、工单下达后调整；A10 需求来源/离散取整；A11 PO 号重复、上次成交价；A13 销售建客户；
 *   销售订单读权限与金额字段。
 */
import { addDays, fmtDate, today } from '../src/common/dates';
import { bootApp } from './harness';

let t: Awaited<ReturnType<typeof bootApp>>;
beforeAll(async () => (t = await bootApp()));
beforeEach(() => t.reset());
afterAll(() => t.close());

const d = (n: number) => fmtDate(addDays(today(), n))!;
const so = (q: string) => t.api.as('sales').find('/api/sales-orders', { q });
const reasons = async (entity: string, id: number) =>
  (await t.db.base.auditLog.findMany({ where: { entity, entity_id: id }, orderBy: { id: 'asc' } }))
    .map((r) => JSON.parse(r.changes || '{}').change_reason?.[1])
    .filter(Boolean);

describe('A1 已确认订单：撤销确认 / 变更', () => {
  test('无下游时撤销确认回草稿（需原因、留痕）；有工单时不能撤销，提示用变更', async () => {
    const { api } = t;
    const s = await so('GY-2026-0931'); // 已确认 10 台 BL-100
    expect((await api.as('sales').post(`/api/sales-orders/${s.id}/unconfirm`, { reason: ' ' })).body.detail).toBe('请填写撤销确认的原因');
    expect((await api.as('buyer').post(`/api/sales-orders/${s.id}/unconfirm`, { reason: 'x' })).status).toBe(403);
    const r = await api.as('sales').ok('post', `/api/sales-orders/${s.id}/unconfirm`, { reason: '客户改型号' });
    expect(r.status).toBe('DRAFT');
    expect(await reasons('erp_sales_order', s.id)).toEqual(['撤销确认（退回草稿）：客户改型号']);
    // 草稿修改保留原行 id（审计按行记录）
    const lineId = r.lines[0].id;
    const upd = await api.as('sales').ok('put', `/api/sales-orders/${s.id}`, {
      customer_id: s.customer_id, lines: [{ id: lineId, material_id: r.lines[0].material_id, qty: 12, unit_price: 4200 }],
    });
    expect([upd.lines[0].id, upd.lines[0].qty, upd.total_amount]).toEqual([lineId, 12, 50400]);
    await api.as('sales').ok('post', `/api/sales-orders/${s.id}/confirm`);
    await api.as('pmc').ok('post', `/api/sales-orders/${s.id}/create-work-orders`);
    const err = await api.as('sales').post(`/api/sales-orders/${s.id}/unconfirm`, { reason: 'x' });
    expect(err.status).toBe(400);
    expect(err.body.detail).toMatch(/已生成工单（WO\d+），不能撤销确认；改数量\/交期请用【变更】/);
    // 有工单时取消订单也给出办法
    expect((await api.as('sales').post(`/api/sales-orders/${s.id}/cancel`)).body.detail).toMatch(/请先取消工单；如只是改数量\/交期，请用【变更】/);
  });

  test('变更：预览差异与受影响工单；校验已发货/待发、单价与删除限制；保存需原因，审计留痕', async () => {
    const { api, db } = t;
    const s = await so('LUM-PO-26-118'); // 已确认 20 台 RL-300，交期 +20
    await api.as('pmc').ok('post', `/api/sales-orders/${s.id}/create-work-orders`);
    const full = await api.as('sales').ok('get', `/api/sales-orders/${s.id}`);
    const line = full.lines[0];
    const wo = full.work_orders[0];
    expect([line.planned_qty, wo.planned_qty, wo.planned_end]).toEqual([20, 20, d(20)]);
    const body = (o: Record<string, unknown>) => ({ lines: [{ id: line.id, material_id: line.material_id, qty: 20, unit_price: 88, ...o }] });

    // 减量 + 交期提前 → 预览列出受影响工单（不保存）
    let p = await api.as('sales').ok('post', `/api/sales-orders/${s.id}/change`, { ...body({ qty: 15, delivery_date: d(10) }), preview: true });
    expect(p.errors).toEqual([]);
    expect(p.changes).toEqual(['第1行 FG-RL300 数量 20 → 15', `第1行 FG-RL300 交期 ${d(20)} → ${d(10)}`]);
    expect(p.affected.map((a: any) => a.wo_no)).toEqual([wo.no, wo.no]);
    expect(p.affected[0].message).toContain('计划员需调减 5');
    expect(p.affected[1].message).toContain(`新交期 ${d(10)} 早于工单 ${wo.no} 计划完工 ${d(20)}`);
    expect((await api.as('sales').ok('get', `/api/sales-orders/${s.id}`)).lines[0].qty).toBe(20);

    // 增量 → 提醒补排；不填原因不能保存；没有修改不能保存
    p = await api.as('sales').ok('post', `/api/sales-orders/${s.id}/change`, { ...body({ qty: 25 }), preview: true });
    expect(p.warnings[0]).toContain('计划员需补排 5');
    expect((await api.as('sales').post(`/api/sales-orders/${s.id}/change`, body({ qty: 25 }))).body.detail).toContain('请填写变更原因');
    expect((await api.as('sales').post(`/api/sales-orders/${s.id}/change`, { ...body({}), reason: 'x' })).body.detail).toBe('没有修改任何内容');
    expect((await api.as('wh').post(`/api/sales-orders/${s.id}/change`, { ...body({ qty: 25 }), reason: 'x' })).status).toBe(403);

    const saved = await api.as('sales').ok('post', `/api/sales-orders/${s.id}/change`, { ...body({ qty: 25 }), reason: '客户邮件追加 5 台' });
    expect([saved.order.lines[0].id, saved.order.lines[0].qty, saved.order.total_amount, saved.order.status]).toEqual([line.id, 25, 2200, 'IN_PRODUCTION']);
    expect(await reasons('erp_sales_order', s.id)).toEqual(['订单变更：第1行 FG-RL300 数量 20 → 25。原因：客户邮件追加 5 台']);
    const lineAudit = await db.base.auditLog.findFirst({ where: { entity: 'erp_sales_order_line', entity_id: line.id, action: 'UPDATE' }, orderBy: { id: 'desc' } });
    expect(JSON.parse(lineAudit!.changes!).qty).toEqual([20, 25]);
    // 补排：生成工单只补未覆盖的 5
    const res = await api.as('pmc').ok('post', `/api/sales-orders/${s.id}/create-work-orders`);
    expect(res.work_orders).toHaveLength(1);
    expect((await api.as('pmc').find('/api/work-orders', { q: res.work_orders[0] })).planned_qty).toBe(5);

    // 已发货：数量不能少于已发 + 待发；不能改单价；有工单的行不能删、不能换产品
    await db.base.salesOrderLine.update({ where: { id: line.id }, data: { shipped_qty: 22 } });
    p = await api.as('sales').ok('post', `/api/sales-orders/${s.id}/change`, { ...body({ qty: 21, unit_price: 90 }), preview: true });
    expect(p.errors).toEqual(['第1行 FG-RL300 已发货 22，变更后数量不能少于 22', '第1行 FG-RL300 已发货 22（已生成应收），不能修改单价；如需调价请联系财务处理应收差额']);
    const bad = await api.as('sales').post(`/api/sales-orders/${s.id}/change`, { ...body({ qty: 21 }), reason: 'x' });
    expect(bad.body.detail).toBe('第1行 FG-RL300 已发货 22，变更后数量不能少于 22');
    const ref = await api.ids();
    p = await api.as('sales').ok('post', `/api/sales-orders/${s.id}/change`, { lines: [{ material_id: ref.m['FG-RL300'], qty: 5, unit_price: 88 }], preview: true });
    expect(p.errors[0]).toMatch(/^第1行 FG-RL300 已排产（WO\d+、WO\d+），不能删除；可把数量改为已发货数量$/);
    // 改到已发数量 → 订单变为已全部发货
    const done = await api.as('sales').ok('post', `/api/sales-orders/${s.id}/change`, { ...body({ qty: 22 }), reason: '客户不再要剩余 3 台' });
    expect(done.order.status).toBe('SHIPPED');

    // 变更记录：含原因与字段变化
    const hist = await api.as('sales').ok('get', `/api/sales-orders/${s.id}/history`);
    expect(hist.filter((h: any) => h.changes.change_reason).length).toBe(2);
    expect(hist.some((h: any) => h.target === 'LINE' && h.line_no === 1 && Array.isArray(h.changes.qty))).toBe(true);
  });
});

describe('A2/A3 订单与 MRP 互相知道、重跑不重复建议', () => {
  test('MRP 生产建议挂订单行，转工单关联订单；订单再生成工单不重复', async () => {
    const { api } = t;
    const s = await so('LUM-PO-26-118');
    const run = await api.as('pmc').ok('post', '/api/mrp/run');
    const fg = run.suggestions.find((x: any) => x.material_code === 'FG-RL300');
    expect(fg.demand).toEqual([expect.objectContaining({ type: 'SO', id: s.id, no: s.no, line_no: 1, qty: 20, date: d(20), customer: 'Lumina' })]);
    // 下层组件的需求来源 = 上层计划（带订单号）
    const child = run.suggestions.find((x: any) => (x.demand || []).some((r: any) => r.type === 'PLAN' && r.parent === 'FG-RL300'));
    expect(child.demand.find((r: any) => r.parent === 'FG-RL300')).toEqual(expect.objectContaining({ type: 'PLAN', parent: 'FG-RL300', so: [s.no] }));
    const conv = await api.as('pmc').ok('post', '/api/mrp/convert', { suggestion_ids: [fg.id] });
    expect(conv.work_orders).toHaveLength(1);
    const wo = await api.as('pmc').find('/api/work-orders', { q: conv.work_orders[0] });
    expect([wo.so_id, wo.so_no, wo.planned_qty, wo.source]).toEqual([s.id, s.no, 20, `MRP·${s.no}`]);
    const detail = await api.as('sales').ok('get', `/api/sales-orders/${s.id}`);
    expect([detail.status, detail.lines[0].planned_qty]).toEqual(['IN_PRODUCTION', 20]);
    const plan = await api.as('pmc').ok('get', `/api/sales-orders/${s.id}/work-order-plan`);
    expect([plan.lines[0].wo_qty, plan.lines[0].uncovered, plan.lines[0].suggest_qty]).toEqual([20, 0, 0]);
    expect((await api.as('pmc').ok('post', `/api/sales-orders/${s.id}/create-work-orders`)).work_orders).toEqual([]);
    // 运行结果带转出单据的 id/状态，单号可直接点开
    const again = await api.as('pmc').ok('get', `/api/mrp/runs/${run.id}`);
    const c = again.suggestions.find((x: any) => x.id === fg.id);
    expect([c.status, c.converted_doc_no, c.converted_doc_id, c.converted_doc_status]).toEqual(['CONVERTED', wo.no, wo.id, 'PLANNED']);
    expect(c.converted).toEqual([expect.objectContaining({ role: 'converted', type: 'WO', id: wo.id, no: wo.no, qty: 20 })]);
  });

  test('运算后订单又生成了工单 → 结果过期，转单被拦截；强制转单也不重复生成已覆盖的量', async () => {
    const { api } = t;
    const s = await so('LUM-PO-26-118');
    const run = await api.as('pmc').ok('post', '/api/mrp/run');
    const fg = run.suggestions.find((x: any) => x.material_code === 'FG-RL300');
    expect((await api.as('pmc').ok('get', `/api/mrp/runs/${run.id}/staleness`)).stale).toBe(false);
    const gen = await api.as('pmc').ok('post', `/api/sales-orders/${s.id}/create-work-orders`);
    const st = await api.as('pmc').ok('get', `/api/mrp/runs/${run.id}/staleness`);
    expect(st.stale).toBe(true);
    expect(st.reasons).toEqual([`生产工单有新建/改量改期/取消：${gen.work_orders[0]}`]);
    const blocked = await api.as('pmc').post('/api/mrp/convert', { suggestion_ids: [fg.id] });
    expect(blocked.status).toBe(400);
    expect(blocked.body.detail).toMatch(/^MRP 结果已过期：生产工单有新建\/改量改期\/取消：WO\d+。请重新运行 MRP 后再转单/);
    const forced = await api.as('pmc').ok('post', '/api/mrp/convert', { suggestion_ids: [fg.id], force: true });
    expect(forced.work_orders).toEqual([]);
    expect(forced.skipped).toEqual([`FG-RL300：订单 ${s.no} 的 20 已有工单/库存覆盖，未重复生成`]);
    expect((await api.as('pmc').ok('get', `/api/sales-orders/${s.id}`)).work_orders).toHaveLength(1);
    // 订单先生成工单再跑 MRP：工单按交期倒排完工，MRP 不再建议生产
    const run2 = await api.as('pmc').ok('post', '/api/mrp/run');
    expect(run2.suggestions.filter((x: any) => x.material_code === 'FG-RL300')).toEqual([]);
    // 订单确认/变更、库存调整也会使结果过期
    const s2 = await so('LUM-PO-26-131');
    await api.as('sales').ok('post', `/api/sales-orders/${s2.id}/confirm`);
    expect((await api.as('pmc').ok('get', `/api/mrp/runs/${run2.id}/staleness`)).reasons).toEqual([`销售订单有确认/变更/取消：${s2.no}`]);
  });

  test('订单生成工单扣除未关联订单的工单（旧 MRP/手工建的），可关联到订单而不新建', async () => {
    const { api } = t;
    const ref = await api.ids();
    const manual = await api.as('pmc').ok('post', '/api/work-orders', { material_id: ref.m['FG-BL100'], planned_qty: 6, planned_start: d(3), planned_end: d(10) });
    const s = await so('GY-2026-0931'); // 10 台
    const plan = await api.as('pmc').ok('get', `/api/sales-orders/${s.id}/work-order-plan`);
    expect(plan.lines[0]).toEqual(expect.objectContaining({ qty: 10, wo_qty: 0, free_qty: 6, uncovered: 4, suggest_qty: 4 }));
    expect(plan.lines[0].free_sources).toEqual([{ type: 'WO', id: manual.id, no: manual.no, qty: 6 }]);
    expect(plan.linkable_work_orders.map((w: any) => w.no)).toEqual([manual.no]);
    const r = await api.as('pmc').ok('post', `/api/sales-orders/${s.id}/create-work-orders`, { link_wo_ids: [manual.id] });
    expect([r.linked, r.work_orders.length]).toEqual([[manual.no], 1]);
    const detail = await api.as('sales').ok('get', `/api/sales-orders/${s.id}`);
    expect(detail.work_orders.map((w: any) => [w.no === manual.no, w.planned_qty]).sort()).toEqual([[false, 4], [true, 6]]);
    expect(detail.lines[0].planned_qty).toBe(10);
  });

  test('重跑 MRP：已转采购单的量不再建议，后续周已有在途时给“提前催交”例外', async () => {
    const { api } = t;
    const run = await api.as('pmc').ok('post', '/api/mrp/run');
    // 电源适配器：安全库存 50、现有 35 → 本周缺 15（交期紧张，建议下单日 = 今天，到货 = 今天 + 20 天）
    const first = run.suggestions.find((x: any) => x.material_code === 'PSU-24V-5A' && !x.exception);
    expect([first.required_date, first.due_date, first.suggested_qty, first.demand]).toEqual([d(0), d(0), 15, []]);
    const conv = await api.as('pmc').ok('post', '/api/mrp/convert', { suggestion_ids: [first.id] });
    expect(conv.purchase_orders).toHaveLength(1);
    const run2 = await api.as('pmc').ok('post', '/api/mrp/run');
    const sameWeek = run2.suggestions.filter((x: any) => x.material_code === 'PSU-24V-5A' && x.week === first.week);
    expect(sameWeek).toHaveLength(1);
    const exp = sameWeek[0];
    expect([exp.exception, exp.action, exp.suggested_qty, exp.status]).toEqual(['EXPEDITE', 'PURCHASE', first.suggested_qty, 'OPEN']);
    expect(exp.expedite).toEqual([expect.objectContaining({ role: 'expedite', type: 'PO', no: conv.purchase_orders[0], qty: first.suggested_qty, to_date: exp.required_date })]);
    expect(exp.note).toContain(`请将采购单 ${conv.purchase_orders[0]} 的 ${first.suggested_qty}`);
    expect(run2.summary).toMatch(/提前催交 \d+ 条$/);
    // 催交例外不能转单
    const c2 = await api.as('pmc').ok('post', '/api/mrp/convert', { suggestion_ids: [exp.id] });
    expect([c2.purchase_orders, c2.work_orders]).toEqual([[], []]);
    expect(c2.skipped[0]).toContain('提前催交例外，无需新建单据');
  });

  test('离散单位需求取整（不出现小数颗数）', async () => {
    const { api } = t;
    const s = await so('LUM-PO-26-131');
    await api.as('sales').ok('post', `/api/sales-orders/${s.id}/confirm`);
    const run = await api.as('pmc').ok('post', '/api/mrp/run');
    for (const x of run.suggestions.filter((y: any) => y.uom === 'PCS')) {
      expect(Number.isInteger(x.gross_qty)).toBe(true);
      expect(Number.isInteger(x.suggested_qty)).toBe(true);
    }
  });
});

describe('A4 齐套分析（只读）', () => {
  test('工单/订单齐套：需求、可用、缺口、在途采购单、预计齐套日；无副作用；缺料筛选与批量', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const s = await so('GY-2026-0931'); // BL-100 × 10：外壳库存 12、支架 12、包装箱 15，够 10 台
    let k = await api.as('pmc').ok('get', `/api/kitting/sales-orders/${s.id}`);
    expect([k.kitted, k.uncovered.map((u: any) => u.qty)]).toEqual([true, [10]]);
    expect(k.lines.find((l: any) => l.material_code === 'HSG-BL100')).toEqual(expect.objectContaining({ required: 10, available: 10, shortage: 0, stock_total: 12 }));
    // 改为 20 台 → 外壳缺 8；下采购单（供应商回复交期）后显示在途与预计齐套日
    const line = (await api.as('sales').ok('get', `/api/sales-orders/${s.id}`)).lines[0];
    await api.as('sales').ok('post', `/api/sales-orders/${s.id}/change`, { lines: [{ id: line.id, material_id: line.material_id, qty: 20, unit_price: 4200 }], reason: '追加' });
    const sup = await api.find('/api/suppliers', { q: 'S004' });
    const po = await api.as('buyer').ok('post', '/api/purchase-orders', { supplier_id: sup.id, lines: [{ material_id: ref.m['HSG-BL100'], qty: 20, unit_price: 85, expected_date: d(12) }] });
    await api.as('buyer').ok('post', `/api/purchase-orders/${po.id}/approve`);
    await db.base.purchaseOrderLine.update({ where: { id: po.lines[0].id }, data: { promised_date: addDays(today(), 9) } });
    k = await api.as('pmc').ok('get', `/api/kitting/sales-orders/${s.id}`);
    const hsg = k.lines.find((l: any) => l.material_code === 'HSG-BL100');
    expect([hsg.required, hsg.available, hsg.shortage, hsg.eta]).toEqual([20, 12, 8, d(9)]);
    expect(hsg.on_order).toEqual([expect.objectContaining({ type: 'PO', po_id: po.id, po_no: po.no, open_qty: 20, promised_date: d(9), delivery_date: d(12), status: 'APPROVED' })]);
    const stand = k.lines.find((l: any) => l.material_code === 'STAND-BL100');
    expect([stand.shortage, stand.eta, stand.note]).toEqual([8, null, '需采购（可运行 MRP）']);
    expect(k.kitted).toBe(false);

    // 生成工单后：工单齐套（按工单先后分配），列表缺料筛选、批量接口；全程不产生领料单、库存不变
    const stockBefore = await db.base.stock.aggregate({ _sum: { qty: true } });
    const gen = await api.as('pmc').ok('post', `/api/sales-orders/${s.id}/create-work-orders`);
    const wo = await api.as('pmc').find('/api/work-orders', { q: gen.work_orders[0] });
    const wk = await api.as('op1').ok('get', `/api/kitting/work-orders/${wo.id}`);
    expect([wk.applicable, wk.kitted, wk.shortage_count]).toEqual([true, false, k.shortage_count]);
    const batch = await api.as('pmc').ok('get', '/api/kitting/work-orders', { ids: `${wo.id}` });
    expect(batch[wo.id]).toEqual({ kitted: false, shortage_count: k.shortage_count, eta: null });
    const short = await api.as('pmc').ok('get', '/api/kitting/work-order-list', { kitting: 'SHORT' });
    expect(short.items.map((w: any) => w.no)).toEqual([wo.no]);
    expect(short.items[0].kitting.shortages.map((x: any) => x.material_code)).toContain('HSG-BL100');
    expect((await api.as('pmc').ok('get', '/api/kitting/work-order-list', { kitting: 'KITTED' })).items.map((w: any) => w.no)).not.toContain(wo.no);
    expect(await db.base.materialIssue.count()).toBe(0);
    expect((await db.base.stock.aggregate({ _sum: { qty: true } }))._sum.qty).toBe(stockBefore._sum.qty);
    // 订单齐套读权限
    expect((await api.as('op1').get(`/api/kitting/sales-orders/${s.id}`)).status).toBe(403);
  });
});

describe('A9 按交期倒排 / 工单下达后调整', () => {
  test('订单生成工单按交期倒排开工；预览可改数量与日期', async () => {
    const { api } = t;
    const s = await so('GY-2026-0931'); // 交期 +25，BL-100 生产周期 7 天
    const plan = await api.as('pmc').ok('get', `/api/sales-orders/${s.id}/work-order-plan`);
    expect([plan.lines[0].planned_start, plan.lines[0].planned_end, plan.lines[0].tight]).toEqual([d(18), d(25), false]);
    const r = await api.as('pmc').ok('post', `/api/sales-orders/${s.id}/create-work-orders`, {
      lines: [{ so_line_id: plan.lines[0].line_id, qty: 4, planned_start: d(5), planned_end: d(12) }],
    });
    const wo = await api.as('pmc').find('/api/work-orders', { q: r.work_orders[0] });
    expect([wo.planned_qty, wo.planned_start, wo.planned_end, wo.so_id]).toEqual([4, d(5), d(12), s.id]);
    const rest = await api.as('pmc').ok('post', `/api/sales-orders/${s.id}/create-work-orders`);
    const wo2 = await api.as('pmc').find('/api/work-orders', { q: rest.work_orders[0] });
    expect([wo2.planned_qty, wo2.planned_start, wo2.planned_end]).toEqual([6, d(18), d(25)]);
  });

  test('已下达工单调整未开工部分：数量下限、作废/补发序列号、重算用料、原因留痕', async () => {
    const { api } = t;
    const s = await so('LUM-PO-26-118');
    const gen = await api.as('pmc').ok('post', `/api/sales-orders/${s.id}/create-work-orders`);
    let wo = await api.as('pmc').find('/api/work-orders', { q: gen.work_orders[0] });
    expect((await api.as('pmc').post(`/api/work-orders/${wo.id}/adjust`, { planned_qty: 5, reason: 'x' })).body.detail).toBe('计划状态的工单请直接【修改】，不需要走调整');
    await api.as('pmc').ok('put', `/api/work-orders/${wo.id}`, { material_id: wo.material_id, planned_qty: 4 });
    wo = await api.as('pmc').ok('post', `/api/work-orders/${wo.id}/release`);
    const sns = (await api.as('pmc').ok('get', `/api/work-orders/${wo.id}/serials`)).map((x: any) => x.sn);
    expect(sns).toHaveLength(4);
    // 模拟第一台已过站（已开工）、灯板已领 4 个
    await t.db.base.serialNumber.update({ where: { sn: sns[0] }, data: { status: 'IN_PROCESS', last_seq: 10 } });
    await t.db.base.workOrder.update({ where: { id: wo.id }, data: { status: 'IN_PROGRESS' } });
    const saMat = await t.db.base.workOrderMaterial.findFirstOrThrow({ where: { wo_id: wo.id, material: { code: 'SA-RL300-LB' } } });
    await t.db.base.workOrderMaterial.update({ where: { id: saMat.id }, data: { issued_qty: 4 } });
    const info = await api.as('pmc').ok('get', `/api/work-orders/${wo.id}/adjust-info`);
    expect([info.adjustable, info.started, info.min_qty, info.unstarted_serials]).toEqual([true, 1, 1, 3]);
    expect((await api.as('op1').post(`/api/work-orders/${wo.id}/adjust`, { planned_qty: 3, reason: 'x' })).status).toBe(403);
    // 预览不保存；没有原因不能保存
    const pv = await api.as('pmc').ok('post', `/api/work-orders/${wo.id}/adjust`, { planned_qty: 2, planned_end: d(30), preview: true });
    expect(pv.changes).toEqual(['数量 4 → 2', `计划完工 ${d(20)} → ${d(30)}`, '作废未开工序列号 2 个']);
    expect(pv.warnings.some((w: string) => w.includes('请办理生产退料'))).toBe(true);
    expect((await api.as('pmc').post(`/api/work-orders/${wo.id}/adjust`, { planned_qty: 2 })).body.detail).toContain('请填写调整原因');
    const r = await api.as('pmc').ok('post', `/api/work-orders/${wo.id}/adjust`, { planned_qty: 2, planned_end: d(30), reason: '客户减量' });
    expect([r.work_order.planned_qty, r.work_order.planned_end]).toEqual([2, d(30)]);
    expect(r.work_order.materials.find((m: any) => m.material_code === 'SA-RL300-LB').required_qty).toBe(2);
    const after = await api.as('pmc').ok('get', `/api/work-orders/${wo.id}/serials`);
    expect(after.filter((x: any) => x.status === 'SCRAPPED').map((x: any) => x.sn)).toEqual([sns[2], sns[3]]);
    expect(await reasons('mes_work_order', wo.id)).toEqual([`工单调整：数量 4 → 2；计划完工 ${d(20)} → ${d(30)}；作废未开工序列号 2 个。原因：客户减量`]);
    // 不能少于已开工；调增补发序列号（同批号）
    expect((await api.as('pmc').post(`/api/work-orders/${wo.id}/adjust`, { planned_qty: 0.5, reason: 'x' })).body.detail).toBe('序列号管理的产品，工单数量必须为整数');
    const up = await api.as('pmc').ok('post', `/api/work-orders/${wo.id}/adjust`, { planned_qty: 3, reason: '补 1 台' });
    expect(up.work_order.planned_qty).toBe(3);
    const live = (await api.as('pmc').ok('get', `/api/work-orders/${wo.id}/serials`)).filter((x: any) => x.status !== 'SCRAPPED');
    expect(live).toHaveLength(3);
    expect(live.every((x: any) => x.lot_no === wo.lot_no && x.udi?.includes(`(10)${wo.lot_no}`))).toBe(true);
  });
});

describe('A11/A13 录单辅助、销售订单权限', () => {
  test('同客户 PO 号重复提示；上次成交价；销售可建客户', async () => {
    const { api } = t;
    const ref = await api.ids();
    const c1 = await api.find('/api/customers', { q: 'C001' });
    const dup = await api.as('sales').ok('get', '/api/sales-orders/check-po', { customer_id: c1.id, customer_po: 'lum-po-26-118' });
    expect(dup.map((x: any) => x.customer_po)).toEqual(['LUM-PO-26-118']);
    const s = await so('LUM-PO-26-118');
    expect(await api.as('sales').ok('get', '/api/sales-orders/check-po', { customer_id: c1.id, customer_po: 'LUM-PO-26-118', exclude_id: s.id })).toEqual([]);
    const lp = await api.as('sales').ok('get', '/api/sales-orders/last-prices', { customer_id: c1.id, material_ids: `${ref.m['FG-RL300']}` });
    expect(lp[ref.m['FG-RL300']]).toEqual(expect.objectContaining({ unit_price: 88, currency: 'USD', so_no: s.no })); // 草稿 131 单不算成交
    // 销售可直接新建客户；仓库不行
    const c = await api.as('sales').ok('post', '/api/customers', { code: 'C900', name: 'Aurora Wellness GmbH', currency: 'EUR' });
    expect(c.code).toBe('C900');
    expect((await api.as('wh').post('/api/customers', { code: 'C901', name: 'x' })).status).toBe(403);
  });

  test('销售订单读权限：销售/计划/仓库/财务/QA 可看；仓库看不到金额；管理员与操作员不可看', async () => {
    const { api } = t;
    const s = await so('LUM-PO-26-118');
    for (const u of ['sales', 'pmc', 'wh', 'finance', 'qa', 'manager']) expect((await api.as(u).get(`/api/sales-orders/${s.id}`)).status).toBe(200);
    for (const u of ['admin', 'op1', 'engineer']) expect((await api.as(u).get('/api/sales-orders')).status).toBe(403);
    const wh = await api.as('wh').ok('get', `/api/sales-orders/${s.id}`);
    expect([wh.total_amount, wh.lines[0].unit_price, wh.lines[0].amount, wh.lines[0].qty]).toEqual([null, null, null, 20]);
    expect((await api.as('finance').ok('get', '/api/sales-orders')).items.find((x: any) => x.id === s.id).total_amount).toBe(1760);
  });
});
