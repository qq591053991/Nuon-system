/** 基础数据：用户、客户、供应商、物料、BOM、工艺（含测试规格）、设备、仓库库位、期初库存、销售订单。 */
import { Prisma } from '@prisma/client';
import { DEMO_PASSWORD, DEMO_USERS } from '../auth/demo';
import { generateTempPassword, hashPassword } from '../auth/password';
import { addDays, today } from '../common/dates';
import { PrismaService, type Tx } from '../common/prisma.service';
import { InventoryService } from '../core/inventory.service';
import { NumberingService } from '../core/numbering.service';
import { makeGtin14 } from '../core/udi';

export { DEMO_PASSWORD };

const USERS = DEMO_USERS;

export interface SeedBaseOptions {
  /** 预置演示账号首次登录须修改密码（演示环境默认 false，便于体验；DEMO_FORCE_PASSWORD_CHANGE=1 或 --force-change 开启） */
  forcePasswordChange?: boolean;
}

/**
 * 生产初始化（npm run seed，无 --demo）：只建系统管理员 admin，首次登录强制修改密码。
 * 初始密码取 initialPassword（环境变量 INITIAL_ADMIN_PASSWORD），未提供则随机生成并返回（由调用方打印一次）。
 * admin 已存在时不做任何修改，返回 null。
 */
export async function seedAdmin(db: PrismaService, initialPassword?: string | null): Promise<{ username: string; password: string } | null> {
  return db.tx(async (tx: Tx) => {
    if (await tx.user.findUnique({ where: { username: 'admin' } })) return null;
    const password = initialPassword?.trim() || generateTempPassword(12);
    await tx.user.create({
      data: {
        username: 'admin', full_name: '系统管理员', roles: 'admin', department: '信息部', password_hash: hashPassword(password),
        password_changed_at: new Date(), must_change_password: true, created_by: 'system',
      },
    });
    return { username: 'admin', password };
  });
}

