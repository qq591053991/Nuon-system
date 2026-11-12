/**
 * 退供应商单接口：
 *   GET  /supplier-returns?status=PENDING&q=&supplier_id=    列表（登录用户均可查，供质量、仓管、采购待办）
 *   GET  /supplier-returns/:id                                 详情（含当前不合格库存所在库位）
 *   POST /supplier-returns/:id/ship   {remark?, carrier?}      仓管出库确认 → 扣减“不合格”库存（RETURN_SUPPLIER）
 *   POST /supplier-returns/:id/cancel {reason, signature}      QA 取消（电子签名）→ NCR 退回待处置
 */
import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { like, pageArgs, sortArg } from '../common/paginate';
import { PrismaService } from '../common/prisma.service';
import { SignatureDto } from '../core/esign.service';
import { SupplierReturnService } from './supplier-return.service';

class ShipDto {
  @IsOptional() @IsString() @MaxLength(200) remark?: string | null;
  /** 承运商/运单号 */
  @IsOptional() @IsString() @MaxLength(100) carrier?: string | null;
}

class CancelDto {
  @IsString() reason: string;
  @IsOptional() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto | null;
}

@Controller('supplier-returns')
export class SupplierReturnController {
  constructor(private readonly db: PrismaService, private readonly svc: SupplierReturnService) {}

  @Get()
  async list(@Query() q: Record<string, string>) {
    const where: any = {};
    if (q.status) where.status = { in: q.status.split(',') };
    if (q.supplier_id && Number(q.supplier_id)) where.supplier_id = Number(q.supplier_id);
    if (q.ncr_id && Number(q.ncr_id)) where.ncr_id = Number(q.ncr_id);
    if (q.q) {
      const kw = q.q.trim();
      const mats = await this.db.client.material.findMany({ where: { OR: [{ code: like(kw) }, { name: like(kw) }] }, select: { id: true }, take: 200 });
      const ncrs = await this.db.client.ncr.findMany({ where: { no: like(kw) }, select: { id: true }, take: 200 });
      where.OR = [{ no: like(kw) }, { lot_no: like(kw) }, { material_id: { in: mats.map((m) => m.id) } }, { ncr_id: { in: ncrs.map((n) => n.id) } }];
    }
    const { page, page_size, skip, take } = pageArgs(q);
    const [total, rows] = await Promise.all([
      this.db.client.supplierReturn.count({ where }),
      this.db.client.supplierReturn.findMany({ where, orderBy: sortArg('SupplierReturn', q, { id: 'desc' }), skip, take }),
    ]);
    return { items: await this.svc.enrich(this.db.client, rows), total, page, page_size };
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    const r = await this.svc.load(this.db.client, id);
    return (await this.svc.enrich(this.db.client, [r], true))[0];
  }

  /** 仓管出库确认（扣减不合格库存） */
  @Post(':id/ship')
  @Perms('wms')
  ship(@Param('id', ParseIntPipe) id: number, @Body() b: ShipDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => (await this.svc.enrich(tx, [await this.svc.ship(tx, user, id, b ?? {})], true))[0]);
  }

  /** QA 取消（电子签名“退供应商单取消”），NCR 退回待处置 */
  @Post(':id/cancel')
  @Perms('qa')
  cancel(@Param('id', ParseIntPipe) id: number, @Body() b: CancelDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => (await this.svc.enrich(tx, [await this.svc.cancel(tx, user, id, b.reason, b.signature)], true))[0]);
  }
}
