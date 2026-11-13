/**
 * 演示业务流程（移植自 backend/app/seed.py 的 seed_demo）：
 *   SO → 工单 → 领料 → 逐台过站（含一次光学不合格返工换件、一次安规不合格报废）→ 完工入库 → DHR 放行 → 发货；
 *   再生成一张部分在制的工单（留一条待处置 NCR；已完工的 2 台入库并分批放行 1 台）和一张已到货待 IQC 的采购订单。
 *   RFID 演示：成品单台标签、1 台完工待入库、1 张待过账发货单、1 张待过账领料单（BL-100 工单）、1 次待确认的仓门过门读取。
 * 每个业务步骤一个事务，并以对应操作人的身份运行（审计追踪记录真实操作人）。
 */
import { AuthService } from '../auth/auth.service';
import { als, type CurrentUser } from '../common/context';
import { addDays, today } from '../common/dates';
import { round } from '../common/num';
import type { PrismaService, Tx } from '../common/prisma.service';
import { EsignService } from '../core/esign.service';
import { InventoryService } from '../core/inventory.service';
import { NumberingService } from '../core/numbering.service';
import { nextOperation, opParams, ProductionService } from '../mes/production.service';
import { QualityService } from '../qms/quality.service';
import { WmsService } from '../wms/wms.service';
import { RfidService } from '../rfid/rfid.service';
import { DEMO_PASSWORD, type SeedContext } from './seed-base';

/** 可复现的伪随机数（mulberry32，固定种子），保证每次生成的演示测试数据一致 */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RunOpts { failAt?: number; failCode?: string; stopAfter?: number | null }

