/**
 * 第二轮修复 R3（质量）端到端测试：
 *   D-N1 可关闭 NCR（closableNcrIds / ?closable=1）；D-N2 返工“需更换零件”（Ncr.require_part_change）；
 *   D-N3 放行结论给出可直接关闭的 NCR 与提示项；D-N4 客诉按序列号带出客户、按客户带出国家、国家统一中文、改国家重算期限；
 *   D-N7 IQC 判退原因（定量逐件 Ac=0 与 AQL 不良分开）+ 正式字段 InspectionItem.defect_qty；
 *   正式字段 Qualification.voided_*、Capa.owner_user_id；N19 CAPA 按来源默认期限；N14 资质签名单据号为姓名。
 */
import { addDays, today } from '../src/common/dates';
import { closableNcrIds } from '../src/qms/qms-rules';
import { Api, bootApp, SIG } from './harness';

type Ref = Awaited<ReturnType<Api['ids']>>;
const D = (n: number) => addDays(today(), n).toISOString().slice(0, 10);

const GOOD: Record<number, Record<string, number>> = {
  20: { WL_RED: 660, WL_NIR: 850, IRR: 50 },
  30: { AGE_H: 4, IRR_DROP: 1.2 },
  40: { HIPOT: 1.1, EARTH_LK: 120, PAT_LK: 20 },
};
function report(api: Api, sn: string, seq: number, ref: Ref, kw: Record<string, unknown> = {}) {
  const eq = ({ 20: ref.eq['EQ-SPEC-01'], 30: ref.eq['EQ-AGING-01'], 40: ref.eq['EQ-SAFE-01'] } as Record<number, number>)[seq] ?? null;
  const body: Record<string, unknown> = { sn, seq, values: GOOD[seq] ?? {}, equipment_id: eq };
  if (seq === 60) body.key_parts = [{ lot_no: 'HY2609A' }];
  return api.as('op1').post('/api/mes/report', { ...body, ...kw });
}
async function passFrom(api: Api, sn: string, ref: Ref, from = 10) {
  for (const seq of [10, 20, 30, 40, 50, 60].filter((s) => s >= from)) {
    const r = await report(api, sn, seq, ref);
    if (r.status !== 200 || r.body.result !== 'PASS') throw new Error(`${sn}@${seq}: ${r.status} ${JSON.stringify(r.body)}`);
  }
}
async function rlWo(api: Api, ref: Ref, qty: number) {
  const pmc = api.as('pmc');
  const so = await pmc.ok('get', `/api/sales-orders/${(await pmc.find('/api/sales-orders', { q: 'LUM-PO-26-118' })).id}`);
  let wo = await pmc.ok('post', '/api/work-orders', { material_id: ref.m['FG-RL300'], planned_qty: qty, so_id: so.id, so_line_id: so.lines[0].id });
  wo = await pmc.ok('post', `/api/work-orders/${wo.id}/release`);
  const iss = await api.as('wh').ok('post', `/api/work-orders/${wo.id}/issues`, {});
  await api.as('wh').ok('post', `/api/issues/${iss.id}/confirm`);
  const sns: string[] = (await pmc.ok('get', `/api/work-orders/${wo.id}/serials`)).map((s: any) => s.sn);
  return { wo, sns };
}
async function receive(api: Api, ref: Ref, code: string, lot: string, qty: number, loc = 'DRY-01') {
  await api.as('wh').ok('post', '/api/receipts', { receipt_type: 'OTHER', lines: [{ material_id: ref.m[code], qty, location_id: ref.loc[loc], lot_no: lot }] });
  const insp = await api.find('/api/inspections', { q: lot });
  return api.ok('get', `/api/inspections/${insp.id}`);
}
function allPass(detail: any, override: Record<string, Partial<any>> = {}) {
  const need = Math.min(detail.sample_size, 5);
  return detail.items.map((i: any) => {
    const mid = i.lower !== null && i.upper !== null ? (i.lower + i.upper) / 2 : i.lower ?? i.upper;
    const base = i.item_type === 'QUANT'
      ? { id: i.id, name: i.name, sample_values: Array.from({ length: need }, () => mid) }
      : { id: i.id, name: i.name, checked: true, result: 'PASS' };
    return { ...base, ...(override[i.name] ?? {}) };
  });
}

