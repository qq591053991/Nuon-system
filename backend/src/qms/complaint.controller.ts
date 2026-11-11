/** 客户投诉 / 不良事件接口：登记、修改、开始调查、开具 NCR、发起 CAPA、关闭（QA 电子签名“客诉关闭”）。投诉为质量记录，不提供删除。 */
import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { dateOnly } from '../common/dates';
import { NotFound } from '../common/errors';
import { like, pageArgs } from '../common/paginate';
import { PrismaService } from '../common/prisma.service';
import { SignatureDto } from '../core/esign.service';
import { ComplaintService } from './complaint.service';

const int = (v?: string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

class ComplaintCreateDto {
  @Type(() => Number) @IsInt() customer_id: number;
  @IsOptional() @IsString() received_date?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() material_id?: number | null;
  @IsOptional() @IsString() sn?: string | null;
  @IsOptional() @IsString() lot_no?: string | null;
  @IsString() description: string;
  @IsOptional() @IsBoolean() is_adverse_event?: boolean;
}

/** 修改：只更新请求中出现的字段 */
class ComplaintUpdateDto {
  @IsOptional() @Type(() => Number) @IsInt() customer_id?: number;
  @IsOptional() @IsString() received_date?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() material_id?: number | null;
  @IsOptional() @IsString() sn?: string | null;
  @IsOptional() @IsString() lot_no?: string | null;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() is_adverse_event?: boolean;
  @IsOptional() @IsString() investigation?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() capa_id?: number | null;
}

class InvestigateDto {
  @IsOptional() @IsString() investigation?: string | null;
}

class ComplaintNcrDto {
  @IsOptional() @IsString() severity?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() qty?: number | null;
}

class ComplaintCapaDto {
  @IsOptional() @IsString() title?: string | null;
}

class ComplaintCloseDto {
  @IsOptional() @IsString() investigation?: string | null;
  @IsOptional() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto | null;
}

@Controller('complaints')
export class ComplaintController {
  constructor(private readonly db: PrismaService, private readonly svc: ComplaintService) {}

  @Get()
  async list(@Query() q: Record<string, string>) {
    const where: any = {};
    if (q.q) {
      const kw = q.q.trim();
      where.OR = [{ no: like(kw) }, { sn: like(kw) }, { lot_no: like(kw) }, { description: like(kw) }];
    }
    if (q.status) where.status = { in: q.status.split(',') };
    if (int(q.customer_id)) where.customer_id = int(q.customer_id);
    if (q.is_adverse_event !== undefined && q.is_adverse_event !== '') where.is_adverse_event = ['1', 'true', 'yes'].includes(q.is_adverse_event.toLowerCase());
    const { page, page_size, skip, take } = pageArgs(q);
    const [total, rows] = await Promise.all([
      this.db.client.complaint.count({ where }),
      this.db.client.complaint.findMany({ where, orderBy: { id: 'desc' }, skip, take }),
    ]);
    return { items: await this.svc.enrich(this.db.client, rows), total, page, page_size };
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    const c = await this.db.client.complaint.findUnique({ where: { id } });
    if (!c) throw new NotFound('客户投诉');
    return (await this.svc.enrich(this.db.client, [c]))[0];
  }

  /** 登记客户投诉（销售/客服或 QA） */
  @Post()
  @Perms('qa', 'sales')
  create(@Body() b: ComplaintCreateDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const c = await this.svc.create(tx, user, { ...b, received_date: dateOnly(b.received_date) });
      return (await this.svc.enrich(tx, [c]))[0];
    });
  }

  @Put(':id')
  @Perms('qa', 'sales')
  update(@Param('id', ParseIntPipe) id: number, @Body() b: ComplaintUpdateDto) {
    return this.db.tx(async (tx) => {
      const c = await this.svc.update(tx, id, { ...b, received_date: b.received_date === undefined ? undefined : dateOnly(b.received_date) });
      return (await this.svc.enrich(tx, [c]))[0];
    });
  }

  /** 开始调查（已登记 → 调查中） */
  @Post(':id/investigate')
  @Perms('qa')
  investigate(@Param('id', ParseIntPipe) id: number, @Body() b: InvestigateDto) {
    return this.db.tx(async (tx) => (await this.svc.enrich(tx, [await this.svc.startInvestigation(tx, id, b?.investigation)]))[0]);
  }

  /** 由投诉开具 NCR（来源：客户） */
  @Post(':id/ncr')
  @Perms('qa')
  createNcr(@Param('id', ParseIntPipe) id: number, @Body() b: ComplaintNcrDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => (await this.svc.enrich(tx, [await this.svc.createNcr(tx, user, id, b ?? {})]))[0]);
  }

  /** 由投诉发起 CAPA（来源：客户投诉） */
  @Post(':id/capa')
  @Perms('qa')
  createCapa(@Param('id', ParseIntPipe) id: number, @Body() b: ComplaintCapaDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => (await this.svc.enrich(tx, [await this.svc.createCapa(tx, user, id, b ?? {})]))[0]);
  }

  /** 关闭投诉（须填写调查结论，QA 电子签名“客诉关闭”） */
  @Post(':id/close')
  @Perms('qa')
  close(@Param('id', ParseIntPipe) id: number, @Body() b: ComplaintCloseDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => (await this.svc.enrich(tx, [await this.svc.close(tx, user, id, b?.investigation, b?.signature)]))[0]);
  }
}
