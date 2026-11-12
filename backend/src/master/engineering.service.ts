/**
 * 工程数据业务规则：BOM / 工艺路线（受控文件）。
 * 生命周期（双人签名，GMP 要求工程变更须经质量部门批准）：
 *   草稿 DRAFT（工程师编辑）→【提交】工程师电子签名“编制” → 待批准 SUBMITTED（只读）
 *     →【批准】QA 电子签名“批准”（批准人 ≠ 提交人）→ 已发布 RELEASED（同产品原已发布版本自动作废 OBSOLETE）
 *     →【驳回】QA 电子签名 + 驳回原因 → 退回草稿
 *   已发布后只能“升版”生成新草稿；首版之后的版本提交时必须填写变更原因/影响评估（ECN）。
 * BOM 生效日期（D#18）：生效日期在未来的 BOM 批准后为“已批准待生效”（APPROVED），旧版本继续用于新工单与 MRP，
 *   到生效日自动转为已发布（定时任务 / 工单下达 / 批准时），旧版本同时作废。
 * 变更差异（F11 / D#2）：与上一版本逐项对比；提交时系统自动生成变更摘要写入编制签名理由。
 */
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { dateOnly, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { round } from '../common/num';
import { like, paginate } from '../common/paginate';
import { inc, ser } from '../common/presenter';
import { PrismaService, type Tx } from '../common/prisma.service';
import { activateDueBoms, diffBom, diffRouting, diffSummary, releasedBom, type DiffItem } from '../core/engineering';
import { EsignService } from '../core/esign.service';
import type { BomDto, BomLineDto, NewVersionDto, OperationDto, ParamDto, RejectDto, RoutingDto, SignOnlyDto, SubmitDto } from './engineering.dto';

const BOM_CHILDREN = ['lines'];
const ROUTING_CHILDREN = ['operations.params'];

/** 受控工程文件（BOM / 工艺路线）的签名含义与提示用语 */
const DOC = {
  bom: { table: 'eng_bom', name: 'BOM', submit: 'BOM编制提交', approve: 'BOM批准', reject: 'BOM驳回' },
  routing: { table: 'eng_routing', name: '工艺路线', submit: '工艺路线编制提交', approve: '工艺路线批准', reject: '工艺路线驳回' },
} as const;
type DocKind = keyof typeof DOC;

/** 不可编辑时的提示 */
function readOnlyError(kind: DocKind, status: string): BizError {
  const d = DOC[kind];
  if (status === 'SUBMITTED') return new BizError(`${d.name}已提交待 QA 批准，不能修改；如需修改请由 QA 驳回后再编辑`);
  if (status === 'APPROVED') return new BizError(`${d.name}已批准、等待生效日生效，不能修改；如需修改请升版`);
  return kind === 'bom' ? new BizError('已发布的 BOM 不能修改，请“升版”生成新版本（ECN 变更）') : new BizError('已发布的工艺路线不能修改，请升版');
}

/** 查询参数中的整数（空/0 视为未筛选） */
export function qInt(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new BizError(`参数格式错误：${v}`);
  return n || undefined;
}

/** 外键不存在 / 唯一约束冲突时给出明确的中文提示（否则会被全局过滤器误报） */
function fkGuard(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') throw new BizError('数据不完整或关联数据不存在');
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    const target = String((e.meta as any)?.target ?? '');
    if (target.includes('code') || target.includes('param')) {
      throw new BizError('测试项编码重复：同一工序内测试项编码必须唯一（工位按编码记录测量值），请修改后再保存');
    }
    throw new BizError('编码或版本号重复，请修改后再保存');
  }
  throw e;
}

function bomLines(materialId: number, lines: BomLineDto[]) {
  const seen = new Map<number, number>();
  return lines.map((ln, i) => {
    if (ln.component_id === materialId) throw new BizError('BOM 组件不能是父项自身');
    if (seen.has(ln.component_id)) throw new BizError(`同一组件在 BOM 中重复出现（第 ${seen.get(ln.component_id)} 行和第 ${i + 1} 行），请合并为一行`);
    seen.set(ln.component_id, i + 1);
    return {
      line_no: (i + 1) * 10, component_id: ln.component_id, qty_per: ln.qty_per, scrap_rate: ln.scrap_rate ?? 0,
      designator: ln.designator ?? null, remark: ln.remark ?? null,
    };
  });
}

const has = (v: number | null | undefined): v is number => v !== null && v !== undefined;

/**
 * 测试项校验（C-F02 / F19）：编码必填且同一工序内唯一（工位按编码记录测量值，重复会导致两个框同步、每台判不合格）；
 * OK/NG 型不设上下限；数值型下限 ≤ 上限、合理范围下限 ≤ 上限、规格在合理范围内、小数位 0–6。
 */
