/**
 * 好用性修复 G6（质量）端到端测试：
 *   D#8/#9/#14 IQC 定量/定性逐项检验、自动判定、不良数关联检验项、未完成不能提交、检验单快照、下一张待检单、AQL 检验水平
 *   D#5/#6/#23 NCR 处置期限/超期筛选、返工复测后才能关闭、关闭需签名、批量关闭
 *   D#7 退货 → 退供应商单（不扣库存）→ 仓管出库扣账 / QA 取消退回重新评审
 *   D#10 上岗资质：只列有报工权限人员、按工牌查找、登记/变更/作废需签名、人员不可修改
 *   D#11 放行结论（按序列号逐项检查）
 *   D#12 客诉法规字段与结案规则；D#19 CAPA 默认期限、负责人、关闭检查；D#20 检验规范定量项、免检物料、版本；D#25 召回清单字段
 */
import { addDays, today } from '../src/common/dates';
import { Api, bootApp, SIG } from './harness';

type Ref = Awaited<ReturnType<Api['ids']>>;

const GOOD: Record<number, Record<string, number>> = {
  20: { WL_RED: 660, WL_NIR: 850, IRR: 50 },
  30: { AGE_H: 4, IRR_DROP: 1.2 },
  40: { HIPOT: 1.1, EARTH_LK: 120, PAT_LK: 20 },
};

function report(api: Api, sn: string, seq: number, ref: Ref, kw: Record<string, unknown> = {}, user = 'op1') {
  const eq = ({ 20: ref.eq['EQ-SPEC-01'], 30: ref.eq['EQ-AGING-01'], 40: ref.eq['EQ-SAFE-01'] } as Record<number, number>)[seq] ?? null;
  const body: Record<string, unknown> = { sn, seq, values: GOOD[seq] ?? {}, equipment_id: eq };
  if (seq === 60) body.key_parts = [{ lot_no: 'HY2609A' }];
  Object.assign(body, kw);
  return api.as(user).post('/api/mes/report', body);
}

async function passFrom(api: Api, sn: string, ref: Ref, from = 10) {
  for (const seq of [10, 20, 30, 40, 50, 60].filter((s) => s >= from)) {
    const r = await report(api, sn, seq, ref);
    if (r.status !== 200 || r.body.result !== 'PASS') throw new Error(`${sn}@${seq}: ${r.status} ${JSON.stringify(r.body)}`);
  }
}

async function rlWo(api: Api, ref: Ref, qty: number) {
  const so = await api.ok('get', `/api/sales-orders/${(await api.find('/api/sales-orders', { q: 'LUM-PO-26-118' })).id}`);
  let wo = await api.as('pmc').ok('post', '/api/work-orders', { material_id: ref.m['FG-RL300'], planned_qty: qty, so_id: so.id, so_line_id: so.lines[0].id });
  wo = await api.as('pmc').ok('post', `/api/work-orders/${wo.id}/release`);
  const iss = await api.as('wh').ok('post', `/api/work-orders/${wo.id}/issues`, {});
  await api.as('wh').ok('post', `/api/issues/${iss.id}/confirm`);
  const sns: string[] = (await api.ok('get', `/api/work-orders/${wo.id}/serials`)).map((s: any) => s.sn);
  return { wo, sns };
}

/** 收货一批（其他入库，自动生成 IQC）并返回检验单详情 */
async function receive(api: Api, ref: Ref, code: string, lot: string, qty: number, loc = 'DRY-01') {
  await api.as('wh').ok('post', '/api/receipts', { receipt_type: 'OTHER', lines: [{ material_id: ref.m[code], qty, location_id: ref.loc[loc], lot_no: lot }] });
  const insp = await api.find('/api/inspections', { q: lot });
  return api.ok('get', `/api/inspections/${insp.id}`);
}

/** 全部合格的逐项结果（定量项按上下限中值录入） */
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

const stockOf = async (api: Api, lot: string) => (await api.ok('get', '/api/stock', { lot_no: lot, page_size: 200 })).items as any[];

