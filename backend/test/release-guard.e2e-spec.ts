/**
 * 第二轮复核 D-R3-2：分批放行 / 整单放行按 DHR 放行结论（逐台检查）把关——
 *   结论卡判为“不可放行”（如操作员资质被作废）的产品不能批准放行，只能拒绝（冻结）；可放行清单逐台给出检查结果。
 */
import { Api, bootApp, SIG } from './harness';

type Ref = Awaited<ReturnType<Api['ids']>>;

const GOOD: Record<number, Record<string, number>> = {
  20: { WL_RED: 660, WL_NIR: 850, IRR: 50 },
  30: { AGE_H: 4, IRR_DROP: 1.2 },
  40: { HIPOT: 1.1, EARTH_LK: 120, PAT_LK: 20 },
};

async function passAll(api: Api, sn: string, ref: Ref) {
  for (const seq of [10, 20, 30, 40, 50, 60]) {
    const eq = ({ 20: ref.eq['EQ-SPEC-01'], 30: ref.eq['EQ-AGING-01'], 40: ref.eq['EQ-SAFE-01'] } as Record<number, number>)[seq] ?? null;
    const body: Record<string, unknown> = { sn, seq, values: GOOD[seq] ?? {}, equipment_id: eq };
    if (seq === 60) body.key_parts = [{ lot_no: 'HY2609A' }];
    const r = await api.as('op1').post('/api/mes/report', body);
    if (r.status !== 200 || r.body.result !== 'PASS') throw new Error(`${sn}@${seq}: ${r.status} ${JSON.stringify(r.body)}`);
  }
}

describe('放行把关：放行结论不通过的产品不能批准放行', () => {
  const t = {} as Awaited<ReturnType<typeof bootApp>>;
  beforeAll(async () => Object.assign(t, await bootApp()));
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  test('操作员资质作废后：可放行清单标“不通过”，分批/整单批准被拒，拒绝（冻结）仍可；恢复资质后可放行', async () => {
    const { api } = t;
    const ref = await api.ids();
    const pmc = api.as('pmc');
    const so = await pmc.ok('get', `/api/sales-orders/${(await pmc.find('/api/sales-orders', { q: 'LUM-PO-26-118' })).id}`);
    let wo = await pmc.ok('post', '/api/work-orders', { material_id: ref.m['FG-RL300'], planned_qty: 3, so_id: so.id, so_line_id: so.lines[0].id });
    wo = await pmc.ok('post', `/api/work-orders/${wo.id}/release`);
    const iss = await api.as('wh').ok('post', `/api/work-orders/${wo.id}/issues`, {});
    await api.as('wh').ok('post', `/api/issues/${iss.id}/confirm`);
    const sns: string[] = (await pmc.ok('get', `/api/work-orders/${wo.id}/serials`)).map((s: any) => s.sn);
    for (const sn of sns) await passAll(api, sn, ref);
    await api.as('wh').ok('post', `/api/work-orders/${wo.id}/fg-receipt`, { location_id: ref.loc['FG-01'] });

    // 作废 op1 的上岗资质（往回追溯：其报工记录变为“无有效资质”）
    const quals = (await api.as('qa').ok('get', '/api/qualifications', { page_size: 100 })).items.filter((q: any) => q.username === 'op1' && q.is_active);
    expect(quals.length).toBeGreaterThan(0);
    for (const q of quals) await api.as('qa').ok('put', `/api/qualifications/${q.id}`, { level: q.level, is_active: false, signature: SIG });

    const sum = await api.as('qa').ok('get', `/api/work-orders/${wo.id}/releasable`);
    expect(sum.serials.map((s: any) => s.check_ok)).toEqual([false, false, false]);
    expect(sum.serials[0].check_issues.join('；')).toContain('人员资质');

    const url = `/api/work-orders/${wo.id}/releases`;
    let r = await api.as('qa').post(url, { serials: [sns[0]], signature: SIG });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('放行检查未通过，不能批准放行');
    expect(r.body.detail).toContain(sns[0]);
    r = await api.as('qa').post(url, { signature: SIG }); // 不指定序列号 = 全部可放行
    expect(r.body.detail).toContain('3 台放行检查未通过');
    r = await api.as('qa').post(`/api/work-orders/${wo.id}/dhr/release`, { approve: true, signature: SIG });
    expect(r.status).toBe(400);
    expect(r.body.detail).toMatch(/放行检查未通过|DHR 审核未通过/);

    // 拒绝（冻结）不受放行结论限制
    const rej = await api.as('qa').ok('post', url, { serials: [sns[2]], approve: false, reason: '操作员资质作废，冻结待评估', signature: SIG });
    expect(rej.release.status).toBe('REJECTED');

    // 恢复资质后可以放行
    for (const q of quals) await api.as('qa').ok('put', `/api/qualifications/${q.id}`, { level: q.level, is_active: true, signature: SIG });
    const ok = await api.as('qa').ok('post', url, { serials: [sns[0]], signature: SIG });
    expect(ok.release.status).toBe('RELEASED');
    expect((await api.as('qa').ok('get', `/api/work-orders/${wo.id}/releasable`)).serials.map((s: any) => [s.sn, s.check_ok])).toEqual([[sns[1], true]]);
  });
});
