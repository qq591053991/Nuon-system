/**
 * 评审改进（代理 1 · 数据与财务）：
 *   P0-2(a) 库存并发入库不产生重复行；P0-3 汇率与多币别折算；P0-8 金额十进制精确；
 *   P1-3 采购单位换算；P1-5 MRP 按周分时段净算。
 */
import { addDays, fmtDate, today } from '../src/common/dates';
import { InventoryService } from '../src/core/inventory.service';
import { convertToBase, RateBook } from '../src/erp/currency';
import { isoWeekLabel, weekStart } from '../src/erp/mrp.service';
import { bootApp } from './harness';

let t: Awaited<ReturnType<typeof bootApp>>;
beforeAll(async () => {
  t = await bootApp();
  // 并发请求需要真正监听端口（否则 supertest 会为每个请求各自 listen/close 同一个 server）
  const server = t.app.getHttpServer();
  if (!server.address()) await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
});
beforeEach(() => t.reset());
afterAll(() => t.close());

const d = (n: number) => fmtDate(addDays(today(), n))!;

describe('P0-2 库存并发入库', () => {
  test('同一新批次 10 个并发收货（各自独立事务）→ 只有一行库存，数量为总和；审计与流水完整', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const mid = ref.m['CBL-PWR-1.5']; // 免检物料：收货即合格；货主为空（验证 NULLS NOT DISTINCT）
    const loc = ref.loc['RAW-A02'];
    const lot = 'CONC-LOT-01';
    const res = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        api.as('wh').post('/api/receipts', { receipt_type: 'OTHER', lines: [{ material_id: mid, qty: i + 1, location_id: loc, lot_no: lot }] }),
      ),
    );
    expect(res.map((r) => r.status)).toEqual(Array(10).fill(200));
    const rows = await db.base.stock.findMany({ where: { material_id: mid, lot_no: lot } });
    expect(rows).toHaveLength(1);
    expect(rows[0].qty).toBe(55);
    expect([rows[0].status, rows[0].location_id, rows[0].owner_customer_id]).toEqual(['AVAILABLE', loc, null]);
    expect(await db.base.stockMove.count({ where: { material_id: mid, lot_no: lot, move_type: 'OTHER_RECEIPT' } })).toBe(10);
    // 审计：1 条 CREATE（含首次入库数量与批次属性）+ 9 条 UPDATE（数量逐次累加）
    const logs = await db.base.auditLog.findMany({ where: { entity: 'wms_stock', entity_id: rows[0].id }, orderBy: { id: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['CREATE', ...Array(9).fill('UPDATE')]);
    expect(logs[0].username).toBe('wh');
    const created = JSON.parse(logs[0].changes!);
    expect([created.lot_no, created.status, created.location_id]).toEqual([lot, 'AVAILABLE', loc]);
    let qty = created.qty;
    for (const l of logs.slice(1)) {
      const [before, after] = JSON.parse(l.changes!).qty;
      expect(before).toBe(qty);
      qty = after;
    }
    expect(qty).toBe(55);
  });

  test('服务层：10 个并发事务入库同一新键（含客供料货主），保留首次入库批次属性并补填有效期', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const inv = t.app.get(InventoryService);
    const box = await db.base.material.findUnique({ where: { code: 'PKG-RL300-BOX' } });
    const exp = addDays(today(), 200);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        db.tx((tx) =>
          inv.addStock(tx, {
            material_id: box!.id, location_id: ref.loc['CS-01'], lot_no: 'CS-CONC', status: 'QUARANTINE', owner_customer_id: box!.owner_customer_id,
            qty: 0.1, move_type: 'CS_RECEIPT', ref: { ref_type: 'TEST', username: 'test' }, expiry_date: i === 9 ? exp : null,
          }),
        ),
      ),
    );
    const rows = await db.base.stock.findMany({ where: { material_id: box!.id, lot_no: 'CS-CONC' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].qty).toBe(1);
    expect(rows[0].owner_customer_id).toBe(box!.owner_customer_id);
    expect(fmtDate(rows[0].expiry_date)).toBe(fmtDate(exp));
    // 出库按同一行扣减，不会因“重复行”误报库存不足
    await db.tx((tx) =>
      inv.removeStock(tx, {
        material_id: box!.id, location_id: ref.loc['CS-01'], lot_no: 'CS-CONC', status: 'QUARANTINE', owner_customer_id: box!.owner_customer_id,
        qty: 1, move_type: 'ADJUST', ref: { ref_type: 'TEST' },
      }),
    );
    expect(await db.base.stock.count({ where: { material_id: box!.id, lot_no: 'CS-CONC' } })).toBe(0);
  });
});