export function checkParams(o: { seq: number; name: string }, params: ParamDto[]) {
  const seen = new Map<string, number>();
  return params.map((p, i) => {
    const code = (p.code ?? '').trim();
    const name = (p.name ?? '').trim();
    if (!code || !name) throw new BizError(`工序【${o.seq} ${o.name}】第 ${i + 1} 个测试项请填写编码和名称`);
    const k = code.toUpperCase();
    if (seen.has(k)) {
      throw new BizError(`工序【${o.seq} ${o.name}】的测试项编码“${code}”重复（第 ${seen.get(k)} 项和第 ${i + 1} 项）：同一工序内编码必须唯一，请改为不同的编码`);
    }
    seen.set(k, i + 1);
    if (p.param_type === 'OKNG') {
      return { code, name, unit: null, lower: null, upper: null, target: null, param_type: 'OKNG', decimals: null, min_valid: null, max_valid: null };
    }
    if (has(p.lower) && has(p.upper) && p.lower > p.upper) throw new BizError(`工序 ${o.name} 测试项 ${p.name} 下限大于上限`);
    if (has(p.min_valid) && has(p.max_valid) && p.min_valid > p.max_valid) {
      throw new BizError(`工序 ${o.name} 测试项 ${p.name} 合理范围下限大于上限`);
    }
    for (const [v, label] of [[p.lower, '下限'], [p.upper, '上限'], [p.target, '目标值']] as const) {
      if (!has(v)) continue;
      if ((has(p.min_valid) && v < p.min_valid) || (has(p.max_valid) && v > p.max_valid)) {
        throw new BizError(`工序 ${o.name} 测试项 ${p.name} 的规格${label} ${v} 不在合理范围（${p.min_valid ?? '不限'} ~ ${p.max_valid ?? '不限'}）内`);
      }
    }
    return {
      code, name, unit: p.unit?.trim() || null, lower: p.lower ?? null, upper: p.upper ?? null, target: p.target ?? null, param_type: 'NUMBER',
      decimals: has(p.decimals) ? p.decimals : null, min_valid: p.min_valid ?? null, max_valid: p.max_valid ?? null,
    };
  });
}

function routingOps(ops: OperationDto[]) {
  const seqs = ops.map((o) => o.seq);
  if (new Set(seqs).size !== seqs.length) throw new BizError('工序号重复');
  const codes = new Map<string, number>();
  for (const o of ops) {
    const k = (o.code ?? '').trim().toUpperCase();
    if (k && codes.has(k)) throw new BizError(`工序编码“${o.code}”重复（工序 ${codes.get(k)} 和 ${o.seq}）：工位按工序编码锁定，同一工艺路线内必须唯一`);
    codes.set(k, o.seq);
  }
  return [...ops]
    .sort((a, b) => a.seq - b.seq)
    .map((o) => {
      const params = checkParams(o, o.params ?? []);
      return {
        seq: o.seq, code: o.code, name: o.name, op_type: o.op_type ?? 'ASSEMBLY', work_center_id: o.work_center_id ?? null,
        std_minutes: o.std_minutes ?? 0, requires_equipment: o.requires_equipment ?? false, key_part_material_id: o.key_part_material_id ?? null,
        sop_no: o.sop_no ?? null, instructions: o.instructions ?? null,
        params: { create: params },
      };
    });
}

/** 提交签名理由：工程师未填写时写入系统生成的变更摘要（不可篡改的编制记录） */
function withSummary<T extends { signature?: { password: string; reason?: string | null } | null }>(body: T, summary: string | null) {
  if (!body.signature || !summary || body.signature.reason?.trim()) return body.signature;
  return { ...body.signature, reason: `变更摘要（系统生成）：${summary}`.slice(0, 256) };
}

/** 锁定单据行，保证状态流转串行（并发提交/批准/驳回） */
async function lockRow(tx: Tx, kind: DocKind, id: number) {
  if (kind === 'bom') await tx.$queryRaw`SELECT id FROM "eng_bom" WHERE id = ${id} FOR UPDATE`;
  else await tx.$queryRaw`SELECT id FROM "eng_routing" WHERE id = ${id} FOR UPDATE`;
}

/** 同一产品的批准串行执行，保证任一时刻只有一个“已发布”版本 */
async function lockMaterial(tx: Tx, materialId: number) {
  await tx.$queryRaw`SELECT id FROM "md_material" WHERE id = ${materialId} FOR NO KEY UPDATE`;
}

