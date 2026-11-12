/**
 * 第三轮复核遗留的两个 P1：
 *   C-R3-1 管理员设置/重置的工位 PIN：本人重设前，工牌会话只能改 PIN，不能调用业务接口（后端强制）；
 *   E-R3-1 已审批采购单变更后金额达到大额标准且金额增加：须厂长重新审批。
 */
import request from 'supertest';
import { bootApp, SIG } from './harness';

let t: Awaited<ReturnType<typeof bootApp>>;
beforeAll(async () => (t = await bootApp()));
beforeEach(() => t.reset());
afterAll(() => t.close());
const http = () => request(t.app.getHttpServer());

test('C-R3-1 临时 PIN 的工牌会话不能报工，改 PIN 后放行', async () => {
  const u = await t.api.as('admin').ok('post', '/api/system/users', { username: 'newop', full_name: '新操作员', roles: ['operator'], badge_no: 'E9001', generate_password: true });
  const login = await http().post('/api/auth/badge-login').send({ badge_no: 'E9001', pin: u.temp_pin });
  const auth = { Authorization: `Bearer ${login.body.access_token}` };
  let r = await http().get('/api/work-orders').set(auth);
  expect(r.status).toBe(403);
  expect(r.body.detail).toContain('须先设置本人的新 PIN');
  expect((await http().get('/api/auth/me').set(auth)).status).toBe(200);
  expect((await http().post('/api/auth/change-pin').set(auth).send({ old_pin: u.temp_pin, new_pin: '2468' })).status).toBe(200);
  r = await http().get('/api/work-orders').set(auth);
  expect(r.status).toBe(200);
});

test('E-R3-1 审批后变更越过大额标准须厂长重新审批；金额不增加不受影响', async () => {
  const { api } = t;
  const ref = await api.ids();
  const sup = await api.find('/api/suppliers', { q: 'S004' });
  const po = await api.as('buyer').ok('post', '/api/purchase-orders', { supplier_id: sup.id, lines: [{ material_id: ref.m['STAND-BL100'], qty: 100, unit_price: 160 }] }); // 16,000
  await api.as('buyer').ok('post', `/api/purchase-orders/${po.id}/approve`, {});
  const line = (await api.as('buyer').ok('get', `/api/purchase-orders/${po.id}`)).lines[0];
  // 小幅调整（仍低于 5 万）：照常
  let r = await api.as('buyer').ok('post', `/api/purchase-orders/${po.id}/change`, { reason: '数量调整', lines: [{ id: line.id, qty: 120 }] });
  expect(r.status).toBe('APPROVED');
  expect(r.change.reapproval).toBe(false);
  // 改到 64,000：退回待厂长审批，审批人清空，期间不能收货
  r = await api.as('buyer').ok('post', `/api/purchase-orders/${po.id}/change`, { reason: '追加数量', lines: [{ id: line.id, qty: 400 }] });
  expect(r.change.reapproval).toBe(true);
  expect(r.status).toBe('SUBMITTED');
  expect(r.approved_by).toBeNull();
  expect((await api.as('buyer').post(`/api/purchase-orders/${po.id}/approve`, {})).status).toBe(400);
  const ok = await api.as('manager').ok('post', `/api/purchase-orders/${po.id}/approve`, { signature: SIG });
  expect(ok.status).toBe('APPROVED');
  expect(ok.approved_by).toBe('王厂长');
  // 厂长批准后采购员再加价：再次须厂长审批；降价不需要
  r = await api.as('buyer').ok('post', `/api/purchase-orders/${po.id}/change`, { reason: '议价下调', lines: [{ id: line.id, unit_price: 155 }] });
  expect(r.change.reapproval).toBe(false);
  r = await api.as('buyer').ok('post', `/api/purchase-orders/${po.id}/change`, { reason: '供应商涨价', lines: [{ id: line.id, unit_price: 170 }] });
  expect(r.status).toBe('SUBMITTED');
});
