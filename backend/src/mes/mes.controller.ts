/** MES 接口：生产工单、工位终端（扫码过站）、完工入库、DHR 与产品放行。 */
import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsNumber, IsObject, IsOptional, IsPositive, IsString, ValidateNested } from 'class-validator';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { dateOnly } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { inc, like, paginate, ser, serList } from '../common/paginate';
import { PrismaService, type Tx } from '../common/prisma.service';
import { AuthService } from '../auth/auth.service';
import { SignatureDto } from '../core/esign.service';
import { NumberingService } from '../core/numbering.service';
import { OP_TYPE_TEXT, ProductionService } from './production.service';

const WO_CHILDREN = ['materials', 'operations'];

class WoDto {
  @IsInt() material_id: number;
  @IsNumber() @IsPositive() planned_qty: number;
  @IsOptional() @IsInt() customer_id?: number | null;
  @IsOptional() @IsInt() so_id?: number | null;
  @IsOptional() @IsInt() so_line_id?: number | null;
  @IsOptional() @IsInt() bom_id?: number | null;
  @IsOptional() @IsInt() routing_id?: number | null;
  @IsOptional() @IsString() planned_start?: string | null;
  @IsOptional() @IsString() planned_end?: string | null;
  @IsOptional() @IsInt() priority?: number;
  @IsOptional() @IsString() remark?: string | null;
}

class KeyPartDto {
  @IsOptional() @IsString() lot_no?: string | null;
  @IsOptional() @IsString() part_sn?: string | null;
}

class ReportDto {
  @IsString() sn: string;
  /** 工位所在工序，用于防跳站校验 */
  @IsOptional() @IsInt() seq?: number | null;
  /** 可选：人工判 FAIL（如外观不良） */
  @IsOptional() @IsString() result?: string | null;
  /** 判不合格时点选的不良现象代码 */
  @IsOptional() @IsString() defect_code?: string | null;
  @IsOptional() @IsObject() values?: Record<string, number | null> = {};
  @IsOptional() @IsInt() equipment_id?: number | null;
  @IsOptional() @IsString() remark?: string | null;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => KeyPartDto) key_parts?: KeyPartDto[] = [];
}

class BatchReportDto {
  @IsInt() seq: number;
  @IsOptional() @IsNumber() good_qty?: number = 0;
  @IsOptional() @IsNumber() ng_qty?: number = 0;
  @IsOptional() @IsObject() values?: Record<string, number | null> = {};
  @IsOptional() @IsInt() equipment_id?: number | null;
  @IsOptional() @IsString() remark?: string | null;
}

class FgReceiptDto {
  @IsInt() location_id: number;
  @IsOptional() @IsNumber() qty?: number | null;
}

class DhrReleaseDto {
  @IsOptional() @IsBoolean() approve?: boolean = true;
  @IsOptional() @IsString() reason?: string | null;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto;
}

/** 分批放行：序列号产品传 serials（为空 = 全部可放行，或用 qty 取前 N 台）；批量产品传 qty（为空 = 全部可放行数量） */
class ReleaseBatchDto {
  @IsOptional() @IsArray() @IsString({ each: true }) serials?: string[] | null;
  @IsOptional() @IsNumber() @IsPositive() qty?: number | null;
  @IsOptional() @IsBoolean() approve?: boolean = true;
  @IsOptional() @IsString() reason?: string | null;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto;
}

class ReworkRemovedDto {
  @IsInt() material_id: number;
  @IsOptional() @IsString() lot_no?: string | null;
  @IsOptional() @IsString() part_sn?: string | null;
  @IsOptional() @IsString() remark?: string | null;
}

class ReworkInstalledDto {
  @IsInt() material_id: number;
  @IsString() lot_no: string;
  /** 不传 = 在该批次的合格库存中按先到期先出扣减 */
  @IsOptional() @IsInt() location_id?: number | null;
  @IsOptional() @IsNumber() @IsPositive() qty?: number | null;
  @IsOptional() @IsString() part_sn?: string | null;
  @IsOptional() @IsString() remark?: string | null;
}

class ReworkPartsDto {
  @IsString() sn: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ReworkRemovedDto) removed?: ReworkRemovedDto[] = [];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ReworkInstalledDto) installed?: ReworkInstalledDto[] = [];
  @IsOptional() @IsString() remark?: string | null;
}

class StationAuthDto {
  @IsString() password: string;
}

class StationResumeDto {
  @IsString() badge_no: string;
}

class KeyPartCheckDto {
  @IsString() sn: string;
  @IsString() lot_no: string;
}

const WO_FIELDS = ['material_id', 'planned_qty', 'customer_id', 'so_id', 'so_line_id', 'bom_id', 'routing_id', 'planned_start', 'planned_end', 'priority', 'remark'] as const;