describe('G6 质量好用性修复', () => {
  let t: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => (t = await bootApp()));
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  test('IQC：默认模板按物料规格生成定量项；逐项完成才能提交；超限自动判定；不良数须关联检验项；检验单为快照', async () => {
    const { api } = t;
    const ref = await api.ids();
    const d = await receive(api, ref, 'LED-660-3030', 'Q-660-A', 1000);
    // 物料规格 660±5nm → 定量项 655~665nm，标准不与规格冲突
    const wl = d.items.find((i: any) => i.name === '峰值波长抽测');
    expect([wl.item_type, wl.lower, wl.upper, wl.unit]).toEqual(['QUANT', 655, 665, 'nm']);
    expect(wl.standard).toContain('660±5nm');
    expect(d.items.filter((i: any) => i.item_type === 'QUAL').every((i: any) => i.checked === false)).toBe(true);

    // 未完成项不能提交
    let r = await api.as('qc').post(`/api/inspections/${d.id}/submit`, { items: [], signature: SIG });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('未填写');
    const items = allPass(d);
    r = await api.as('qc').post(`/api/inspections/${d.id}/submit`, {
      items: items.map((x: any) => (x.name === '外观' ? { ...x, checked: false } : x)), signature: SIG,
    });
    expect(r.body.detail).toBe('检验项目“外观”尚未确认，请点选“合格”或“不合格”');
    r = await api.as('qc').post(`/api/inspections/${d.id}/submit`, {
      items: items.map((x: any) => (x.name === '峰值波长抽测' ? { ...x, sample_values: [660, 661] } : x)), signature: SIG,
    });
    expect(r.body.detail).toContain('需录入至少 5 件实测值');
    // 不良数未关联检验项
    r = await api.as('qc').post(`/api/inspections/${d.id}/submit`, { items, defect_qty: 2, signature: SIG });
    expect(r.body.detail).toContain('未关联检验项目');

    // 定量项 2 件超限 → 自动判不合格；外观不良 1 件
    const bad = allPass(d, { 峰值波长抽测: { sample_values: [660, 661, 668.2, 659, 669] }, 外观: { result: 'FAIL', defect_qty: 1, value: '引脚氧化' } });
    r = await api.as('qc').post(`/api/inspections/${d.id}/submit`, { items: bad, defect_qty: 1, signature: SIG });
    expect(r.body.detail).toContain('少于检验项目“峰值波长抽测”的不良数（2）');
    const res = await api.as('qc').ok('post', `/api/inspections/${d.id}/submit`, { items: bad, defect_qty: 3, remark: '波长偏移', signature: SIG });
    expect(res.status).toBe('REJECTED');
    const wl2 = res.items.find((i: any) => i.name === '峰值波长抽测');
    expect([wl2.result, wl2.item_defects, wl2.samples]).toEqual(['FAIL', 2, [660, 661, 668.2, 659, 669]]);
    expect(res.items.find((i: any) => i.name === '外观').item_defects).toBe(1);
    const ncr = await api.find('/api/ncrs', { q: 'Q-660-A' });
    expect(ncr.description).toContain('峰值波长抽测（2 件超限）');
    expect(ncr.description).toContain('外观（1 件）');
    expect(ncr.due_on).toBe(addDays(today(), 7).toISOString().slice(0, 10));

    // 快照：修改规范后，已建检验单的项目不变
    await api.as('qa').ok('put', `/api/materials/${ref.m['LED-660-3030']}/inspection-items`, {
      items: [{ name: '峰值波长', item_type: 'QUANT', lower: 650, upper: 670, unit: 'nm', method: '积分球' }], signature: SIG,
    });
    const again = await api.ok('get', `/api/inspections/${d.id}`);
    expect(again.items.map((i: any) => i.name)).toEqual(d.items.map((i: any) => i.name));
    expect(again.ncrs.map((n: any) => n.no)).toEqual([ncr.no]);
    // 新收货按新规范（定量项从规范复制上下限）
    const d2 = await receive(api, ref, 'LED-660-3030', 'Q-660-B', 100);
    expect(d2.items.map((i: any) => [i.name, i.item_type, i.lower, i.upper, i.method])).toEqual([['峰值波长', 'QUANT', 650, 670, '积分球']]);
    // 合格
    const ok = await api.as('qc').ok('post', `/api/inspections/${d2.id}/submit`, { items: allPass(d2), signature: SIG });
    expect(ok.status).toBe('PASSED');
    expect((await stockOf(api, 'Q-660-B'))[0].status).toBe('AVAILABLE');
  });

  test('IQC：下一张待检单（先到先检）；AQL 检验水平', async () => {
    const { api } = t;
    const ref = await api.ids();
    const a = await receive(api, ref, 'HSG-RL300-U', 'NX-1', 200, 'RAW-A02');
    const b = await receive(api, ref, 'HSG-RL300-U', 'NX-2', 200, 'RAW-A02');
    let n = await api.ok('get', '/api/inspections/next', { after: a.id, type: 'IQC' });
    expect([n.next.id, n.pending]).toEqual([b.id, 2]);
    await api.as('qc').ok('post', `/api/inspections/${a.id}/submit`, { items: allPass(a), signature: SIG });
    n = await api.ok('get', '/api/inspections/next', { after: b.id });
    expect(n.next).toBeNull();
    // 列表支持 type= 与 supplier/date 筛选、排序
    const list = await api.ok('get', '/api/inspections', { status: 'PENDING', type: 'IQC', date_from: today().toISOString().slice(0, 10), sort: 'lot_no', order: 'asc' });
    expect(list.items.map((x: any) => x.lot_no)).toEqual(['NX-2']);
    // AQL：一般水平 II（默认）与特殊水平 S-3
    expect((await api.ok('get', '/api/quality/aql', { lot_qty: 1000, aql: 1.0 })).sample_size).toBe(80);
    const s3 = await api.ok('get', '/api/quality/aql', { lot_qty: 1000, aql: 1.0, level: 'S-3' });
    expect([s3.level, s3.code_letter, s3.sample_size, s3.accept_num]).toEqual(['S-3', 'E', 13, 0]);
  });

  test('NCR：处置期限/超期筛选/严重度筛选；关闭需签名；批量关闭', async () => {
    const { api, db } = t;
    const crit = await api.as('qc').ok('post', '/api/ncrs', { source: 'OTHER', severity: 'CRITICAL', description: '巡检：漏电流超标' });
    const minor = await api.as('qc').ok('post', '/api/ncrs', { source: 'OTHER', severity: 'MINOR', description: '标签歪斜' });
    expect(crit.due_on).toBe(addDays(today(), 3).toISOString().slice(0, 10));
    expect(minor.due_on).toBe(addDays(today(), 14).toISOString().slice(0, 10));
    // 未设期限的旧记录按开具日 + 严重度天数推算；致命 5 天前开具 → 超期
    await db.client.ncr.update({ where: { id: crit.id }, data: { due_date: null, created_at: addDays(new Date(), -5) } });
    let list = await api.ok('get', '/api/ncrs', { overdue: 1 });
    expect(list.items.map((x: any) => [x.no, x.overdue])).toEqual([[crit.no, true]]);
    expect((await api.ok('get', '/api/ncrs', { severity: 'MINOR,MAJOR' })).items.map((x: any) => x.no)).toEqual([minor.no]);
    expect((await api.ok('get', '/api/ncrs', { status: 'OPEN', sort: 'severity', order: 'asc' })).items.map((x: any) => x.severity)).toEqual(['CRITICAL', 'MINOR']);
    // QA 调整期限
    expect((await api.as('qa').ok('put', `/api/ncrs/${crit.id}/due-date`, { due_date: addDays(today(), 2).toISOString().slice(0, 10) })).overdue).toBe(false);

    for (const n of [crit, minor]) await api.as('qa').ok('post', `/api/ncrs/${n.id}/disposition`, { disposition: 'SCRAP', remark: '报废', signature: SIG });
    let r = await api.as('qa').post(`/api/ncrs/${crit.id}/close`, {});
    expect(r.body.detail).toContain('此操作需要电子签名（NCR关闭）');
    r = await api.as('qa').post('/api/ncrs/close-batch', { ids: [crit.id, minor.id] });
    expect(r.body.detail).toContain('电子签名');
    const out = await api.as('qa').ok('post', '/api/ncrs/close-batch', { ids: [crit.id, minor.id], signature: SIG });
    expect(out.items.map((x: any) => [x.status, x.closed_by])).toEqual([['CLOSED', '赵QA'], ['CLOSED', '赵QA']]);
    const sigs = (await api.ok('get', '/api/system/esignatures', { entity: 'qms_ncr', page_size: 50 })).items;
    expect(sigs.filter((s: any) => s.meaning === 'NCR关闭')).toHaveLength(2);
    r = await api.as('qa').post('/api/ncrs/close-batch', { ids: [crit.id], signature: SIG });
    expect(r.body.detail).toContain('已关闭');
    list = await api.ok('get', '/api/ncrs', { id: crit.id });
    expect(list.items[0].closed_at).toBeTruthy();
  });

  test('来料退货：生成退供应商单（不扣库存）→ 关闭被拦 → 仓管出库扣账 → 可关闭；取消退回重新评审', async () => {
    const { api } = t;
    const ref = await api.ids();
    for (const lot of ['RT-1', 'RT-2']) {
      const d = await receive(api, ref, 'HSG-RL300-U', lot, 200, 'RAW-A02');
      await api.as('qc').ok('post', `/api/inspections/${d.id}/submit`, {
        items: allPass(d, { 外观: { result: 'FAIL', defect_qty: 6 } }), defect_qty: 6, signature: SIG,
      });
    }
    const n1 = await api.find('/api/ncrs', { q: 'RT-1' });
    const n2 = await api.find('/api/ncrs', { q: 'RT-2' });
    await api.as('qa').ok('post', `/api/ncrs/${n1.id}/disposition`, { disposition: 'RETURN', remark: '外观不良退货', signature: SIG });
    // 库存仍为不合格（隔离），未扣账
    expect((await stockOf(api, 'RT-1')).map((s: any) => [s.status, s.qty])).toEqual([['REJECTED', 200]]);
    const sr = (await api.as('buyer').ok('get', '/api/supplier-returns', { status: 'PENDING' })).items[0];
    expect([sr.no.startsWith('SR'), sr.ncr_no, sr.qty, sr.material_code, sr.supplier_name, sr.stock_qty]).toEqual([true, n1.no, 200, 'HSG-RL300-U', '精塑模具制品有限公司', 200]);
    const ncrRow = await api.ok('get', `/api/ncrs/${n1.id}`);
    expect([ncrRow.supplier_return_no, ncrRow.close_block]).toEqual([sr.no, `退供应商单 ${sr.no} 尚未出库（仓管出库确认后才能关闭）`]);
    let r = await api.as('qa').post(`/api/ncrs/${n1.id}/close`, { signature: SIG });
    expect(r.body.detail).toContain('尚未出库');
    // 只有仓管可出库
    expect((await api.as('qa').post(`/api/supplier-returns/${sr.id}/ship`, {})).status).toBe(403);
    const shipped = await api.as('wh').ok('post', `/api/supplier-returns/${sr.id}/ship`, { carrier: '顺丰 SF123' });
    expect([shipped.status, shipped.shipped_by]).toEqual(['SHIPPED', '郑仓管']);
    expect(await stockOf(api, 'RT-1')).toEqual([]);
    const moves = (await api.ok('get', '/api/stock-moves', { lot_no: 'RT-1' })).items;
    expect(moves[0].move_type).toBe('RETURN_SUPPLIER');
    expect((await api.as('wh').post(`/api/supplier-returns/${sr.id}/ship`, {})).body.detail).toContain('已出库');
    const closed = await api.as('qa').ok('post', `/api/ncrs/${n1.id}/close`, { signature: SIG });
    expect(closed.status).toBe('CLOSED');

    // 取消：供应商拒收 → NCR 退回待处置，库存不变
    await api.as('qa').ok('post', `/api/ncrs/${n2.id}/disposition`, { disposition: 'RETURN', signature: SIG });
    const sr2 = (await api.ok('get', '/api/supplier-returns', { q: 'RT-2' })).items[0];
    r = await api.as('qa').post(`/api/supplier-returns/${sr2.id}/cancel`, { reason: '', signature: SIG });
    expect(r.body.detail).toContain('取消原因');
    const c = await api.as('qa').ok('post', `/api/supplier-returns/${sr2.id}/cancel`, { reason: '供应商拒收，改报废', signature: SIG });
    expect(c.status).toBe('CANCELLED');
    const n2b = await api.ok('get', `/api/ncrs/${n2.id}`);
    expect([n2b.status, n2b.disposition]).toEqual(['OPEN', null]);
    expect(n2b.disposition_remark).toContain('已取消');
    expect((await stockOf(api, 'RT-2')).map((s: any) => s.status)).toEqual(['REJECTED']);
  });

  test('制程返工 NCR：复测合格前不能关闭；放行结论按序列号逐项检查并汇总 NCR 签名', async () => {
    const { api } = t;
    const ref = await api.ids();
    const { wo, sns } = await rlWo(api, ref, 2);
    await passFrom(api, sns[0], ref);
    for (const seq of [10]) await report(api, sns[1], seq, ref);
    const ng = await report(api, sns[1], 20, ref, { values: { WL_RED: 690, WL_NIR: 850, IRR: 50 } });
    expect(ng.body.result).toBe('FAIL');
    const ncr = await api.find('/api/ncrs', { q: sns[1] });
    await api.as('qa').ok('post', `/api/ncrs/${ncr.id}/disposition`, { disposition: 'REWORK', remark: '清洁光学窗口后重新测试', signature: SIG });
    let row = (await api.ok('get', '/api/ncrs', { id: ncr.id })).items[0];
    expect(row.close_block).toContain(`序列号 ${sns[1]} 需重新通过工序 20`);
    let r = await api.as('qa').post(`/api/ncrs/${ncr.id}/close`, { signature: SIG });
    expect(r.body.detail).toContain('返工后尚未复测合格');

    // 放行结论：第 1 台全部通过；第 2 台工序未完成、返工未复测、NCR 已处置未关闭
    await api.as('wh').ok('post', `/api/work-orders/${wo.id}/fg-receipt`, { location_id: ref.loc['FG-01'] });
    let rc = await api.ok('get', `/api/quality/release-check/${wo.id}`);
    const u1 = rc.units.find((u: any) => u.sn === sns[0]);
    const u2 = rc.units.find((u: any) => u.sn === sns[1]);
    expect([u1.eligible, u1.ok]).toEqual([true, true]);
    expect(Object.keys(u1.checks)).toEqual(['ops', 'ncr', 'rework', 'iqc', 'equipment', 'qualification']);
    expect([u2.ok, u2.checks.ops.level, u2.checks.rework.level, u2.checks.ncr.level]).toEqual([false, 'fail', 'fail', 'warn']);
    expect(rc.summary).toMatchObject({ candidates: 1, ready: 1, blocked: 0 });
    expect(rc.ncr_signatures.map((s: any) => s.meaning)).toEqual(['不合格品评审处置：返工/返修']);

    // 复测合格后可关闭
    await passFrom(api, sns[1], ref, 20);
    row = (await api.ok('get', '/api/ncrs', { id: ncr.id })).items[0];
    expect(row.close_block).toBeNull();
    await api.as('qa').ok('post', `/api/ncrs/${ncr.id}/close`, { signature: SIG });
    rc = await api.ok('get', `/api/quality/release-check/${wo.id}`);
    expect(rc.units.find((u: any) => u.sn === sns[1]).checks.rework.level).toBe('ok');
    expect(rc.ncr_signatures.map((s: any) => s.meaning)).toEqual(['不合格品评审处置：返工/返修', 'NCR关闭']);
  });

  test('上岗资质：只列有报工权限人员、按工牌查找、登记/变更/作废需签名、人员不可修改', async () => {
    const { api } = t;
    const users = await api.as('qa').ok('get', '/api/qualifications/users');
    expect(users.every((u: any) => u.can_report)).toBe(true);
    expect(users.map((u: any) => u.username)).not.toContain('finance');
    const byBadge = await api.as('qa').ok('get', '/api/qualifications/users', { badge: 'e1002' });
    expect(byBadge.map((u: any) => [u.username, u.badge_no])).toEqual([['op2', 'E1002']]);
    const all = await api.as('qa').ok('get', '/api/qualifications/users', { all: 1 });
    const fin = all.find((u: any) => u.username === 'finance');
    expect(fin.can_report).toBe(false);

    const body = { user_id: byBadge[0].id, op_code: 'OPT', certified_at: today().toISOString().slice(0, 10), trainer: '赵QA' };
    let r = await api.as('qa').post('/api/qualifications', { ...body, user_id: fin.id, signature: SIG });
    expect(r.body.detail).toContain('没有工位报工权限');
    r = await api.as('qa').post('/api/qualifications', body);
    expect(r.body.detail).toContain('电子签名');
    const q = await api.as('qa').ok('post', '/api/qualifications', { ...body, signature: SIG });
    expect([q.username, q.badge_no, q.valid]).toEqual(['op2', 'E1002', true]);
    r = await api.as('qa').put(`/api/qualifications/${q.id}`, { user_id: users.find((u: any) => u.username === 'op1').id, signature: SIG });
    expect(r.body.detail).toContain('不能更换人员');
    r = await api.as('qa').put(`/api/qualifications/${q.id}`, { level: 'TRAINER' });
    expect(r.body.detail).toContain('电子签名');
    expect((await api.as('qa').ok('put', `/api/qualifications/${q.id}`, { level: 'TRAINER', signature: SIG })).level).toBe('TRAINER');
    const v = await api.as('qa').ok('post', `/api/qualifications/${q.id}/void`, { reason: '选错工序', signature: SIG });
    expect([v.is_active, v.valid]).toEqual([false, false]);
    expect(v.remark).toContain('作废：选错工序');
    const sigs = (await api.ok('get', '/api/system/esignatures', { entity: 'hr_qualification' })).items.map((s: any) => s.meaning);
    expect(sigs.sort()).toEqual(['上岗资质作废', '上岗资质变更', '上岗资质登记']);
  });

  test('客诉：法规字段、上报期限默认、结案规则（不良事件须完成上报评估）', async () => {
    const { api } = t;
    const c1 = await api.find('/api/customers', { q: 'C001' });
    let c = await api.as('sales').ok('post', '/api/complaints', {
      customer_id: c1.id, description: '用户反馈面板发烫，皮肤轻度红肿', is_adverse_event: true,
      reporter_contact: 'Dr. Smith / +1-555-0100', event_date: addDays(today(), -3).toISOString().slice(0, 10), country: 'US',
    });
    expect([c.reporter_contact, c.country, c.reportable, c.report_due]).toEqual(['Dr. Smith / +1-555-0100', 'US', null, addDays(today(), 30).toISOString().slice(0, 10)]);
    expect(c.report_days_left).toBe(30);
    c = await api.as('qa').ok('post', `/api/complaints/${c.id}/investigate`, { investigation: '复现：风扇转速偏低' });
    let r = await api.as('qa').post(`/api/complaints/${c.id}/close`, { signature: SIG });
    expect(r.body.detail).toContain('上报评估');
    r = await api.as('qa').post(`/api/complaints/${c.id}/close`, { reportable: true, signature: SIG });
    expect(r.body.detail).toContain('上报编号与上报日期');
    c = await api.as('qa').ok('put', `/api/complaints/${c.id}`, { reportable: true });
    expect(c.report_deadline).toBe(addDays(today(), 30).toISOString().slice(0, 10));
    c = await api.as('qa').ok('post', `/api/complaints/${c.id}/close`, {
      report_no: 'MDR-2026-0001', reported_at: today().toISOString().slice(0, 10), customer_reply: '已更换整机并寄送调查报告', signature: SIG,
    });
    expect([c.status, c.report_no, c.replied_at, c.report_days_left]).toEqual(['CLOSED', 'MDR-2026-0001', today().toISOString().slice(0, 10), null]);
    const sigs = (await api.ok('get', '/api/system/esignatures', { entity: 'qms_complaint' })).items;
    expect(sigs[0].meaning).toBe('客诉结案');
    expect((await api.ok('get', '/api/complaints', { sort: 'received_date', order: 'asc' })).total).toBe(1);
  });

  test('CAPA：默认 30 天期限、负责人清单、关联 NCR 待处置时不能关闭', async () => {
    const { api } = t;
    const ncr = await api.as('qc').ok('post', '/api/ncrs', { source: 'OTHER', description: '螺丝漏打' });
    const capa = await api.as('qa').ok('post', '/api/capas', { title: '防漏打', ncr_id: ncr.id, owner: '李工程' });
    expect(capa.due_date).toBe(addDays(today(), 30).toISOString().slice(0, 10));
    const owners = await api.ok('get', '/api/capas/owners', { q: 'engineer' });
    expect(owners.map((o: any) => o.username)).toEqual(['engineer']);
    await api.as('qa').ok('put', `/api/capas/${capa.id}`, { title: '防漏打', root_cause: '无防呆', corrective_action: '电批计数' });
    await api.as('qa').ok('post', `/api/capas/${capa.id}/status`, { status: 'VERIFYING' });
    const r = await api.as('qa').post(`/api/capas/${capa.id}/status`, { status: 'CLOSED', effectiveness: '3 批无复发', signature: SIG });
    expect(r.body.detail).toContain(`${ncr.no} 尚未评审处置`);
    await api.as('qa').ok('post', `/api/ncrs/${ncr.id}/disposition`, { disposition: 'REWORK', signature: SIG });
    expect((await api.as('qa').ok('post', `/api/capas/${capa.id}/status`, { status: 'CLOSED', effectiveness: '3 批无复发', signature: SIG })).status).toBe('CLOSED');
  });

  test('检验规范：定量项上下限、免检物料不能维护、文件编号与版本', async () => {
    const { api } = t;
    const ref = await api.ids();
    let r = await api.as('qa').put(`/api/materials/${ref.m['FG-RL300']}/inspection-items`, { items: [{ name: '外观' }], signature: SIG });
    expect(r.body.detail).toContain('不做来料检验');
    r = await api.as('qa').put(`/api/materials/${ref.m['PSU-24V-5A']}/inspection-items`, { items: [{ name: '输出电压', item_type: 'QUANT' }], signature: SIG });
    expect(r.body.detail).toContain('请填写下限或上限');
    const psu = ref.m['PSU-24V-5A'];
    let spec = await api.ok('get', `/api/materials/${psu}/inspection-items`);
    expect([spec.doc_no, spec.version, spec.exempt]).toEqual(['IQC-SPEC-PSU-24V-5A', null, false]);
    expect(spec.default_items.find((i: any) => i.name === '输出电压')).toMatchObject({ item_type: 'QUANT', lower: 22.8, upper: 25.2, unit: 'V' });
    spec = await api.as('qa').ok('put', `/api/materials/${psu}/inspection-items`, {
      items: [{ name: '输出电压', item_type: 'QUANT', lower: 23.5, upper: 24.5, unit: 'V' }, { name: '外观' }], signature: { ...SIG, reason: '首版' },
    });
    expect([spec.version, spec.items[0].item_type, spec.items[0].lower, spec.items[1].item_type]).toEqual(['A0', 'QUANT', 23.5, 'QUAL']);
    spec = await api.as('qa').ok('put', `/api/materials/${psu}/inspection-items`, {
      items: [{ ...spec.items[0], upper: 24.8 }, spec.items[1]], signature: { ...SIG, reason: '放宽上限' },
    });
    expect([spec.version, spec.items[0].upper, spec.history.map((h: any) => h.reason)]).toEqual(['A1', 24.8, ['放宽上限', '首版']]);
    expect((await api.ok('get', '/api/inspection-specs')).map((x: any) => [x.material_code, x.version])).toEqual([['PSU-24V-5A', 'A1']]);
  });

  test('召回清单：批次正向追溯的序列号含 UDI、批号、库位与客户联系人', async () => {
    const { api } = t;
    const ref = await api.ids();
    const { wo, sns } = await rlWo(api, ref, 1);
    await passFrom(api, sns[0], ref);
    await api.as('wh').ok('post', `/api/work-orders/${wo.id}/fg-receipt`, { location_id: ref.loc['FG-01'] });
    const d = await api.ok('get', '/api/trace/lot', { material_code: 'PSU-24V-5A', lot_no: 'HY2609A' });
    const s = d.serials.find((x: any) => x.sn === sns[0]);
    expect(s.udi).toContain(sns[0]);
    expect([s.lot_no, s.location_code, s.product_code]).toEqual([wo.lot_no, 'FG-01', 'FG-RL300']);
    expect(s).toHaveProperty('customer_contact');
  });
});
