/**
 * 物料检验规范（IQC 检验项目，按物料维护）：
 *   GET /inspection-specs                      已维护检验规范的物料清单
 *   GET /materials/:id/inspection-items        某物料的检验规范（启用项，按序号）+ 系统默认模板（未维护时 IQC 使用默认模板）
 *   PUT /materials/:id/inspection-items        整体替换检验规范（QA/工程，电子签名“检验规范批准”）
 * 替换规则：带 id 的行更新，新行新增，未出现在列表中的旧行停用（is_active=false，保留历史，不物理删除）。
 * 变更只影响之后新建的检验单；已建检验单保留建单时的项目。
 */
import { Body, Controller, Get, Param, ParseIntPipe, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';
import type { Material } from '@prisma/client';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { BizError, NotFound } from '../common/errors';
import { serList } from '../common/paginate';
import { PrismaService, type Tx } from '../common/prisma.service';
import { EsignService, SignatureDto } from '../core/esign.service';
import { itemsFor } from './quality.service';

class SpecItemDto {
  @IsOptional() @Type(() => Number) @IsInt() id?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() seq?: number | null;
  @IsString() name: string;
  @IsOptional() @IsString() standard?: string | null;
  @IsOptional() @IsString() method?: string | null;
}

class SpecPutDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => SpecItemDto) items: SpecItemDto[];
  @IsOptional() @ValidateNested() @Type(() => SignatureDto) signature?: SignatureDto | null;
}

const MAX_ITEMS = 60;
const clean = (v: string | null | undefined) => {
  const s = (v ?? '').trim();
  return s ? s : null;
};

@Controller()
export class InspectionSpecController {
  constructor(private readonly db: PrismaService, private readonly esign: EsignService) {}

  private async view(tx: Tx, m: Material) {
    const items = await tx.materialInspectionItem.findMany({ where: { material_id: m.id, is_active: true }, orderBy: [{ seq: 'asc' }, { id: 'asc' }] });
    return {
      material_id: m.id, material_code: m.code, material_name: m.name, material_spec: m.spec, category: m.category,
      iqc_required: m.iqc_required, aql: m.aql,
      using_default: items.length === 0,
      items: serList('MaterialInspectionItem', items),
      default_items: itemsFor(m).map(([name, standard]) => ({ name, standard })),
    };
  }

  /** 已维护检验规范的物料（q 按物料编码/名称搜索） */
  @Get('inspection-specs')
  async list(@Query() q: Record<string, string>) {
    const groups = await this.db.client.materialInspectionItem.groupBy({
      by: ['material_id'], where: { is_active: true }, _count: { _all: true }, _max: { updated_at: true },
    });
    if (!groups.length) return [];
    const kw = (q.q || '').trim().toLowerCase();
    const mats = await this.db.client.material.findMany({ where: { id: { in: groups.map((g) => g.material_id) } }, orderBy: { code: 'asc' } });
    const byId = new Map(groups.map((g) => [g.material_id, g]));
    return mats
      .filter((m) => !kw || m.code.toLowerCase().includes(kw) || m.name.toLowerCase().includes(kw))
      .map((m) => ({
        material_id: m.id, material_code: m.code, material_name: m.name, material_spec: m.spec, category: m.category,
        item_count: byId.get(m.id)!._count._all, updated_at: byId.get(m.id)!._max.updated_at,
      }));
  }

  @Get('materials/:id/inspection-items')
  async get(@Param('id', ParseIntPipe) id: number) {
    const m = await this.db.client.material.findUnique({ where: { id } });
    if (!m) throw new NotFound('物料');
    return this.view(this.db.client, m);
  }

  /** 整体替换检验规范（电子签名：检验规范批准）。传空列表 = 停用全部规范项，恢复使用系统默认模板 */
  @Put('materials/:id/inspection-items')
  @Perms('qa', 'engineering')
  put(@Param('id', ParseIntPipe) id: number, @Body() b: SpecPutDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const m = await tx.material.findUnique({ where: { id } });
      if (!m) throw new NotFound('物料');
      const input = b.items ?? [];
      if (input.length > MAX_ITEMS) throw new BizError(`检验项目不能超过 ${MAX_ITEMS} 项`);
      const names = new Set<string>();
      const rows = input.map((it, i) => {
        const name = clean(it.name);
        if (!name) throw new BizError(`第 ${i + 1} 行：请填写检验项目名称`);
        if (name.length > 64) throw new BizError(`检验项目“${name.slice(0, 20)}…”名称过长（最多 64 字）`);
        if (names.has(name)) throw new BizError(`检验项目“${name}”重复`);
        names.add(name);
        const standard = clean(it.standard);
        const method = clean(it.method);
        if (standard && standard.length > 256) throw new BizError(`检验项目“${name}”的标准/要求过长（最多 256 字）`);
        if (method && method.length > 128) throw new BizError(`检验项目“${name}”的检验方法过长（最多 128 字）`);
        return { id: it.id ?? null, seq: it.seq ?? (i + 1) * 10, name, standard, method };
      });
      const current = await tx.materialInspectionItem.findMany({ where: { material_id: id, is_active: true } });
      const byId = new Map(current.map((c) => [c.id, c]));
      const kept = new Set<number>();
      for (const r of rows) {
        const cur = r.id ? byId.get(r.id) : undefined;
        if (r.id && !cur) throw new BizError(`检验项目“${r.name}”已被他人修改或停用，请刷新后重试`);
        if (cur) {
          kept.add(cur.id);
          if (cur.seq !== r.seq || cur.name !== r.name || (cur.standard ?? null) !== r.standard || (cur.method ?? null) !== r.method) {
            await tx.materialInspectionItem.update({ where: { id: cur.id }, data: { seq: r.seq, name: r.name, standard: r.standard, method: r.method } });
          }
        } else {
          await tx.materialInspectionItem.create({
            data: { material_id: id, seq: r.seq, name: r.name, standard: r.standard, method: r.method, created_by: user.username },
          });
        }
      }
      for (const c of current) {
        if (!kept.has(c.id)) await tx.materialInspectionItem.update({ where: { id: c.id }, data: { is_active: false } });
      }
      await this.esign.sign(tx, user, b.signature, '检验规范批准', 'md_material', m.id, m.code);
      return this.view(tx, m);
    });
  }
}

