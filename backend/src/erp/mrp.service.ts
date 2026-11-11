/**
 * MRP 物料需求计划：
 *   独立需求 = 已确认销售订单未发数量；
 *   成品净需求 = 毛需求 − 成品库存(合格+待放行) − 在制工单未完工数量；
 *   组件毛需求 = 父项净需求 × 单位用量 ×(1+损耗) + 在制工单未领料数量；
 *   组件净需求 = 毛需求 + 安全库存 − 库存(合格+待检) − 采购在途；
 * 按低阶码逐层展开。自制件建议“生产”，外购件建议“采购”，客供料建议“通知客户供料”。
 */
import { Injectable } from '@nestjs/common';
import type { Material, MrpSuggestion, Prisma } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { addDays, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { round, round2 } from '../common/num';
import { paginate } from '../common/paginate';
import { inc, ser } from '../common/presenter';
import { PrismaService, type Tx } from '../common/prisma.service';
import { releasedBom } from '../core/engineering';
import { NumberingService } from '../core/numbering.service';

const EPS = 1e-9;
const DISCRETE_UOM_UPPER = ['PCS', 'EA', 'SET'];
const DISCRETE_UOM_CN = ['个', '台', '只', '套', '片', '件'];

type BomWithLines = Prisma.BomGetPayload<{ include: { lines: true } }>;

const minDate = (a: Date, b: Date) => (a.getTime() <= b.getTime() ? a : b);

@Injectable()
export class MrpService {
  constructor(private readonly db: PrismaService, private readonly numbering: NumberingService) {}

  /** 低阶码：每个物料在所有已发布 BOM 中出现的最深层级 */
  private async lowLevelCodes(tx: Tx): Promise<{ llc: Map<number, number>; boms: Map<number, BomWithLines> }> {
    const rows = await tx.bom.findMany({
      where: { status: 'RELEASED' },
      orderBy: { id: 'asc' },
      include: { lines: { orderBy: { line_no: 'asc' } } },
    });
    const boms = new Map<number, BomWithLines>();
    for (const b of rows) boms.set(b.material_id, b); // 同一物料多个已发布版本时取最新
    const llc = new Map<number, number>();
    const walk = (mid: number, level: number, path: number[]) => {
      if (path.includes(mid)) throw new BizError('BOM 存在循环引用');
      llc.set(mid, Math.max(llc.get(mid) ?? 0, level));
      const b = boms.get(mid);
      if (b) for (const ln of b.lines) walk(ln.component_id, level + 1, [...path, mid]);
    };
    for (const mid of [...boms.keys()]) walk(mid, 0, []);
    return { llc, boms };
  }

  run(user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const { llc, boms } = await this.lowLevelCodes(tx);
      const gross = new Map<number, number>();
      const needDate = new Map<number, Date>();
      const addGross = (mid: number, qty: number, d: Date | null | undefined) => {
        if (qty <= EPS) return;
        gross.set(mid, (gross.get(mid) ?? 0) + qty);
        if (d && (!needDate.has(mid) || d.getTime() < needDate.get(mid)!.getTime())) needDate.set(mid, d);
      };

      // 1) 独立需求：销售订单
      const sos = await tx.salesOrder.findMany({
        where: { status: { in: ['CONFIRMED', 'IN_PRODUCTION', 'PARTIAL_SHIPPED'] } },
        orderBy: { id: 'asc' },
        include: { lines: { orderBy: { line_no: 'asc' } } },
      });
      for (const so of sos) {
        for (const ln of so.lines) addGross(ln.material_id, round(ln.qty - (ln.shipped_qty || 0)), ln.delivery_date ?? so.delivery_date);
      }

      // 2) 在制工单：未完工数量作为成品供给；未领料数量作为组件毛需求
      const wipSupply = new Map<number, number>();
      const wos = await tx.workOrder.findMany({
        where: { status: { in: ['PLANNED', 'RELEASED', 'IN_PROGRESS'] } },
        orderBy: { id: 'asc' },
        include: { materials: { orderBy: { id: 'asc' } } },
      });
      for (const wo of wos) {
        wipSupply.set(wo.material_id, (wipSupply.get(wo.material_id) ?? 0) + Math.max(wo.planned_qty - (wo.completed_qty || 0) - (wo.scrap_qty || 0), 0));
        if (wo.status === 'PLANNED' || !wo.materials.length) {
          const b = boms.get(wo.material_id);
          if (b) for (const ln of b.lines) addGross(ln.component_id, wo.planned_qty * ln.qty_per * (1 + (ln.scrap_rate || 0)), wo.planned_start);
        } else {
          for (const m of wo.materials) addGross(m.material_id, Math.max(m.required_qty - (m.issued_qty || 0), 0), wo.planned_start);
        }
      }

      // 3) 采购在途
      const onOrder = new Map<number, number>();
      const pls = await tx.purchaseOrderLine.findMany({
        where: { order: { status: { in: ['DRAFT', 'APPROVED', 'PARTIAL_RECEIVED'] } } },
        orderBy: { id: 'asc' },
      });
      for (const pl of pls) onOrder.set(pl.material_id, (onOrder.get(pl.material_id) ?? 0) + Math.max(pl.qty - (pl.received_qty || 0), 0));

      // 库存（合格 + 待检/待放行）
      const stockRows = await tx.stock.groupBy({ by: ['material_id'], where: { status: { in: ['AVAILABLE', 'QUARANTINE'] } }, _sum: { qty: true } });
      const onHand = new Map(stockRows.map((r) => [r.material_id, round(r._sum.qty ?? 0)]));

      const allMids = new Set<number>([...gross.keys(), ...llc.keys()]);
      const mats = new Map<number, Material>(
        (await tx.material.findMany({ where: { id: { in: [...allMids] } } })).map((m) => [m.id, m]),
      );
      const material = async (id: number) => {
        if (!mats.has(id)) {
          const m = await tx.material.findUnique({ where: { id } });
          if (m) mats.set(id, m);
        }
        return mats.get(id);
      };

      const t = today();
      const maxLevel = Math.max(0, ...llc.values());
      const suggestions: Prisma.MrpSuggestionUncheckedCreateWithoutRunInput[] = [];
      for (let level = 0; level <= maxLevel; level++) {
        const mids = [...allMids].filter((m) => (llc.get(m) ?? 0) === level).sort((a, b) => a - b);
        for (const mid of mids) {
          const g = round(gross.get(mid) ?? 0);
          const m = await material(mid);
          if (!m) continue;
          const stock = onHand.get(mid) ?? 0;
          const supply = stock + (onOrder.get(mid) ?? 0) + (wipSupply.get(mid) ?? 0);
          const ss = m.safety_stock || 0;
          const net = round(g + ss - supply);
          if (g <= EPS && net <= EPS) continue;
          const b = boms.get(mid);
          if (net > EPS) {
            let qty = net;
            if (DISCRETE_UOM_UPPER.includes((m.uom || '').toUpperCase()) || DISCRETE_UOM_CN.includes(m.uom)) qty = Math.ceil(net - EPS);
            if (m.min_order_qty && qty < m.min_order_qty && !b) qty = m.min_order_qty;
            let action: string;
            if (b) {
              action = 'PRODUCE';
              for (const ln of b.lines) {
                addGross(ln.component_id, net * ln.qty_per * (1 + (ln.scrap_rate || 0)), needDate.get(mid));
                allMids.add(ln.component_id);
              }
            } else if (m.owner_customer_id) {
              action = 'CUSTOMER_SUPPLY';
            } else {
              action = 'PURCHASE';
            }
            const due = addDays(needDate.get(mid) ?? t, -(m.lead_time_days || 0));
            suggestions.push({
              material_id: mid, level, action, gross_qty: g, on_hand_qty: stock,
              on_order_qty: round((onOrder.get(mid) ?? 0) + (wipSupply.get(mid) ?? 0)), safety_stock: ss, net_qty: net,
              suggested_qty: qty, due_date: due.getTime() > t.getTime() ? due : t,
              supplier_id: action === 'PURCHASE' ? m.default_supplier_id : null,
              customer_id: action === 'CUSTOMER_SUPPLY' ? m.owner_customer_id : action === 'PRODUCE' ? m.customer_id : null,
              remark: due.getTime() < t.getTime() ? '交期紧张：建议日期早于今天' : null,
            });
          }
        }
      }
      const cnt = (a: string) => suggestions.filter((s) => s.action === a).length;
      const run = await tx.mrpRun.create({
        data: {
          no: await this.numbering.nextNo(tx, 'MRP'), run_at: new Date(), run_by: user.full_name, created_by: user.username,
          summary: `生产建议 ${cnt('PRODUCE')} 条，采购建议 ${cnt('PURCHASE')} 条，客供料通知 ${cnt('CUSTOMER_SUPPLY')} 条`,
          suggestions: { create: suggestions },
        },
        include: inc('MrpRun', ['suggestions']),
      });
      return ser('MrpRun', run, ['suggestions']);
    });
  }

  runs(q: Record<string, string>) {
    return paginate(this.db.client.mrpRun, 'MrpRun', { orderBy: { id: 'desc' } }, q);
  }

  async getRun(id: number) {
    const run = await this.db.client.mrpRun.findUnique({ where: { id }, include: inc('MrpRun', ['suggestions']) });
    if (!run) throw new NotFound('MRP 运算');
    return ser('MrpRun', run, ['suggestions']);
  }

  /** 建议一键转单：采购建议按供应商合并为采购订单草稿；生产建议生成计划工单；客供料建议跳过（通知客户供料） */
  convert(ids: number[], user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const sugs = await tx.mrpSuggestion.findMany({ where: { id: { in: ids }, status: 'OPEN' }, orderBy: { id: 'asc' }, include: { material: true } });
      const createdPos: string[] = [];
      const createdWos: string[] = [];
      const skipped: string[] = [];
      const bySupplier = new Map<number, (MrpSuggestion & { material: Material })[]>();
      for (const s of sugs) {
        if (s.action === 'PURCHASE') {
          if (!s.supplier_id) {
            skipped.push(`${s.material.code}：未设置默认供应商`);
            continue;
          }
          if (!bySupplier.has(s.supplier_id)) bySupplier.set(s.supplier_id, []);
          bySupplier.get(s.supplier_id)!.push(s);
        } else if (s.action === 'PRODUCE') {
          const m = s.material;
          if (!(await releasedBom(tx, m.id))) {
            skipped.push(`${m.code}：无已发布 BOM`);
            continue;
          }
          const start = s.due_date ?? today();
          const wo = await tx.workOrder.create({
            data: {
              no: await this.numbering.nextNo(tx, 'WO'), material_id: m.id, customer_id: m.customer_id, planned_qty: s.suggested_qty,
              planned_start: start, planned_end: addDays(start, m.lead_time_days || 0), status: 'PLANNED', source: 'MRP', created_by: user.username,
            },
          });
          await tx.mrpSuggestion.update({ where: { id: s.id }, data: { status: 'CONVERTED', converted_doc_no: wo.no } });
          createdWos.push(wo.no);
        } else {
          skipped.push(`${s.material.code}：客供料，请通知客户供料`);
        }
      }
      for (const [supplierId, items] of bySupplier) {
        let total = 0;
        const lines = items.map((s, n) => {
          const price = s.material.std_cost || 0;
          total += price * s.suggested_qty;
          return { line_no: n + 1, material_id: s.material_id, qty: s.suggested_qty, unit_price: price, amount: round2(price * s.suggested_qty), expected_date: s.due_date };
        });
        const dues = items.map((s) => s.due_date).filter((d): d is Date => !!d);
        const po = await tx.purchaseOrder.create({
          data: {
            no: await this.numbering.nextNo(tx, 'PO'), supplier_id: supplierId, order_date: today(), expected_date: dues.length ? dues.reduce(minDate) : null,
            status: 'DRAFT', source: 'MRP', created_by: user.username, total_amount: round2(total), lines: { create: lines },
          },
        });
        await tx.mrpSuggestion.updateMany({ where: { id: { in: items.map((s) => s.id) } }, data: { status: 'CONVERTED', converted_doc_no: po.no } });
        createdPos.push(po.no);
      }
      return { purchase_orders: createdPos, work_orders: createdWos, skipped };
    });
  }

  ignore(id: number) {
    return this.db.tx(async (tx) => {
      const s = await tx.mrpSuggestion.findUnique({ where: { id } });
      if (!s) throw new NotFound('建议');
      const row = await tx.mrpSuggestion.update({ where: { id }, data: { status: 'IGNORED' }, include: inc('MrpSuggestion') });
      return ser('MrpSuggestion', row);
    });
  }
}
