/**
 * 第二轮修复 R1（平台 / 系统管理 / 账号）：
 *  E-N2 演示密码账号不能“要求下次登录改密”、对本人操作须确认；空闲锁屏解锁（密码 / 工牌 + PIN）；
 *  must_change_pin（管理员生成的 PIN 首次刷卡后须本人修改）、单建有工牌自动生成 PIN、批量重置 PIN；
 *  公司信息系统设置（/auth/options.company 读设置）；审计“编码 版本”搜索、完整性校验留档；用户导入模板；
 *  待办与工作台（可关闭 NCR、需提前催交、待上架、到期预警、大额采购单拍板）；交付风险按行交期与预计完工判断。
 */
import ExcelJS from 'exceljs';
import request from 'supertest';
import { addDays, today } from '../src/common/dates';
import { DEMO_PASSWORD } from '../src/seed/seed-base';
import { bootApp } from './harness';

describe('UX R1：平台 / 系统管理 / 账号', () => {
  let t: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => (t = await bootApp()));
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  const http = () => request(t.app.getHttpServer());
  const login = async (username: string, password = DEMO_PASSWORD) => (await http().post('/api/auth/login').send({ username, password })).body.access_token as string;
  const uid = async (username: string) => (await t.db.base.user.findUniqueOrThrow({ where: { username } })).id;

  test('E-N2：公开演示密码账号不能“要求下次登录改密”，只能重置随机密码或停用；含本人须确认', async () => {
    const { api } = t;
    const qa = await uid('qa');
    let r = await api.as('admin').post('/api/system/users/batch', { ids: [qa], action: 'force_change' });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('仍在使用公开的演示密码');
    expect(r.body.detail).toContain('重置为随机临时密码');
    expect((await t.db.base.user.findUniqueOrThrow({ where: { id: qa } })).must_change_password).toBe(false);
    // 重置为随机临时密码：可以，且演示密码失效
    r = await api.as('admin').post('/api/system/users/batch', { ids: [qa], action: 'reset_password' });
    expect(r.status).toBe(200);
    expect(r.body.passwords[0].temp_password).toBeTruthy();
    expect((await http().post('/api/auth/login').send({ username: 'qa', password: DEMO_PASSWORD })).status).toBe(401);
    // 已不是演示密码的账号可以“要求下次登录改密”
    expect((await api.as('admin').post('/api/system/users/batch', { ids: [qa], action: 'force_change' })).status).toBe(200);
    // 勾选中包含本人：未确认拒绝，确认后执行
    const admin = await uid('admin');
    const op1 = await uid('op1');
    r = await api.as('admin').post('/api/system/users/batch', { ids: [op1, admin], action: 'reset_password' });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('包含您自己');
    r = await api.as('admin').post('/api/system/users/batch', { ids: [op1, admin], action: 'reset_password', confirm_self: true });
    expect([r.status, r.body.passwords.length]).toEqual([200, 2]);
  });

  test('工位 PIN：单建有工牌自动生成 PIN 且须本人修改；刷卡响应 must_change_pin；改 PIN 后清除；批量/行内重置 PIN', async () => {
    const { api } = t;
    const u = await api.as('admin').ok('post', '/api/system/users', {
      username: 'newop', full_name: '新操作员', roles: ['operator'], badge_no: 'E9001', generate_password: true,
    });
    expect(u.temp_password).toBeTruthy();
    expect(u.temp_pin).toMatch(/^\d{4}$/);
    expect(u.has_pin).toBe(true);
    expect(u.must_change_pin).toBe(true);
    // 刷卡登录：响应带 must_change_pin
    let r = await http().post('/api/auth/badge-login').send({ badge_no: 'E9001', pin: u.temp_pin });
    expect(r.status).toBe(200);
    expect(r.body.user.must_change_pin).toBe(true);
    const tok = r.body.access_token;
    // 本人用原 PIN 改成自己的 PIN → 清除标记
    r = await http().post('/api/auth/change-pin').set('Authorization', `Bearer ${tok}`).send({ old_pin: u.temp_pin, new_pin: '2468' });
    expect(r.status).toBe(200);
    r = await http().get('/api/auth/me').set('Authorization', `Bearer ${tok}`);
    expect(r.body.must_change_pin).toBe(false);
    // 行内重置 PIN：重新须改
    const id = u.id;
    const rp = await api.as('admin').ok('post', `/api/system/users/${id}/reset-pin`);
    expect(rp.temp_pin).toMatch(/^\d{4}$/);
    expect(rp.must_change_pin).toBe(true);
    // 批量重置 PIN：只处理有工牌的账号
    const b = await api.as('admin').ok('post', '/api/system/users/batch', { ids: [await uid('op1'), await uid('op2'), await uid('sales')], action: 'reset_pin' });
    expect(b.passwords.map((p: any) => [p.username, p.badge_no, /^\d{4}$/.test(p.temp_pin)])).toEqual([['op1', 'E1001', true], ['op2', 'E1002', true]]);
    expect(b.skipped).toEqual(['sales']);
    // 不显式填 PIN 也没有工牌：不生成
    const u2 = await api.as('admin').ok('post', '/api/system/users', { username: 'office1', full_name: '文员', roles: ['sales'], generate_password: true });
    expect([u2.temp_pin, u2.has_pin]).toEqual([null, false]);
  });

  test('空闲锁屏解锁：本人密码或本人工牌 + PIN；错误返回 400 并提示剩余次数；别人的工牌拒绝', async () => {
    const tok = await login('op1');
    const unlock = (body: Record<string, unknown>) => http().post('/api/auth/unlock').set('Authorization', `Bearer ${tok}`).send(body);
    let r = await unlock({ password: DEMO_PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.access_token).toBeTruthy();
    expect(r.body.user.username).toBe('op1');
    r = await unlock({ password: 'wrong-pass1' });
    expect(r.status).toBe(400);
    expect(r.body.detail).toMatch(/密码错误，还可尝试 \d+ 次/);
    r = await unlock({ badge_no: 'E1001', pin: '1234' });
    expect(r.status).toBe(200);
    r = await unlock({ badge_no: 'E1002', pin: '5678' });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('不是当前登录用户');
    // 失败写入审计（登录失败），成功记“解锁屏幕”
    const logs = await t.db.base.auditLog.findMany({ where: { entity: 'sys_login', username: 'op1' }, orderBy: { id: 'asc' } });
    expect(logs.some((l) => l.action === 'UNLOCK')).toBe(true);
    expect(logs.some((l) => l.action === 'LOGIN_FAILED' && (l.changes ?? '').includes('解锁屏幕'))).toBe(true);
  });

  test('公司信息：管理员在系统设置维护，/auth/options.company 读设置（环境变量作默认），逐项写审计', async () => {
    const { api } = t;
    expect((await api.as('sales').put('/api/system/settings/company', { name: 'X' })).status).toBe(403);
    const saved = await api.as('admin').ok('put', '/api/system/settings/company', {
      name: '诺恩光电医疗', name_en: 'Nuon Phototherapy Co., Ltd.', address: '深圳市宝安区', phone: '0755-1234', tax_no: '91440300X', bank: '中国银行 123', swift: 'BKCHCNBJ45A',
    });
    expect(saved).toMatchObject({ name: '诺恩光电医疗', swift: 'BKCHCNBJ45A', updated_by: 'admin' });
    const opts = (await http().get('/api/auth/options')).body;
    expect(opts.company).toMatchObject({ name: '诺恩光电医疗', name_en: 'Nuon Phototherapy Co., Ltd.', swift: 'BKCHCNBJ45A', bank: '中国银行 123' });
    expect(opts.company.updated_by).toBeUndefined();
    const log = await t.db.base.auditLog.findFirst({ where: { entity: 'sys_setting' }, orderBy: { id: 'desc' } });
    expect(JSON.parse(log!.changes!)['company.swift']).toEqual(['', 'BKCHCNBJ45A']);
    // 审计页显示“公司信息”
    const a = await api.as('admin').ok('get', '/api/system/audit-logs', { entity: 'sys_setting' });
    expect(a.items[0].doc_no).toBe('公司信息');
  });

  test('审计：按“编码 版本”查 BOM 变更；完整性校验结论留档可查历史', async () => {
    const { api } = t;
    const r = await api.as('admin').ok('get', '/api/system/audit-logs', { doc: 'FG-RL300 A1' });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((x: any) => ['eng_bom', 'eng_bom_line', 'eng_routing', 'eng_routing_op', 'eng_routing_param'].includes(x.entity))).toBe(true);
    expect(r.items.some((x: any) => x.entity === 'eng_bom')).toBe(true);
    expect((await api.as('admin').ok('get', '/api/system/audit-logs', { doc: 'FG-RL300 Z9' })).items).toEqual([]);
    const v = await api.as('qa').ok('get', '/api/system/audit-verify');
    expect(v.ok).toBe(true);
    const h = await api.as('admin').ok('get', '/api/system/audit-verify/history');
    expect(h[0]).toMatchObject({ username: 'qa', ok: true, problems: 0 });
    expect(h[0].sealed_total).toBe(v.sealed_total);
  });

  test('用户导入模板：角色列校验为“警告”（可填多个）；金蝶未启用时登录方式不列“金蝶”', async () => {
    const r = await http().get('/api/import/templates/users').set('Authorization', `Bearer ${await login('admin')}`).buffer(true)
      .parse((res: any, cb: (e: Error | null, body: Buffer) => void) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(r.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body as any);
    const ws = wb.worksheets[0];
    const header = (ws.getRow(1).values as unknown[]).slice(1).map(String);
    const col = (name: string) => ws.getColumn(header.indexOf(name) + 1).letter;
    const dv = (ws as any).dataValidations.model as Record<string, any>;
    const roleDv = Object.entries(dv).find(([k]) => k.startsWith(`${col('角色')}2`))?.[1];
    expect(roleDv.errorStyle).toBe('warning');
    const lists = wb.getWorksheet('可选值')!;
    const all = (lists.getSheetValues() as unknown[][]).flat().map((x) => String(x ?? ''));
    expect(all).toContain('本系统');
    expect(all).not.toContain('金蝶');
  });

  test('待办：QA 可关闭 NCR、采购需提前催交、厂长大额采购单拍板；QA/采购到期预警', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    // 一张已处置（报废）的 NCR：满足关闭条件
    await db.client.ncr.create({ data: { no: 'NCR-C1', source: 'IQC', description: '外观', status: 'DISPOSITIONED', disposition: 'SCRAP', disposition_at: new Date(), material_id: ref.m['LED-660-3030'] } });
    const qa = await api.as('qa').ok('get', '/api/todos');
    expect(qa.find((x: any) => x.key === 'ncr_closable')).toMatchObject({ count: 1, path: '/quality/ncrs?closable=1' });
    // MRP 例外：提前催交
    const run = await db.client.mrpRun.create({ data: { no: 'MRP-T1', run_at: new Date() } });
    await db.client.mrpSuggestion.create({
      data: { run_id: run.id, material_id: ref.m['LED-660-3030'], action: 'PURCHASE', suggested_qty: 100, due_date: today(), status: 'OPEN', exception: 'EXPEDITE' },
    });
    const buyer = await api.as('buyer').ok('get', '/api/todos');
    expect(buyer.find((x: any) => x.key === 'mrp_expedite')).toMatchObject({ count: 1, path: '/purchase/chase' });
    expect(buyer.find((x: any) => x.key === 'mrp_purchase')).toBeUndefined();
    // 大额采购单：SUBMITTED 进厂长拍板（工作台 big_pos 可直接批准/退回）
    const sup = await api.as('buyer').find('/api/suppliers', { page_size: 1 });
    const po = await db.client.purchaseOrder.create({ data: { no: 'PO-BIG1', supplier_id: sup.id, order_date: today(), status: 'SUBMITTED', currency: 'CNY', total_amount: 80000 } });
    const mgr = await api.as('manager').ok('get', '/api/todos');
    expect(mgr.find((x: any) => x.key === 'po_big')).toMatchObject({ count: 1, path: '/purchase/orders?status=SUBMITTED' });
    const wb = await api.as('manager').ok('get', '/api/workbench');
    expect(wb.sections.big_pos).toEqual([expect.objectContaining({ id: po.id, no: 'PO-BIG1', base_amount: 80000 })]);
    // 到期预警：仪器校准、供应商资质
    await db.client.equipment.updateMany({ where: {}, data: { calibration_required: false } });
    const eq = await db.client.equipment.findFirstOrThrow();
    await db.client.equipment.update({ where: { id: eq.id }, data: { calibration_required: true, next_calibration_date: addDays(today(), -3) } });
    const qaWb = await api.as('qa').ok('get', '/api/workbench');
    expect(qaWb.sections.expiry.calibration).toEqual([expect.objectContaining({ code: eq.code, days_left: -3 })]);
    expect(Object.keys(qaWb.sections.expiry).sort()).toEqual(['calibration', 'lot', 'qualification', 'supplier']);
    expect(qaWb.kpis.find((k: any) => k.key === 'closable_ncr')).toMatchObject({ value: 1, path: '/quality/ncrs?closable=1' });
    const buyerWb = await api.as('buyer').ok('get', '/api/workbench');
    expect(Object.keys(buyerWb.sections.expiry)).toEqual(['supplier']);
    // 仓管：待上架与 /wms/putaway 同口径
    const wh = await api.as('wh').ok('get', '/api/todos');
    const pa = (await api.as('wh').ok('get', '/api/wms/putaway')).total;
    expect(wh.find((x: any) => x.key === 'putaway')?.count ?? 0).toBe(pa);
  });

  test('交付风险：按最早行交期；预计完工（齐套日 + 生产周期）晚于交期标红“预计晚 N 天”', async () => {
    const { api, db } = t;
    const so = await api.as('sales').find('/api/sales-orders', { q: 'GY-2026-0931' });
    const line = await db.client.salesOrderLine.findFirstOrThrow({ where: { order_id: so.id } });
    // 表头交期 30 天后，但行交期 2 天后；成品生产周期 7 天 → 预计晚 5 天
    await db.client.salesOrder.update({ where: { id: so.id }, data: { delivery_date: addDays(today(), 30) } });
    await db.client.salesOrderLine.update({ where: { id: line.id }, data: { delivery_date: addDays(today(), 2) } });
    await db.client.material.update({ where: { id: line.material_id }, data: { lead_time_days: 7 } });
    const r = await api.as('pmc').ok('get', '/api/workbench/delivery-risk');
    const row = r.items.find((x: any) => x.id === so.id);
    expect(row.delivery_date).toBe(addDays(today(), 2).toISOString().slice(0, 10));
    expect(row.days_left).toBe(2);
    expect(row.level).toBe('red');
    expect(row.late_days).toBe(5);
    expect(row.reasons.some((x: string) => x.startsWith('预计晚 5 天'))).toBe(true);
  });
});
