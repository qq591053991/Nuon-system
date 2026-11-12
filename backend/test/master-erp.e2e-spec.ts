/**
 * 主数据/工程（BOM、工艺、设备校准）、ERP（销售、采购、MRP、财务）、数据导入。
 * 移植自 backend/tests/test_master_engineering.py、test_supply_chain.py，并补充修复项的用例。
 */
import ExcelJS from 'exceljs';
import { addDays, fmtDate, today } from '../src/common/dates';
import { bootApp, SIG } from './harness';

async function xlsx(rows: (string | number | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('主数据与工程数据', () => {
  let t: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => (t = await bootApp()));
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  test('BOM 生命周期与审计（test_bom_lifecycle_and_audit）', async () => {
    const { api } = t;
    const ref = await api.ids();
    let bom = await api.as('engineer').ok('post', '/api/boms', {
      material_id: ref.m['FG-BL100'], version: 'A1',
      lines: [{ component_id: ref.m['LED-460-5050'], qty_per: 48 }, { component_id: ref.m['PCB-AL-BL100'], qty_per: 1 }],
    });
    expect(bom.status).toBe('DRAFT');
    expect(bom.material_code).toBe('FG-BL100');
    expect(bom.lines.map((l: any) => [l.line_no, l.component_code])).toEqual([[10, 'LED-460-5050'], [20, 'PCB-AL-BL100']]);
    // 自引用
    let r = await api.as('engineer').put(`/api/boms/${bom.id}`, {
      material_id: ref.m['FG-BL100'], version: 'A1', lines: [{ component_id: ref.m['FG-BL100'], qty_per: 1 }],
    });
    expect(r.status).toBe(400);
    expect(r.body.detail).toBe('BOM 组件不能是父项自身');
    // 工程师提交需要电子签名（编制）；首版之后的版本须填写变更原因
    r = await api.as('engineer').post(`/api/boms/${bom.id}/submit`, { signature: { password: 'bad' }, change_reason: '更换 LED 供应商' });
    expect(r.status).toBe(400);
    r = await api.as('engineer').post(`/api/boms/${bom.id}/submit`, { signature: SIG });
    expect(r.body.detail).toContain('变更原因');
    bom = await api.as('engineer').ok('post', `/api/boms/${bom.id}/submit`, { signature: SIG, change_reason: '更换 LED 供应商' });
    expect([bom.status, bom.submitted_by, bom.change_reason]).toEqual(['SUBMITTED', '吴工艺', '更换 LED 供应商']);
    // 待批准状态只读；工程师、厂长都不能批准（质量签名只限 QA）
    r = await api.as('engineer').put(`/api/boms/${bom.id}`, { material_id: ref.m['FG-BL100'], version: 'A1', lines: [] });
    expect(r.body.detail).toContain('待 QA 批准');
    expect((await api.as('engineer').post(`/api/boms/${bom.id}/approve`, { signature: SIG })).status).toBe(403);
    expect((await api.as('manager').post(`/api/boms/${bom.id}/approve`, { signature: SIG })).status).toBe(403);
    bom = await api.as('qa').ok('post', `/api/boms/${bom.id}/approve`, { signature: SIG });
    expect(bom.status).toBe('RELEASED');
    expect(bom.released_by).toBe('赵QA');
    expect(bom.effective_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const old = (await api.ok('get', '/api/boms', { material_id: ref.m['FG-BL100'], status: 'OBSOLETE' })).items;
    expect(old.length).toBeGreaterThan(0);
    expect(old[0].version).toBe('A0');
    // 发布后不可修改，只能升版
    r = await api.as('engineer').put(`/api/boms/${bom.id}`, { material_id: ref.m['FG-BL100'], version: 'A1', lines: [] });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('升版');
    const nb = await api.as('engineer').ok('post', `/api/boms/${bom.id}/new-version`, { version: 'A2', ecn_no: 'ECN-001' });
    expect(nb.status).toBe('DRAFT');
    expect(nb.lines).toHaveLength(2);
    // 多级展开
    const rl = await api.find('/api/boms', { material_id: ref.m['FG-RL300'], status: 'RELEASED' });
    const tree = (await api.ok('get', `/api/boms/${rl.id}/tree`, { qty: 10 })).tree;
    const lb = tree.find((n: any) => n.code === 'SA-RL300-LB');
    const led = lb.children.find((n: any) => n.code === 'LED-660-3030');
    expect(led.total_qty).toBe(606.0); // 10 × 60 × 1.01
    expect(led.level).toBe(2);
    expect(tree.find((n: any) => n.code === 'PKG-RL300-BOX').customer_supplied).toBe(true);
    // 审计追踪 + 电子签名
    const logs = (await api.ok('get', '/api/system/audit-logs', { entity: 'eng_bom', entity_id: bom.id })).items;
    const actions = new Set(logs.map((l: any) => l.action));
    expect(actions.has('CREATE') && actions.has('UPDATE')).toBe(true);
    expect([...new Set(logs.map((l: any) => l.username))].sort()).toEqual(['engineer', 'qa']);
    const sigs = (await api.ok('get', '/api/system/esignatures', { entity: 'eng_bom' })).items;
    expect(sigs.map((x: any) => [x.meaning, x.username])).toEqual([['BOM批准', 'qa'], ['BOM编制提交', 'engineer']]);
    expect(sigs[0].doc_no).toBe('FG-BL100 A1');
    // 草稿可删除，已发布不可删除
    expect((await api.as('engineer').del(`/api/boms/${bom.id}`)).body.detail).toBe('只能删除草稿');
    await api.as('engineer').ok('delete', `/api/boms/${nb.id}`);
  });

  test('工艺路线升版/修改/发布（不依赖 MES）', async () => {
    const { api } = t;
    const ref = await api.ids();
    const rt = await api.find('/api/routings', { material_id: ref.m['FG-BL100'], status: 'RELEASED' });
    const nr = await api.as('engineer').ok('post', `/api/routings/${rt.id}/new-version`, { version: 'A1' });
    expect(nr.status).toBe('DRAFT');
    const ops = (await api.ok('get', `/api/routings/${nr.id}`)).operations;
    expect(ops[1].params[0].upper).toBe(470);
    ops[1].params[0].upper = 999;
    // 下限大于上限
    const bad = structuredClone(ops);
    bad[1].params[0].lower = 1000;
    let r = await api.as('engineer').put(`/api/routings/${nr.id}`, { material_id: ref.m['FG-BL100'], version: 'A1', operations: bad });
    expect(r.status).toBe(400);
    expect(r.body.detail).toBe('工序 光学性能测试 测试项 峰值波长 下限大于上限');
    r = await api.as('engineer').put(`/api/routings/${nr.id}`, { material_id: ref.m['FG-BL100'], version: 'A1', operations: [ops[0], { ...ops[1], seq: ops[0].seq }] });
    expect(r.body.detail).toBe('工序号重复');
    const saved = await api.as('engineer').ok('put', `/api/routings/${nr.id}`, { material_id: ref.m['FG-BL100'], version: 'A1', operations: ops });
    expect(saved.operations[1].params[0].upper).toBe(999);
    expect(saved.operations[1].work_center_name).toBe('光学测试区');
    r = await api.as('engineer').post(`/api/routings/${nr.id}/submit`, {});
    expect(r.body.detail).toContain('变更原因');
    r = await api.as('engineer').post(`/api/routings/${nr.id}/submit`, { change_reason: '光学测试上限放宽（ECN-002）' });
    expect(r.body.detail).toBe('此操作需要电子签名（工艺路线编制提交），请输入密码确认');
    const sub = await api.as('engineer').ok('post', `/api/routings/${nr.id}/submit`, { signature: SIG, change_reason: '光学测试上限放宽（ECN-002）' });
    expect(sub.status).toBe('SUBMITTED');
    expect((await api.ok('get', `/api/routings/${rt.id}`)).status).toBe('RELEASED'); // 批准前旧版本仍生效
    const rel = await api.as('qa').ok('post', `/api/routings/${nr.id}/approve`, { signature: SIG });
    expect(rel.status).toBe('RELEASED');
    expect((await api.ok('get', `/api/routings/${rt.id}`)).status).toBe('OBSOLETE');
    r = await api.as('engineer').put(`/api/routings/${nr.id}`, { material_id: ref.m['FG-BL100'], version: 'A1', operations: ops });
    expect(r.body.detail).toBe('已发布的工艺路线不能修改，请升版');
    expect((await api.as('engineer').post(`/api/routings/${nr.id}/new-version`, { version: 'A0' })).body.detail).toBe('版本号已存在');
    const sig = (await api.ok('get', '/api/system/esignatures', { entity: 'eng_routing' })).items[0];
    expect(sig.meaning).toBe('工艺路线批准');
  });

  test('工艺发布不影响已下达工单的快照（test_routing_release_and_wo_snapshot，依赖 MES 工单接口）', async () => {
    const { api } = t;
    const ref = await api.ids();
    const rt = await api.find('/api/routings', { material_id: ref.m['FG-BL100'], status: 'RELEASED' });
    let wo = await api.as('pmc').ok('post', '/api/work-orders', { material_id: ref.m['FG-BL100'], planned_qty: 2 });
    wo = await api.as('pmc').ok('post', `/api/work-orders/${wo.id}/release`);
    const nr = await api.as('engineer').ok('post', `/api/routings/${rt.id}/new-version`, { version: 'A1' });
    const ops = (await api.ok('get', `/api/routings/${nr.id}`)).operations;
    ops[1].params[0].upper = 999;
    await api.as('engineer').ok('put', `/api/routings/${nr.id}`, { material_id: ref.m['FG-BL100'], version: 'A1', operations: ops });
    await api.as('engineer').ok('post', `/api/routings/${nr.id}/submit`, { signature: SIG, change_reason: '放宽上限' });
    await api.as('qa').ok('post', `/api/routings/${nr.id}/approve`, { signature: SIG });
    // 已下达工单的工序规格是快照，不受新版本影响
    wo = await api.ok('get', `/api/work-orders/${wo.id}`);
    expect(wo.operations[1].params[0].upper).toBe(470);
  });

  test('校准记录更新设备（test_calibration_record_updates_equipment）', async () => {
    const { api } = t;
    const ref = await api.ids();
    const eid = ref.eq['EQ-SPEC-02'];
    expect((await api.as('op1').post(`/api/equipment/${eid}/calibrations`, { calibration_date: '2026-11-01' })).status).toBe(403);
    const rec = await api.as('qa').ok('post', `/api/equipment/${eid}/calibrations`, { calibration_date: '2026-11-01', certificate_no: 'CAL-001' });
    expect(rec.result).toBe('PASS');
    expect(rec.next_due_date).toBe('2027-11-01');
    let eq = await api.ok('get', `/api/equipment/${eid}`);
    expect(eq.next_calibration_date).toBe('2027-11-01');
    expect(eq.last_calibration_date).toBe('2026-11-01');
    await api.as('qa').ok('post', `/api/equipment/${eid}/calibrations`, { calibration_date: '2026-11-02', result: 'FAIL' });
    expect((await api.ok('get', `/api/equipment/${eid}`)).status).toBe('DISABLED');
    // 重新校准合格后恢复
    await api.as('qa').ok('post', `/api/equipment/${eid}/calibrations`, { calibration_date: '2026-11-03', next_due_date: '2027-06-30' });
    eq = await api.ok('get', `/api/equipment/${eid}`);
    expect([eq.status, eq.next_calibration_date]).toEqual(['NORMAL', '2027-06-30']);
    const rows = await api.ok('get', `/api/equipment/${eid}/calibrations`);
    expect(rows.map((x: any) => x.calibration_date)).toEqual(['2026-11-03', '2026-11-02', '2026-11-01']);
  });
});

describe('ERP：销售、采购、MRP、财务', () => {
  let t: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => (t = await bootApp()));
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  const po = async (supplierCode: string, materialId: number, qty = 1000, price = 0.35) => {
    const sup = await t.api.find('/api/suppliers', { q: supplierCode });
    return t.api.as('buyer').ok('post', '/api/purchase-orders', { supplier_id: sup.id, lines: [{ material_id: materialId, qty, unit_price: price }] });
  };

  test('采购需合格供方、客供料不能采购（test_po_requires_qualified_supplier）', async () => {
    const { api } = t;
    const ref = await api.ids();
    const p = await po('S006', ref.m['LED-660-3030']);
    expect(p.total_amount).toBe(350);
    let r = await api.as('buyer').post(`/api/purchase-orders/${p.id}/approve`);
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('合格供方');
    expect(r.body.detail).toBe('供应商【新锐光电有限公司】当前为“待评审”，不在合格供方名录内，采购订单不能审批（GMP 采购控制）。请联系质量部完成供应商评审，评为“合格供方”后再审批；急用可改选其他合格供应商。'); // G4：中文状态 + 找质量部
    // 客供料不能采购
    const sup = await api.find('/api/suppliers', { q: 'S005' });
    r = await api.as('buyer').post('/api/purchase-orders', { supplier_id: sup.id, lines: [{ material_id: ref.m['PKG-RL300-BOX'], qty: 10 }] });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('客供料');
    // 合格供方可审批；审批后不能修改，可关闭
    const ok = await po('S001', ref.m['LED-660-3030']);
    const ap = await api.as('buyer').ok('post', `/api/purchase-orders/${ok.id}/approve`);
    expect([ap.status, ap.approved_by]).toEqual(['APPROVED', '陈采购']);
    expect((await api.as('buyer').put(`/api/purchase-orders/${ok.id}`, { supplier_id: ok.supplier_id, lines: [] })).body.detail).toBe('只有草稿状态可以修改');
    expect((await api.as('sales').post(`/api/purchase-orders/${ok.id}/close`)).status).toBe(403);
    expect((await api.as('buyer').ok('post', `/api/purchase-orders/${ok.id}/close`)).status).toBe('CLOSED');
  });

  test('MRP 运算与转单（test_mrp_and_convert）', async () => {
    const { api } = t;
    const so = await api.as('sales').find('/api/sales-orders', { q: 'LUM-PO-26-131' }); // 200 台草稿
    await api.as('sales').ok('post', `/api/sales-orders/${so.id}/confirm`);
    const run = await api.as('pmc').ok('post', '/api/mrp/run');
    const by: Record<string, any> = {};
    for (const s of run.suggestions) by[s.material_code] = s;
    expect(by['FG-RL300'].action).toBe('PRODUCE');
    expect(by['SA-RL300-LB'].action).toBe('PRODUCE');
    expect(by['SA-RL300-LB'].level).toBeGreaterThan(by['FG-RL300'].level);
    expect(by['LED-660-3030'].action).toBe('PURCHASE'); // 灯板的下层物料
    expect(by['PKG-RL300-BOX'].action).toBe('CUSTOMER_SUPPLY');
    // 安全库存计入：LED 净需求 = 毛需求 + 安全库存 − 库存 − 在途
    const led = by['LED-660-3030'];
    expect(led.net_qty).toBe(Math.round((led.gross_qty + led.safety_stock - led.on_hand_qty - led.on_order_qty) * 1e4) / 1e4);
    expect(run.summary).toMatch(/^生产建议 \d+ 条，采购建议 \d+ 条，客供料通知 \d+ 条$/);
    const levels = run.suggestions.map((s: any) => s.level);
    expect(levels).toEqual([...levels].sort((a: number, b: number) => a - b));
    const res = await api.as('pmc').ok('post', '/api/mrp/convert', { suggestion_ids: [led.id, by['FG-RL300'].id, by['PKG-RL300-BOX'].id] });
    expect(res.purchase_orders).toHaveLength(1);
    expect(res.work_orders).toHaveLength(1);
    expect(res.skipped.length).toBeGreaterThan(0);
    const p = await api.as('pmc').find('/api/purchase-orders', { q: res.purchase_orders[0] }); // G4：采购单 GET 需采购/计划等读权限
    expect([p.status, p.source]).toEqual(['DRAFT', 'MRP']);
    expect(p.lines[0].qty).toBe(led.suggested_qty);
    const again = await api.ok('get', `/api/mrp/runs/${run.id}`);
    const conv = again.suggestions.find((s: any) => s.id === led.id);
    expect([conv.status, conv.converted_doc_no]).toEqual(['CONVERTED', res.purchase_orders[0]]);
    expect((await api.ok('get', '/api/mrp/runs')).items[0].id).toBe(run.id);
    const ign = await api.as('pmc').ok('post', `/api/mrp/suggestions/${by['PKG-RL300-BOX'].id}/ignore`);
    expect(ign.status).toBe('IGNORED');
  });

  test('销售订单：校验、生成工单、取消保护', async () => {
    const { api } = t;
    const ref = await api.ids();
    const c2 = await api.find('/api/customers', { q: 'C002' });
    let r = await api.as('sales').post('/api/sales-orders', { customer_id: c2.id, lines: [{ material_id: ref.m['FG-RL300'], qty: 1 }] });
    expect(r.body.detail).toBe('FG-RL300 是其他品牌客户的产品（代工产品只能卖给注册人/品牌方）');
    r = await api.as('sales').post('/api/sales-orders', { customer_id: c2.id, lines: [{ material_id: ref.m['LED-660-3030'], qty: 1 }] });
    expect(r.body.detail).toBe('LED-660-3030 不是成品/半成品，不能销售');
    r = await api.as('sales').post('/api/sales-orders', { customer_id: c2.id, lines: [] });
    expect(r.body.detail).toBe('请至少录入一行订单明细');
    const so = await api.as('sales').find('/api/sales-orders', { q: 'LUM-PO-26-118' }); // 已确认 20 台
    expect(so.customer_name).toBe('Lumina Health Inc.');
    expect((await api.as('sales').post(`/api/sales-orders/${so.id}/create-work-orders`)).status).toBe(403);
    const res = await api.as('pmc').ok('post', `/api/sales-orders/${so.id}/create-work-orders`);
    expect(res.work_orders).toHaveLength(1);
    expect(res.skipped).toEqual([]);
    expect((await api.as('pmc').ok('post', `/api/sales-orders/${so.id}/create-work-orders`)).work_orders).toEqual([]);
    const d = await api.as('sales').ok('get', `/api/sales-orders/${so.id}`);
    expect(d.status).toBe('IN_PRODUCTION');
    expect(d.work_orders).toHaveLength(1);
    expect([d.work_orders[0].planned_qty, d.work_orders[0].so_no, d.work_orders[0].source]).toEqual([20, so.no, so.no]);
    expect(d.shipments).toEqual([]);
    expect((await api.as('sales').post(`/api/sales-orders/${so.id}/cancel`)).body.detail).toMatch(/^订单已有生产工单（WO\d+），请先取消工单；如只是改数量\/交期，请用【变更】$/);
    const list = await api.as('sales').ok('get', '/api/sales-orders', { status: 'IN_PRODUCTION,DRAFT' });
    expect(list.items.map((x: any) => x.status).sort()).toEqual(['DRAFT', 'IN_PRODUCTION']);
  });

  test('修改草稿时显式 null 清空可选字段，未传字段保持不变（修复 Python 版忽略 None 的问题）', async () => {
    const { api } = t;
    const ref = await api.ids();
    const c1 = await api.find('/api/customers', { q: 'C001' });
    const lines = [{ material_id: ref.m['FG-RL300'], qty: 5, unit_price: 80 }];
    let so = await api.as('sales').ok('post', '/api/sales-orders', {
      customer_id: c1.id, customer_po: 'PO-X', remark: '加急', ship_to: '洛杉矶', delivery_date: '2026-12-31', currency: 'USD', lines,
    });
    expect([so.customer_po, so.remark, so.ship_to, so.delivery_date, so.currency, so.total_amount]).toEqual(['PO-X', '加急', '洛杉矶', '2026-12-31', 'USD', 400]);
    so = await api.as('sales').ok('put', `/api/sales-orders/${so.id}`, {
      customer_id: c1.id, customer_po: null, remark: null, ship_to: null, delivery_date: null, lines,
    });
    expect([so.customer_po, so.remark, so.ship_to, so.delivery_date]).toEqual([null, null, null, null]);
    expect(so.currency).toBe('USD'); // 未传 → 不变
    so = await api.as('sales').ok('put', `/api/sales-orders/${so.id}`, { customer_id: c1.id, remark: '改', lines });
    so = await api.as('sales').ok('put', `/api/sales-orders/${so.id}`, { customer_id: c1.id, lines: [{ ...lines[0], qty: 6 }] });
    expect([so.remark, so.total_amount, so.lines[0].amount]).toEqual(['改', 480, 480]);
    const logs = (await api.ok('get', '/api/system/audit-logs', { entity: 'erp_sales_order', entity_id: so.id, action: 'UPDATE' })).items;
    expect(logs.some((l: any) => JSON.parse(l.changes).customer_po?.[0] === 'PO-X')).toBe(true);

    const sup = await api.find('/api/suppliers', { q: 'S001' });
    const pl = [{ material_id: ref.m['LED-660-3030'], qty: 1000, unit_price: 0.35, expected_date: '2026-12-01' }];
    let p = await api.as('buyer').ok('post', '/api/purchase-orders', { supplier_id: sup.id, remark: '备注', expected_date: '2026-12-15', lines: pl });
    expect([p.remark, p.expected_date, p.currency]).toEqual(['备注', '2026-12-15', 'CNY']);
    p = await api.as('buyer').ok('put', `/api/purchase-orders/${p.id}`, { supplier_id: sup.id, remark: null, expected_date: null, lines: pl });
    expect([p.remark, p.expected_date, p.order_date]).toEqual([null, null, fmtDate(today())]);
    expect(p.lines[0].expected_date).toBe('2026-12-01');
  });

  test('收付款与账龄汇总', async () => {
    const { api, db } = t;
    const s1 = await api.find('/api/suppliers', { q: 'S001' });
    const doc = await db.base.financeDoc.create({
      data: { no: 'AP-TEST-1', doc_type: 'AP', supplier_id: s1.id, ref_no: 'RK-1', doc_date: addDays(today(), -60), due_date: addDays(today(), -40), amount: 1000 },
    });
    let sum = await api.as('finance').ok('get', '/api/finance/summary'); // G4：财务数据 GET 需 finance 权限
    // 评审 P0-3：账龄按往来单位 + 币别分行，并给出本位币折算（total_base）
    expect(sum.AP).toEqual([{ partner: s1.name, currency: 'CNY', 未到期: 0, '1-30天': 0, '31-90天': 1000, '90天以上': 0, total: 1000, total_base: 1000 }]);
    expect(sum.AR).toEqual([]);
    expect((await api.as('buyer').post(`/api/finance/docs/${doc.id}/payments`, { amount: 1 })).status).toBe(403);
    let d = await api.as('finance').ok('post', `/api/finance/docs/${doc.id}/payments`, { amount: 300, reference: 'BANK-1' });
    expect([d.status, d.paid_amount, d.balance, d.partner_name]).toEqual(['PARTIAL', 300, 700, s1.name]);
    expect([d.payments[0].method, d.payments[0].pay_date]).toEqual(['银行转账', fmtDate(today())]);
    const r = await api.as('finance').post(`/api/finance/docs/${doc.id}/payments`, { amount: 800 });
    expect(r.body.detail).toBe('金额超过未结余额 700.00（超出 100.00）。如供应商多付，请选择“超出部分转预付款”'); // G4：超额提示转预付
    d = await api.as('finance').ok('post', `/api/finance/docs/${doc.id}/payments`, { amount: 700, method: null, pay_date: '2026-11-01' });
    expect([d.status, d.payments.length, d.payments[1].method, d.payments[1].pay_date]).toEqual(['PAID', 2, null, '2026-11-01']);
    sum = await api.as('finance').ok('get', '/api/finance/summary');
    expect(sum.AP).toEqual([]);
    const list = await api.as('finance').ok('get', '/api/finance/docs', { doc_type: 'AP', q: 'RK-1' });
    expect(list.items).toHaveLength(1);
    expect(list.items[0].payments).toHaveLength(2);
  });

  test('采购收货（依赖 WmsService.receive）', async () => {
    const { api } = t;
    const ref = await api.ids();
    const p = await po('S001', ref.m['LED-850-3030'], 1000, 0.42);
    expect((await api.as('wh').post(`/api/purchase-orders/${p.id}/receive`, { lines: [{ po_line_id: p.lines[0].id, qty: 10, location_id: ref.loc['DRY-01'] }] })).body.detail)
      .toBe('采购订单未审批或已完结，不能收货');
    await api.as('buyer').ok('post', `/api/purchase-orders/${p.id}/approve`);
    const rc = await api.as('wh').ok('post', `/api/purchase-orders/${p.id}/receive`, {
      delivery_note: 'DN-1', lines: [{ po_line_id: p.lines[0].id, qty: 1000, location_id: ref.loc['DRY-01'], lot_no: 'NEW-850' }],
    });
    expect(rc.lines[0].status).toBe('QUARANTINE');
    expect(rc.po_no).toBe(p.no);
    const d = await api.as('buyer').ok('get', `/api/purchase-orders/${p.id}`); // G4：采购单 GET 需读权限
    expect(d.status).toBe('RECEIVED');
    expect(d.receipts).toHaveLength(1);
    expect((await api.as('buyer').post(`/api/purchase-orders/${p.id}/cancel`)).body.detail).toBe('已收货的订单不能取消，请使用“关闭”');
  });
});

describe('数据导入', () => {
  let t: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => (t = await bootApp()));
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  test('金蝶物料导出导入（test_import_materials_from_kingdee_excel）', async () => {
    const { api } = t;
    let r = await api.as('engineer').upload('/api/import/materials', 'materials.xlsx', await xlsx([
      ['物料列表（金蝶K/3 Cloud 导出）'], // 顶部标题行应被跳过
      ['编码', '名称', '规格型号', '物料属性', '基本单位', '安全库存', '默认供应商'],
      ['LED-630-2835', '红光LED 630nm', '2835 0.2W', '外购', 'PCS', 1000, 'S001'],
      ['FG-MASK-M1', 'LED面罩 M1', '三色光 硅胶', '成品', '台', 0, null],
    ]));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, created: 2, updated: 0, errors: [] });
    const m = await api.find('/api/materials', { q: 'LED-630-2835' });
    expect(m.category).toBe('RAW');
    expect(m.safety_stock).toBe(1000);
    expect(m.default_supplier_name.startsWith('晶光')).toBe(true);

    const csv = '物料编码,物料名称,物料类别\nLED-630-2835,红光LED 630nm 改,原材料\nBAD-1,坏数据,未知类别\n';
    r = await api.as('engineer').upload('/api/import/materials', 'm.csv', Buffer.from(csv));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.errors).toEqual([{ row: 3, message: '无法识别的物料类别：未知类别（可选：原材料、半成品、成品、包材、辅料；金蝶的 外购/委外/自制 也可识别）' }]); // 有错误时整体回滚；报错列出可选值（G2 E-25）
    expect(r.body.message).toBe('发现 1 行错误，已全部回滚，请修正后重新导入');
    expect((await api.find('/api/materials', { q: 'LED-630-2835' })).name).toBe('红光LED 630nm');
    const tpl = await api.as('engineer').get('/api/import/templates/boms');
    expect(tpl.status).toBe(200);
    expect(tpl.headers['content-type']).toContain('spreadsheetml');
    expect((await api.as('engineer').get('/api/import/templates/nope')).body.detail).toBe('不支持的导入类型');
    expect((await api.as('op1').upload('/api/import/materials', 'm.csv', Buffer.from(csv))).status).toBe(403);
    // 带 BOM 的 UTF-8 CSV 更新已有物料
    r = await api.as('engineer').upload('/api/import/materials', 'm.csv', Buffer.from('﻿物料编码,物料名称,安全库存\r\nLED-630-2835,红光LED 630nm 改,"1,500"\r\n'));
    expect(r.body).toEqual({ ok: true, created: 0, updated: 1, errors: [] });
    expect((await api.find('/api/materials', { q: 'LED-630-2835' })).safety_stock).toBe(1500);
  });

  test('BOM 导入（test_import_bom_and_opening_stock 前半部分）', async () => {
    const { api } = t;
    expect((await api.as('engineer').post('/api/import/materials')).body.detail).toBe('请选择要导入的文件');
    let r = await api.as('engineer').upload('/api/import/materials', 'm.xlsx', await xlsx([['物料编码', '物料名称', '物料类别'], ['FG-MASK-M1', 'LED面罩 M1', '成品']]));
    expect(r.body.ok).toBe(true);
    r = await api.as('engineer').upload('/api/import/boms', 'data.xlsx', await xlsx([
      ['父项物料编码', 'BOM版本', '子项物料编码', '用量:分子', '用量:分母', '损耗率(%)', '位号'],
      ['FG-MASK-M1', 'A0', 'LED-660-3030', 120, 1, 2, 'D1-D120'],
      ['FG-MASK-M1', 'A0', 'SCREW-M3X8', 1, 2, 0, null],
    ]));
    expect(r.body.created).toBe(1);
    const bom = await api.find('/api/boms', { q: 'FG-MASK-M1' });
    const detail = await api.ok('get', `/api/boms/${bom.id}`);
    expect(detail.status).toBe('DRAFT'); // 导入的 BOM 需工程师审核后发布
    const lines: Record<string, any> = {};
    for (const l of detail.lines) lines[l.component_code] = l;
    expect(lines['LED-660-3030'].scrap_rate).toBe(0.02);
    expect(lines['LED-660-3030'].designator).toBe('D1-D120');
    expect(lines['SCREW-M3X8'].qty_per).toBe(0.5);
    // 重复导入同版本 BOM 被拒（受控文件不允许覆盖）
    r = await api.as('engineer').upload('/api/import/boms', 'data.xlsx', await xlsx([['父项物料编码', 'BOM版本', '子项物料编码', '用量'], ['FG-MASK-M1', 'A0', 'LED-660-3030', 1]]));
    expect(r.body.ok).toBe(false);
    expect(r.body.errors[0].message).toContain('已存在');

    r = await api.as('wh').upload('/api/import/stock', 'data.xlsx', await xlsx([
      ['物料编码', '库位编码', '批号', '数量', '生产日期', '有效期至'],
      ['LED-630-X', 'RAW-A01', 'L1', 10, null, null],
      ['LED-660-3030', 'NOPE', 'L2', 10, null, null],
      ['LED-660-3030', 'RAW-A01', 'L3', 0, null, null],
      ['LED-660-3030', 'RAW-A01', 'L4', 5, '2026-13-45x', null],
    ]));
    expect(r.body.ok).toBe(false);
    expect(r.body.errors).toEqual([
      { row: 2, message: '物料 LED-630-X 不存在（请先导入物料，或核对编码与物料主数据是否完全一致）' }, // G2 E-25：报错说明怎么改、列出可选库位
      { row: 3, message: '库位 NOPE 不存在（现有库位：CS-01、DRY-01、FG-01、FG-02、LINE-01、RAW-A01、RAW-A02、REJ-01；新库位请先在“基础资料 → 库位”中建立）' },
      { row: 4, message: '数量必须大于 0' },
      { row: 5, message: '日期格式错误：2026-13-45x' },
    ]);
  }, 60000);

  test('期初库存导入（test_import_bom_and_opening_stock 后半部分，依赖 WmsService.receive 与库存查询接口）', async () => {
    const { api } = t;
    const res = await api.as('wh').upload('/api/import/stock', 'data.xlsx', await xlsx([
      ['物料编码', '库位编码', '批号', '数量', '生产日期', '有效期至'],
      ['LED-660-3030', 'DRY-01', 'KD-OPEN-1', 800, '2026-10-01', '2027-10-01'],
      ['PKG-RL300-IFU', 'CS-01', 'KD-IFU-1', 30, null, null],
    ]));
    expect(res.body).toMatchObject({ ok: true, created: 2, updated: 0, errors: [], duplicates: [] }); // G2 E-01：另返回导入批次号
    expect(res.body.batch_no).toMatch(/^RK/);
    const st: Record<string, any> = {};
    for (const s of (await api.ok('get', '/api/stock', { q: 'KD-' })).items) st[s.lot_no] = s;
    expect(st['KD-OPEN-1'].status).toBe('AVAILABLE');
    expect(st['KD-OPEN-1'].expiry_date).toBe('2027-10-01');
    expect(st['KD-IFU-1'].owner_customer_name).toBe('Lumina Health Inc.'); // 客供料期初记入货主名下
  });

  test('供应商导入：供应类别为自由文本（修复：物料类别映射只用于物料），GBK 编码 CSV', async () => {
    const { api } = t;
    let r = await api.as('engineer').upload('/api/import/suppliers', 's.xlsx', await xlsx([
      ['供应商编码', '供应商名称', '简称', '供应类别', '联系人', '电话', '状态'],
      ['S100', '示例电子有限公司', '示例电子', 'LED芯片', '李工', 13900000000, '合格'],
      ['S001', '晶光半导体（厦门）有限公司', null, '原材料', null, null, '暂停'],
    ]));
    expect(r.body).toEqual({ ok: true, created: 1, updated: 1, errors: [] });
    const s = await api.find('/api/suppliers', { q: 'S100' });
    expect([s.category, s.status, s.phone, s.short_name]).toEqual(['LED芯片', 'QUALIFIED', '13900000000', '示例电子']);
    const s1 = await api.find('/api/suppliers', { q: 'S001' });
    expect([s1.category, s1.status]).toEqual(['原材料', 'SUSPENDED']); // 不映射为 RAW
    const logs = (await api.ok('get', '/api/system/audit-logs', { entity: 'md_supplier', entity_id: s.id })).items;
    expect(logs.map((l: any) => [l.action, l.username])).toEqual([['CREATE', 'engineer']]);
    // GBK 编码的 CSV（Excel 中文版默认另存格式）
    const gbk = Buffer.from(
      'b9a9d3a6c9ccb1e0c2eb2cb9a9d3a6c9ccc3fbb3c62cb9a9d3a6c0e0b1f02cd7b4ccac0d0a533130312cbae3c1c1b9e2b5e7d3d0cfdeb9abcbbe2c4c4544d0bec6ac2cbacfb8f10d0a',
      'hex',
    );
    r = await api.as('engineer').upload('/api/import/suppliers', 'suppliers.csv', gbk);
    expect(r.body).toEqual({ ok: true, created: 1, updated: 0, errors: [] });
    const s101 = await api.find('/api/suppliers', { q: 'S101' });
    expect([s101.name, s101.category, s101.status]).toEqual(['恒亮光电有限公司', 'LED芯片', 'QUALIFIED']);
    // 物料导入仍校验物料类别；数据库层错误（超长）只回滚该行，后续行继续检查
    r = await api.as('engineer').upload('/api/import/materials', 'm.xlsx', await xlsx([
      ['物料编码', '物料名称', '物料类别'], ['X-1', '测试', 'LED芯片'], ['X'.repeat(80), '超长编码', '原材料'], ['X-3', '正常', '原材料'], ['', '缺编码', '原材料'],
    ]));
    expect(r.body.errors).toEqual([
      { row: 2, message: '无法识别的物料类别：LED芯片（可选：原材料、半成品、成品、包材、辅料；金蝶的 外购/委外/自制 也可识别）' },
      { row: 3, message: '字段内容超出长度限制' },
      { row: 5, message: '编码和名称不能为空' },
    ]);
    expect((await api.ok('get', '/api/materials', { q: 'X-3' })).items).toEqual([]);
  });
});
