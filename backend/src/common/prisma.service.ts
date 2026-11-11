import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { als } from './context';
import { DATE_FIELDS } from './dates';

export type Tx = Prisma.TransactionClient;

/** 审计追踪不记录的模型（自身即为记录/流水） */
const SKIP_MODELS = new Set(['AuditLog', 'ESignature', 'Sequence', 'StockMove']);
const SKIP_FIELDS = new Set(['password_hash', 'updated_at', 'created_at']);
const WRITE_OPS = new Set(['create', 'update', 'upsert', 'delete', 'updateMany', 'deleteMany']);

const MODELS = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
const tableOf = (model: string) => MODELS.get(model)?.dbName ?? model;
const scalarFields = (model: string) =>
  (MODELS.get(model)?.fields ?? []).filter((f) => f.kind === 'scalar' && !SKIP_FIELDS.has(f.name)).map((f) => f.name);
const delegateName = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

function jsonable(key: string, v: unknown): unknown {
  if (v instanceof Date) return DATE_FIELDS.has(key) ? v.toISOString().slice(0, 10) : v.toISOString();
  return v;
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b || (a == null && b == null);
}

/** 嵌套写入（如订单行 lines: {create: [...]}）摘要，记录在父记录的审计中 */
function nestedOps(model: string, data: any): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const rels = (MODELS.get(model)?.fields ?? []).filter((f) => f.kind === 'object').map((f) => f.name);
  const out: Record<string, unknown> = {};
  for (const r of rels) if (data[r] !== undefined) out[r] = data[r];
  return Object.keys(out).length ? JSON.parse(JSON.stringify(out)) : undefined;
}

function rowChanges(model: string, action: string, before: any, after: any, data?: any) {
  const changes: Record<string, unknown> = {};
  for (const f of scalarFields(model)) {
    if (action === 'CREATE') {
      if (f !== 'id' && after?.[f] !== null && after?.[f] !== undefined) changes[f] = jsonable(f, after[f]);
    } else if (action === 'UPDATE') {
      if (before && after && f in after && !same(before[f], after[f])) changes[f] = [jsonable(f, before[f]), jsonable(f, after[f])];
    } else if (before?.[f] !== null && before?.[f] !== undefined) {
      changes[f] = jsonable(f, before[f]);
    }
  }
  const nested = action !== 'DELETE' ? nestedOps(model, data) : undefined;
  if (nested) changes._nested = nested;
  return changes;
}

/**
 * 带审计追踪的 Prisma 客户端。
 * 所有 create/update/upsert/delete 自动记录：操作人、时间、表名、记录 ID、字段级修改前后值。
 * 审计日志与业务数据写在同一事务中（通过 AsyncLocalStorage 取当前事务），要么都成功要么都回滚。
 */
function withAudit(base: PrismaClient) {
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || SKIP_MODELS.has(model) || !WRITE_OPS.has(operation)) return query(args);
          const ctx = als.getStore();
          const client: any = ctx?.tx ?? base;
          const delegate = client[delegateName(model)];
          const a: any = args;
          let befores: any[] = [];
          if (operation === 'update' || operation === 'delete' || operation === 'upsert') {
            const b = await delegate.findUnique({ where: a.where });
            befores = b ? [b] : [];
          } else if (operation === 'updateMany' || operation === 'deleteMany') {
            befores = await delegate.findMany({ where: a.where });
          }
          const result: any = await query(args);
          const rows: any[] = [];
          const push = (action: string, id: number | null, changes: Record<string, unknown>) => {
            if (action === 'UPDATE' && !Object.keys(changes).length) return;
            rows.push({
              username: ctx?.user?.username ?? 'system',
              full_name: ctx?.user?.full_name ?? '系统',
              entity: tableOf(model),
              entity_id: id,
              action,
              changes: JSON.stringify(changes),
            });
          };
          if (operation === 'create') push('CREATE', result?.id ?? null, rowChanges(model, 'CREATE', null, result, a.data));
          else if (operation === 'upsert') {
            if (befores.length) push('UPDATE', result?.id, rowChanges(model, 'UPDATE', befores[0], result, a.update));
            else push('CREATE', result?.id, rowChanges(model, 'CREATE', null, result, a.create));
          } else if (operation === 'update') push('UPDATE', result?.id, rowChanges(model, 'UPDATE', befores[0], result, a.data));
          else if (operation === 'delete') push('DELETE', befores[0]?.id ?? null, rowChanges(model, 'DELETE', befores[0], null));
          else if (operation === 'deleteMany') befores.forEach((b) => push('DELETE', b.id, rowChanges(model, 'DELETE', b, null)));
          else if (operation === 'updateMany' && befores.length) {
            const afters = await delegate.findMany({ where: { id: { in: befores.map((b) => b.id) } } });
            const byId = new Map(afters.map((x: any) => [x.id, x]));
            befores.forEach((b) => push('UPDATE', b.id, rowChanges(model, 'UPDATE', b, byId.get(b.id))));
          }
          if (rows.length) await client.auditLog.createMany({ data: rows });
          return result;
        },
      },
    },
  });
}

@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly base = new PrismaClient();
  /** 业务代码统一使用此客户端（带审计） */
  readonly client: PrismaClient = withAudit(this.base) as unknown as PrismaClient;

  /**
   * 在事务中执行业务操作（所有写操作必须走这里）。
   * 事务内产生的审计日志、库存流水与业务数据一起提交或回滚。
   */
  tx<T>(fn: (tx: Tx) => Promise<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
    return this.client.$transaction(
      (tx) => {
        const store = als.getStore() ?? {};
        return als.run({ ...store, tx }, () => fn(tx));
      },
      { timeout: opts.timeoutMs ?? 60_000, maxWait: 15_000 },
    );
  }

  async onModuleDestroy() {
    await this.base.$disconnect();
  }
}
