/**
 * 数据导入（金蝶等旧系统迁移）：物料 / 客户 / 供应商按编码新增或更新；BOM 按父项+版本导入为草稿；期初库存走仓储收货（OPENING）。
 * 整个文件在一个事务中处理：逐行收集所有错误（每行一个保存点，数据库错误不影响后续行的检查），
 * 只要有任何错误就整体回滚，返回全部错误行，修正后重新导入。
 */
import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import type { CurrentUser } from '../common/context';
import { BizError } from '../common/errors';
import { PrismaService, type Tx } from '../common/prisma.service';
import { WmsService, type ReceiveLineInput } from '../wms/wms.service';
import { CATEGORY, getSpec, SUP_STATUS, YES, type ImportSpec } from './import-specs';
import { cellText, type Cell, type DataRow, excelDate, num, pick, readRows } from './tabular';

export interface RowError {
  row: number;
  message: string;
}

export interface UploadedFileLike {
  buffer: Buffer;
  originalname: string;
}

/** 有错误时抛出以回滚整个事务，并把错误列表带出事务 */
class RollbackImport extends Error {
  constructor(readonly errors: RowError[]) {
    super('import rollback');
  }
}

const has = (o: Record<string, string>, k: string) => Object.hasOwn(o, k);

function errMsg(e: unknown): string {
  if (e instanceof HttpException) {
    const r: any = e.getResponse();
    return r && typeof r === 'object' && r.detail ? String(r.detail) : e.message;
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const col = String((e.meta as any)?.column_name ?? '');
    if (e.code === 'P2000') return `字段内容超出长度限制${col && !col.includes('not available') ? `：${col}` : ''}`;
    if (e.code === 'P2002') return '编码已存在，不能重复';
    if (e.code === 'P2003') return '关联数据不存在';
  }
  return e instanceof Error ? e.message : String(e);
}

const DELEGATE: Record<string, 'material' | 'customer' | 'supplier'> = { materials: 'material', customers: 'customer', suppliers: 'supplier' };

@Injectable()
export class ImportService {
  constructor(private readonly db: PrismaService, private readonly wms: WmsService) {}

