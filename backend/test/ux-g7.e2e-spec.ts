/** G7 仓储 / PDA 好用性修复：库位规则、盘点（单一进行中 / 按当前账面过账 / 作废 / 盲盘 / 范围 / 盘盈行）、拣料模式、冲销、扫码校验、待上架、金额权限 */
import { InventoryService } from '../src/core/inventory.service';
import { bootApp, SIG, type Api } from './harness';

type T = Awaited<ReturnType<typeof bootApp>>;

async function po(api: Api, supplierCode: string, materialId: number, qty = 1000, price = 0.35) {
  const sup = await api.find('/api/suppliers', { q: supplierCode });
  const o = await api.as('buyer').ok('post', '/api/purchase-orders', { supplier_id: sup.id, lines: [{ material_id: materialId, qty, unit_price: price }] });
  await api.as('buyer').ok('post', `/api/purchase-orders/${o.id}/approve`);
  return o;
}

const stockOf = async (api: Api, lot: string) => (await api.ok('get', '/api/stock', { lot_no: lot })).items;
const qtyAt = async (api: Api, lot: string) => Object.fromEntries((await stockOf(api, lot)).map((s: any) => [s.location_code, s.qty]));

describe('G7 仓储 / PDA', () => {
  let t: T;
  beforeAll(async () => (t = await bootApp()));
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  test('WH-02 库位规则：自有料不进客供仓、客供料不进自有仓；湿敏物料需确认；默认库位带出', async () => {
    const { api } = t;
    const ref = await api.ids();
    const led = ref.m['LED-660-3030'];
    const o = await po(api, 'S001', led, 1000);
    // 采购（自有）LED 收进客供料仓 → 拒绝，并给出建议库位
    let r = await api.as('wh').post(`/api/purchase-orders/${o.id}/receive`, { lines: [{ po_line_id: o.lines[0].id, qty: 500, location_id: ref.loc['CS-01'] }] });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('是公司自有物料，不能放入客供料仓库位 CS-01');
    expect(r.body.detail).toContain('DRY-01');
    // 客供料收进自有原材料仓 → 拒绝
    const c1 = await api.find('/api/customers', { q: 'C001' });
    r = await api.as('wh').post('/api/receipts', { receipt_type: 'CUSTOMER_SUPPLIED', customer_id: c1.id, lines: [{ material_id: ref.m['PKG-RL300-IFU'], qty: 10, location_id: ref.loc['RAW-A01'] }] });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('是客供料（货主：Lumina Health Inc.），不能放入自有仓库位 RAW-A01');
    // 收货上下文：建议库位（湿敏 → 防潮柜）
    const ctx = await api.as('wh').ok('get', '/api/wms/receive-context', { po: o.no });
    expect([ctx.po.no, ctx.lines[0].remaining, ctx.lines[0].suggest_location.code, ctx.lines[0].msl_level]).toEqual([o.no, 1000, 'DRY-01', '3']);
    expect((await api.as('wh').get('/api/wms/receive-context', { po: 'PO-NOPE' })).body.detail).toContain('未找到采购订单');
    // 库位校验接口：湿敏物料放普通库位 → 警告（需确认）；客供仓 → 错误
    let chk = await api.as('wh').ok('post', '/api/wms/placement-check', { material_id: led, location_code: 'raw-a01' });
    expect([chk.ok, chk.errors.length, chk.warnings[0]]).toEqual([true, 0, expect.stringContaining('湿敏物料（MSL 3）')]);
    chk = await api.as('wh').ok('post', '/api/wms/placement-check', { material_id: led, location_code: 'CS-01' });
    expect(chk.ok).toBe(false);
    chk = await api.as('wh').ok('post', '/api/wms/placement-check', { material_id: led, location_code: 'XX-99' });
    expect(chk.errors[0]).toContain('库位“XX-99”不存在');
    // 默认库位优先
    await api.as('engineer').ok('put', `/api/materials/${ref.m['FAN-6015-24V']}`, { default_location_id: ref.loc['RAW-A01'] });
    expect((await api.ok('get', '/api/wms/suggest-location', { material_id: ref.m['FAN-6015-24V'] })).code).toBe('RAW-A01');
    // 调拨：湿敏物料到普通库位需确认；自有料到客供仓拒绝
    const st = (await stockOf(api, 'JG2609-660A'))[0];
    r = await api.as('wh').post('/api/stock/transfer', { stock_id: st.id, qty: 100, to_location_id: ref.loc['RAW-A01'] });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('请确认后再提交');
    r = await api.as('wh').post('/api/stock/transfer', { stock_id: st.id, to_location_id: ref.loc['CS-01'] });
    expect(r.body.detail).toContain('不能放入客供料仓');
    await api.as('wh').ok('post', '/api/stock/transfer', { stock_id: st.id, qty: 100, to_location_id: ref.loc['RAW-A01'], confirm: true });
    expect(await qtyAt(api, 'JG2609-660A')).toEqual({ 'DRY-01': 2900, 'RAW-A01': 100 });
    // 待上架：湿敏物料不在防潮柜 → 建议 DRY-01；数量为空 = 整行上架
    const pa = await api.as('wh').ok('get', '/api/wms/putaway');
    const row = pa.items.find((x: any) => x.lot_no === 'JG2609-660A');
    expect([row.location_code, row.suggest_location_code, row.putaway_reason]).toEqual(['RAW-A01', 'DRY-01', '湿敏物料（MSL 3）不在防潮柜']);
    await api.as('wh').ok('post', '/api/stock/transfer', { stock_id: row.id, to_location_id: ref.loc['DRY-01'] });
    expect(await qtyAt(api, 'JG2609-660A')).toEqual({ 'DRY-01': 3000 });
    // 扫码解析
    expect((await api.ok('get', '/api/wms/scan', { code: 'dry-01' })).kind).toBe('LOCATION');
    expect((await api.ok('get', '/api/wms/scan', { code: 'JG2609-660A' })).rows[0].qty).toBe(3000);
  });

  test('库存金额字段按权限隐藏', async () => {
    const { api } = t;
    const wh = (await api.as('wh').ok('get', '/api/stock', { lot_no: 'JG2609-660A' })).items[0];
    expect([wh.amount, wh.unit_cost]).toEqual([undefined, undefined]);
    const fin = (await api.as('finance').ok('get', '/api/stock', { lot_no: 'JG2609-660A' })).items[0];
    expect(fin.amount).toBe(1050);
    expect((await api.as('wh').ok('get', '/api/stock/summary'))[0].amount).toBeUndefined();
    expect((await api.as('manager').ok('get', '/api/stock/summary'))[0].amount).toBeDefined();
  });

  test('WH-03 盘点：同一范围只允许一张进行中；按当前账面过账；作废；盲盘；新增盘盈行；冲销', async () => {
    const { api } = t;
    const ref = await api.ids();
    const raw = await api.find('/api/warehouses', { q: 'WH-RAW' });
    const sc1 = await api.as('wh').ok('post', '/api/stock-counts', { warehouse_id: raw.id, location_ids: [ref.loc['DRY-01']] });
    expect(sc1.range_codes).toEqual(['DRY-01']);
    expect(sc1.lines.map((l: any) => l.lot_no)).toEqual(['JG2608-460B', 'JG2609-660A', 'JG2609-850A']); // 库位→物料→批号
    // 整仓与已有范围重叠 → 拒绝；不重叠的范围可以
    let r = await api.as('wh').post('/api/stock-counts', { warehouse_id: raw.id });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain(`已有进行中的盘点单 ${sc1.no}`);
    r = await api.as('wh').post('/api/stock-counts', { warehouse_id: raw.id, location_ids: [ref.loc['DRY-01'], ref.loc['RAW-A01']] });
    expect(r.body.detail).toContain('重叠库位 DRY-01');
    const sc2 = await api.as('wh').ok('post', '/api/stock-counts', { warehouse_id: raw.id, location_ids: [ref.loc['RAW-A01']], blind: true });
    // 盲盘：进行中不返回账面；复核时返回
    expect(sc2.lines.every((l: any) => l.system_qty === null && l.diff_qty === null)).toBe(true);
    expect((await api.ok('get', `/api/stock-counts/${sc2.id}`, { review: 1 })).lines[0].system_qty).toBeGreaterThan(0);
    // 作废后可以重新建
    await api.as('wh').ok('post', `/api/stock-counts/${sc2.id}/cancel`, { reason: '范围建错' });
    expect((await api.as('wh').post(`/api/stock-counts/${sc2.id}/post`)).body.detail).toBe('盘点单已作废，不能过账');

    // 快照后发生流水：JG2609-850A 快照 3000，之后调走 200（账面 2800），实盘 2800 → 不应再扣
    const st850 = (await stockOf(api, 'JG2609-850A'))[0];
    await api.as('wh').ok('post', '/api/stock/transfer', { stock_id: st850.id, qty: 200, to_location_id: ref.loc['LINE-01'] });
    let d = await api.ok('get', `/api/stock-counts/${sc1.id}`);
    const l850 = d.lines.find((l: any) => l.lot_no === 'JG2609-850A');
    expect([l850.system_qty, l850.current_qty, l850.moved]).toEqual([3000, 2800, true]);
    expect(d.moved_count).toBe(1);
    // 只录两行 → 不确认则拒绝；确认“未盘按账面”后过账
    const l660 = d.lines.find((l: any) => l.lot_no === 'JG2609-660A');
    d = await api.as('wh').ok('put', `/api/stock-counts/${sc1.id}/lines`, [{ id: l850.id, counted_qty: 2800 }, { id: l660.id, counted_qty: 2990 }]);
    expect(d.lines.find((l: any) => l.id === l850.id).diff_qty).toBe(0);
    // 盘盈行：账上没有的批次
    d = await api.as('wh').ok('post', `/api/stock-counts/${sc1.id}/add-line`, { material_id: ref.m['LED-850-3030'], location_id: ref.loc['DRY-01'], lot_no: 'FOUND-1', counted_qty: 30 });
    expect(d.lines.find((l: any) => l.lot_no === 'FOUND-1').system_qty).toBe(0);
    r = await api.as('wh').post(`/api/stock-counts/${sc1.id}/add-line`, { material_id: ref.m['LED-850-3030'], location_id: ref.loc['RAW-A02'], lot_no: 'X', counted_qty: 1 });
    expect(r.body.detail).toContain('不在本盘点单的范围内');
    r = await api.as('wh').post(`/api/stock-counts/${sc1.id}/post`);
    expect(r.body.detail).toContain('还有 1 行未录入实盘数量');
    const posted = await api.as('wh').ok('post', `/api/stock-counts/${sc1.id}/post`, { uncounted_as_book: true });
    expect(posted.status).toBe('POSTED');
    expect(await qtyAt(api, 'JG2609-850A')).toEqual({ 'DRY-01': 2800, 'LINE-01': 200 });
    expect(await qtyAt(api, 'JG2609-660A')).toEqual({ 'DRY-01': 2990 });
    expect(await qtyAt(api, 'JG2608-460B')).toEqual({ 'DRY-01': 1500 });
    expect(await qtyAt(api, 'FOUND-1')).toEqual({ 'DRY-01': 30 });
    expect(Object.fromEntries(posted.lines.map((l: any) => [l.lot_no, l.diff_qty]))).toEqual({ 'JG2608-460B': 0, 'JG2609-660A': -10, 'JG2609-850A': 0, 'FOUND-1': 30 });
    // 冲销：需原因 + 电子签名；反向流水
    r = await api.as('wh').post(`/api/stock-counts/${sc1.id}/reverse`, { reason: '', signature: SIG });
    expect(r.body.detail).toBe('请填写冲销原因');
    r = await api.as('wh').post(`/api/stock-counts/${sc1.id}/reverse`, { reason: '录错', signature: { password: 'bad' } });
    expect(r.status).toBe(400);
    const rev = await api.as('wh').ok('post', `/api/stock-counts/${sc1.id}/reverse`, { reason: '实盘录错，重盘', signature: SIG });
    expect([rev.status, rev.reversed_by, rev.reverse_reason]).toEqual(['REVERSED', '郑仓管', '实盘录错，重盘']);
    expect(await qtyAt(api, 'JG2609-660A')).toEqual({ 'DRY-01': 3000 });
    expect(await stockOf(api, 'FOUND-1')).toEqual([]);
    const moves = (await api.ok('get', '/api/stock-moves', { move_type: 'ADJUST_REVERSE' })).items;
    expect(moves).toHaveLength(2);
    expect((await api.as('wh').post(`/api/stock-counts/${sc1.id}/reverse`, { reason: 'x', signature: SIG })).body.detail).toContain('只有已过账的盘点单才能冲销');
  });

  test('WH-05 拣料模式：实拣不足自动从下一 FEFO 批次补足、扫其他批次替换、部分过账；WH-17 已有待过账领料单提示；WH-15 领料冲销', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const LED = ref.m['LED-660-3030'];
    const c1 = await api.find('/api/customers', { q: 'C001' });
    // 第二个合格批次（晚到期）
    await t.db.tx((tx) => t.app.get(InventoryService).addStock(tx, {
      material_id: LED, location_id: ref.loc['DRY-01'], lot_no: 'LATE-660', status: 'AVAILABLE', qty: 500, move_type: 'OPENING', ref: { ref_no: 'T' },
      expiry_date: new Date(Date.UTC(2030, 0, 1)),
    }));
    const wo = await db.client.workOrder.create({
      data: {
        no: 'WO-PK-1', material_id: ref.m['FG-RL300'], customer_id: c1.id, planned_qty: 1, status: 'RELEASED', lot_no: 'B-PK-1',
        materials: { create: [{ material_id: LED, qty_per: 100, required_qty: 100 }, { material_id: ref.m['FAN-6015-24V'], qty_per: 2, required_qty: 2 }] },
      },
    });
    const issue = await api.as('wh').ok('post', `/api/work-orders/${wo.id}/issues`, {});
    expect(issue.lines.map((l: any) => [l.lot_no, l.qty])).toEqual([['JG2609-660A', 100], ['HY2609F', 2]]);
    // 已有待过账领料单时再生成 → 明确提示单号
    let r = await api.as('wh').post(`/api/work-orders/${wo.id}/issues`, {});
    expect(r.body.detail).toContain(`已有待过账领料单 ${issue.no}`);
    const ledLine = issue.lines[0];
    // 实拣 60 → 差 40 自动从 LATE-660 补
    let p = await api.as('wh').ok('post', `/api/issues/${issue.id}/pick`, { line_id: ledLine.id, picked_qty: 60 });
    expect(p.messages.join()).toContain('LATE-660');
    expect(p.issue.lines.map((l: any) => [l.lot_no, l.qty, l.picked_qty])).toEqual([['JG2609-660A', 60, 60], ['HY2609F', 2, null], ['LATE-660', 40, null]]);
    r = await api.as('wh').post(`/api/issues/${issue.id}/pick`, { line_id: ledLine.id, picked_qty: 61 });
    expect(r.body.detail).toContain('超过应拣');
    // 未拣完不能直接过账；部分过账 → 未拣行转入新领料单
    r = await api.as('wh').post(`/api/issues/${issue.id}/confirm`);
    expect(r.body.detail).toContain('还有 2 行未拣');
    const late = p.issue.lines.find((l: any) => l.lot_no === 'LATE-660');
    p = await api.as('wh').ok('post', `/api/issues/${issue.id}/pick`, { line_id: late.id, picked_qty: 40 });
    const done = await api.as('wh').ok('post', `/api/issues/${issue.id}/confirm`, { partial: true });
    expect(done.status).toBe('CONFIRMED');
    expect(done.lines.map((l: any) => [l.lot_no, l.qty])).toEqual([['JG2609-660A', 60], ['LATE-660', 40]]);
    const rest = (await api.ok('get', '/api/issues', { wo_id: wo.id, status: 'DRAFT' })).items;
    expect(rest.map((x: any) => x.lines.map((l: any) => [l.lot_no, l.qty]))).toEqual([[['HY2609F', 2]]]);
    // 替换批次：扫到其他风扇批次
    await t.db.tx((tx) => t.app.get(InventoryService).addStock(tx, {
      material_id: ref.m['FAN-6015-24V'], location_id: ref.loc['RAW-A01'], lot_no: 'FAN-ALT', status: 'AVAILABLE', qty: 5, move_type: 'OPENING', ref: { ref_no: 'T' },
    }));
    const alt = (await stockOf(api, 'FAN-ALT'))[0];
    p = await api.as('wh').ok('post', `/api/issues/${rest[0].id}/replace`, { line_id: rest[0].lines[0].id, stock_id: alt.id });
    expect(p.issue.lines.map((l: any) => [l.lot_no, l.location_code, l.qty])).toEqual([['FAN-ALT', 'RAW-A01', 2]]);
    await api.as('wh').ok('post', `/api/issues/${rest[0].id}/confirm`);
    expect(await qtyAt(api, 'FAN-ALT')).toEqual({ 'RAW-A01': 3 });
    let mats = await db.client.workOrderMaterial.findMany({ where: { wo_id: wo.id }, orderBy: { id: 'asc' } });
    expect(mats.map((m) => m.issued_qty)).toEqual([100, 2]);
    // 冲销领料单：库存加回、工单已领回滚
    r = await api.as('wh').post(`/api/issues/${issue.id}/reverse`, { reason: '领错工单' });
    expect(r.body.detail).toContain('需要电子签名');
    const rev = await api.as('wh').ok('post', `/api/issues/${issue.id}/reverse`, { reason: '领错工单', signature: SIG });
    expect(rev.status).toBe('REVERSED');
    expect(await qtyAt(api, 'LATE-660')).toEqual({ 'DRY-01': 500 });
    expect(await qtyAt(api, 'JG2609-660A')).toEqual({ 'DRY-01': 3000 });
    mats = await db.client.workOrderMaterial.findMany({ where: { wo_id: wo.id }, orderBy: { id: 'asc' } });
    expect(mats.map((m) => m.issued_qty)).toEqual([0, 2]);
    expect((await api.ok('get', '/api/stock-moves', { ref_no: issue.no, move_type: 'ISSUE_REVERSE' })).total).toBe(2);
    expect((await api.as('wh').post(`/api/issues/${issue.id}/reverse`, { reason: 'x', signature: SIG })).body.detail).toContain('只有已过账的单据才能冲销');
    const sigs = (await api.as('admin').ok('get', '/api/system/esignatures', { entity: 'wms_issue' })).items;
    expect(sigs[0].meaning).toBe('领料单冲销');
  });

  test('发货扫码校验、运单补录、发货冲销（红字应收）、RMA 扫码带出客户', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const inv = t.app.get(InventoryService);
    const so = await api.as('wh').ok('get', `/api/sales-orders/${(await api.as('wh').find('/api/sales-orders', { q: 'LUM-PO-26-118' })).id}`);
    const fg = ref.m['FG-RL300'];
    const wo = await db.client.workOrder.create({
      data: { no: 'WO-SH-1', material_id: fg, customer_id: so.customer_id, so_id: so.id, planned_qty: 4, completed_qty: 4, status: 'COMPLETED', lot_no: 'B-SH-1' },
    });
    const rel = await db.client.productRelease.create({ data: { no: 'FX-SH-1', wo_id: wo.id, qty: 2, status: 'RELEASED', released_by: 'QA', released_at: new Date() } });
    for (let i = 1; i <= 4; i++) {
      await db.client.serialNumber.create({
        data: { sn: `SH100${i}`, wo_id: wo.id, material_id: fg, lot_no: 'B-SH-1', status: i <= 3 ? 'IN_STOCK' : 'COMPLETED', location_id: i <= 3 ? ref.loc['FG-01'] : null, release_id: i <= 2 ? rel.id : null },
      });
    }
    await db.tx((tx) => inv.addStock(tx, { material_id: fg, location_id: ref.loc['FG-01'], lot_no: 'B-SH-1', status: 'AVAILABLE', qty: 2, move_type: 'FG_RECEIPT', ref: { ref_no: 'T' } }));
    const chk = (sn: string) => api.ok('get', '/api/wms/serial-check', { sn, so_id: so.id });
    expect((await chk('SH1001')).ok).toBe(true);
    expect((await chk('SH1003')).reason).toBe('NOT_RELEASED');
    expect((await chk('SH1004')).reason).toBe('NOT_IN_STOCK');
    expect((await chk('JG2609-660A')).reason).toBe('LOT');
    expect((await chk('ZZZ')).reason).toBe('NOT_FOUND');
    const sh = await api.as('wh').ok('post', '/api/shipments', { so_id: so.id, lines: [{ so_line_id: so.lines[0].id, qty: 2, serials: ['SH1001', 'SH1002'] }] });
    expect((await chk('SH1001')).reason).toBe('IN_DRAFT');
    await api.as('wh').ok('post', `/api/shipments/${sh.id}/confirm`);
    const shipped = await chk('SH1001');
    expect([shipped.reason, shipped.message]).toEqual(['SHIPPED', expect.stringContaining(sh.no)]);
    // 运单号补录
    const tr = await api.as('wh').ok('put', `/api/shipments/${sh.id}/tracking`, { carrier: '顺丰速运', tracking_no: 'SF123' });
    expect([tr.carrier, tr.tracking_no, tr.status]).toEqual(['顺丰速运', 'SF123', 'SHIPPED']);
    // RMA 扫码带出客户、订单、发货单
    const info = await api.ok('get', '/api/wms/rma-scan', { code: 'SH1001' });
    expect([info.customer_id, info.so_no, info.shipment_no, info.lot_no]).toEqual([so.customer_id, so.no, sh.no, 'B-SH-1']);
    expect((await api.get('/api/wms/rma-scan', { code: 'SH1003' })).body.detail).toContain('不是已发货产品');
    // 冲销发货：序列号回库、订单已发数量回滚、红字应收
    const rev = await api.as('wh').ok('post', `/api/shipments/${sh.id}/reverse`, { reason: '发错客户', signature: SIG });
    expect(rev.status).toBe('REVERSED');
    const sns = await db.client.serialNumber.findMany({ where: { sn: { in: ['SH1001', 'SH1002'] } } });
    expect(sns.map((s) => [s.status, s.shipment_id, s.customer_id])).toEqual([['IN_STOCK', null, null], ['IN_STOCK', null, null]]);
    expect((await stockOf(api, 'B-SH-1'))[0].qty).toBe(2);
    const so2 = await api.as('wh').ok('get', `/api/sales-orders/${so.id}`);
    expect([so2.status, so2.lines[0].shipped_qty]).toEqual(['IN_PRODUCTION', 0]);
    const ars = (await api.as('finance').ok('get', '/api/finance/docs', { doc_type: 'AR' })).items;
    expect(ars.map((a: any) => a.amount).sort((a: number, b: number) => a - b)).toEqual([-176, 176]);
    expect((await chk('SH1001')).ok).toBe(true);
  });

  test('WH-19 完工入库逐台扫码核对', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const fg = ref.m['FG-RL300'];
    const wo = await db.client.workOrder.create({ data: { no: 'WO-FG-1', material_id: fg, planned_qty: 3, completed_qty: 3, status: 'COMPLETED', lot_no: 'B-FG-1' } });
    for (let i = 1; i <= 3; i++) await db.client.serialNumber.create({ data: { sn: `FG100${i}`, wo_id: wo.id, material_id: fg, lot_no: 'B-FG-1', status: 'COMPLETED' } });
    let r = await api.as('wh').post('/api/wms/fg-receipt', { wo_id: wo.id, location_id: ref.loc['CS-01'], serials: ['FG1001'] });
    expect(r.body.detail).toContain('不能放入客供料仓');
    r = await api.as('wh').post('/api/wms/fg-receipt', { wo_id: wo.id, location_id: ref.loc['FG-01'], serials: ['FG1001', 'NOPE'] });
    expect(r.body.detail).toBe('序列号 NOPE 不属于工单 WO-FG-1');
    const rc = await api.as('wh').ok('post', '/api/wms/fg-receipt', { wo_id: wo.id, location_id: ref.loc['FG-01'], serials: ['FG1003', 'FG1001'] });
    expect([rc.receipt_type, rc.lines[0].qty, rc.lines[0].status]).toEqual(['PRODUCTION', 2, 'QUARANTINE']);
    const sns = await db.client.serialNumber.findMany({ where: { wo_id: wo.id }, orderBy: { sn: 'asc' } });
    expect(sns.map((s) => s.status)).toEqual(['IN_STOCK', 'COMPLETED', 'IN_STOCK']);
    expect((await db.client.workOrder.findUnique({ where: { id: wo.id } }))!.received_qty).toBe(2);
  });
});
