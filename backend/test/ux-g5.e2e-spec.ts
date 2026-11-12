/**
 * 好用性修复 G5（工位终端 / 工程）端到端测试：
 *   C-F02 测试项编码重复（中文报错、唯一约束）；F19 OK/NG 型 / 小数位 / 合理范围（工艺校验 + 报工判定）；
 *   C-F01 录入错误拦截（合理范围、小数位）不写入 DHR；C-F04 工位判定（已过站 / 工序未到 / 不经过本工位）；
 *   C-F08 设备按适用工序校验；C-F16 判不合格需不良现象；C-F17 QA 要求换件时必须先登记；C-F15 关键件即时校验；
 *   C-F07/F13/F14 终端授权、本人刷卡恢复、上岗资质预检；F11/D#2 版本差异与提交自动变更摘要；D#18 BOM 生效日期。
 */
import { addDays, fmtDate, today } from '../src/common/dates';
import { Api, bootApp, SIG } from './harness';

type Ref = Awaited<ReturnType<Api['ids']>>;

const GOOD: Record<number, Record<string, number>> = {
  20: { WL_RED: 660, WL_NIR: 850, IRR: 50 },
  30: { AGE_H: 4, IRR_DROP: 1.2 },
  40: { HIPOT: 1.1, EARTH_LK: 120, PAT_LK: 20 },
};

/** RL-300 新工艺版本：按 mutate 修改工序后提交并批准 */
async function newRouting(api: Api, ref: Ref, mutate: (ops: any[]) => void, version = 'A2') {
  const rt = await api.find('/api/routings', { material_id: ref.m['FG-RL300'], status: 'RELEASED' });
  const nr = await api.as('engineer').ok('post', `/api/routings/${rt.id}/new-version`, { version });
  const ops = (await api.ok('get', `/api/routings/${nr.id}`)).operations;
  mutate(ops);
  await api.as('engineer').ok('put', `/api/routings/${nr.id}`, { material_id: ref.m['FG-RL300'], version, operations: ops });
  await api.as('engineer').ok('post', `/api/routings/${nr.id}/submit`, { signature: SIG, change_reason: '测试变更' });
  await api.as('qa').ok('post', `/api/routings/${nr.id}/approve`, { signature: SIG });
  return { rt, nr };
}

async function rlWo(api: Api, ref: Ref, qty: number) {
  let wo = await api.as('pmc').ok('post', '/api/work-orders', { material_id: ref.m['FG-RL300'], planned_qty: qty });
  wo = await api.as('pmc').ok('post', `/api/work-orders/${wo.id}/release`);
  const sns: string[] = (await api.ok('get', `/api/work-orders/${wo.id}/serials`)).map((s: any) => s.sn);
  return { wo, sns };
}

const report = (api: Api, ref: Ref, sn: string, seq: number, kw: Record<string, unknown> = {}) => {
  const eq = ({ 20: ref.eq['EQ-SPEC-01'], 30: ref.eq['EQ-AGING-01'], 40: ref.eq['EQ-SAFE-01'] } as Record<number, number>)[seq] ?? null;
  return api.as('op1').post('/api/mes/report', { sn, seq, values: GOOD[seq] ?? {}, equipment_id: eq, ...kw });
};

