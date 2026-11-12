/** R5 仓储 / PDA 第二轮：收货湿敏确认（confirm_placement）、拒绝提示的建议库位、盲盘录入后有收发须重新清点、待领料工单 */
import { bootApp, type Api } from './harness';

type T = Awaited<ReturnType<typeof bootApp>>;

async function po(api: Api, supplierCode: string, materialId: number, qty = 1000, price = 0.35) {
  const sup = await api.as('buyer').find('/api/suppliers', { q: supplierCode });
  const o = await api.as('buyer').ok('post', '/api/purchase-orders', { supplier_id: sup.id, lines: [{ material_id: materialId, qty, unit_price: price }] });
  await api.as('buyer').ok('post', `/api/purchase-orders/${o.id}/approve`);
  return o;
}

const qtyAt = async (api: Api, lot: string) =>
  Object.fromEntries((await api.as('wh').ok('get', '/api/stock', { lot_no: lot })).items.map((s: any) => [s.location_code, s.qty]));

describe('R5 仓储 / PDA', () => {
  let t: T;
  beforeAll(async () => (t = await bootApp()));
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  test('B-N1 收货：湿敏物料放非防潮柜须 confirm_placement，否则 400【需确认】；期初导入不要求', async () => {
    const { api } = t;
    const ref = await api.ids();
    const led = ref.m['LED-660-3030'];
    const line = { material_id: led, qty: 100, location_id: ref.loc['RAW-A01'], lot_no: 'MSL-OTHER-1' };
    let r = await api.as('wh').post('/api/receipts', { receipt_type: 'OTHER', lines: [line] });
    expect(r.status).toBe(400);
    expect(r.body.detail).toMatch(/^【需确认】第 1 行：LED-660-3030 是湿敏物料（MSL 3），RAW-A01 不是防潮柜/);
    expect(await qtyAt(api, 'MSL-OTHER-1')).toEqual({});
    const rc = await api.as('wh').ok('post', '/api/receipts', { receipt_type: 'OTHER', lines: [line], confirm_placement: true });
    expect(rc.lines[0].location_code).toBe('RAW-A01');
    // 采购收货同样拦截（采购单收货弹窗由 R2 传 confirm_placement）
    const o = await po(api, 'S001', led, 500);
    r = await api.as('wh').post(`/api/purchase-orders/${o.id}/receive`, { lines: [{ po_line_id: o.lines[0].id, qty: 500, location_id: ref.loc['RAW-A02'] }] });
    expect(r.status).toBe(400);
    expect(r.body.detail).toMatch(/^【需确认】/);
    expect(r.body.detail).toContain('RAW-A02');
    // 防潮柜不需要确认
    await api.as('wh').ok('post', `/api/purchase-orders/${o.id}/receive`, { lines: [{ po_line_id: o.lines[0].id, qty: 500, location_id: ref.loc['DRY-01'] }] });
    // 期初：按实际存放位置记账，不要求确认
    await api.as('wh').ok('post', '/api/receipts', { receipt_type: 'OPENING', lines: [{ ...line, lot_no: 'MSL-OPEN-1' }] });
    expect(await qtyAt(api, 'MSL-OPEN-1')).toEqual({ 'RAW-A01': 100 });
  });

  test('N14 拒绝提示建议合适库位：普通物料建议普通存储库位，不建议防潮柜；有默认库位时建议默认库位', async () => {
    const { api } = t;
    const ref = await api.ids();
    const screw = ref.m['SCREW-M3X8'];
    let chk = await api.as('wh').ok('post', '/api/wms/placement-check', { material_id: screw, location_code: 'CS-01' });
    expect(chk.errors[0]).toContain('如 RAW-A01');
    expect(chk.errors[0]).not.toContain('DRY-01');
    await api.as('engineer').ok('put', `/api/materials/${screw}`, { default_location_id: ref.loc['RAW-A02'] });
    chk = await api.as('wh').ok('post', '/api/wms/placement-check', { material_id: screw, location_code: 'CS-01' });
    expect(chk.errors[0]).toContain('如 RAW-A02');
    // 湿敏物料仍建议防潮柜；客供料建议客供料仓
    chk = await api.as('wh').ok('post', '/api/wms/placement-check', { material_id: ref.m['LED-850-3030'], location_code: 'CS-01' });
    expect(chk.errors[0]).toContain('如 DRY-01');
    chk = await api.as('wh').ok('post', '/api/wms/placement-check', { material_id: ref.m['PKG-RL300-BOX'], location_code: 'RAW-A01' });
    expect(chk.errors[0]).toContain('如 CS-01');
  });

  test('B-N6 盲盘：录入实盘后又有收发 → 标记须重新清点（不泄露账面），过账被拦截；重录后可过账', async () => {
    const { api } = t;
    const ref = await api.ids();
    const raw = await api.as('wh').find('/api/warehouses', { q: 'WH-RAW' });
    const sc = await api.as('wh').ok('post', '/api/stock-counts', { warehouse_id: raw.id, location_ids: [ref.loc['DRY-01']], blind: true });
    const l660 = sc.lines.find((l: any) => l.lot_no === 'JG2609-660A');
    const l850 = sc.lines.find((l: any) => l.lot_no === 'JG2609-850A');
    let d = await api.as('wh').ok('put', `/api/stock-counts/${sc.id}/lines`, [{ id: l660.id, counted_qty: 3000 }]);
    expect(d.lines.every((l: any) => !l.recount && !l.moved)).toBe(true);
    // 录入后调走 100（660），未录入的 850 也调走 50
    for (const [lot, q] of [['JG2609-660A', 100], ['JG2609-850A', 50]] as [string, number][]) {
      const st = (await api.as('wh').ok('get', '/api/stock', { lot_no: lot })).items[0];
      await api.as('wh').ok('post', '/api/stock/transfer', { stock_id: st.id, qty: q, to_location_id: ref.loc['LINE-01'] });
    }
    d = await api.as('wh').ok('get', `/api/stock-counts/${sc.id}`);
    const a = d.lines.find((l: any) => l.id === l660.id);
    const b = d.lines.find((l: any) => l.id === l850.id);
    expect([a.recount, a.moved, a.system_qty, a.current_qty]).toEqual([true, true, null, null]); // 盲盘不返回账面
    expect([b.recount, b.moved]).toEqual([false, true]); // 未录入：按现在的实物清点即可
    expect([d.recount_count, d.moved_count]).toEqual([1, 2]);
    let r = await api.as('wh').post(`/api/stock-counts/${sc.id}/post`, { uncounted_as_book: true });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('请重新清点后再过账：DRY-01 LED-660-3030 批次 JG2609-660A');
    expect(r.body.detail).not.toMatch(/2900|3000/); // 不泄露账面
    // 重新清点
    d = await api.as('wh').ok('put', `/api/stock-counts/${sc.id}/lines`, [{ id: l660.id, counted_qty: 2898 }]);
    expect(d.lines.find((l: any) => l.id === l660.id).recount).toBe(false);
    const posted = await api.as('wh').ok('post', `/api/stock-counts/${sc.id}/post`, { uncounted_as_book: true });
    expect(posted.status).toBe('POSTED');
    expect(await qtyAt(api, 'JG2609-660A')).toEqual({ 'DRY-01': 2898, 'LINE-01': 100 });
    expect(await qtyAt(api, 'JG2609-850A')).toEqual({ 'DRY-01': 2950, 'LINE-01': 50 });
  });

  test('N13 待领料工单：已下达且有未领物料、未被待过账领料单覆盖', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const wo = await db.client.workOrder.create({
      data: {
        no: 'WO-R5-1', material_id: ref.m['SA-RL300-LB'], planned_qty: 2, status: 'RELEASED', lot_no: 'B-R5-1',
        materials: { create: [{ material_id: ref.m['PCB-AL-300'], qty_per: 1, required_qty: 2 }, { material_id: ref.m['IC-DRV-CC'], qty_per: 4, required_qty: 8 }] },
      },
    });
    let c = await api.as('wh').ok('get', '/api/wms/issue-candidates');
    const hit = c.find((x: any) => x.id === wo.id);
    expect([hit.no, hit.lines, hit.has_draft, hit.materials]).toEqual(['WO-R5-1', 2, false, ['PCB-AL-300', 'IC-DRV-CC']]);
    await api.as('wh').ok('post', `/api/work-orders/${wo.id}/issues`, {});
    c = await api.as('wh').ok('get', '/api/wms/issue-candidates');
    expect(c.find((x: any) => x.id === wo.id)).toBeUndefined();
  });
});
