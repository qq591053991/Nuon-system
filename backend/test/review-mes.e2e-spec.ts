/**
 * 评审改进（生产，代理 3）端到端测试：
 *   P1-7 人员上岗资质（维护 + 报工校验）；
 *   P1-1 返工换件追溯（拆下/装上、补领库存、单台追溯/DHR/扫码履历）；
 *   P1-2 DHR 分批放行（序列号产品 / 批量产品、拒绝冻结、发货以放行批为准、整单放行 = 放行全部剩余）。
 */
import { addDays, today } from '../src/common/dates';
import { InventoryService } from '../src/core/inventory.service';
import { Api, bootApp, SIG } from './harness';

type Ref = Awaited<ReturnType<Api['ids']>>;

const GOOD_VALUES: Record<number, Record<string, number>> = {
  20: { WL_RED: 660, WL_NIR: 850, IRR: 50 },
  30: { AGE_H: 4, IRR_DROP: 1.2 },
  40: { HIPOT: 1.1, EARTH_LK: 120, PAT_LK: 20 },
};

function report(api: Api, sn: string, seq: number, ref: Ref, kw: Record<string, unknown> = {}, user = 'op1') {
  const eq = ({ 20: ref.eq['EQ-SPEC-01'], 30: ref.eq['EQ-AGING-01'], 40: ref.eq['EQ-SAFE-01'] } as Record<number, number>)[seq] ?? null;
  const body: Record<string, unknown> = { sn, seq, values: GOOD_VALUES[seq] ?? {}, equipment_id: eq };
  if (seq === 60) body.key_parts = [{ lot_no: 'HY2609A' }];
  Object.assign(body, kw);
  return api.as(user).post('/api/mes/report', body);
}

async function passAll(api: Api, sn: string, ref: Ref, from = 10) {
  for (const seq of [10, 20, 30, 40, 50, 60].filter((s) => s >= from)) {
    const r = await report(api, sn, seq, ref);
    if (r.status !== 200 || r.body.result !== 'PASS') throw new Error(`${sn}@${seq}: ${r.status} ${JSON.stringify(r.body)}`);
  }
}

/** RL-300 工单（关联订单 LUM-PO-26-118）：创建 → 下达 →（可选）领料过账 */
async function rlWo(api: Api, ref: Ref, qty: number, issue = true) {
  const so = await api.ok('get', `/api/sales-orders/${(await api.find('/api/sales-orders', { q: 'LUM-PO-26-118' })).id}`);
  let wo = await api.as('pmc').ok('post', '/api/work-orders', {
    material_id: ref.m['FG-RL300'], planned_qty: qty, so_id: so.id, so_line_id: so.lines[0].id,
  });
  wo = await api.as('pmc').ok('post', `/api/work-orders/${wo.id}/release`);
  if (issue) {
    const iss = await api.as('wh').ok('post', `/api/work-orders/${wo.id}/issues`, {});
    await api.as('wh').ok('post', `/api/issues/${iss.id}/confirm`);
  }
  const sns: string[] = (await api.ok('get', `/api/work-orders/${wo.id}/serials`)).map((s: any) => s.sn);
  return { wo, so, sns };
}

const stockOf = async (api: Api, lot: string) => (await api.ok('get', '/api/stock', { lot_no: lot, page_size: 200 })).items as any[];
const qtyBy = (rows: any[], status: string) => rows.filter((r) => r.status === status).reduce((s, r) => s + r.qty, 0);

