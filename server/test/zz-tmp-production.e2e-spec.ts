/** 端到端：销售订单 → 工单下达 → 领料 → 工位过站（防呆/校准/测试判定/NCR）→ 完工入库 → DHR 放行 → 发货 → 应收 → 追溯。 */
import { Api, bootApp, SIG } from './harness';

type Ref = Awaited<ReturnType<Api['ids']>>;

const GOOD_VALUES: Record<number, Record<string, number>> = {
  20: { WL_RED: 660, WL_NIR: 850, IRR: 50 },
  30: { AGE_H: 4, IRR_DROP: 1.2 },
  40: { HIPOT: 1.1, EARTH_LK: 120, PAT_LK: 20 },
};

function report(api: Api, sn: string, seq: number, ref: Ref, kw: Record<string, unknown> = {}) {
  const eq = ({ 20: ref.eq['EQ-SPEC-01'], 30: ref.eq['EQ-AGING-01'], 40: ref.eq['EQ-SAFE-01'] } as Record<number, number>)[seq] ?? null;
  const body: Record<string, unknown> = { sn, seq, values: GOOD_VALUES[seq] ?? {}, equipment_id: eq };
  if (seq === 60) body.key_parts = [{ lot_no: 'HY2609A' }];
  Object.assign(body, kw);
  return api.as('op1').post('/api/mes/report', body);
}