export async function seedDemo(db: PrismaService, ctx: SeedContext): Promise<void> {
  if (await db.client.workOrder.findFirst()) {
    console.log('已存在生产数据，跳过演示流程');
    return;
  }
  const inv = new InventoryService();
  const numbering = new NumberingService();
  const esign = new EsignService(new AuthService(db));
  const prod = new ProductionService(numbering, inv, esign);
  const qms = new QualityService(inv, numbering, esign);
  const wms = new WmsService(inv, numbering, qms);
  const rfid = new RfidService(numbering);

  const rand = prng(2026);
  const uniform = (a: number, b: number) => a + (b - a) * rand();
  const u: Record<string, CurrentUser> = Object.fromEntries((await db.client.user.findMany()).map((x) => [x.username, x as CurrentUser]));
  const { m, eq } = ctx;
  const sig = { password: DEMO_PASSWORD, reason: '演示数据' };
  const so = await db.client.salesOrder.findFirstOrThrow({ where: { customer_po: 'LUM-PO-26-118' }, include: { lines: { orderBy: { line_no: 'asc' } } } });
  const loc = new Map((await db.client.location.findMany()).map((l) => [l.code, l.id]));
  const t = today();

  /** 以某用户身份在一个事务中执行一步业务操作 */
  const step = <T>(user: CurrentUser, fn: (tx: Tx) => Promise<T>): Promise<T> => als.run({ user }, () => db.tx(fn));

  const valuesFor = (op: { params_json?: string | null }, failCode?: string | null) => {
    const vals: Record<string, number> = {};
    for (const p of opParams(op)) {
      const { lower: lo, upper: up, target: tg } = p;
      let v: number;
      if (lo !== null && up !== null) v = uniform(lo + (up - lo) * 0.25, up - (up - lo) * 0.25);
      else if (lo !== null) v = (tg || lo) + uniform(0, 0.5);
      else v = (up ?? 0) * uniform(0.1, 0.5);
      if (p.code === failCode) v = up !== null ? up * 1.08 : (lo || 0) * 0.9;
      vals[p.code] = round(v, 2);
    }
    return vals;
  };

  const eqFor: Record<string, number> = { TEST_OPTICAL: eq.SPEC1.id, AGING: eq.AGING.id, TEST_SAFETY: eq.HIPOT.id };

  /** 某序列号逐道工序过站，直到完工/不合格/报废或到达 stopAfter 工序 */
  const runSn = async (woId: number, sn: string, operator: CurrentUser, o: RunOpts = {}) => {
    const ops = await db.client.workOrderOperation.findMany({ where: { wo_id: woId }, orderBy: { seq: 'asc' } });
    for (;;) {
      const s = await prod.getSn(db.client, sn);
      if (['COMPLETED', 'SCRAPPED', 'NG'].includes(s.status)) return s.status;
      const op = nextOperation(ops, s);
      if (!op || (o.stopAfter && op.seq > o.stopAfter)) return s.status;
      const keyParts = op.key_part_material_id ? [{ lot_no: 'HY2609A' }] : [];
      const fc = o.failAt === op.seq && s.ng_seq === null ? o.failCode : null;
      await step(operator, (tx) =>
        prod.reportSerial(tx, operator, { sn, seq: op.seq, values: valuesFor(op, fc), equipment_id: eqFor[op.op_type] ?? null, key_parts: keyParts }),
      );
    }
  };

  const disposeOpenNcr = (sn: string, disposition: string, remark: string) =>
    step(u.qa, async (tx) => {
      const ncr = await tx.ncr.findFirstOrThrow({ where: { sn, status: 'OPEN' } });
      return qms.dispositionNcr(tx, u.qa, ncr.id, disposition, remark, sig);
    });

  const serialsOf = async (woId: number) =>
    (await db.client.serialNumber.findMany({ where: { wo_id: woId }, orderBy: { sn: 'asc' } })).map((s) => s.sn);

  const issueAll = async (woId: number) => {
    const { issue } = await step(u.wh, (tx) => wms.createIssue(tx, u.wh, woId));
    await step(u.wh, (tx) => wms.confirmIssue(tx, u.wh, issue.id));
  };

  const newWo = (qty: number, markSo: boolean) =>
    step(u.pmc, async (tx) => {
      const wo = await tx.workOrder.create({
        data: {
          no: await numbering.nextNo(tx, 'WO'), material_id: m.RL300.id, customer_id: so.customer_id, so_id: so.id,
          so_line_id: so.lines[0].id, planned_qty: qty, planned_start: t, status: 'PLANNED', source: so.no, created_by: 'pmc',
        },
      });
      if (markSo) await tx.salesOrder.update({ where: { id: so.id }, data: { status: 'IN_PRODUCTION' } });
      return prod.releaseWorkOrder(tx, wo.id, u.pmc);
    });

  // 工单 1：RL-300 × 10，完整走完
  const wo = await newWo(10, true);
  await issueAll(wo.id);
  const sns = await serialsOf(wo.id);
  for (const [i, sn] of sns.entries()) {
    const operator = i % 2 === 0 ? u.op1 : u.op2;
    if (i === 3) {
      // 光学测试辐照度超上限 → NCR → 返工后通过
      await runSn(wo.id, sn, operator, { failAt: 20, failCode: 'IRR' });
      await disposeOpenNcr(sn, 'REWORK', '更换驱动IC后重新测试');
      // 返工换件：拆下损坏的驱动 IC，从合格库存补领同型号 IC 装上（单台追溯）
      await step(operator, (tx) =>
        prod.reworkParts(tx, operator, {
          sn,
          removed: [{ material_id: m.ICDRV.id, lot_no: 'XD260830', part_sn: 'U2', remark: '驱动IC输出电流偏大' }],
          installed: [{ material_id: m.ICDRV.id, lot_no: 'XD260830', location_id: loc.get('RAW-A01')!, qty: 1, part_sn: 'U2' }],
        }),
      );
      await runSn(wo.id, sn, operator);
    } else if (i === 7) {
      // 安规测试患者漏电流超标 → 报废
      await runSn(wo.id, sn, operator, { failAt: 40, failCode: 'PAT_LK' });
      await disposeOpenNcr(sn, 'SCRAP', '绝缘结构缺陷，报废并隔离');
    } else {
      await runSn(wo.id, sn, operator);
    }
  }
  await step(u.wh, (tx) => prod.fgReceipt(tx, u.wh, wo.id, loc.get('FG-01')!));
  await step(u.qa, (tx) => prod.releaseDhr(tx, u.qa, wo.id, true, sig, 'DHR 记录完整，批准放行'));
  const sh = await step(u.sales, (tx) =>
    wms.createShipment(tx, u.sales, so.id, [{ so_line_id: so.lines[0].id, qty: 9 }], { carrier: 'DHL', tracking_no: 'DHL6620260001' }),
  );
  await step(u.wh, (tx) => wms.confirmShipment(tx, u.wh, sh.id));

  // 工单 2：RL-300 × 11，部分在制
  const wo2 = await newWo(11, false);
  await issueAll(wo2.id);
  const sns2 = await serialsOf(wo2.id);
  const stops = [60, 60, 40, 40, 30, 30, 20, 20, 10, null, null];
  for (const [i, sn] of sns2.entries()) {
    const stop = stops[i];
    if (stop) await runSn(wo2.id, sn, u.op1, { stopAfter: stop });
  }
  await runSn(wo2.id, sns2[8], u.op2, { failAt: 20, failCode: 'WL_RED', stopAfter: 20 }); // 留一条待处置 NCR
  // 已完工的 2 台先入库，QA 分批放行其中 1 台（另 1 台待放行）
  await step(u.wh, (tx) => prod.fgReceipt(tx, u.wh, wo2.id, loc.get('FG-02')!));
  await step(u.qa, (tx) => prod.releaseBatch(tx, u.qa, wo2.id, { serials: [sns2[0]], approve: true, reason: '首批急单，记录审核完整', sig }));

  // 采购：LED 补货，已到货待 IQC
  const po = await step(u.buyer, async (tx) =>
    tx.purchaseOrder.create({
      data: {
        no: await numbering.nextNo(tx, 'PO'), supplier_id: m.LED660.default_supplier_id, order_date: t, expected_date: addDays(t, 7),
        status: 'APPROVED', approved_by: '陈采购', created_by: 'buyer', total_amount: 3850,
        lines: {
          create: [
            { line_no: 1, material_id: m.LED660.id, qty: 5000, unit_price: 0.35, amount: 1750 },
            { line_no: 2, material_id: m.LED850.id, qty: 5000, unit_price: 0.42, amount: 2100 },
          ],
        },
      },
      include: { lines: { orderBy: { line_no: 'asc' } } },
    }),
  );
  await step(u.wh, (tx) =>
    wms.receive(tx, u.wh, {
      receipt_type: 'PURCHASE', po, supplier_id: po.supplier_id, delivery_note: 'JG-DN-88123',
      lines: [{
        po_line_id: po.lines[0].id, material_id: m.LED660.id, qty: 5000, location_id: loc.get('DRY-01')!,
        lot_no: 'JG2610-660C', supplier_lot: 'W2610-03', mfg_date: addDays(t, -10),
      }],
    }),
  );
  // ---------------- RFID 演示数据 ----------------
  // 工单 2 再完工 1 台（完工待入库，供“RFID 完工入库”演示）
  await runSn(wo2.id, sns2[2], u.op1);
  // 成品单台标签：两张工单已完工 / 在库 / 已发货的序列号
  await step(u.wh, (tx) => rfid.issueForSerials(tx, u.wh, { wo_id: wo.id }));
  await step(u.wh, (tx) => rfid.issueForSerials(tx, u.wh, { wo_id: wo2.id }));
  // 待过账发货单：已放行在库的 1 台（供“RFID 发货核对”演示）
  await step(u.sales, (tx) =>
    wms.createShipment(tx, u.sales, so.id, [{ so_line_id: so.lines[0].id, qty: 1, serials: [sns2[0]] }], { carrier: 'SF', remark: 'RFID 发货核对演示' }),
  );
  // 工单 3：BL-100 × 2，已下达，生成待过账领料单（供“RFID 领料核对”演示）
  const so2 = await db.client.salesOrder.findFirstOrThrow({ where: { customer_po: 'GY-2026-0931' }, include: { lines: true } });
  const wo3 = await step(u.pmc, async (tx) => {
    const w = await tx.workOrder.create({
      data: {
        no: await numbering.nextNo(tx, 'WO'), material_id: m.BL100.id, customer_id: so2.customer_id, so_id: so2.id, so_line_id: so2.lines[0].id,
        planned_qty: 2, planned_start: t, status: 'PLANNED', source: so2.no, created_by: 'pmc',
      },
    });
    await tx.salesOrder.update({ where: { id: so2.id }, data: { status: 'IN_PRODUCTION' } });
    return prod.releaseWorkOrder(tx, w.id, u.pmc);
  });
  await step(u.wh, (tx) => wms.createIssue(tx, u.wh, wo3.id));
  // 原材料仓门：一次过门读取（2 包出库到车间线边 + 1 包只被一侧天线读到），待仓管确认
  const gate = await db.client.rfidReader.findUniqueOrThrow({ where: { code: 'RD-GATE-RAW' } });
  const tagOf = (lot: string) => db.client.rfidTag.findFirstOrThrow({ where: { lot_no: lot, status: 'ACTIVE' }, orderBy: { id: 'asc' } });
  const [hu, cb, fan] = [await tagOf('JS2609U'), await tagOf('HY2609C'), await tagOf('HY2609F')];
  const now = Date.now();
  const at = (s: number) => new Date(now - 60_000 + s * 1000).toISOString();
  await step(u.wh, (tx) =>
    rfid.ingest(tx, gate, [
      { epc: hu.epc, antenna: 1, rssi: -52, ts: at(0) }, { epc: hu.epc, antenna: 2, rssi: -48, ts: at(1) },
      { epc: cb.epc, antenna: 1, rssi: -55, ts: at(0) }, { epc: cb.epc, antenna: 2, rssi: -50, ts: at(2) },
      { epc: fan.epc, antenna: 1, rssi: -66, ts: at(1) },
      { epc: 'E28068940000500A1B2C3D4E', antenna: 2, rssi: -82, ts: at(1) }, // 弱信号（隔壁货架），被过滤
    ], { source: 'SIMULATED', username: 'wh' }),
  );
  // 读写器心跳（演示：收货台、仓门、发货口刚上线；手持机未连接）
  await db.client.$executeRaw`UPDATE rfid_reader SET last_heartbeat_at = (now() AT TIME ZONE 'UTC') WHERE code IN ('RD-RCV-01', 'RD-GATE-RAW', 'RD-SHIP-01')`;
  console.log('演示业务流程已生成');
}