/** 首版之后的版本（该产品已有发布过的版本）提交时，必须填写变更原因 / 影响评估 */
async function requireChangeReason(
  tx: Tx, kind: DocKind, doc: { id: number; material_id: number; change_reason: string | null }, given?: string | null,
): Promise<string | null> {
  const reason = given?.trim() || doc.change_reason?.trim() || null;
  if (reason) return reason;
  const where = { material_id: doc.material_id, id: { not: doc.id }, status: { in: ['RELEASED', 'OBSOLETE'] } };
  const prior = kind === 'bom' ? await tx.bom.count({ where }) : await tx.routing.count({ where });
  if (prior) throw new BizError(`该产品已有发布过的${DOC[kind].name}版本，提交新版本须填写变更原因及影响评估`);
  return null;
}

/** 职责分离：批准人不能是本次提交人（以提交时的电子签名记录为准） */
async function checkNotSubmitter(tx: Tx, kind: DocKind, doc: { id: number; submitted_by: string | null }, user: CurrentUser) {
  const sig = await tx.eSignature.findFirst({
    where: { entity: DOC[kind].table, entity_id: doc.id, meaning: DOC[kind].submit },
    orderBy: { id: 'desc' },
  });
  const submitter = sig ? sig.username === user.username : doc.submitted_by === user.full_name;
  if (submitter) throw new BizError(`批准人不能与提交人相同：${DOC[kind].name}须由另一位 QA 人员审核批准（职责分离）`);
}

/** 驳回原因写入电子签名理由 */
const withReason = (body: RejectDto) => (body.signature ? { ...body.signature, reason: body.signature.reason?.trim() || body.reason } : body.signature);