describe('P0-3 汇率与多币别', () => {
  test('汇率维护：权限、校验、按生效日期取最近汇率', async () => {
    const { api, db } = t;
    const list = await api.ok('get', '/api/exchange-rates');
    expect(list.items.map((r: any) => [r.currency, r.rate, r.effective_date])).toEqual([['USD', 7.1, d(-5)]]);
    expect((await api.as('sales').post('/api/exchange-rates', { currency: 'EUR', rate: 7.8, effective_date: d(0) })).status).toBe(403);
    let r = await api.as('finance').post('/api/exchange-rates', { currency: 'CNY', rate: 1, effective_date: d(0) });
    expect(r.body.detail).toBe('CNY 是本位币，无需维护汇率');
    r = await api.as('finance').post('/api/exchange-rates', { currency: 'usd', rate: 7.2, effective_date: d(-5) });
    expect(r.body.detail).toBe(`USD 在 ${d(-5)} 已有汇率，请直接修改该条记录`);
    r = await api.as('finance').post('/api/exchange-rates', { currency: 'EUR', rate: 0, effective_date: d(0) });
    expect(r.body.detail).toBe('汇率必须大于 0');
    const eur = await api.as('finance').ok('post', '/api/exchange-rates', { currency: 'eur', rate: 7.6543219, effective_date: d(-1), remark: '中间价' });
    expect([eur.currency, eur.rate]).toEqual(['EUR', 7.654322]);
    await api.as('engineer').ok('post', '/api/exchange-rates', { currency: 'USD', rate: 7.3, effective_date: d(10) }); // 未来生效
    await api.as('finance').ok('put', `/api/exchange-rates/${eur.id}`, { rate: 7.7 });

    const book = await RateBook.load(db.client);
    expect(book.rate('CNY')).toEqual({ rate: 1, effective_date: null });
    expect(book.rate('USD')).toEqual({ rate: 7.1, effective_date: d(-5) });
    expect(book.rate('USD', addDays(today(), 10))).toEqual({ rate: 7.3, effective_date: d(10) });
    expect(book.rate('USD', addDays(today(), -6))).toBeNull();
    expect(book.toBase(100.05, 'USD')).toBe(710.36); // 710.355 → 四舍五入到分
    expect(book.toBase(1, 'JPY')).toBeNull();
    expect([...book.missing]).toEqual(['JPY']);
    expect(await convertToBase(db.client, 1000, 'EUR', today())).toEqual({
      currency: 'EUR', base_currency: 'CNY', amount: 7700, rate: 7.7, effective_date: d(-1), missing: false,
    });
    expect((await convertToBase(db.client, 1000, 'USD', addDays(today(), -30))).missing).toBe(true);
    const cur = await api.ok('get', '/api/finance/currencies');
    expect(cur.base_currency).toBe('CNY');
    expect(cur.rates).toEqual([{ currency: 'EUR', rate: 7.7, effective_date: d(-1) }, { currency: 'USD', rate: 7.1, effective_date: d(-5) }]);
  });

  test('驾驶舱在手订单金额折算本位币，按币别分列；缺汇率时提示', async () => {
    const { api } = t;
    // 基础数据：已确认 USD 1,760（Lumina）+ CNY 42,000（光悦）；草稿不计
    let k = (await api.ok('get', '/api/dashboard')).kpi;
    expect(k.open_so).toBe(2);
    expect(k.base_currency).toBe('CNY');
    expect(k.open_so_by_currency).toEqual([{ currency: 'CNY', amount: 42000 }, { currency: 'USD', amount: 1760 }]);
    expect(k.open_so_amount).toBe(54496); // 1760 × 7.1 + 42000（不再是错误的 43,760）
    expect(k.missing_rates).toEqual([]);
    // 今天生效的新汇率立即用于折算
    await api.as('finance').ok('post', '/api/exchange-rates', { currency: 'USD', rate: 7.2, effective_date: d(0) });
    k = (await api.ok('get', '/api/dashboard')).kpi;
    expect(k.open_so_amount).toBe(54672);
    // EUR 订单没有汇率：不计入本位币合计，按币别列出并预警
    const ref = await api.ids();
    const c2 = await api.find('/api/customers', { q: 'C002' });
    const so = await api.as('sales').ok('post', '/api/sales-orders', { customer_id: c2.id, currency: 'EUR', lines: [{ material_id: ref.m['FG-BL100'], qty: 1, unit_price: 1000 }] });
    await api.as('sales').ok('post', `/api/sales-orders/${so.id}/confirm`);
    const dash = await api.ok('get', '/api/dashboard');
    expect(dash.kpi.open_so_amount).toBe(54672);
    expect(dash.kpi.open_so_by_currency).toEqual([{ currency: 'CNY', amount: 42000 }, { currency: 'EUR', amount: 1000 }, { currency: 'USD', amount: 1760 }]);
    expect(dash.kpi.missing_rates).toEqual(['EUR']);
    expect(dash.alerts[0]).toEqual({ level: 'warning', text: '缺少 EUR → CNY 汇率，在手订单金额未包含 EUR 1000.00（请在“基础资料 → 汇率”中维护）' });
  });

  test('账龄汇总按往来单位 + 币别分行，另给本位币合计', async () => {
    const { api, db } = t;
    const c1 = await api.find('/api/customers', { q: 'C001' });
    const c2 = await api.find('/api/customers', { q: 'C002' });
    const s1 = await api.find('/api/suppliers', { q: 'S001' });
    const doc = (no: string, x: Record<string, any>) =>
      db.base.financeDoc.create({ data: { no, doc_date: addDays(today(), -10), due_date: addDays(today(), 20), ...x } as any });
    await doc('AR-T1', { doc_type: 'AR', customer_id: c1.id, currency: 'USD', amount: 1000.1 });
    await doc('AR-T2', { doc_type: 'AR', customer_id: c1.id, currency: 'CNY', amount: 200, due_date: addDays(today(), -40) });
    await doc('AR-T3', { doc_type: 'AR', customer_id: c2.id, currency: 'CNY', amount: 500, paid_amount: 100.3, status: 'PARTIAL' });
    await doc('AR-T4', { doc_type: 'AR', customer_id: c2.id, currency: 'JPY', amount: 10000 });
    await doc('AP-T1', { doc_type: 'AP', supplier_id: s1.id, currency: 'CNY', amount: 0.3 });
    const sum = await api.ok('get', '/api/finance/summary');
    expect(sum.base_currency).toBe('CNY');
    const row = (partner: string, currency: string) => sum.AR.find((r: any) => r.partner === partner && r.currency === currency);
    expect(sum.AR).toHaveLength(4);
    expect(row(c1.name, 'USD')).toEqual({ partner: c1.name, currency: 'USD', 未到期: 1000.1, '1-30天': 0, '31-90天': 0, '90天以上': 0, total: 1000.1, total_base: 7100.71 });
    expect(row(c1.name, 'CNY')).toMatchObject({ '31-90天': 200, total: 200, total_base: 200 });
    expect(row(c2.name, 'CNY')).toMatchObject({ 未到期: 399.7, total: 399.7, total_base: 399.7 });
    expect(row(c2.name, 'JPY')).toMatchObject({ total: 10000, total_base: null });
    expect(sum.totals.AR).toEqual({
      currency: 'CNY', 未到期: 7500.41, '1-30天': 0, '31-90天': 200, '90天以上': 0, total: 7700.41,
      by_currency: [{ currency: 'CNY', amount: 599.7 }, { currency: 'JPY', amount: 10000 }, { currency: 'USD', amount: 1000.1 }],
      missing_rates: ['JPY'],
    });
    expect(sum.totals.AP).toMatchObject({ total: 0.3, missing_rates: [] });
    expect(sum.missing_rates).toEqual(['JPY']);
  });
});

