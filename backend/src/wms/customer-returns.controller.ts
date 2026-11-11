/** 客户退货（RMA）接口：登记（冻结入库 + 自动开 NCR）、列表、详情、关闭（按 NCR 处置执行，QA 电子签名）。 */
import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, IsOptional, IsPositive, IsString, ValidateNested } from 'class-validator';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { dateOnly } from '../common/dates';
import { NotFound } from '../common/errors';
import { inc, like, pageArgs } from '../common/paginate';
import { PrismaService } from '../common/prisma.service';
import { SignatureDto } from '../core/esign.service';
import { CustomerReturnsService } from './customer-returns.service';

const int = (v?: string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

class RmaLineDto {
  @Type(() => Number) @IsInt() material_id: number;
  @IsOptional() @IsString() sn?: string | null;
  @IsOptional() @IsString() lot_no?: string | null;
  @Type(() => Number) @IsNumber() @IsPositive() qty: number;
  @Type(() => Number) @IsInt() location_id: number;
}

class RmaDto {
  @Type(() => Number) @IsInt() customer_id: number;
  @IsOptional() @Type(() => Number) @IsInt() so_id?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() shipment_id?: number | null;
  @IsString() reason: string;
  @IsOptional() @IsString() return_date?: string | null;
  @IsOptional() @IsString() remark?: string | null;
  @IsArray() @ValidateNested({ each: true }) @Type(() => RmaLineDto) lines: RmaLineDto[];
}

class RmaCloseDto {
  @IsOptional() @Type(() => Number) @IsInt() location_id?: number | null;
  @IsOptional() @IsString() remark?: string | null;
  @IsOptional() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto | null;
}

@Controller('customer-returns')
export class CustomerReturnsController {
  constructor(private readonly db: PrismaService, private readonly svc: CustomerReturnsService) {}

  @Get()
  async list(@Query() q: Record<string, string>) {
    const where: any = {};
    if (q.q) {
      const kw = q.q.trim();
      where.OR = [{ no: like(kw) }, { reason: like(kw) }, { lines: { some: { OR: [{ sn: like(kw) }, { lot_no: like(kw) }] } } }];
    }
    if (q.status) where.status = { in: q.status.split(',') };
    if (int(q.customer_id)) where.customer_id = int(q.customer_id);
    const { page, page_size, skip, take } = pageArgs(q);
    const [total, rows] = await Promise.all([
      this.db.client.customerReturn.count({ where }),
      this.db.client.customerReturn.findMany({ where, orderBy: { id: 'desc' }, skip, take, include: inc('CustomerReturn', ['lines']) }),
    ]);
    return { items: await this.svc.enrich(this.db.client, rows), total, page, page_size };
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    const r = await this.db.client.customerReturn.findUnique({ where: { id }, include: inc('CustomerReturn', ['lines']) });
    if (!r) throw new NotFound('客户退货单');
    return (await this.svc.enrich(this.db.client, [r]))[0];
  }

  /** 登记客户退货：退货品冻结入库、序列号转“客户退回”、自动开具 NCR */
  @Post()
  @Perms('wms', 'qa')
  create(@Body() b: RmaDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const r = await this.svc.create(tx, user, {
        customer_id: b.customer_id, so_id: b.so_id, shipment_id: b.shipment_id, reason: b.reason, remark: b.remark,
        return_date: dateOnly(b.return_date), lines: b.lines,
      });
      return (await this.svc.enrich(tx, [r]))[0];
    });
  }

  /** 关闭退货单（QA 电子签名）：按 NCR 处置执行冻结库存（报废/返还客户/转合格） */
  @Post(':id/close')
  @Perms('qa')
  close(@Param('id', ParseIntPipe) id: number, @Body() b: RmaCloseDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const r = await this.svc.close(tx, user, id, { location_id: b.location_id, remark: b.remark, sig: b.signature });
      return (await this.svc.enrich(tx, [r]))[0];
    });
  }
}
