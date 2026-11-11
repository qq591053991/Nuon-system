/** 仓储与质量：采购收货/IQC/NCR、客供料隔离、调拨盘点（移植自 backend/tests/test_supply_chain.py），以及领料 FEFO、发货放行校验、NCR/CAPA 流程 */
import { dateOnly, addDays, today } from '../src/common/dates';
import { InventoryService } from '../src/core/inventory.service';
import { bootApp, SIG, type Api } from './harness';

type T = Awaited<ReturnType<typeof bootApp>>;

// >>> TEMP-ERP-FALLBACK：ERP 接口（采购订单/财务单据）尚未移植时，用 Prisma + WmsService 模拟；ERP 完成后删除本段
import { WmsService } from '../src/wms/wms.service';
import { ser } from '../src/common/presenter';
const routeMissing = (r: any) => r.status === 404 && String(r.body?.detail ?? '').startsWith('Cannot ');
async function erpFallback(t: T, method: 'get' | 'post', url: string, body: any, user: string) {
  const db = t.db.client;
  let m: RegExpExecArray | null;
  if (method === 'post' && url === '/api/purchase-orders') {
    const po = await db.purchaseOrder.create({
      data: {
        no: `PO-T${Date.now()}${Math.floor(Math.random() * 1000)}`, supplier_id: body.supplier_id, order_date: today(), status: 'DRAFT', created_by: user,
        lines: { create: body.lines.map((l: any, i: number) => ({ line_no: i + 1, material_id: l.material_id, qty: l.qty, unit_price: l.unit_price ?? 0, amount: l.qty * (l.unit_price ?? 0) })) },
      },
      include: { lines: { orderBy: { id: 'asc' } } },
    });
    return ser('PurchaseOrder', po, ['lines']);
  }
  if (method === 'post' && (m = /^\/api\/purchase-orders\/(\d+)\/approve$/.exec(url))) {
    return db.purchaseOrder.update({ where: { id: Number(m[1]) }, data: { status: 'APPROVED' } });
  }
  if (method === 'get' && (m = /^\/api\/purchase-orders\/(\d+)$/.exec(url))) {
    return ser('PurchaseOrder', await db.purchaseOrder.findUnique({ where: { id: Number(m[1]) }, include: { lines: true } }), ['lines']);
  }
  if (method === 'get' && url === '/api/finance/docs') {
    return { items: await db.financeDoc.findMany({ where: { doc_type: body?.doc_type }, orderBy: { id: 'desc' } }) };
  }
  if (method === 'post' && (m = /^\/api\/purchase-orders\/(\d+)\/receive$/.exec(url))) {
    const u: any = await db.user.findUnique({ where: { username: user } });
    const wms = t.app.get(WmsService);
    try {
      return { status: 200, body: await t.db.tx(async (tx) => {
        const po = await tx.purchaseOrder.findUnique({ where: { id: Number(m![1]) }, include: { lines: true } });
        const lines = [];
        for (const ln of body.lines) {
          const pl = await tx.purchaseOrderLine.findUnique({ where: { id: ln.po_line_id } });
          lines.push({ ...ln, material_id: pl!.material_id });
        }
        const rc = await wms.receive(tx, u, { receipt_type: 'PURCHASE', lines, supplier_id: po!.supplier_id, po, delivery_note: body.delivery_note, remark: body.remark });
        return ser('Receipt', rc, ['lines']);
      }) };
    } catch (e: any) {
      return { status: e.getStatus?.() ?? 500, body: e.getResponse?.() ?? { detail: String(e) } };
    }
  }
  throw new Error(`no fallback for ${method} ${url}`);
}
// <<< TEMP-ERP-FALLBACK

