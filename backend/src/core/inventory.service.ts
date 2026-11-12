/** 库存核心服务：所有库存变动必须经过这里，余额与流水在同一事务内更新。 */
import { Injectable } from '@nestjs/common';
import type { Location, Stock, Warehouse } from '@prisma/client';
import { als } from '../common/context';
import { fmtDate, today } from '../common/dates';
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

/** 湿敏等级 MSL 2a 及以上（2a、3、4、5、5a、6）需存放防潮柜；MSL 1（不限）与 MSL 2（车间寿命 1 年）可放普通库位（J-STD-033） */
export const needsDryStorage = (msl?: string | null): boolean => {
  const s = String(msl ?? '').trim().toUpperCase().replace(/^MSL\s*/, '');
  return !!s && !['0', '1', '2'].includes(s);
};

/** 库位放置检查结果：errors = 后端必须拒绝；warnings = 需要操作人确认 */
export interface PlacementCheck {
  errors: string[];
  warnings: string[];
  location: (Location & { warehouse: Warehouse | null }) | null;
}

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

  /**
   * 入库（并发安全）：
   *   1) 原子“插入或锁定”：INSERT … ON CONFLICT (库存键) DO UPDATE，依赖唯一索引 wms_stock_key_uq（NULLS NOT DISTINCT，货主为空也视为同一键）。
   *      新键 → 直接插入本次数量（首次入库的生产日期/有效期/供应商等批次属性随之写入）；
   *      已存在 → 走空更新以取得行锁，并发的同批次入库在此排队，不会产生重复行。
   *   2) 已存在的行在持锁状态下用 ORM 更新数量（审计钩子自动记录 UPDATE；保留首次入库的批次属性，仅在有效期为空时补填）。
   *   原生 SQL 不经过审计钩子，因此“新插入”分支在同一事务内手工写一条与钩子格式一致的 CREATE 审计记录。
   */
  async addStock(tx: Tx, a: AddStockArgs): Promise<Stock> {
    if (!a.qty || a.qty <= 0) throw new BizError('数量必须大于 0');
    const loc = await tx.location.findUnique({ where: { id: a.location_id } });
    if (!loc || !loc.is_active) throw new BizError('库位不存在或已停用');
    const owner = a.owner_customer_id ?? null;
    const lot = a.lot_no || '';
    const qty = round(a.qty);
    // 纯日期按 'YYYY-MM-DD' 文本传入再转 date，避免会话时区影响；received_at 统一按 UTC 存储（与 Prisma 一致）
    const [hit] = await tx.$queryRaw<{ id: number; inserted: boolean }[]>`
      INSERT INTO wms_stock (material_id, location_id, lot_no, status, owner_customer_id, qty, mfg_date, expiry_date, supplier_id, supplier_lot, received_at)
      VALUES (${a.material_id}, ${a.location_id}, ${lot}, ${a.status}, ${owner}::int, ${qty}::float8,
              ${fmtDate(a.mfg_date ?? null)}::date, ${fmtDate(a.expiry_date ?? null)}::date, ${a.supplier_id ?? null}::int, ${a.supplier_lot ?? null},
              (now() AT TIME ZONE 'UTC'))
      ON CONFLICT (material_id, location_id, lot_no, status, owner_customer_id) DO UPDATE SET qty = wms_stock.qty
      RETURNING id, (xmax = 0) AS inserted`;
    let st: Stock;
    if (hit.inserted) {
      st = (await tx.stock.findUnique({ where: { id: hit.id } }))!;
      await this.auditCreate(tx, st);
    } else {
      const cur = (await tx.stock.findUnique({ where: { id: hit.id } }))!;
      st = await tx.stock.update({
        where: { id: cur.id },
        data: { qty: round((cur.qty || 0) + qty), ...(a.expiry_date && !cur.expiry_date ? { expiry_date: a.expiry_date } : {}) },
      });
    }
    if (a.log !== false) {
      await this.log(tx, a.move_type, a.material_id, a.lot_no, a.qty, a.ref, { to_location_id: a.location_id, to_status: a.status, owner_customer_id: owner });
    }
    return st;
  }

  /** 原生 SQL 新增的库存行补写审计（格式与审计钩子一致：非空标量字段，纯日期 YYYY-MM-DD，时间 ISO） */
  private async auditCreate(tx: Tx, st: Stock) {
    const user = als.getStore()?.user;
    const changes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(st)) {
      if (k === 'id' || v === null || v === undefined) continue;
      changes[k] = v instanceof Date ? (k === 'received_at' ? v.toISOString() : fmtDate(v)) : v;
    }
    await tx.auditLog.create({
      data: {
        username: user?.username ?? 'system', full_name: user?.full_name ?? '系统', entity: 'wms_stock', entity_id: st.id, action: 'CREATE',
        changes: JSON.stringify(changes),
      },
    });
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

  /**
   * 库位放置规则（收货、调拨/上架、退料、盘盈新增行共用）：
   *   - 自有物料（无货主）不能放入客供料仓；客供料不能放入自有的原材料仓/成品仓（线边仓、不合格品仓两者都可）——错误，后端拒绝；
   *   - MSL 2a 及以上的湿敏物料放入非防潮柜库位（线边、不合格品区除外）——警告，需操作人确认（收货 confirm_placement、调拨 confirm）。
   * owner_customer_id 未传时按物料主数据的货主判断。
   */
  async checkPlacement(tx: Tx, a: { material_id: number; location_id: number; owner_customer_id?: number | null }): Promise<PlacementCheck> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const loc = await tx.location.findUnique({ where: { id: a.location_id }, include: { warehouse: true } });
    const m = await tx.material.findUnique({ where: { id: a.material_id }, include: { owner_customer: true } });
    if (!m) return { errors: ['物料不存在'], warnings, location: loc };
    if (!loc || !loc.is_active) return { errors: ['库位不存在或已停用，请重扫库位'], warnings, location: loc };
    const owner = a.owner_customer_id === undefined ? m.owner_customer_id : a.owner_customer_id;
    const wtype = loc.warehouse?.warehouse_type ?? 'RAW';
    const whName = loc.warehouse?.name ?? '';
    const firstLoc = async (where: any) =>
      (await tx.location.findFirst({ where: { is_active: true, ...where }, orderBy: { code: 'asc' } }))?.code ?? null;
    /** 建议库位：物料默认库位（且仓库类型合适）→ 湿敏物料防潮柜 → 同类仓库的普通存储库位（不建议防潮柜给普通物料） */
    const altFor = async (wt: string) => {
      if (m.default_location_id) {
        const d = await tx.location.findUnique({ where: { id: m.default_location_id }, include: { warehouse: true } });
        if (d?.is_active && d.warehouse?.warehouse_type === wt) return d.code;
      }
      if (needsDryStorage(m.msl_level)) {
        const dry = await firstLoc({ location_type: 'DRY_CABINET', warehouse: { warehouse_type: wt } });
        if (dry) return dry;
      }
      return (await firstLoc({ location_type: 'STORAGE', warehouse: { warehouse_type: wt } })) ?? (await firstLoc({ warehouse: { warehouse_type: wt } }));
    };
    if (!owner && wtype === 'CUSTOMER') {
      const alt = await altFor(m.category === 'FINISHED' ? 'FG' : 'RAW');
      errors.push(`${m.code} 是公司自有物料，不能放入客供料仓库位 ${loc.code}（${whName}）。请改放自有仓库位${alt ? `，如 ${alt}` : ''}`);
    } else if (owner && (wtype === 'RAW' || wtype === 'FG')) {
      const cust = m.owner_customer_id === owner ? m.owner_customer?.name : (await tx.customer.findUnique({ where: { id: owner } }))?.name;
      const alt = await altFor('CUSTOMER');
      errors.push(`${m.code} 是客供料（货主：${cust ?? owner}），不能放入自有仓库位 ${loc.code}（${whName}）。请放客供料仓库位${alt ? `，如 ${alt}` : ''}`);
    }
    if (needsDryStorage(m.msl_level) && loc.location_type !== 'DRY_CABINET' && wtype !== 'WIP' && wtype !== 'REJECT') {
      const dry = await firstLoc({ location_type: 'DRY_CABINET' });
      warnings.push(`${m.code} 是湿敏物料（MSL ${m.msl_level}），${loc.code} 不是防潮柜，放普通库位会消耗车间寿命。建议放防潮柜${dry ? ` ${dry}` : ''}`);
    }
    return { errors, warnings, location: loc };
  }

  /** 读取并锁定某库存键的当前账面数量（无库存行 = 0），用于盘点过账按“实盘 − 当前账面”调整 */
  async lockedQty(tx: Tx, k: Key): Promise<number> {
    return (await this.find(tx, k))?.qty ?? 0;
  }

  async onHand(tx: Tx, material_id: number, statuses = ['AVAILABLE', 'QUARANTINE']): Promise<number> {
    const r = await tx.stock.aggregate({ where: { material_id, status: { in: statuses } }, _sum: { qty: true } });
    return round(r._sum.qty ?? 0);
  }
}
