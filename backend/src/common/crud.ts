/** 通用 CRUD 控制器工厂：主数据（客户、供应商、物料、设备、仓库库位…）统一的增删改查、搜索、分页、筛选。
 *  请求体按 Prisma 模型字段自动校验（类型、必填），未知字段忽略。 */
import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query, type Type } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Perms, User } from '../auth';
import type { CurrentUser } from './context';
import { dateOnly } from './dates';
import { BizError, NotFound } from './errors';
import { like, paginate } from './paginate';
import { inc, ser } from './presenter';
import { PrismaService, type Tx } from './prisma.service';

const MODELS = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
const SKIP = new Set(['id', 'created_at', 'updated_at', 'created_by']);

function coerce(model: string, body: Record<string, any>, creating: boolean, label: string): Record<string, any> {
  const out: Record<string, any> = {};
  for (const f of MODELS.get(model)!.fields) {
    if (f.kind !== 'scalar' || SKIP.has(f.name)) continue;
    let v = body?.[f.name];
    if (v === undefined || (creating && v === null)) {
      if (creating && f.isRequired && !f.hasDefaultValue) throw new BizError(`${label}：请填写字段 ${f.name}`);
      continue;
    }
    if (v === null) {
      if (f.isRequired) throw new BizError(`${label}：字段 ${f.name} 不能为空`);
      out[f.name] = null;
      continue;
    }
    switch (f.type) {
      case 'String': v = String(v); break;
      case 'Int':
        if (!Number.isInteger(Number(v))) throw new BizError(`字段 ${f.name} 必须为整数`);
        v = Number(v); break;
      case 'Decimal':
      case 'Float':
        if (Number.isNaN(Number(v))) throw new BizError(`字段 ${f.name} 必须为数字`);
        v = Number(v); break;
      case 'Boolean': v = v === true || v === 'true' || v === 1; break;
      case 'DateTime': v = dateOnly(v); break;
    }
    out[f.name] = v;
  }
  return out;
}

function parseFilter(model: string, name: string, raw: string) {
  const f = MODELS.get(model)!.fields.find((x) => x.name === name)!;
  if (f.type === 'Boolean') return ['1', 'true', 'yes'].includes(raw.toLowerCase());
  if (f.type === 'Int') return Number(raw);
  return raw;
}

export interface CrudOptions {
  model: string;
  prefix: string;
  perm: string | string[];
  label: string;
  search?: string[];
  filters?: string[];
  orderBy?: any;
  children?: string[];
  /** 保存前校验/补全（merged = 原记录 + 本次修改） */
  validate?: (tx: Tx, merged: Record<string, any>, data: Record<string, any>) => Promise<void> | void;
}

export function crudController(o: CrudOptions): Type<unknown> {
  const perms = Array.isArray(o.perm) ? o.perm : [o.perm];
  const delegateName = o.model.charAt(0).toLowerCase() + o.model.slice(1);

  @Controller(o.prefix)
  class CrudController {
    constructor(@Inject(PrismaService) readonly db: PrismaService) {}

    private d(c: any = this.db.client) {
      return c[delegateName];
    }

    @Get()
    list(@Query() q: Record<string, string>) {
      const where: Record<string, any> = {};
      if (q.q) where.OR = (o.search ?? ['code', 'name']).map((f) => ({ [f]: like(q.q) }));
      for (const f of o.filters ?? []) if (q[f] !== undefined && q[f] !== '') where[f] = parseFilter(o.model, f, q[f]);
      return paginate(this.d(), o.model, { where, orderBy: o.orderBy, children: o.children }, q);
    }

    @Get(':id')
    async get(@Param('id', ParseIntPipe) id: number) {
      const row = await this.d().findUnique({ where: { id }, include: inc(o.model, o.children) });
      if (!row) throw new NotFound(o.label);
      return ser(o.model, row, o.children);
    }

    private save(fn: (tx: Tx) => Promise<any>) {
      return this.db.tx(fn).catch((e) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new BizError(`${o.label}编码已存在`);
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') throw new BizError(`数据不完整或关联数据不存在`);
        throw e;
      });
    }

    @Post()
    @Perms(...perms)
    create(@Body() body: Record<string, any>, @User() user: CurrentUser) {
      return this.save(async (tx) => {
        const data = coerce(o.model, body, true, o.label);
        if (MODELS.get(o.model)!.fields.some((f) => f.name === 'created_by')) data.created_by = user.username;
        await o.validate?.(tx, { ...data }, data);
        const row = await this.d(tx).create({ data, include: inc(o.model, o.children) });
        return ser(o.model, row, o.children);
      });
    }

    @Put(':id')
    @Perms(...perms)
    update(@Param('id', ParseIntPipe) id: number, @Body() body: Record<string, any>) {
      return this.save(async (tx) => {
        const cur = await this.d(tx).findUnique({ where: { id } });
        if (!cur) throw new NotFound(o.label);
        const data = coerce(o.model, body, false, o.label);
        await o.validate?.(tx, { ...cur, ...data }, data);
        const row = await this.d(tx).update({ where: { id }, data, include: inc(o.model, o.children) });
        return ser(o.model, row, o.children);
      });
    }

    @Delete(':id')
    @Perms(...perms)
    remove(@Param('id', ParseIntPipe) id: number) {
      return this.db
        .tx(async (tx) => {
          const cur = await this.d(tx).findUnique({ where: { id } });
          if (!cur) throw new NotFound(o.label);
          await this.d(tx).delete({ where: { id } });
          return { ok: true };
        })
        .catch((e) => {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') throw new BizError(`该${o.label}已被业务单据引用，不能删除（可改为停用）`);
          throw e;
        });
    }
  }

  Object.defineProperty(CrudController, 'name', { value: `${o.model}CrudController` });
  return CrudController;
}