describe('P0-8 金额十进制精确', () => {
  test('采购：3 × 0.1 与 3 × 1.005 累加到分不失真；收货应付、分次付款精确结清', async () => {
    const { api } = t;
    const ref = await api.ids();
    const sup = await api.find('/api/suppliers', { q: 'S004' });
    const lines = [
      { material_id: ref.m['SCREW-M3X8'], qty: 1, unit_price: 0.1 },
      { material_id: ref.m['SCREW-M3X8'], qty: 1, unit_price: 0.1 },
      { material_id: ref.m['SCREW-M3X8'], qty: 1, unit_price: 0.1 },
      { material_id: ref.m['HSG-RL300-U'], qty: 3, unit_price: 1.005 }, // 浮点 3 × 1.005 = 3.0149999… → 3.01（错）；十进制 3.015 → 3.02
    ];
    const p = await api.as('buyer').ok('post', '/api/purchase-orders', { supplier_id: sup.id, lines });
    expect(p.lines.map((l: any) => l.amount)).toEqual([0.1, 0.1, 0.1, 3.02]);
    expect(p.total_amount).toBe(3.32);
    await api.as('buyer').ok('post', `/api/purchase-orders/${p.id}/approve`);
    await api.as('wh').ok('post', `/api/purchase-orders/${p.id}/receive`, {
      lines: p.lines.map((l: any) => ({ po_line_id: l.id, qty: l.qty, location_id: ref.loc['RAW-A02'] })),
    });
    const ap = (await api.ok('get', '/api/finance/docs', { doc_type: 'AP' })).items[0];
    expect(ap.amount).toBe(3.32);
    for (const amt of [0.1, 0.1, 0.1]) await api.as('finance').ok('post', `/api/finance/docs/${ap.id}/payments`, { amount: amt });
    let doc = await api.as('finance').ok('post', `/api/finance/docs/${ap.id}/payments`, { amount: 3.02 });
    expect([doc.status, doc.paid_amount, doc.balance]).toEqual(['PAID', 3.32, 0]);
    // 付款金额按分四舍五入；超额拒绝
    const ap2 = await t.db.base.financeDoc.create({ data: { no: 'AP-T9', doc_type: 'AP', supplier_id: sup.id, doc_date: today(), amount: 0.3 } });
    doc = await api.as('finance').ok('post', `/api/finance/docs/${ap2.id}/payments`, { amount: 0.104 });
    expect([doc.paid_amount, doc.payments[0].amount, doc.status]).toEqual([0.1, 0.1, 'PARTIAL']);
    expect((await api.as('finance').post(`/api/finance/docs/${ap2.id}/payments`, { amount: 0.21 })).body.detail).toBe('金额超过未结余额 0.20');
  });

  test('销售发货应收：多行 0.1 累加精确到分；同一订单行分批次发货先合并再计价（与订单行金额一致）', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const c2 = await api.find('/api/customers', { q: 'C002' });
    const sa = ref.m['SA-RL300-LB']; // 半成品（非序列号），期初 30 件
    // 再入一个更早到期的批次，使 3 件分两个批次（FEFO）发出
    await api.as('wh').ok('post', '/api/receipts', { receipt_type: 'OTHER', lines: [{ material_id: sa, qty: 1, location_id: ref.loc['FG-01'], lot_no: 'SA-EARLY', expiry_date: d(30) }] });
    const so = await api.as('sales').ok('post', '/api/sales-orders', {
      customer_id: c2.id,
      lines: [{ material_id: sa, qty: 1, unit_price: 0.1 }, { material_id: sa, qty: 1, unit_price: 0.1 }, { material_id: sa, qty: 1, unit_price: 0.1 }, { material_id: sa, qty: 3, unit_price: 1.002 }],
    });
    expect([so.total_amount, so.lines[3].amount]).toEqual([3.31, 3.01]);
    await api.as('sales').ok('post', `/api/sales-orders/${so.id}/confirm`);
    // 先发第 4 行：3 件来自两个批次（1 + 2）
    let sh = await api.as('wh').ok('post', '/api/shipments', { so_id: so.id, lines: [{ so_line_id: so.lines[3].id, qty: 3 }] });
    expect(sh.lines.map((l: any) => l.qty)).toEqual([1, 2]);
    await api.as('wh').ok('post', `/api/shipments/${sh.id}/confirm`);
    sh = await api.as('wh').ok('post', '/api/shipments', { so_id: so.id, lines: so.lines.slice(0, 3).map((l: any) => ({ so_line_id: l.id, qty: 1 })) });
    await api.as('wh').ok('post', `/api/shipments/${sh.id}/confirm`);
    const ar = (await api.ok('get', '/api/finance/docs', { doc_type: 'AR' })).items.map((x: any) => x.amount).sort();
    expect(ar).toEqual([0.3, 3.01]); // 按批次分别取整会得 1.00 + 2.00 = 3.00；合并计价 3 × 1.002 = 3.006 → 3.01（= 订单行金额）；三行 0.1 → 0.3
    const docs = await db.base.financeDoc.findMany({ where: { doc_type: 'AR' } });
    expect(docs.map((x) => x.amount.toString()).sort()).toEqual(['0.3', '3.01']);
  });
});

