/** 库存核心服务：所有库存变动必须经过这里，余额与流水在同一事务内更新。 */
import { Injectable } from '@nestjs/common';
import type { Stock } from '@prisma/client';
import { today } from '../common/dates';
import { BizError } from '../common/errors';
import { EPS, g, round } from '../common/num';
import type { Tx } from '../common/prisma.service';

export const STATUS_TEXT: Record<string, string> = { QUARANTINE: '待检/待放行', AVAILABLE: '合格', REJECTED: '不合格', HOLD: '冻结' };

export interface Ref {
  ref_type?: string | null;
  ref_id?: number | null;
  ref_no?: string | null;
  username?: string | null;
  remark?: string | null;
}

interface Key { material_id: number; location_id: number; lot_no: string; status: string; owner_customer_id?: number | null }

export interface AddStockArgs extends Key {
  qty: number;
  move_type: string;
  ref: Ref;
  mfg_date?: Date | null;
  expiry_date?: Date | null;
  supplier_id?: number | null;
  supplier_lot?: string | null;
  log?: boolean;
}

export interface RemoveStockArgs extends Key { qty: number; move_type: string; ref: Ref; log?: boolean }

@Injectable()
export class InventoryService {
  /** 查找并锁定库存行（SELECT ... FOR UPDATE） */
  private async find(tx: Tx, k: Key): Promise<Stock | null> {
    const rows = await tx.$queryRaw<{ id: number }[]>`
      SELECT id FROM wms_stock
      WHERE material_id = ${k.material_id} AND location_id = ${k.location_id} AND lot_no = ${k.lot_no || ''}
        AND status = ${k.status} AND owner_customer_id IS NOT DISTINCT FROM ${k.owner_customer_id ?? null}::int
      ORDER BY id LIMIT 1 FOR UPDATE`;
    return rows.length ? tx.stock.findUnique({ where: { id: rows[0].id } }) : null;
  }

  private async log(tx: Tx, move_type: string, material_id: number, lot_no: string, qty: number, ref: Ref, extra: {
    from_location_id?: number | null; to_location_id?: number | null; from_status?: string | null; to_status?: string | null; owner_customer_id?: number | null;
  }) {
    await tx.stockMove.create({
      data: {
        move_type, material_id, lot_no: lot_no || '', qty, ...extra,
        ref_type: ref.ref_type ?? null, ref_id: ref.ref_id ?? null, ref_no: ref.ref_no ?? null,
        username: ref.username ?? null, remark: ref.remark ?? null,
      },
    });
  }

  async addStock(tx: Tx, a: AddStockArgs): Promise<Stock> {
    if (!a.qty || a.qty <= 0) throw new BizError('数量必须大于 0');
    const loc = await tx.location.findUnique({ where: { id: a.location_id } });
    if (!loc || !loc.is_active) throw new BizError('库位不存在或已停用');
    const owner = a.owner_customer_id ?? null;
    let st = await this.find(tx, a);
    if (!st) {
      st = await tx.stock.create({
        data: {
          material_id: a.material_id, location_id: a.location_id, lot_no: a.lot_no || '', status: a.status,
          owner_customer_id: owner, qty: 0, mfg_date: a.mfg_date ?? null, expiry_date: a.expiry_date ?? null,
          supplier_id: a.supplier_id ?? null, supplier_lot: a.supplier_lot ?? null, received_at: new Date(),
        },
      });
    }
    st = await tx.stock.update({
      where: { id: st.id },
      data: { qty: round((st.qty || 0) + a.qty), ...(a.expiry_date && !st.expiry_date ? { expiry_date: a.expiry_date } : {}) },
    });
    if (a.log !== false) {
      await this.log(tx, a.move_type, a.material_id, a.lot_no, a.qty, a.ref, { to_location_id: a.location_id, to_status: a.status, owner_customer_id: owner });
    }
    return st;
  }

  async removeStock(tx: Tx, a: RemoveStockArgs): Promise<Stock> {
    if (!a.qty || a.qty <= 0) throw new BizError('数量必须大于 0');
    const owner = a.owner_customer_id ?? null;
    const st = await this.find(tx, a);
    const have = st?.qty ?? 0;
    if (have + EPS < a.qty) {
      const m = await tx.material.findUnique({ where: { id: a.material_id } });
      const loc = await tx.location.findUnique({ where: { id: a.location_id } });
      throw new BizError(
        `库存不足：${m?.code ?? a.material_id} 批次[${a.lot_no || '-'}] 库位[${loc?.code ?? a.location_id}] ` +
          `${STATUS_TEXT[a.status] ?? a.status}库存 ${g(have)}，需要 ${g(a.qty)}`,
      );
    }
    const left = round(st!.qty - a.qty);
    if (a.log !== false) {
      await this.log(tx, a.move_type, a.material_id, a.lot_no, a.qty, a.ref, { from_location_id: a.location_id, from_status: a.status, owner_customer_id: owner });
    }
    if (left <= EPS) {
      await tx.stock.delete({ where: { id: st!.id } });
      return { ...st!, qty: 0 };
    }
    return tx.stock.update({ where: { id: st!.id }, data: { qty: left } });
  }

