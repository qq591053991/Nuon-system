/**
 * 库位建议（收货 / 上架默认库位）与“待上架”判断。
 *   suggestLocation(tx, material)  → { id, code, name, reason } | null
 *     优先级：物料默认库位 → 客供料仓 → 湿敏物料防潮柜 → 上次收货库位（且符合放置规则）→ 现有库存最多的库位 → 成品/原材料仓第一个存储库位
 */
import type { Location, Material } from '@prisma/client';
import type { Tx } from '../common/prisma.service';
import { needsDryStorage } from '../core/inventory.service';

export interface SuggestedLocation { id: number; code: string; name: string | null; reason: string }

const out = (l: Location | null | undefined, reason: string): SuggestedLocation | null =>
  l ? { id: l.id, code: l.code, name: l.name ?? null, reason } : null;

/** 某库位是否适合该物料（货主与仓库类型匹配；湿敏物料须防潮柜） */
async function fits(tx: Tx, m: Pick<Material, 'owner_customer_id' | 'msl_level'>, locId: number): Promise<Location | null> {
  const l = await tx.location.findUnique({ where: { id: locId }, include: { warehouse: true } });
  if (!l || !l.is_active) return null;
  const wt = l.warehouse?.warehouse_type;
  if (wt === 'WIP' || wt === 'REJECT') return null;
  if (m.owner_customer_id ? wt !== 'CUSTOMER' : wt === 'CUSTOMER') return null;
  if (needsDryStorage(m.msl_level) && l.location_type !== 'DRY_CABINET') return null;
  return l;
}

export async function suggestLocation(tx: Tx, m: Material): Promise<SuggestedLocation | null> {
  if (m.default_location_id) {
    const l = await tx.location.findUnique({ where: { id: m.default_location_id } });
    if (l?.is_active) return out(l, '物料默认库位');
  }
  const first = (where: any) => tx.location.findFirst({ where: { is_active: true, ...where }, orderBy: { code: 'asc' } });
  if (m.owner_customer_id) {
    const l = await first({ warehouse: { warehouse_type: 'CUSTOMER' } });
    if (l) return out(l, '客供料仓');
  }
  if (needsDryStorage(m.msl_level)) {
    const l = (await first({ location_type: 'DRY_CABINET', warehouse: { warehouse_type: m.owner_customer_id ? 'CUSTOMER' : 'RAW' } })) ?? (await first({ location_type: 'DRY_CABINET' }));
    if (l) return out(l, `湿敏物料（MSL ${m.msl_level}）放防潮柜`);
  }
  const last = await tx.receiptLine.findFirst({ where: { material_id: m.id, receipt: { receipt_type: { in: ['PURCHASE', 'CUSTOMER_SUPPLIED', 'OTHER', 'OPENING'] } } }, orderBy: { id: 'desc' } });
  if (last) {
    const l = await fits(tx, m, last.location_id);
    if (l) return out(l, '上次收货库位');
  }
  const stocks = await tx.stock.findMany({ where: { material_id: m.id, qty: { gt: 0 } }, orderBy: { qty: 'desc' }, take: 5 });
  for (const st of stocks) {
    const l = await fits(tx, m, st.location_id);
    if (l) return out(l, '现有库存所在库位');
  }
  const wt = m.owner_customer_id ? 'CUSTOMER' : m.category === 'FINISHED' ? 'FG' : 'RAW';
  return out(await first({ location_type: 'STORAGE', warehouse: { warehouse_type: wt } }), '同类仓库的存储库位');
}

/**
 * 待上架判断：合格（可选含待检）库存，位于原材料/客供/成品仓，且满足其一：
 *   ① 在“暂存”类型库位（收货暂存区）；② 放置不合规（货主与仓库不符、湿敏物料不在防潮柜）；③ 物料设置了默认库位但不在默认库位。
 * 返回原因与建议库位。
 */
export async function putawayReason(
  tx: Tx,
  st: { material: Material; location: Location & { warehouse: { warehouse_type: string } | null }; owner_customer_id: number | null },
  cache: Map<number, SuggestedLocation | null>,
): Promise<{ reason: string; suggest: SuggestedLocation | null } | null> {
  const m = st.material;
  const loc = st.location;
  const wt = loc.warehouse?.warehouse_type;
  if (wt === 'WIP' || wt === 'REJECT') return null;
  if (!cache.has(m.id)) cache.set(m.id, await suggestLocation(tx, m));
  const sug = cache.get(m.id) ?? null;
  const target = sug && sug.id !== loc.id ? sug : null;
  if (st.owner_customer_id ? wt !== 'CUSTOMER' : wt === 'CUSTOMER') {
    return { reason: st.owner_customer_id ? '客供料放在自有仓' : '自有物料放在客供料仓', suggest: target };
  }
  if (needsDryStorage(m.msl_level) && loc.location_type !== 'DRY_CABINET') return { reason: `湿敏物料（MSL ${m.msl_level}）不在防潮柜`, suggest: target };
  if (loc.location_type === 'STAGING') return { reason: '在收货暂存区', suggest: target };
  if (m.default_location_id && m.default_location_id !== loc.id) return { reason: '不在物料默认库位', suggest: target };
  return null;
}
