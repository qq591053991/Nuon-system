/**
 * 好用性修复 G2：系统管理与数据导入
 *  E-01 期初库存防重复导入（报错 / 覆盖为导入数 / 批次撤销）；E-02 生产初始化只建 admin 且强制改密、演示模式判断；
 *  E-03 管理员设置/重置的密码首登强制改密、随机临时密码；E-07 导入按实体分权限与上线迁移模式；
 *  E-08 审计追踪按行可读（BOM 明细差异）、按单号/姓名查；E-12/13/22 用户筛选、批量操作、Excel 批量开户、停用释放工牌、
 *  登录失败剩余次数；E-25 模板说明与下拉、预检查、报错列出可选值；E-26/D#22 签名台账中文对象名、链接、筛选。
 */
import ExcelJS from 'exceljs';
import request from 'supertest';
import { config } from '../src/config';
import { DEMO_PASSWORD, resetDatabase, seedAdmin } from '../src/seed/seed-base';
import { bootApp, SIG } from './harness';

async function xlsx(rows: (string | number | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('G2 系统管理与数据导入', () => {
  let t: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => (t = await bootApp()));
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  const http = () => request(t.app.getHttpServer());
  const login = (username: string, password: string) => http().post('/api/auth/login').send({ username, password });
  const bearer = (tok: string) => ({ Authorization: `Bearer ${tok}` });
  const userRow = (username: string) => t.db.base.user.findUniqueOrThrow({ where: { username } });

  test('E-02 生产初始化只建 admin、首登强制改密；演示模式按演示账号自动判断', async () => {
    // 演示数据（seedBase）：预置账号使用公开演示密码 → 演示模式
    let o = (await http().get('/api/auth/options')).body;
    expect(o.demo).toBe(true);
    expect(o.demo_password).toBe(DEMO_PASSWORD);
    expect(o.demo_accounts.map((a: any) => a.username)).toContain('qa');
    expect(o.demo_accounts.find((a: any) => a.username === 'qa').role_names).toEqual(['质量工程师/QA']);
    const prev = process.env.DEMO_MODE;
    process.env.DEMO_MODE = '0';
    expect((await http().get('/api/auth/options')).body).toMatchObject({ demo: false, demo_accounts: [], demo_password: null });
    process.env.DEMO_MODE = prev ?? '';

    // 管理员首页提示：仍有 N 个初始密码账号
    const sum = await t.api.ok('get', '/api/system/users/summary');
    expect(sum.initial_password).toBe(12);
    expect(sum.demo_password.length).toBe(12);
    expect(sum.departments.find((d: any) => d.name === '生产部').count).toBe(2);
    // 一个账号改了密码后不再算“初始密码”
    const tok = (await login('finance', DEMO_PASSWORD)).body.access_token;
    await http().post('/api/auth/change-password').set(bearer(tok)).send({ old_password: DEMO_PASSWORD, new_password: 'Finance2026x' }).expect(200);
    expect((await t.api.ok('get', '/api/system/users/summary')).initial_password).toBe(11);
    const listed = await t.api.ok('get', '/api/system/users', { status: 'initial_password', page_size: 100 });
    expect(listed.total).toBe(11);
    expect(listed.items.every((u: any) => u.initial_password && u.demo_password)).toBe(true);

    // 生产初始化：清空后只建 admin，首次登录须改密
    await resetDatabase(t.db);
    const admin = await seedAdmin(t.db, 'Init2026abc');
    expect(admin).toEqual({ username: 'admin', password: 'Init2026abc' });
    expect(await seedAdmin(t.db)).toBeNull(); // 已存在不改
    expect(await t.db.base.user.count()).toBe(1);
    expect((await http().get('/api/auth/options')).body.demo).toBe(false);
    const r = await login('admin', 'Init2026abc');
    expect(r.body.must_change_password).toBe(true);
    expect(r.body.user.password_change_reason).toBe('INITIAL');
    const t2 = r.body.access_token;
    const denied = await http().get('/api/system/users').set(bearer(t2));
    expect(denied.status).toBe(403);
    expect(denied.body.detail).toContain('须本人修改密码');
    await http().post('/api/auth/change-password').set(bearer(t2)).send({ old_password: 'Init2026abc', new_password: 'Admin2026xyz' }).expect(200);
    expect((await http().get('/api/system/users').set(bearer(t2))).status).toBe(200);
    expect((await userRow('admin')).must_change_password).toBe(false);
    // 随机初始密码符合密码策略
    await resetDatabase(t.db);
    const rnd = await seedAdmin(t.db);
    expect(rnd!.password).toMatch(/^(?=.*[A-Za-z])(?=.*\d).{12}$/);
    expect((await login('admin', rnd!.password)).body.must_change_password).toBe(true);
  });

  test('E-03 新建/重置密码首登强制改密；生成临时密码只显示一次；登录失败提示剩余次数', async () => {
    const { api } = t;
    const u = await api.ok('post', '/api/system/users', { username: 'zhangsan', full_name: '张三', roles: ['warehouse'], generate_password: true });
    expect(u.temp_password).toMatch(/^(?=.*[A-Za-z])(?=.*\d).{10,}$/);
    expect(u).toMatchObject({ must_change_password: true, initial_password: true });
    expect(JSON.stringify(await api.ok('get', '/api/system/users', { q: 'zhangsan' }))).not.toContain(u.temp_password);
    let r = await login('zhangsan', u.temp_password);
    expect(r.body).toMatchObject({ must_change_password: true, user: { password_change_reason: 'INITIAL' } });
    expect((await http().get('/api/stock').set(bearer(r.body.access_token))).status).toBe(403);
    await http().post('/api/auth/change-password').set(bearer(r.body.access_token)).send({ old_password: u.temp_password, new_password: 'Zhang2026x' }).expect(200);
    r = await login('zhangsan', 'Zhang2026x');
    expect(r.body.must_change_password).toBe(false);
    // 行内重置：生成临时密码、同时解锁、本人须再改
    const rs = await api.ok('post', `/api/system/users/${u.id}/reset-password`, {});
    expect(rs.temp_password).toBeTruthy();
    expect((await login('zhangsan', rs.temp_password)).body.must_change_password).toBe(true);
    // 编辑时填新密码同样须改密
    await api.ok('put', `/api/system/users/${u.id}`, { username: 'zhangsan', full_name: '张三', roles: ['warehouse'], password: 'Admin2026set' });
    expect((await userRow('zhangsan')).must_change_password).toBe(true);
    // 登录失败提示剩余次数
    r = await login('zhangsan', 'wrong-pass1');
    expect(r.status).toBe(401);
    expect(r.body.detail).toBe(`用户名或密码错误，还可尝试 ${config.loginMaxFailures - 1} 次（连续错误 ${config.loginMaxFailures} 次将锁定 ${config.loginLockMinutes} 分钟）`);
    for (let i = 0; i < config.loginMaxFailures - 2; i++) await login('zhangsan', 'wrong-pass1');
    r = await login('zhangsan', 'wrong-pass1');
    expect(r.body.detail).toContain('账号已锁定');
    expect((await login('nobody', 'x')).body.detail).toBe('用户名或密码错误'); // 不存在的账号不提示次数
    // 行内解锁
    expect((await api.ok('get', '/api/system/users', { status: 'locked' })).items.map((x: any) => x.username)).toEqual(['zhangsan']);
    await api.ok('post', `/api/system/users/${u.id}/unlock`);
    expect((await userRow('zhangsan')).locked_until).toBeNull();
    // 金蝶登录未启用时不能建金蝶账号
    const kd = await api.post('/api/system/users', { username: 'lisi', full_name: '李四', roles: ['qa'], auth_source: 'KINGDEE' });
    expect(kd.status).toBe(400);
    expect(kd.body.detail).toContain('金蝶云星空登录未启用');
    // 修改我的 PIN
    const op = (await login('op1', DEMO_PASSWORD)).body.access_token;
    expect((await http().post('/api/auth/change-pin').set(bearer(op)).send({ old_pin: '0000', new_pin: '4321' })).body.detail).toBe('原 PIN 错误');
    expect((await http().post('/api/auth/change-pin').set(bearer(op)).send({ old_pin: '1234', new_pin: '1111' })).body.detail).toContain('相同的数字');
    await http().post('/api/auth/change-pin').set(bearer(op)).send({ old_pin: '1234', new_pin: '4321' }).expect(200);
    expect((await http().post('/api/auth/badge-login').send({ badge_no: 'E1001', pin: '4321' })).status).toBe(200);
  });

  test('E-12/E-13/E-22 用户筛选、批量分配角色/停用（释放工牌）、Excel 批量开户输出初始密码清单', async () => {
    const { api } = t;
    // 默认新建在前；按角色、部门筛选
    const nu = await api.ok('post', '/api/system/users', { username: 'new1', full_name: '新人一', roles: ['operator'], department: '生产部', generate_password: true });
    let list = await api.ok('get', '/api/system/users');
    expect(list.items[0].username).toBe('new1');
    expect((await api.ok('get', '/api/system/users', { role: 'operator' })).items.map((x: any) => x.username).sort()).toEqual(['new1', 'op1', 'op2']);
    expect((await api.ok('get', '/api/system/users', { role: 'qa' })).items.map((x: any) => x.username)).toEqual(['qa']);
    expect((await api.ok('get', '/api/system/users', { department: '品质部' })).total).toBe(2);
    // 批量：追加角色、设为指定角色
    const op1 = await userRow('op1');
    const op2 = await userRow('op2');
    let b = await api.ok('post', '/api/system/users/batch', { ids: [op1.id, op2.id, nu.id], action: 'add_roles', roles: ['qc'] });
    expect(b.changed).toBe(3);
    expect((await userRow('op2')).roles).toBe('operator,qc');
    b = await api.ok('post', '/api/system/users/batch', { ids: [op2.id], action: 'set_roles', roles: ['operator'] });
    expect((await userRow('op2')).roles).toBe('operator');
    // 批量停用：释放工牌、清 PIN；不能停用自己
    const admin = await userRow('admin');
    expect((await api.post('/api/system/users/batch', { ids: [op2.id, admin.id], action: 'deactivate' })).body.detail).toContain('不能停用自己');
    expect((await userRow('op2')).is_active).toBe(true); // 整批回滚
    await api.ok('post', '/api/system/users/batch', { ids: [op2.id], action: 'deactivate' });
    const off = await userRow('op2');
    expect([off.is_active, off.badge_no, off.pin_hash]).toEqual([false, null, null]);
    // 工牌可直接分配给新人
    await api.ok('put', `/api/system/users/${nu.id}`, { username: 'new1', full_name: '新人一', roles: ['operator'], badge_no: 'E1002', pin: '2580' });
    // 行内停用（默认释放工牌）；编辑时停用可选释放工牌
    const d = await api.ok('post', `/api/system/users/${op1.id}/deactivate`, {});
    expect([d.is_active, d.badge_no, d.has_pin]).toEqual([false, null, false]);
    const logs = (await api.ok('get', '/api/system/audit-logs', { entity: 'sys_user', entity_id: op1.id })).items;
    expect(logs.some((l: any) => JSON.parse(l.changes).pin?.[1] === '已清除')).toBe(true);
    // 批量重置密码：返回临时密码清单
    b = await api.ok('post', '/api/system/users/batch', { ids: [nu.id], action: 'reset_password' });
    expect(b.passwords).toHaveLength(1);
    expect((await login('new1', b.passwords[0].temp_password)).body.must_change_password).toBe(true);
    list = await api.ok('get', '/api/system/users', { status: 'inactive' });
    expect(list.items.map((x: any) => x.username).sort()).toEqual(['op1', 'op2']);

    // Excel 批量开户：模板 → 预检查 → 导入 → 初始密码清单
    const tpl = await api.get('/api/import/templates/users');
    expect(tpl.status).toBe(200);
    const rows: (string | number | null)[][] = [
      ['登录账号', '姓名', '角色', '部门', '工牌号', '工位PIN', '邮箱', '初始密码'],
      ['wang1', '王一', '仓管员', '仓储部', null, null, null, null],
      ['li2', '李二', '操作员,质检员', '生产部', 'E3001', null, null, null],
      ['zhao3', '赵三', 'qa', '品质部', null, null, null, 'Zhao2026abc'],
    ];
    const chk = await api.upload('/api/import/users?mode=check', 'users.xlsx', await xlsx(rows));
    expect(chk.body).toMatchObject({ ok: true, check: true, total: 3, created: 3, errors: [] });
    expect(chk.body.passwords).toBeUndefined();
    expect(await t.db.base.user.count({ where: { username: { in: ['wang1', 'li2', 'zhao3'] } } })).toBe(0);
    const bad = await api.upload('/api/import/users', 'users.xlsx', await xlsx([...rows, ['wang1', '重复', '老板', null, 'E3001', '12', null, null]]));
    expect(bad.body.ok).toBe(false);
    expect(bad.body.errors[0].row).toBe(5);
    expect(bad.body.errors[0].message).toContain('与第 2 行重复');
    const bad2 = await api.upload('/api/import/users', 'users.xlsx', await xlsx([rows[0], ['x9', '某人', '老板', null, null, null, null, null]]));
    expect(bad2.body.errors[0].message).toContain('无法识别的角色：老板（可选：系统管理员(admin)');
    const res = await api.upload('/api/import/users', 'users.xlsx', await xlsx(rows));
    expect(res.body).toMatchObject({ ok: true, created: 3 });
    const pw: Record<string, any> = Object.fromEntries(res.body.passwords.map((p: any) => [p.username, p]));
    expect(pw.li2).toMatchObject({ roles: '产线操作员、质检员', badge_no: 'E3001' });
    expect(pw.li2.temp_pin).toMatch(/^\d{4}$/);
    expect(pw.zhao3.temp_password).toBe('（文件中指定）');
    expect((await login('wang1', pw.wang1.temp_password)).body.must_change_password).toBe(true);
    expect((await http().post('/api/auth/badge-login').send({ badge_no: 'E3001', pin: pw.li2.temp_pin })).status).toBe(200);
    // 非管理员不能导入用户
    expect((await api.as('wh').upload('/api/import/users', 'users.xlsx', await xlsx(rows))).status).toBe(403);
  });

  test('E-01 期初库存重复导入：默认报错、预检查列出重复行、覆盖为导入数走调整流水、整批撤销', async () => {
    const { api } = t;
    const file = await xlsx([
      ['物料编码', '库位编码', '批号', '数量'],
      ['SCREW-M3X8', 'RAW-A01', 'T-001', 1200],
      ['FAN-6015-24V', 'RAW-A01', 'T-002', 50],
    ]);
    const stockQty = async (lot: string) => (await t.db.base.stock.findMany({ where: { lot_no: lot } })).reduce((a, s) => a + s.qty, 0);
    const first = await api.as('wh').upload('/api/import/stock', 's.xlsx', file);
    expect(first.body).toMatchObject({ ok: true, created: 2, updated: 0 });
    const batch1 = first.body.batch_no;
    expect(batch1).toMatch(/^RK/);
    // 同一文件再传一次：不翻倍，报错并列出重复行
    const again = await api.as('wh').upload('/api/import/stock', 's.xlsx', file);
    expect(again.body.ok).toBe(false);
    expect(again.body.errors).toHaveLength(2);
    expect(again.body.errors[0]).toEqual({ row: 2, message: expect.stringContaining(`SCREW-M3X8 库位 RAW-A01 批号 T-001 已有库存 1200（期初批次 ${batch1} 已导入过）`) });
    expect(again.body.errors[0].message).toContain('覆盖为导入数');
    expect(again.body.duplicates[0]).toMatchObject({ row: 2, material_code: 'SCREW-M3X8', current_qty: 1200, new_qty: 1200, prior_batch: batch1 });
    expect(await stockQty('T-001')).toBe(1200);
    // 文件内重复
    const dupInFile = await api.as('wh').upload('/api/import/stock', 's.xlsx', await xlsx([
      ['物料编码', '库位编码', '批号', '数量'], ['LBL-UDI-50X30', 'RAW-A02', 'Z1', 5], ['LBL-UDI-50X30', 'RAW-A02', 'Z1', 6],
    ]));
    expect(dupInFile.body.errors).toEqual([{ row: 3, message: '与第 2 行重复（同一物料 LBL-UDI-50X30 + 库位 RAW-A02 + 批号 Z1），请合并为一行' }]);
    // 预检查 + 覆盖为导入数：1200 → 1000（调整流水），新行正常入库
    const file2 = await xlsx([
      ['物料编码', '库位编码', '批号', '数量'],
      ['SCREW-M3X8', 'RAW-A01', 'T-001', 1000],
      ['FAN-6015-24V', 'RAW-A01', 'T-002', 50],
      ['CBL-PWR-1.5', 'RAW-A02', 'T-003', 20],
    ]);
    const chk = await api.as('wh').upload('/api/import/stock?mode=check&on_duplicate=overwrite', 's.xlsx', file2);
    expect(chk.body).toMatchObject({ ok: true, check: true, created: 1, updated: 1, unchanged: 1 });
    expect(chk.body.message).toContain('预检查通过');
    expect(await stockQty('T-003')).toBe(0);
    const ow = await api.as('wh').upload('/api/import/stock?on_duplicate=overwrite', 's.xlsx', file2);
    expect(ow.body).toMatchObject({ ok: true, created: 1, updated: 1, unchanged: 1 });
    expect(await stockQty('T-001')).toBe(1000);
    expect(await stockQty('T-002')).toBe(50);
    expect(await stockQty('T-003')).toBe(20);
    const adj = await t.db.base.stockMove.findMany({ where: { lot_no: 'T-001', move_type: 'ADJUST' } });
    expect(adj).toHaveLength(1);
    expect([adj[0].qty, adj[0].from_location_id !== null, adj[0].ref_no, adj[0].remark]).toEqual([200, true, ow.body.batch_no, '期初导入覆盖：原 1200 → 1000']);
    // 待检/冻结库存不能覆盖
    const st = await t.db.base.stock.findFirstOrThrow({ where: { lot_no: 'T-002' } });
    await t.db.base.stock.update({ where: { id: st.id }, data: { status: 'HOLD' } });
    const held = await api.as('wh').upload('/api/import/stock?on_duplicate=overwrite', 's.xlsx', file2);
    expect(held.body.errors.find((e: any) => e.row === 3).message).toContain('有冻结库存 50，不能按导入数覆盖');
    await t.db.base.stock.update({ where: { id: st.id }, data: { status: 'AVAILABLE' } });
    // 批次清单与整批撤销（反向流水）
    const batches = await api.as('wh').ok('get', '/api/import/stock/batches');
    expect(batches.slice(0, 2).map((b: any) => b.no)).toEqual([ow.body.batch_no, batch1]);
    expect(batches[0]).toMatchObject({ line_count: 1, adjust_count: 1 });
    expect((await api.as('wh').post(`/api/import/stock/batches/${batches[1].id}/revert`, {})).status).toBe(400);
    await api.as('wh').ok('post', `/api/import/stock/batches/${batches[0].id}/revert`, { reason: '传错文件' });
    expect(await stockQty('T-001')).toBe(1200);
    expect(await stockQty('T-003')).toBe(0);
    const again2 = await api.as('wh').post(`/api/import/stock/batches/${batches[0].id}/revert`, { reason: 'x' });
    expect(again2.body.detail).toContain('已撤销');
    // 撤销后的批次不再算“已导入过”：重新导入新批号正常
    expect((await api.as('wh').upload('/api/import/stock', 's.xlsx', await xlsx([['物料编码', '库位编码', '批号', '数量'], ['CBL-PWR-1.5', 'RAW-A02', 'T-003', 20]]))).body.ok).toBe(true);
  });

  test('E-07/E-25 导入按实体分权限、上线迁移模式、模板说明与下拉、缺列与可选值报错', async () => {
    const { api } = t;
    const file = await xlsx([['物料编码', '库位编码', '批号', '数量'], ['SCREW-M3X8', 'RAW-A01', 'P-1', 10]]);
    // 工艺工程师不能导入期初库存（只能导物料/BOM/往来单位）
    const eng = await api.as('engineer').upload('/api/import/stock', 's.xlsx', file);
    expect(eng.status).toBe(403);
    expect(eng.body.detail).toContain('无权限导入期初库存：需要【仓储作业】权限');
    const eo = await api.as('engineer').ok('get', '/api/import/options');
    expect(Object.fromEntries(eo.entities.map((e: any) => [e.key, e.can_import]))).toEqual({ suppliers: true, customers: true, materials: true, boms: true, stock: false, users: false });
    expect(eo.entities.find((e: any) => e.key === 'stock').reason).toContain('仓管员');
    expect(eo.entities.find((e: any) => e.key === 'materials').columns.find((c: any) => c.header === '物料类别')).toMatchObject({ required: false, options: ['原材料', '半成品', '成品', '包材', '辅料'] });
    // 管理员：上线迁移模式（默认开启）下可导入全部业务数据
    let ao = await api.ok('get', '/api/import/options');
    expect(ao.migration_mode).toBe(true);
    expect(ao.entities.every((e: any) => e.can_import)).toBe(true);
    expect(ao.entities.find((e: any) => e.key === 'stock').via_migration).toBe(true);
    expect((await api.upload('/api/import/stock', 's.xlsx', file)).body.ok).toBe(true);
    // 关闭迁移模式（写审计）后管理员不能再导入业务数据，但仍可导入用户
    await api.ok('post', '/api/import/migration-mode', { enabled: false });
    expect((await api.as('wh').post('/api/import/migration-mode', { enabled: true })).status).toBe(403);
    ao = await api.ok('get', '/api/import/options');
    expect(ao.entities.filter((e: any) => e.can_import).map((e: any) => e.key)).toEqual(['users']);
    const denied = await api.upload('/api/import/materials', 'm.xlsx', await xlsx([['物料编码', '物料名称'], ['X1', 'x']]));
    expect(denied.status).toBe(403);
    expect(denied.body.detail).toContain('上线迁移模式已关闭');
    const setting = (await api.ok('get', '/api/system/audit-logs', { entity: 'sys_setting' })).items[0];
    expect(JSON.parse(setting.changes)).toEqual({ import_migration_mode: ['开启', '关闭'] });
    expect(setting.doc_no).toBe('上线迁移模式');

    // 模板：数据页无示例行、必填列批注、下拉；填写说明页
    const whTok = (await login('wh', DEMO_PASSWORD)).body.access_token;
    const tpl = await http().get('/api/import/templates/stock').set(bearer(whTok)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(tpl.body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['期初库存', '填写说明', '可选值']);
    const ws = wb.worksheets[0];
    expect(ws.getCell('A2').value).toBeNull(); // 数据页不放示例行
    expect(String((ws.getCell('A1').note as any)?.texts?.map((x: any) => x.text).join('') ?? ws.getCell('A1').note)).toContain('必填');
    expect((ws.getCell('B2') as any).dataValidation).toMatchObject({ type: 'list' });
    const lists = wb.getWorksheet('可选值')!;
    const locs = [];
    for (let r = 2; r <= lists.rowCount; r++) locs.push(lists.getCell(r, 1).value);
    expect(locs).toContain('RAW-A01');
    // 缺少必填列
    const miss = await api.as('engineer').upload('/api/import/materials', 'm.xlsx', await xlsx([['物料名称', '规格型号'], ['x', 'y']]));
    expect(miss.status).toBe(400);
    expect(miss.body.detail).toContain('文件缺少必填列：物料编码');
    // 可选值报错：供应商状态、是/否
    const sup = await api.as('engineer').upload('/api/import/suppliers', 's.xlsx', await xlsx([['供应商编码', '供应商名称', '状态'], ['S900', '某供应商', '优秀']]));
    expect(sup.body.errors).toEqual([{ row: 2, message: '无法识别的供应商状态：优秀（可选：合格、待评、暂停、取消；留空 = 待评）' }]);
    const mat = await api.as('engineer').upload('/api/import/materials', 'm.xlsx', await xlsx([['物料编码', '物料名称', '来料检验'], ['X-9', '某物料', '要']]));
    expect(mat.body.errors[0].message).toBe('来料检验无法识别：要（可选：是、否）');
    // 预检查不写入
    const chk = await api.as('engineer').upload('/api/import/materials?mode=check', 'm.xlsx', await xlsx([['物料编码', '物料名称'], ['X-10', '新物料'], ['LED-660-3030', '改名']]));
    expect(chk.body).toMatchObject({ ok: true, check: true, created: 1, updated: 1 });
    expect(await t.db.base.material.count({ where: { code: 'X-10' } })).toBe(0);
  });

  test('E-08 审计追踪：BOM 明细按行显示差异（物料编码、旧值→新值）；按单号/产品编码/姓名查；仅审计权限可查', async () => {
    const { api } = t;
    const ref = await api.ids();
    const rl = await api.as('engineer').find('/api/boms', { material_id: ref.m['FG-RL300'], status: 'RELEASED' });
    const nb = await api.as('engineer').ok('post', `/api/boms/${rl.id}/new-version`, { version: 'A2', change_reason: '加强固定' });
    const lines = nb.lines.map((l: any) => ({ component_id: l.component_id, qty_per: l.component_code === 'SCREW-M3X8' ? 14 : l.qty_per, scrap_rate: l.scrap_rate, designator: l.designator }));
    lines.push({ component_id: ref.m['PKG-BL100-BOX'], qty_per: 1, scrap_rate: 0, designator: null });
    await api.as('engineer').ok('put', `/api/boms/${nb.id}`, { material_id: ref.m['FG-RL300'], version: 'A2', change_reason: '加强固定', lines });
    const logs = (await api.ok('get', '/api/system/audit-logs', { entity: 'eng_bom', entity_id: nb.id, action: 'UPDATE' })).items;
    const upd = logs.find((l: any) => l.line_changes);
    expect(upd).toMatchObject({ entity_name: 'BOM', doc_no: 'FG-RL300 A2', doc_url: `/engineering/boms/${nb.id}` });
    const lc = upd.line_changes[0];
    expect(lc).toMatchObject({ rel: 'lines', before_known: true, unchanged: 10 });
    const screw = lc.items.find((i: any) => i.op === 'MOD');
    expect(screw).toMatchObject({ key: '第70行', title: 'SCREW-M3X8 螺丝 M3×8', fields: [{ field: 'qty_per', old: 12, new: 14 }] });
    const added = lc.items.find((i: any) => i.op === 'ADD');
    expect(added).toMatchObject({ key: '第120行', title: 'PKG-BL100-BOX 包装箱 BL-100' });
    // 新建（升版）记录：全部明细为新增
    const created = (await api.ok('get', '/api/system/audit-logs', { entity: 'eng_bom', entity_id: nb.id, action: 'CREATE' })).items[0];
    expect(created.line_changes[0].items).toHaveLength(11);
    expect(created.refs.material_id[String(ref.m['FG-RL300'])]).toBe('FG-RL300 LED红光治疗仪 RL-300');
    // 按产品编码查到其 BOM 变更；按姓名查
    const byDoc = await api.ok('get', '/api/system/audit-logs', { doc: 'FG-RL300', user: '吴工艺' });
    expect(byDoc.total).toBeGreaterThanOrEqual(2);
    expect(byDoc.items.every((l: any) => l.username === 'engineer')).toBe(true);
    expect(byDoc.items.some((l: any) => l.entity === 'eng_bom' && l.entity_id === nb.id)).toBe(true);
    // 按单号查：入库单及其明细行（子表记录显示所属单据、ID 字段显示编码）
    const imp = await api.as('wh').upload('/api/import/stock', 's.xlsx', await xlsx([['物料编码', '库位编码', '批号', '数量'], ['FAN-6015-24V', 'RAW-A01', 'AU-1', 5]]));
    const byNo = await api.ok('get', '/api/system/audit-logs', { doc: imp.body.batch_no });
    const rcLine = byNo.items.find((l: any) => l.entity === 'wms_receipt_line');
    expect(rcLine).toMatchObject({ entity_name: '入库明细', doc_no: imp.body.batch_no, parent_name: '入库单', doc_url: `/wms/receipts?q=${imp.body.batch_no}` });
    expect(Object.values(rcLine.refs.material_id)[0]).toBe('FAN-6015-24V 散热风扇');
    expect(Object.values(rcLine.refs.location_id)[0]).toBe('RAW-A01 原材料 A01');
    expect((await api.ok('get', '/api/system/audit-logs', { doc: 'NO-SUCH-DOC' })).doc_not_found).toBe(true);
    // 导出：一次可取 5000 条
    expect((await api.ok('get', '/api/system/audit-logs', { page_size: 5000 })).page_size).toBe(5000);
    // 权限：审计追踪与签名台账仅 audit/admin
    expect((await api.as('op1').get('/api/system/audit-logs')).status).toBe(403);
    expect((await api.as('finance').get('/api/system/esignatures')).status).toBe(403);
    // 单张单据的签名历史、变更记录（BOM 详情页）随单据可见；系统表不行
    expect((await api.as('engineer').get('/api/system/esignatures', { entity: 'eng_bom', entity_id: nb.id })).status).toBe(200);
    expect((await api.as('engineer').get('/api/system/audit-logs', { entity: 'eng_bom', entity_id: nb.id })).body.total).toBeGreaterThanOrEqual(2);
    expect((await api.as('engineer').get('/api/system/audit-logs', { entity: 'sys_user', entity_id: 1 })).status).toBe(403);
  });

  test('E-26/D#22 电子签名台账：中文对象名、单号链接、按签名人/含义/单号筛选', async () => {
    const { api } = t;
    const ref = await api.ids();
    const rl = await api.as('engineer').find('/api/boms', { material_id: ref.m['FG-RL300'], status: 'RELEASED' });
    const nb = await api.as('engineer').ok('post', `/api/boms/${rl.id}/new-version`, { version: 'A2', change_reason: '降本' });
    await api.as('engineer').ok('post', `/api/boms/${nb.id}/submit`, { signature: SIG, change_reason: '降本' });
    const sigs = (await api.ok('get', '/api/system/esignatures', { user: '吴工艺' })).items;
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({ entity_name: 'BOM', doc_no: 'FG-RL300 A2', doc_url: `/engineering/boms/${nb.id}`, username: 'engineer' });
    expect((await api.ok('get', '/api/system/esignatures', { meaning: '编制提交', doc: 'RL300' })).total).toBe(1);
    expect((await api.ok('get', '/api/system/esignatures', { user: '赵QA' })).total).toBe(0);
    const opts = await api.ok('get', '/api/system/esignatures/options');
    expect(opts.entities).toEqual([{ value: 'eng_bom', label: 'BOM', count: 1 }]);
    expect(opts.meanings[0].value).toBe('BOM编制提交');
  });
});
