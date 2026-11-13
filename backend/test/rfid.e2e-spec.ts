/**
 * RFID（仓库）端到端测试：读写器密钥校验与心跳、去重与 RSSI 过滤、收货台发卡生成入库单、库门待确认 → 确认后才移库、
 * 领料核对（多读/少读/读错批次）、发货核对（多读/少读/未放行）、盘点对账（读到/没读到/不在此库位 → 盘点单过账）、原始读取不可改。
 */
import request from 'supertest';
import { InventoryService } from '../src/core/inventory.service';
import { bootApp, type Api } from './harness';

type T = Awaited<ReturnType<typeof bootApp>>;
type Ref = Awaited<ReturnType<Api['ids']>>;

const KEY = { rcv: 'demo-reader-key-rcv-01', gate: 'demo-reader-key-gate-raw', ship: 'demo-reader-key-ship-01', hh: 'demo-reader-key-hh-01' };

const qtyAt = async (api: Api, lot: string) => Object.fromEntries((await api.ok('get', '/api/stock', { lot_no: lot })).items.map((s: any) => [`${s.location_code}/${s.status}`, s.qty]));

describe('RFID 仓库作业', () => {
  let t: T;
  let readers: Record<string, any>;
  const push = (key: string | null, body: unknown) => {
    const r = request(t.app.getHttpServer()).post('/api/rfid/readings');
    if (key !== null) r.set('X-Reader-Key', key);
    return r.send(body as object);
  };
  const tagsOf = async (lot: string) => (await t.api.as('wh').ok('get', '/api/rfid/tags', { lot_no: lot, status: 'ACTIVE' })).items as any[];
  const sim = (reader: string, reads: { epc: string; antenna?: number; rssi?: number }[], session_id?: number) =>
    t.api.as('wh').ok('post', '/api/rfid/simulate', { reader_id: readers[reader].id, reads, ...(session_id ? { session_id } : {}) });
  const detail = (id: number) => t.api.as('wh').ok('get', `/api/rfid/sessions/${id}`);

  beforeAll(async () => (t = await bootApp()));
  beforeEach(async () => {
    await t.reset();
    readers = Object.fromEntries((await t.api.as('wh').ok('get', '/api/rfid/readers')).map((r: any) => [r.code, r]));
  });
  afterAll(() => t.close());

  test('读写器密钥校验、心跳、无进行中作业；原始读取不可修改/删除', async () => {
    expect(Object.keys(readers).sort()).toEqual(['RD-GATE-RAW', 'RD-HH-01', 'RD-RCV-01', 'RD-SHIP-01']);
    expect(readers['RD-RCV-01'].key_hash).toBeUndefined(); // 密钥只存哈希且不返回
    const epc = '4E5501000000000000000001';
    let r = await push(null, { reads: [{ epc }] });
    expect([r.status, r.body.detail]).toEqual([401, expect.stringContaining('X-Reader-Key')]);
    r = await push('wrong-key', { reads: [{ epc }] });
    expect([r.status, r.body.detail]).toEqual([401, expect.stringContaining('密钥无效')]);
    r = await push(KEY.rcv, { reader_code: 'RD-SHIP-01', reads: [{ epc }] });
    expect([r.status, r.body.detail]).toEqual([401, expect.stringContaining('与请求中的 RD-SHIP-01 不符')]);
    // 收货台没有进行中的作业：自动开“识别中”会话（识别不出单据时给出提示）
    r = await push(KEY.rcv, { reader_code: 'RD-RCV-01', reads: [{ epc, antenna: 1, rssi: -50 }, { epc: 'xyz' }] });
    expect(r.status).toBe(200);
    expect([r.body.no_session, r.body.accepted, r.body.invalid, r.body.recognized]).toEqual([0, 1, ['xyz'], null]);
    expect(r.body.hint).toContain('没有包含这些批次的待过账领料单'); // 读到的是期初库存的包装标签
    const hb = await request(t.app.getHttpServer()).post('/api/rfid/heartbeat').set('X-Reader-Key', KEY.rcv).send({});
    expect([hb.status, hb.body.reader_code, hb.body.session.session_type]).toEqual([200, 'RD-RCV-01', 'AUTO']);
    expect((await t.api.as('wh').ok('get', '/api/rfid/overview')).readers.find((x: any) => x.code === 'RD-RCV-01').online).toBe(true);
    // 停用后拒绝
    await t.api.as('wh').ok('put', `/api/rfid/readers/${readers['RD-RCV-01'].id}`, { is_active: false });
    expect((await push(KEY.rcv, { reads: [{ epc }] })).status).toBe(403);
    // 重新生成密钥：旧密钥失效
    await t.api.as('wh').ok('put', `/api/rfid/readers/${readers['RD-RCV-01'].id}`, { is_active: true });
    const rot = await t.api.as('wh').ok('post', `/api/rfid/readers/${readers['RD-RCV-01'].id}/rotate-key`);
    expect(rot.key).toMatch(/^rk_/);
    expect((await push(KEY.rcv, { reads: [{ epc }] })).status).toBe(401);
    expect((await push(rot.key, { reads: [{ epc }] })).status).toBe(200);
    // 没有 wms 权限不能管理读写器 / 模拟读取
    expect((await t.api.as('sales').get('/api/rfid/readers')).status).toBe(403);
    expect((await t.api.as('sales').post('/api/rfid/simulate', { reader_id: readers['RD-RCV-01'].id, reads: [] })).status).toBe(403);
    // 原始读取是电子记录：数据库禁止修改/删除
    const raw = await t.db.base.rfidRead.findFirstOrThrow();
    await expect(t.db.base.rfidRead.update({ where: { id: raw.id }, data: { rssi: -10 } })).rejects.toThrow(/电子记录不可修改或删除/);
    await expect(t.db.base.rfidRead.delete({ where: { id: raw.id } })).rejects.toThrow(/电子记录不可修改或删除/);
    const reads = await t.api.as('wh').ok('get', '/api/rfid/reads', { reader_id: readers['RD-RCV-01'].id });
    expect(reads.items.map((x: any) => x.result)).toContain('ACCEPTED');
  });

  test('收货台：去重与 RSSI 过滤、未登记标签单独列出；新标签绑定到货明细 → 确认生成入库单并发卡（湿敏库位须确认）', async () => {
    const { api } = t;
    const ref: Ref = await api.ids();
    const sup = await api.find('/api/suppliers', { q: 'S001' });
    const po = await api.as('buyer').ok('post', '/api/purchase-orders', { supplier_id: sup.id, lines: [{ material_id: ref.m['LED-660-3030'], qty: 1000, unit_price: 0.35 }] });
    await api.as('buyer').ok('post', `/api/purchase-orders/${po.id}/approve`);
    let s = await api.as('wh').ok('post', '/api/rfid/sessions', { session_type: 'RECEIVE', reader_id: readers['RD-RCV-01'].id, po_id: po.id });
    expect([s.session.status, s.check.po.no, s.check.lines[0].remaining, s.check.lines[0].suggest_location.code]).toEqual(['OPEN', po.no, 1000, 'DRY-01']);
    // 同一读写器不能同时开两个作业
    expect((await api.as('wh').post('/api/rfid/sessions', { session_type: 'RECEIVE', reader_id: readers['RD-RCV-01'].id, po_id: po.id })).body.detail).toContain('正在用于收货作业');
    const [A, B] = ['E2806894000050001111AAAA', 'E2806894000050001111BBBB'];
    const old = (await tagsOf('JG2609-660A'))[0];
    // 读写器推送：A 读 3 次（去重）、B 一次、弱信号一次（过滤）、旁边已贴标的料盘一次（不参与收货）
    const r = await push(KEY.rcv, {
      reads: [
        { epc: A, antenna: 1, rssi: -45 }, { epc: A.toLowerCase(), antenna: 1, rssi: -44 }, { epc: B, antenna: 1, rssi: -50 }, { epc: A, antenna: 1, rssi: -47 },
        { epc: 'E2806894000050001111CCCC', antenna: 1, rssi: -88 }, { epc: old.epc, antenna: 1, rssi: -60 },
      ],
    });
    expect([r.body.session_id, r.body.accepted, r.body.duplicates, r.body.low_rssi]).toEqual([s.session.id, 3, 2, 1]);
    expect(r.body.unknown.sort()).toEqual([A, B]);
    s = await detail(s.session.id);
    expect(s.items.length).toBe(3);
    expect(s.items.find((i: any) => i.epc === A).read_count).toBe(3);
    expect(s.items.find((i: any) => i.epc === old.epc).message).toContain('不参与本次收货');
    // 只有一行未收：第一包自动绑定（每包默认 = 最小包装量 1000，库位 = 建议库位 DRY-01）；该行已收满，第二包不自动绑
    expect(s.items.find((i: any) => i.epc === A)).toMatchObject({ po_line_id: s.check.lines[0].po_line_id, bind_qty: 1000, bind_location_code: 'DRY-01' });
    expect([s.check.bound, s.check.unbound]).toEqual([1, 1]);
    expect(s.can_confirm).toBe(false);
    expect(s.blockers[0]).toContain('还有 1 张新标签没有绑定');
    // 绑定到普通库位 RAW-A01（湿敏物料）→ 确认时须确认放置
    const line = s.check.lines[0];
    s = await api.as('wh').ok('post', `/api/rfid/sessions/${s.session.id}/bind`, { epcs: [A, B], po_line_id: line.po_line_id, qty: 500, supplier_lot: 'W2611-01', mfg_date: '2026-11-01', location_id: ref.loc['RAW-A01'] });
    expect(s.warnings[0]).toContain('湿敏物料');
    expect([s.check.bound, s.check.lines[0].bound_qty, s.can_confirm]).toEqual([2, 1000, true]);
    // 自有料不能绑定到客供仓（放置规则立即拦截）
    expect((await api.as('wh').post(`/api/rfid/sessions/${s.session.id}/bind`, { epcs: [A], po_line_id: line.po_line_id, qty: 500, location_id: ref.loc['CS-01'] })).body.detail).toContain('不能放入客供料仓');
    let c = await api.as('wh').post(`/api/rfid/sessions/${s.session.id}/confirm`, {});
    expect([c.status, c.body.detail]).toEqual([400, expect.stringContaining('【需确认】')]);
    // 改绑防潮柜后确认
    await api.as('wh').ok('post', `/api/rfid/sessions/${s.session.id}/bind`, { epcs: [A, B], po_line_id: line.po_line_id, qty: 500, supplier_lot: 'W2611-01', mfg_date: '2026-11-01', location_id: ref.loc['DRY-01'] });
    c = await api.as('wh').post(`/api/rfid/sessions/${s.session.id}/confirm`, { delivery_note: 'DN-RFID-1' });
    expect(c.status).toBe(200);
    expect([c.body.session.status, c.body.result.tags, c.body.session.ref_type]).toEqual(['CONFIRMED', 2, 'RECEIPT']);
    const rc = await api.as('wh').ok('get', `/api/receipts/${c.body.result.receipt_id}`);
    expect([rc.po_no, rc.delivery_note, rc.lines.length, rc.lines[0].qty, rc.lines[0].status, rc.lines[0].location_code]).toEqual([po.no, 'DN-RFID-1', 1, 1000, 'QUARANTINE', 'DRY-01']);
    const lot = rc.lines[0].lot_no;
    expect(lot).toBeTruthy(); // 批号自动生成并写到标签上
    const tags = await tagsOf(lot);
    expect(tags.map((x) => [x.epc, x.qty, x.location_code, x.tag_type, x.receipt_id]).sort()).toEqual([[A, 500, 'DRY-01', 'PACKAGE', rc.id], [B, 500, 'DRY-01', 'PACKAGE', rc.id]]);
    expect((await api.as('buyer').ok('get', `/api/purchase-orders/${po.id}`)).status).toBe('RECEIVED');
    expect((await api.as('qc').ok('get', '/api/inspections', { status: 'PENDING' })).items.some((x: any) => x.lot_no === lot)).toBe(true);
    // 已确认的作业不能再读、再确认
    expect((await api.as('wh').post(`/api/rfid/sessions/${s.session.id}/confirm`, {})).body.detail).toContain('已确认');
    const again = await push(KEY.rcv, { reads: [{ epc: A }] });
    expect(again.body.session_id).not.toBe(s.session.id); // 新开“识别中”会话
  });

  test('库门：过门生成待确认（不自动移库），仓管确认后才调拨；方向不明须选择或标记误读', async () => {
    const { api } = t;
    const cbl = (await tagsOf('HY2609C'))[0];
    const fan = (await tagsOf('HY2609F'))[0];
    expect(cbl.location_code).toBe('RAW-A02');
    // 先内侧（1）后外侧（2）= 出库；FAN 只被内侧读到 = 方向不明
    const r = await push(KEY.gate, { reads: [
      { epc: cbl.epc, antenna: 1, rssi: -50, ts: '2026-11-13T01:00:00Z' }, { epc: fan.epc, antenna: 1, rssi: -60, ts: '2026-11-13T01:00:00.500Z' },
      { epc: cbl.epc, antenna: 2, rssi: -49, ts: '2026-11-13T01:00:01Z' },
    ] });
    expect([r.status, r.body.accepted, r.body.duplicates]).toEqual([200, 2, 1]);
    const sid = r.body.session_id;
    let d = await detail(sid);
    expect(d.session.session_type).toBe('GATE');
    const ci = d.items.find((i: any) => i.epc === cbl.epc);
    expect([ci.direction, ci.antennas, ci.level, ci.to_location_code]).toEqual(['OUT', '1,2', 'ok', 'LINE-01']);
    expect(ci.message).toContain('RAW-A02 → LINE-01');
    expect(d.items.find((i: any) => i.epc === fan.epc).level).toBe('warn');
    expect(d.check).toMatchObject({ to_move: 1, unclear: 1 });
    // 未确认：库存不动
    expect(await qtyAt(api, 'HY2609C')).toEqual({ 'RAW-A02/AVAILABLE': 100 });
    expect((await api.as('wh').ok('get', '/api/rfid/overview')).gate_pending).toBe(2);
    // 方向不明的不能直接确认
    expect((await api.as('wh').post(`/api/rfid/sessions/${sid}/confirm`, { items: [{ epc: fan.epc }] })).body.detail).toContain('方向不明');
    // 确认出库
    d = await api.as('wh').ok('post', `/api/rfid/sessions/${sid}/confirm`, { items: [{ epc: cbl.epc }] });
    expect(d.result.moved).toBe(1);
    expect(await qtyAt(api, 'HY2609C')).toEqual({ 'LINE-01/AVAILABLE': 100 });
    expect((await api.ok('get', `/api/rfid/tags/${cbl.id}`)).location_code).toBe('LINE-01');
    expect((await api.ok('get', '/api/stock-moves', { lot_no: 'HY2609C', move_type: 'TRANSFER' })).total).toBe(1);
    expect(d.session.status).toBe('OPEN'); // 还有 FAN 待处理
    // 标记误读 → 这次过门结束
    d = await api.as('wh').ok('post', `/api/rfid/sessions/${sid}/ignore`, { epcs: [fan.epc] });
    expect(d.session.status).toBe('CONFIRMED');
    expect(await qtyAt(api, 'HY2609F')).toEqual({ 'RAW-A02/AVAILABLE': 80 });
    // 再次过门：先外侧后内侧 = 进库（回到库内默认库位 / 物料建议库位）
    const r2 = await sim('RD-GATE-RAW', [{ epc: cbl.epc, antenna: 2, rssi: -50 }, { epc: cbl.epc, antenna: 1, rssi: -50 }]);
    expect(r2.session_id).not.toBe(sid);
    d = await detail(r2.session_id);
    expect([d.items[0].direction, d.items[0].level]).toEqual(['IN', 'ok']);
    await api.as('wh').ok('post', `/api/rfid/sessions/${r2.session_id}/confirm`, { items: [{ epc: cbl.epc, to_location_id: (await api.ids()).loc['RAW-A02'] }] });
    expect(await qtyAt(api, 'HY2609C')).toEqual({ 'RAW-A02/AVAILABLE': 100 });
  });

  test('领料核对：多读、少读、读错批次明确提示；够数后拣料并过账，标签数量扣减', async () => {
    const { api } = t;
    const ref: Ref = await api.ids();
    const so = await api.as('sales').ok('get', `/api/sales-orders/${(await api.as('sales').find('/api/sales-orders', { q: 'GY-2026-0931' })).id}`);
    let wo = await api.as('pmc').ok('post', '/api/work-orders', { material_id: ref.m['FG-BL100'], planned_qty: 1, so_id: so.id, so_line_id: so.lines[0].id });
    wo = await api.as('pmc').ok('post', `/api/work-orders/${wo.id}/release`);
    const issue = await api.as('wh').ok('post', `/api/work-orders/${wo.id}/issues`, {});
    const ledLine = issue.lines.find((l: any) => l.material_code === 'LED-460-5050');
    expect(ledLine.lot_no).toBe('JG2608-460B');
    let s = await api.as('wh').ok('post', '/api/rfid/sessions', { session_type: 'ISSUE', reader_id: readers['RD-RCV-01'].id, issue_id: issue.id });
    const led = await tagsOf('JG2608-460B'); // 1000 + 500 两包
    const pcb = (await tagsOf('XD260918'))[0];
    const stand = (await tagsOf('JS2609ST'))[0];
    const led660 = (await tagsOf('JG2609-660A'))[0]; // 不在单上
    // LED 两包（第二包多读）、PCB 一包、外加一包不在单上的物料
    await sim('RD-RCV-01', [{ epc: led[0].epc }, { epc: led[1].epc }, { epc: pcb.epc }, { epc: led660.epc }], s.session.id);
    s = await detail(s.session.id);
    const msg = (epc: string) => s.items.find((i: any) => i.epc === epc).message;
    expect(msg(led[0].epc)).toContain('本次领');
    expect(msg(led[1].epc)).toContain('多读：批次 JG2608-460B 已够数');
    expect(msg(led660.epc)).toContain('多读：LED-660-3030 不在本领料单上');
    const lines = s.check.lines;
    expect(lines.find((l: any) => l.material_code === 'LED-460-5050').status).toBe('OK');
    const standLine = lines.find((l: any) => l.material_code === 'STAND-BL100');
    expect([standLine.status, standLine.message]).toEqual(['MISSING', expect.stringContaining('少读：应领 1，读到 0')]);
    expect(s.blockers[0]).toContain('不符合本次作业');
    expect((await api.as('wh').post(`/api/rfid/sessions/${s.session.id}/confirm`, {})).body.detail).toContain('多读/读错批次');
    // 读错批次：同物料其他批次
    const otherLot = await api.as('wh').ok('post', '/api/rfid/tags', { tag_type: 'PACKAGE', material_id: ref.m['STAND-BL100'], lot_no: 'JS-OTHER', qty: 5, location_id: ref.loc['RAW-A02'] });
    await sim('RD-RCV-01', [{ epc: otherLot.epc }], s.session.id);
    s = await detail(s.session.id);
    expect(s.items.find((i: any) => i.epc === otherLot.epc).message).toContain('读错批次：STAND-BL100 本单应领批次 JS2609ST，读到 JS-OTHER');
    // 标记误读（红色行一次清掉）
    s = await api.as('wh').ok('post', `/api/rfid/sessions/${s.session.id}/ignore`, { all_errors: true });
    expect(s.items.filter((i: any) => i.action === 'IGNORED').length).toBe(3);
    // 少读：不能整单过账
    expect((await api.as('wh').post(`/api/rfid/sessions/${s.session.id}/confirm`, {})).body.detail).toContain('行少读');
    // 兜底：手输批号（该批次只有一个包装标签）
    s = await api.as('wh').ok('post', `/api/rfid/sessions/${s.session.id}/manual`, { code: 'JS2609ST' });
    expect(s.manual.epc).toBe(stand.epc);
    expect(s.items.find((i: any) => i.epc === stand.epc).source).toBe('MANUAL');
    // 读完其余各行
    const rest = s.check.lines.filter((l: any) => l.status !== 'OK');
    const epcs: string[] = [];
    for (const l of rest) epcs.push(...(await tagsOf(l.lot_no)).filter((x) => x.material_code === l.material_code).map((x) => x.epc));
    await sim('RD-RCV-01', epcs.map((epc) => ({ epc })), s.session.id);
    s = await detail(s.session.id);
    expect(s.check.short_lines).toBe(0);
    // 同批次多包时多余的包须拿开
    if (s.blockers.length) s = await api.as('wh').ok('post', `/api/rfid/sessions/${s.session.id}/ignore`, { all_errors: true });
    const done = await api.as('wh').ok('post', `/api/rfid/sessions/${s.session.id}/confirm`, {});
    expect([done.session.status, done.result.issue_no]).toEqual(['CONFIRMED', issue.no]);
    expect((await api.ok('get', `/api/issues/${issue.id}`)).status).toBe('CONFIRMED');
    const ledAfter = (await api.ok('get', `/api/rfid/tags/${led[0].id}`));
    expect(ledAfter.qty).toBe(led[0].qty - ledLine.qty); // 先读到的那包扣减
    expect(await qtyAt(api, 'JG2608-460B')).toEqual({ 'DRY-01/AVAILABLE': 1500 - ledLine.qty });
  });

  test('发货核对：应发/读到/多出/缺少/未放行逐条列出，全部一致才能确认', async () => {
    const { api, db } = t;
    const ref: Ref = await api.ids();
    const inv = t.app.get(InventoryService);
    const so = await api.as('wh').ok('get', `/api/sales-orders/${(await api.as('wh').find('/api/sales-orders', { q: 'LUM-PO-26-118' })).id}`);
    const fg = ref.m['FG-RL300'];
    const wo = await db.client.workOrder.create({ data: { no: 'WO-RF-1', material_id: fg, customer_id: so.customer_id, so_id: so.id, planned_qty: 4, completed_qty: 4, status: 'COMPLETED', lot_no: 'B-RF-1' } });
    const rel = await db.client.productRelease.create({ data: { no: 'FX-RF-1', wo_id: wo.id, qty: 3, status: 'RELEASED', released_by: 'QA', released_at: new Date() } });
    for (let i = 1; i <= 4; i++) {
      await db.client.serialNumber.create({ data: { sn: `RF100${i}`, wo_id: wo.id, material_id: fg, lot_no: 'B-RF-1', status: 'IN_STOCK', location_id: ref.loc['FG-01'], release_id: i <= 3 ? rel.id : null } });
    }
    await db.tx((tx) => inv.addStock(tx, { material_id: fg, location_id: ref.loc['FG-01'], lot_no: 'B-RF-1', status: 'AVAILABLE', qty: 4, move_type: 'FG_RECEIPT', ref: { ref_no: 'T' } }));
    const iss = await api.as('wh').ok('post', '/api/rfid/tags/issue-serials', { wo_id: wo.id });
    expect(iss.created.length).toBe(4);
    const epc = Object.fromEntries(iss.created.map((x: any) => [x.sn, x.epc]));
    expect((await api.as('wh').post('/api/rfid/tags/issue-serials', { wo_id: wo.id })).body.detail).toContain('都已有启用的单台标签');
    const sh = await api.as('wh').ok('post', '/api/shipments', { so_id: so.id, lines: [{ so_line_id: so.lines[0].id, qty: 2, serials: ['RF1001', 'RF1002'] }] });
    let s = await api.as('wh').ok('post', '/api/rfid/sessions', { session_type: 'SHIP', reader_id: readers['RD-SHIP-01'].id, shipment_id: sh.id });
    // 读到：RF1001（应发）、RF1003（已放行但不在本单 = 多出）、RF1004（未放行）；缺 RF1002
    await sim('RD-SHIP-01', [{ epc: epc.RF1001 }, { epc: epc.RF1003 }, { epc: epc.RF1004 }, { epc: epc.RF1001 }], s.session.id);
    s = await detail(s.session.id);
    expect(s.check).toMatchObject({ expected: 2, read: 1, missing: ['RF1002'], extra: ['RF1003'], not_released: ['RF1004'], all_match: false });
    expect(s.items.find((i: any) => i.sn === 'RF1004').message).toContain('未放行');
    expect(s.items.find((i: any) => i.sn === 'RF1003').message).toContain('多出');
    expect(s.blockers.join('；')).toContain('缺少 1 台：RF1002');
    expect((await api.as('wh').post(`/api/rfid/sessions/${s.session.id}/confirm`, {})).status).toBe(400);
    // 拿开多出的，补读缺少的（标签损坏 → 手输序列号兜底）
    await api.as('wh').ok('post', `/api/rfid/sessions/${s.session.id}/ignore`, { all_errors: true });
    s = await api.as('wh').ok('post', `/api/rfid/sessions/${s.session.id}/manual`, { code: 'RF1002' });
    expect(s.check).toMatchObject({ expected: 2, read: 2, missing: [], all_match: true });
    expect(s.can_confirm).toBe(true);
    const done = await api.as('wh').ok('post', `/api/rfid/sessions/${s.session.id}/confirm`, {});
    expect([done.session.status, done.result.shipment_no]).toEqual(['CONFIRMED', sh.no]);
    expect((await api.ok('get', `/api/shipments/${sh.id}`)).status).toBe('SHIPPED');
    const tag = (await api.ok('get', '/api/rfid/tags/lookup', { code: 'RF1001' })).tags[0];
    expect([tag.sn_status, tag.location_id]).toEqual(['SHIPPED', null]);
  });

  test('盘点对账：手持机批量读取 → 读到 / 账面有没读到 / 读到但账面不在此库位 → 写入盘点单并按当前账面过账', async () => {
    const { api } = t;
    const ref: Ref = await api.ids();
    let s = await api.as('wh').ok('post', '/api/rfid/sessions', { session_type: 'COUNT', reader_id: readers['RD-HH-01'].id, location_id: ref.loc['RAW-A02'] });
    const here = (await api.as('wh').ok('get', '/api/rfid/tags', { location_id: ref.loc['RAW-A02'], page_size: 100 })).items as any[];
    const screws = here.filter((x) => x.lot_no === 'JS2609S');
    expect(screws.length).toBe(3);
    const missing = screws[2];
    const pcb = (await tagsOf('XD260915'))[0]; // 账面在 RAW-A01
    // 手持机上传（带会话号）
    const up = await push(KEY.hh, { session_id: s.session.id, reads: [...here.filter((x) => x.epc !== missing.epc).map((x) => ({ epc: x.epc, rssi: -55 })), { epc: pcb.epc, rssi: -58 }] });
    expect(up.body.accepted).toBe(here.length);
    s = await detail(s.session.id);
    expect(s.check.missing.map((x: any) => x.epc)).toEqual([missing.epc]);
    expect(s.check.read_elsewhere).toBe(1);
    expect(s.items.find((i: any) => i.epc === pcb.epc).message).toContain('读到但账面不在此库位（账面：RAW-A01）');
    const scr = s.check.lines.find((l: any) => l.lot_no === 'JS2609S');
    expect([scr.book_qty, scr.read_qty, scr.diff]).toEqual([3000, 2000, -1000]);
    // 确认并过账：螺丝盘亏 1000，PCB 在 RAW-A02 盘盈 40（RAW-A01 盘点时会盘亏）
    const done = await api.as('wh').ok('post', `/api/rfid/sessions/${s.session.id}/confirm`, { post: true });
    expect([done.session.status, done.result.count_status]).toEqual(['CONFIRMED', 'POSTED']);
    expect(await qtyAt(api, 'JS2609S')).toEqual({ 'RAW-A02/AVAILABLE': 2000 });
    expect(await qtyAt(api, 'XD260915')).toEqual({ 'RAW-A01/AVAILABLE': 40, 'RAW-A02/AVAILABLE': 40 });
    const sc = await api.as('wh').ok('get', `/api/stock-counts/${done.result.count_id}`);
    expect(sc.status).toBe('POSTED');
    expect(sc.range_codes).toEqual(['RAW-A02']);
    expect((await api.ok('get', `/api/rfid/tags/${pcb.id}`)).location_code).toBe('RAW-A02');
    // 同一库位再次 RFID 盘点（新盘点单）
    s = await api.as('wh').ok('post', '/api/rfid/sessions', { session_type: 'COUNT', reader_id: readers['RD-HH-01'].id, location_id: ref.loc['RAW-A02'] });
    expect(s.check.book_tags).toBe(here.length); // 漏读的那包已按盘亏移出此库位，PCB 那包已更新到此库位
    expect((await api.ok('get', `/api/rfid/tags/${missing.id}`)).location_id).toBeNull();
    // 漏读的那包找到了：再读到 = 读到但账面不在此库位（盘盈回来）
    await sim('RD-HH-01', [{ epc: missing.epc }], s.session.id);
    expect((await detail(s.session.id)).items[0].message).toContain('读到但账面不在此库位（账面：不在库）');
    await api.as('wh').ok('post', `/api/rfid/sessions/${s.session.id}/cancel`, { reason: '测试' });
  });

  test('标签数量按账面纠正：不经 RFID 的调拨/领用后，盘点不会按发卡数量误判盘盈', async () => {
    const { api } = t;
    const ref: Ref = await api.ids();
    const fan = (await tagsOf('HY2609F'))[0];
    expect(fan.qty).toBe(80);
    const st = (await api.ok('get', '/api/stock', { lot_no: 'HY2609F' })).items[0];
    await api.as('wh').ok('post', '/api/stock/transfer', { stock_id: st.id, qty: 30, to_location_id: ref.loc['RAW-A01'] }); // 电脑页面调拨（不经 RFID）
    let s = await api.as('wh').ok('post', '/api/rfid/sessions', { session_type: 'COUNT', reader_id: readers['RD-HH-01'].id, location_id: ref.loc['RAW-A02'] });
    await sim('RD-HH-01', [{ epc: fan.epc }], s.session.id);
    s = await detail(s.session.id);
    const it = s.items[0];
    expect([it.qty, it.tag_qty, it.qty_note]).toEqual([50, 80, '标签发卡 80，账面剩 50']);
    const line = s.check.lines.find((l: any) => l.lot_no === 'HY2609F');
    expect([line.book_qty, line.read_qty, line.diff]).toEqual([50, 50, 0]);
  });

  test('收货连续多包：多行时点一下物料，之后每包自动绑定（默认数量、沿用批号），收满一行自动转下一行', async () => {
    const { api } = t;
    const ref: Ref = await api.ids();
    const sup = await api.find('/api/suppliers', { q: 'S001' });
    const po = await api.as('buyer').ok('post', '/api/purchase-orders', { supplier_id: sup.id, lines: [
      { material_id: ref.m['LED-660-3030'], qty: 3000, unit_price: 0.35 }, { material_id: ref.m['LED-850-3030'], qty: 2000, unit_price: 0.42 },
    ] });
    await api.as('buyer').ok('post', `/api/purchase-orders/${po.id}/approve`);
    // 不先开作业：读到新标签 → 识别中；选采购单后转为收货（已读的标签保留）
    const T = (n: number) => `E28068940000500022220${n.toString(16).toUpperCase().padStart(3, '0')}`;
    const r0 = await push(KEY.rcv, { reads: [{ epc: T(1) }] });
    let s = await api.as('wh').ok('post', '/api/rfid/sessions', { session_type: 'RECEIVE', reader_id: readers['RD-RCV-01'].id, po_id: po.id });
    expect(s.session.id).toBe(r0.body.session_id);
    expect([s.check.unbound, s.check.bound]).toEqual([1, 0]); // 两行都未收：等仓管点物料
    const [l1, l2] = s.check.lines;
    // 点一下物料（第 1 行）→ 默认每包 1000（最小包装量）；改成本批号
    s = await api.as('wh').ok('post', `/api/rfid/sessions/${s.session.id}/bind`, { epcs: [T(1)], po_line_id: l1.po_line_id });
    expect(s.items[0]).toMatchObject({ bind_qty: 1000, bind_location_code: 'DRY-01' });
    s = await api.as('wh').ok('post', `/api/rfid/sessions/${s.session.id}/bind`, { epcs: [T(1)], po_line_id: l1.po_line_id, qty: 1000, lot_no: 'LOT-RF-1', supplier_lot: 'SUP-9' });
    // 连续两包：0 次输入，自动沿用第 1 行、每包 1000、批号 LOT-RF-1
    await push(KEY.rcv, { reads: [{ epc: T(2) }, { epc: T(3) }] });
    s = await detail(s.session.id);
    expect(s.items.slice(1).map((i: any) => [i.po_line_id, i.bind_qty, i.bind_lot_no, i.bind_supplier_lot])).toEqual([[l1.po_line_id, 1000, 'LOT-RF-1', 'SUP-9'], [l1.po_line_id, 1000, 'LOT-RF-1', 'SUP-9']]);
    // 第 1 行收满，只剩第 2 行 → 下一包自动绑第 2 行
    await push(KEY.rcv, { reads: [{ epc: T(4) }, { epc: T(5) }] });
    s = await detail(s.session.id);
    expect(s.items.slice(3).map((i: any) => [i.po_line_id, i.bind_qty])).toEqual([[l2.po_line_id, 1000], [l2.po_line_id, 1000]]);
    expect([s.check.unbound, s.can_confirm]).toEqual([0, true]);
    const c = await api.as('wh').ok('post', `/api/rfid/sessions/${s.session.id}/confirm`, {});
    const rc = await api.as('wh').ok('get', `/api/receipts/${c.result.receipt_id}`);
    expect(rc.lines.map((l: any) => [l.material_code, l.qty, l.lot_no === 'LOT-RF-1'])).toEqual([['LED-660-3030', 3000, true], ['LED-850-3030', 2000, false]]);
  });

  test('自动识别单据：发货口识别发货单（唯一/多张/没有）、完工入库、客户退货、领料单、手持机扫库位标签开盘点', async () => {
    const { api, db } = t;
    const ref: Ref = await api.ids();
    const inv = t.app.get(InventoryService);
    const so = await api.as('wh').ok('get', `/api/sales-orders/${(await api.as('wh').find('/api/sales-orders', { q: 'LUM-PO-26-118' })).id}`);
    const fg = ref.m['FG-RL300'];
    const wo = await db.client.workOrder.create({ data: { no: 'WO-AU-1', material_id: fg, customer_id: so.customer_id, so_id: so.id, planned_qty: 6, completed_qty: 6, status: 'COMPLETED', lot_no: 'B-AU-1' } });
    const rel = await db.client.productRelease.create({ data: { no: 'FX-AU-1', wo_id: wo.id, qty: 5, status: 'RELEASED', released_by: 'QA', released_at: new Date() } });
    for (let i = 1; i <= 6; i++) {
      await db.client.serialNumber.create({ data: { sn: `AU00${i}`, wo_id: wo.id, material_id: fg, lot_no: 'B-AU-1', status: i <= 5 ? 'IN_STOCK' : 'COMPLETED', location_id: i <= 5 ? ref.loc['FG-01'] : null, release_id: i <= 5 ? rel.id : null } });
    }
    await db.tx((tx) => inv.addStock(tx, { material_id: fg, location_id: ref.loc['FG-01'], lot_no: 'B-AU-1', status: 'AVAILABLE', qty: 5, move_type: 'FG_RECEIPT', ref: { ref_no: 'T' } }));
    const epc = Object.fromEntries((await api.as('wh').ok('post', '/api/rfid/tags/issue-serials', { wo_id: wo.id })).created.map((x: any) => [x.sn, x.epc]));
    const sh1 = await api.as('wh').ok('post', '/api/shipments', { so_id: so.id, lines: [{ so_line_id: so.lines[0].id, qty: 2, serials: ['AU001', 'AU002'] }] });
    const sh2 = await api.as('wh').ok('post', '/api/shipments', { so_id: so.id, lines: [{ so_line_id: so.lines[0].id, qty: 1, serials: ['AU003'] }] });
    // 唯一匹配：直接开发货核对，全部一致 → 一次确认
    let r = await push(KEY.ship, { reads: [{ epc: epc.AU001 }, { epc: epc.AU002 }] });
    expect(r.body.recognized).toMatchObject({ session_type: 'SHIP' });
    let s = await detail(r.body.session_id);
    expect([s.session.session_type, s.session.shipment_id, s.check.all_match, s.can_confirm]).toEqual(['SHIP', sh1.id, true, true]);
    await api.as('wh').ok('post', `/api/rfid/sessions/${s.session.id}/confirm`, {});
    // 多张匹配：列出候选，仓管点选
    r = await push(KEY.ship, { reads: [{ epc: epc.AU003 }, { epc: epc.AU001 }] });
    // AU001 已发货：发货类优先，只有 sh2 含待发 → 唯一
    expect((await detail(r.body.session_id)).session.shipment_id).toBe(sh2.id);
    await api.as('wh').ok('post', `/api/rfid/sessions/${r.body.session_id}/cancel`, {});
    const sh3 = await api.as('wh').ok('post', '/api/shipments', { so_id: so.id, lines: [{ so_line_id: so.lines[0].id, qty: 1, serials: ['AU004'] }] });
    r = await push(KEY.ship, { reads: [{ epc: epc.AU003 }, { epc: epc.AU004 }] });
    s = await detail(r.body.session_id);
    expect(s.session.session_type).toBe('AUTO');
    expect(s.check.candidates.filter((c: any) => c.session_type === 'SHIP').map((c: any) => c.shipment_id).sort()).toEqual([sh2.id, sh3.id].sort());
    expect(s.can_confirm).toBe(false);
    s = await api.as('wh').ok('post', `/api/rfid/sessions/${s.session.id}/adopt`, { session_type: 'SHIP', shipment_id: sh3.id });
    expect([s.session.session_type, s.check.missing, s.check.extra.length + s.check.not_mine.length]).toEqual(['SHIP', [], 1]);
    await api.as('wh').ok('post', `/api/rfid/sessions/${s.session.id}/cancel`, {});
    // 没有匹配：提示
    r = await push(KEY.ship, { reads: [{ epc: epc.AU005 }] });
    expect(r.body.hint).toContain('没有待发货的发货单');
    await api.as('wh').ok('post', `/api/rfid/sessions/${r.body.session_id}/cancel`, {});
    // 完工待入库的成品 → 按工单开完工入库
    r = await push(KEY.ship, { reads: [{ epc: epc.AU006 }] });
    s = await detail(r.body.session_id);
    expect([s.session.session_type, s.session.wo_id, s.check.read_ok]).toEqual(['FG_RECEIPT', wo.id, 1]);
    await api.as('wh').ok('post', `/api/rfid/sessions/${s.session.id}/cancel`, {});
    // 已发货的成品（AU001）→ 客户退货
    r = await push(KEY.rcv, { reads: [{ epc: epc.AU001 }] });
    expect((await detail(r.body.session_id)).session.session_type).toBe('RETURN');
    await api.as('wh').ok('post', `/api/rfid/sessions/${r.body.session_id}/cancel`, {});
    // 包装标签 → 含该批次的待过账领料单
    const so2 = await api.as('sales').ok('get', `/api/sales-orders/${(await api.as('sales').find('/api/sales-orders', { q: 'GY-2026-0931' })).id}`);
    let w2 = await api.as('pmc').ok('post', '/api/work-orders', { material_id: ref.m['FG-BL100'], planned_qty: 1, so_id: so2.id, so_line_id: so2.lines[0].id });
    w2 = await api.as('pmc').ok('post', `/api/work-orders/${w2.id}/release`);
    const issue = await api.as('wh').ok('post', `/api/work-orders/${w2.id}/issues`, {});
    r = await push(KEY.rcv, { reads: [{ epc: (await tagsOf('JS2609ST'))[0].epc }] });
    s = await detail(r.body.session_id);
    expect([s.session.session_type, s.session.issue_id]).toEqual(['ISSUE', issue.id]);
    // 手持盘点机扫库位标签（4E5503…）→ 直接开该库位盘点
    const locEpc = `4E550300${ref.loc['RAW-A02'].toString(16).toUpperCase().padStart(16, '0')}`;
    r = await push(KEY.hh, { reads: [{ epc: locEpc }, { epc: (await tagsOf('HY2609F'))[0].epc }] });
    s = await detail(r.body.session_id);
    expect([s.session.session_type, s.session.location_id, s.check.read_here]).toEqual(['COUNT', ref.loc['RAW-A02'], 1]);
  });

  test('完工入库、客户退货、标签维护（换标/作废）', async () => {
    const { api, db } = t;
    const ref: Ref = await api.ids();
    const so = await api.as('wh').ok('get', `/api/sales-orders/${(await api.as('wh').find('/api/sales-orders', { q: 'LUM-PO-26-118' })).id}`);
    const fg = ref.m['FG-RL300'];
    const wo = await db.client.workOrder.create({ data: { no: 'WO-RF-2', material_id: fg, customer_id: so.customer_id, so_id: so.id, planned_qty: 2, completed_qty: 2, status: 'COMPLETED', lot_no: 'B-RF-2' } });
    for (let i = 1; i <= 2; i++) await db.client.serialNumber.create({ data: { sn: `RF200${i}`, wo_id: wo.id, material_id: fg, lot_no: 'B-RF-2', status: 'COMPLETED' } });
    const tags = (await api.as('wh').ok('post', '/api/rfid/tags/issue-serials', { wo_id: wo.id })).created;
    let s = await api.as('wh').ok('post', '/api/rfid/sessions', { session_type: 'FG_RECEIPT', reader_id: readers['RD-SHIP-01'].id, wo_id: wo.id });
    expect([s.check.waiting, s.check.untagged]).toEqual([2, 0]);
    await sim('RD-SHIP-01', tags.map((x: any) => ({ epc: x.epc })), s.session.id);
    s = await api.as('wh').ok('post', `/api/rfid/sessions/${s.session.id}/confirm`, {});
    expect([s.session.status, s.result.qty]).toEqual(['CONFIRMED', 2]);
    expect((await api.ok('get', `/api/rfid/tags/${tags[0].id}`)).sn_status).toBe('IN_STOCK');
    // 换标：旧标签作废，新标签继承序列号
    const nt = await api.as('wh').ok('post', `/api/rfid/tags/${tags[0].id}/replace`, { reason: '标签破损读不到' });
    expect([nt.sn, nt.status, nt.location_code]).toEqual(['RF2001', 'ACTIVE', tags[0].location_code ?? nt.location_code]);
    const oldTag = await api.ok('get', `/api/rfid/tags/${tags[0].id}`);
    expect([oldTag.status, oldTag.replaced_by_epc]).toEqual(['VOID', nt.epc]);
    expect((await api.as('wh').post(`/api/rfid/tags/${tags[0].id}/void`, { reason: 'x' })).body.detail).toContain('已作废');
    // 发卡重复 EPC 拒绝；EPC 格式校验
    expect((await api.as('wh').post('/api/rfid/tags', { tag_type: 'UNIT', epc: nt.epc, sn: 'RF2002' })).body.detail).toContain('已登记');
    expect((await api.as('wh').post('/api/rfid/tags', { tag_type: 'PACKAGE', epc: 'XYZ', material_id: fg, qty: 1 })).body.detail).toContain('格式不对');
    // 入库单批量发卡（已发卡的行跳过）
    const opening = (await api.as('wh').ok('get', '/api/receipts', { receipt_type: 'OPENING' })).items[0];
    expect((await api.as('wh').post('/api/rfid/tags/issue-receipt', { receipt_id: opening.id })).body.detail).toContain('没有需要发卡的行');
    // 发货后客户退货：读单台标签识别客户与发货单
    const rel = await db.client.productRelease.create({ data: { no: 'FX-RF-2', wo_id: wo.id, qty: 2, status: 'RELEASED', released_by: 'QA', released_at: new Date() } });
    await db.client.serialNumber.updateMany({ where: { wo_id: wo.id }, data: { release_id: rel.id } });
    await db.tx((tx) => t.app.get(InventoryService).changeLotStatus(tx, { material_id: fg, lot_no: 'B-RF-2', from_status: 'QUARANTINE', to_status: 'AVAILABLE', move_type: 'RELEASE', ref: { ref_no: 'T' } }));
    const sh = await api.as('wh').ok('post', '/api/shipments', { so_id: so.id, lines: [{ so_line_id: so.lines[0].id, qty: 1, serials: ['RF2002'] }] });
    await api.as('wh').ok('post', `/api/shipments/${sh.id}/confirm`);
    let r = await api.as('wh').ok('post', '/api/rfid/sessions', { session_type: 'RETURN', reader_id: readers['RD-RCV-01'].id });
    await sim('RD-RCV-01', [{ epc: tags[1].epc }], r.session.id);
    r = await detail(r.session.id);
    expect(r.check.serials[0]).toMatchObject({ sn: 'RF2002', shipment_no: sh.no });
    r = await api.as('wh').ok('post', `/api/rfid/sessions/${r.session.id}/confirm`, { reason: '客户反馈不亮' });
    expect(r.result.return_no).toMatch(/^TH/);
    expect((await api.ok('get', '/api/rfid/tags/lookup', { code: 'RF2002' })).tags[0].sn_status).toBe('RETURNED');
  });
});