/** 请求体 → 工单字段（只取请求中出现的字段；日期转纯日期） */
function woData(b: WoDto): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of WO_FIELDS) {
    const v = (b as any)[k];
    if (v === undefined) continue;
    out[k] = k === 'planned_start' || k === 'planned_end' ? dateOnly(v) : v;
  }
  return out;
}

@Controller()
export class MesController {
  constructor(
    private readonly db: PrismaService,
    private readonly numbering: NumberingService,
    private readonly svc: ProductionService,
    private readonly auth: AuthService,
  ) {}

  private async woOut(tx: Tx, id: number) {
    const wo = await tx.workOrder.findUnique({ where: { id }, include: inc('WorkOrder', WO_CHILDREN) });
    if (!wo) throw new NotFound('生产工单');
    return ser('WorkOrder', wo, WO_CHILDREN);
  }

  private async wo(tx: Tx, id: number) {
    const wo = await tx.workOrder.findUnique({ where: { id } });
    if (!wo) throw new NotFound('生产工单');
    return wo;
  }

  // ---------- 生产工单 ----------
  @Get('work-orders')
  async list(@Query() q: Record<string, string>) {
    const where: any = {};
    if (q.q) {
      where.OR = [{ no: like(q.q) }, { lot_no: like(q.q) }, { material: { code: like(q.q) } }, { material: { name: like(q.q) } }];
    }
    if (q.status) where.status = { in: q.status.split(',') };
    if (q.material_id) where.material_id = Number(q.material_id);
    if (q.customer_id) where.customer_id = Number(q.customer_id);
    if (q.dhr_status) where.dhr_status = q.dhr_status;
    if (q.releasable === '1' || q.releasable === 'true') {
      // 有已入库、尚未放行（也未拒绝）成品的工单（分批放行待办）
      const rows = await this.db.client.$queryRaw<{ id: number }[]>`
        SELECT w.id FROM mes_work_order w
        WHERE w.dhr_status = 'OPEN' AND w.status IN ('IN_PROGRESS', 'COMPLETED')
          AND w.received_qty - w.released_qty
              - COALESCE((SELECT SUM(r.qty) FROM mes_product_release r WHERE r.wo_id = w.id AND r.status = 'REJECTED'), 0) > 0.00001`;
      where.id = { in: rows.map((r) => r.id) };
    }
    return paginate(this.db.client.workOrder, 'WorkOrder', { where, orderBy: { id: 'desc' } }, q);
  }

  @Get('work-orders/:id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.woOut(this.db.client, id);
  }

