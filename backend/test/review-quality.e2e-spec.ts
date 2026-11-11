/**
 * 评审改进（代理 4）：物料检验规范用于 IQC、生产退料数量控制、客户退货（冻结入库 + NCR + 序列号 RETURNED）、
 * 客诉关闭电子签名、附件上传/列表/下载（内容寻址 + sha256 校验）。
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { DEMO_PASSWORD } from '../src/seed/seed-base';
import { bootApp, SIG, type Api } from './harness';

type T = Awaited<ReturnType<typeof bootApp>>;

const stockOf = async (api: Api, q: Record<string, unknown>) => (await api.ok('get', '/api/stock', { page_size: 200, ...q })).items;
const sum = (rows: any[]) => rows.reduce((s, r) => s + r.qty, 0);

/** 下达一张 2 台的 RL-300 工单并按 FEFO 领料过账 */
async function issuedWorkOrder(api: Api, ref: Awaited<ReturnType<Api['ids']>>) {
  let wo = await api.as('pmc').ok('post', '/api/work-orders', { material_id: ref.m['FG-RL300'], planned_qty: 2 });
  wo = await api.as('pmc').ok('post', `/api/work-orders/${wo.id}/release`);
  const issue = await api.as('wh').ok('post', `/api/work-orders/${wo.id}/issues`, {});
  await api.as('wh').ok('post', `/api/issues/${issue.id}/confirm`);
  return { wo: await api.ok('get', `/api/work-orders/${wo.id}`), issue };
}

