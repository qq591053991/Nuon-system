/** 仓库作业接口（条码扫码作业——仓库改用 RFID 后作为兜底、库位校验、待上架、拣料、冲销、盘点辅助、发货/退货扫码、逐台完工入库）。业务规则见 ops.service.ts。 */
import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { BizError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { SignatureDto } from '../core/esign.service';
import { WmsOpsService } from './ops.service';

const int = (v?: string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const bool = (v?: string) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());

class PlacementDto {
  @Type(() => Number) @IsInt() material_id: number;
  @IsOptional() @Type(() => Number) @IsInt() location_id?: number | null;
  @IsOptional() @IsString() location_code?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() owner_customer_id?: number | null;
}

class PickDto {
  @Type(() => Number) @IsInt() line_id: number;
  @Type(() => Number) @IsNumber() @Min(0) picked_qty: number;
}

class ReplaceDto {
  @Type(() => Number) @IsInt() line_id: number;
  @Type(() => Number) @IsInt() stock_id: number;
}

class ReverseDto {
  @IsString() reason: string;
  @IsOptional() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto | null;
}

class TrackingDto {
  @IsOptional() @IsString() carrier?: string | null;
  @IsOptional() @IsString() tracking_no?: string | null;
}

class CountAddLineDto {
  @Type(() => Number) @IsInt() material_id: number;
  @Type(() => Number) @IsInt() location_id: number;
  @IsOptional() @IsString() lot_no?: string | null;
  @IsOptional() @IsString() status?: string | null;
  @Type(() => Number) @IsNumber() @Min(0) counted_qty: number;
}

class CancelDto {
  @IsOptional() @IsString() reason?: string | null;
}

class FgScanDto {
  @Type(() => Number) @IsInt() wo_id: number;
  @Type(() => Number) @IsInt() location_id: number;
  @IsArray() @IsString({ each: true }) serials: string[];
}

@Controller()
export class WmsOpsController {
  constructor(private readonly db: PrismaService, private readonly svc: WmsOpsService) {}

  // ---------- 收货 / 库位 ----------
  /** 条码收货：扫采购单号 → 未收行、物料属性、建议库位 */
  @Get('wms/receive-context')
  @Perms('wms', 'purchase')
  receiveContext(@Query('po') po: string) {
    return this.svc.receiveContext(this.db.client, po);
  }

  /** 库位校验：errors = 会被拒绝；warnings = 需确认（湿敏物料放非防潮柜） */
  @Post('wms/placement-check')
  placementCheck(@Body() b: PlacementDto) {
    return this.svc.placementCheck(this.db.client, b);
  }

  /** 物料建议库位（默认库位 → 客供料仓 → 防潮柜 → 上次收货库位 → 现有库存库位） */
  @Get('wms/suggest-location')
  suggest(@Query('material_id') materialId: string) {
    const id = int(materialId);
    if (!id) throw new BizError('缺少参数 material_id');
    return this.svc.suggest(this.db.client, id);
  }

  /** 待上架清单（include_quarantine=1 含待检） */
  @Get('wms/putaway')
  putaway(@Query() q: Record<string, string>) {
    return this.svc.putawayList(this.db.client, { warehouse_id: int(q.warehouse_id), include_quarantine: bool(q.include_quarantine), q: q.q });
  }

  /** 扫码解析：库位 / 批号 / 原厂批号 / 序列号 / 物料编码 → 库存行 */
  @Get('wms/scan')
  scan(@Query() q: Record<string, string>) {
    return this.svc.scan(this.db.client, q.code, { lot: q.lot, gtin: q.gtin });
  }

  // ---------- 拣料 ----------
  /** 已下达、仍有未领物料的工单（拣料列表为空时给出“生成领料单”入口） */
  @Get('wms/issue-candidates')
  issueCandidates() {
    return this.svc.issueCandidates(this.db.client);
  }

  /** 录入实拣数量（短缺自动从下一 FEFO 批次补足） */
  @Post('issues/:id/pick')
  @Perms('wms')
  pick(@Param('id', ParseIntPipe) id: number, @Body() b: PickDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.svc.pickLine(tx, user, id, b.line_id, b.picked_qty));
  }

  /** 扫到其他批次时替换某行批次 */
  @Post('issues/:id/replace')
  @Perms('wms')
  replace(@Param('id', ParseIntPipe) id: number, @Body() b: ReplaceDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.svc.replaceLine(tx, user, id, b.line_id, b.stock_id));
  }

  // ---------- 冲销（电子签名 + 原因） ----------
  @Post('issues/:id/reverse')
  @Perms('wms')
  reverseIssue(@Param('id', ParseIntPipe) id: number, @Body() b: ReverseDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.svc.reverseIssue(tx, user, id, b.reason, b.signature));
  }

  @Post('shipments/:id/reverse')
  @Perms('wms')
  reverseShipment(@Param('id', ParseIntPipe) id: number, @Body() b: ReverseDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.svc.reverseShipment(tx, user, id, b.reason, b.signature));
  }

  @Post('stock-counts/:id/reverse')
  @Perms('wms')
  reverseCount(@Param('id', ParseIntPipe) id: number, @Body() b: ReverseDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.svc.reverseCount(tx, user, id, b.reason, b.signature));
  }

  // ---------- 发货 / 退货 ----------
  /** 运单号补录（待过账 / 已发货） */
  @Put('shipments/:id/tracking')
  @Perms('wms', 'sales')
  tracking(@Param('id', ParseIntPipe) id: number, @Body() b: TrackingDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.svc.updateTracking(tx, user, id, b));
  }

  /** 发货扫码校验（返回 ok 或具体拒绝原因） */
  @Get('wms/serial-check')
  serialCheck(@Query() q: Record<string, string>) {
    return this.svc.serialCheck(this.db.client, q.sn, int(q.so_id));
  }

  /** 客户退货扫码：序列号 → 产品、客户、原订单、原发货单 */
  @Get('wms/rma-scan')
  rmaScan(@Query('code') code: string) {
    return this.svc.rmaScan(this.db.client, code);
  }

  // ---------- 盘点 ----------
  @Post('stock-counts/:id/add-line')
  @Perms('wms')
  addCountLine(@Param('id', ParseIntPipe) id: number, @Body() b: CountAddLineDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.svc.addCountLine(tx, user, id, b));
  }

  @Post('stock-counts/:id/cancel')
  @Perms('wms')
  cancelCount(@Param('id', ParseIntPipe) id: number, @Body() b: CancelDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.svc.cancelCount(tx, user, id, b?.reason));
  }

  // ---------- 完工入库（逐台扫码核对） ----------
  @Post('wms/fg-receipt')
  @Perms('wms', 'plan')
  fgReceipt(@Body() b: FgScanDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.svc.fgReceiptSerials(tx, user, b.wo_id, b.location_id, b.serials));
  }
}

