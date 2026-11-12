/**
 * 第二轮修复 R4（工位 / 工程）端到端测试：
 *   C-N3 班组长刷工牌 + PIN 授权（须 mes_lead，失败计入锁定、返回 400 不影响终端会话）；
 *   C-N4 返工换件按 Ncr.require_part_change 判断、候选展开到下级组件并按 QA 意见预选；
 *   N7 关键件框扫到产品序列号的提示；N8 / N10 差异包含测试项顺序与附件、变更摘要按工序归并。
 */
import { Api, bootApp, SIG } from './harness';

type Ref = Awaited<ReturnType<Api['ids']>>;

const GOOD: Record<number, Record<string, number>> = {
  20: { WL_RED: 660, WL_NIR: 850, IRR: 50 },
  30: { AGE_H: 4, IRR_DROP: 1.2 },
  40: { HIPOT: 1.1, EARTH_LK: 120, PAT_LK: 20 },
};

const report = (api: Api, ref: Ref, sn: string, seq: number, kw: Record<string, unknown> = {}) => {
  const eq = ({ 20: ref.eq['EQ-SPEC-01'], 30: ref.eq['EQ-AGING-01'], 40: ref.eq['EQ-SAFE-01'] } as Record<number, number>)[seq] ?? null;
  return api.as('op1').post('/api/mes/report', { sn, seq, values: GOOD[seq] ?? {}, equipment_id: eq, ...kw });
};

async function rlWo(api: Api, ref: Ref, qty: number, issue = false) {
  let wo = await api.as('pmc').ok('post', '/api/work-orders', { material_id: ref.m['FG-RL300'], planned_qty: qty });
  wo = await api.as('pmc').ok('post', `/api/work-orders/${wo.id}/release`);
  if (issue) {
    const iss = await api.as('wh').ok('post', `/api/work-orders/${wo.id}/issues`, {});
    await api.as('wh').ok('post', `/api/issues/${iss.id}/confirm`);
  }
  const sns: string[] = (await api.ok('get', `/api/work-orders/${wo.id}/serials`)).map((s: any) => s.sn);
  return { wo, sns };
}

