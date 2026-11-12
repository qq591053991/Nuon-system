/**
 * 评审改进（安全与合规）：职责分离、BOM/工艺双人签名、审计追踪封存与校验、密码策略与锁定、工牌登录、安全响应头。
 */
import request from 'supertest';
import { passwordExpired } from '../src/auth/password';
import { config } from '../src/config';
import { AuditSealService } from '../src/system/audit-seal.service';
import { DEMO_PASSWORD } from '../src/seed/seed-base';
import { bootApp, SIG } from './harness';

describe('评审改进：安全与合规', () => {
  let t: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => (t = await bootApp()));
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  const http = () => request(t.app.getHttpServer());
  const login = (username: string, password: string) => http().post('/api/auth/login').send({ username, password });
  const badge = (badge_no: string, pin: string) => http().post('/api/auth/badge-login').send({ badge_no, pin });
  const bearer = (tok: string) => ({ Authorization: `Bearer ${tok}` });
  const userRow = (username: string) => t.db.base.user.findUniqueOrThrow({ where: { username } });

  test('P0-5 职责分离：admin 只管账号；manager 不能做质量签名；质量签名接口只限 QA', async () => {
    const { api } = t;
    const admin = await api.as('admin').ok('get', '/api/auth/me');
    expect(admin.permissions).toEqual(['admin', 'audit']); // G1：admin 可查审计追踪/签名台账（audit）
    const mgr = await api.as('manager').ok('get', '/api/auth/me');
    expect(mgr.permissions).not.toContain('qa');
    expect(mgr.permissions).not.toContain('admin');
    expect(mgr.permissions).toEqual(expect.arrayContaining(['sales', 'plan', 'wms', 'mes', 'qc', 'engineering', 'finance']));
    // admin 可以查看业务数据，但不能做业务写操作
    expect((await api.as('admin').get('/api/materials')).status).toBe(200);
    expect((await api.as('admin').post('/api/materials', { code: 'X-ADM', name: '管理员不能建' })).status).toBe(403);
    expect((await api.as('admin').post('/api/sales-orders/1/confirm')).status).toBe(403);
    // 质量签名接口：admin / manager 都是 403
    const qaOnly: [string, unknown][] = [
      ['/api/work-orders/1/dhr/release', { approve: true, signature: SIG }],
      ['/api/work-orders/1/releases', { signature: SIG }],
      ['/api/ncrs/1/disposition', { disposition: 'SCRAP', signature: SIG }],
      ['/api/ncrs/1/close', {}],
      ['/api/capas/1/status', { status: 'CLOSED', signature: SIG }],
      ['/api/boms/1/approve', { signature: SIG }],
      ['/api/boms/1/reject', { reason: 'x', signature: SIG }],
      ['/api/routings/1/approve', { signature: SIG }],
      ['/api/routings/1/reject', { reason: 'x', signature: SIG }],
    ];
    for (const [url, body] of qaOnly) {
      expect([url, (await api.as('admin').post(url, body)).status]).toEqual([url, 403]);
      expect([url, (await api.as('manager').post(url, body)).status]).toEqual([url, 403]);
      expect([url, (await api.as('qa').post(url, body)).status]).not.toEqual([url, 403]);
    }
    // 管理员仍可管理用户
    expect((await api.as('admin').get('/api/system/users')).status).toBe(200);
    expect((await api.as('manager').get('/api/system/users')).status).toBe(403);
  });

  test('P0-6 BOM 双人签名：提交（编制）→ 驳回 → 再提交 → 批准；批准人不能是提交人；待批准只读；QA 待办', async () => {
    const { api } = t;
    const ref = await api.ids();
    // 新产品首版：不要求变更原因
    const mat = await api.as('engineer').ok('post', '/api/materials', { code: 'FG-NEW1', name: '新品', category: 'FINISHED' });
    let bom = await api.as('engineer').ok('post', '/api/boms', { material_id: mat.id, version: 'A0', lines: [{ component_id: ref.m['LED-460-5050'], qty_per: 10 }] });
    expect((await api.as('qa').post(`/api/boms/${bom.id}/approve`, { signature: SIG })).body.detail).toContain('只有已提交待批准');
    expect((await api.as('qa').post(`/api/boms/${bom.id}/submit`, { signature: SIG })).status).toBe(403); // 提交是工程权限
    bom = await api.as('engineer').ok('post', `/api/boms/${bom.id}/submit`, { signature: SIG });
    expect(bom.status).toBe('SUBMITTED');
    expect(bom.submitted_at).toBeTruthy();
    // 待批准：只读、不能删除、不能重复提交
    expect((await api.as('engineer').put(`/api/boms/${bom.id}`, { material_id: mat.id, version: 'A0', lines: [] })).status).toBe(400);
    expect((await api.as('engineer').del(`/api/boms/${bom.id}`)).body.detail).toBe('只能删除草稿');
    expect((await api.as('engineer').post(`/api/boms/${bom.id}/submit`, { signature: SIG })).body.detail).toBe('只有草稿可以提交');
    // QA 待办：待批准的 BOM，跳转到按状态筛选的列表
    const todo = (await api.as('qa').ok('get', '/api/todos')).find((x: any) => x.key === 'bom_submitted');
    expect(todo).toMatchObject({ count: 1, path: '/engineering/boms?status=SUBMITTED' });
    expect((await api.as('qa').ok('get', '/api/boms', { status: 'SUBMITTED' })).items.map((x: any) => x.id)).toEqual([bom.id]);
    // 驳回：需要原因 + 电子签名，退回草稿
    expect((await api.as('qa').post(`/api/boms/${bom.id}/reject`, { signature: SIG })).status).toBe(400);
    expect((await api.as('qa').post(`/api/boms/${bom.id}/reject`, { reason: '用量需复核' })).body.detail).toContain('电子签名');
    bom = await api.as('qa').ok('post', `/api/boms/${bom.id}/reject`, { reason: '用量需复核', signature: { password: DEMO_PASSWORD } });
    expect([bom.status, bom.submitted_by]).toEqual(['DRAFT', null]);
    await api.as('engineer').ok('put', `/api/boms/${bom.id}`, { material_id: mat.id, version: 'A0', lines: [{ component_id: ref.m['LED-460-5050'], qty_per: 12 }] });
    // 同时拥有工程与 QA 角色的人：可以提交，但不能批准自己提交的版本
    // 管理员设置的密码默认首次登录须修改（G2 E-03）；此处测试职责分离，显式免改密
    await api.as('admin').ok('post', '/api/system/users', { username: 'eqa', full_name: '钱工程QA', password: DEMO_PASSWORD, roles: ['engineer', 'qa'], must_change_password: false });
    bom = await api.as('eqa').ok('post', `/api/boms/${bom.id}/submit`, { signature: SIG });
    const self = await api.as('eqa').post(`/api/boms/${bom.id}/approve`, { signature: SIG });
    expect(self.status).toBe(400);
    expect(self.body.detail).toContain('批准人不能与提交人相同');
    bom = await api.as('qa').ok('post', `/api/boms/${bom.id}/approve`, { signature: SIG });
    expect([bom.status, bom.released_by, bom.submitted_by]).toEqual(['RELEASED', '赵QA', '钱工程QA']);
    const sigs = (await api.ok('get', '/api/system/esignatures', { entity: 'eng_bom', entity_id: bom.id })).items;
    expect(sigs.map((s: any) => [s.meaning, s.username]).reverse()).toEqual([
      ['BOM编制提交', 'engineer'], ['BOM驳回', 'qa'], ['BOM编制提交', 'eqa'], ['BOM批准', 'qa'],
    ]);
    expect(sigs.find((s: any) => s.meaning === 'BOM驳回').reason).toBe('用量需复核');
    // 升版可带变更原因；提交时使用
    const nb = await api.as('engineer').ok('post', `/api/boms/${bom.id}/new-version`, { version: 'A1', ecn_no: 'ECN-9', change_reason: '降本' });
    expect(nb.change_reason).toBe('降本');
    expect((await api.as('engineer').ok('post', `/api/boms/${nb.id}/submit`, { signature: SIG })).status).toBe('SUBMITTED');
    await api.as('qa').ok('post', `/api/boms/${nb.id}/approve`, { signature: SIG });
    expect((await api.ok('get', `/api/boms/${bom.id}`)).status).toBe('OBSOLETE');
  });

  test('P0-6 工艺路线双人签名：未批准前旧版本仍生效；驳回后可编辑', async () => {
    const { api } = t;
    const ref = await api.ids();
    const rt = await api.find('/api/routings', { material_id: ref.m['FG-RL300'], status: 'RELEASED' });
    const nr = await api.as('engineer').ok('post', `/api/routings/${rt.id}/new-version`, { version: 'A2' });
    let r = await api.as('engineer').ok('post', `/api/routings/${nr.id}/submit`, { signature: SIG, change_reason: '增加老化时长' });
    expect(r.status).toBe('SUBMITTED');
    expect((await api.as('engineer').put(`/api/routings/${nr.id}`, { material_id: ref.m['FG-RL300'], version: 'A2', operations: [] })).body.detail)
      .toContain('待 QA 批准');
    expect((await api.as('qa').ok('get', '/api/todos')).find((x: any) => x.key === 'routing_submitted')?.count).toBe(1);
    r = await api.as('qa').ok('post', `/api/routings/${nr.id}/reject`, { reason: '缺少验证报告', signature: SIG });
    expect(r.status).toBe('DRAFT');
    expect(r.change_reason).toBe('增加老化时长'); // 驳回保留变更原因，修改后可直接再提交
    await api.as('engineer').ok('post', `/api/routings/${nr.id}/submit`, { signature: SIG });
    expect((await api.ok('get', `/api/routings/${rt.id}`)).status).toBe('RELEASED');
    r = await api.as('qa').ok('post', `/api/routings/${nr.id}/approve`, { signature: SIG });
    expect([r.status, r.released_by]).toEqual(['RELEASED', '赵QA']);
    expect((await api.ok('get', `/api/routings/${rt.id}`)).status).toBe('OBSOLETE');
  });

  test('P0-7 审计追踪：哈希链封存与完整性校验，能发现被篡改的记录', async () => {
    const { api } = t;
    await api.as('engineer').ok('post', '/api/materials', { code: 'X-AUD', name: '审计测试' });
    expect((await api.as('engineer').get('/api/system/audit-verify')).status).toBe(403);
    let v = await api.as('qa').ok('get', '/api/system/audit-verify');
    expect(v.ok).toBe(true);
    expect(v.problems).toEqual([]);
    expect(v.sealed_total).toBeGreaterThan(10);
    const total = v.sealed_total;
    // 新记录会被下一次封存接到链上
    await api.as('engineer').ok('post', '/api/materials', { code: 'X-AUD2', name: '审计测试2' });
    v = await api.as('admin').ok('get', '/api/system/audit-verify');
    expect(v.ok).toBe(true);
    expect(v.sealed_total).toBeGreaterThan(total);
    // 已封存的记录通过应用账号无法修改/删除（数据库触发器）
    const row = await t.db.base.auditLog.findFirstOrThrow({ where: { entity: 'md_material' }, orderBy: { id: 'desc' } });
    await expect(t.db.base.$executeRawUnsafe(`UPDATE "sys_audit_log" SET changes = '{}' WHERE id = ${row.id}`)).rejects.toThrow();
    await expect(t.db.base.$executeRawUnsafe(`DELETE FROM "sys_audit_log" WHERE id = ${row.id}`)).rejects.toThrow();
    // 有超级权限的人绕过触发器篡改一条记录 → 校验能发现
    await t.db.base.$transaction([
      t.db.base.$executeRawUnsafe('ALTER TABLE "sys_audit_log" DISABLE TRIGGER trg_audit_log_guard'),
      t.db.base.$executeRawUnsafe(`UPDATE "sys_audit_log" SET changes = '{"name":"被篡改"}' WHERE id = ${row.id}`),
      t.db.base.$executeRawUnsafe('ALTER TABLE "sys_audit_log" ENABLE TRIGGER trg_audit_log_guard'),
    ]);
    v = await api.as('qa').ok('get', '/api/system/audit-verify');
    expect(v.ok).toBe(false);
    expect(v.problems).toEqual([{ id: row.id, seal_no: row.seal_no, problem: '内容与哈希不符（记录被篡改）' }]);
    // 删除一条记录（链条断裂）也能发现
    const mid = await t.db.base.auditLog.findFirstOrThrow({ where: { seal_no: 3 } });
    await t.db.base.$transaction([
      t.db.base.$executeRawUnsafe('ALTER TABLE "sys_audit_log" DISABLE TRIGGER trg_audit_log_guard'),
      t.db.base.$executeRawUnsafe(`DELETE FROM "sys_audit_log" WHERE id = ${mid.id}`),
      t.db.base.$executeRawUnsafe('ALTER TABLE "sys_audit_log" ENABLE TRIGGER trg_audit_log_guard'),
    ]);
    v = await t.app.get(AuditSealService).verify();
    expect(v.problems.map((p: any) => p.seal_no)).toEqual([4, row.seal_no]);
    expect(v.problems[0].problem).toContain('不连续');
  });

  test('P1-11 密码策略、有效期（强制改密）与数据库锁定', async () => {
    const { api } = t;
    // 复杂度：至少 8 位且含字母和数字
    const tok = (await login('sales', DEMO_PASSWORD)).body.access_token;
    const change = (old_password: string, new_password: string) =>
      http().post('/api/auth/change-password').set(bearer(tok)).send({ old_password, new_password });
    expect((await change(DEMO_PASSWORD, 'abc123')).body.detail).toContain('至少 8 位');
    expect((await change(DEMO_PASSWORD, 'abcdefghij')).body.detail).toContain('字母和数字');
    expect((await change(DEMO_PASSWORD, DEMO_PASSWORD)).body.detail).toContain('不能与原密码相同');
    expect((await api.as('admin').post('/api/system/users', { username: 'weak', full_name: 'x', password: '12345678', roles: ['sales'] })).status).toBe(400);
    // 有效期：超过 90 天必须先改密码，其他接口 403
    await t.db.base.user.update({ where: { username: 'sales' }, data: { password_changed_at: new Date(Date.now() - 91 * 86400_000) } });
    const r = await login('sales', DEMO_PASSWORD);
    expect(r.status).toBe(200);
    expect(r.body.must_change_password).toBe(true);
    expect(r.body.user.must_change_password).toBe(true);
    const t2 = r.body.access_token;
    expect((await http().get('/api/auth/me').set(bearer(t2))).body.must_change_password).toBe(true);
    const denied = await http().get('/api/sales-orders').set(bearer(t2));
    expect(denied.status).toBe(403);
    expect(denied.body.detail).toContain('密码已过期');
    const ok = await http().post('/api/auth/change-password').set(bearer(t2)).send({ old_password: DEMO_PASSWORD, new_password: 'NewPass2026' });
    expect(ok.status).toBe(200);
    expect((await http().get('/api/sales-orders').set(bearer(t2))).status).toBe(200);
    expect((await userRow('sales')).password_changed_at!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    // 金蝶账号不受本系统密码有效期约束；0 = 关闭
    expect(passwordExpired({ auth_source: 'KINGDEE', password_changed_at: null })).toBe(false);
    expect(passwordExpired({ auth_source: 'LOCAL', password_changed_at: null })).toBe(true);
    const saved = config.passwordMaxAgeDays;
    config.passwordMaxAgeDays = 0;
    expect(passwordExpired({ auth_source: 'LOCAL', password_changed_at: null })).toBe(false);
    config.passwordMaxAgeDays = saved;

    // 锁定：连续 5 次失败锁定（存数据库），正确密码也不能登录；管理员保存用户即解锁
    for (let i = 0; i < 5; i++) expect((await login('pmc', 'wrong-pass1')).status).toBe(401);
    let u = await userRow('pmc');
    expect(u.locked_until!.getTime()).toBeGreaterThan(Date.now());
    const locked = await login('pmc', DEMO_PASSWORD);
    expect(locked.status).toBe(401);
    expect(locked.body.detail).toContain('已锁定');
    const listed = (await api.as('admin').ok('get', '/api/system/users', { q: 'pmc' })).items[0];
    expect(listed.locked).toBe(true);
    await api.as('admin').ok('put', `/api/system/users/${u.id}`, { username: 'pmc', full_name: u.full_name, roles: ['planner'] });
    u = await userRow('pmc');
    expect([u.failed_login_count, u.locked_until]).toEqual([0, null]);
    expect((await login('pmc', DEMO_PASSWORD)).status).toBe(200);
    // 登录成功清零失败计数
    await login('pmc', 'wrong-pass1');
    expect((await userRow('pmc')).failed_login_count).toBe(1);
    await login('pmc', DEMO_PASSWORD);
    expect((await userRow('pmc')).failed_login_count).toBe(0);
  });

  test('工牌登录：工牌号 + PIN；仅限有车间报工权限的启用用户；失败计入同一锁定；PIN 哈希不外泄', async () => {
    const { api } = t;
    const r = await badge('E1001', '1234');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['access_token', 'must_change_password', 'token_type', 'user']);
    expect(r.body.user).toMatchObject({ username: 'op1', full_name: '刘操作', login_method: 'badge', badge_no: 'E1001' });
    expect((await http().get('/api/auth/me').set(bearer(r.body.access_token))).body.username).toBe('op1');
    expect((await badge('E1002', '5678')).body.user.username).toBe('op2');
    let bad = await badge('E1001', '9999');
    expect(bad.status).toBe(401);
    expect(bad.body.detail).toBe('工牌号或 PIN 错误');
    expect((await badge('E9999', '1234')).status).toBe(401);
    // 工牌会话使用 PIN，不受密码有效期限制
    await t.db.base.user.update({ where: { username: 'op1' }, data: { password_changed_at: null } });
    const b2 = await badge('E1001', '1234');
    expect(b2.body.must_change_password).toBe(false);
    expect((await http().get('/api/work-orders').set(bearer(b2.body.access_token))).status).toBe(200);
    expect((await login('op1', DEMO_PASSWORD)).body.must_change_password).toBe(true);

    // 管理员为质检员设置工牌和 PIN：没有 mes 权限不能工牌登录
    const qc = await userRow('qc');
    const saved = await api.as('admin').ok('put', `/api/system/users/${qc.id}`, { username: 'qc', full_name: qc.full_name, roles: ['qc'], badge_no: 'E2001', pin: '2468' });
    expect(saved).toMatchObject({ badge_no: 'E2001', has_pin: true });
    expect(saved).not.toHaveProperty('pin_hash');
    bad = await badge('E2001', '2468');
    expect(bad.status).toBe(401);
    expect(bad.body.detail).toContain('没有车间报工权限');
    // PIN 格式、工牌号唯一
    expect((await api.as('admin').put(`/api/system/users/${qc.id}`, { username: 'qc', full_name: qc.full_name, roles: ['qc'], pin: '12ab' })).status).toBe(400);
    const dup = await api.as('admin').put(`/api/system/users/${qc.id}`, { username: 'qc', full_name: qc.full_name, roles: ['qc'], badge_no: 'E1001' });
    expect(dup.body.detail).toContain('已分配给用户');
    // 审计追踪只记录“已设置 PIN”，不含哈希
    const logs = (await api.ok('get', '/api/system/audit-logs', { entity: 'sys_user', entity_id: qc.id })).items;
    expect(logs.some((l: any) => JSON.parse(l.changes).pin)).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('$2');
    expect(JSON.stringify((await api.as('admin').ok('get', '/api/system/users')).items)).not.toContain('pin_hash');
    // 停用账号不能工牌登录
    const op2 = await userRow('op2');
    await api.as('admin').ok('put', `/api/system/users/${op2.id}`, { username: 'op2', full_name: op2.full_name, roles: ['operator'], is_active: false });
    expect((await badge('E1002', '5678')).body.detail).toBe('账号已停用');
    // PIN 错误计入同一锁定计数：锁定后密码登录也被拒绝
    for (let i = 0; i < 5; i++) await badge('E1001', '0000');
    expect((await login('op1', DEMO_PASSWORD)).body.detail).toContain('已锁定');
    expect((await badge('E1001', '1234')).body.detail).toContain('已锁定');
    const audit = (await api.ok('get', '/api/system/audit-logs', { entity: 'sys_login', username: 'op1' })).items;
    expect(audit.filter((l: any) => l.action === 'LOGIN' && JSON.parse(l.changes).source === 'BADGE').length).toBeGreaterThanOrEqual(2);
  });

  test('登录选项（空闲超时、密码策略）与安全响应头', async () => {
    const o = await http().get('/api/auth/options');
    expect(o.body).toMatchObject({ idle_minutes: 30, password_policy: { min_length: 8, require_letter_digit: true, max_age_days: 90 } });
    expect(o.headers['x-content-type-options']).toBe('nosniff');
    expect(o.headers['x-frame-options']).toBe('DENY');
    expect(o.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(o.headers['content-security-policy']).toContain("script-src 'self'");
    expect(o.headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline'");
    expect(o.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(o.headers['cache-control']).toBe('no-store');
    expect(o.headers['x-powered-by']).toBeUndefined();
    // 错误响应同样带安全头
    const e = await http().get('/api/materials');
    expect(e.status).toBe(401);
    expect(e.headers['x-frame-options']).toBe('DENY');
  });
});