  /** 库位间移动 和/或 质量状态变更（如 待检→合格），保留批次属性 */
  async moveStock(tx: Tx, a: {
    material_id: number; lot_no: string; qty: number; from_location_id: number; to_location_id: number;
    from_status: string; to_status: string; move_type: string; ref: Ref; owner_customer_id?: number | null;
  }): Promise<Stock> {
    const owner = a.owner_customer_id ?? null;
    const src = await this.find(tx, { material_id: a.material_id, location_id: a.from_location_id, lot_no: a.lot_no, status: a.from_status, owner_customer_id: owner });
    const attrs = src ? { mfg_date: src.mfg_date, expiry_date: src.expiry_date, supplier_id: src.supplier_id, supplier_lot: src.supplier_lot } : {};
    await this.removeStock(tx, { material_id: a.material_id, location_id: a.from_location_id, lot_no: a.lot_no, status: a.from_status, qty: a.qty, move_type: a.move_type, ref: a.ref, owner_customer_id: owner, log: false });
    const dst = await this.addStock(tx, { material_id: a.material_id, location_id: a.to_location_id, lot_no: a.lot_no, status: a.to_status, qty: a.qty, move_type: a.move_type, ref: a.ref, owner_customer_id: owner, log: false, ...attrs });
    await this.log(tx, a.move_type, a.material_id, a.lot_no, a.qty, a.ref, {
      from_location_id: a.from_location_id, to_location_id: a.to_location_id, from_status: a.from_status, to_status: a.to_status, owner_customer_id: owner,
    });
    return dst;
  }

  /** 把某批次在所有(或指定)库位上的某状态库存整体转为另一状态，返回转换数量 */
  async changeLotStatus(tx: Tx, a: {
    material_id: number; lot_no: string; from_status: string; to_status: string; move_type: string; ref: Ref;
    owner_customer_id?: number | null; location_id?: number | null;
  }): Promise<number> {
    const rows = await tx.stock.findMany({
      where: {
        material_id: a.material_id, lot_no: a.lot_no || '', status: a.from_status,
        owner_customer_id: a.owner_customer_id ?? null, ...(a.location_id ? { location_id: a.location_id } : {}),
      },
      orderBy: { id: 'asc' },
    });
    let total = 0;
    for (const st of rows) {
      if (st.qty <= EPS) continue;
      await this.moveStock(tx, {
        material_id: a.material_id, lot_no: a.lot_no, qty: st.qty, from_location_id: st.location_id, to_location_id: st.location_id,
        from_status: a.from_status, to_status: a.to_status, move_type: a.move_type, ref: a.ref, owner_customer_id: a.owner_customer_id,
      });
      total += st.qty;
    }
    return round(total);
  }

  /** 可用（合格）库存，按 FEFO（先到期先出）→ FIFO（先入先出）排序；过期、不合格品区库存不可用 */
  async availableLots(tx: Tx, material_id: number, owner_customer_id: number | null = null, allowOwn = true) {
    const stocks = await tx.stock.findMany({
      where: { material_id, status: 'AVAILABLE', qty: { gt: EPS } },
      include: { location: true },
    });
    const t = today().getTime();
    const far = Date.UTC(9999, 11, 31);
    return stocks
      .filter((s) => (s.owner_customer_id === null ? allowOwn : s.owner_customer_id === owner_customer_id))
      .filter((s) => s.location.location_type !== 'REJECT')
      .filter((s) => !s.expiry_date || s.expiry_date.getTime() >= t)
      .sort((a, b) =>
        (a.expiry_date?.getTime() ?? far) - (b.expiry_date?.getTime() ?? far) ||
        (a.received_at?.getTime() ?? 0) - (b.received_at?.getTime() ?? 0) || a.id - b.id);
  }

  /** 按 FEFO 分配。客供料只分配该客户货主库存；自购料只分配公司自有库存。返回 [库存行, 数量] 与未满足数量 */
  async allocate(tx: Tx, material_id: number, qty: number): Promise<{ alloc: [Stock, number][]; short: number }> {
    const m = await tx.material.findUnique({ where: { id: material_id } });
    const lots = m?.owner_customer_id
      ? await this.availableLots(tx, material_id, m.owner_customer_id, false)
      : await this.availableLots(tx, material_id, null, true);
    const alloc: [Stock, number][] = [];
    let remain = qty;
    for (const s of lots) {
      if (remain <= EPS) break;
      const take = Math.min(s.qty, remain);
      alloc.push([s, round(take)]);
      remain = round(remain - take);
    }
    return { alloc, short: Math.max(remain, 0) };
  }

  async onHand(tx: Tx, material_id: number, statuses = ['AVAILABLE', 'QUARANTINE']): Promise<number> {
    const r = await tx.stock.aggregate({ where: { material_id, status: { in: statuses } }, _sum: { qty: true } });
    return round(r._sum.qty ?? 0);
  }
}
