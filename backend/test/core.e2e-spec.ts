/** 规则与基础设施：AQL、GTIN/UDI、认证、权限、主数据校验、审计追踪 */
import { samplingPlan } from '../src/core/aql';
import { buildUdi, gtinCheckDigit, isValidGtin, makeGtin14 } from '../src/core/udi';
import { dateOnly } from '../src/common/dates';
import { bootApp } from './harness';

describe('纯规则', () => {
  test('AQL 一般检验水平 II', () => {
    const p = (lot: number, aql: number) => samplingPlan(lot, aql);
    expect([p(1000, 1).code_letter, p(1000, 1).sample_size, p(1000, 1).accept_num, p(1000, 1).reject_num]).toEqual(['J', 80, 2, 3]);
    expect([p(500, 0.65).code_letter, p(500, 0.65).plan_letter, p(500, 0.65).sample_size, p(500, 0.65).accept_num]).toEqual(['H', 'J', 80, 1]);
    expect([p(60, 2.5).sample_size, p(60, 2.5).accept_num]).toEqual([20, 1]);
    expect(p(20000, 4).accept_num).toBe(21);
    const s = p(5, 1);
    expect(s.full_inspection && s.sample_size === 5 && s.accept_num === 0).toBe(true);
  });

  test('GTIN 与 UDI', () => {
    expect(gtinCheckDigit('629104150021')).toBe(3);
    expect(isValidGtin('6291041500213')).toBe(true);
    expect(isValidGtin('6291041500214')).toBe(false);
    const g = makeGtin14('697000000', '001');
    expect(g).toHaveLength(14);
    expect(isValidGtin(g)).toBe(true);
    expect(buildUdi(g, { mfg_date: dateOnly('2026-11-11'), expiry_date: dateOnly('2031-11-10'), lot: 'B261111001', serial: 'RL30001' }))
      .toBe(`(01)${g}(11)261111(17)311110(10)B261111001(21)RL30001`);
  });
});

describe('认证、权限、主数据', () => {
  let t: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => (t = await bootApp()));
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  test('登录与权限', async () => {
    const { api } = t;
    expect((await api.c_get_noauth('/api/materials')).status).toBe(401);
    expect((await api.c_login('admin', 'x')).status).toBe(401);
    const me = await api.as('qa').ok('get', '/api/auth/me');
    expect(me.permissions).toContain('qa');
    expect(me.permissions).not.toContain('admin');
    expect((await api.as('qa').get('/api/system/users')).status).toBe(403);
    const u = await api.ok('post', '/api/system/users', { username: 'op9', full_name: '新员工', password: 'abc12345', roles: ['operator'] });
    expect(u.roles).toBe('operator');
    expect((await api.post('/api/system/users', { username: 'op8', full_name: 'x', password: 'abc12345', roles: ['boss'] })).status).toBe(400);
  });

  test('物料校验、唯一性、删除保护、审计', async () => {
    const { api } = t;
    expect((await api.as('op1').post('/api/materials', { code: 'X1', name: '测试' })).status).toBe(403);
    let r = await api.as('engineer').post('/api/materials', { code: 'FG-X', name: '成品X', category: 'FINISHED', gtin: '06970000000011' });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('校验位');
    const m = await api.as('engineer').ok('post', '/api/materials', { code: 'FG-X', name: '成品X', category: 'FINISHED', serial_control: true });
    r = await api.as('engineer').post('/api/materials', { code: 'FG-X', name: '重复' });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('已存在');
    const led = await api.find('/api/materials', { q: 'LED-660-3030' });
    r = await api.as('engineer').del(`/api/materials/${led.id}`);
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('引用');
    await api.as('engineer').ok('put', `/api/materials/${m.id}`, { name: '成品X改' });
    const logs = (await api.ok('get', '/api/system/audit-logs', { entity: 'md_material', entity_id: m.id })).items;
    expect(logs.map((l: any) => l.action).sort()).toEqual(['CREATE', 'UPDATE']);
    expect(JSON.parse(logs.find((l: any) => l.action === 'UPDATE').changes).name).toEqual(['成品X', '成品X改']);
    expect(logs.every((l: any) => l.username === 'engineer')).toBe(true);
    await api.as('engineer').ok('delete', `/api/materials/${m.id}`);
    const eq = await api.find('/api/equipment', { q: 'EQ-SPEC-01' });
    expect(eq.next_calibration_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(eq.work_center_name).toBe('光学测试区');
  });
});