describe('评审改进：生产（资质 / 返工换件 / 分批放行）', () => {
  let t: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => (t = await bootApp()));
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  // ------------------------------------------------------------------ P1-7
  test('人员上岗资质：维护与报工校验（无资质/工序不符/过期/培训期/停用均拦截）', async () => {
    const { api } = t;
    const ref = await api.ids();
    const users = await api.as('qa').ok('get', '/api/qualifications/users');
    const uid = Object.fromEntries(users.map((u: any) => [u.username, u.id]));
    expect((await api.as('op1').get('/api/qualifications/users')).status).toBe(403);

    // 基础数据：op1、op2 全部工序有效
    const list = await api.ok('get', '/api/qualifications', { user_id: uid.op1 });
    expect(list.items).toHaveLength(1);
    expect([list.items[0].op_code, list.items[0].user_full_name, list.items[0].username, list.items[0].valid]).toEqual(['*', '刘操作', 'op1', true]);
    expect(list.items[0].certified_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const codes = await api.ok('get', '/api/qualifications/op-codes');
    expect(codes[0].code).toBe('*');
    expect(codes.map((c: any) => c.code)).toEqual(expect.arrayContaining(['ASM', 'OPT', 'SAFE', 'SMT']));

    // 维护权限：QA / 系统管理员；操作员不可
    const body = { user_id: uid.manager, op_code: 'ASM', certified_at: '2026-01-01', trainer: '赵QA', certificate: 'TR-M-01' };
    expect((await api.as('op1').post('/api/qualifications', body)).status).toBe(403);
    let r = await api.as('qa').post('/api/qualifications', { ...body, op_code: 'NOPE' });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('工序代码 NOPE');
    r = await api.as('qa').post('/api/qualifications', { ...body, expires_at: '2025-12-31' });
    expect(r.body.detail).toBe('有效期不能早于取证日期');

    const { wo, sns } = await rlWo(api, ref, 2);
    // 厂长（有报工权限）未取得资质 → 拦截
    r = await report(api, sns[0], 10, ref, {}, 'manager');
    expect(r.status).toBe(400);
    expect(r.body.detail).toBe('您尚未取得工序【ASM 整机组装】的上岗资质，请联系质量部培训考核');

    const q = await api.as('qa').ok('post', '/api/qualifications', body);
    expect([q.level, q.valid, q.user_full_name, q.created_by]).toEqual(['QUALIFIED', true, '王厂长', 'qa']);
    expect((await report(api, sns[0], 10, ref, {}, 'manager')).body.result).toBe('PASS');
    // 只有 ASM 资质，不能做光学测试
    r = await report(api, sns[0], 20, ref, {}, 'manager');
    expect(r.body.detail).toContain('工序【OPT 光学性能测试】的上岗资质');
    // 报工记录归属真实操作人
    const recs = await api.ok('get', `/api/work-orders/${wo.id}/records`);
    expect(recs[0].operator_name).toBe('王厂长');

    // 过期
    await api.as('admin').ok('put', `/api/qualifications/${q.id}`, { certified_at: '2025-01-01', expires_at: '2025-12-31' });
    r = await report(api, sns[1], 10, ref, {}, 'manager');
    expect(r.body.detail).toContain('已于 2025-12-31 过期');
    // 培训期（TRAINEE）不能独立上岗
    await api.as('qa').ok('put', `/api/qualifications/${q.id}`, { expires_at: null, level: 'TRAINEE' });
    r = await report(api, sns[1], 10, ref, {}, 'manager');
    expect(r.body.detail).toContain('培训期');
    // 停用
    await api.as('qa').ok('put', `/api/qualifications/${q.id}`, { level: 'QUALIFIED', is_active: false });
    expect((await report(api, sns[1], 10, ref, {}, 'manager')).body.detail).toContain('上岗资质');
    const got = await api.ok('get', `/api/qualifications/${q.id}`);
    expect([got.is_active, got.valid, got.expires_at]).toEqual([false, false, null]);
    expect((await api.ok('get', '/api/qualifications', { op_code: 'ASM' })).items.map((x: any) => x.id)).toEqual([q.id]);
    expect((await api.ok('get', '/api/qualifications', { valid: 1 })).items.map((x: any) => x.username).sort()).toEqual(['op1', 'op2']);
    expect((await api.ok('get', '/api/qualifications', { q: '王厂长' })).total).toBe(1);

    // 批量报工同样校验
    let bwo = await api.as('pmc').ok('post', '/api/work-orders', { material_id: ref.m['SA-RL300-LB'], planned_qty: 5 });
    bwo = await api.as('pmc').ok('post', `/api/work-orders/${bwo.id}/release`);
    r = await api.as('manager').post(`/api/work-orders/${bwo.id}/report-batch`, { seq: 10, good_qty: 5 });
    expect(r.body.detail).toContain('工序【SMT SMT贴片+回流焊】的上岗资质');
    await api.as('qa').ok('put', `/api/qualifications/${q.id}`, { is_active: true, op_code: '*' });
    await api.as('manager').ok('post', `/api/work-orders/${bwo.id}/report-batch`, { seq: 10, good_qty: 5 });

    // 删除（审计追踪保留）
    await api.as('qa').ok('delete', `/api/qualifications/${q.id}`);
    expect((await api.get(`/api/qualifications/${q.id}`)).status).toBe(404);
    const logs = (await api.ok('get', '/api/system/audit-logs', { entity: 'hr_qualification', entity_id: q.id })).items;
    expect(logs.some((l: any) => l.action === 'DELETE')).toBe(true);
  });

  // ------------------------------------------------------------------ P1-1
  test('返工换件：仅返工中可登记；装上件须合格/未过期/客供隔离，补领库存并计入追溯', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const inv = t.app.get(InventoryService);
    const { wo, sns } = await rlWo(api, ref, 2);
    const sn = sns[0];
    const kp = (body: Record<string, unknown>, user = 'op1') => api.as(user).post('/api/mes/rework-parts', { sn, ...body });
    const ic = ref.m['IC-DRV-CC'];
    const psu = ref.m['PSU-24V-5A'];

    expect((await report(api, sn, 10, ref)).body.result).toBe('PASS');
    // 未返工的产品不能登记
    let r = await kp({ removed: [{ material_id: ic }] });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('不在返工中');
    const fail = (await report(api, sn, 20, ref, { values: { WL_RED: 660, WL_NIR: 850, IRR: 65 } })).body;
    expect(fail.result).toBe('FAIL');
    // NG 待处置也不能登记
    expect((await kp({ removed: [{ material_id: ic }] })).body.detail).toContain('不在返工中');
    const ncr = await api.find('/api/ncrs', { q: fail.ncr_no });
    await api.as('qa').ok('post', `/api/ncrs/${ncr.id}/disposition`, { disposition: 'REWORK', remark: '更换驱动IC', signature: SIG });

    // 扫码：返工中，提示可登记换件
    let scan = await api.ok('get', `/api/mes/scan/${sn}`);
    expect(scan.rework).toMatchObject({ ncr_no: fail.ncr_no, ng_seq: 20, op_name: '光学性能测试', disposition_remark: '更换驱动IC' });
    expect(scan.key_parts).toEqual([]);

    // 权限、参数
    expect((await kp({ removed: [{ material_id: ic }] }, 'qc')).status).toBe(403);
    expect((await kp({})).body.detail).toBe('请登记拆下或装上的零件');
    // 待检批次不能装
    await db.tx((tx) => inv.addStock(tx, {
      material_id: ic, location_id: ref.loc['RAW-A01'], lot_no: 'IC-Q-1', status: 'QUARANTINE', qty: 10, move_type: 'PO_RECEIPT', ref: { ref_no: 'T' },
    }));
    r = await kp({ installed: [{ material_id: ic, lot_no: 'IC-Q-1' }] });
    expect(r.body.detail).toBe('批次 IC-Q-1 质量状态为【待检/待放行】，不能用于返工');
    // 过期批次不能装
    await db.tx((tx) => inv.addStock(tx, {
      material_id: ic, location_id: ref.loc['RAW-A01'], lot_no: 'IC-EXP-1', status: 'AVAILABLE', qty: 10, move_type: 'PO_RECEIPT',
      ref: { ref_no: 'T' }, expiry_date: addDays(today(), -1),
    }));
    r = await kp({ installed: [{ material_id: ic, lot_no: 'IC-EXP-1' }] });
    expect(r.body.detail).toContain('批次 IC-EXP-1 已过期');
    // 其他客户的客供料不能装（客供隔离）
    const c3 = (await api.find('/api/customers', { q: 'C003' })).id;
    const cs = await api.as('engineer').ok('post', '/api/materials', { code: 'CS-C3-PART', name: '客供件（BrightSkin）', category: 'RAW', owner_customer_id: c3 });
    await db.tx((tx) => inv.addStock(tx, {
      material_id: cs.id, location_id: ref.loc['CS-01'], lot_no: 'C3-LOT', status: 'AVAILABLE', qty: 5, move_type: 'CS_RECEIPT', ref: { ref_no: 'T' }, owner_customer_id: c3,
    }));
    r = await kp({ installed: [{ material_id: cs.id, lot_no: 'C3-LOT' }] });
    expect(r.body.detail).toBe('CS-C3-PART 为其他客户的客供料，不能用于本工单');
    // 库存不足
    r = await kp({ installed: [{ material_id: ic, lot_no: 'XD260830', qty: 100000 }] });
    expect(r.body.detail).toContain('库存不足');
    // 失败的请求不留下任何记录
    expect((await api.ok('get', `/api/mes/scan/${sn}`)).key_parts).toEqual([]);

    const icBefore = qtyBy(await stockOf(api, 'XD260830'), 'AVAILABLE');
    const psuIssued0 = (await api.ok('get', `/api/work-orders/${wo.id}`)).materials.find((m: any) => m.material_code === 'PSU-24V-5A').issued_qty;
    const res = await api.as('op2').ok('post', '/api/mes/rework-parts', {
      sn,
      removed: [{ material_id: ic, lot_no: 'XD260830', part_sn: 'U3', remark: '驱动IC击穿' }],
      installed: [
        { material_id: ic, lot_no: 'XD260830', part_sn: 'U3' },
        { material_id: psu, lot_no: 'HY2609A', location_id: ref.loc['RAW-A02'], qty: 1 },
      ],
      remark: '按 NCR 返工',
    });
    expect([res.removed, res.installed, res.ncr_no]).toEqual([1, 2, fail.ncr_no]);
    expect(res.key_parts.map((k: any) => [k.action, k.material_code, k.lot_no, k.part_sn, k.ncr_no, k.operator_name])).toEqual([
      ['REMOVE', 'IC-DRV-CC', 'XD260830', 'U3', fail.ncr_no, '黄操作'],
      ['INSTALL', 'IC-DRV-CC', 'XD260830', 'U3', fail.ncr_no, '黄操作'],
      ['INSTALL', 'PSU-24V-5A', 'HY2609A', null, fail.ncr_no, '黄操作'],
    ]);
    expect(res.key_parts[0].remark).toBe('驱动IC击穿；按 NCR 返工');
    // 库存补领（REWORK_ISSUE，关联 NCR）；BOM 中的物料累加工单已领数量
    expect(qtyBy(await stockOf(api, 'XD260830'), 'AVAILABLE')).toBe(icBefore - 1);
    const moves = (await api.ok('get', '/api/stock-moves', { move_type: 'REWORK_ISSUE' })).items;
    expect(moves.map((m: any) => [m.material_code, m.lot_no, m.qty, m.ref_type, m.ref_no, m.username]).sort()).toEqual([
      ['IC-DRV-CC', 'XD260830', 1, 'NCR', fail.ncr_no, 'op2'], ['PSU-24V-5A', 'HY2609A', 1, 'NCR', fail.ncr_no, 'op2'],
    ]);
    const woNow = await api.ok('get', `/api/work-orders/${wo.id}`);
    expect(woNow.materials.find((m: any) => m.material_code === 'PSU-24V-5A').issued_qty).toBe(psuIssued0 + 1);
    expect(woNow.materials.find((m: any) => m.material_code === 'IC-DRV-CC')).toBeUndefined(); // IC 不在整机 BOM 中

    // 扫码履历显示换件
    scan = await api.ok('get', `/api/mes/scan/${sn}`);
    expect(scan.key_parts.map((k: any) => k.action_text)).toEqual(['返工拆下', '返工装上', '返工装上']);

    // 重新测试通过后不再处于返工中
    expect((await report(api, sn, 20, ref)).body.result).toBe('PASS');
    expect((await api.ok('get', `/api/mes/scan/${sn}`)).rework).toBeNull();
    expect((await kp({ removed: [{ material_id: ic }] })).body.detail).toContain('不在返工中');
    await passAll(api, sn, ref, 30);

    // 单台追溯：关键件含动作与 NCR
    const tr = await api.ok('get', `/api/trace/serial/${sn}`);
    expect(tr.key_parts.map((k: any) => [k.action, k.material_code, k.lot_no])).toEqual([
      ['REMOVE', 'IC-DRV-CC', 'XD260830'], ['INSTALL', 'IC-DRV-CC', 'XD260830'], ['INSTALL', 'PSU-24V-5A', 'HY2609A'], ['BIND', 'PSU-24V-5A', 'HY2609A'],
    ]);
    expect(tr.key_parts[1].ncr_no).toBe(fail.ncr_no);
    // 正向追溯：返工装上的 IC 批次能追到该台
    const lot = await api.ok('get', '/api/trace/lot', { material_code: 'IC-DRV-CC', lot_no: 'XD260830' });
    const row = lot.serials.find((s: any) => s.sn === sn);
    expect([row.key_part_bound, row.key_part_removed]).toEqual([true, true]);
    expect(lot.work_orders.find((w: any) => w.id === wo.id).issued_qty).toBe(1);
    // DHR：关键件/换件记录 + 返工补料批次
    const dhr = await api.ok('get', `/api/work-orders/${wo.id}/dhr`);
    expect(dhr.key_parts.filter((k: any) => k.action !== 'BIND').map((k: any) => [k.sn, k.action, k.ncr_no])).toEqual([
      [sn, 'REMOVE', fail.ncr_no], [sn, 'INSTALL', fail.ncr_no], [sn, 'INSTALL', fail.ncr_no],
    ]);
    const rw = dhr.materials.filter((m: any) => m.source === 'REWORK').map((m: any) => [m.material_code, m.lot_no, m.qty]).sort();
    expect(rw).toEqual([['IC-DRV-CC', 'XD260830', 1], ['PSU-24V-5A', 'HY2609A', 1]]);
  });

  // ------------------------------------------------------------------ P1-2
  test('分批放行（序列号产品）：按序列号放行/拒绝，发货以放行批为准，全部放行后工单关闭', async () => {
    const { api } = t;
    const ref = await api.ids();
    const { wo, so, sns } = await rlWo(api, ref, 4);
    const sol = so.lines[0];
    for (const sn of sns.slice(0, 3)) await passAll(api, sn, ref);
    await api.as('wh').ok('post', `/api/work-orders/${wo.id}/fg-receipt`, { location_id: ref.loc['FG-01'] });
    let rel = await api.ok('get', `/api/work-orders/${wo.id}/releasable`);
    expect([rel.serial_control, rel.received_qty, rel.released_qty, rel.releasable_qty]).toEqual([true, 3, 0, 3]);
    expect(rel.serials.map((s: any) => s.sn)).toEqual(sns.slice(0, 3));

    // 未放行不能发货
    let r = await api.as('wh').post('/api/shipments', { so_id: so.id, lines: [{ so_line_id: sol.id, qty: 1, serials: [sns[0]] }] });
    expect(r.body.detail).toContain('尚未完成 DHR 审核放行');

    // 权限：仅 QA；需电子签名
    const url = `/api/work-orders/${wo.id}/releases`;
    expect((await api.as('wh').post(url, { serials: [sns[0]], signature: SIG })).status).toBe(403);
    expect((await api.as('manager').post(url, { serials: [sns[0]], signature: SIG })).status).toBe(403);
    r = await api.as('qa').post(url, { serials: [sns[0]] });
    expect(r.body.detail).toContain('电子签名');
    // 未入库的序列号不能放行
    r = await api.as('qa').post(url, { serials: [sns[3]], signature: SIG });
    expect(r.body.detail).toBe(`序列号 ${sns[3]} 状态为【CREATED】，只有已完工入库的产品才能放行`);

    // 第 1 批：放行 1 台
    const b1 = await api.as('qa').ok('post', url, { serials: [sns[0]], approve: true, reason: '首批出货', signature: SIG });
    expect(b1.release.no).toMatch(/^FX\d{9}$/);
    expect([b1.release.qty, b1.release.status, b1.release.sn_list, b1.release.wo_no, b1.release.released_by]).toEqual([1, 'RELEASED', [sns[0]], wo.no, '赵QA']);
    expect([b1.wo_status, b1.dhr_status, b1.released_qty]).toEqual(['IN_PROGRESS', 'OPEN', 1]);
    let st = await stockOf(api, wo.lot_no);
    expect([qtyBy(st, 'AVAILABLE'), qtyBy(st, 'QUARANTINE')]).toEqual([1, 2]);
    const sigs = (await api.ok('get', '/api/system/esignatures', { entity: 'mes_product_release', entity_id: b1.release.id })).items;
    expect([sigs[0].meaning, sigs[0].doc_no, sigs[0].full_name]).toEqual(['产品放行（分批）', b1.release.no, '赵QA']);
    // 重复放行
    r = await api.as('qa').post(url, { serials: [sns[0]], signature: SIG });
    expect(r.body.detail).toContain('已在放行批');

    // 发货：只能发已放行的那一台
    expect((await api.ok('get', '/api/serials/available', { material_id: ref.m['FG-RL300'] })).map((s: any) => s.sn)).toEqual([sns[0]]);
    r = await api.as('wh').post('/api/shipments', { so_id: so.id, lines: [{ so_line_id: sol.id, qty: 1, serials: [sns[1]] }] });
    expect(r.status).toBe(400);
    let sh = await api.as('wh').ok('post', '/api/shipments', { so_id: so.id, lines: [{ so_line_id: sol.id, qty: 1 }] });
    expect(sh.lines[0].serial_list).toEqual([sns[0]]);
    sh = await api.as('wh').ok('post', `/api/shipments/${sh.id}/confirm`);
    expect(sh.status).toBe('SHIPPED');

    // 第 2 批：拒绝 1 台（须填原因）→ 冻结，不能发货
    r = await api.as('qa').post(url, { serials: [sns[1]], approve: false, signature: { password: SIG.password } });
    expect(r.body.detail).toBe('拒绝放行须填写原因');
    const b2 = await api.as('qa').ok('post', url, { serials: [sns[1]], approve: false, reason: '外观划伤待调查', signature: SIG });
    expect([b2.release.status, b2.released_qty]).toEqual(['REJECTED', 1]);
    st = await stockOf(api, wo.lot_no);
    expect([qtyBy(st, 'HOLD'), qtyBy(st, 'QUARANTINE')]).toEqual([1, 1]);
    r = await api.as('wh').post('/api/shipments', { so_id: so.id, lines: [{ so_line_id: sol.id, qty: 1, serials: [sns[1]] }] });
    expect(r.body.detail).toContain('已被 QA 拒绝放行');

    // 存在未处置 NCR 的产品不能放行（第 4 台在光学测试不合格）
    await report(api, sns[3], 10, ref);
    const fail = (await report(api, sns[3], 20, ref, { values: { WL_RED: 660, WL_NIR: 850, IRR: 65 } })).body;
    const ncr = await api.find('/api/ncrs', { q: fail.ncr_no });
    await api.as('qa').ok('post', `/api/ncrs/${ncr.id}/disposition`, { disposition: 'REWORK', signature: SIG });
    await passAll(api, sns[3], ref, 20);
    await api.as('wh').ok('post', `/api/work-orders/${wo.id}/fg-receipt`, { location_id: ref.loc['FG-02'] });
    let w = await api.ok('get', `/api/work-orders/${wo.id}`);
    expect([w.status, w.received_qty]).toEqual(['COMPLETED', 4]);
    const manual = await api.as('qc').ok('post', '/api/ncrs', { source: 'OTHER', sn: sns[3], description: '包装复检发现标签歪斜' });
    rel = await api.ok('get', `/api/work-orders/${wo.id}/releasable`);
    expect(rel.serials.map((s: any) => s.sn)).toEqual([sns[2]]);
    expect(rel.blocked).toEqual([{ sn: sns[3], reason: `存在未处置的不合格（${manual.no}）` }]);
    r = await api.as('qa').post(url, { serials: [sns[3]], signature: SIG });
    expect(r.body.detail).toContain('存在未处置的不合格（NCR）');
    await api.as('qa').ok('post', `/api/ncrs/${manual.id}/disposition`, { disposition: 'REWORK', remark: '重贴标签', signature: SIG });

    // 第 3 批：按数量放行（取完工最早的 1 台），工单未全部放行（有拒绝批）→ 不关闭
    const b3 = await api.as('qa').ok('post', url, { qty: 1, signature: SIG });
    expect(b3.release.sn_list).toEqual([sns[2]]);
    expect([b3.wo_status, b3.dhr_status, b3.released_qty]).toEqual(['COMPLETED', 'OPEN', 2]);
    // 第 4 批：默认放行全部可放行（FG-02 库位的那台）
    const b4 = await api.as('qa').ok('post', url, { signature: SIG });
    expect([b4.release.sn_list, b4.released_qty, b4.dhr_status]).toEqual([[sns[3]], 3, 'OPEN']);
    expect((await stockOf(api, wo.lot_no)).filter((s: any) => s.status === 'AVAILABLE').map((s: any) => [s.location_code, s.qty]).sort())
      .toEqual([['FG-01', 1], ['FG-02', 1]]);
    r = await api.as('qa').post(url, { signature: SIG });
    expect(r.body.detail).toContain('没有可放行的产品');

    // 整单“放行全部剩余”：剩余 0 台，检查通过 → DHR 已放行、工单关闭
    w = await api.as('qa').ok('post', `/api/work-orders/${wo.id}/dhr/release`, { approve: true, signature: SIG });
    expect([w.dhr_status, w.status, w.released_qty]).toEqual(['RELEASED', 'CLOSED', 3]);
    r = await api.as('qa').post(url, { signature: SIG });
    expect(r.body.detail).toBe('该批已全部放行');

    const list = await api.ok('get', `/api/work-orders/${wo.id}/releases`);
    expect(list.map((x: any) => [x.status, x.qty, x.sn_list])).toEqual([
      ['RELEASED', 1, [sns[0]]], ['REJECTED', 1, [sns[1]]], ['RELEASED', 1, [sns[2]]], ['RELEASED', 1, [sns[3]]],
    ]);
    const serials = await api.ok('get', `/api/work-orders/${wo.id}/serials`);
    expect(serials.map((s: any) => s.release_status)).toEqual(['RELEASED', 'REJECTED', 'RELEASED', 'RELEASED']);
    const dhr = await api.ok('get', `/api/work-orders/${wo.id}/dhr`);
    expect(dhr.releases).toHaveLength(4);
    expect(dhr.signatures.map((s: any) => s.meaning)).toEqual(expect.arrayContaining(['产品放行（分批）', '产品放行（分批拒绝）', '产品放行（DHR审核批准）']));
    const tr = await api.ok('get', `/api/trace/serial/${sns[0]}`);
    expect([tr.serial.release_no, tr.serial.release_status]).toEqual([b1.release.no, 'RELEASED']);
  });

  test('分批放行全部完成后自动关闭工单；物料未足额领用不能放行；整单放行等价于放行全部剩余', async () => {
    const { api } = t;
    const ref = await api.ids();
    // A：两批放行完 → 自动关闭
    const a = await rlWo(api, ref, 2);
    for (const sn of a.sns) await passAll(api, sn, ref);
    await api.as('wh').ok('post', `/api/work-orders/${a.wo.id}/fg-receipt`, { location_id: ref.loc['FG-01'] });
    const urlA = `/api/work-orders/${a.wo.id}/releases`;
    expect((await api.as('qa').ok('post', urlA, { serials: [a.sns[1]], signature: SIG })).dhr_status).toBe('OPEN');
    const last = await api.as('qa').ok('post', urlA, { serials: [a.sns[0]], signature: SIG });
    expect([last.wo_status, last.dhr_status, last.released_qty]).toEqual(['CLOSED', 'RELEASED', 2]);
    expect((await api.as('qa').post(`/api/work-orders/${a.wo.id}/dhr/release`, { approve: true, signature: SIG })).body.detail).toBe('该批已放行');

    // B：未领料生产 → 物料不足，不能放行
    const b = await rlWo(api, ref, 1, false);
    await passAll(api, b.sns[0], ref);
    await api.as('wh').ok('post', `/api/work-orders/${b.wo.id}/fg-receipt`, { location_id: ref.loc['FG-01'] });
    const r = await api.as('qa').post(`/api/work-orders/${b.wo.id}/releases`, { signature: SIG });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('物料未按 BOM 足额领用');
    expect(r.body.detail).toContain('SA-RL300-LB 已领 0 < 应耗 1');

    // C：部分放行后，整单审核放行剩余全部
    const c = await rlWo(api, ref, 3);
    for (const sn of c.sns) await passAll(api, sn, ref);
    await api.as('wh').ok('post', `/api/work-orders/${c.wo.id}/fg-receipt`, { location_id: ref.loc['FG-01'] });
    await api.as('qa').ok('post', `/api/work-orders/${c.wo.id}/releases`, { serials: [c.sns[0]], signature: SIG });
    const w = await api.as('qa').ok('post', `/api/work-orders/${c.wo.id}/dhr/release`, { approve: true, reason: '记录完整', signature: SIG });
    expect([w.dhr_status, w.status, w.released_qty]).toEqual(['RELEASED', 'CLOSED', 3]);
    const rels = await api.ok('get', `/api/work-orders/${c.wo.id}/releases`);
    expect(rels.map((x: any) => [x.status, x.qty, x.sn_list.length])).toEqual([['RELEASED', 1, 1], ['RELEASED', 2, 2]]);
    expect(rels[1].reason).toBe('整单放行（剩余全部）：记录完整');
    const st = await stockOf(api, c.wo.lot_no);
    expect([qtyBy(st, 'AVAILABLE'), qtyBy(st, 'QUARANTINE')]).toEqual([3, 0]);
    const avail = (await api.ok('get', '/api/serials/available', { material_id: ref.m['FG-RL300'] })).map((s: any) => s.sn);
    expect(avail).toEqual(expect.arrayContaining([...a.sns, ...c.sns]));
    expect(avail).not.toContain(b.sns[0]);
    // 放行待办筛选：只剩 B（已入库未放行）
    const todo = await api.ok('get', '/api/work-orders', { releasable: 1 });
    expect(todo.items.map((x: any) => x.id)).toEqual([b.wo.id]);
  });

  test('分批放行（批量产品）：按数量放行，不超过已入库未放行；有未处置 NCR 不能放行；全部放行后关闭', async () => {
    const { api } = t;
    const ref = await api.ids();
    let wo = await api.as('pmc').ok('post', '/api/work-orders', { material_id: ref.m['SA-RL300-LB'], planned_qty: 10 });
    wo = await api.as('pmc').ok('post', `/api/work-orders/${wo.id}/release`);
    const iss = await api.as('wh').ok('post', `/api/work-orders/${wo.id}/issues`, {});
    await api.as('wh').ok('post', `/api/issues/${iss.id}/confirm`);
    const op = api.as('op1');
    await op.ok('post', `/api/work-orders/${wo.id}/report-batch`, { seq: 10, good_qty: 8, ng_qty: 2 });
    await op.ok('post', `/api/work-orders/${wo.id}/report-batch`, { seq: 20, good_qty: 8 });
    await api.as('wh').ok('post', `/api/work-orders/${wo.id}/fg-receipt`, { location_id: ref.loc['LINE-01'], qty: 6 });
    const url = `/api/work-orders/${wo.id}/releases`;
    // 工单有未处置 NCR → 不能放行
    let r = await api.as('qa').post(url, { qty: 2, signature: SIG });
    expect(r.body.detail).toContain('未处置的不合格（NCR）');
    const ncr = await api.find('/api/ncrs', { wo_id: wo.id });
    await api.as('qa').ok('post', `/api/ncrs/${ncr.id}/disposition`, { disposition: 'SCRAP', signature: SIG });

    const b1 = await api.as('qa').ok('post', url, { qty: 4, signature: SIG });
    expect([b1.release.qty, b1.released_qty, b1.wo_status]).toEqual([4, 4, 'COMPLETED']);
    r = await api.as('qa').post(url, { qty: 3, signature: SIG });
    expect(r.body.detail).toBe('放行数量超出：可放行 2 PCS（已入库 − 已放行 − 已拒绝）');
    let st = await stockOf(api, wo.lot_no);
    expect([qtyBy(st, 'AVAILABLE'), qtyBy(st, 'QUARANTINE')]).toEqual([4, 2]);
    // 剩余入库后一次放行全部 → 关闭
    await api.as('wh').ok('post', `/api/work-orders/${wo.id}/fg-receipt`, { location_id: ref.loc['LINE-01'] });
    const sum = await api.ok('get', `/api/work-orders/${wo.id}/releasable`);
    expect([sum.serial_control, sum.received_qty, sum.released_qty, sum.releasable_qty]).toEqual([false, 8, 4, 4]);
    const b2 = await api.as('qa').ok('post', url, { signature: SIG });
    expect([b2.release.qty, b2.released_qty, b2.wo_status, b2.dhr_status]).toEqual([4, 8, 'CLOSED', 'RELEASED']);
    st = await stockOf(api, wo.lot_no);
    expect([qtyBy(st, 'AVAILABLE'), qtyBy(st, 'QUARANTINE')]).toEqual([8, 0]);
  });
});
