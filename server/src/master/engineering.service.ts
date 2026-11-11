/** 工程数据业务规则：BOM / 工艺路线（受控文件：草稿可编辑 → 电子签名发布 → 发布后只能升版） */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { dateOnly, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { round } from '../common/num';
import { like, paginate } from '../common/paginate';
import { inc, ser } from '../common/presenter';
import { PrismaService, type Tx } from '../common/prisma.service';
import { releasedBom } from '../core/engineering';
import { EsignService } from '../core/esign.service';
import type { BomDto, BomLineDto, NewVersionDto, OperationDto, ReleaseDto, RoutingDto } from './engineering.dto';

const BOM_CHILDREN = ['lines'];
const ROUTING_CHILDREN = ['operations.params'];

/** 查询参数中的整数（与 Python 版 `if material_id:` 一致：空/0 视为未筛选） */
export function qInt(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new BizError(`参数格式错误：${v}`);
  return n || undefined;
}

/** 外键不存在时给出明确提示（否则会被全局过滤器误报为“已被引用”） */
function fkGuard(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') throw new BizError('数据不完整或关联数据不存在');
  throw e;
}

function bomLines(materialId: number, lines: BomLineDto[]) {
  const seen = new Set<number>();
  return lines.map((ln, i) => {
    if (ln.component_id === materialId) throw new BizError('BOM 组件不能是父项自身');
    if (seen.has(ln.component_id)) throw new BizError('同一组件在 BOM 中重复出现，请合并');
    seen.add(ln.component_id);
    return {
      line_no: (i + 1) * 10, component_id: ln.component_id, qty_per: ln.qty_per, scrap_rate: ln.scrap_rate ?? 0,
      designator: ln.designator ?? null, remark: ln.remark ?? null,
    };
  });
}

function routingOps(ops: OperationDto[]) {
  const seqs = ops.map((o) => o.seq);
  if (new Set(seqs).size !== seqs.length) throw new BizError('工序号重复');
  return [...ops]
    .sort((a, b) => a.seq - b.seq)
    .map((o) => {
      const params = o.params ?? [];
      for (const p of params) {
        if (p.lower !== null && p.lower !== undefined && p.upper !== null && p.upper !== undefined && p.lower > p.upper) {
          throw new BizError(`工序 ${o.name} 测试项 ${p.name} 下限大于上限`);
        }
      }
      return {
        seq: o.seq, code: o.code, name: o.name, op_type: o.op_type ?? 'ASSEMBLY', work_center_id: o.work_center_id ?? null,
        std_minutes: o.std_minutes ?? 0, requires_equipment: o.requires_equipment ?? false, key_part_material_id: o.key_part_material_id ?? null,
        sop_no: o.sop_no ?? null, instructions: o.instructions ?? null,
        params: { create: params.map((p) => ({ code: p.code, name: p.name, unit: p.unit ?? null, lower: p.lower ?? null, upper: p.upper ?? null, target: p.target ?? null })) },
      };
    });
}

@Injectable()
export class EngineeringService {
  constructor(private readonly db: PrismaService, private readonly esign: EsignService) {}

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
            remark: body.remark ?? null, status: 'DRAFT', created_by: user.username, lines: { create: lines },
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
        if (cur.status !== 'DRAFT') throw new BizError('已发布的 BOM 不能修改，请“升版”生成新版本（ECN 变更）');
        const lines = bomLines(cur.material_id, body.lines ?? []);
        await this.checkMaterials(tx, lines.map((l) => l.component_id));
        const b = await tx.bom.update({
          where: { id },
          data: {
            version: body.version ?? 'A0', ecn_no: body.ecn_no ?? null, effective_date: dateOnly(body.effective_date), remark: body.remark ?? null,
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

  releaseBom(id: number, body: ReleaseDto, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const b = await tx.bom.findUnique({ where: { id }, include: { material: true, lines: { orderBy: { line_no: 'asc' } } } });
      if (!b) throw new NotFound('BOM');
      if (b.status !== 'DRAFT') throw new BizError('只有草稿可以发布');
      if (!b.lines.length) throw new BizError('BOM 没有组件');
      await this.checkCycle(tx, b.material_id, b.lines.map((l) => l.component_id));
      await this.esign.sign(tx, user, body.signature, 'BOM发布批准', 'eng_bom', b.id, `${b.material.code} ${b.version}`);
      await tx.bom.updateMany({ where: { material_id: b.material_id, status: 'RELEASED' }, data: { status: 'OBSOLETE' } });
      const row = await tx.bom.update({
        where: { id },
        data: { status: 'RELEASED', released_by: user.full_name, released_at: new Date(), effective_date: b.effective_date ?? today() },
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
            operations: { create: ops },
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
        if (cur.status !== 'DRAFT') throw new BizError('已发布的工艺路线不能修改，请升版');
        const ops = routingOps(body.operations ?? []);
        const r = await tx.routing.update({
          where: { id },
          data: { version: body.version ?? 'A0', name: body.name ?? null, remark: body.remark ?? null, operations: { deleteMany: {}, create: ops } },
          include: inc('Routing', ROUTING_CHILDREN),
        });
        return ser('Routing', r, ROUTING_CHILDREN);
      })
      .catch(fkGuard);
  }

  releaseRouting(id: number, body: ReleaseDto, user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const r = await tx.routing.findUnique({ where: { id }, include: { material: true, operations: { select: { id: true } } } });
      if (!r) throw new NotFound('工艺路线');
      if (r.status !== 'DRAFT') throw new BizError('只有草稿可以发布');
      if (!r.operations.length) throw new BizError('工艺路线没有工序');
      await this.esign.sign(tx, user, body.signature, '工艺路线发布批准', 'eng_routing', r.id, `${r.material.code} ${r.version}`);
      await tx.routing.updateMany({ where: { material_id: r.material_id, status: 'RELEASED' }, data: { status: 'OBSOLETE' } });
      const row = await tx.routing.update({
        where: { id },
        data: { status: 'RELEASED', released_by: user.full_name, released_at: new Date() },
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
          operations: {
            create: r.operations.map((o) => ({
              seq: o.seq, code: o.code, name: o.name, op_type: o.op_type, work_center_id: o.work_center_id, std_minutes: o.std_minutes,
              requires_equipment: o.requires_equipment, key_part_material_id: o.key_part_material_id, sop_no: o.sop_no, instructions: o.instructions,
              params: { create: o.params.map((p) => ({ code: p.code, name: p.name, unit: p.unit, lower: p.lower, upper: p.upper, target: p.target })) },
            })),
          },
        },
        include: inc('Routing', ROUTING_CHILDREN),
      });
      return ser('Routing', nr, ROUTING_CHILDREN);
    });
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