@Injectable()
export class EngineeringService implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly db: PrismaService, private readonly esign: EsignService) {}

  private timer?: ReturnType<typeof setInterval>;

  /** 定时把到期的“已批准待生效”BOM 转为已发布（启动时执行一次，之后每 10 分钟） */
  onModuleInit() {
    const run = () => this.activateBoms().catch(() => undefined);
    setTimeout(run, 2000).unref?.();
    this.timer = setInterval(run, 10 * 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  activateBoms(materialId?: number) {
    return this.db.tx((tx) => activateDueBoms(tx, materialId));
  }

  private async checkMaterials(tx: Tx, ids: number[]) {
    const uniq = [...new Set(ids)];
    const n = await tx.material.count({ where: { id: { in: uniq } } });
    if (n !== uniq.length) throw new NotFound('物料');
  }

  // ================= BOM =================
  listBoms(q: Record<string, string>) {
    const where: Prisma.BomWhereInput = {};
    if (q.q) where.OR = [{ material: { code: like(q.q) } }, { material: { name: like(q.q) } }, { ecn_no: like(q.q) }];
    const mid = qInt(q.material_id);
    if (mid) where.material_id = mid;
    if (q.status) where.status = q.status;
    return paginate(this.db.client.bom, 'Bom', { where, orderBy: { id: 'desc' } }, q);
  }

  async getBom(id: number) {
    const b = await this.db.client.bom.findUnique({ where: { id }, include: inc('Bom', BOM_CHILDREN) });
    if (!b) throw new NotFound('BOM');
    return ser('Bom', b, BOM_CHILDREN);
  }

  createBom(user: CurrentUser, body: BomDto) {
    return this.db
      .tx(async (tx) => {
        const version = body.version ?? 'A0';
        if (await tx.bom.findFirst({ where: { material_id: body.material_id, version } })) throw new BizError(`该产品已存在版本 ${version} 的 BOM`);
        const lines = bomLines(body.material_id, body.lines ?? []);
        await this.checkMaterials(tx, [body.material_id, ...lines.map((l) => l.component_id)]);
        const b = await tx.bom.create({
          data: {
            material_id: body.material_id, version, ecn_no: body.ecn_no ?? null, effective_date: dateOnly(body.effective_date),
            remark: body.remark ?? null, change_reason: body.change_reason?.trim() || null, status: 'DRAFT', created_by: user.username, lines: { create: lines },
          },
          include: inc('Bom', BOM_CHILDREN),
        });
        return ser('Bom', b, BOM_CHILDREN);
      })
      .catch(fkGuard);
  }

  updateBom(id: number, body: BomDto) {
    return this.db
      .tx(async (tx) => {
        const cur = await tx.bom.findUnique({ where: { id } });
        if (!cur) throw new NotFound('BOM');
        if (cur.status !== 'DRAFT') throw readOnlyError('bom', cur.status);
        const lines = bomLines(cur.material_id, body.lines ?? []);
        await this.checkMaterials(tx, lines.map((l) => l.component_id));
        const b = await tx.bom.update({
          where: { id },
          data: {
            version: body.version ?? 'A0', ecn_no: body.ecn_no ?? null, effective_date: dateOnly(body.effective_date), remark: body.remark ?? null,
            change_reason: body.change_reason === undefined ? cur.change_reason : body.change_reason?.trim() || null,
            lines: { deleteMany: {}, create: lines },
          },
          include: inc('Bom', BOM_CHILDREN),
        });
        return ser('Bom', b, BOM_CHILDREN);
      })
      .catch(fkGuard);
  }

  deleteBom(id: number) {
    return this.db.tx(async (tx) => {
      const b = await tx.bom.findUnique({ where: { id } });
      if (!b) throw new NotFound('BOM');
      if (b.status !== 'DRAFT') throw new BizError('只能删除草稿');
      await tx.bom.delete({ where: { id } });
      return { ok: true };
    });
  }

  /** 循环引用检查：沿已发布的子 BOM 向下展开 */
  private async checkCycle(tx: Tx, rootId: number, compIds: number[], path: number[] = []): Promise<void> {
    for (const cid of compIds) {
      if (cid === rootId || path.includes(cid)) throw new BizError('BOM 存在循环引用');
      const sub = await releasedBom(tx, cid);
      if (sub) await this.checkCycle(tx, rootId, sub.lines.map((l) => l.component_id), [...path, cid]);
    }
  }

  /** 工程师提交（电子签名：编制）：草稿 → 待批准 */
  submitBom(id: number, body: SubmitDto, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      await lockRow(tx, 'bom', id);
      const b = await tx.bom.findUnique({ where: { id }, include: { material: true, lines: { orderBy: { line_no: 'asc' } } } });
      if (!b) throw new NotFound('BOM');
      if (b.status !== 'DRAFT') throw new BizError('只有草稿可以提交');
      if (!b.lines.length) throw new BizError('BOM 没有组件');
      await this.checkCycle(tx, b.material_id, b.lines.map((l) => l.component_id));
      const reason = await requireChangeReason(tx, 'bom', b, body.change_reason);
      const base = await this.bomBase(tx, b);
      const summary = base ? diffSummary(diffBom(await this.bomFull(tx, base.id), await this.bomFull(tx, b.id))) : null;
      await this.esign.sign(tx, user, withSummary(body, summary), DOC.bom.submit, DOC.bom.table, b.id, `${b.material.code} ${b.version}`);
      const row = await tx.bom.update({
        where: { id },
        data: { status: 'SUBMITTED', change_reason: reason, submitted_by: user.full_name, submitted_at: new Date() },
        include: inc('Bom', BOM_CHILDREN),
      });
      return ser('Bom', row, BOM_CHILDREN);
    });
  }

  /** QA 批准（电子签名：批准）：待批准 → 已发布；同产品原已发布版本作废。批准人不能是提交人 */
  approveBom(id: number, body: SignOnlyDto, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      await lockRow(tx, 'bom', id);
      const b = await tx.bom.findUnique({ where: { id }, include: { material: true, lines: { orderBy: { line_no: 'asc' } } } });
      if (!b) throw new NotFound('BOM');
      if (b.status !== 'SUBMITTED') throw new BizError('只有已提交待批准的 BOM 可以批准');
      await checkNotSubmitter(tx, 'bom', b, user);
      await lockMaterial(tx, b.material_id);
      await this.checkCycle(tx, b.material_id, b.lines.map((l) => l.component_id));
      await this.esign.sign(tx, user, body.signature, DOC.bom.approve, DOC.bom.table, b.id, `${b.material.code} ${b.version}`);
      const eff = b.effective_date ?? today();
      const future = eff.getTime() > today().getTime();
      // 更早批准、尚未生效的版本被本版本取代，不再生效
      await tx.bom.updateMany({ where: { material_id: b.material_id, status: 'APPROVED', id: { not: b.id } }, data: { status: 'OBSOLETE' } });
      if (!future) await tx.bom.updateMany({ where: { material_id: b.material_id, status: 'RELEASED' }, data: { status: 'OBSOLETE' } });
      const row = await tx.bom.update({
        where: { id },
        // 生效日期在未来：已批准待生效，原已发布版本继续使用到生效日
        data: { status: future ? 'APPROVED' : 'RELEASED', released_by: user.full_name, released_at: new Date(), effective_date: eff },
        include: inc('Bom', BOM_CHILDREN),
      });
      return ser('Bom', row, BOM_CHILDREN);
    });
  }

  /** QA 驳回（电子签名 + 原因）：待批准 → 草稿 */
  rejectBom(id: number, body: RejectDto, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      await lockRow(tx, 'bom', id);
      const b = await tx.bom.findUnique({ where: { id }, include: { material: true } });
      if (!b) throw new NotFound('BOM');
      if (b.status !== 'SUBMITTED') throw new BizError('只有已提交待批准的 BOM 可以驳回');
      await this.esign.sign(tx, user, withReason(body), DOC.bom.reject, DOC.bom.table, b.id, `${b.material.code} ${b.version}`);
      const row = await tx.bom.update({
        where: { id },
        data: { status: 'DRAFT', submitted_by: null, submitted_at: null },
        include: inc('Bom', BOM_CHILDREN),
      });
      return ser('Bom', row, BOM_CHILDREN);
    });
  }

  bomNewVersion(id: number, body: NewVersionDto, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const b = await tx.bom.findUnique({ where: { id }, include: { lines: { orderBy: { line_no: 'asc' } } } });
      if (!b) throw new NotFound('BOM');
      if (await tx.bom.findFirst({ where: { material_id: b.material_id, version: body.version } })) throw new BizError('版本号已存在');
      const nb = await tx.bom.create({
        data: {
          material_id: b.material_id, version: body.version, ecn_no: body.ecn_no ?? null, status: 'DRAFT', remark: b.remark, created_by: user.username,
          change_reason: body.change_reason?.trim() || null,
          lines: {
            create: b.lines.map((ln) => ({
              line_no: ln.line_no, component_id: ln.component_id, qty_per: ln.qty_per, scrap_rate: ln.scrap_rate, designator: ln.designator, remark: ln.remark,
            })),
          },
        },
        include: inc('Bom', BOM_CHILDREN),
      });
      return ser('Bom', nb, BOM_CHILDREN);
    });
  }

  /** 多级 BOM 展开（按已发布的子 BOM 逐层展开，用量含损耗） */
  async bomTree(id: number, qty: number) {
    const c = this.db.client;
    const b = await c.bom.findUnique({ where: { id }, include: { ...inc('Bom'), lines: { orderBy: { line_no: 'asc' }, include: { component: true } } } });
    if (!b) throw new NotFound('BOM');
    type Line = (typeof b.lines)[number];
    const expand = async (lines: Line[], mult: number, level: number, path: number[]): Promise<any[]> => {
      const out: any[] = [];
      for (const ln of lines) {
        const need = mult * ln.qty_per * (1 + (ln.scrap_rate || 0));
        const node: Record<string, any> = {
          key: `${path.join('-')}-${ln.id}`, level, component_id: ln.component_id, code: ln.component.code, name: ln.component.name,
          spec: ln.component.spec, uom: ln.component.uom, qty_per: ln.qty_per, total_qty: round(need, 4), designator: ln.designator,
          customer_supplied: !!ln.component.owner_customer_id,
        };
        const sub = await releasedBom(c, ln.component_id);
        if (sub && !path.includes(ln.component_id)) node.children = await expand(sub.lines, need, level + 1, [...path, ln.component_id]);
        out.push(node);
      }
      return out;
    };
    return { bom: ser('Bom', b), tree: await expand(b.lines, qty, 1, [b.material_id]) };
  }

  // ================= 工艺路线 =================
  listRoutings(q: Record<string, string>) {
    const where: Prisma.RoutingWhereInput = {};
    if (q.q) where.OR = [{ material: { code: like(q.q) } }, { material: { name: like(q.q) } }, { name: like(q.q) }];
    const mid = qInt(q.material_id);
    if (mid) where.material_id = mid;
    if (q.status) where.status = q.status;
    return paginate(this.db.client.routing, 'Routing', { where, orderBy: { id: 'desc' } }, q);
  }

  async getRouting(id: number) {
    const r = await this.db.client.routing.findUnique({ where: { id }, include: inc('Routing', ROUTING_CHILDREN) });
    if (!r) throw new NotFound('工艺路线');
    return ser('Routing', r, ROUTING_CHILDREN);
  }

  createRouting(user: CurrentUser, body: RoutingDto) {
    return this.db
      .tx(async (tx) => {
        const version = body.version ?? 'A0';
        if (await tx.routing.findFirst({ where: { material_id: body.material_id, version } })) throw new BizError(`该产品已存在版本 ${version} 的工艺路线`);
        const ops = routingOps(body.operations ?? []);
        await this.checkMaterials(tx, [body.material_id]);
        const r = await tx.routing.create({
          data: {
            material_id: body.material_id, version, name: body.name ?? null, remark: body.remark ?? null, status: 'DRAFT', created_by: user.username,
            change_reason: body.change_reason?.trim() || null, operations: { create: ops },
          },
          include: inc('Routing', ROUTING_CHILDREN),
        });
        return ser('Routing', r, ROUTING_CHILDREN);
      })
      .catch(fkGuard);
  }

  updateRouting(id: number, body: RoutingDto) {
    return this.db
      .tx(async (tx) => {
        const cur = await tx.routing.findUnique({ where: { id } });
        if (!cur) throw new NotFound('工艺路线');
        if (cur.status !== 'DRAFT') throw readOnlyError('routing', cur.status);
        const ops = routingOps(body.operations ?? []);
        // 工序按编码原地更新（保持工序 id 不变，作业指导附件挂在工序上），新增的创建、删掉的删除
        const existing = await tx.routingOperation.findMany({ where: { routing_id: id }, orderBy: { id: 'asc' } });
        const byCode = new Map(existing.map((o) => [o.code.trim().toUpperCase(), o]));
        const keep: number[] = [];
        for (const o of ops) {
          const { params, ...data } = o;
          const ex = byCode.get(String(o.code).trim().toUpperCase());
          if (ex && !keep.includes(ex.id)) {
            keep.push(ex.id);
            await tx.routingParam.deleteMany({ where: { operation_id: ex.id } });
            await tx.routingOperation.update({ where: { id: ex.id }, data: { ...data, params } });
          } else {
            keep.push((await tx.routingOperation.create({ data: { ...data, routing_id: id, params } })).id);
          }
        }
        await tx.routingOperation.deleteMany({ where: { routing_id: id, id: { notIn: keep } } });
        const r = await tx.routing.update({
          where: { id },
          data: {
            version: body.version ?? 'A0', name: body.name ?? null, remark: body.remark ?? null,
            change_reason: body.change_reason === undefined ? cur.change_reason : body.change_reason?.trim() || null,
          },
          include: inc('Routing', ROUTING_CHILDREN),
        });
        return ser('Routing', r, ROUTING_CHILDREN);
      })
      .catch(fkGuard);
  }

  /** 工程师提交（电子签名：编制）：草稿 → 待批准 */
  submitRouting(id: number, body: SubmitDto, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      await lockRow(tx, 'routing', id);
      const r = await tx.routing.findUnique({ where: { id }, include: { material: true, operations: { select: { id: true } } } });
      if (!r) throw new NotFound('工艺路线');
      if (r.status !== 'DRAFT') throw new BizError('只有草稿可以提交');
      if (!r.operations.length) throw new BizError('工艺路线没有工序');
      const reason = await requireChangeReason(tx, 'routing', r, body.change_reason);
      const base = await this.routingBase(tx, r);
      const summary = base ? diffSummary(diffRouting(await this.routingFull(tx, base.id), await this.routingFull(tx, r.id))) : null;
      await this.esign.sign(tx, user, withSummary(body, summary), DOC.routing.submit, DOC.routing.table, r.id, `${r.material.code} ${r.version}`);
      const row = await tx.routing.update({
        where: { id },
        data: { status: 'SUBMITTED', change_reason: reason, submitted_by: user.full_name, submitted_at: new Date() },
        include: inc('Routing', ROUTING_CHILDREN),
      });
      return ser('Routing', row, ROUTING_CHILDREN);
    });
  }

  /** QA 批准（电子签名：批准）：待批准 → 已发布；同产品原已发布版本作废。批准人不能是提交人 */
  approveRouting(id: number, body: SignOnlyDto, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      await lockRow(tx, 'routing', id);
      const r = await tx.routing.findUnique({ where: { id }, include: { material: true } });
      if (!r) throw new NotFound('工艺路线');
      if (r.status !== 'SUBMITTED') throw new BizError('只有已提交待批准的工艺路线可以批准');
      await checkNotSubmitter(tx, 'routing', r, user);
      await lockMaterial(tx, r.material_id);
      await this.esign.sign(tx, user, body.signature, DOC.routing.approve, DOC.routing.table, r.id, `${r.material.code} ${r.version}`);
      await tx.routing.updateMany({ where: { material_id: r.material_id, status: 'RELEASED' }, data: { status: 'OBSOLETE' } });
      const row = await tx.routing.update({
        where: { id },
        data: { status: 'RELEASED', released_by: user.full_name, released_at: new Date() },
        include: inc('Routing', ROUTING_CHILDREN),
      });
      return ser('Routing', row, ROUTING_CHILDREN);
    });
  }

  /** QA 驳回（电子签名 + 原因）：待批准 → 草稿 */
  rejectRouting(id: number, body: RejectDto, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      await lockRow(tx, 'routing', id);
      const r = await tx.routing.findUnique({ where: { id }, include: { material: true } });
      if (!r) throw new NotFound('工艺路线');
      if (r.status !== 'SUBMITTED') throw new BizError('只有已提交待批准的工艺路线可以驳回');
      await this.esign.sign(tx, user, withReason(body), DOC.routing.reject, DOC.routing.table, r.id, `${r.material.code} ${r.version}`);
      const row = await tx.routing.update({
        where: { id },
        data: { status: 'DRAFT', submitted_by: null, submitted_at: null },
        include: inc('Routing', ROUTING_CHILDREN),
      });
      return ser('Routing', row, ROUTING_CHILDREN);
    });
  }

  routingNewVersion(id: number, body: NewVersionDto, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const r = await tx.routing.findUnique({
        where: { id },
        include: { operations: { orderBy: { seq: 'asc' }, include: { params: { orderBy: { id: 'asc' } } } } },
      });
      if (!r) throw new NotFound('工艺路线');
      if (await tx.routing.findFirst({ where: { material_id: r.material_id, version: body.version } })) throw new BizError('版本号已存在');
      const nr = await tx.routing.create({
        data: {
          material_id: r.material_id, version: body.version, name: r.name, status: 'DRAFT', created_by: user.username,
          change_reason: body.change_reason?.trim() || null,
          operations: {
            create: r.operations.map((o) => ({
              seq: o.seq, code: o.code, name: o.name, op_type: o.op_type, work_center_id: o.work_center_id, std_minutes: o.std_minutes,
              requires_equipment: o.requires_equipment, key_part_material_id: o.key_part_material_id, sop_no: o.sop_no, instructions: o.instructions,
              params: {
                create: o.params.map((p) => ({
                  code: p.code, name: p.name, unit: p.unit, lower: p.lower, upper: p.upper, target: p.target,
                  param_type: p.param_type, decimals: p.decimals, min_valid: p.min_valid, max_valid: p.max_valid,
                })),
              },
            })),
          },
        },
        include: inc('Routing', ROUTING_CHILDREN),
      });
      // 作业指导附件随工序带到新版本（引用同一文件，原记录不变）
      const newOps = new Map((nr as any).operations.map((o: { code: string; id: number }) => [o.code, o.id]));
      for (const o of r.operations) {
        const to = newOps.get(o.code) as number | undefined;
        if (!to) continue;
        const atts = await tx.attachment.findMany({ where: { entity: 'eng_routing_op', entity_id: o.id }, orderBy: { id: 'asc' } });
        for (const { id: _id, created_at: _c, ...a } of atts) await tx.attachment.create({ data: { ...a, entity_id: to } });
      }
      return ser('Routing', nr, ROUTING_CHILDREN);
    });
  }

  /** 本单据的电子签名记录（编制提交 / 驳回 / 批准）：随单据可见，不需要审计查阅权限 */
  async signatures(kind: DocKind, id: number) {
    const rows = await this.db.client.eSignature.findMany({ where: { entity: DOC[kind].table, entity_id: id }, orderBy: { id: 'asc' } });
    return rows.map((r) => ({ id: r.id, ts: r.ts, username: r.username, full_name: r.full_name, meaning: r.meaning, reason: r.reason, doc_no: r.doc_no }));
  }

  // ================= 版本差异（F11 / D#2） =================
  /** 对比基准：草稿/待批准 → 当前生效版本；其他 → 上一个版本 */
  private async bomBase(tx: Tx, b: { id: number; material_id: number; status: string }) {
    if (['DRAFT', 'SUBMITTED'].includes(b.status)) {
      const cur = await releasedBom(tx, b.material_id);
      if (cur && cur.id !== b.id) return cur;
    }
    const where = { material_id: b.material_id, id: { not: b.id }, status: { in: ['RELEASED', 'OBSOLETE', 'APPROVED'] } };
    return (await tx.bom.findFirst({ where: { ...where, id: { lt: b.id } }, orderBy: { id: 'desc' } })) ?? (await tx.bom.findFirst({ where, orderBy: { id: 'desc' } }));
  }

  private async routingBase(tx: Tx, r: { id: number; material_id: number; status: string }) {
    if (['DRAFT', 'SUBMITTED'].includes(r.status)) {
      const cur = await tx.routing.findFirst({ where: { material_id: r.material_id, status: 'RELEASED', id: { not: r.id } }, orderBy: { id: 'desc' } });
      if (cur) return cur;
    }
    const where = { material_id: r.material_id, id: { not: r.id }, status: { in: ['RELEASED', 'OBSOLETE'] } };
    return (await tx.routing.findFirst({ where: { ...where, id: { lt: r.id } }, orderBy: { id: 'desc' } })) ?? (await tx.routing.findFirst({ where, orderBy: { id: 'desc' } }));
  }

  private async bomFull(tx: Tx, id: number) {
    return ser('Bom', await tx.bom.findUniqueOrThrow({ where: { id }, include: inc('Bom', BOM_CHILDREN) }), BOM_CHILDREN);
  }

  private async routingFull(tx: Tx, id: number) {
    return ser('Routing', await tx.routing.findUniqueOrThrow({ where: { id }, include: inc('Routing', ROUTING_CHILDREN) }), ROUTING_CHILDREN);
  }

  private diffOut(base: { id: number; version: string; status: string } | null, items: DiffItem[]) {
    if (!base) return { base: null, items: [], summary: '首个版本，没有可对比的上一版本' };
    return { base: { id: base.id, version: base.version, status: base.status }, items, summary: diffSummary(items) };
  }

  /**
   * BOM 与上一版本的差异；draft 为未保存的编辑内容（按组件 id 解析编码名称），不传则用已保存内容。
   */
  async bomDiff(id: number, baseId?: number, draft?: { lines?: { component_id: number; qty_per?: number; scrap_rate?: number | null; designator?: string | null; remark?: string | null }[] | null }) {
    const tx = this.db.client;
    const b = await tx.bom.findUnique({ where: { id } });
    if (!b) throw new NotFound('BOM');
    const base = baseId ? await tx.bom.findUnique({ where: { id: baseId } }) : await this.bomBase(tx, b);
    if (base && base.material_id !== b.material_id) throw new BizError('只能与同一产品的其他版本对比');
    if (!base) return this.diffOut(null, []);
    let cur: Record<string, any> = await this.bomFull(tx, id);
    if (draft?.lines) {
      const ids = [...new Set(draft.lines.map((l) => Number(l.component_id)).filter(Boolean))];
      const mats = new Map((await tx.material.findMany({ where: { id: { in: ids } } })).map((m) => [m.id, m]));
      cur = {
        lines: draft.lines.filter((l) => l.component_id).map((l) => ({
          ...l, component_id: Number(l.component_id), component_code: mats.get(Number(l.component_id))?.code, component_name: mats.get(Number(l.component_id))?.name,
          scrap_rate: l.scrap_rate ?? 0, designator: l.designator || null, remark: l.remark || null,
        })),
      };
    }
    return this.diffOut(base, diffBom(await this.bomFull(tx, base.id), cur));
  }

  /** 工艺路线与上一版本的差异；draft 为未保存的编辑内容 */
  async routingDiff(id: number, baseId?: number, draft?: { operations?: Record<string, any>[] | null }) {
    const tx = this.db.client;
    const r = await tx.routing.findUnique({ where: { id } });
    if (!r) throw new NotFound('工艺路线');
    const base = baseId ? await tx.routing.findUnique({ where: { id: baseId } }) : await this.routingBase(tx, r);
    if (base && base.material_id !== r.material_id) throw new BizError('只能与同一产品的其他版本对比');
    if (!base) return this.diffOut(null, []);
    let cur: Record<string, any> = await this.routingFull(tx, id);
    if (draft?.operations) {
      const wcIds = [...new Set(draft.operations.map((o) => Number(o.work_center_id)).filter(Boolean))];
      const kpIds = [...new Set(draft.operations.map((o) => Number(o.key_part_material_id)).filter(Boolean))];
      const wcs = new Map((await tx.workCenter.findMany({ where: { id: { in: wcIds } } })).map((w) => [w.id, w.name]));
      const kps = new Map((await tx.material.findMany({ where: { id: { in: kpIds } } })).map((m) => [m.id, m.code]));
      cur = {
        operations: draft.operations.map((o) => ({
          ...o, work_center_id: o.work_center_id ?? null, key_part_material_id: o.key_part_material_id ?? null,
          work_center_name: o.work_center_id ? wcs.get(Number(o.work_center_id)) ?? null : null,
          key_part_material_code: o.key_part_material_id ? kps.get(Number(o.key_part_material_id)) ?? null : null,
          sop_no: o.sop_no || null, instructions: o.instructions || null,
          params: (o.params || []).map((p: Record<string, any>) => ({ ...p, unit: p.unit || null, param_type: p.param_type || 'NUMBER' })),
        })),
      };
    }
    return this.diffOut(base, diffRouting(await this.routingFull(tx, base.id), cur));
  }

  deleteRouting(id: number) {
    return this.db.tx(async (tx) => {
      const r = await tx.routing.findUnique({ where: { id } });
      if (!r) throw new NotFound('工艺路线');
      if (r.status !== 'DRAFT') throw new BizError('只能删除草稿');
      await tx.routing.delete({ where: { id } });
      return { ok: true };
    });
  }
}