describe('TMP 生产流程', () => {
  let t: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => (t = await bootApp()));
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  test('完整生产流程：下达 → 领料 → 过站 → NCR → 入库 → DHR 放行 → 发货 → 追溯', async () => {
    const { api } = t;
    const ref = await api.ids();
    const so: any = await t.db.client.salesOrder.findFirst({ where: { customer_po: 'LUM-PO-26-118' }, include: { lines: true } });
    const w0 = await api.as('pmc').ok('post', '/api/work-orders', { material_id: ref.m['FG-RL300'], planned_qty: 20, so_id: so.id, so_line_id: so.lines[0].id, customer_id: so.customer_id });
    let wo = await api.find('/api/work-orders', { q: w0.no });
    expect(wo.planned_qty).toBe(20);
    // 改成 3 台便于测试
    await api.as('pmc').ok('put', `/api/work-orders/${wo.id}`, { material_id: wo.material_id, planned_qty: 3 });

    // 操作员无权下达
    expect((await api.as('op1').post(`/api/work-orders/${wo.id}/release`)).status).toBe(403);
    wo = await api.as('pmc').ok('post', `/api/work-orders/${wo.id}/release`);
    expect(wo.status).toBe('RELEASED');
    expect(wo.lot_no.startsWith('B')).toBe(true);
    expect(new Set(wo.operations.map((o: any) => o.seq))).toEqual(new Set([10, 20, 30, 40, 50, 60]));
    expect(wo.operations.find((o: any) => o.seq === 20).params.map((p: any) => p.code)).toEqual(['WL_RED', 'WL_NIR', 'IRR']);
    const mats = Object.fromEntries(wo.materials.map((m: any) => [m.material_code, m]));
    expect(mats['LED-660-3030']).toBeUndefined(); // LED 在半成品灯板中
    expect(mats['SA-RL300-LB'].required_qty).toBe(3);
    expect(mats['SCREW-M3X8'].required_qty).toBe(37); // 3×12×1.02 = 36.72 → 向上取整
    const serials = await api.ok('get', `/api/work-orders/${wo.id}/serials`);
    expect(serials).toHaveLength(3);
    expect(serials[0].udi.startsWith('(01)')).toBe(true);
    expect(serials[0].udi).toContain(`(10)${wo.lot_no}`);
    const sns: string[] = serials.map((s: any) => s.sn);

    // 领料：FEFO 自动分配，客供料只从该客户货主库存出
    const issue = await api.as('wh').ok('post', `/api/work-orders/${wo.id}/issues`, {});
    expect(issue.shortages).toHaveLength(0);
    const csLines = issue.lines.filter((l: any) => l.material_code === 'PKG-RL300-BOX');
    expect(csLines.length).toBeGreaterThan(0);
    expect(csLines[0].owner_customer_id).toBe(wo.customer_id);
    await api.as('wh').ok('post', `/api/issues/${issue.id}/confirm`);
    wo = await api.ok('get', `/api/work-orders/${wo.id}`);
    expect(wo.materials.every((m: any) => m.issued_qty >= m.required_qty)).toBe(true);

    // 防呆：未做组装不能直接光学测试
    let r = await report(api, sns[0], 20, ref);
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('防呆');
    // 正常组装
    expect((await report(api, sns[0], 10, ref)).body.result).toBe('PASS');
    // 光学测试必须选设备；校准过期的设备被拒
    r = await report(api, sns[0], 20, ref, { equipment_id: null });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('设备');
    r = await report(api, sns[0], 20, ref, { equipment_id: ref.eq['EQ-SPEC-02'] });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('校准已过期');
    // 漏填测试项
    r = await report(api, sns[0], 20, ref, { values: { WL_RED: 660 } });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('测量值');
    // 辐照度超上限 → 系统自动判 FAIL 并开 NCR
    const res1 = (await report(api, sns[0], 20, ref, { values: { WL_RED: 660, WL_NIR: 850, IRR: 65 } })).body;
    expect(res1.result).toBe('FAIL');
    expect(res1.ncr_no).toBeTruthy();
    // NG 产品在处置前不能继续报工
    r = await report(api, sns[0], 20, ref);
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('NCR');
    const ncr = await api.find('/api/ncrs', { q: res1.ncr_no });
    // 质检员没有处置权限；过程不合格不允许让步放行；密码错误签名失败
    expect((await api.as('qc').post(`/api/ncrs/${ncr.id}/disposition`, { disposition: 'REWORK', signature: SIG })).status).toBe(403);
    r = await api.as('qa').post(`/api/ncrs/${ncr.id}/disposition`, { disposition: 'USE_AS_IS', signature: SIG });
    expect(r.status).toBe(400);
    r = await api.as('qa').post(`/api/ncrs/${ncr.id}/disposition`, { disposition: 'REWORK', signature: { password: 'wrong' } });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('签名');
    await api.as('qa').ok('post', `/api/ncrs/${ncr.id}/disposition`, { disposition: 'REWORK', remark: '更换IC', signature: SIG });
    // 返工后重新测试通过，标记为返工记录
    expect((await report(api, sns[0], 20, ref)).body.result).toBe('PASS');
    const scan = await api.ok('get', `/api/mes/scan/${sns[0]}`);
    expect(scan.next_operation.seq).toBe(30);
    expect(scan.history.some((h: any) => h.is_rework)).toBe(true);
    expect(scan.operations.map((o: any) => [o.seq, o.code, o.op_type, o.done])).toEqual([
      [10, 'ASM', 'ASSEMBLY', true], [20, 'OPT', 'TEST_OPTICAL', true], [30, 'AGE', 'AGING', false],
      [40, 'SAFE', 'TEST_SAFETY', false], [50, 'FQC', 'INSPECTION', false], [60, 'PACK', 'PACKING', false],
    ]);
    expect(scan.operations[0].name).toBe('整机组装');

    // 关键件：包装工序需绑定已领用的电源批次
    for (const seq of [30, 40, 50]) expect((await report(api, sns[0], seq, ref)).body.result).toBe('PASS');
    r = await report(api, sns[0], 60, ref, { key_parts: [{ lot_no: 'NOT-ISSUED' }] });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('未领用');
    expect((await report(api, sns[0], 60, ref)).body.sn_status).toBe('COMPLETED');

    // 第二台全部通过；第三台安规失败 → 报废
    for (const seq of [10, 20, 30, 40, 50, 60]) expect((await report(api, sns[1], seq, ref)).body.result).toBe('PASS');
    for (const seq of [10, 20, 30]) await report(api, sns[2], seq, ref);
    const res2 = (await report(api, sns[2], 40, ref, { values: { HIPOT: 1, EARTH_LK: 100, PAT_LK: 150 } })).body;
    expect(res2.result).toBe('FAIL');
    const ncr2 = await api.find('/api/ncrs', { q: res2.ncr_no });
    await api.as('qa').ok('post', `/api/ncrs/${ncr2.id}/disposition`, { disposition: 'SCRAP', signature: SIG });
    wo = await api.ok('get', `/api/work-orders/${wo.id}`);
    expect([wo.status, wo.completed_qty, wo.scrap_qty]).toEqual(['COMPLETED', 2, 1]);

    // DHR：未入库前检查项不通过，不能放行
    let dhr = await api.ok('get', `/api/work-orders/${wo.id}/dhr`);
    expect(dhr.checks.every((c: any) => c.ok)).toBe(false);
    r = await api.as('qa').post(`/api/work-orders/${wo.id}/dhr/release`, { approve: true, signature: SIG });
    expect(r.status).toBe(400);

    // 完工入库 → 待放行
    const fg = await api.as('wh').ok('post', `/api/work-orders/${wo.id}/fg-receipt`, { location_id: ref.loc['FG-01'] });
    expect(fg.lines[0].qty).toBe(2);
    expect(fg.lines[0].status).toBe('QUARANTINE');
    // 未放行不能发货
    let soDetail: any = so;
    r = await api.as('wh').post('/api/shipments', { so_id: so.id, lines: [{ so_line_id: soDetail.lines[0].id, qty: 1, serials: [sns[0]] }] });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('放行');

    // QA 电子签名放行
    dhr = await api.ok('get', `/api/work-orders/${wo.id}/dhr`);
    expect(dhr.checks.filter((c: any) => !c.ok)).toEqual([]);
    expect(dhr.materials.length).toBeGreaterThanOrEqual(10);
    expect(dhr.operations[1].first_pass_yield).toBeLessThan(100);
    wo = await api.as('qa').ok('post', `/api/work-orders/${wo.id}/dhr/release`, { approve: true, signature: SIG });
    expect(wo.dhr_status).toBe('RELEASED');
    expect(wo.status).toBe('CLOSED');
    const stock = (await api.ok('get', '/api/stock', { lot_no: wo.lot_no })).items;
    expect(stock[0].status).toBe('AVAILABLE');
    expect(stock[0].qty).toBe(2);

    // 报废的序列号不能发货
    r = await api.as('wh').post('/api/shipments', { so_id: so.id, lines: [{ so_line_id: soDetail.lines[0].id, qty: 1, serials: [sns[2]] }] });
    expect(r.status).toBe(400);
    // 发货（自动选取已放行序列号）
    let sh = await api.as('wh').ok('post', '/api/shipments', { so_id: so.id, carrier: '顺丰', lines: [{ so_line_id: soDetail.lines[0].id, qty: 2 }] });
    expect([...sh.lines[0].serial_list].sort()).toEqual([...sns.slice(0, 2)].sort());
    sh = await api.as('wh').ok('post', `/api/shipments/${sh.id}/confirm`);
    expect(sh.status).toBe('SHIPPED');

    // 追溯
    let tr = await api.ok('get', `/api/trace/serial/${sns[0]}`);
    expect(tr.shipment.customer_name).toBe('Lumina Health Inc.');
    expect(tr.records.some((x: any) => x.is_rework)).toBe(true);
    expect(tr.key_parts[0].lot_no).toBe('HY2609A');
    expect(tr.materials.some((m: any) => m.lot_no === 'HY2609A')).toBe(true);
    tr = await api.ok('get', '/api/trace/lot', { material_code: 'PSU-24V-5A', lot_no: 'HY2609A' });
    expect(tr.summary.shipped).toBe(2);
    expect(tr.customers[0].customer_name).toBe('Lumina Health Inc.');

    // 电子签名与审计追踪
    const sigs = (await api.ok('get', '/api/system/esignatures', { entity: 'mes_work_order', entity_id: wo.id })).items;
    expect(sigs[0].meaning.startsWith('产品放行')).toBe(true);
    expect(sigs[0].full_name).toBe('赵QA');
    const logs = (await api.ok('get', '/api/system/audit-logs', { entity: 'mes_work_order', entity_id: wo.id })).items;
    expect(logs.some((l: any) => l.action === 'UPDATE' && l.changes.includes('dhr_status') && l.username === 'qa')).toBe(true);

    // 驾驶舱
    const d = await api.ok('get', '/api/dashboard');
    expect(d.kpi.fpy).not.toBeNull();
    expect(d.kpi.today_output).toBe(2);
  });

  test('半成品（非序列号）按批量报工，防超报', async () => {
    const { api } = t;
    const ref = await api.ids();
    let wo = await api.as('pmc').ok('post', '/api/work-orders', { material_id: ref.m['SA-RL300-LB'], planned_qty: 10 });
    wo = await api.as('pmc').ok('post', `/api/work-orders/${wo.id}/release`);
    expect(wo.serial_control).toBe(false);
    const op = api.as('op1');
    let r = await op.post(`/api/work-orders/${wo.id}/report-batch`, { seq: 20, good_qty: 1 });
    expect(r.status).toBe(400); // 上道工序未报工
    await op.ok('post', `/api/work-orders/${wo.id}/report-batch`, { seq: 10, good_qty: 8, ng_qty: 2 });
    r = await op.post(`/api/work-orders/${wo.id}/report-batch`, { seq: 20, good_qty: 9 });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('超出');
    await op.ok('post', `/api/work-orders/${wo.id}/report-batch`, { seq: 20, good_qty: 8 });
    const ncr = await api.find('/api/ncrs', { wo_id: wo.id });
    await api.as('qa').ok('post', `/api/ncrs/${ncr.id}/disposition`, { disposition: 'REWORK', signature: SIG });
    await op.ok('post', `/api/work-orders/${wo.id}/report-batch`, { seq: 10, good_qty: 2 });
    const res = await op.ok('post', `/api/work-orders/${wo.id}/report-batch`, { seq: 20, good_qty: 2 });
    expect(res.wo_status).toBe('COMPLETED');
    expect(res.wo_completed_qty).toBe(10);
  });
});