describe('R3 质量（第二轮）', () => {
  let t: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => (t = await bootApp()));
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  test('IQC：定量项超限单独计（Ac=0），AQL 不良数只计定性项；单项不良数写正式字段；NCR 写明判退原因', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const d = await receive(api, ref, 'LED-660-3030', 'R3-660', 1000);
    // 只有定量项 2 件超限：AQL 不良数可为 0，仍判退
    const items = allPass(d, { 峰值波长抽测: { sample_values: [660, 661, 668.2, 659, 669] }, 外观: { result: 'FAIL', defect_qty: 1, value: '引脚氧化' } });
    const res = await api.as('qc').ok('post', `/api/inspections/${d.id}/submit`, { items, defect_qty: 1, signature: SIG });
    expect([res.status, res.defect_qty]).toEqual(['REJECTED', 1]);
    const rows = await db.client.inspectionItem.findMany({ where: { inspection_id: d.id }, orderBy: { id: 'asc' } });
    const look = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect([look['外观'].defect_qty, look['外观'].sample_values, look['峰值波长抽测'].defect_qty]).toEqual([1, null, 2]);
    expect(res.items.find((i: any) => i.name === '外观').item_defects).toBe(1);
    const ncr = await api.find('/api/ncrs', { q: 'R3-660' });
    expect(ncr.description).toContain('判退原因：定量项超限（逐件判定，Ac=0）：峰值波长抽测 2/5 件超限（668.2、669nm）');
    expect(ncr.description).toContain('定性项不合格：外观（不良 1 件，引脚氧化）');
    expect(ncr.description).toContain('AQL 抽样 n=80，不良 1 件（Ac=1 / Re=2）');
    // 旧数据兼容：定性项不良数存于 sample_values 时仍能读出
    await db.client.inspectionItem.update({ where: { id: look['外观'].id }, data: { defect_qty: 0, sample_values: JSON.stringify({ defects: 4 }) } });
    expect((await api.ok('get', `/api/inspections/${d.id}`)).items.find((i: any) => i.name === '外观').item_defects).toBe(4);
  });

  test('NCR：返工“需更换零件”写入正式字段；可关闭 NCR 清单与 ?closable=1；创建人显示姓名', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const { sns } = await rlWo(api, ref, 2);
    await report(api, sns[0], 10, ref);
    expect((await report(api, sns[0], 20, ref, { values: { WL_RED: 690, WL_NIR: 850, IRR: 50 } })).body.result).toBe('FAIL');
    const ncr = await api.find('/api/ncrs', { q: sns[0] });
    const d = await api.as('qa').ok('post', `/api/ncrs/${ncr.id}/disposition`, { disposition: 'REWORK', remark: '清洁光学窗口后重测', require_part_change: true, signature: SIG });
    expect(d.require_part_change).toBe(true);
    const sigs = (await api.ok('get', '/api/system/esignatures', { entity: 'qms_ncr' })).items;
    expect(sigs[0].meaning).toBe('不合格品评审处置：返工/返修（需换件）');
    // 报废不会带上换件要求
    const other = await api.as('qc').ok('post', '/api/ncrs', { source: 'OTHER', description: '巡检：外壳划伤' });
    expect((await api.as('qa').ok('post', `/api/ncrs/${other.id}/disposition`, { disposition: 'SCRAP', require_part_change: true, signature: SIG })).require_part_change).toBe(false);
    expect(other.created_by).toBe('qc');
    expect((await api.ok('get', '/api/ncrs', { id: other.id })).items[0].created_by_name).toBe('孙质检');

    // 报废已执行完毕 → 可关闭；返工未复测 → 不可关闭
    expect(await closableNcrIds(db.client)).toEqual([other.id]);
    expect((await api.ok('get', '/api/ncrs', { closable: 1 })).items.map((x: any) => x.no)).toEqual([other.no]);
    // 工位换件、复测后返工 NCR 也进入可关闭
    await api.as('op1').ok('post', '/api/mes/rework-parts', { sn: sns[0], removed: [{ material_id: ref.m['IC-DRV-CC'], remark: '击穿' }] });
    await passFrom(api, sns[0], ref, 20);
    expect((await api.ok('get', '/api/ncrs', { closable: 1, sort: 'id', order: 'asc' })).items.map((x: any) => x.id)).toEqual([ncr.id, other.id].sort((a, b) => a - b));
  });

  test('放行结论：有提示的产品列出其 NCR 且可直接关闭；全部通过的不带提示', async () => {
    const { api } = t;
    const ref = await api.ids();
    const { wo, sns } = await rlWo(api, ref, 2);
    await passFrom(api, sns[0], ref);
    await report(api, sns[1], 10, ref);
    await report(api, sns[1], 20, ref, { values: { WL_RED: 690, WL_NIR: 850, IRR: 50 } });
    const ncr = await api.find('/api/ncrs', { q: sns[1] });
    await api.as('qa').ok('post', `/api/ncrs/${ncr.id}/disposition`, { disposition: 'REWORK', remark: '重新校准后重测', signature: SIG });
    await passFrom(api, sns[1], ref, 20);
    await api.as('wh').ok('post', `/api/work-orders/${wo.id}/fg-receipt`, { location_id: ref.loc['FG-01'] });
    let rc = await api.ok('get', `/api/quality/release-check/${wo.id}`);
    const u2 = rc.units.find((u: any) => u.sn === sns[1]);
    expect([u2.ok, u2.warn, u2.checks.ncr.level]).toEqual([true, true, 'warn']);
    expect(u2.ncrs.map((n: any) => [n.no, n.closable])).toEqual([[ncr.no, true]]);
    expect(rc.closable_ncrs.map((n: any) => n.no)).toEqual([ncr.no]);
    expect(rc.units.find((u: any) => u.sn === sns[0]).warn).toBe(false);
    await api.as('qa').ok('post', `/api/ncrs/${ncr.id}/close`, { signature: SIG });
    rc = await api.ok('get', `/api/quality/release-check/${wo.id}`);
    expect([rc.units.find((u: any) => u.sn === sns[1]).warn, rc.closable_ncrs]).toEqual([false, []]);
  });

  test('客诉：按序列号带出客户与国家（中文）、改国家立即重算上报期限、旧代码兼容', async () => {
    const { api, db } = t;
    const c1 = await api.find('/api/customers', { q: 'C001' });
    await db.client.customer.update({ where: { id: c1.id }, data: { country: '美国' } });
    const wo = await db.client.workOrder.create({ data: { no: 'WO-R3-KS', material_id: (await api.ids()).m['FG-RL300'], customer_id: c1.id, planned_qty: 1, lot_no: 'BR3', status: 'CLOSED' } });
    await db.client.serialNumber.create({ data: { sn: 'RL3R3001', wo_id: wo.id, material_id: wo.material_id, lot_no: 'BR3', status: 'SHIPPED', customer_id: c1.id } });

    const look = await api.as('sales').ok('get', '/api/complaints/lookup', { sn: 'RL3R3001' });
    expect([look.customer_id, look.customer_name, look.country, look.lot_no]).toEqual([c1.id, 'Lumina Health Inc.', '美国', 'BR3']);
    // 只填序列号：客户、国家自动带出，上报期限按美国 30 天
    let c = await api.as('sales').ok('post', '/api/complaints', { sn: 'RL3R3001', description: '面板发烫', is_adverse_event: true });
    expect([c.customer_id, c.country, c.material_code, c.report_due]).toEqual([c1.id, '美国', 'FG-RL300', D(30)]);
    // 评估需上报 → 期限 30 天；改国家为中国 → 立即按 20 天重算
    c = await api.as('qa').ok('put', `/api/complaints/${c.id}`, { reportable: true });
    expect(c.report_deadline).toBe(D(30));
    c = await api.as('qa').ok('put', `/api/complaints/${c.id}`, { country: '中国' });
    expect([c.country, c.report_deadline]).toEqual(['中国', D(20)]);
    // 英文代码统一为中文；欧盟 15 天
    c = await api.as('qa').ok('put', `/api/complaints/${c.id}`, { country: 'EU' });
    expect([c.country, c.report_deadline]).toEqual(['欧盟', D(15)]);
    // 手工指定的期限不被覆盖
    c = await api.as('qa').ok('put', `/api/complaints/${c.id}`, { country: 'US', report_deadline: D(10) });
    expect([c.country, c.report_deadline]).toEqual(['美国', D(10)]);
    // 没有发货客户的序列号须选客户
    const r = await api.as('sales').post('/api/complaints', { description: 'x' });
    expect([r.status, r.body.detail]).toEqual([400, '请选择投诉客户']);
    expect((await api.as('sales').ok('get', '/api/complaints/lookup', { sn: 'NOPE' })).found).toBe(false);
    // 由客诉发起的 CAPA 默认 30 天期限
    c = await api.as('qa').ok('post', `/api/complaints/${c.id}/capa`);
    expect((await api.ok('get', `/api/capas/${c.capa_id}`)).due_date).toBe(D(30));
    expect(c.created_by_name).toBe('李销售');
  });

  test('CAPA 负责人账号（owner_user_id）与按来源默认期限；资质作废写正式字段、签名单据号为姓名', async () => {
    const { api } = t;
    const owners = await api.ok('get', '/api/capas/owners', { q: 'engineer' });
    let capa = await api.as('qa').ok('post', '/api/capas', { title: '审核发现：SOP 未受控', source: 'AUDIT', owner_user_id: owners[0].id });
    expect([capa.owner_user_id, capa.owner, capa.due_date]).toEqual([owners[0].id, owners[0].full_name, D(60)]);
    capa = await api.as('qa').ok('put', `/api/capas/${capa.id}`, { title: '审核发现：SOP 未受控', owner: owners[0].full_name });
    expect(capa.owner_user_id).toBe(owners[0].id);
    expect((await api.ok('get', '/api/capas', { owner_user_id: owners[0].id })).items[0].created_by_name).toBe('赵QA');

    const users = await api.as('qa').ok('get', '/api/qualifications/users', { badge: 'E1002' });
    const q = await api.as('qa').ok('post', '/api/qualifications', { user_id: users[0].id, op_code: 'OPT', certified_at: D(0), signature: SIG });
    const v = await api.as('qa').ok('post', `/api/qualifications/${q.id}/void`, { reason: '选错工序', signature: SIG });
    expect([v.is_active, v.voided_by, v.void_reason, !!v.voided_at]).toEqual([false, '赵QA', '选错工序', true]);
    const sigs = (await api.ok('get', '/api/system/esignatures', { entity: 'hr_qualification' })).items;
    expect(sigs.map((s: any) => s.doc_no)).toEqual(expect.arrayContaining(['黄操作（E1002） OPT']));
    expect((await api.ok('get', '/api/qualifications', { user_id: users[0].id })).items.find((x: any) => x.id === q.id).created_by_name).toBe('赵QA');
  });
});