  /** 导入模板：第一行为表头（各字段首选列名），第二行为示例 */
  async template(entity: string): Promise<Buffer> {
    const spec = getSpec(entity);
    if (!spec) throw new BizError('不支持的导入类型');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(spec.title);
    const header = Object.values(spec.fields).map((a) => a[0]);
    ws.addRow(header);
    ws.addRow(spec.example);
    header.forEach((_, i) => (ws.getColumn(i + 1).width = 16));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  async run(entity: string, file: UploadedFileLike | undefined, user: CurrentUser) {
    const spec = getSpec(entity);
    if (!spec) throw new BizError('不支持的导入类型');
    if (!file?.buffer) throw new BizError('请选择要导入的文件');
    const rows = await readRows(file.buffer, file.originalname);
    if (!rows.length) throw new BizError('文件为空或无法识别表头');
    try {
      return await this.db.tx(async (tx) => {
        const errors: RowError[] = [];
        let res: { created: number; updated: number };
        if (entity === 'boms') res = await this.boms(tx, spec, rows, user, errors);
        else if (entity === 'stock') res = await this.stock(tx, spec, rows, user, errors);
        else res = await this.masterData(tx, entity, spec, rows, user, errors);
        if (errors.length) throw new RollbackImport(errors);
        return { ok: true, created: res.created, updated: res.updated, errors: [] as RowError[] };
      }, { timeoutMs: 300_000 }); // 大文件导入（数千行）放宽事务超时
    } catch (e) {
      if (e instanceof RollbackImport) {
        return { ok: false, created: 0, updated: 0, errors: e.errors, message: `发现 ${e.errors.length} 行错误，已全部回滚，请修正后重新导入` };
      }
      throw e;
    }
  }

  /** 保存点：单行出错只回滚该行，事务可继续检查后续行 */
  private async savepoint<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
    await tx.$executeRawUnsafe('SAVEPOINT import_row');
    try {
      const r = await fn();
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT import_row');
      return r;
    } catch (e) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT import_row');
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT import_row');
      throw e;
    }
  }

  private fieldValue(entity: string, key: string, v: Cell): unknown {
    const s = cellText(v);
    switch (key) {
      case 'category':
        // 物料类别需映射为系统代码；供应商的“供应类别”是自由文本（如 LED芯片）
        if (entity !== 'materials') return s;
        if (!has(CATEGORY, s)) throw new BizError(`无法识别的物料类别：${s}`);
        return CATEGORY[s];
      case 'status':
        return has(SUP_STATUS, s) ? SUP_STATUS[s] : 'PENDING';
      case 'lot_control':
      case 'serial_control':
      case 'iqc_required':
        return YES.has(s);
      case 'safety_stock':
      case 'std_cost':
        return num(v, 0);
      case 'lead_time_days':
      case 'shelf_life_days':
        return Math.trunc(num(v, 0));
      default:
        return s;
    }
  }

  /** 物料 / 客户 / 供应商：按编码新增或更新 */
  private async masterData(tx: Tx, entity: string, spec: ImportSpec, rows: DataRow[], user: CurrentUser, errors: RowError[]) {
    const f = spec.fields;
    const delegate: any = tx[DELEGATE[entity]];
    let created = 0;
    let updated = 0;
    for (const { line, data: row } of rows) {
      try {
        await this.savepoint(tx, async () => {
          const rawCode = pick(row, f.code);
          const name = pick(row, f.name);
          if (!rawCode || !name) throw new BizError('编码和名称不能为空');
          const code = cellText(rawCode);
          const data: Record<string, unknown> = {};
          for (const [key, aliases] of Object.entries(f)) {
            if (key === 'code' || key === 'default_supplier') continue;
            const v = pick(row, aliases);
            if (v === null) continue;
            data[key] = this.fieldValue(entity, key, v);
          }
          if (entity === 'materials') {
            const sup = pick(row, f.default_supplier);
            if (sup) {
              const s = cellText(sup);
              const found = await tx.supplier.findFirst({ where: { OR: [{ code: s }, { name: s }] }, orderBy: { id: 'asc' } });
              if (!found) throw new BizError(`默认供应商 ${s} 不存在，请先导入供应商`);
              data.default_supplier_id = found.id;
            }
          }
          const cur = await delegate.findUnique({ where: { code } });
          if (cur) {
            await delegate.update({ where: { id: cur.id }, data });
            updated++;
          } else {
            await delegate.create({ data: { code, created_by: user.username, ...data } });
            created++;
          }
        });
      } catch (e) {
        errors.push({ row: line, message: errMsg(e) });
      }
    }
    return { created, updated };
  }

  /** BOM：按 父项编码 + 版本 分组，每组生成一个草稿 BOM（受控文件：已存在的版本不覆盖，导入后需工程师审核发布） */
  private async boms(tx: Tx, spec: ImportSpec, rows: DataRow[], user: CurrentUser, errors: RowError[]) {
    const f = spec.fields;
    const groups = new Map<string, { parent: string; ver: string; items: DataRow[] }>();
    for (const r of rows) {
      const parent = cellText(pick(r.data, f.parent) || '');
      const ver = cellText(pick(r.data, f.version) || 'A0');
      const key = JSON.stringify([parent, ver]);
      if (!groups.has(key)) groups.set(key, { parent, ver, items: [] });
      groups.get(key)!.items.push(r);
    }
    let created = 0;
    for (const { parent, ver, items } of groups.values()) {
      try {
        await this.savepoint(tx, async () => {
          const pm = await tx.material.findUnique({ where: { code: parent } });
          if (!pm) throw new BizError(`父项物料 ${parent} 不存在`);
          if (await tx.bom.findFirst({ where: { material_id: pm.id, version: ver } })) {
            throw new BizError(`${parent} 版本 ${ver} 的 BOM 已存在（为保证受控，导入不覆盖已有 BOM）`);
          }
          const lines: Prisma.BomLineUncheckedCreateWithoutBomInput[] = [];
          for (const [n, { line, data: row }] of items.entries()) {
            const cc = cellText(pick(row, f.component) || '');
            const cm = await tx.material.findUnique({ where: { code: cc } });
            if (!cm) throw new BizError(`第 ${line} 行子项物料 ${cc} 不存在`);
            const qty = num(pick(row, f.qty), 0) / (num(pick(row, f.denominator), 1) || 1);
            const sr = num(pick(row, f.scrap_rate), 0);
            const designator = pick(row, f.designator);
            lines.push({
              line_no: (n + 1) * 10, component_id: cm.id, qty_per: qty, scrap_rate: sr && sr >= 1 ? sr / 100 : sr,
              designator: designator === null ? null : cellText(designator),
            });
          }
          await tx.bom.create({ data: { material_id: pm.id, version: ver, status: 'DRAFT', remark: '数据导入', created_by: user.username, lines: { create: lines } } });
          created++;
        });
      } catch (e) {
        errors.push({ row: items[0].line, message: errMsg(e) });
      }
    }
    return { created, updated: 0 };
  }

  /** 期初库存：全部行校验通过后一次性走仓储收货（OPENING，合格状态；客供料记入货主名下） */
  private async stock(tx: Tx, spec: ImportSpec, rows: DataRow[], user: CurrentUser, errors: RowError[]) {
    const f = spec.fields;
    const lines: ReceiveLineInput[] = [];
    for (const { line, data: row } of rows) {
      try {
        const mc = cellText(pick(row, f.material) || '');
        const m = await tx.material.findUnique({ where: { code: mc } });
        if (!m) throw new BizError(`物料 ${mc} 不存在`);
        const lc = cellText(pick(row, f.location) || '');
        const loc = await tx.location.findUnique({ where: { code: lc } });
        if (!loc) throw new BizError(`库位 ${lc} 不存在`);
        const qty = num(pick(row, f.qty), 0);
        if (qty <= 0) throw new BizError('数量必须大于 0');
        const lot = cellText(pick(row, f.lot_no) || '');
        lines.push({
          material_id: m.id, location_id: loc.id, qty, lot_no: lot || null,
          mfg_date: excelDate(pick(row, f.mfg_date)), expiry_date: excelDate(pick(row, f.expiry_date)),
        });
      } catch (e) {
        errors.push({ row: line, message: errMsg(e) });
      }
    }
    let created = 0;
    if (lines.length && !errors.length) {
      await this.wms.receive(tx, user, { receipt_type: 'OPENING', lines, remark: '期初库存导入' });
      created = lines.length;
    }
    return { created, updated: 0 };
  }
}