/** ERP 接口调用（采购订单、财务单据） */
async function erp(t: T, user: string, method: 'get' | 'post', url: string, body?: any): Promise<{ status: number; body: any }> {
  const api = t.api.as(user);
  const r = method === 'get' ? await api.get(url, body) : await api.post(url, body);
  // >>> TEMP-ERP-FALLBACK
  if (routeMissing(r)) {
    const out: any = await erpFallback(t, method, url, body, user);
    return out && typeof out.status === 'number' && 'body' in out ? out : { status: 200, body: out };
  }
  // <<< TEMP-ERP-FALLBACK
  return { status: r.status, body: r.body };
}
async function erpOk(t: T, user: string, method: 'get' | 'post', url: string, body?: any) {
  const r = await erp(t, user, method, url, body);
  if (r.status !== 200) throw new Error(`${method.toUpperCase()} ${url} -> ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

/** 新建并审批采购订单（与 Python 测试 _po 相同） */
async function po(t: T, supplierCode: string, materialId: number, qty = 1000, price = 0.35) {
  const sup = await t.api.find('/api/suppliers', { q: supplierCode });
  const o = await erpOk(t, 'buyer', 'post', '/api/purchase-orders', { supplier_id: sup.id, lines: [{ material_id: materialId, qty, unit_price: price }] });
  await erpOk(t, 'buyer', 'post', `/api/purchase-orders/${o.id}/approve`);
  return o;
}

const stockOf = async (api: Api, lot: string) => (await api.ok('get', '/api/stock', { lot_no: lot })).items;

describe('仓储与质量', () => {
  let t: T;
  beforeAll(async () => (t = await bootApp()));
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  test('采购收货 → IQC 判不合格 → NCR 退货', async () => {
    const { api } = t;
    const ref = await api.ids();
    const led = ref.m['LED-850-3030'];
    const o = await po(t, 'S001', led, 1000, 0.42);
    // 超收（>5%）被拒
    let r = await erp(t, 'wh', 'post', `/api/purchase-orders/${o.id}/receive`, {
      lines: [{ po_line_id: o.lines[0].id, qty: 1100, location_id: ref.loc['DRY-01'] }],
    });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('超收');
    const rc = await erpOk(t, 'wh', 'post', `/api/purchase-orders/${o.id}/receive`, {
      delivery_note: 'DN-1', lines: [{ po_line_id: o.lines[0].id, qty: 1000, location_id: ref.loc['DRY-01'], lot_no: 'NEW-850' }],
    });
    expect(rc.lines[0].status).toBe('QUARANTINE');
    expect(rc.lines[0].inspection_id).toBeTruthy();
    expect((await erpOk(t, 'admin', 'get', `/api/purchase-orders/${o.id}`)).status).toBe('RECEIVED');
    const ap = (await erpOk(t, 'admin', 'get', '/api/finance/docs', { doc_type: 'AP' })).items[0];
    expect(ap.amount).toBe(420.0);

    const insp = await api.find('/api/inspections', { q: 'NEW-850' });
    // 批量 1000、AQL 0.65 → J 字码 n=80 Ac=1
    expect([insp.sample_size, insp.accept_num, insp.status]).toEqual([80, 1, 'PENDING']);
    expect(insp.material_code).toBe('LED-850-3030');
    expect(insp.supplier_name).toContain('晶光');
    expect((await stockOf(api, 'NEW-850'))[0].status).toBe('QUARANTINE');

    // 不良 3 > Ac=1 → 判不合格，库存转不合格并自动开 NCR
    const detail = await api.ok('get', `/api/inspections/${insp.id}`);
    expect(detail.items.map((i: any) => i.name)).toContain('峰值波长抽测');
    const items = detail.items.map((i: any) => ({ ...i, result: i.name === '峰值波长抽测' ? 'FAIL' : 'PASS' }));
    const res = await api.as('qc').ok('post', `/api/inspections/${insp.id}/submit`, { defect_qty: 3, items, remark: '波长偏移', signature: SIG });
    expect(res.status).toBe('REJECTED');
    expect(res.inspector).toBe('孙质检');
    expect((await stockOf(api, 'NEW-850'))[0].status).toBe('REJECTED');
    // 已判定的检验单不能重复提交
    r = await api.as('qc').post(`/api/inspections/${insp.id}/submit`, { defect_qty: 0, signature: SIG });
    expect(r.status).toBe(400);
    expect(r.body.detail).toBe('该检验单已判定');
    const ncr = await api.find('/api/ncrs', { source: 'IQC' });
    expect(ncr.status).toBe('OPEN');
    expect(ncr.description).toContain('峰值波长抽测');
    expect(ncr.description).toContain('波长偏移');
    await api.as('qa').ok('post', `/api/ncrs/${ncr.id}/disposition`, { disposition: 'RETURN', signature: SIG });
    expect(await stockOf(api, 'NEW-850')).toEqual([]);
    const moves = (await api.ok('get', '/api/stock-moves', { lot_no: 'NEW-850' })).items;
    expect(moves.map((m: any) => m.move_type).slice(0, 2)).toEqual(['RETURN_SUPPLIER', 'IQC_REJECT']);
    await api.as('qa').ok('post', `/api/ncrs/${ncr.id}/close`);
    const sigs = (await api.ok('get', '/api/system/esignatures', { entity: 'qms_ncr' })).items;
    expect(sigs[0].meaning).toBe('不合格品评审处置：退货');
  });

  test('IQC 合格与让步接收', async () => {
    const { api } = t;
    const ref = await api.ids();
    const cases: [string, number, boolean, string][] = [['OK-1', 0, false, 'PASSED'], ['CON-1', 5, true, 'CONCESSION']];
    for (const [lot, defects, concession, expected] of cases) {
      const o = await po(t, 'S004', ref.m['HSG-RL300-U'], 200, 12);
      await erpOk(t, 'wh', 'post', `/api/purchase-orders/${o.id}/receive`, {
        lines: [{ po_line_id: o.lines[0].id, qty: 200, location_id: ref.loc['RAW-A02'], lot_no: lot }],
      });
      const insp = await api.find('/api/inspections', { q: lot });
      const who = concession ? 'qa' : 'qc';
      if (concession) {
        // 质检员不能批准让步
        const r = await api.as('qc').post(`/api/inspections/${insp.id}/submit`, { defect_qty: defects, concession: true, signature: SIG });
        expect(r.status).toBe(400);
        expect(r.body.detail).toBe('让步接收需由 QA 批准');
      }
      const res = await api.as(who).ok('post', `/api/inspections/${insp.id}/submit`, { defect_qty: defects, concession, signature: SIG });
      expect(res.status).toBe(expected);
      expect((await stockOf(api, lot))[0].status).toBe('AVAILABLE');
    }
    // 让步接收自动生成已处置（USE_AS_IS）的 NCR
    const ncr = await api.find('/api/ncrs', { source: 'IQC' });
    expect([ncr.status, ncr.disposition, ncr.lot_no]).toEqual(['DISPOSITIONED', 'USE_AS_IS', 'CON-1']);
  });

  test('客供料收货：货主隔离', async () => {
    const { api } = t;
    const ref = await api.ids();
    const c1 = await api.find('/api/customers', { q: 'C001' });
    const c2 = await api.find('/api/customers', { q: 'C002' });
    const line = { material_id: ref.m['PKG-RL300-IFU'], qty: 100, location_id: ref.loc['CS-01'], lot_no: 'IFU-NEW' };
    let r = await api.as('wh').post('/api/receipts', { receipt_type: 'CUSTOMER_SUPPLIED', customer_id: c2.id, lines: [line] });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('货主');
    // 自购料不能走客供料收货；采购收货必须从采购订单发起
    r = await api.as('wh').post('/api/receipts', { receipt_type: 'CUSTOMER_SUPPLIED', customer_id: c1.id, lines: [{ ...line, material_id: ref.m['LED-660-3030'] }] });
    expect(r.body.detail).toContain('不是该客户的客供料');
    r = await api.as('wh').post('/api/receipts', { receipt_type: 'PURCHASE', lines: [line] });
    expect(r.body.detail).toBe('采购收货请从采购订单发起；完工入库请从生产工单发起');
    expect((await api.as('qc').post('/api/receipts', { receipt_type: 'CUSTOMER_SUPPLIED', customer_id: c1.id, lines: [line] })).status).toBe(403);
    const rc = await api.as('wh').ok('post', '/api/receipts', { receipt_type: 'CUSTOMER_SUPPLIED', customer_id: c1.id, lines: [line] });
    expect(rc.lines[0].status).toBe('QUARANTINE');
    expect(rc.partner_name).toBe('Lumina Health Inc.');
    const st = (await stockOf(api, 'IFU-NEW'))[0];
    expect(st.owner_customer_id).toBe(c1.id);
    expect(st.owner_customer_name).toBe('Lumina Health Inc.');
    const insp = await api.find('/api/inspections', { q: 'IFU-NEW' });
    expect(insp.owner_customer_id).toBe(c1.id);
    expect((await api.ok('get', `/api/inspections/${insp.id}`)).items.map((i: any) => i.name)).toEqual(['外观/印刷', '尺寸']);
  });

  test('调拨与盘点', async () => {
    const { api } = t;
    const ref = await api.ids();
    const st = (await stockOf(api, 'JS2609S'))[0]; // 螺丝 3000
    await api.as('wh').ok('post', '/api/stock/transfer', { stock_id: st.id, qty: 500, to_location_id: ref.loc['LINE-01'] });
    let locs = Object.fromEntries((await stockOf(api, 'JS2609S')).map((s: any) => [s.location_code, s.qty]));
    expect(locs).toEqual({ 'RAW-A02': 2500, 'LINE-01': 500 });
    let r = await api.as('wh').post('/api/stock/transfer', { stock_id: st.id, qty: 99999, to_location_id: ref.loc['LINE-01'] });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('库存不足');
    r = await api.as('wh').post('/api/stock/transfer', { stock_id: st.id, qty: 1, to_location_id: ref.loc['RAW-A02'] });
    expect(r.body.detail).toBe('目标库位与原库位相同');

    const wh = await api.find('/api/warehouses', { q: 'WH-WIP' });
    const sc = await api.as('wh').ok('post', '/api/stock-counts', { warehouse_id: wh.id });
    expect(sc.warehouse_name).toBe('线边仓');
    expect((await api.as('wh').post(`/api/stock-counts/${sc.id}/post`)).status).toBe(400); // 未录入实盘
    const lines = sc.lines.map((l: any) => ({ id: l.id, counted_qty: l.system_qty - (l.lot_no === 'JS2609S' ? 2 : 0) }));
    expect((await api.as('wh').put(`/api/stock-counts/${sc.id}/lines`, [{ id: lines[0].id, counted_qty: -1 }])).status).toBe(400);
    const saved = await api.as('wh').ok('put', `/api/stock-counts/${sc.id}/lines`, lines);
    expect(saved.lines.find((l: any) => l.lot_no === 'JS2609S').diff_qty).toBe(-2);
    const posted = await api.as('wh').ok('post', `/api/stock-counts/${sc.id}/post`);
    expect(posted.status).toBe('POSTED');
    locs = Object.fromEntries((await stockOf(api, 'JS2609S')).map((s: any) => [s.location_code, s.qty]));
    expect(locs['LINE-01']).toBe(498);
    expect((await api.as('wh').post(`/api/stock-counts/${sc.id}/post`)).body.detail).toBe('盘点单已过账');
    const adj = (await api.ok('get', '/api/stock-moves', { move_type: 'ADJUST' })).items;
    expect(adj.map((m: any) => [m.lot_no, m.qty, m.from_location_code])).toEqual([['JS2609S', 2, 'LINE-01']]);
  });

  test('IQC 不合格 → 返工重检 / 让步接收', async () => {
    const { api } = t;
    const ref = await api.ids();
    for (const lot of ['RW-850', 'UAI-850']) {
      await api.as('wh').ok('post', '/api/receipts', {
        receipt_type: 'OTHER', lines: [{ material_id: ref.m['LED-850-3030'], qty: 100, location_id: ref.loc['DRY-01'], lot_no: lot }],
      });
      const insp = await api.find('/api/inspections', { q: lot });
      expect((await api.as('qc').ok('post', `/api/inspections/${insp.id}/submit`, { defect_qty: 5, signature: SIG })).status).toBe('REJECTED');
    }
    const ncrs = (await api.ok('get', '/api/ncrs', { source: 'IQC' })).items;
    const byLot = Object.fromEntries(ncrs.map((n: any) => [n.lot_no, n]));
    expect((await api.as('qc').post(`/api/ncrs/${byLot['RW-850'].id}/disposition`, { disposition: 'REWORK', signature: SIG })).status).toBe(403);
    let r = await api.as('qa').post(`/api/ncrs/${byLot['RW-850'].id}/disposition`, { disposition: 'REWORK' });
    expect(r.body.detail).toContain('此操作需要电子签名');
    await api.as('qa').ok('post', `/api/ncrs/${byLot['RW-850'].id}/disposition`, { disposition: 'REWORK', remark: '挑选', signature: SIG });
    expect((await stockOf(api, 'RW-850'))[0].status).toBe('QUARANTINE');
    const re = (await api.ok('get', '/api/inspections', { q: 'RW-850', status: 'PENDING' })).items;
    expect(re).toHaveLength(1); // 返工后重新检验
    expect((await api.as('qc').ok('post', `/api/inspections/${re[0].id}/submit`, { defect_qty: 0, signature: SIG })).status).toBe('PASSED');
    expect((await stockOf(api, 'RW-850'))[0].status).toBe('AVAILABLE');

    const uai = await api.as('qa').ok('post', `/api/ncrs/${byLot['UAI-850'].id}/disposition`, { disposition: 'USE_AS_IS', signature: SIG });
    expect([uai.status, uai.disposition, uai.disposition_by]).toEqual(['DISPOSITIONED', 'USE_AS_IS', '赵QA']);
    expect((await stockOf(api, 'UAI-850'))[0].status).toBe('AVAILABLE');
    r = await api.as('qa').post(`/api/ncrs/${byLot['UAI-850'].id}/disposition`, { disposition: 'SCRAP', signature: SIG });
    expect(r.body.detail).toBe('该 NCR 已处置');

    const aql = await api.ok('get', '/api/quality/aql', { lot_qty: 1000, aql: 0.65 });
    expect([aql.code_letter, aql.sample_size, aql.accept_num, aql.reject_num]).toEqual(['J', 80, 1, 2]);
  });

  test('生产领料：FEFO、待检不可领、客供料隔离、缺料', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const c1 = await api.find('/api/customers', { q: 'C001' });
    const c2 = await api.find('/api/customers', { q: 'C002' });
    const LED = ref.m['LED-660-3030'];
    // 先到期批次（经 IQC 合格）与待检批次（更早到期，但不可领用）
    const t0 = today();
    for (const [lot, mfgDays] of [['EARLY-660', -300], ['Q-660', -350]] as [string, number][]) {
      await api.as('wh').ok('post', '/api/receipts', {
        receipt_type: 'OTHER', lines: [{ material_id: LED, qty: 50, location_id: ref.loc['DRY-01'], lot_no: lot, mfg_date: addDays(t0, mfgDays).toISOString().slice(0, 10) }],
      });
    }
    const early = await api.find('/api/inspections', { q: 'EARLY-660' });
    await api.as('qc').ok('post', `/api/inspections/${early.id}/submit`, { defect_qty: 0, signature: SIG });
    const earlyStock = (await stockOf(api, 'EARLY-660'))[0];
    expect(earlyStock.expiry_date).toBe(addDays(t0, 65).toISOString().slice(0, 10));

    // 工单（MES 尚未参与：直接写入已下达工单及用料快照）
    const wo = await db.client.workOrder.create({
      data: {
        no: 'WO-T-001', material_id: ref.m['FG-RL300'], customer_id: c1.id, planned_qty: 1, status: 'RELEASED', lot_no: 'B-T-001',
        materials: { create: [
          { material_id: LED, qty_per: 100, required_qty: 100 },
          { material_id: ref.m['PKG-RL300-BOX'], qty_per: 10, required_qty: 10 },
          { material_id: ref.m['PSU-24V-5A'], qty_per: 50, required_qty: 50 },
        ] },
      },
    });
    expect((await api.as('op1').post(`/api/work-orders/${wo.id}/issues`, {})).status).toBe(403);
    const issue = await api.as('wh').ok('post', `/api/work-orders/${wo.id}/issues`, {});
    expect(issue.status).toBe('DRAFT');
    expect(issue.wo_no).toBe('WO-T-001');
    const lines = issue.lines.map((l: any) => [l.material_code, l.lot_no, l.qty]);
    expect(lines).toEqual([
      ['LED-660-3030', 'EARLY-660', 50], ['LED-660-3030', 'JG2609-660A', 50],
      ['PKG-RL300-BOX', 'LUM-BOX-2609', 10], ['PSU-24V-5A', 'HY2609A', 35],
    ]);
    expect(issue.lines[2].owner_customer_id).toBe(c1.id);
    expect(issue.shortages).toEqual([
      { material_id: ref.m['PSU-24V-5A'], material_code: 'PSU-24V-5A', material_name: '医用电源适配器 24V/5A', required: 50, shortage: 15, customer_supplied: false },
    ]);
    // 未过账领料单占用的数量不再重复分配
    let r = await api.as('wh').post(`/api/work-orders/${wo.id}/issues`, {});
    expect(r.body.detail).toBe('没有可领用的合格库存（缺料：PSU-24V-5A）');
    // 手工指定待检批次被拒
    const q660 = (await stockOf(api, 'Q-660'))[0];
    r = await api.as('wh').post(`/api/work-orders/${wo.id}/issues`, { lines: [{ material_id: LED, stock_id: q660.id, qty: 1 }] });
    expect(r.body.detail).toBe('批次 Q-660 质量状态为【待检/待放行】，不能领用');
    r = await api.as('wh').post(`/api/work-orders/${wo.id}/issues`, { lines: [{ material_id: ref.m['FAN-6015-24V'], stock_id: q660.id, qty: 1 }] });
    expect(r.body.detail).toBe('非本工单 BOM 物料，不能领用');

    const done = await api.as('wh').ok('post', `/api/issues/${issue.id}/confirm`);
    expect([done.status, done.confirmed_by]).toEqual(['CONFIRMED', '郑仓管']);
    expect(await stockOf(api, 'EARLY-660')).toEqual([]);
    expect((await stockOf(api, 'JG2609-660A'))[0].qty).toBe(2950);
    expect((await stockOf(api, 'LUM-BOX-2609'))[0].qty).toBe(30);
    const mats = await db.client.workOrderMaterial.findMany({ where: { wo_id: wo.id }, orderBy: { id: 'asc' } });
    expect(mats.map((m) => m.issued_qty)).toEqual([100, 10, 35]);
    expect((await api.as('wh').post(`/api/issues/${issue.id}/confirm`)).body.detail).toBe('领料单已过账或已取消');
    expect((await api.as('wh').post(`/api/issues/${issue.id}/cancel`)).body.detail).toBe('只能取消未过账的领料单');
    const issueMoves = (await api.ok('get', '/api/stock-moves', { ref_no: issue.no })).items;
    expect(issueMoves.every((m: any) => m.move_type === 'WO_ISSUE')).toBe(true);
    expect(issueMoves).toHaveLength(4);

    // 客供料只能用于该客户工单
    const wo2 = await db.client.workOrder.create({
      data: {
        no: 'WO-T-002', material_id: ref.m['FG-BL100'], customer_id: c2.id, planned_qty: 1, status: 'RELEASED',
        materials: { create: [{ material_id: ref.m['PKG-RL300-BOX'], qty_per: 5, required_qty: 5 }] },
      },
    });
    r = await api.as('wh').post(`/api/work-orders/${wo2.id}/issues`, {});
    expect(r.body.detail).toBe('PKG-RL300-BOX 为其他客户的客供料，不能用于本工单');
    const box = (await stockOf(api, 'LUM-BOX-2609'))[0];
    r = await api.as('wh').post(`/api/work-orders/${wo2.id}/issues`, { lines: [{ material_id: ref.m['PKG-RL300-BOX'], stock_id: box.id, qty: 5 }] });
    expect(r.body.detail).toBe('批次 LUM-BOX-2609 为其他客户的客供料，不能用于本工单');
    // 未下达工单不能领料
    await db.client.workOrder.update({ where: { id: wo2.id }, data: { status: 'PLANNED' } });
    r = await api.as('wh').post(`/api/work-orders/${wo2.id}/issues`, {});
    expect(r.body.detail).toBe('工单未下达或已完工，不能领料');
    expect((await api.ok('get', '/api/issues', { wo_id: wo.id })).total).toBe(1);
  });

  test('发货：DHR 未放行禁止发货；放行后按序列号发货并生成应收', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const inv = t.app.get(InventoryService);
    const so = await db.client.salesOrder.findFirstOrThrow({ where: { customer_po: 'LUM-PO-26-118' }, include: { lines: true } });
    const sol = so.lines[0];
    const fg = ref.m['FG-RL300'];
    const wo = await db.client.workOrder.create({
      data: { no: 'WO-T-SH', material_id: fg, customer_id: so.customer_id, so_id: so.id, planned_qty: 3, completed_qty: 3, status: 'COMPLETED', dhr_status: 'OPEN', lot_no: 'B-T-SH' },
    });
    const base = Date.now();
    for (let i = 1; i <= 3; i++) {
      await db.client.serialNumber.create({
        data: { sn: `RL3T000${i}`, wo_id: wo.id, material_id: fg, lot_no: 'B-T-SH', status: 'IN_STOCK', location_id: ref.loc['FG-01'], completed_at: new Date(base + i * 1000) },
      });
    }
    // 完工入库（DHR 未放行 → 待放行状态）
    const ref0 = { ref_type: 'TEST', ref_no: 'T' };
    await db.tx((tx) => inv.addStock(tx, { material_id: fg, location_id: ref.loc['FG-01'], lot_no: 'B-T-SH', status: 'QUARANTINE', qty: 3, move_type: 'WO_RECEIPT', ref: ref0 }));

    let r = await api.as('wh').post('/api/shipments', { so_id: so.id, lines: [{ so_line_id: sol.id, qty: 1, serials: ['RL3T0001'] }] });
    expect(r.status).toBe(400);
    expect(r.body.detail).toBe('序列号 RL3T0001 所在批次 B-T-SH 尚未完成 DHR 审核放行，禁止发货');
    r = await api.as('wh').post('/api/shipments', { so_id: so.id, lines: [{ so_line_id: sol.id, qty: 2 }] });
    expect(r.body.detail).toBe('FG-RL300 发货数量 2 与扫描序列号数量 0 不一致（可发已放行库存不足？）');
    expect(await api.ok('get', '/api/serials/available', { material_id: fg })).toEqual([]);
    expect((await api.as('qc').post('/api/shipments', { so_id: so.id, lines: [{ so_line_id: sol.id, qty: 2 }] })).status).toBe(403);

    // DHR 审核放行（MES 负责；此处直接改状态并放行库存）
    await db.tx(async (tx) => {
      await tx.workOrder.update({ where: { id: wo.id }, data: { dhr_status: 'RELEASED' } });
      await inv.changeLotStatus(tx, { material_id: fg, lot_no: 'B-T-SH', from_status: 'QUARANTINE', to_status: 'AVAILABLE', move_type: 'DHR_RELEASE', ref: ref0 });
    });
    const avail = await api.ok('get', '/api/serials/available', { material_id: fg });
    expect(avail.map((s: any) => [s.sn, s.wo_no])).toEqual([['RL3T0001', 'WO-T-SH'], ['RL3T0002', 'WO-T-SH'], ['RL3T0003', 'WO-T-SH']]);
    r = await api.as('wh').post('/api/shipments', { so_id: so.id, lines: [{ so_line_id: sol.id, qty: 1, serials: ['NOPE'] }] });
    expect(r.body.detail).toBe('序列号 NOPE 不存在或不是物料 FG-RL300');

    const sh = await api.as('sales').ok('post', '/api/shipments', { so_id: so.id, carrier: 'DHL', lines: [{ so_line_id: sol.id, qty: 2 }] });
    expect([sh.status, sh.customer_name, sh.so_no, sh.carrier]).toEqual(['DRAFT', 'Lumina Health Inc.', so.no, 'DHL']);
    expect(sh.lines.map((l: any) => [l.lot_no, l.location_code, l.qty, l.serial_list])).toEqual([['B-T-SH', 'FG-01', 2, ['RL3T0001', 'RL3T0002']]]);
    expect(sh.lines[0].serials).toBeUndefined();
    const got = await api.ok('get', `/api/shipments/${sh.id}`);
    expect(got.lines[0].serial_list).toEqual(['RL3T0001', 'RL3T0002']);
    expect((await api.as('sales').post(`/api/shipments/${sh.id}/confirm`)).status).toBe(403);

    const done = await api.as('wh').ok('post', `/api/shipments/${sh.id}/confirm`);
    expect([done.status, done.shipped_by]).toEqual(['SHIPPED', '郑仓管']);
    expect(done.ship_date).toBe(today().toISOString().slice(0, 10));
    const sns = await db.client.serialNumber.findMany({ where: { wo_id: wo.id }, orderBy: { sn: 'asc' } });
    expect(sns.map((s) => [s.status, s.shipment_id, s.customer_id, s.location_id])).toEqual([
      ['SHIPPED', sh.id, so.customer_id, null], ['SHIPPED', sh.id, so.customer_id, null], ['IN_STOCK', null, null, ref.loc['FG-01']],
    ]);
    expect((await stockOf(api, 'B-T-SH'))[0].qty).toBe(1);
    const so2 = await db.client.salesOrder.findUniqueOrThrow({ where: { id: so.id }, include: { lines: true } });
    expect([so2.status, so2.lines[0].shipped_qty]).toEqual(['PARTIAL_SHIPPED', 2]);
    const ar = await db.client.financeDoc.findFirstOrThrow({ where: { doc_type: 'AR' } });
    expect([ar.amount, ar.ref_no, ar.customer_id, ar.currency]).toEqual([176, sh.no, so.customer_id, 'USD']);
    expect(ar.due_date?.toISOString().slice(0, 10)).toBe(addDays(today(), 60).toISOString().slice(0, 10));
    expect((await api.as('wh').post(`/api/shipments/${sh.id}/confirm`)).body.detail).toBe('发货单已过账或已取消');
    expect((await api.as('wh').post(`/api/shipments/${sh.id}/cancel`)).body.detail).toBe('已发货不能取消');
    expect((await api.ok('get', '/api/shipments', { so_id: so.id })).items).toHaveLength(1);

    // 已发货序列号不能再次发货；草稿可取消
    r = await api.as('wh').post('/api/shipments', { so_id: so.id, lines: [{ so_line_id: sol.id, qty: 1, serials: ['RL3T0001'] }] });
    expect(r.body.detail).toBe('序列号 RL3T0001 状态为【SHIPPED】，不可发货');
    const sh2 = await api.as('wh').ok('post', '/api/shipments', { so_id: so.id, lines: [{ so_line_id: sol.id, qty: 1, serials: ['RL3T0003'] }] });
    expect((await api.as('wh').ok('post', `/api/shipments/${sh2.id}/cancel`)).status).toBe('CANCELLED');
  });

  test('手工 NCR 与 CAPA 流程（关闭需电子签名）', async () => {
    const { api } = t;
    let r = await api.as('qc').post('/api/ncrs', { source: 'PROCESS', description: 'x' });
    expect(r.body.detail).toBe('过程/来料不合格由系统自动开具');
    const ncr = await api.as('qc').ok('post', '/api/ncrs', { source: 'CUSTOMER', description: '客诉：RL-300 指示灯不亮', qty: 1 });
    expect([ncr.status, ncr.severity, ncr.created_by]).toEqual(['OPEN', 'MAJOR', 'qc']);
    expect((await api.as('qa').post(`/api/ncrs/${ncr.id}/close`)).body.detail).toBe('NCR 需先完成处置');
    expect((await api.as('qa').post(`/api/ncrs/${ncr.id}/disposition`, { disposition: 'XYZ', signature: SIG })).body.detail).toBe('处置方式无效');
    await api.as('qa').ok('post', `/api/ncrs/${ncr.id}/disposition`, { disposition: 'REWORK', remark: '返修', signature: SIG });

    const capa = await api.as('qa').ok('post', '/api/capas', { title: '指示灯失效', ncr_id: ncr.id, due_date: '2026-12-31' });
    expect([capa.status, capa.source, capa.due_date]).toEqual(['OPEN', 'NCR', '2026-12-31']);
    expect((await api.ok('get', `/api/capas/${capa.id}`)).ncrs.map((n: any) => n.id)).toEqual([ncr.id]);
    r = await api.as('qa').post(`/api/capas/${capa.id}/status`, { status: 'VERIFYING' });
    expect(r.body.detail).toBe('不能从 OPEN 变更为 VERIFYING');
    let c = await api.as('qa').ok('put', `/api/capas/${capa.id}`, { title: '指示灯失效', root_cause: 'LED 焊接虚焊' });
    expect(c.status).toBe('IN_PROGRESS');
    expect(c.due_date).toBe('2026-12-31'); // 未提交的字段保持不变
    r = await api.as('qa').post(`/api/capas/${capa.id}/status`, { status: 'VERIFYING' });
    expect(r.body.detail).toBe('请先填写根本原因和纠正措施');
    c = await api.as('qa').ok('put', `/api/capas/${capa.id}`, { title: '指示灯失效', corrective_action: '回流焊温度曲线优化' });
    expect(c.root_cause).toBe('LED 焊接虚焊');
    await api.as('qa').ok('post', `/api/capas/${capa.id}/status`, { status: 'VERIFYING' });
    r = await api.as('qa').post(`/api/capas/${capa.id}/status`, { status: 'CLOSED' });
    expect(r.body.detail).toBe('请填写有效性验证结论');
    r = await api.as('qa').post(`/api/capas/${capa.id}/status`, { status: 'CLOSED', effectiveness: '连续 3 批无复发' });
    expect(r.body.detail).toContain('此操作需要电子签名（CAPA关闭批准）');
    r = await api.as('qa').post(`/api/capas/${capa.id}/status`, { status: 'CLOSED', effectiveness: '连续 3 批无复发', signature: { password: 'bad' } });
    expect(r.body.detail).toBe('电子签名失败：密码错误');
    c = await api.as('qa').ok('post', `/api/capas/${capa.id}/status`, { status: 'CLOSED', effectiveness: '连续 3 批无复发', signature: SIG });
    expect([c.status, c.closed_by, c.effectiveness]).toEqual(['CLOSED', '赵QA', '连续 3 批无复发']);
    expect((await api.as('qa').put(`/api/capas/${capa.id}`, { title: 'x' })).body.detail).toBe('CAPA 已关闭');
    const closed = await api.as('qa').ok('post', `/api/ncrs/${ncr.id}/close`, { capa_id: capa.id });
    expect([closed.status, closed.capa_id]).toEqual(['CLOSED', capa.id]);
    const sigs = (await api.ok('get', '/api/system/esignatures', { entity: 'qms_capa' })).items;
    expect(sigs.map((s: any) => [s.meaning, s.username])).toEqual([['CAPA关闭批准', 'qa']]);
    expect((await api.ok('get', '/api/capas', { status: 'CLOSED' })).total).toBe(1);
  });

  test('库存汇总', async () => {
    const { api } = t;
    const rows = await api.ok('get', '/api/stock/summary');
    const led = rows.find((x: any) => x.material_code === 'LED-660-3030');
    expect([led.available, led.quarantine, led.safety_stock, led.below_safety, led.amount]).toEqual([3000, 0, 2000, false, 1050]);
    expect(rows.find((x: any) => x.material_code === 'PKG-RL300-BOX').customer_supplied).toBe(true);
    const below = await api.ok('get', '/api/stock/summary', { below_safety: 'true' });
    expect(below.every((x: any) => x.below_safety)).toBe(true);
    expect(below.map((x: any) => x.material_code)).toContain('PCB-CTRL-01'); // 60 > 50? 否则 PSU 35 < 50
    const exp = (await api.ok('get', '/api/stock', { expiring_days: 400 })).items;
    expect(exp.length).toBeGreaterThan(0);
    expect(exp.every((s: any) => s.expiry_date)).toBe(true);
    void dateOnly;
  });
});