describe('好用性修复 G5：工位终端 / 工程', () => {
  let t: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => (t = await bootApp()));
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  test('C-F02 / F19：测试项编码重复中文报错；OK/NG 型、小数位、合理范围校验与升版复制', async () => {
    const { api } = t;
    const ref = await api.ids();
    const rt = await api.find('/api/routings', { material_id: ref.m['FG-RL300'], status: 'RELEASED' });
    const nr = await api.as('engineer').ok('post', `/api/routings/${rt.id}/new-version`, { version: 'A2' });
    const ops = (await api.ok('get', `/api/routings/${nr.id}`)).operations;
    const body = (o: any[]) => ({ material_id: ref.m['FG-RL300'], version: 'A2', operations: o });
    const opt = ops.find((o: any) => o.code === 'OPT');

    // 编码重复（大小写不同也算重复）
    const dup = structuredClone(ops);
    dup.find((o: any) => o.code === 'OPT').params.push({ code: 'irr', name: '辐照度（30cm）', lower: 20, upper: 40 });
    let r = await api.as('engineer').put(`/api/routings/${nr.id}`, body(dup));
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('测试项编码“irr”重复（第 3 项和第 4 项）');
    // 工序编码重复
    const dupOp = structuredClone(ops);
    dupOp[1].code = 'ASM';
    r = await api.as('engineer').put(`/api/routings/${nr.id}`, body(dupOp));
    expect(r.body.detail).toContain('工序编码“ASM”重复');
    // 合理范围：规格不在合理范围内 / 下限大于上限
    const bad = structuredClone(ops);
    Object.assign(bad.find((o: any) => o.code === 'OPT').params[0], { min_valid: 600, max_valid: 655 });
    r = await api.as('engineer').put(`/api/routings/${nr.id}`, body(bad));
    expect(r.body.detail).toContain('规格上限 670 不在合理范围（600 ~ 655）内');
    Object.assign(bad.find((o: any) => o.code === 'OPT').params[0], { min_valid: 700, max_valid: 600 });
    r = await api.as('engineer').put(`/api/routings/${nr.id}`, body(bad));
    expect(r.body.detail).toContain('合理范围下限大于上限');
    // 小数位越界（DTO 校验）
    Object.assign(bad.find((o: any) => o.code === 'OPT').params[0], { min_valid: null, max_valid: null, decimals: 9 });
    r = await api.as('engineer').put(`/api/routings/${nr.id}`, body(bad));
    expect(r.status).toBe(400);

    // 正常保存：OK/NG 型忽略上下限；工序 id 保持不变（附件挂在工序上）
    Object.assign(opt.params[0], { decimals: 1, min_valid: 600, max_valid: 700 });
    opt.params.reverse(); // 排序：按提交顺序保存
    const fqc = ops.find((o: any) => o.code === 'FQC');
    fqc.params = [{ code: 'LOOK', name: '外观', param_type: 'OKNG', lower: 1, upper: 5 }];
    const saved = await api.as('engineer').ok('put', `/api/routings/${nr.id}`, body(ops));
    const sOpt = saved.operations.find((o: any) => o.code === 'OPT');
    expect(sOpt.id).toBe(opt.id);
    expect(sOpt.params.map((p: any) => p.code)).toEqual(['IRR', 'WL_NIR', 'WL_RED']);
    expect(sOpt.params[2]).toMatchObject({ param_type: 'NUMBER', decimals: 1, min_valid: 600, max_valid: 700 });
    expect(saved.operations.find((o: any) => o.code === 'FQC').params[0]).toMatchObject({ param_type: 'OKNG', lower: null, upper: null });

    // 升版复制新字段
    await api.as('engineer').ok('post', `/api/routings/${nr.id}/submit`, { signature: SIG, change_reason: '增加合理范围' });
    await api.as('qa').ok('post', `/api/routings/${nr.id}/approve`, { signature: SIG });
    const n3 = await api.as('engineer').ok('post', `/api/routings/${nr.id}/new-version`, { version: 'A3' });
    expect(n3.operations.find((o: any) => o.code === 'OPT').params.find((p: any) => p.code === 'WL_RED')).toMatchObject({ decimals: 1, min_valid: 600, max_valid: 700 });
    expect(n3.operations.find((o: any) => o.code === 'FQC').params[0].param_type).toBe('OKNG');
  });

  test('C-F01：合理范围 / 小数位录入错误被拦截（不写 DHR、不开 NCR）；OK/NG 判定；人工判不合格需不良现象', async () => {
    const { api } = t;
    const ref = await api.ids();
    await newRouting(api, ref, (ops) => {
      const opt = ops.find((o: any) => o.code === 'OPT');
      Object.assign(opt.params.find((p: any) => p.code === 'WL_RED'), { decimals: 1, min_valid: 600, max_valid: 700 });
      ops.find((o: any) => o.code === 'FQC').params = [{ code: 'LOOK', name: '外观无划伤', param_type: 'OKNG' }];
    });
    const { sns } = await rlWo(api, ref, 4);
    for (const sn of sns) expect((await report(api, ref, sn, 10)).body.result).toBe('PASS');

    // 拼接值 660.385：小数位超限 → 录入错误；6603：超出合理范围 → 录入错误
    let r = await report(api, ref, sns[0], 20, { values: { ...GOOD[20], WL_RED: 660.385 } });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('最多 1 位小数');
    r = await report(api, ref, sns[0], 20, { values: { ...GOOD[20], WL_RED: 6603 } });
    expect(r.body.detail).toBe('录入错误：【红光峰值波长】6603nm 超出合理范围（600 ~ 700 nm），请复测后重新录入（不是不合格判定）');
    let scan = await api.as('op1').ok('get', `/api/mes/scan/${sns[0]}`);
    expect(scan.history).toHaveLength(1);
    expect((await api.ok('get', '/api/ncrs', { q: sns[0] })).items).toHaveLength(0);
    expect((await report(api, ref, sns[0], 20)).body.result).toBe('PASS');

    // 人工判不合格：没有不良现象/原因 → 拦截；点选不良代码 → 写入记录与 NCR；可只录已测的项
    r = await report(api, ref, sns[1], 20, { result: 'FAIL', values: {} });
    expect(r.body.detail).toBe('判不合格请选择不良现象或填写原因');
    r = await report(api, ref, sns[1], 20, { result: 'FAIL', defect_code: 'PACK-ACC', values: {} });
    expect(r.body.detail).toContain('不适用于工序【光学性能测试】');
    r = await report(api, ref, sns[1], 20, { result: 'FAIL', defect_code: 'OTHER', values: {} });
    expect(r.body.detail).toBe('选择“其他”时请说明不良现象');
    const fail = (await report(api, ref, sns[1], 20, { result: 'FAIL', defect_code: 'OPT-LED', remark: '左下角 2 颗', values: { WL_RED: 661 } })).body;
    expect(fail.result).toBe('FAIL');
    expect(fail.values.map((v: any) => v.code)).toEqual(['WL_RED']);
    const ncr = await api.find('/api/ncrs', { q: fail.ncr_no });
    expect(ncr.description).toContain('【灯珠不亮/闪烁】 左下角 2 颗');
    scan = await api.as('op1').ok('get', `/api/mes/scan/${sns[1]}`);
    expect(scan.history.find((h: any) => h.seq === 20).remark).toBe('【灯珠不亮/闪烁】 左下角 2 颗');

    // OK/NG 判定型：1 = OK，0 = NG；其他值拦截
    for (const seq of [30, 40]) expect((await report(api, ref, sns[0], seq)).body.result).toBe('PASS');
    scan = await api.as('op1').ok('get', `/api/mes/scan/${sns[0]}`);
    expect(scan.next_operation.params[0]).toMatchObject({ code: 'LOOK', param_type: 'OKNG' });
    expect((await report(api, ref, sns[0], 50, { values: { LOOK: 2 } })).body.detail).toBe('测试项【外观无划伤】只能判定 OK 或 NG');
    expect((await report(api, ref, sns[0], 50, { values: {} })).body.detail).toBe('请判定测试项【外观无划伤】（OK / NG）');
    const ok = (await report(api, ref, sns[0], 50, { values: { LOOK: 1 } })).body;
    expect(ok.result).toBe('PASS');
    expect(ok.values[0]).toMatchObject({ unit: 'OK/NG', value: 1, result: 'PASS' });
    // 默认不良现象列表随工序类型
    expect(scan.defect_codes.map((d: any) => d.code)).toContain('FQC-LABEL');
  });

  test('C-F04 工位判定 / C-F08 设备适用工序 / C-F15 关键件即时校验 / C-F14 资质预检', async () => {
    const { api } = t;
    const ref = await api.ids();
    const { wo, sns } = await rlWo(api, ref, 3);
    expect((await report(api, ref, sns[0], 10)).body.result).toBe('PASS');
    const op1 = api.as('op1');

    // 本工位 OPT：可作业
    let s = (await op1.ok('get', `/api/mes/scan/${sns[0]}`, { op: 'OPT' })).station;
    expect(s).toMatchObject({ ok: true, op_name: '光学性能测试' });
    // 本工位 ASM：已过站，说明谁何时测过、应送往哪道工序
    s = (await op1.ok('get', `/api/mes/scan/${sns[0]}`, { op: 'ASM' })).station;
    expect(s).toMatchObject({ ok: false, kind: 'PASSED', title: '该序列号已过本工位', send_to: { seq: 20, name: '光学性能测试' } });
    expect(s.message).toMatch(/^该序列号已于 \d\d-\d\d \d\d:\d\d 由 刘操作 在【10 整机组装】测过（合格），应送往【20 光学性能测试】工序$/);
    // 本工位 SAFE：工序未到
    s = (await op1.ok('get', `/api/mes/scan/${sns[0]}`, { op: 'SAFE' })).station;
    expect(s).toMatchObject({ ok: false, kind: 'EARLY' });
    expect(s.message).toBe('该产品尚未完成【20 光学性能测试】，应先送往【20 光学性能测试】工序');
    // 不经过的工序
    s = (await op1.ok('get', `/api/mes/scan/${sns[0]}`, { op: 'SMT' })).station;
    expect(s.kind).toBe('NOT_IN_ROUTING');
    // 不传 op：无判定
    expect((await op1.ok('get', `/api/mes/scan/${sns[0]}`)).station).toBeNull();

    // 设备适用工序：老化工序用光谱仪 → 拦截；设备台账设置适用工序后按设置判断
    let r = await report(api, ref, sns[0], 20);
    expect(r.body.result).toBe('PASS');
    r = await report(api, ref, sns[0], 30, { equipment_id: ref.eq['EQ-SPEC-01'] });
    expect(r.body.detail).toBe('设备 EQ-SPEC-01 光谱辐照度计 #1 是检测仪器，不能用于【老化测试】（老化），请选择适用于本工序的设备');
    const eqs = await op1.ok('get', '/api/mes/station/equipment', { op_type: 'AGING', op_name: '老化测试' });
    const byCode = Object.fromEntries(eqs.map((e: any) => [e.code, e.issue]));
    expect(byCode['EQ-AGING-01']).toBeNull();
    expect(byCode['EQ-SPEC-01']).toBe('是检测仪器，不能用于【老化测试】（老化）');
    expect(byCode['EQ-SPEC-02']).toMatch(/^校准已过期/);
    await api.as('engineer').ok('put', `/api/equipment/${ref.eq['EQ-SPEC-01']}`, { op_types: 'TEST_OPTICAL,AGING' });
    expect((await report(api, ref, sns[0], 30, { equipment_id: ref.eq['EQ-SPEC-01'] })).body.result).toBe('PASS');
    await api.as('engineer').ok('put', `/api/equipment/${ref.eq['EQ-AGING-01']}`, { op_types: 'TEST_SAFETY' });
    expect((await report(api, ref, sns[1], 10)).status).toBe(200);
    expect((await report(api, ref, sns[1], 20)).status).toBe(200);
    r = await report(api, ref, sns[1], 30);
    expect(r.body.detail).toContain('适用于【安规测试】工序，不能用于【老化测试】');

    // 工序清单（班组长设定本工位工序）
    const ops = await op1.ok('get', '/api/mes/station/ops');
    expect(ops.find((o: any) => o.code === 'OPT')).toMatchObject({ name: '光学性能测试', op_type: 'TEST_OPTICAL', requires_equipment: true, has_params: true });

    // 关键件即时校验（领料后只能用已领批次）
    const iss = await api.as('wh').ok('post', `/api/work-orders/${wo.id}/issues`, {});
    await api.as('wh').ok('post', `/api/issues/${iss.id}/confirm`);
    for (const seq of [40, 50]) expect((await report(api, ref, sns[0], seq)).status).toBe(200);
    let k = await op1.ok('post', '/api/mes/station/key-part-check', { sn: sns[0], lot_no: 'NOT-ISSUED' });
    expect(k.ok).toBe(false);
    expect(k.message).toContain('关键件批号 NOT-ISSUED 未领用到工单');
    k = await op1.ok('post', '/api/mes/station/key-part-check', { sn: sns[0], lot_no: 'HY2609A' });
    expect(k).toEqual({ ok: true, message: null });

    // 上岗资质预检
    expect(await op1.ok('get', '/api/mes/station/qualification', { op_code: 'OPT' })).toEqual({ ok: true, message: null });
    await t.db.client.qualification.updateMany({ where: { user: { username: 'op1' } }, data: { is_active: false } });
    const nq = await op1.ok('get', '/api/mes/station/qualification', { op_code: 'OPT' });
    expect(nq.ok).toBe(false);
    expect(nq.message).toContain('上岗资质');
  });

  test('C-F07 终端授权 / C-F13 本人刷卡恢复 / C-F17 QA 要求换件时必须先登记', async () => {
    const { api } = t;
    const ref = await api.ids();
    // 终端账号密码授权（退出工位 / 终端设置）
    expect((await api.as('pmc').ok('post', '/api/mes/station/authorize', { password: SIG.password })).full_name).toBe('周计划');
    const bad = await api.as('pmc').post('/api/mes/station/authorize', { password: 'wrong' });
    expect(bad.status).toBe(400);
    expect(bad.body.detail).toContain('密码错误');
    // 本人刷卡恢复：工牌须属于令牌对应的操作员
    expect(await api.as('op1').ok('post', '/api/mes/station/resume', { badge_no: 'E1001' })).toEqual({ ok: true });
    expect((await api.as('op1').post('/api/mes/station/resume', { badge_no: 'E1002' })).body.detail).toBe('不是锁定前的操作员，请输入 PIN 登录');
    expect((await api.as('qc').post('/api/mes/station/resume', { badge_no: 'E1001' })).status).toBe(403);

    // 返工：QA 意见要求换件 → 未登记不能重测；登记后可以
    const { sns } = await rlWo(api, ref, 2);
    await report(api, ref, sns[0], 10);
    const fail = (await report(api, ref, sns[0], 20, { values: { ...GOOD[20], IRR: 30 } })).body;
    expect(fail.result).toBe('FAIL');
    const ncr = await api.find('/api/ncrs', { q: fail.ncr_no });
    await api.as('qa').ok('post', `/api/ncrs/${ncr.id}/disposition`, { disposition: 'REWORK', remark: '更换LED灯板', signature: SIG });
    const scan = await api.as('op1').ok('get', `/api/mes/scan/${sns[0]}`, { op: 'OPT' });
    expect(scan.rework).toMatchObject({ require_parts: true, registered: 0 });
    expect(scan.rework.candidates.map((c: any) => c.code)).toContain('SA-RL300-LB');
    expect(scan.station.ok).toBe(true);
    let r = await report(api, ref, sns[0], 20);
    expect(r.body.detail).toBe(`QA 处置意见要求更换零件（“更换LED灯板”），请先在【返工换件】中登记拆下/装上的零件，再重新测试（${fail.ncr_no}）`);
    await api.as('op1').ok('post', '/api/mes/rework-parts', { sn: sns[0], removed: [{ material_id: ref.m['SA-RL300-LB'], remark: '灯珠失效' }] });
    expect((await api.as('op1').ok('get', `/api/mes/scan/${sns[0]}`)).rework.registered).toBe(1);
    r = await report(api, ref, sns[0], 20);
    expect(r.body.result).toBe('PASS');

    // QA 意见不要求换件：直接重测
    await report(api, ref, sns[1], 10);
    const f2 = (await report(api, ref, sns[1], 20, { values: { ...GOOD[20], IRR: 30 } })).body;
    const n2 = await api.find('/api/ncrs', { q: f2.ncr_no });
    await api.as('qa').ok('post', `/api/ncrs/${n2.id}/disposition`, { disposition: 'REWORK', remark: '重新校准探头后复测', signature: SIG });
    expect((await api.as('op1').ok('get', `/api/mes/scan/${sns[1]}`)).rework.require_parts).toBe(false);
    expect((await report(api, ref, sns[1], 20)).body.result).toBe('PASS');
  });

  test('F11 / D#2：版本差异（含未保存草稿）与提交自动变更摘要', async () => {
    const { api } = t;
    const ref = await api.ids();
    const rt = await api.find('/api/routings', { material_id: ref.m['FG-RL300'], status: 'RELEASED' });
    const nr = await api.as('engineer').ok('post', `/api/routings/${rt.id}/new-version`, { version: 'A2' });
    expect((await api.ok('get', `/api/routings/${nr.id}/diff`)).items).toEqual([]);
    const ops = (await api.ok('get', `/api/routings/${nr.id}`)).operations;
    const age = ops.find((o: any) => o.code === 'AGE');
    age.params[0].lower = 300; // 老化时长 4 → 300（D#2 场景）
    age.params.splice(1, 1); // 删除“老化后辐照度衰减”
    ops.find((o: any) => o.code === 'OPT').params.push({ code: 'UNI', name: '均匀度', unit: '%', lower: 80 });
    // 未保存的草稿也能对比
    const live = await api.ok('post', `/api/routings/${nr.id}/diff`, { operations: ops });
    expect(live.base).toMatchObject({ id: rt.id, version: 'A1', status: 'RELEASED' });
    expect(live.items.map((i: any) => [i.kind, i.key, i.field ?? null, i.limit ?? false])).toEqual([
      ['added', 'param:OPT/UNI', null, true],
      ['changed', 'param:AGE/AGE_H', 'lower', true],
      ['removed', 'param:AGE/IRR_DROP', null, true],
    ]);
    expect(live.summary).toBe('光学性能测试：新增测试项 UNI 均匀度（≥80 %）；老化测试：老化时长 下限 4 → 300；老化测试：删除测试项 IRR_DROP 老化后辐照度衰减（原规格 ≤5 %）');
    await api.as('engineer').ok('put', `/api/routings/${nr.id}`, { material_id: ref.m['FG-RL300'], version: 'A2', operations: ops });
    expect((await api.ok('get', `/api/routings/${nr.id}/diff`)).summary).toBe(live.summary);
    // 保存草稿不要求变更原因；提交时才要求
    expect((await api.as('engineer').post(`/api/routings/${nr.id}/submit`, { signature: SIG })).body.detail).toContain('变更原因');
    await api.as('engineer').ok('post', `/api/routings/${nr.id}/submit`, { signature: { password: SIG.password }, change_reason: '老化时长延长' });
    const sigs = await api.ok('get', `/api/routings/${nr.id}/signatures`);
    expect(sigs[0].meaning).toBe('工艺路线编制提交');
    expect(sigs[0].reason).toBe(`变更摘要（系统生成）：${live.summary}`.slice(0, 256));
    // 工艺批准后查看历史版本差异（与上一版本对比）
    await api.as('qa').ok('post', `/api/routings/${nr.id}/approve`, { signature: SIG });
    expect((await api.ok('get', `/api/routings/${nr.id}/diff`)).base.version).toBe('A1');

    // BOM：删除行 / 用量修改 / 新增
    const bom = await api.find('/api/boms', { material_id: ref.m['FG-RL300'], status: 'RELEASED' });
    const nb = await api.as('engineer').ok('post', `/api/boms/${bom.id}/new-version`, { version: 'A2', ecn_no: 'ECN-1' });
    const lines = nb.lines.map((l: any) => ({ component_id: l.component_id, qty_per: l.qty_per, scrap_rate: l.scrap_rate, designator: l.designator }));
    const removed = lines.pop();
    lines[0].qty_per = 2;
    const d = await api.ok('post', `/api/boms/${nb.id}/diff`, { lines });
    expect(d.items.map((i: any) => [i.kind, i.field ?? null])).toEqual([['changed', 'qty_per'], ['removed', null]]);
    expect(d.items[1].key).toBe(`line:${removed.component_id}`);
    // 重复组件：中文提示指明行号
    const r = await api.as('engineer').put(`/api/boms/${nb.id}`, { material_id: ref.m['FG-RL300'], version: 'A2', lines: [...lines, { ...lines[1] }] });
    expect(r.body.detail).toBe(`同一组件在 BOM 中重复出现（第 2 行和第 ${lines.length + 1} 行），请合并为一行`);
  });

  test('D#18：BOM 生效日期在未来 → 已批准待生效，旧版本继续用于新工单；到期自动切换', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const bom = await api.find('/api/boms', { material_id: ref.m['FG-RL300'], status: 'RELEASED' });
    const nb = await api.as('engineer').ok('post', `/api/boms/${bom.id}/new-version`, { version: 'A2', ecn_no: 'ECN-9' });
    const eff = fmtDate(addDays(today(), 8));
    const lines = nb.lines.map((l: any, i: number) => ({ component_id: l.component_id, qty_per: i === 0 ? l.qty_per * 2 : l.qty_per }));
    await api.as('engineer').ok('put', `/api/boms/${nb.id}`, { material_id: ref.m['FG-RL300'], version: 'A2', effective_date: eff, lines });
    await api.as('engineer').ok('post', `/api/boms/${nb.id}/submit`, { signature: SIG, change_reason: '用量调整' });
    const ap = await api.as('qa').ok('post', `/api/boms/${nb.id}/approve`, { signature: SIG });
    expect([ap.status, ap.effective_date]).toEqual(['APPROVED', eff]);
    expect((await api.ok('get', `/api/boms/${bom.id}`)).status).toBe('RELEASED');
    expect((await api.as('engineer').put(`/api/boms/${nb.id}`, { material_id: ref.m['FG-RL300'], version: 'A2', lines })).body.detail).toContain('等待生效日');
    // 生效前：新工单使用旧版本
    let { wo } = await rlWo(api, ref, 1);
    expect(wo.bom_id).toBe(bom.id);
    // 到生效日（模拟）：下达工单时自动切换，旧版本作废
    await db.client.bom.update({ where: { id: nb.id }, data: { effective_date: today() } });
    ({ wo } = await rlWo(api, ref, 1));
    expect(wo.bom_id).toBe(nb.id);
    expect((await api.ok('get', `/api/boms/${bom.id}`)).status).toBe('OBSOLETE');
    expect((await api.ok('get', `/api/boms/${nb.id}`)).status).toBe('RELEASED');

    // 生效日期为今天：批准即生效（原有行为）
    const n3 = await api.as('engineer').ok('post', `/api/boms/${nb.id}/new-version`, { version: 'A3', ecn_no: 'ECN-10' });
    await api.as('engineer').ok('post', `/api/boms/${n3.id}/submit`, { signature: SIG, change_reason: '同版本内容' });
    expect((await api.as('qa').ok('post', `/api/boms/${n3.id}/approve`, { signature: SIG })).status).toBe('RELEASED');
    expect((await api.ok('get', `/api/boms/${nb.id}`)).status).toBe('OBSOLETE');
  });
});