describe('P1-3 采购单位换算', () => {
  const setPurchaseUnit = async (code: string, uom: string, factor: number) => {
    const m = await t.api.find('/api/materials', { q: code });
    return t.api.as('engineer').ok('put', `/api/materials/${m.id}`, { purchase_uom: uom, purchase_factor: factor });
  };

  test('按采购单位下单：数量/单价换算为库存单位，金额按采购单位计算；收货按库存单位，应付与订单金额一致', async () => {
    const { api } = t;
    const ref = await api.ids();
    expect((await api.as('engineer').put(`/api/materials/${ref.m['LED-660-3030']}`, { purchase_factor: 0 })).body.detail).toBe('采购单位换算率必须大于 0');
    const led = await setPurchaseUnit('LED-660-3030', '卷', 3000);
    expect([led.purchase_uom, led.purchase_factor]).toEqual(['卷', 3000]);
    const sup = await api.find('/api/suppliers', { q: 'S001' });
    const p = await api.as('buyer').ok('post', '/api/purchase-orders', {
      supplier_id: sup.id,
      lines: [
        { material_id: ref.m['LED-660-3030'], purchase_qty: 10, purchase_price: 100 },
        { material_id: ref.m['LED-850-3030'], qty: 1000, unit_price: 0.42 },
      ],
    });
    const [l1, l2] = p.lines;
    expect([l1.qty, l1.unit_price, l1.amount, l1.purchase_qty, l1.purchase_uom, l1.purchase_price]).toEqual([30000, 0.033333, 1000, 10, '卷', 100]);
    expect([l2.qty, l2.amount, l2.purchase_qty, l2.purchase_uom, l2.purchase_price]).toEqual([1000, 420, null, null, null]);
    expect(p.total_amount).toBe(1420);
    // 只给库存单位单价时按换算率推出采购单价
    const p2 = await api.as('buyer').ok('post', '/api/purchase-orders', { supplier_id: sup.id, lines: [{ material_id: ref.m['LED-660-3030'], purchase_qty: 2, unit_price: 0.35 }] });
    expect([p2.lines[0].qty, p2.lines[0].purchase_price, p2.lines[0].amount]).toEqual([6000, 1050, 2100]);
    // 校验
    let r = await api.as('buyer').post('/api/purchase-orders', { supplier_id: sup.id, lines: [{ material_id: ref.m['LED-660-3030'], purchase_qty: 1, purchase_uom: '箱', purchase_price: 1 }] });
    expect(r.body.detail).toBe('第 1 行 LED-660-3030 的采购单位为 卷，不能按 箱 下单');
    r = await api.as('buyer').post('/api/purchase-orders', { supplier_id: sup.id, lines: [{ material_id: ref.m['LED-850-3030'], purchase_qty: 1, purchase_uom: '卷' }] });
    expect(r.body.detail).toBe('第 1 行 LED-850-3030 未设置采购单位，请按库存单位（PCS）录入数量');
    r = await api.as('buyer').post('/api/purchase-orders', { supplier_id: sup.id, lines: [{ material_id: ref.m['LED-850-3030'] }] });
    expect(r.body.detail).toBe('第 1 行请填写数量');

    // 收货按库存单位：先收 3000（= 1 卷）→ 应付 100；再收其余 27000 → 应付 900（合计 = 订单行金额 1000，而非 30000 × 0.033333 = 999.99）
    await api.as('buyer').ok('post', `/api/purchase-orders/${p.id}/approve`);
    await api.as('wh').ok('post', `/api/purchase-orders/${p.id}/receive`, { lines: [{ po_line_id: l1.id, qty: 3000, location_id: ref.loc['DRY-01'] }] });
    await api.as('wh').ok('post', `/api/purchase-orders/${p.id}/receive`, { lines: [{ po_line_id: l1.id, qty: 27000, location_id: ref.loc['DRY-01'] }] });
    const aps = (await api.ok('get', '/api/finance/docs', { doc_type: 'AP' })).items.map((x: any) => x.amount).sort((a: number, b: number) => a - b);
    expect(aps).toEqual([100, 900]);
    const po = await api.ok('get', `/api/purchase-orders/${p.id}`);
    expect(po.lines[0].received_qty).toBe(30000);
  });

  test('MRP 建议按整数采购单位取整，转单后采购订单行带采购单位信息', async () => {
    const { api } = t;
    await setPurchaseUnit('LED-660-3030', '卷', 4000);
    const so = await api.find('/api/sales-orders', { q: 'LUM-PO-26-131' });
    await api.as('sales').ok('post', `/api/sales-orders/${so.id}/confirm`);
    const run = await api.as('pmc').ok('post', '/api/mrp/run');
    const leds = run.suggestions.filter((s: any) => s.material_code === 'LED-660-3030');
    expect(leds.length).toBeGreaterThan(0);
    for (const s of leds) {
      expect(s.suggested_qty % 4000).toBe(0);
      expect(s.suggested_qty).toBeGreaterThanOrEqual(s.net_qty);
      expect(s.suggested_qty - s.net_qty).toBeLessThan(4000);
    }
    const res = await api.as('pmc').ok('post', '/api/mrp/convert', { suggestion_ids: leds.map((s: any) => s.id) });
    const p = await api.find('/api/purchase-orders', { q: res.purchase_orders[0] });
    expect(p.lines).toHaveLength(leds.length);
    const l = p.lines[0];
    expect([l.qty, l.purchase_uom, l.purchase_qty, l.purchase_price, l.unit_price]).toEqual([leds[0].suggested_qty, '卷', leds[0].suggested_qty / 4000, 1400, 0.35]);
    expect(l.amount).toBe((leds[0].suggested_qty / 4000) * 1400);
    expect(l.expected_date).toBe(fmtDate(addDays(new Date(`${leds[0].due_date}T00:00:00Z`), 15))); // 到货日 = 建议下单日 + 采购提前期
  });
});