/** 清空所有业务表（仅测试/重置使用） */
export async function resetDatabase(db: PrismaService) {
  const tables = Prisma.dmmf.datamodel.models.map((m) => `"${m.dbName ?? m.name}"`).join(', ');
  await db.base.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

async function upsertByCode<T>(delegate: any, code: string, data: Record<string, any>): Promise<T> {
  const cur = await delegate.findUnique({ where: { code } });
  return cur ?? delegate.create({ data: { code, created_by: 'system', ...data } });
}

export interface SeedContext {
  m: Record<string, any>;
  eq: Record<string, any>;
  customers: any[];
}

/** 基础数据 + 12 个演示账号（密码均为 DEMO_PASSWORD）：演示初始化与端到端测试共用 */
export async function seedBase(db: PrismaService, opts: SeedBaseOptions = {}): Promise<SeedContext> {
  const numbering = new NumberingService();
  const inv = new InventoryService();
  return db.tx(async (tx: Tx) => {
    const t = today();
    const pwd = hashPassword(DEMO_PASSWORD);
    for (const [username, full_name, roles, department] of USERS) {
      if (!(await tx.user.findUnique({ where: { username } }))) {
        await tx.user.create({
          data: { username, full_name, roles, department, password_hash: pwd, created_by: 'system', must_change_password: !!opts.forcePasswordChange },
        });
      }
    }

    const c1: any = await upsertByCode(tx.customer, 'C001', {
      name: 'Lumina Health Inc.', short_name: 'Lumina', country: '美国', contact: 'Emily Carter', currency: 'USD',
      payment_terms_days: 60, mah_name: 'Lumina Health Inc.', quality_agreement_no: 'QA-C001-2026', quality_agreement_expiry: addDays(t, 500),
    });
    const c2: any = await upsertByCode(tx.customer, 'C002', {
      name: '光悦医疗器械（上海）有限公司', short_name: '光悦医疗', country: '中国', contact: '张经理', currency: 'CNY',
      payment_terms_days: 30, mah_name: '光悦医疗器械（上海）有限公司', quality_agreement_no: 'QA-C002-2026', quality_agreement_expiry: addDays(t, 300),
    });
    const c3: any = await upsertByCode(tx.customer, 'C003', { name: 'BrightSkin Co., Ltd.', short_name: 'BrightSkin', country: '韩国', contact: 'Kim Min-jun', currency: 'USD', payment_terms_days: 45 });

    const sup = (code: string, d: Record<string, any>) => upsertByCode<any>(tx.supplier, code, d);
    const s1 = await sup('S001', { name: '晶光半导体（厦门）有限公司', short_name: '晶光半导体', category: 'LED芯片/灯珠', status: 'QUALIFIED', qualification_expiry: addDays(t, 220) });
    const s2 = await sup('S002', { name: '鑫达电子科技有限公司', short_name: '鑫达电子', category: 'PCB/IC', status: 'QUALIFIED', qualification_expiry: addDays(t, 300) });
    const s3 = await sup('S003', { name: '恒源医用电源有限公司', short_name: '恒源电源', category: '医用电源/线材', status: 'QUALIFIED', qualification_expiry: addDays(t, 40), iso13485: true });
    const s4 = await sup('S004', { name: '精塑模具制品有限公司', short_name: '精塑模具', category: '结构件/五金', status: 'QUALIFIED', qualification_expiry: addDays(t, 365) });
    const s5 = await sup('S005', { name: '佳印包装印刷有限公司', short_name: '佳印包装', category: '包材/标签', status: 'QUALIFIED', qualification_expiry: addDays(t, 365) });
    await sup('S006', { name: '新锐光电有限公司', short_name: '新锐光电', category: 'LED芯片/灯珠', status: 'PENDING', remark: '样品评估中，未完成供应商审核' });

    const mat = (code: string, name: string, spec: string, o: Record<string, any> = {}) => {
      const { cat = 'RAW', supplier, cost = 0, ss = 0, lead = 7, ...rest } = o;
      return upsertByCode<any>(tx.material, code, {
        name, spec, category: cat, default_supplier_id: supplier?.id ?? null, std_cost: cost, safety_stock: ss, lead_time_days: lead, ...rest,
      });
    };
    const m: Record<string, any> = {};
    m.LED660 = await mat('LED-660-3030', '红光LED 660nm', '3030 0.5W 660±5nm', { supplier: s1, cost: 0.35, ss: 2000, lead: 15, aql: 0.65, wavelength_nm: '660', msl_level: '3', esd_sensitive: true, shelf_life_days: 365, min_order_qty: 1000 });
    m.LED850 = await mat('LED-850-3030', '近红外LED 850nm', '3030 0.5W 850±10nm', { supplier: s1, cost: 0.42, ss: 2000, lead: 15, aql: 0.65, wavelength_nm: '850', msl_level: '3', esd_sensitive: true, shelf_life_days: 365, min_order_qty: 1000 });
    m.LED460 = await mat('LED-460-5050', '蓝光LED 460nm', '5050 1W 460±5nm', { supplier: s1, cost: 0.55, ss: 1000, lead: 15, aql: 0.65, wavelength_nm: '460', msl_level: '3', esd_sensitive: true, shelf_life_days: 365, min_order_qty: 500 });
    m.PCBAL = await mat('PCB-AL-300', 'LED铝基板 RL-300', '300×200mm 1.6mm 铝基', { supplier: s2, cost: 18, lead: 10 });
    m.PCBBL = await mat('PCB-AL-BL100', 'LED铝基板 BL-100', '220×120mm 1.6mm 铝基', { supplier: s2, cost: 14, lead: 10 });
    m.PCBCTRL = await mat('PCB-CTRL-01', '主控板 PCBA', 'MCU+触控+定时 V1.2', { supplier: s2, cost: 26, ss: 50, lead: 12, esd_sensitive: true });
    m.ICDRV = await mat('IC-DRV-CC', '恒流驱动IC', 'SOP-8 350mA', { supplier: s2, cost: 0.8, lead: 20, esd_sensitive: true, msl_level: '2' });
    m.PSU = await mat('PSU-24V-5A', '医用电源适配器 24V/5A', 'IEC 60601-1 2xMOPP Class II', { supplier: s3, cost: 45, ss: 50, lead: 20 });
    m.FAN = await mat('FAN-6015-24V', '散热风扇', '60×60×15mm 24V 静音', { supplier: s3, cost: 6.5, lead: 10 });
    m.CBL = await mat('CBL-PWR-1.5', '电源线', '1.5m 美规/欧规可选', { supplier: s3, cost: 3.2, lead: 10, iqc_required: false });
    m.HSGU = await mat('HSG-RL300-U', '上壳 RL-300', 'PC+ABS V0 白色', { supplier: s4, cost: 12, lead: 15, aql: 1.0 });
    m.HSGD = await mat('HSG-RL300-D', '下壳 RL-300', 'PC+ABS V0 白色', { supplier: s4, cost: 10, lead: 15, aql: 1.0 });
    m.HSGBL = await mat('HSG-BL100', '灯箱外壳 BL-100', '铝合金+PC罩', { supplier: s4, cost: 85, lead: 20 });
    m.STAND = await mat('STAND-BL100', '移动支架 BL-100', '可升降 带脚轮', { supplier: s4, cost: 160, lead: 25 });
    m.SCREW = await mat('SCREW-M3X8', '螺丝 M3×8', '不锈钢 十字盘头', { supplier: s4, cost: 0.02, lead: 5, iqc_required: false, uom: 'PCS' });
    m.LBL = await mat('LBL-UDI-50X30', 'UDI标签', '50×30mm 哑银 耐刮', { cat: 'PACKAGING', supplier: s5, cost: 0.15, lead: 7, iqc_required: false });
    m.BOXBL = await mat('PKG-BL100-BOX', '包装箱 BL-100', '五层瓦楞 定制印刷', { cat: 'PACKAGING', supplier: s5, cost: 18, lead: 10 });
    m.BOXRL = await mat('PKG-RL300-BOX', '彩盒 RL-300（Lumina品牌）', '客供 品牌彩盒', { cat: 'PACKAGING', owner_customer_id: c1.id, aql: 1.0 });
    m.IFURL = await mat('PKG-RL300-IFU', '说明书 RL-300（英文）', '客供 FDA 版 IFU', { cat: 'PACKAGING', owner_customer_id: c1.id });
    m.SA_LB = await mat('SA-RL300-LB', 'LED灯板组件 RL-300', '60×660nm + 60×850nm', { cat: 'SEMI', cost: 95, lead: 3, iqc_required: false });
    m.RL300 = await mat('FG-RL300', 'LED红光治疗仪 RL-300', '660nm+850nm 面板式 120颗LED', {
      cat: 'FINISHED', cost: 420, lead: 5, iqc_required: false, serial_control: true, customer_id: c1.id, model: 'RL-300',
      registration_no: '（示例）FDA 510(k) K26XXXX', device_class: 'II', gtin: makeGtin14('697000000', '001'), sn_prefix: 'RL3',
    });
    m.BL100 = await mat('FG-BL100', '新生儿蓝光治疗仪 BL-100', '460nm LED 蓝光 带支架', {
      cat: 'FINISHED', cost: 1650, lead: 7, iqc_required: false, serial_control: true, customer_id: c2.id, model: 'BL-100',
      registration_no: '（示例）沪械注准2026209XXXX', device_class: 'II', gtin: makeGtin14('697000000', '002'), sn_prefix: 'BL1',
    });

    const wcs: Record<string, any> = {};
    for (const [code, name] of [['WC-SMT', 'SMT贴片线'], ['WC-ASM', '总装线'], ['WC-TEST', '光学测试区'], ['WC-AGING', '老化房'], ['WC-SAFE', '安规测试区'], ['WC-PACK', '包装线']]) {
      wcs[code] = await upsertByCode(tx.workCenter, code, { name });
    }
    const eq: Record<string, any> = {};
    const equip = (code: string, d: Record<string, any>) => upsertByCode<any>(tx.equipment, code, d);
    eq.SPEC1 = await equip('EQ-SPEC-01', { name: '光谱辐照度计 #1', model: 'SPR-3000', equipment_type: 'TEST', op_types: 'TEST_OPTICAL', work_center_id: wcs['WC-TEST'].id, calibration_required: true, calibration_cycle_days: 365, last_calibration_date: addDays(t, -100), next_calibration_date: addDays(t, 265) });
    eq.SPEC2 = await equip('EQ-SPEC-02', { name: '光谱辐照度计 #2（备用）', model: 'SPR-3000', equipment_type: 'TEST', op_types: 'TEST_OPTICAL', work_center_id: wcs['WC-TEST'].id, calibration_required: true, calibration_cycle_days: 365, last_calibration_date: addDays(t, -370), next_calibration_date: addDays(t, -5) });
    eq.HIPOT = await equip('EQ-SAFE-01', { name: '医用安规综合测试仪', model: 'MS-6000', equipment_type: 'TEST', op_types: 'TEST_SAFETY', work_center_id: wcs['WC-SAFE'].id, calibration_required: true, calibration_cycle_days: 365, last_calibration_date: addDays(t, -345), next_calibration_date: addDays(t, 20) });
    eq.AGING = await equip('EQ-AGING-01', { name: '智能老化架 #1', model: 'AR-48', equipment_type: 'AGING', op_types: 'AGING', work_center_id: wcs['WC-AGING'].id });
    await equip('EQ-SMT-01', { name: '高速贴片机', model: 'SM-481', equipment_type: 'PRODUCTION', work_center_id: wcs['WC-SMT'].id });

    const whDefs: [string, string, string, [string, string, string][]][] = [
      ['WH-RAW', '原材料仓', 'RAW', [['RAW-A01', '原材料 A01', 'STORAGE'], ['RAW-A02', '原材料 A02', 'STORAGE'], ['DRY-01', '防潮柜 01（MSL物料）', 'DRY_CABINET']]],
      ['WH-CS', '客供料仓', 'CUSTOMER', [['CS-01', '客供料 01', 'STORAGE']]],
      ['WH-WIP', '线边仓', 'WIP', [['LINE-01', '总装线边', 'STAGING']]],
      ['WH-FG', '成品仓', 'FG', [['FG-01', '成品 01', 'STORAGE'], ['FG-02', '成品 02', 'STORAGE']]],
      ['WH-REJ', '不合格品仓', 'REJECT', [['REJ-01', '不合格品区', 'REJECT']]],
    ];
    for (const [code, name, wtype, locs] of whDefs) {
      const wh: any = await upsertByCode(tx.warehouse, code, { name, warehouse_type: wtype });
      for (const [lc, ln, lt] of locs) await upsertByCode(tx.location, lc, { name: ln, warehouse_id: wh.id, location_type: lt });
    }
    // 湿敏（MSL 3）LED 默认放防潮柜：收货/上架时自动带出
    const dry = await tx.location.findFirst({ where: { code: 'DRY-01' } });
    if (dry) await tx.material.updateMany({ where: { id: { in: [m.LED660.id, m.LED850.id, m.LED460.id] }, default_location_id: null }, data: { default_location_id: dry.id } });

    const bom = async (parent: any, version: string, lines: [any, number, number, string | null][]) => {
      if (await tx.bom.findFirst({ where: { material_id: parent.id, version } })) return;
      await tx.bom.create({
        data: {
          material_id: parent.id, version, status: 'RELEASED', released_by: '系统初始化', ecn_no: 'ECN-INIT', effective_date: t, created_by: 'system',
          lines: { create: lines.map(([c, qty, scrap, des], i) => ({ line_no: (i + 1) * 10, component_id: c.id, qty_per: qty, scrap_rate: scrap, designator: des })) },
        },
      });
    };
    await bom(m.SA_LB, 'A0', [[m.PCBAL, 1, 0, null], [m.LED660, 60, 0.01, 'D1-D60'], [m.LED850, 60, 0.01, 'D61-D120'], [m.ICDRV, 4, 0.01, 'U1-U4']]);
    await bom(m.RL300, 'A1', [[m.SA_LB, 1, 0, null], [m.PCBCTRL, 1, 0, null], [m.PSU, 1, 0, null], [m.FAN, 2, 0, null], [m.HSGU, 1, 0, null], [m.HSGD, 1, 0, null], [m.SCREW, 12, 0.02, null], [m.CBL, 1, 0, null], [m.BOXRL, 1, 0, null], [m.IFURL, 1, 0, null], [m.LBL, 2, 0.02, null]]);
    await bom(m.BL100, 'A0', [[m.PCBBL, 1, 0, null], [m.LED460, 48, 0.01, 'D1-D48'], [m.ICDRV, 4, 0.01, null], [m.PCBCTRL, 1, 0, null], [m.PSU, 1, 0, null], [m.FAN, 1, 0, null], [m.HSGBL, 1, 0, null], [m.STAND, 1, 0, null], [m.SCREW, 16, 0.02, null], [m.BOXBL, 1, 0, null], [m.LBL, 2, 0.02, null]]);

    type P = [string, string, string | null, number | null, number | null, number | null];
    type Op = [number, string, string, string, string, boolean, any, string, P[]];
    const routing = async (prod: any, version: string, ops: Op[]) => {
      if (await tx.routing.findFirst({ where: { material_id: prod.id, version } })) return;
      const r = await tx.routing.create({ data: { material_id: prod.id, version, name: `${prod.model || prod.code} 标准工艺`, status: 'RELEASED', released_by: '系统初始化', created_by: 'system' } });
      for (const [seq, code, name, typ, wc, eqp, kp, sop, params] of ops) {
        await tx.routingOperation.create({
          data: {
            routing_id: r.id, seq, code, name, op_type: typ, work_center_id: wcs[wc].id, requires_equipment: eqp,
            key_part_material_id: kp?.id ?? null, sop_no: sop, std_minutes: 5,
            params: { create: params.map(([c, n, u, lo, up, tg]) => ({ code: c, name: n, unit: u, lower: lo, upper: up, target: tg })) },
          },
        });
      }
    };
    await routing(m.SA_LB, 'A0', [
      [10, 'SMT', 'SMT贴片+回流焊', 'SMT', 'WC-SMT', false, null, 'SOP-SMT-001', []],
      [20, 'AOI', 'AOI光学检查', 'INSPECTION', 'WC-SMT', false, null, 'SOP-SMT-002', []],
    ]);
    await routing(m.RL300, 'A1', [
      [10, 'ASM', '整机组装', 'ASSEMBLY', 'WC-ASM', false, null, 'SOP-RL300-010', []],
      [20, 'OPT', '光学性能测试', 'TEST_OPTICAL', 'WC-TEST', true, null, 'SOP-RL300-020', [
        ['WL_RED', '红光峰值波长', 'nm', 650, 670, 660], ['WL_NIR', '近红外峰值波长', 'nm', 840, 860, 850], ['IRR', '辐照度（距面板15cm）', 'mW/cm²', 40, 60, 50]]],
      [30, 'AGE', '老化测试', 'AGING', 'WC-AGING', true, null, 'SOP-RL300-030', [['AGE_H', '老化时长', 'h', 4, null, 4], ['IRR_DROP', '老化后辐照度衰减', '%', null, 5, 0]]],
      [40, 'SAFE', '安规测试', 'TEST_SAFETY', 'WC-SAFE', true, null, 'SOP-RL300-040', [
        ['HIPOT', '耐压测试漏电流（1500VAC/60s）', 'mA', null, 5, null], ['EARTH_LK', '对地漏电流', 'μA', null, 500, null], ['PAT_LK', '患者漏电流', 'μA', null, 100, null]]],
      [50, 'FQC', '终检（外观/功能/标签）', 'INSPECTION', 'WC-PACK', false, null, 'SOP-RL300-050', []],
      [60, 'PACK', '包装（绑定电源适配器批次）', 'PACKING', 'WC-PACK', false, m.PSU, 'SOP-RL300-060', []],
    ]);
    await routing(m.BL100, 'A0', [
      [10, 'ASM', '整机组装', 'ASSEMBLY', 'WC-ASM', false, null, 'SOP-BL100-010', []],
      [20, 'OPT', '光学性能测试', 'TEST_OPTICAL', 'WC-TEST', true, null, 'SOP-BL100-020', [
        ['WL_PEAK', '峰值波长', 'nm', 455, 470, 460], ['IRR_BILI', '胆红素有效辐照度', 'μW/(cm²·nm)', 30, 55, 40], ['UNIFORM', '辐照均匀度（最小/最大）', '%', 40, null, 60]]],
      [30, 'AGE', '老化测试', 'AGING', 'WC-AGING', true, null, 'SOP-BL100-030', [['AGE_H', '老化时长', 'h', 8, null, 8]]],
      [40, 'SAFE', '安规测试', 'TEST_SAFETY', 'WC-SAFE', true, null, 'SOP-BL100-040', [['HIPOT', '耐压测试漏电流（1500VAC/60s）', 'mA', null, 5, null], ['EARTH_LK', '对地漏电流', 'μA', null, 500, null]]],
      [50, 'FQC', '终检', 'INSPECTION', 'WC-PACK', false, null, 'SOP-BL100-050', []],
      [60, 'PACK', '包装', 'PACKING', 'WC-PACK', false, null, 'SOP-BL100-060', []],
    ]);

    // 期初库存（OPENING 入库，合格状态；客供料记入货主名下）
    if (!(await tx.stock.findFirst())) {
      const loc = new Map((await tx.location.findMany()).map((l) => [l.code, l.id]));
      const open: [any, string, number, string, Date | null][] = [
        [m.LED660, 'DRY-01', 3000, 'JG2609-660A', addDays(t, -60)], [m.LED850, 'DRY-01', 3000, 'JG2609-850A', addDays(t, -60)],
        [m.LED460, 'DRY-01', 1500, 'JG2608-460B', addDays(t, -90)], [m.PCBAL, 'RAW-A01', 40, 'XD260915', null],
        [m.PCBBL, 'RAW-A01', 20, 'XD260918', null], [m.PCBCTRL, 'RAW-A01', 60, 'XD260920', null], [m.ICDRV, 'RAW-A01', 400, 'XD260830', null],
        [m.PSU, 'RAW-A02', 35, 'HY2609A', null], [m.FAN, 'RAW-A02', 80, 'HY2609F', null], [m.CBL, 'RAW-A02', 100, 'HY2609C', null],
        [m.HSGU, 'RAW-A02', 50, 'JS2609U', null], [m.HSGD, 'RAW-A02', 50, 'JS2609D', null], [m.HSGBL, 'RAW-A02', 12, 'JS2609BL', null],
        [m.STAND, 'RAW-A02', 12, 'JS2609ST', null], [m.SCREW, 'RAW-A02', 3000, 'JS2609S', null], [m.LBL, 'RAW-A02', 500, 'JY2609L', null],
        [m.BOXBL, 'RAW-A02', 15, 'JY2609B', null], [m.BOXRL, 'CS-01', 40, 'LUM-BOX-2609', null], [m.IFURL, 'CS-01', 40, 'LUM-IFU-2609', null],
        [m.SA_LB, 'LINE-01', 30, 'SA260920', null],
      ];
      const rc = await tx.receipt.create({ data: { no: await numbering.nextNo(tx, 'RK'), receipt_type: 'OPENING', receipt_date: t, status: 'CONFIRMED', remark: '期初库存（系统上线）', created_by: 'admin' } });
      const ref = { ref_type: 'RECEIPT', ref_id: rc.id, ref_no: rc.no, username: 'admin', remark: '期初库存（系统上线）' };
      let i = 0;
      for (const [mm, lc, qty, lot, mfg] of open) {
        const exp = mfg && mm.shelf_life_days ? addDays(mfg, mm.shelf_life_days) : null;
        await tx.receiptLine.create({ data: { receipt_id: rc.id, line_no: ++i, material_id: mm.id, qty, lot_no: lot, location_id: loc.get(lc)!, status: 'AVAILABLE', mfg_date: mfg, expiry_date: exp } });
        await inv.addStock(tx, { material_id: mm.id, location_id: loc.get(lc)!, lot_no: lot, status: 'AVAILABLE', qty, move_type: 'OPENING', ref, owner_customer_id: mm.owner_customer_id, mfg_date: mfg, expiry_date: exp });
      }
    }

    // 销售订单
    if (!(await tx.salesOrder.findFirst())) {
      const orders: [any, any, number, number, number, string, string][] = [
        [c1, m.RL300, 20, 88.0, 20, 'CONFIRMED', 'LUM-PO-26-118'],
        [c2, m.BL100, 10, 4200.0, 25, 'CONFIRMED', 'GY-2026-0931'],
        [c1, m.RL300, 200, 86.0, 45, 'DRAFT', 'LUM-PO-26-131'],
      ];
      for (const [cust, prod, qty, price, days, status, po] of orders) {
        await tx.salesOrder.create({
          data: {
            no: await numbering.nextNo(tx, 'SO'), customer_id: cust.id, order_date: t, delivery_date: addDays(t, days), customer_po: po, status,
            currency: cust.currency, total_amount: qty * price, created_by: 'sales',
            lines: { create: [{ line_no: 1, material_id: prod.id, qty, unit_price: price, amount: qty * price, delivery_date: addDays(t, days) }] },
          },
        });
      }
    }

    // 汇率（评审 P0-3：多币别折算本位币）：1 USD = 7.10 CNY，几天前生效
    if (!(await tx.exchangeRate.findFirst({ where: { currency: 'USD' } }))) {
      await tx.exchangeRate.create({ data: { currency: 'USD', rate: 7.1, effective_date: addDays(t, -5), remark: '示例汇率（月初中间价）', created_by: 'system' } });
    }

    // 账号安全（评审 P1-11 / P0-4）：预置账号记为刚设置密码（密码有效期从此起算）；产线操作员分配工牌与工位 PIN
    await tx.user.updateMany({
      where: { username: { in: USERS.map(([u]) => u) }, created_by: 'system', auth_source: 'LOCAL', password_changed_at: null },
      data: { password_changed_at: new Date() },
    });
    for (const [username, badge, pin] of [['op1', 'E1001', '1234'], ['op2', 'E1002', '5678']]) {
      const u = await tx.user.findUnique({ where: { username } });
      if (!u || u.badge_no || u.pin_hash || (await tx.user.findUnique({ where: { badge_no: badge } }))) continue;
      await tx.user.update({ where: { id: u.id }, data: { badge_no: badge } });
      // PIN 哈希直接写库，不进入审计追踪内容
      await tx.$executeRaw`UPDATE "sys_user" SET "pin_hash" = ${hashPassword(pin)} WHERE "id" = ${u.id}`;
    }

    // 人员上岗资质（评审 P1-7）：产线操作员 op1、op2 已培训考核合格，可在全部工序（*）上岗
    for (const username of ['op1', 'op2']) {
      const u = await tx.user.findUnique({ where: { username } });
      if (!u || (await tx.qualification.findFirst({ where: { user_id: u.id, op_code: '*' } }))) continue;
      await tx.qualification.create({
        data: {
          user_id: u.id, op_code: '*', level: 'QUALIFIED', certified_at: addDays(t, -30), expires_at: addDays(t, 335),
          trainer: '赵QA', certificate: `TR-2026-${username.toUpperCase()}`, remark: '上岗培训考核合格（全部工序）', created_by: 'system',
        },
      });
    }
    return { m, eq, customers: [c1, c2, c3] };
  });
}