describe('评审改进：检验规范、退料、客户退货、客诉、附件', () => {
  let t: T;
  let attDir: string;
  beforeAll(async () => {
    attDir = mkdtempSync(join(tmpdir(), 'nuon-att-'));
    process.env.ATTACHMENT_DIR = attDir;
    t = await bootApp();
  });
  beforeEach(() => t.reset());
  afterAll(async () => {
    await t.close();
    rmSync(attDir, { recursive: true, force: true });
  });

  test('物料检验规范：维护（电子签名）→ IQC 按规范生成检验项目；清空后恢复默认模板', async () => {
    const { api } = t;
    const ref = await api.ids();
    const mat = ref.m['HSG-RL300-U'];
    // 未维护：使用默认模板
    let spec = await api.ok('get', `/api/materials/${mat}/inspection-items`);
    expect(spec.using_default).toBe(true);
    expect(spec.items).toEqual([]);
    expect(spec.default_items.map((i: any) => i.name)).toContain('外观');

    const items = [
      { seq: 20, name: '尺寸', standard: '按图纸 DWG-RL300-U A版', method: '卡尺，抽 5 件' },
      { seq: 10, name: '外观', standard: '无缩水、无毛刺、颜色与色板一致', method: '目视，D65 光源' },
      { seq: 30, name: '阻燃等级', standard: 'UL94 V0 证书有效', method: '核对供应商 COA' },
    ];
    // 质检员无权维护；未签名被拒
    expect((await api.as('qc').put(`/api/materials/${mat}/inspection-items`, { items, signature: SIG })).status).toBe(403);
    let r = await api.as('qa').put(`/api/materials/${mat}/inspection-items`, { items });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('电子签名');
    r = await api.as('qa').put(`/api/materials/${mat}/inspection-items`, { items: [...items, { name: '外观' }], signature: SIG });
    expect(r.body.detail).toContain('重复');
    spec = await api.as('engineer').ok('put', `/api/materials/${mat}/inspection-items`, { items, signature: SIG });
    expect(spec.using_default).toBe(false);
    expect(spec.items.map((i: any) => i.name)).toEqual(['外观', '尺寸', '阻燃等级']);
    expect(spec.items[0].method).toBe('目视，D65 光源');
    const sigs = (await api.ok('get', '/api/system/esignatures', { entity: 'md_material' })).items;
    expect(sigs[0].meaning).toBe('检验规范批准');
    expect((await api.ok('get', '/api/inspection-specs')).map((x: any) => x.material_code)).toEqual(['HSG-RL300-U']);

    // 收货 → IQC 检验项目按规范（序号顺序）
    await api.as('wh').ok('post', '/api/receipts', { receipt_type: 'OTHER', lines: [{ material_id: mat, qty: 100, location_id: ref.loc['RAW-A02'], lot_no: 'SPEC-1' }] });
    const insp = await api.find('/api/inspections', { q: 'SPEC-1' });
    const detail = await api.ok('get', `/api/inspections/${insp.id}`);
    expect(detail.items.map((i: any) => [i.name, i.standard])).toEqual([
      ['外观', '无缩水、无毛刺、颜色与色板一致'], ['尺寸', '按图纸 DWG-RL300-U A版'], ['阻燃等级', 'UL94 V0 证书有效'],
    ]);

    // 修改：去掉一项（停用保留历史）、改一项
    const keep = spec.items.filter((i: any) => i.name !== '阻燃等级').map((i: any) => ({ ...i, standard: i.name === '尺寸' ? '按图纸 B版' : i.standard }));
    spec = await api.as('qa').ok('put', `/api/materials/${mat}/inspection-items`, { items: keep, signature: SIG });
    expect(spec.items.map((i: any) => [i.name, i.standard])).toEqual([['外观', '无缩水、无毛刺、颜色与色板一致'], ['尺寸', '按图纸 B版']]);
    const all = await t.db.base.materialInspectionItem.findMany({ where: { material_id: mat }, orderBy: { id: 'asc' } });
    expect(all.filter((i) => !i.is_active).map((i) => i.name)).toEqual(['阻燃等级']);
    // 已建检验单不受规范变更影响
    expect((await api.ok('get', `/api/inspections/${insp.id}`)).items).toHaveLength(3);

    // 清空 → 恢复默认模板
    spec = await api.as('qa').ok('put', `/api/materials/${mat}/inspection-items`, { items: [], signature: SIG });
    expect(spec.using_default).toBe(true);
    await api.as('wh').ok('post', '/api/receipts', { receipt_type: 'OTHER', lines: [{ material_id: mat, qty: 50, location_id: ref.loc['RAW-A02'], lot_no: 'SPEC-2' }] });
    const insp2 = await api.find('/api/inspections', { q: 'SPEC-2' });
    expect((await api.ok('get', `/api/inspections/${insp2.id}`)).items.map((i: any) => i.name)).toEqual(spec.default_items.map((i: any) => i.name));
  });

  test('生产退料：只能退本工单已领批次，数量不超过已领 − 已退 − 未过账退料；过账加回合格库存、扣减已领数量', async () => {
    const { api } = t;
    const ref = await api.ids();
    const { wo } = await issuedWorkOrder(api, ref);
    const screw = wo.materials.find((m: any) => m.material_code === 'SCREW-M3X8');
    const box = wo.materials.find((m: any) => m.material_code === 'PKG-RL300-BOX');
    expect(screw.issued_qty).toBe(25);

    const lots = await api.ok('get', `/api/work-orders/${wo.id}/returnable`);
    const sl = lots.find((l: any) => l.material_code === 'SCREW-M3X8');
    expect([sl.lot_no, sl.issued_qty, sl.returnable_qty]).toEqual(['JS2609S', 25, 25]);
    const before = sum(await stockOf(api, { lot_no: 'JS2609S', status: 'AVAILABLE' }));

    const line = { material_id: ref.m['SCREW-M3X8'], lot_no: 'JS2609S', location_id: ref.loc['RAW-A02'] };
    // 超过已领数量
    let r = await api.as('wh').post(`/api/work-orders/${wo.id}/returns`, { lines: [{ ...line, qty: 26 }] });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain('超过可退数量');
    // 未领用的批次 / 非本工单物料 / 不合格品区 / 无权限
    r = await api.as('wh').post(`/api/work-orders/${wo.id}/returns`, { lines: [{ ...line, lot_no: 'NOPE', qty: 1 }] });
    expect(r.body.detail).toContain('未领用到本工单');
    r = await api.as('wh').post(`/api/work-orders/${wo.id}/returns`, { lines: [{ ...line, material_id: ref.m['LED-660-3030'], qty: 1 }] });
    expect(r.body.detail).toContain('非本工单物料');
    r = await api.as('wh').post(`/api/work-orders/${wo.id}/returns`, { lines: [{ ...line, location_id: ref.loc['REJ-01'], qty: 1 }] });
    expect(r.body.detail).toContain('不合格品区');
    expect((await api.as('op1').post(`/api/work-orders/${wo.id}/returns`, { lines: [{ ...line, qty: 1 }] })).status).toBe(403);

    // 客供料退回货主名下（货主自动按领料记录确定）
    const rt = await api.as('wh').ok('post', `/api/work-orders/${wo.id}/returns`, {
      lines: [{ ...line, qty: 10 }, { material_id: box.material_id, lot_no: 'LUM-BOX-2609', location_id: ref.loc['CS-01'], qty: 1 }],
      remark: '多领退回',
    });
    expect([rt.issue_type, rt.status, rt.no.startsWith('TL')]).toEqual(['RETURN', 'DRAFT', true]);
    expect(rt.lines.find((l: any) => l.material_code === 'PKG-RL300-BOX').owner_customer_id).toBe(wo.customer_id);
    // 未过账的退料单也占用可退数量
    r = await api.as('wh').post(`/api/work-orders/${wo.id}/returns`, { lines: [{ ...line, qty: 16 }] });
    expect(r.body.detail).toContain('最多还可退 15');

    // 过账：库存加回合格，工单已领数量扣减，流水 WO_RETURN
    const done = await api.as('wh').ok('post', `/api/issues/${rt.id}/confirm`);
    expect([done.status, done.issue_type]).toEqual(['CONFIRMED', 'RETURN']);
    expect(sum(await stockOf(api, { lot_no: 'JS2609S', status: 'AVAILABLE' }))).toBe(before + 10);
    const cs = (await stockOf(api, { lot_no: 'LUM-BOX-2609' }))[0];
    expect(cs.owner_customer_id).toBe(wo.customer_id);
    const wo2 = await api.ok('get', `/api/work-orders/${wo.id}`);
    expect(wo2.materials.find((m: any) => m.material_code === 'SCREW-M3X8').issued_qty).toBe(15);
    const moves = (await api.ok('get', '/api/stock-moves', { ref_no: rt.no })).items;
    expect(new Set(moves.map((m: any) => m.move_type))).toEqual(new Set(['WO_RETURN']));
    // 重复过账被拒；可退数量更新
    expect((await api.as('wh').post(`/api/issues/${rt.id}/confirm`)).body.detail).toBe('退料单已过账或已取消');
    const lots2 = await api.ok('get', `/api/work-orders/${wo.id}/returnable`);
    expect(lots2.find((l: any) => l.material_code === 'SCREW-M3X8')).toMatchObject({ issued_qty: 25, returned_qty: 10, returnable_qty: 15 });

    // 退料单与领料单在同一列表，按类型区分；未过账退料单不影响 FEFO 领料需求
    const list = (await api.ok('get', '/api/issues', { wo_id: wo.id })).items;
    expect(list.map((i: any) => i.issue_type).sort()).toEqual(['ISSUE', 'RETURN']);

    // 全部退回后工单可以取消（“工单已领料，请先退料”）
    const rest = (await api.ok('get', `/api/work-orders/${wo.id}/returnable`)).filter((l: any) => l.returnable_qty > 0);
    const all = await api.as('wh').ok('post', `/api/work-orders/${wo.id}/returns`, {
      lines: rest.map((l: any) => ({ material_id: l.material_id, lot_no: l.lot_no, location_id: l.location_id, qty: l.returnable_qty, owner_customer_id: l.owner_customer_id })),
    });
    await api.as('wh').ok('post', `/api/issues/${all.id}/confirm`);
    const wo3 = await api.ok('get', `/api/work-orders/${wo.id}`);
    expect(wo3.materials.every((m: any) => m.issued_qty === 0)).toBe(true);
    expect((await api.as('pmc').ok('post', `/api/work-orders/${wo.id}/cancel`)).status).toBe('CANCELLED');
    // 已取消工单不能再退料
    r = await api.as('wh').post(`/api/work-orders/${wo.id}/returns`, { lines: [{ ...line, qty: 1 }] });
    expect(r.body.detail).toContain('工单状态不允许退料');
  });

  test('客户退货：冻结入库 + 序列号 RETURNED + 自动 NCR；关闭按 NCR 处置执行（电子签名）', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const c1 = await api.find('/api/customers', { q: 'C001' });
    const c2 = await api.find('/api/customers', { q: 'C002' });
    const fg = ref.m['FG-RL300'];
    // 准备两台已发货给 C001 的产品
    const wo = await db.base.workOrder.create({
      data: { no: 'WO-RMA-T', material_id: fg, customer_id: c1.id, planned_qty: 2, completed_qty: 2, lot_no: 'BRMA01', status: 'CLOSED', dhr_status: 'RELEASED' },
    });
    for (const sn of ['RL3RMA001', 'RL3RMA002']) {
      await db.base.serialNumber.create({ data: { sn, wo_id: wo.id, material_id: fg, lot_no: 'BRMA01', status: 'SHIPPED', customer_id: c1.id, shipped_at: new Date() } });
    }
    const line = { material_id: fg, sn: 'RL3RMA001', qty: 1, location_id: ref.loc['REJ-01'] };

    // 校验：序列号产品必须登记 SN、客户必须一致、无权限
    let r = await api.as('wh').post('/api/customer-returns', { customer_id: c1.id, reason: '无法开机', lines: [{ ...line, sn: null }] });
    expect(r.body.detail).toContain('逐台登记序列号');
    r = await api.as('wh').post('/api/customer-returns', { customer_id: c2.id, reason: '无法开机', lines: [line] });
    expect(r.body.detail).toContain('不是发给该客户');
    expect((await api.as('qc').post('/api/customer-returns', { customer_id: c1.id, reason: 'x', lines: [line] })).status).toBe(403);

    const rma = await api.as('wh').ok('post', '/api/customer-returns', { customer_id: c1.id, reason: '无法开机，客户要求退回检测', lines: [line] });
    expect([rma.status, rma.customer_name, rma.no.startsWith('TH'), rma.lines[0].lot_no, rma.lines[0].location_code]).toEqual(['RECEIVED', 'Lumina Health Inc.', true, 'BRMA01', 'REJ-01']);
    expect(rma.return_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 冻结入库（不可领用/发货）
    const st = await stockOf(api, { lot_no: 'BRMA01' });
    expect(st.map((s: any) => [s.status, s.qty, s.location_code])).toEqual([['HOLD', 1, 'REJ-01']]);
    // 序列号 → RETURNED，保留客户
    const sn = await db.base.serialNumber.findUnique({ where: { sn: 'RL3RMA001' } });
    expect([sn!.status, sn!.customer_id, sn!.location_id]).toEqual(['RETURNED', c1.id, ref.loc['REJ-01']]);
    expect(rma.lines[0].sn_status).toBe('RETURNED');
    // 自动开具 NCR（来源客户），已关联
    const ncr = await api.ok('get', `/api/ncrs/${rma.ncr_id}`);
    expect([ncr.source, ncr.status, ncr.sn, ncr.customer_id, ncr.qty]).toEqual(['CUSTOMER', 'OPEN', 'RL3RMA001', c1.id, 1]);
    expect(ncr.description).toContain(rma.no);
    expect(rma.ncr_no).toBe(ncr.no);
    // 同一序列号不能重复退货
    r = await api.as('wh').post('/api/customer-returns', { customer_id: c1.id, reason: '重复', lines: [line] });
    expect(r.body.detail).toContain('不是已发货产品');

    // 关闭：NCR 未处置不能关闭
    r = await api.as('qa').post(`/api/customer-returns/${rma.id}/close`, { location_id: ref.loc['FG-01'], signature: SIG });
    expect(r.body.detail).toContain('NCR');
    await api.as('qa').ok('post', `/api/ncrs/${ncr.id}/disposition`, { disposition: 'USE_AS_IS', remark: '复测合格，客户误操作', signature: SIG });
    // 转合格不能留在不合格品区；需电子签名；仅 QA
    r = await api.as('qa').post(`/api/customer-returns/${rma.id}/close`, { signature: SIG });
    expect(r.body.detail).toContain('上架库位');
    r = await api.as('qa').post(`/api/customer-returns/${rma.id}/close`, { location_id: ref.loc['FG-01'] });
    expect(r.body.detail).toContain('电子签名');
    expect((await api.as('wh').post(`/api/customer-returns/${rma.id}/close`, { location_id: ref.loc['FG-01'], signature: SIG })).status).toBe(403);
    const closed = await api.as('qa').ok('post', `/api/customer-returns/${rma.id}/close`, { location_id: ref.loc['FG-01'], remark: '复测合格', signature: SIG });
    expect(closed.status).toBe('CLOSED');
    expect((await stockOf(api, { lot_no: 'BRMA01' })).map((s: any) => [s.status, s.location_code])).toEqual([['AVAILABLE', 'FG-01']]);
    expect((await db.base.serialNumber.findUnique({ where: { sn: 'RL3RMA001' } }))!.status).toBe('IN_STOCK');
    const sigs = (await api.ok('get', '/api/system/esignatures', { entity: 'wms_customer_return' })).items;
    expect(sigs[0].meaning).toBe('客户退货关闭（让步接收转合格）');

    // 第二台：报废
    const rma2 = await api.as('qa').ok('post', '/api/customer-returns', { customer_id: c1.id, reason: '外壳破裂', lines: [{ ...line, sn: 'RL3RMA002' }] });
    await api.as('qa').ok('post', `/api/ncrs/${rma2.ncr_id}/disposition`, { disposition: 'SCRAP', signature: SIG });
    await api.as('qa').ok('post', `/api/customer-returns/${rma2.id}/close`, { signature: SIG });
    expect((await db.base.serialNumber.findUnique({ where: { sn: 'RL3RMA002' } }))!.status).toBe('SCRAPPED');
    expect((await stockOf(api, { lot_no: 'BRMA01', status: 'HOLD' }))).toEqual([]);
    const list = await api.ok('get', '/api/customer-returns', { q: 'RL3RMA002' });
    expect(list.items.map((x: any) => [x.no, x.status, x.ncr_disposition])).toEqual([[rma2.no, 'CLOSED', 'SCRAP']]);
  });

  test('客户投诉：登记 → 调查 → 开 NCR / CAPA → 关闭需调查结论 + QA 电子签名（客诉关闭）', async () => {
    const { api, db } = t;
    const ref = await api.ids();
    const c1 = await api.find('/api/customers', { q: 'C001' });
    const fg = ref.m['FG-RL300'];
    const wo = await db.base.workOrder.create({ data: { no: 'WO-KS-T', material_id: fg, customer_id: c1.id, planned_qty: 1, lot_no: 'BKS01', status: 'CLOSED' } });
    await db.base.serialNumber.create({ data: { sn: 'RL3KS001', wo_id: wo.id, material_id: fg, lot_no: 'BKS01', status: 'SHIPPED', customer_id: c1.id } });

    expect((await api.as('qc').post('/api/complaints', { customer_id: c1.id, description: 'x' })).status).toBe(403);
    let c = await api.as('sales').ok('post', '/api/complaints', {
      customer_id: c1.id, sn: 'RL3KS001', description: '用户反馈使用中面板局部发烫', is_adverse_event: true,
    });
    expect([c.status, c.no.startsWith('KS'), c.material_code, c.lot_no, c.is_adverse_event, c.customer_name]).toEqual(['OPEN', true, 'FG-RL300', 'BKS01', true, 'Lumina Health Inc.']);
    expect(c.received_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // QA 待办
    const todos = await api.as('qa').ok('get', '/api/todos');
    expect(todos.some((x: any) => x.key === 'complaint' && x.count === 1)).toBe(true);

    // 未开始调查不能关闭
    let r = await api.as('qa').post(`/api/complaints/${c.id}/close`, { investigation: '结论', signature: SIG });
    expect(r.body.detail).toContain('请先开始调查');
    c = await api.as('qa').ok('post', `/api/complaints/${c.id}/investigate`);
    expect(c.status).toBe('INVESTIGATING');
    // 开具 NCR（不良事件 → 致命）与 CAPA
    c = await api.as('qa').ok('post', `/api/complaints/${c.id}/ncr`);
    const ncr = await api.ok('get', `/api/ncrs/${c.ncr_id}`);
    expect([ncr.source, ncr.severity, ncr.sn, ncr.customer_id]).toEqual(['CUSTOMER', 'CRITICAL', 'RL3KS001', c1.id]);
    expect(c.ncr_no).toBe(ncr.no);
    expect((await api.as('qa').post(`/api/complaints/${c.id}/ncr`)).body.detail).toContain('已关联 NCR');
    c = await api.as('qa').ok('post', `/api/complaints/${c.id}/capa`, { title: '面板过热纠正预防' });
    const capa = await api.ok('get', `/api/capas/${c.capa_id}`);
    expect([capa.source, capa.title]).toEqual(['COMPLAINT', '面板过热纠正预防']);
    expect((await api.ok('get', `/api/ncrs/${c.ncr_id}`)).capa_id).toBe(c.capa_id);

    // 关闭：缺调查结论 / 缺签名 / 密码错误 / 非 QA
    r = await api.as('qa').post(`/api/complaints/${c.id}/close`, { signature: SIG });
    expect(r.body.detail).toContain('调查结论');
    r = await api.as('qa').post(`/api/complaints/${c.id}/close`, { investigation: '散热风扇批次 HY2609F 个别转速偏低' });
    expect(r.body.detail).toContain('电子签名');
    r = await api.as('qa').post(`/api/complaints/${c.id}/close`, { investigation: '结论', signature: { password: 'wrong-pwd' } });
    expect(r.status).toBe(400);
    expect((await api.as('sales').post(`/api/complaints/${c.id}/close`, { investigation: '结论', signature: SIG })).status).toBe(403);
    c = await api.as('qa').ok('post', `/api/complaints/${c.id}/close`, { investigation: '散热风扇批次 HY2609F 个别转速偏低，已更换并上报注册人', signature: SIG });
    expect([c.status, c.closed_by]).toEqual(['CLOSED', '赵QA']);
    expect(c.investigation).toContain('HY2609F');
    const sigs = (await api.ok('get', '/api/system/esignatures', { entity: 'qms_complaint' })).items;
    expect([sigs[0].meaning, sigs[0].username, sigs[0].doc_no]).toEqual(['客诉关闭', 'qa', c.no]);
    // 已关闭不能修改；列表筛选不良事件
    expect((await api.as('sales').put(`/api/complaints/${c.id}`, { description: '改' })).body.detail).toContain('已关闭');
    expect((await api.ok('get', '/api/complaints', { is_adverse_event: 'true' })).total).toBe(1);
    expect((await api.ok('get', '/api/complaints', { is_adverse_event: 'false' })).total).toBe(0);
  });

  test('附件：上传 → 列表 → 下载（原文件名、sha256 校验）；内容去重；不提供删除', async () => {
    const { api, app } = t;
    const login = await api.c_login('qc', DEMO_PASSWORD);
    const token = login.body.access_token;
    const http = () => request(app.getHttpServer());
    const ncr = await api.as('qc').ok('post', '/api/ncrs', { source: 'OTHER', description: '巡检发现划伤' });
    const content = Buffer.from('\x89PNG\r\n\x1a\n-fake-image-' + 'x'.repeat(1000), 'binary');
    const up = (entity: string, id: number | string, buf = content, name = '缺陷照片 1.png') =>
      http().post('/api/attachments').set('Authorization', `Bearer ${token}`).field('entity', entity).field('entity_id', String(id)).attach('file', buf, name);

    let r = await up('qms_ncr', ncr.id);
    expect(r.status).toBe(200);
    const a1 = r.body;
    expect([a1.entity, a1.entity_id, a1.filename, a1.size, a1.uploaded_by, a1.uploaded_by_name]).toEqual(['qms_ncr', ncr.id, '缺陷照片 1.png', content.length, 'qc', '孙质检']);
    expect(a1.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a1.storage_key).toBeUndefined();

    // 同一内容挂到另一单据：只存一份文件
    const capa = await api.as('qa').ok('post', '/api/capas', { title: '划伤 CAPA' });
    r = await up('qms_capa', capa.id, content, 'same.png');
    expect(r.body.sha256).toBe(a1.sha256);
    const files = readdirSync(join(attDir, a1.sha256.slice(0, 2), a1.sha256.slice(2, 4)));
    expect(files).toEqual([a1.sha256]);

    const list = await api.ok('get', '/api/attachments', { entity: 'qms_ncr', entity_id: ncr.id });
    expect(list.map((x: any) => x.filename)).toEqual(['缺陷照片 1.png']);

    // 下载：原文件名（RFC 5987）+ 内容一致
    const dl = await http().get(`/api/attachments/${a1.id}/download`).set('Authorization', `Bearer ${token}`)
      .buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(dl.status).toBe(200);
    expect(Buffer.compare(dl.body as Buffer, content)).toBe(0);
    expect(dl.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('缺陷照片 1.png')}`);

    // 校验：不支持的对象、单据不存在、空文件、超大文件、未登录
    expect((await up('sys_user', 1)).status).toBe(400);
    expect((await up('qms_ncr', 99999)).status).toBe(404);
    r = await up('qms_ncr', ncr.id, Buffer.alloc(0), 'empty.txt');
    expect(r.status).toBe(400);
    r = await up('qms_ncr', ncr.id, Buffer.alloc(20 * 1024 * 1024 + 1, 1), 'big.bin');
    expect(r.status).toBe(413);
    expect(r.body.detail).toContain('20 MB');
    expect((await http().get('/api/attachments').query({ entity: 'qms_ncr', entity_id: ncr.id })).status).toBe(401);

    // 质量证据不可删除；文件被篡改时拒绝下载
    expect((await http().delete(`/api/attachments/${a1.id}`).set('Authorization', `Bearer ${token}`)).status).toBe(404);
    writeFileSync(join(attDir, a1.sha256.slice(0, 2), a1.sha256.slice(2, 4), a1.sha256), 'tampered');
    r = await http().get(`/api/attachments/${a1.id}/download`).set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(500);
    expect(r.body.detail).toContain('校验失败');
    // 上传记录进入审计追踪
    const audit = await t.db.base.auditLog.findMany({ where: { entity: 'sys_attachment', action: 'CREATE' } });
    expect(audit.length).toBe(2);
  });
});
