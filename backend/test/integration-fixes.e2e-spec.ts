/** 评审改进集成修复：退料冲减追溯/DHR、MRP 周次字段、检验方法随检验单保存、分批放行待办 */
import { bootApp, SIG } from './harness';

describe('评审改进集成修复', () => {
  let t: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => (t = await bootApp()));
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  test('退料冲减：已全部退回的批次不进入 DHR 与批次追溯，已领数量同步冲减', async () => {
    const { api } = t;
    const ref = await api.ids();
    let wo = await api.as('pmc').ok('post', '/api/work-orders', { material_id: ref.m['FG-RL300'], planned_qty: 2 });
    wo = await api.as('pmc').ok('post', `/api/work-orders/${wo.id}/release`);
    const issue = await api.as('wh').ok('post', `/api/work-orders/${wo.id}/issues`, {});
    await api.as('wh').ok('post', `/api/issues/${issue.id}/confirm`);
    const psu = issue.lines.find((l: any) => l.material_code === 'PSU-24V-5A');
    const screw = issue.lines.find((l: any) => l.material_code === 'SCREW-M3X8');
    // 电源全部退回，螺丝退回 5 颗
    const ret = await api.as('wh').ok('post', `/api/work-orders/${wo.id}/returns`, {
      lines: [
        { material_id: psu.material_id, lot_no: psu.lot_no, location_id: psu.location_id, qty: psu.qty },
        { material_id: screw.material_id, lot_no: screw.lot_no, location_id: screw.location_id, qty: 5 },
      ],
    });
    await api.as('wh').ok('post', `/api/issues/${ret.id}/confirm`);

    const dhr = await api.ok('get', `/api/work-orders/${wo.id}/dhr`);
    const mats = Object.fromEntries(dhr.materials.map((m: any) => [m.material_code, m]));
    expect(mats['PSU-24V-5A']).toBeUndefined();
    expect(mats['SCREW-M3X8'].qty).toBe(screw.qty - 5);

    const lot = await api.ok('get', '/api/trace/lot', { material_code: 'PSU-24V-5A', lot_no: psu.lot_no });
    expect(lot.work_orders.find((w: any) => w.id === wo.id)).toBeUndefined();

    // 工单用料的已领数量同步冲减为 0
    const issuedNet = await t.db.client.workOrderMaterial.findFirst({ where: { wo_id: wo.id, material_id: psu.material_id } });
    expect(issuedNet!.issued_qty).toBe(0);
  });

  test('MRP 建议的需求日期与周次存于独立字段', async () => {
    const { api } = t;
    const so = await api.find('/api/sales-orders', { q: 'LUM-PO-26-131' });
    await api.as('sales').ok('post', `/api/sales-orders/${so.id}/confirm`);
    const run = await api.as('pmc').ok('post', '/api/mrp/run');
    expect(run.suggestions.length).toBeGreaterThan(0);
    for (const s of run.suggestions) {
      expect(s.week).toMatch(/^\d{4}-W\d{2}$/);
      expect(s.required_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(String(s.remark ?? '')).not.toMatch(/^需求日期/);
    }
    const row = await t.db.client.mrpSuggestion.findFirst({ where: { run_id: run.id } });
    expect(row!.week).toMatch(/^\d{4}-W\d{2}$/);
    expect(row!.required_date).toBeInstanceOf(Date);
  });

  test('IQC 检验单保存检验方法（规范日后修改不影响已生成的记录）', async () => {
    const { api } = t;
    const ref = await api.ids();
    const led = ref.m['LED-850-3030'];
    await api.as('qa').ok('put', `/api/materials/${led}/inspection-items`, {
      items: [{ name: '峰值波长', standard: '850±10nm', method: '光谱仪抽测 5 颗' }, { name: '外观', standard: '无破损', method: '目视' }],
      signature: SIG,
    });
    const sup = await api.find('/api/suppliers', { q: 'S001' });
    const po = await api.as('buyer').ok('post', '/api/purchase-orders', { supplier_id: sup.id, lines: [{ material_id: led, qty: 1000, unit_price: 0.42 }] });
    await api.as('buyer').ok('post', `/api/purchase-orders/${po.id}/approve`);
    await api.as('wh').ok('post', `/api/purchase-orders/${po.id}/receive`, {
      lines: [{ po_line_id: po.lines[0].id, qty: 1000, location_id: ref.loc['DRY-01'], lot_no: 'METHOD-1' }],
    });
    const insp = await api.find('/api/inspections', { q: 'METHOD-1' });
    const detail = await api.ok('get', `/api/inspections/${insp.id}`);
    expect(detail.items.map((i: any) => [i.name, i.method])).toEqual([['峰值波长', '光谱仪抽测 5 颗'], ['外观', '目视']]);
    expect(detail.items.every((i: any) => typeof i.spec_item_id === 'number')).toBe(true);
    // 修改规范后，已生成检验单的方法不变
    await api.as('qa').ok('put', `/api/materials/${led}/inspection-items`, { items: [{ name: '峰值波长', method: '积分球全检' }], signature: SIG });
    const again = await api.ok('get', `/api/inspections/${insp.id}`);
    expect(again.items[0].method).toBe('光谱仪抽测 5 颗');
  });

  test('QA 待办与驾驶舱“待放行”包含可分批放行的生产中工单', async () => {
    const { api } = t;
    const ref = await api.ids();
    await t.db.client.workOrder.create({
      data: { no: 'WO-PART-1', material_id: ref.m['FG-RL300'], planned_qty: 10, completed_qty: 3, received_qty: 3, released_qty: 1, status: 'IN_PROGRESS', dhr_status: 'OPEN', lot_no: 'BPART1' },
    });
    const todos = await api.as('qa').ok('get', '/api/todos');
    expect(todos.find((x: any) => x.key === 'dhr')?.count).toBe(1);
    const d = await api.as('manager').ok('get', '/api/dashboard');
    expect(d.kpi.pending_release).toBe(1);
  });
});
