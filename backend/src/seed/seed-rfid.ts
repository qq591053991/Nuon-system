/**
 * RFID 基础数据：4 台演示读写器（收货台、原材料仓门、发货口、盘点手持机）与期初库存的包装标签。
 * 演示读写器的接口密钥是公开的演示值（见 docs/hardware-integration.md），正式环境请在“读写器管理”中重新生成。
 */
import type { Tx } from '../common/prisma.service';
import type { NumberingService } from '../core/numbering.service';
import { newEpc } from '../rfid/epc';
import { hashKey } from '../rfid/rfid.service';

/** 演示读写器（编码、名称、类型、用途、仓库、库内侧/绑定库位、外侧库位、方向规则、内/外天线、演示密钥） */
export const DEMO_READERS: [string, string, string, string, string | null, string | null, string | null, string, number | null, number | null, string][] = [
  ['RD-RCV-01', '收货台读写器', 'DESKTOP', 'RECEIVE', 'WH-RAW', null, null, 'NONE', null, null, 'demo-reader-key-rcv-01'],
  ['RD-GATE-RAW', '原材料仓门（通往车间）', 'GATE', 'GATE', 'WH-RAW', 'RAW-A01', 'LINE-01', 'ANTENNA', 1, 2, 'demo-reader-key-gate-raw'],
  ['RD-SHIP-01', '发货口读写器', 'DESKTOP', 'SHIP', 'WH-FG', null, null, 'NONE', null, null, 'demo-reader-key-ship-01'],
  ['RD-HH-01', '盘点手持机 #1', 'HANDHELD', 'COUNT', null, null, null, 'NONE', null, null, 'demo-reader-key-hh-01'],
];

export async function seedRfidReaders(tx: Tx) {
  const wh = new Map((await tx.warehouse.findMany()).map((w) => [w.code, w.id]));
  const loc = new Map((await tx.location.findMany()).map((l) => [l.code, l.id]));
  for (const [code, name, reader_type, purpose, w, inner, outer, mode, ia, oa, key] of DEMO_READERS) {
    if (await tx.rfidReader.findUnique({ where: { code } })) continue;
    await tx.rfidReader.create({
      data: {
        code, name, reader_type, purpose, warehouse_id: w ? wh.get(w) ?? null : null, location_id: inner ? loc.get(inner) ?? null : null,
        outside_location_id: outer ? loc.get(outer) ?? null : null, direction_mode: mode, inner_antenna: ia, outer_antenna: oa,
        key_hash: hashKey(key), key_hint: key.slice(-4), created_by: 'system',
        remark: purpose === 'GATE' ? '天线 1 = 库内侧，天线 2 = 库外侧（车间线边）；先 2 后 1 = 进库，先 1 后 2 = 出库' : null,
      },
    });
  }
}

/** 期初库存发卡：每个库存行按包装拆分（≥1000 时每 1000 一包，否则一包），绑定物料、批号、数量、货主、库位 */
export async function seedOpeningTags(tx: Tx, numbering: NumberingService, receiptId: number) {
  if (await tx.rfidTag.findFirst()) return;
  const lines = await tx.receiptLine.findMany({ where: { receipt_id: receiptId }, include: { material: true }, orderBy: { line_no: 'asc' } });
  for (const ln of lines) {
    if (ln.material.serial_control) continue;
    const n = ln.qty >= 1000 ? Math.ceil(ln.qty / 1000) : 1;
    for (let i = 0; i < n; i++) {
      const qty = n === 1 ? ln.qty : i < n - 1 ? 1000 : ln.qty - 1000 * (n - 1);
      await tx.rfidTag.create({
        data: {
          epc: await newEpc(tx, numbering, 'PACKAGE'), tag_type: 'PACKAGE', material_id: ln.material_id, lot_no: ln.lot_no, qty,
          owner_customer_id: ln.material.owner_customer_id, location_id: ln.location_id, receipt_id: receiptId, created_by: 'system',
          remark: `期初库存发卡 第 ${i + 1}/${n} 包`,
        },
      });
    }
  }
}