describe('P1-5 MRP 按周分时段', () => {
  test('ISO 周计算', () => {
    const w = (s: string) => isoWeekLabel(new Date(`${s}T00:00:00Z`));
    expect([w('2026-01-01'), w('2027-01-01'), w('2024-12-30'), w('2026-11-11'), w('2026-11-15'), w('2026-11-16')])
      .toEqual(['2026-W01', '2026-W53', '2025-W01', '2026-W46', '2026-W46', '2026-W47']);
    expect(fmtDate(weekStart(new Date('2026-11-15T00:00:00Z')))).toBe('2026-11-09');
  });

  test('逐周净算：预计库存结转、子件需求日期扣父项生产周期、外购件扣采购提前期、交期压缩提示', async () => {
    const { api } = t;
    const ref = await api.ids();
    const so = await api.find('/api/sales-orders', { q: 'LUM-PO-26-131' }); // 200 台，交期 +45 天
    await api.as('sales').ok('post', `/api/sales-orders/${so.id}/confirm`);
    // 在制工单的计划完工日在 +60 天：不能抵扣 +20 天的需求，只能提示“其后有在制”
    await api.as('pmc').ok('post', '/api/work-orders', { material_id: ref.m['FG-RL300'], planned_qty: 5, planned_start: d(55), planned_end: d(60) });
    const run = await api.as('pmc').ok('post', '/api/mrp/run');
    const of = (code: string) => run.suggestions.filter((s: any) => s.material_code === code);
    const wk = (n: number) => isoWeekLabel(weekStart(addDays(today(), n)));

    // 成品：交期 +20 天（20 台，已确认）和 +45 天（200 台）分属两周 → 两条生产建议；建议开工 = 需求日 − 5 天生产周期
    const fg = of('FG-RL300');
    expect(fg.map((s: any) => [s.week, s.required_date, s.due_date, s.gross_qty, s.net_qty, s.suggested_qty])).toEqual([
      [wk(20), d(20), d(15), 20, 20, 20],
      [wk(45), d(45), d(40), 200, 200, 200],
    ]);
    expect(fg[0].note).toBe('其后各周另有在途/在制 5，可考虑催交提前');
    // 在制工单 5 台在 +60 天入库：结转为预计库存，不产生新建议
    expect(fg.every((s: any) => s.action === 'PRODUCE' && s.level === 0)).toBe(true);

    // 灯板组件：需求在父项开工日（+15、+40），计划工单在 +55 开工另需 5；期初 30 先满足 +15 的 20，剩 10 结转到 +40 那周
    const sa = of('SA-RL300-LB');
    expect(sa.map((s: any) => [s.week, s.required_date, s.due_date, s.gross_qty, s.on_hand_qty, s.net_qty, s.suggested_qty])).toEqual([
      [wk(40), d(40), d(37), 200, 10, 190, 190],
      [wk(55), d(55), d(52), 5, 0, 5, 5],
    ]);

    // LED（外购，提前期 15 天，安全库存 2000，最小订货量 1000）：需求日 = 灯板开工日；建议下单日 = 需求日 − 15
    // 净需求 = 毛需求 + 安全库存 − 预计库存 − 本周在途；+52 那周仅缺 303，按最小订货量建议 1000，多出部分结转
    const led = of('LED-660-3030');
    expect(led.map((s: any) => [s.required_date, s.due_date, s.action, s.on_hand_qty])).toEqual([
      [d(37), d(22), 'PURCHASE', 3000],
      [d(52), d(37), 'PURCHASE', 2000],
    ]);
    expect(led[0].gross_qty).toBe(Math.round(190 * 60 * 1.01 * 1e4) / 1e4);
    expect([led[1].gross_qty, led[1].net_qty, led[1].suggested_qty]).toEqual([303, 303, 1000]);
    for (const s of led) expect(s.net_qty).toBe(Math.round((s.gross_qty + s.safety_stock - s.on_hand_qty - s.on_order_qty) * 1e4) / 1e4);

    // 紧急订单：交期 +2 天 → 成品建议开工日被压缩到今天并提示；其下层组件需求也落在本周
    const c1 = await api.find('/api/customers', { q: 'C001' });
    const rush = await api.as('sales').ok('post', '/api/sales-orders', { customer_id: c1.id, currency: 'USD', lines: [{ material_id: ref.m['FG-RL300'], qty: 50, unit_price: 80, delivery_date: d(2) }] });
    await api.as('sales').ok('post', `/api/sales-orders/${rush.id}/confirm`);
    const run2 = await api.as('pmc').ok('post', '/api/mrp/run');
    const rushFg = run2.suggestions.find((s: any) => s.material_code === 'FG-RL300' && s.required_date === d(2));
    expect([rushFg.due_date, rushFg.week, rushFg.suggested_qty]).toEqual([d(0), wk(2), 50]);
    expect(rushFg.note).toContain('交期紧张：建议日期早于今天');
    const rushSa = run2.suggestions.find((s: any) => s.material_code === 'SA-RL300-LB' && s.required_date === d(-3));
    expect([rushSa.week, rushSa.due_date, rushSa.on_hand_qty, rushSa.gross_qty, rushSa.net_qty]).toEqual([wk(0), d(0), 30, 50, 20]);

    // 忽略/转单仍可用；转单生成的工单按建议开工日
    const ign = await api.as('pmc').ok('post', `/api/mrp/suggestions/${rushSa.id}/ignore`);
    expect([ign.status, ign.required_date]).toEqual(['IGNORED', d(-3)]);
    const res = await api.as('pmc').ok('post', '/api/mrp/convert', { suggestion_ids: [rushFg.id] });
    const wo = await api.find('/api/work-orders', { q: res.work_orders[0] });
    expect([wo.planned_qty, wo.planned_start, wo.planned_end]).toEqual([50, d(0), d(5)]);
  });
});
