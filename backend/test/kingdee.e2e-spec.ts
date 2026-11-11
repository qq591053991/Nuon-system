/** 金蝶云星空账号登录：用模拟的 K/3 Cloud WebAPI（ValidateUser / Logout）验证集成行为 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { config } from '../src/config';
import { EsignService } from '../src/core/esign.service';
import { bootApp } from './harness';

const ACCT = '6512f3a0c1b2d4';
const KD_USERS: Record<string, { pwd: string; id: number; name: string }> = {
  zhangsan: { pwd: 'Kd@123456', id: 100231, name: '张三' },
  '李四': { pwd: 'lisi888', id: 100232, name: '李四' },
};

describe('金蝶云星空账号登录', () => {
  let t: Awaited<ReturnType<typeof bootApp>>;
  let kd: Server;
  let kdUrl = '';
  const calls: { path: string; body: any; cookie?: string }[] = [];
  const saved = { ...config.kingdee };

  beforeAll(async () => {
    kd = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        calls.push({ path: req.url || '', body, cookie: req.headers.cookie });
        res.setHeader('Content-Type', 'application/json');
        if (req.url?.endsWith('AuthService.ValidateUser.common.kdsvc')) {
          const u = KD_USERS[body.username];
          if (body.acctID !== ACCT) return res.end(JSON.stringify({ LoginResultType: 0, Message: '数据中心不存在' }));
          if (!u || u.pwd !== body.password) return res.end(JSON.stringify({ LoginResultType: 0, Message: '用户名或密码错误！' }));
          res.setHeader('Set-Cookie', ['kdservice-sessionid=abc123; path=/', 'ASP.NET_SessionId=xyz; path=/; HttpOnly']);
          return res.end(JSON.stringify({ LoginResultType: 1, Message: null, IsSuccessByAPI: true, Context: { UserId: u.id, UserName: u.name } }));
        }
        if (req.url?.endsWith('AuthService.Logout.common.kdsvc')) return res.end('true');
        res.statusCode = 404;
        res.end('{}');
      });
    });
    await new Promise<void>((r) => kd.listen(0, '127.0.0.1', () => r()));
    kdUrl = `http://127.0.0.1:${(kd.address() as AddressInfo).port}/k3cloud`;
    t = await bootApp();
  });
  beforeEach(async () => {
    await t.reset();
    calls.length = 0;
    Object.assign(config.kingdee, { enabled: true, url: kdUrl, acctId: ACCT, autoCreate: true, defaultRoles: '', timeoutMs: 3000 });
  });
  afterAll(async () => {
    Object.assign(config.kingdee, saved);
    await t.close();
    kd.close();
  });

  const login = (username: string, password: string) => request(t.app.getHttpServer()).post('/api/auth/login').send({ username, password });
  const asToken = (tok: string) => ({ Authorization: `Bearer ${tok}` });

  test('金蝶账号首次登录自动开通；未分配角色不能访问业务数据；分配角色后可用', async () => {
    expect((await request(t.app.getHttpServer()).get('/api/auth/options')).body).toMatchObject({ kingdee_enabled: true, kingdee_name: '金蝶云星空' });
    const r = await login('zhangsan', 'Kd@123456');
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ username: 'zhangsan', full_name: '张三', roles: [], auth_source: 'KINGDEE' });
    const v = calls.find((c) => c.path.endsWith('ValidateUser.common.kdsvc'))!;
    expect(v.body).toEqual({ acctID: ACCT, username: 'zhangsan', password: 'Kd@123456', lcid: 2052 });
    const tok = r.body.access_token;
    expect((await request(t.app.getHttpServer()).get('/api/auth/me').set(asToken(tok))).status).toBe(200);
    const denied = await request(t.app.getHttpServer()).get('/api/materials').set(asToken(tok));
    expect(denied.status).toBe(403);
    expect(denied.body.detail).toContain('尚未分配角色');
    // 本系统不保存金蝶密码
    const row = await t.db.base.user.findUnique({ where: { username: 'zhangsan' } });
    expect(row).toMatchObject({ auth_source: 'KINGDEE', external_id: '100231', password_hash: '!kingdee' });
    // 管理员分配角色
    await t.api.ok('put', `/api/system/users/${row!.id}`, { username: 'zhangsan', full_name: '张三', roles: ['warehouse'] });
    expect((await request(t.app.getHttpServer()).get('/api/materials').set(asToken(tok))).status).toBe(200);
    // 再次登录不重复建号；中文用户名也支持
    expect((await login('zhangsan', 'Kd@123456')).status).toBe(200);
    expect((await login('李四', 'lisi888')).body.user.full_name).toBe('李四');
    expect(await t.db.base.user.count({ where: { auth_source: 'KINGDEE' } })).toBe(2);
    // 登录成功后释放金蝶会话（带上金蝶返回的 cookie 调用 Logout）
    await new Promise((r2) => setTimeout(r2, 100));
    const out = calls.filter((c) => c.path.endsWith('Logout.common.kdsvc'));
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0].cookie).toContain('kdservice-sessionid=abc123');
  });

  test('金蝶密码错误、连续失败锁定、登录审计', async () => {
    // 锁定状态存数据库（按本系统账号记录）：先首次登录开通账号
    expect((await login('zhangsan', 'Kd@123456')).status).toBe(200);
    let r = await login('zhangsan', 'wrong');
    expect(r.status).toBe(401);
    expect(r.body.detail).toBe('金蝶云星空：用户名或密码错误！');
    for (let i = 0; i < 4; i++) await login('zhangsan', 'wrong');
    r = await login('zhangsan', 'Kd@123456');
    expect(r.status).toBe(401);
    expect(r.body.detail).toContain('已锁定');
    const logs = (await t.api.ok('get', '/api/system/audit-logs', { entity: 'sys_login' })).items;
    expect(logs.filter((l: any) => l.action === 'LOGIN_FAILED' && l.username === 'zhangsan').length).toBe(5);
    expect(logs.some((l: any) => l.action === 'LOGIN' && l.username === 'admin')).toBe(true);
  });

  test('金蝶服务不可用时返回明确提示，本地管理员仍可登录；本地账号不走金蝶', async () => {
    config.kingdee.url = 'http://127.0.0.1:9/k3cloud';
    const r = await login('zhangsan', 'Kd@123456');
    expect(r.status).toBe(503);
    expect(r.body.detail).toContain('无法连接金蝶云星空');
    expect((await login('admin', 'Nuon@2026')).status).toBe(200);
    config.kingdee.url = kdUrl;
    expect((await login('qa', 'Nuon@2026')).status).toBe(200);
    expect(calls.length).toBe(0);
  });

  test('关闭自动开通 / 关闭金蝶登录', async () => {
    config.kingdee.autoCreate = false;
    let r = await login('zhangsan', 'Kd@123456');
    expect(r.status).toBe(401);
    expect(r.body.detail).toContain('尚未开通');
    config.kingdee.enabled = false;
    r = await login('zhangsan', 'Kd@123456');
    expect(r.status).toBe(401);
    expect(r.body.detail).toBe('用户名或密码错误');
  });

  test('金蝶用户电子签名使用金蝶密码；不能在本系统改密码；管理员可预先开通金蝶账号并分配角色', async () => {
    const u = await t.api.ok('post', '/api/system/users', { username: 'zhangsan', full_name: '张三', roles: ['qa'], auth_source: 'KINGDEE' });
    expect(u.auth_source).toBe('KINGDEE');
    const r = await login('zhangsan', 'Kd@123456');
    expect(r.body.user.permissions).toContain('qa');
    const tok = r.body.access_token;
    const cp = await request(t.app.getHttpServer()).post('/api/auth/change-password').set(asToken(tok)).send({ old_password: 'x', new_password: 'yyyyyy' });
    expect(cp.status).toBe(400);
    expect(cp.body.detail).toContain('金蝶');
    const esign = t.app.get(EsignService);
    const user = (await t.db.base.user.findUnique({ where: { username: 'zhangsan' } }))!;
    await expect(t.db.tx((tx) => esign.sign(tx, user, { password: 'Nuon@2026' }, '测试签名', 'eng_bom', 1))).rejects.toThrow();
    const sig = await t.db.tx((tx) => esign.sign(tx, user, { password: 'Kd@123456', reason: 'ok' }, '测试签名', 'eng_bom', 1));
    expect(sig).toMatchObject({ username: 'zhangsan', full_name: '张三', meaning: '测试签名' });
  });
});
