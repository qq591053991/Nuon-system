/**
 * 好用性修复 G1：读权限矩阵（audit 权限点、金额按权限裁剪）、按岗位的待办/工作台（带筛选的跳转路径）、
 * 交付风险（红黄绿 + 阻塞原因）、产出/FPY 下钻、全局搜索（UDI/GS1、单号、库位、中文状态、按权限裁剪、完全匹配排前）。
 */
import { addDays, today } from '../src/common/dates';
import { bootApp } from './harness';

describe('UX G1：平台与岗位工作台', () => {
  let t: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => (t = await bootApp()));
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  const todoKeys = (rows: any[]) => rows.map((x) => x.key);

  test('权限点 audit：admin / manager / qa 拥有，其他岗位没有', async () => {
    const { api } = t;
    expect((await api.as('admin').ok('get', '/api/auth/me')).permissions).toEqual(['admin', 'audit']);
    expect((await api.as('manager').ok('get', '/api/auth/me')).permissions).toContain('audit');
    expect((await api.as('manager').ok('get', '/api/auth/me')).permissions).not.toContain('qa');
    expect((await api.as('qa').ok('get', '/api/auth/me')).permissions).toEqual(['audit', 'qa', 'qc']);
    for (const u of ['sales', 'buyer', 'pmc', 'engineer', 'wh', 'op1', 'qc', 'finance']) {
      expect([u, (await api.as(u).ok('get', '/api/auth/me')).permissions.includes('audit')]).toEqual([u, false]);
    }
  });

  test('驾驶舱金额按权限裁剪：操作员/QA/管理员看不到在手订单金额与库存金额；厂长、销售、财务按各自口径可见', async () => {
    const { api } = t;
    const mgr = (await api.as('manager').ok('get', '/api/dashboard')).kpi;
    expect(mgr.open_so_amount).toBeGreaterThan(0);
    expect(mgr.stock_value).toBeGreaterThan(0);
    for (const u of ['op1', 'qa', 'admin', 'wh']) {
      const k = (await api.as(u).ok('get', '/api/dashboard')).kpi;
      expect([u, k.open_so_amount, k.open_so_by_currency, k.stock_value]).toEqual([u, null, null, null]);
      expect(k.open_so).toBe(2); // 数量类指标照常
    }
    const sales = (await api.as('sales').ok('get', '/api/dashboard')).kpi;
    expect([sales.open_so_amount > 0, sales.stock_value]).toEqual([true, null]);
    const buyer = (await api.as('buyer').ok('get', '/api/dashboard')).kpi;
    expect([buyer.open_so_amount, buyer.stock_value > 0]).toEqual([null, true]);
  });

  test('待办按岗位裁剪，跳转路径带筛选参数；厂长只看要他拍板的事', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    // 一张 IQC 待检、一张超期 NCR、一张逾期订单、一张大额待审批采购单
    await db.client.inspection.create({ data: { no: 'IQC-T1', insp_type: 'IQC', material_id: ref.m['LED-660-3030'], lot_no: 'L1', lot_qty: 10 } });
    await db.client.ncr.create({ data: { no: 'NCR-T1', source: 'IQC', description: '外观不良', status: 'OPEN', due_date: addDays(today(), -2) } });
    const so = await api.as('sales').find('/api/sales-orders', { q: 'LUM-PO-26-118' });
    await db.client.salesOrder.update({ where: { id: so.id }, data: { delivery_date: addDays(today(), -3) } });
    const sup = await api.as('buyer').find('/api/suppliers', { page_size: 1 });
    await db.client.purchaseOrder.create({ data: { no: 'PO-BIG', supplier_id: sup.id, order_date: today(), status: 'DRAFT', currency: 'CNY', total_amount: 80000 } });

    const qa = await api.as('qa').ok('get', '/api/todos');
    expect(qa.find((x: any) => x.key === 'iqc')).toMatchObject({ count: 1, path: '/quality/inspections?status=PENDING&type=IQC' });
    expect(qa.find((x: any) => x.key === 'ncr')).toMatchObject({ count: 1, path: '/quality/ncrs?status=OPEN' });
    expect(qa.find((x: any) => x.key === 'ncr_overdue')).toMatchObject({ count: 1, path: '/quality/ncrs?overdue=1' });

    const mgr = await api.as('manager').ok('get', '/api/todos');
    expect(todoKeys(mgr).sort()).toEqual(['ncr_overdue', 'po_big', 'so_overdue']);
    expect(mgr.find((x: any) => x.key === 'so_overdue')).toMatchObject({ count: 1, path: '/?risk=overdue', level: 'error' });

    const wh = await api.as('wh').ok('get', '/api/todos');
    expect(todoKeys(wh)).not.toContain('iqc');
    const buyer = await api.as('buyer').ok('get', '/api/todos');
    expect(buyer.find((x: any) => x.key === 'po_draft')).toMatchObject({ count: 1, path: '/purchase/orders?status=DRAFT' });
    const sales = await api.as('sales').ok('get', '/api/todos');
    expect(sales.find((x: any) => x.key === 'so_draft')).toMatchObject({ count: 1, path: '/sales/orders?status=DRAFT' });
    // 操作员没有业务待办
    expect(await api.as('op1').ok('get', '/api/todos')).toEqual([]);
  });

  test('岗位工作台：主岗位、KPI 带下钻路径、岗位区块（财务应收应付 / 管理员账号安全 / 操作员资质）', async () => {
    const { api, db } = t;
    const mgr = await api.as('manager').ok('get', '/api/workbench');
    expect(mgr.profile).toBe('manager');
    const k = Object.fromEntries(mgr.kpis.map((x: any) => [x.key, x]));
    expect(k.open_so).toMatchObject({ value: 2, path: '/sales/orders?status=CONFIRMED,IN_PRODUCTION,PARTIAL_SHIPPED' });
    expect(k.open_so.hint).toContain('金额 CNY');
    expect(k.wip_wo.path).toBe('/mes/work-orders?status=RELEASED,IN_PROGRESS');
    expect(k.stock_value.value).toBeGreaterThan(0);
    expect(mgr.sections.approvals).toEqual([]);

    // 财务：逾期应收进 KPI 与区块
    const c1 = await api.as('sales').find('/api/customers', { q: 'C001' });
    await db.client.financeDoc.create({ data: { no: 'AR-T1', doc_type: 'AR', customer_id: c1.id, doc_date: addDays(today(), -40), due_date: addDays(today(), -10), currency: 'CNY', amount: 1000, paid_amount: 200 } });
    const fin = await api.as('finance').ok('get', '/api/workbench');
    expect(fin.profile).toBe('finance');
    expect(fin.sections.finance.ar_overdue).toEqual([expect.objectContaining({ no: 'AR-T1', balance: 800, base_balance: 800, days_overdue: 10 })]);
    expect(fin.kpis.find((x: any) => x.key === 'ar_overdue')).toMatchObject({ value: 800, path: '/finance?tab=AR&overdue=1', level: 'error' });
    expect((await api.as('finance').ok('get', '/api/todos')).find((x: any) => x.key === 'ar_overdue')).toMatchObject({ count: 1 });
    // 非财务看不到财务区块
    expect((await api.as('manager').ok('get', '/api/workbench')).sections.finance).toBeUndefined();

    // 管理员：锁定账号、待分配角色
    await db.base.user.update({ where: { username: 'sales' }, data: { locked_until: new Date(Date.now() + 600_000) } });
    await db.base.user.create({ data: { username: 'newbie', full_name: '新人', password_hash: '!x', roles: '', must_change_password: true } });
    const adm = await api.as('admin').ok('get', '/api/workbench');
    expect(adm.profile).toBe('admin');
    expect(adm.sections.security.locked.map((u: any) => u.username)).toEqual(['sales']);
    expect(adm.sections.security.no_role.map((u: any) => u.username)).toEqual(['newbie']);
    expect(adm.sections.security.initial_password.map((u: any) => u.username)).toContain('newbie');
    expect(adm.kpis.find((x: any) => x.key === 'locked')).toMatchObject({ value: 1, path: '/system/users?status=locked' });
    expect((await api.as('admin').ok('get', '/api/todos')).find((x: any) => x.key === 'users_locked')).toMatchObject({ count: 1 });

    // 操作员 / 仓管
    const op = await api.as('op1').ok('get', '/api/workbench');
    expect(op.profile).toBe('operator');
    expect(op.sections.operator.quals.length).toBeGreaterThan(0);
    expect(op.kpis.some((x: any) => /金额/.test(x.title + (x.hint ?? '')))).toBe(false);
    expect((await api.as('wh').ok('get', '/api/workbench')).profile).toBe('warehouse');
  });

  test('交付风险：逾期订单为红并给出原因；未排产订单提示；无权限 403', async () => {
    const { api, db } = t;
    const so = await api.as('sales').find('/api/sales-orders', { q: 'LUM-PO-26-118' });
    await db.client.salesOrder.update({ where: { id: so.id }, data: { delivery_date: addDays(today(), -2) } });
    const r = await api.as('manager').ok('get', '/api/workbench/delivery-risk');
    expect(r.items.map((x: any) => x.no)).toHaveLength(2); // 草稿不计
    const first = r.items[0];
    expect([first.id, first.level, first.days_left]).toEqual([so.id, 'red', -2]);
    expect(first.reasons).toEqual(expect.arrayContaining(['已逾期 2 天', '未排产 20 台']));
    expect(r.summary.red).toBe(1);
    // 生成工单后不再是“未排产”，变成“工单未下达”
    const ref = await api.ids();
    await api.as('pmc').ok('post', '/api/work-orders', { material_id: ref.m['FG-RL300'], planned_qty: 20, so_id: so.id });
    const r2 = await api.as('pmc').ok('get', '/api/workbench/delivery-risk');
    const row = r2.items.find((x: any) => x.id === so.id);
    expect(row.reasons.some((x: string) => x.startsWith('未排产'))).toBe(false);
    expect(row.reasons).toContain('工单未下达');
    expect(row.work_orders).toHaveLength(1);
    expect((await api.as('op1').get('/api/workbench/delivery-risk')).status).toBe(403);
    expect((await api.as('wh').get('/api/workbench/delivery-risk')).status).toBe(403);
  });

  test('全局搜索：序列号 / UDI（人工可读与 GS1 原始串）/ 批号 / 库位 / 单号，中文状态，完全匹配排前，按权限裁剪', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const wo = await db.client.workOrder.create({ data: { no: 'WO-S1', material_id: ref.m['FG-RL300'], planned_qty: 2, status: 'IN_PROGRESS', lot_no: 'BS1' } });
    await db.client.serialNumber.create({ data: { sn: 'RLS0001', wo_id: wo.id, material_id: ref.m['FG-RL300'], lot_no: 'BS1', status: 'SHIPPED' } });
    await db.client.serialNumber.create({ data: { sn: 'RLS00011', wo_id: wo.id, material_id: ref.m['FG-RL300'], lot_no: 'BS1', status: 'IN_STOCK' } });

    // 序列号：两条都匹配，但完全匹配的排第一并标 exact
    let r = await api.as('manager').ok('get', '/api/search', { q: 'RLS0001' });
    expect(r[0]).toMatchObject({ type: 'serial', title: 'RLS0001', exact: true, status_label: '已发货', url: '/trace?sn=RLS0001' });
    expect(r.filter((x: any) => x.exact)).toHaveLength(1);
    // UDI 人工可读 / GS1 原始串（]d2 前缀，GS 分隔）→ 只按 (21) 序列号精确查
    r = await api.as('manager').ok('get', '/api/search', { q: '(01)06970000000017(11)261112(10)BS1(21)RLS00011' });
    expect(r.map((x: any) => [x.type, x.title, x.exact])).toEqual([['serial', 'RLS00011', true]]);
    r = await api.as('manager').ok('get', '/api/search', { q: ']d2010697000000001711261112' + '10BS1\x1d21RLS0001' });
    expect(r.map((x: any) => [x.type, x.title])).toEqual([['serial', 'RLS0001']]);
    // 批号：仓管跳库存（带物料与批号筛选），其他岗位跳追溯
    r = await api.as('wh').ok('get', '/api/search', { q: 'JG2609-660A' });
    expect(r[0]).toMatchObject({ type: 'lot', exact: true, status_label: '合格' });
    expect(r[0].url).toBe(`/wms/stock?q=JG2609-660A&material_id=${ref.m['LED-660-3030']}&lot_no=JG2609-660A`);
    r = await api.as('engineer').ok('get', '/api/search', { q: 'JG2609-660A' });
    expect(r[0].url).toBe('/trace?material_code=LED-660-3030&lot_no=JG2609-660A');
    // 库位
    r = await api.as('wh').ok('get', '/api/search', { q: 'DRY-01' });
    expect(r[0]).toMatchObject({ type: 'location', title: 'DRY-01', exact: true, url: `/wms/stock?location_id=${ref.loc['DRY-01']}&location_code=DRY-01` });
    // 单号：销售订单（中文状态）；领料单
    const so = await api.as('sales').find('/api/sales-orders', { q: 'LUM-PO-26-118' });
    r = await api.as('sales').ok('get', '/api/search', { q: so.no });
    expect(r[0]).toMatchObject({ type: 'sales_order', exact: true, status_label: '已确认', url: `/sales/orders/${so.id}` });
    const iss = await db.client.materialIssue.create({ data: { no: 'LL-T1', wo_id: wo.id, status: 'DRAFT' } });
    r = await api.as('wh').ok('get', '/api/search', { q: 'LL-T1' });
    expect(r[0]).toMatchObject({ type: 'issue', type_text: '领料单', exact: true, status_label: '待过账', url: `/wms/issues?q=LL-T1&id=${iss.id}` });
    // 权限：操作员搜不到销售订单；非财务搜不到应收单
    expect((await api.as('op1').ok('get', '/api/search', { q: so.no })).some((x: any) => x.type === 'sales_order')).toBe(false);
    const c1 = await api.as('sales').find('/api/customers', { q: 'C001' });
    await db.client.financeDoc.create({ data: { no: 'ARX-1', doc_type: 'AR', customer_id: c1.id, doc_date: today(), currency: 'CNY', amount: 1 } });
    expect((await api.as('sales').ok('get', '/api/search', { q: 'ARX-1' })).length).toBe(0);
    expect((await api.as('finance').ok('get', '/api/search', { q: 'ARX-1' }))[0]).toMatchObject({ type: 'finance', type_text: '应收单', status_label: '未结' });
    // 空输入
    expect(await api.as('wh').ok('get', '/api/search', { q: '  ' })).toEqual([]);
  });

  test('产出与 FPY 下钻', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const wo = await db.client.workOrder.create({ data: { no: 'WO-D1', material_id: ref.m['FG-RL300'], planned_qty: 2, status: 'IN_PROGRESS', lot_no: 'BD1' } });
    const s1 = await db.client.serialNumber.create({ data: { sn: 'D1-001', wo_id: wo.id, material_id: ref.m['FG-RL300'], status: 'COMPLETED', completed_at: new Date() } });
    const s2 = await db.client.serialNumber.create({ data: { sn: 'D1-002', wo_id: wo.id, material_id: ref.m['FG-RL300'], status: 'IN_PROCESS' } });
    for (const [sn, result] of [[s1.id, 'PASS'], [s2.id, 'FAIL'], [s2.id, 'PASS']] as const) {
      await db.client.operationRecord.create({ data: { wo_id: wo.id, sn_id: sn, seq: 20, op_code: 'OPT', op_name: '光学测试', result, operator: 'op1', operator_name: '刘操作' } });
    }
    const out = await api.as('manager').ok('get', '/api/workbench/output');
    expect(out.total).toBe(1);
    expect(out.work_orders).toEqual([expect.objectContaining({ wo_no: 'WO-D1', qty: 1, serials: ['D1-001'] })]);
    const f = await api.as('manager').ok('get', '/api/workbench/fpy', { op_name: '光学测试' });
    expect(f.ops).toEqual([{ op_name: '光学测试', tested: 2, passed: 1, failed: 1, fpy: 50 }]);
    expect(f.fails.map((x: any) => [x.sn, x.wo_no, x.operator])).toEqual([['D1-002', 'WO-D1', '刘操作']]);
    expect((await api.as('finance').get('/api/workbench/fpy')).status).toBe(403);
    // 厂长 KPI 中 FPY 低于 90% 标红
    const k = (await api.as('manager').ok('get', '/api/workbench')).kpis.find((x: any) => x.key === 'fpy');
    expect([k.value, k.level, k.path]).toEqual([50, 'error', '#fpy']);
  });
});