  @Post('work-orders')
  @Perms('plan')
  create(@Body() b: WoDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const m = await tx.material.findUnique({ where: { id: b.material_id } });
      if (!m || !['FINISHED', 'SEMI'].includes(m.category)) throw new BizError('请选择成品或半成品');
      const data = woData(b);
      const wo = await tx.workOrder.create({
        data: {
          priority: 3, ...data, material_id: b.material_id, planned_qty: b.planned_qty,
          no: await this.numbering.nextNo(tx, 'WO'), status: 'PLANNED', created_by: user.username,
          customer_id: data.customer_id || m.customer_id,
        } as any,
      });
      return this.woOut(tx, wo.id);
    });
  }

  @Put('work-orders/:id')
  @Perms('plan')
  update(@Param('id', ParseIntPipe) id: number, @Body() b: WoDto) {
    return this.db.tx(async (tx) => {
      const wo = await this.wo(tx, id);
      if (wo.status !== 'PLANNED') throw new BizError('工单已下达，不能修改');
      await tx.workOrder.update({ where: { id }, data: woData(b) });
      return this.woOut(tx, id);
    });
  }

  @Post('work-orders/:id/release')
  @Perms('plan')
  release(@Param('id', ParseIntPipe) id: number, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      await this.svc.releaseWorkOrder(tx, id, user);
      return this.woOut(tx, id);
    });
  }

  @Post('work-orders/:id/cancel')
  @Perms('plan')
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.db.tx(async (tx) => {
      const wo = await tx.workOrder.findUnique({ where: { id }, include: { materials: true } });
      if (!wo) throw new NotFound('生产工单');
      if (!['PLANNED', 'RELEASED'].includes(wo.status)) throw new BizError('已开工的工单不能取消');
      if (wo.materials.some((m) => (m.issued_qty || 0) > 0)) throw new BizError('工单已领料，请先退料');
      await tx.workOrder.update({ where: { id }, data: { status: 'CANCELLED' } });
      await tx.serialNumber.updateMany({ where: { wo_id: id }, data: { status: 'SCRAPPED' } });
      return this.woOut(tx, id);
    });
  }

  @Get('work-orders/:id/serials')
  async serials(@Param('id', ParseIntPipe) id: number, @Query('status') status?: string) {
    const rows = await this.db.client.serialNumber.findMany({
      where: { wo_id: id, ...(status ? { status } : {}) }, orderBy: { sn: 'asc' }, include: { ...inc('SerialNumber'), release: true },
    });
    return rows.map((r) => ({ ...ser('SerialNumber', r), release_no: r.release?.no ?? null, release_status: r.release?.status ?? null }));
  }

  @Get('work-orders/:id/records')
  async records(@Param('id', ParseIntPipe) id: number) {
    const rows = await this.db.client.operationRecord.findMany({
      where: { wo_id: id }, orderBy: { id: 'desc' }, include: inc('OperationRecord', ['values']),
    });
    return serList('OperationRecord', rows, ['values']);
  }

  // ---------- 工位终端 ----------
  /** 扫码：op = 本工位锁定的工序编码（返回 station 判定：能否在本工位作业、应送往哪道工序） */
  @Get('mes/scan/:sn')
  scan(@Param('sn') sn: string, @Query('op') op?: string) {
    return this.svc.scanSerial(this.db.client, sn, op || null);
  }

  /** 工位工序清单（已发布工艺路线中的工序，按工序编码汇总），供班组长设定本工位工序 */
  @Get('mes/station/ops')
  async stationOps() {
    const rows = await this.db.client.routingOperation.findMany({
      where: { routing: { status: 'RELEASED' } },
      include: { routing: { include: { material: true } }, work_center: true, params: { select: { id: true } } },
      orderBy: [{ seq: 'asc' }, { id: 'asc' }],
    });
    const out = new Map<string, Record<string, any>>();
    for (const o of rows) {
      const k = o.code.toUpperCase();
      let r = out.get(k);
      if (!r) {
        r = {
          code: o.code, name: o.name, seq: o.seq, op_type: o.op_type, op_type_text: OP_TYPE_TEXT[o.op_type] ?? o.op_type,
          work_center_id: o.work_center_id, work_center_name: o.work_center?.name ?? null, requires_equipment: o.requires_equipment,
          has_params: false, products: [] as string[],
        };
        out.set(k, r);
      }
      r.requires_equipment ||= o.requires_equipment;
      r.has_params ||= o.params.length > 0;
      if (!r.products.includes(o.routing.material.code)) r.products.push(o.routing.material.code);
    }
    return [...out.values()];
  }

  /** 工位可选设备：逐台标注能否用于该工序（停用 / 校准过期 / 不适用本工序 → 工位置灰并说明原因） */
  @Get('mes/station/equipment')
  async stationEquipment(@Query('op_type') opType?: string, @Query('work_center_id') wc?: string, @Query('op_name') opName?: string) {
    const rows = await this.db.client.equipment.findMany({ orderBy: { code: 'asc' }, include: { work_center: true } });
    const op = opType ? { name: opName || OP_TYPE_TEXT[opType] || opType, op_type: opType, work_center_id: wc ? Number(wc) || null : null } : null;
    return rows.map((e) => ({
      id: e.id, code: e.code, name: e.name, model: e.model, equipment_type: e.equipment_type, op_types: e.op_types, status: e.status,
      work_center_id: e.work_center_id, work_center_name: e.work_center?.name ?? null, calibration_required: e.calibration_required,
      next_calibration_date: e.next_calibration_date, issue: this.svc.equipmentIssue(e, op)?.replace(`设备 ${e.code} ${e.name} `, '') ?? null,
    }));
  }

  /** 终端账号授权（退出工位终端 / 终端设置 / 设定本工位工序）：校验当前登录的终端账号密码（班组长掌握） */
  @Post('mes/station/authorize')
  async stationAuthorize(@Body() b: StationAuthDto, @User() user: CurrentUser) {
    const v = await this.auth.verifyUserPassword(user, b.password || '');
    if (!v.ok) throw new BizError(`密码错误：请输入本工位终端登录账号（${user.full_name}）的密码，由班组长或管理员输入`);
    return { ok: true, username: user.username, full_name: user.full_name };
  }

  /** 空闲锁定后本人刷工牌恢复（同一班次免 PIN、保留未提交数据）：工牌须属于当前操作员 */
  @Post('mes/station/resume')
  @Perms('mes')
  async stationResume(@Body() b: StationResumeDto, @User() user: CurrentUser) {
    const u = await this.db.client.user.findUnique({ where: { id: user.id } });
    if (!u || !u.is_active) throw new BizError('账号已停用，请联系班组长');
    if (!u.badge_no || u.badge_no.trim() !== (b.badge_no || '').trim()) throw new BizError('不是锁定前的操作员，请输入 PIN 登录');
    return { ok: true };
  }

  /** 上岗资质预检（解锁时按本工位工序校验，F14） */
  @Get('mes/station/qualification')
  @Perms('mes')
  async stationQualification(@Query('op_code') code: string | undefined, @User() user: CurrentUser) {
    if (!code) return { ok: true, message: null };
    const op = await this.db.client.routingOperation.findFirst({ where: { code, routing: { status: 'RELEASED' } } });
    try {
      await this.svc.checkQualification(this.db.client, user, { code, name: op?.name ?? code });
      return { ok: true, message: null };
    } catch (e) {
      if (e instanceof BizError) return { ok: false, message: (e.getResponse() as { detail?: string }).detail ?? '资质校验未通过' };
      throw e;
    }
  }

  /** 关键件批号即时校验（扫码当场提示，F15） */
  @Post('mes/station/key-part-check')
  @Perms('mes')
  keyPartCheck(@Body() b: KeyPartCheckDto) {
    return this.svc.checkKeyPart(this.db.client, b.sn, b.lot_no);
  }

  @Post('mes/report')
  @Perms('mes')
  report(@Body() b: ReportDto, @User() user: CurrentUser) {
    return this.db.tx((tx) =>
      this.svc.reportSerial(tx, user, {
        sn: b.sn, seq: b.seq, result: b.result, defect_code: b.defect_code, values: b.values, equipment_id: b.equipment_id, remark: b.remark, key_parts: b.key_parts,
      }),
    );
  }

  /** 返工换件登记：拆下/装上零件（装上件从合格库存补领，流水 REWORK_ISSUE 关联 NCR） */
  @Post('mes/rework-parts')
  @Perms('mes')
  reworkParts(@Body() b: ReworkPartsDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.svc.reworkParts(tx, user, { sn: b.sn, removed: b.removed, installed: b.installed, remark: b.remark }));
  }

  @Post('work-orders/:id/report-batch')
  @Perms('mes')
  reportBatch(@Param('id', ParseIntPipe) id: number, @Body() b: BatchReportDto, @User() user: CurrentUser) {
    return this.db.tx((tx) =>
      this.svc.reportBatch(tx, user, id, {
        seq: b.seq, good_qty: b.good_qty, ng_qty: b.ng_qty, values: b.values, equipment_id: b.equipment_id, remark: b.remark,
      }),
    );
  }

  @Post('work-orders/:id/fg-receipt')
  @Perms('wms', 'plan')
  fgReceipt(@Param('id', ParseIntPipe) id: number, @Body() b: FgReceiptDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const rcId = await this.svc.fgReceipt(tx, user, id, b.location_id, b.qty);
      const rc = await tx.receipt.findUniqueOrThrow({ where: { id: rcId }, include: inc('Receipt', ['lines']) });
      return ser('Receipt', rc, ['lines']);
    });
  }

  // ---------- DHR 与放行 ----------
  @Get('work-orders/:id/dhr')
  dhr(@Param('id', ParseIntPipe) id: number) {
    return this.svc.buildDhr(this.db.client, id);
  }

  @Post('work-orders/:id/dhr/release')
  @Perms('qa')
  dhrRelease(@Param('id', ParseIntPipe) id: number, @Body() b: DhrReleaseDto, @User() user: CurrentUser) {
    if (b.signature && b.reason && !b.signature.reason) b.signature.reason = b.reason;
    return this.db.tx(async (tx) => {
      await this.svc.releaseDhr(tx, user, id, b.approve !== false, b.signature, b.reason);
      return this.woOut(tx, id);
    });
  }

  /** 放行批记录（分批放行 / 整单放行 / 拒绝），含序列号清单 */
  @Get('work-orders/:id/releases')
  async releases(@Param('id', ParseIntPipe) id: number) {
    await this.wo(this.db.client, id);
    return (await this.svc.releaseList(this.db.client, id)).map((r) => ({ ...ser('ProductRelease', r), sn_list: r.sn_list }));
  }

  /** 放行概况：已入库 / 已放行 / 已拒绝 / 可放行数量与可放行序列号 */
  @Get('work-orders/:id/releasable')
  releasable(@Param('id', ParseIntPipe) id: number) {
    return this.svc.releaseSummary(this.db.client, id);
  }

  /** DHR 分批放行（QA 电子签名“产品放行（分批）”） */
  @Post('work-orders/:id/releases')
  @Perms('qa')
  releaseBatch(@Param('id', ParseIntPipe) id: number, @Body() b: ReleaseBatchDto, @User() user: CurrentUser) {
    if (b.signature && b.reason && !b.signature.reason) b.signature.reason = b.reason;
    return this.db.tx(async (tx) => {
      const r = await this.svc.releaseBatch(tx, user, id, { serials: b.serials, qty: b.qty, approve: b.approve !== false, reason: b.reason, sig: b.signature });
      const rel = await tx.productRelease.findUniqueOrThrow({ where: { id: r.release.id }, include: inc('ProductRelease') });
      return { ...r, release: { ...ser('ProductRelease', rel), sn_list: r.release.sn_list } };
    });
  }
}