describe('第二轮修复 R4：工位 / 工程', () => {
  let t: Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => (t = await bootApp()));
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  test('C-N3：班组长刷工牌 + PIN 授权（须 mes_lead）；失败 400 并计入锁定计数', async () => {
    const { api, db } = t;
    // 工位终端设备账号调用
    const ok = await api.as('station1').ok('post', '/api/mes/station/authorize', { badge_no: 'E3001', pin: '1357' });
    expect(ok).toEqual({ ok: true, user: { username: 'leader', full_name: '赵班长' } });
    // 操作员不是班组长
    let r = await api.as('station1').post('/api/mes/station/authorize', { badge_no: 'E1001', pin: '1234' });
    expect(r.status).toBe(400);
    expect(r.body.detail).toBe('刘操作 不是班组长（没有“工位终端设定/退出授权”权限），请由本线班组长刷工牌授权');
    // PIN 错：400（不是 401，终端会话不受影响），计入失败次数
    r = await api.as('station1').post('/api/mes/station/authorize', { badge_no: 'E3001', pin: '0000' });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('班组长授权失败');
    expect((await db.client.user.findUnique({ where: { username: 'leader' } }))!.failed_login_count).toBe(1);
    // 旧的“终端账号密码”方式不再有效
    expect((await api.as('station1').post('/api/mes/station/authorize', { password: SIG.password })).status).toBe(400);
    // 授权后终端账号仍可正常使用
    expect((await api.as('station1').get('/api/mes/station/ops')).status).toBe(200);
  });

  test('C-N4：按 require_part_change 判断必须换件；候选展开下级组件并按 QA 意见预选；N7 关键件扫到序列号', async () => {
    const { api } = t;
    const ref = await api.ids();
    const { sns } = await rlWo(api, ref, 3, true);
    for (const sn of sns) expect((await report(api, ref, sn, 10)).body.result).toBe('PASS');

    // 意见写了“更换”但没勾选“需更换零件”：不强制
    const f1 = (await report(api, ref, sns[0], 20, { values: { ...GOOD[20], IRR: 30 } })).body;
    const n1 = await api.find('/api/ncrs', { q: f1.ncr_no });
    await api.as('qa').ok('post', `/api/ncrs/${n1.id}/disposition`, { disposition: 'REWORK', remark: '更换驱动IC（U3）', signature: SIG });
    let scan = await api.as('op1').ok('get', `/api/mes/scan/${sns[0]}`, { op: 'OPT' });
    expect(scan.rework.require_parts).toBe(false);
    // 候选：灯板组件展开到下级零件（驱动 IC，带位号），QA 意见提到的预选并排在最前
    const c0 = scan.rework.candidates[0];
    expect(c0).toMatchObject({ code: 'IC-DRV-CC', source: 'SUB', parent_code: 'SA-RL300-LB', suggested: true });
    expect(c0.designator).toBeTruthy();
    expect(scan.rework.candidates.filter((c: any) => c.suggested)).toHaveLength(1);
    expect(scan.rework.candidates.some((c: any) => c.code === 'SA-RL300-LB' && c.source === 'BOM')).toBe(true);
    expect((await report(api, ref, sns[0], 20)).body.result).toBe('PASS');

    // 勾选“需更换零件”：未登记不能重测；登记（含原批号、位号）后可以
    const f2 = (await report(api, ref, sns[1], 20, { values: { ...GOOD[20], IRR: 30 } })).body;
    const n2 = await api.find('/api/ncrs', { q: f2.ncr_no });
    await api.as('qa').ok('post', `/api/ncrs/${n2.id}/disposition`, { disposition: 'REWORK', remark: '按 QA 意见返修', require_part_change: true, signature: SIG });
    scan = await api.as('op1').ok('get', `/api/mes/scan/${sns[1]}`, { op: 'OPT' });
    expect(scan.rework.require_parts).toBe(true);
    expect(scan.rework.candidates.some((c: any) => c.suggested)).toBe(false);
    const r = await report(api, ref, sns[1], 20);
    expect(r.body.detail).toContain('请先在【返工换件】中登记拆下/装上的零件');
    await api.as('op1').ok('post', '/api/mes/rework-parts', { sn: sns[1], removed: [{ material_id: ref.m['IC-DRV-CC'], lot_no: 'XD260830', part_sn: 'U3' }] });
    const kp = (await api.as('op1').ok('get', `/api/mes/scan/${sns[1]}`)).key_parts.find((k: any) => k.action === 'REMOVE');
    expect([kp.material_code, kp.lot_no, kp.part_sn]).toEqual(['IC-DRV-CC', 'XD260830', 'U3']);
    expect((await report(api, ref, sns[1], 20)).body.result).toBe('PASS');

    // N7：关键件框扫到的是产品序列号
    for (const seq of [20, 30, 40, 50]) expect((await report(api, ref, sns[2], seq)).status).toBe(200);
    const k = await api.as('op1').ok('post', '/api/mes/station/key-part-check', { sn: sns[2], lot_no: sns[0] });
    expect(k.ok).toBe(false);
    expect(k.message).toBe(`扫到的是产品序列号 ${sns[0]}，不是关键件【PSU-24V-5A 医用电源适配器 24V/5A】的批号，请扫关键件上的批号标签`);
  });

  test('N8 / N10：差异包含测试项顺序与附件增删；变更摘要按工序归并、作业指导只写行数', async () => {
    const { api } = t;
    const ref = await api.ids();
    const rt = await api.find('/api/routings', { material_id: ref.m['FG-RL300'], status: 'RELEASED' });
    const nr = await api.as('engineer').ok('post', `/api/routings/${rt.id}/new-version`, { version: 'A2' });
    const ops = (await api.ok('get', `/api/routings/${nr.id}`)).operations;
    const opt = ops.find((o: any) => o.code === 'OPT');
    opt.params.reverse();
    opt.params.find((p: any) => p.code === 'WL_RED').decimals = 1;
    opt.params.find((p: any) => p.code === 'WL_RED').max_valid = 700;
    ops.find((o: any) => o.code === 'AGE').std_minutes = 300;
    ops.find((o: any) => o.code === 'FQC').instructions = '1. 外观\n2. 铭牌\n3. UDI';
    await api.as('engineer').ok('put', `/api/routings/${nr.id}`, { material_id: ref.m['FG-RL300'], version: 'A2', name: rt.name, operations: ops });
    // 作业指导附件（挂在草稿版本的工序上）
    await t.db.client.attachment.create({
      data: { entity: 'eng_routing_op', entity_id: opt.id, filename: 'SOP-OPT.pdf', content_type: 'application/pdf', size: 10, sha256: 'a'.repeat(64), storage_key: 'test/sop-opt', uploaded_by: 'engineer' },
    });
    const d = await api.ok('get', `/api/routings/${nr.id}/diff`);
    const kinds = d.items.map((i: any) => [i.kind, i.field ?? null]);
    expect(kinds).toEqual(expect.arrayContaining([['changed', 'param_order'], ['added', 'attachment'], ['changed', 'std_minutes'], ['changed', 'instructions']]));
    expect(d.summary).toBe(
      '【光学性能测试】红光峰值波长 小数位 空→1、合理范围上限 空→700；测试项顺序 WL_RED→WL_NIR→IRR 改为 IRR→WL_NIR→WL_RED；新增附件 SOP-OPT.pdf。'
      + '【老化测试】标准工时(分) 5 → 300。【终检（外观/功能/标签）】作业指导已修改（+3 行）',
    );
    // 未保存草稿对比（附件按工序编码取已上传的）
    const live = await api.ok('post', `/api/routings/${nr.id}/diff`, { operations: ops });
    expect(live.summary).toBe(d.summary);
    // 附件随版本提交审批：编制签名理由带上附件变化
    await api.as('engineer').ok('post', `/api/routings/${nr.id}/submit`, { signature: { password: SIG.password }, change_reason: '光学顺序调整' });
    const sigs = await api.ok('get', `/api/routings/${nr.id}/signatures`);
    expect(sigs[0].reason).toContain('新增附件 SOP-OPT.pdf');
  });
});
