/**
 * 数据导入（金蝶等旧系统迁移）：物料 / 客户 / 供应商按编码新增或更新；BOM 按父项+版本导入为草稿；期初库存走仓储收货（OPENING）；
 * 用户账号批量开户（生成初始密码清单）。
 * 整个文件在一个事务中处理：逐行收集所有错误（每行一个保存点，数据库错误不影响后续行的检查），
 * 只要有任何错误就整体回滚，返回全部错误行，修正后重新导入。
 * “预检查”（mode=check）完整执行一遍后一律回滚，只返回将新增/更新的条数与错误清单。
 *
 * 期初库存防重复（评审 E-01 P0）：同一 物料 + 库位 + 批号（+ 货主）已有库存或已在期初批次中导入过 → 默认报错并列出重复行；
 * 选择“覆盖为导入数”时按 导入数 − 当前合格库存 记库存调整流水（ADJUST，经 InventoryService），不直接改库存。
 * 每次期初导入生成一张期初入库单（单号即导入批次号），可整批撤销（反向流水）。
 *
 * 权限（评审 E-07）：按实体分权限（见 import-specs 的 perms）；系统管理员在“上线迁移模式”开启时可导入全部业务数据，
 * 上线完成后由管理员关闭（开关存 sys_sequence，变更写审计追踪）。
 */
import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { PERMISSIONS, ROLES, userPermissions } from '../auth/roles';
import type { CurrentUser } from '../common/context';
import { today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { EPS, g, round } from '../common/num';
import { PrismaService, type Tx } from '../common/prisma.service';
import { InventoryService, type Ref } from '../core/inventory.service';
import { NumberingService } from '../core/numbering.service';
import { createUserTx, parseRoles } from '../system/user-admin';
import { WmsService, type ReceiveLineInput } from '../wms/wms.service';
import {
  AUTH_SOURCE, CATEGORY, CATEGORY_CHOICES, ENTITY_ORDER, getSpec, NO, SPECS, SUP_STATUS, SUP_STATUS_CHOICES, YES, YES_NO,
  type DynamicOptions, type ImportSpec,
} from './import-specs';
import { cellText, type Cell, type DataRow, excelDate, num, pick, readRows } from './tabular';

export interface RowError {
  row: number;
  message: string;
}

export interface UploadedFileLike {
  buffer: Buffer;
  originalname: string;
}

export interface RunOptions {
  /** check = 预检查（执行后整体回滚）；import = 正式导入 */
  mode?: 'check' | 'import';
  /** 期初库存：已有库存时 error = 报错（默认）；overwrite = 覆盖为导入数（记库存调整流水） */
  onDuplicate?: 'error' | 'overwrite';
}

interface StockDup {
  row: number;
  material_code: string;
  location_code: string;
  lot_no: string;
  current_qty: number;
  new_qty: number;
  prior_batch: string | null;
}

interface RunResult {
  created: number;
  updated: number;
  extra?: Record<string, unknown>;
}

/** 有错误（或预检查）时抛出以回滚整个事务，并把结果带出事务 */
class RollbackImport extends Error {
  constructor(readonly errors: RowError[], readonly result: RunResult | null = null) {
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

/** 上线迁移模式开关（sys_sequence 中的配置键：1 = 开启，0 = 关闭；未设置视为开启——新系统上线时管理员即可导入） */
const MIGRATION_KEY = 'cfg:import_migration_mode';

const STATUS_TEXT: Record<string, string> = { QUARANTINE: '待检', AVAILABLE: '合格', REJECTED: '不合格', HOLD: '冻结' };

@Injectable()
export class ImportService {
  constructor(
    private readonly db: PrismaService,
    private readonly wms: WmsService,
    private readonly inv: InventoryService,
    private readonly numbering: NumberingService,
  ) {}

  // ---------------- 权限与迁移模式 ----------------

  async migrationMode(): Promise<boolean> {
    const row = await this.db.base.sequence.findUnique({ where: { key: MIGRATION_KEY } });
    return row ? row.value === 1 : true;
  }

  async setMigrationMode(enabled: boolean, user: CurrentUser) {
    const before = await this.migrationMode();
    await this.db.tx(async (tx) => {
      await tx.sequence.upsert({ where: { key: MIGRATION_KEY }, create: { key: MIGRATION_KEY, value: enabled ? 1 : 0 }, update: { value: enabled ? 1 : 0 } });
      if (before !== enabled) {
        await tx.auditLog.create({
          data: {
            username: user.username, full_name: user.full_name, entity: 'sys_setting', entity_id: null, action: 'UPDATE',
            changes: JSON.stringify({ import_migration_mode: [before ? '开启' : '关闭', enabled ? '开启' : '关闭'] }),
          },
        });
      }
    });
    return { migration_mode: enabled };
  }

  /** 当前账号能否导入该实体；不能时给出原因 */
  private access(user: CurrentUser, spec: ImportSpec, migration: boolean): { ok: boolean; via_migration: boolean; reason: string | null } {
    const mine = userPermissions(user);
    if (spec.perms.some((p) => mine.has(p))) return { ok: true, via_migration: false, reason: null };
    const need = spec.perms.map((p) => PERMISSIONS[p]?.split('（')[0] ?? p).join('、');
    const roles = Object.values(ROLES).filter((r) => spec.perms.some((p) => r.perms.includes(p))).map((r) => r.name).join('、');
    if (mine.has('admin') && spec.perms[0] !== 'admin') {
      if (migration) return { ok: true, via_migration: true, reason: null };
      return { ok: false, via_migration: false, reason: `需要【${need}】权限（${roles}）；上线迁移模式已关闭，管理员需重新开启后才能导入` };
    }
    return { ok: false, via_migration: false, reason: `需要【${need}】权限，请由${roles}导入` };
  }

  private async assertAccess(user: CurrentUser, entity: string, spec: ImportSpec) {
    const a = this.access(user, spec, await this.migrationMode());
    if (!a.ok) throw new HttpException({ detail: `无权限导入${spec.title}：${a.reason}` }, 403);
  }

  /** 导入页面：各类数据的说明、列定义、当前账号能否导入、已有数据量（进度） */
  async options(user: CurrentUser) {
    const migration = await this.migrationMode();
    const c = this.db.base;
    const [suppliers, customers, materials, boms, stock, users] = await Promise.all([
      c.supplier.count(), c.customer.count(), c.material.count(), c.bom.count(),
      c.receipt.count({ where: { receipt_type: 'OPENING', status: { not: 'CANCELLED' } } }), c.user.count(),
    ]);
    const counts: Record<string, number> = { suppliers, customers, materials, boms, stock, users };
    const mine = userPermissions(user);
    return {
      migration_mode: migration,
      is_admin: mine.has('admin'),
      entities: ENTITY_ORDER.map((key) => {
        const spec = SPECS[key];
        const a = this.access(user, spec, migration);
        return {
          key, title: spec.title, desc: spec.desc,
          perms: spec.perms.map((p) => ({ code: p, name: PERMISSIONS[p]?.split('（')[0] ?? p })),
          can_import: a.ok, via_migration: a.via_migration, reason: a.reason, count: counts[key] ?? 0,
          columns: Object.entries(spec.fields).map(([f, aliases]) => {
            const m = spec.meta[f] ?? {};
            return { field: f, header: aliases[0], aliases: aliases.slice(1), required: !!m.required, note: m.note ?? null, options: Array.isArray(m.options) ? m.options : null };
          }),
        };
      }),
    };
  }

  // ---------------- 模板 ----------------

  private async dynamicOptions(kind: DynamicOptions): Promise<string[]> {
    const c = this.db.base;
    switch (kind) {
      case 'locations':
        return (await c.location.findMany({ where: { is_active: true }, orderBy: { code: 'asc' }, select: { code: true } })).map((x) => x.code);
      case 'suppliers':
        return (await c.supplier.findMany({ where: { is_active: true }, orderBy: { code: 'asc' }, select: { code: true } })).map((x) => x.code);
      case 'roles':
        return Object.values(ROLES).map((r) => r.name);
      case 'departments':
        return (await c.user.groupBy({ by: ['department'], orderBy: { department: 'asc' } })).map((d) => d.department).filter((d): d is string => !!d);
      default:
        return [];
    }
  }

  /**
   * 导入模板（.xlsx）：
   *  第 1 页“数据”：表头（必填列红色加粗、带批注说明），可选值列带下拉；不放示例行（避免误导入示例数据）。
   *  第 2 页“填写说明”：每列是否必填、说明、可选值、示例。
   *  第 3 页“可选值”：下拉的数据来源（库位、供应商等取自当前系统）。
   */
  async template(entity: string): Promise<Buffer> {
    const spec = getSpec(entity);
    if (!spec) throw new BizError('不支持的导入类型');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(spec.title);
    const guide = wb.addWorksheet('填写说明');
    const lists = wb.addWorksheet('可选值');
    const fields = Object.entries(spec.fields);
    const header = fields.map(([, a]) => a[0]);
    ws.addRow(header);
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const ROWS = 2000;
    let listCol = 0;
    for (const [i, [f]] of fields.entries()) {
      const m = spec.meta[f] ?? {};
      const col = ws.getColumn(i + 1);
      col.width = Math.max(12, header[i].length * 2 + 4);
      if (m.text) col.numFmt = '@';
      const cell = ws.getCell(1, i + 1);
      cell.font = { bold: true, color: { argb: m.required ? 'FFCF1322' : 'FF262626' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: m.required ? 'FFFFF1F0' : 'FFF5F5F5' } };
      const choices = Array.isArray(m.options) ? m.options : m.options ? await this.dynamicOptions(m.options) : null;
      const noteText = [m.required ? '必填' : '选填', m.note, choices?.length ? `可选：${choices.slice(0, 30).join('、')}${choices.length > 30 ? '…' : ''}` : null].filter(Boolean).join('\n');
      cell.note = noteText;
      if (choices?.length) {
        listCol += 1;
        const letter = lists.getColumn(listCol).letter;
        lists.getCell(1, listCol).value = header[i];
        lists.getCell(1, listCol).font = { bold: true };
        choices.forEach((v, k) => (lists.getCell(k + 2, listCol).value = v));
        lists.getColumn(listCol).width = 18;
        const colLetter = col.letter;
        (ws as any).dataValidations.add(`${colLetter}2:${colLetter}${ROWS}`, {
          type: 'list', allowBlank: true, formulae: [`'可选值'!$${letter}$2:$${letter}$${choices.length + 1}`],
          showErrorMessage: m.strict !== false, errorStyle: 'stop', errorTitle: '不在可选值内', error: `请从下拉中选择${header[i]}`,
          showInputMessage: true, promptTitle: header[i], prompt: (m.note ?? '').slice(0, 250),
        });
      }
    }
    // 填写说明
    guide.addRow([`${spec.title}导入说明：${spec.desc}`]).font = { bold: true };
    guide.addRow(['第一行表头请勿修改（也可直接上传金蝶“引出”的 Excel，系统识别常见列名）；红色列为必填。任何一行出错整个文件都不会导入，可先点“预检查”。']);
    guide.addRow([]);
    const gh = guide.addRow(['列名', '必填', '说明', '可选值', '示例', '也可识别的列名']);
    gh.font = { bold: true };
    for (const [f, aliases] of fields) {
      const m = spec.meta[f] ?? {};
      const choices = Array.isArray(m.options) ? m.options.join('、') : m.options ? `见“可选值”页（${({ locations: '当前系统的库位编码', suppliers: '当前系统的供应商编码', roles: '系统角色', departments: '已有部门' } as Record<string, string>)[m.options]}）` : '';
      guide.addRow([aliases[0], m.required ? '是' : '', m.note ?? '', choices, m.example ?? '', aliases.slice(1).join('、')]);
    }
    [16, 6, 48, 36, 22, 28].forEach((w, i) => (guide.getColumn(i + 1).width = w));
    guide.getColumn(3).alignment = { wrapText: true, vertical: 'top' };
    if (!listCol) lists.state = 'hidden';
    wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: 0, visibility: 'visible' }];
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // ---------------- 导入 ----------------

  async run(entity: string, file: UploadedFileLike | undefined, user: CurrentUser, opts: RunOptions = {}) {
    const spec = getSpec(entity);
    if (!spec) throw new BizError('不支持的导入类型');
    await this.assertAccess(user, entity, spec);
    if (!file?.buffer) throw new BizError('请选择要导入的文件');
    const rows = await readRows(file.buffer, file.originalname);
    if (!rows.length) throw new BizError('文件为空或无法识别表头');
    const missing = this.missingColumns(spec, rows);
    if (missing.length) {
      throw new BizError(`文件缺少必填列：${missing.join('、')}。请使用“下载模板”中的表头（或金蝶导出的同名列）`);
    }
    const check = opts.mode === 'check';
    try {
      return await this.db.tx(async (tx) => {
        const errors: RowError[] = [];
        let res: RunResult;
        if (entity === 'boms') res = await this.boms(tx, spec, rows, user, errors);
        else if (entity === 'stock') res = await this.stock(tx, spec, rows, user, errors, opts, file.originalname);
        else if (entity === 'users') res = await this.users(tx, spec, rows, user, errors, check);
        else res = await this.masterData(tx, entity, spec, rows, user, errors);
        if (errors.length || check) throw new RollbackImport(errors, res);
        return { ok: true, created: res.created, updated: res.updated, errors: [] as RowError[], ...(res.extra ?? {}) };
      }, { timeoutMs: 300_000 }); // 大文件导入（数千行）放宽事务超时
    } catch (e) {
      if (e instanceof RollbackImport) {
        const extra = e.result?.extra ?? {};
        if (check) {
          const { passwords: _p, batch_no: _b, ...rest } = extra as Record<string, unknown>;
          return {
            ok: !e.errors.length, check: true, total: rows.length, created: e.result?.created ?? 0, updated: e.result?.updated ?? 0, errors: e.errors, ...rest,
            message: e.errors.length
              ? `预检查发现 ${e.errors.length} 行错误，请修正后再导入（本次未写入任何数据）`
              : `预检查通过：共 ${rows.length} 行，可新增 ${e.result?.created ?? 0} 条${e.result?.updated ? `、更新 ${e.result.updated} 条` : ''}（本次未写入任何数据）`,
          };
        }
        const { passwords: _p, batch_no: _b, ...rest } = extra as Record<string, unknown>;
        return { ok: false, created: 0, updated: 0, errors: e.errors, ...rest, message: `发现 ${e.errors.length} 行错误，已全部回滚，请修正后重新导入` };
      }
      throw e;
    }
  }

  /** 必填列在文件表头中是否存在（任一别名即可） */
  private missingColumns(spec: ImportSpec, rows: DataRow[]): string[] {
    const headers = new Set<string>();
    for (const r of rows.slice(0, 50)) Object.keys(r.data).forEach((h) => headers.add(h));
    return Object.entries(spec.fields)
      .filter(([f, aliases]) => spec.meta[f]?.required && !aliases.some((a) => headers.has(a)))
      .map(([, aliases]) => aliases[0]);
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

  private yesNo(label: string, s: string): boolean {
    if (YES.has(s)) return true;
    if (NO.has(s)) return false;
    throw new BizError(`${label}无法识别：${s}（可选：${YES_NO.join('、')}）`);
  }

  private fieldValue(entity: string, spec: ImportSpec, key: string, v: Cell): unknown {
    const s = cellText(v).trim();
    const label = spec.fields[key]?.[0] ?? key;
    switch (key) {
      case 'category':
        // 物料类别需映射为系统代码；供应商的“供应类别”是自由文本（如 LED芯片）
        if (entity !== 'materials') return s;
        if (!has(CATEGORY, s)) throw new BizError(`无法识别的物料类别：${s}（可选：${CATEGORY_CHOICES.join('、')}；金蝶的 外购/委外/自制 也可识别）`);
        return CATEGORY[s];
      case 'status':
        if (!has(SUP_STATUS, s)) throw new BizError(`无法识别的供应商状态：${s}（可选：${SUP_STATUS_CHOICES.join('、')}；留空 = 待评）`);
        return SUP_STATUS[s];
      case 'lot_control':
      case 'serial_control':
      case 'iqc_required':
        return this.yesNo(label, s);
      case 'safety_stock':
      case 'std_cost':
        return num(v, 0);
      case 'lead_time_days':
      case 'shelf_life_days':
        return Math.trunc(num(v, 0));
      case 'currency':
        return s.toUpperCase();
      default:
        return s;
    }
  }

  /** 物料 / 客户 / 供应商：按编码新增或更新 */
  private async masterData(tx: Tx, entity: string, spec: ImportSpec, rows: DataRow[], user: CurrentUser, errors: RowError[]): Promise<RunResult> {
    const f = spec.fields;
    const delegate: any = tx[DELEGATE[entity]];
    let created = 0;
    let updated = 0;
    const seen = new Map<string, number>();
    for (const { line, data: row } of rows) {
      try {
        await this.savepoint(tx, async () => {
          const rawCode = pick(row, f.code);
          const name = pick(row, f.name);
          if (!rawCode || !name) throw new BizError('编码和名称不能为空');
          const code = cellText(rawCode);
          if (seen.has(code)) throw new BizError(`编码 ${code} 与第 ${seen.get(code)} 行重复，请合并为一行`);
          seen.set(code, line);
          const data: Record<string, unknown> = {};
          for (const [key, aliases] of Object.entries(f)) {
            if (key === 'code' || key === 'default_supplier') continue;
            const v = pick(row, aliases);
            if (v === null) continue;
            data[key] = this.fieldValue(entity, spec, key, v);
          }
          if (entity === 'materials') {
            const sup = pick(row, f.default_supplier);
            if (sup) {
              const s = cellText(sup);
              const found = await tx.supplier.findFirst({ where: { OR: [{ code: s }, { name: s }] }, orderBy: { id: 'asc' } });
              if (!found) throw new BizError(`默认供应商 ${s} 不存在，请先导入供应商（或留空）`);
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
  private async boms(tx: Tx, spec: ImportSpec, rows: DataRow[], user: CurrentUser, errors: RowError[]): Promise<RunResult> {
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
          if (!parent) throw new BizError('父项物料编码不能为空');
          const pm = await tx.material.findUnique({ where: { code: parent } });
          if (!pm) throw new BizError(`父项物料 ${parent} 不存在，请先导入物料`);
          if (await tx.bom.findFirst({ where: { material_id: pm.id, version: ver } })) {
            throw new BizError(`${parent} 版本 ${ver} 的 BOM 已存在（为保证受控，导入不覆盖已有 BOM；如需修改请在 BOM 页面升版）`);
          }
          const lines: Prisma.BomLineUncheckedCreateWithoutBomInput[] = [];
          const comps = new Map<string, number>();
          for (const [n, { line, data: row }] of items.entries()) {
            const cc = cellText(pick(row, f.component) || '');
            if (!cc) throw new BizError(`第 ${line} 行子项物料编码不能为空`);
            const cm = await tx.material.findUnique({ where: { code: cc } });
            if (!cm) throw new BizError(`第 ${line} 行子项物料 ${cc} 不存在，请先导入物料`);
            if (comps.has(cc)) throw new BizError(`第 ${line} 行子项 ${cc} 与第 ${comps.get(cc)} 行重复，请合并用量`);
            comps.set(cc, line);
            const qty = num(pick(row, f.qty), 0) / (num(pick(row, f.denominator), 1) || 1);
            if (!(qty > 0)) throw new BizError(`第 ${line} 行用量必须大于 0`);
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

  /**
   * 期初库存：全部行校验通过后一次性走仓储收货（OPENING，合格状态；客供料记入货主名下）。
   * 重复判定：物料 + 库位 + 批号 + 货主；文件内重复直接报错；与系统已有库存（任何状态）或已导入的期初批次重复时，
   * 默认报错，onDuplicate=overwrite 时把合格库存调整为导入数（ADJUST 流水，参照本次期初入库单号）。
   */
  private async stock(tx: Tx, spec: ImportSpec, rows: DataRow[], user: CurrentUser, errors: RowError[], opts: RunOptions, filename: string): Promise<RunResult> {
    const f = spec.fields;
    const overwrite = opts.onDuplicate === 'overwrite';
    type Item = { line: number; m: any; loc: any; qty: number; lot: string; mfg: Date | null; exp: Date | null };
    const items: Item[] = [];
    let locChoices: string | null = null;
    const locHint = async () => {
      if (locChoices === null) {
        const codes = (await tx.location.findMany({ where: { is_active: true }, orderBy: { code: 'asc' }, select: { code: true }, take: 13 })).map((x) => x.code);
        locChoices = codes.length ? `现有库位：${codes.slice(0, 12).join('、')}${codes.length > 12 ? ' 等' : ''}；` : '';
      }
      return locChoices;
    };
    for (const { line, data: row } of rows) {
      try {
        const mc = cellText(pick(row, f.material) || '');
        if (!mc) throw new BizError('物料编码不能为空');
        const m = await tx.material.findUnique({ where: { code: mc } });
        if (!m) throw new BizError(`物料 ${mc} 不存在（请先导入物料，或核对编码与物料主数据是否完全一致）`);
        const lc = cellText(pick(row, f.location) || '');
        if (!lc) throw new BizError('库位编码不能为空');
        const loc = await tx.location.findUnique({ where: { code: lc } });
        if (!loc) throw new BizError(`库位 ${lc} 不存在（${await locHint()}新库位请先在“基础资料 → 库位”中建立）`);
        const qty = num(pick(row, f.qty), 0);
        if (qty <= 0) throw new BizError('数量必须大于 0');
        const lot = cellText(pick(row, f.lot_no) || '').trim();
        items.push({ line, m, loc, qty, lot, mfg: excelDate(pick(row, f.mfg_date)), exp: excelDate(pick(row, f.expiry_date)) });
      } catch (e) {
        errors.push({ row: line, message: errMsg(e) });
      }
    }
    // 文件内重复（批号留空且启用批号管理的物料会自动生成新批号，不算重复）
    const seen = new Map<string, number>();
    const keyed: Item[] = [];
    for (const it of items) {
      if (!it.lot && it.m.lot_control) continue;
      const k = `${it.m.id}|${it.loc.id}|${it.lot}`;
      if (seen.has(k)) {
        errors.push({ row: it.line, message: `与第 ${seen.get(k)} 行重复（同一物料 ${it.m.code} + 库位 ${it.loc.code} + 批号 ${it.lot || '（空）'}），请合并为一行` });
        continue;
      }
      seen.set(k, it.line);
      keyed.push(it);
    }
    // 与系统已有库存 / 已导入期初批次重复
    const duplicates: StockDup[] = [];
    const adjust: { it: Item; current: number }[] = [];
    const dupRows = new Set<number>();
    for (const it of keyed) {
      const owner = it.m.owner_customer_id ?? null;
      const stocks = await tx.stock.findMany({ where: { material_id: it.m.id, location_id: it.loc.id, lot_no: it.lot, owner_customer_id: owner, qty: { gt: EPS } } });
      const prior = await tx.receiptLine.findFirst({
        where: { material_id: it.m.id, location_id: it.loc.id, lot_no: it.lot, receipt: { receipt_type: 'OPENING', status: { not: 'CANCELLED' } } },
        include: { receipt: true }, orderBy: { id: 'desc' },
      });
      if (!stocks.length && !prior) continue;
      dupRows.add(it.line);
      const available = round(stocks.filter((s) => s.status === 'AVAILABLE').reduce((a, s) => a + s.qty, 0));
      const other = stocks.filter((s) => s.status !== 'AVAILABLE');
      const total = round(stocks.reduce((a, s) => a + s.qty, 0));
      duplicates.push({ row: it.line, material_code: it.m.code, location_code: it.loc.code, lot_no: it.lot, current_qty: total, new_qty: it.qty, prior_batch: prior?.receipt.no ?? null });
      const where = `${it.m.code} 库位 ${it.loc.code} 批号 ${it.lot || '（空）'}`;
      if (!overwrite) {
        errors.push({
          row: it.line,
          message: `${where} 已有库存 ${g(total)}${prior ? `（期初批次 ${prior.receipt.no} 已导入过）` : ''}，为防止重复导入未入账；如需以本文件数量为准，请选择“覆盖为导入数”后重新导入`,
        });
      } else if (other.length) {
        errors.push({
          row: it.line,
          message: `${where} 有${other.map((s) => `${STATUS_TEXT[s.status] ?? s.status}库存 ${g(s.qty)}`).join('、')}，不能按导入数覆盖；请先在库存中处理（检验/解冻）后再导入`,
        });
      } else {
        adjust.push({ it, current: available });
      }
    }
    const fresh = items.filter((it) => !dupRows.has(it.line));
    if (errors.length) return { created: fresh.length, updated: adjust.length, extra: { duplicates } };

    // 入账：新行走仓储收货（OPENING）；重复行按“导入数 − 当前合格库存”记调整流水
    const remark = `期初库存导入（${filename}）`.slice(0, 250);
    let rc: { id: number; no: string } | null = null;
    if (fresh.length) {
      const lines: ReceiveLineInput[] = fresh.map((it) => ({ material_id: it.m.id, location_id: it.loc.id, qty: it.qty, lot_no: it.lot || null, mfg_date: it.mfg, expiry_date: it.exp }));
      rc = await this.wms.receive(tx, user, { receipt_type: 'OPENING', lines, remark });
    }
    let changed = 0;
    let unchanged = 0;
    for (const { it, current } of adjust) {
      const diff = round(it.qty - current);
      if (Math.abs(diff) <= EPS) {
        unchanged++;
        continue;
      }
      if (!rc) {
        rc = await tx.receipt.create({
          data: { no: await this.numbering.nextNo(tx, 'RK'), receipt_type: 'OPENING', receipt_date: today(), status: 'CONFIRMED', remark: `${remark}：覆盖为导入数`, created_by: user.username },
        });
      }
      const ref: Ref = { ref_type: 'RECEIPT', ref_id: rc.id, ref_no: rc.no, username: user.username, remark: `期初导入覆盖：原 ${g(current)} → ${g(it.qty)}` };
      const k = { material_id: it.m.id, location_id: it.loc.id, lot_no: it.lot, status: 'AVAILABLE', owner_customer_id: it.m.owner_customer_id ?? null, move_type: 'ADJUST', ref };
      if (diff > 0) await this.inv.addStock(tx, { ...k, qty: diff, mfg_date: it.mfg, expiry_date: it.exp });
      else await this.inv.removeStock(tx, { ...k, qty: -diff });
      changed++;
    }
    return { created: fresh.length, updated: changed, extra: { batch_no: rc?.no ?? null, unchanged, duplicates } };
  }

  /** 期初导入批次（期初入库单）：最近的在前 */
  async stockBatches(q: Record<string, string>) {
    const take = Math.min(Number(q.page_size) || 20, 100);
    const rows = await this.db.base.receipt.findMany({
      where: { receipt_type: 'OPENING' }, orderBy: { id: 'desc' }, take,
      include: { lines: { select: { qty: true } } },
    });
    const moves = await this.db.base.stockMove.groupBy({
      by: ['ref_id'], where: { ref_type: 'RECEIPT', ref_id: { in: rows.map((r) => r.id) }, move_type: 'ADJUST' }, _count: { _all: true },
    });
    const adj = new Map(moves.map((m) => [m.ref_id, m._count._all]));
    return rows.map((r) => ({
      id: r.id, no: r.no, status: r.status, receipt_date: r.receipt_date, created_at: r.created_at, created_by: r.created_by, remark: r.remark,
      line_count: r.lines.length, total_qty: round(r.lines.reduce((a, l) => a + l.qty, 0)), adjust_count: adj.get(r.id) ?? 0,
    }));
  }

  /** 整批撤销期初导入：按该批次的入库/调整流水逐笔记反向流水（库存已被领用时提示不足、整批不撤销），入库单标记为已取消 */
  async revertStockBatch(id: number, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new BizError('请填写撤销原因');
    await this.assertAccess(user, 'stock', SPECS.stock);
    return this.db.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM wms_receipt WHERE id = ${id} FOR UPDATE`;
      const rc = await tx.receipt.findUnique({ where: { id } });
      if (!rc) throw new NotFound('期初导入批次');
      if (rc.receipt_type !== 'OPENING') throw new BizError('只能撤销期初库存导入批次');
      if (rc.status === 'CANCELLED') throw new BizError(`批次 ${rc.no} 已撤销`);
      const moves = await tx.stockMove.findMany({ where: { ref_type: 'RECEIPT', ref_id: id, move_type: { in: ['OPENING', 'ADJUST'] } }, orderBy: { id: 'desc' } });
      if (!moves.length) throw new BizError('该批次没有可撤销的库存流水');
      const ref: Ref = { ref_type: 'RECEIPT', ref_id: rc.id, ref_no: rc.no, username: user.username, remark: `撤销期初导入：${reason.trim()}`.slice(0, 250) };
      for (const mv of moves) {
        const base = { material_id: mv.material_id, lot_no: mv.lot_no, owner_customer_id: mv.owner_customer_id, move_type: 'ADJUST', ref, qty: mv.qty };
        if (mv.to_location_id) await this.inv.removeStock(tx, { ...base, location_id: mv.to_location_id, status: mv.to_status ?? 'AVAILABLE' });
        else if (mv.from_location_id) await this.inv.addStock(tx, { ...base, location_id: mv.from_location_id, status: mv.from_status ?? 'AVAILABLE' });
      }
      await tx.receipt.update({ where: { id }, data: { status: 'CANCELLED', remark: `${rc.remark ?? ''}【已撤销：${reason.trim()}】`.slice(0, 1000) } });
      return { ok: true, no: rc.no, reversed: moves.length };
    });
  }

  /** 用户账号批量开户：初始密码留空则生成，有工牌未填 PIN 时生成 PIN；返回初始密码分发清单（仅本次） */
  private async users(tx: Tx, spec: ImportSpec, rows: DataRow[], admin: CurrentUser, errors: RowError[], check: boolean): Promise<RunResult> {
    const f = spec.fields;
    const passwords: Record<string, unknown>[] = [];
    const seenUser = new Map<string, number>();
    const seenBadge = new Map<string, number>();
    let created = 0;
    for (const { line, data: row } of rows) {
      try {
        await this.savepoint(tx, async () => {
          const username = cellText(pick(row, f.username) || '').trim();
          const fullName = cellText(pick(row, f.full_name) || '').trim();
          if (!username || !fullName) throw new BizError('登录账号和姓名不能为空');
          if (seenUser.has(username)) throw new BizError(`账号 ${username} 与第 ${seenUser.get(username)} 行重复`);
          seenUser.set(username, line);
          const rolesText = cellText(pick(row, f.roles) || '');
          const roles = parseRoles(rolesText);
          if (!roles.length) throw new BizError(`请填写角色（可选：${Object.values(ROLES).map((r) => r.name).join('、')}）`);
          const badge = cellText(pick(row, f.badge_no) || '').trim() || null;
          if (badge) {
            if (seenBadge.has(badge)) throw new BizError(`工牌号 ${badge} 与第 ${seenBadge.get(badge)} 行重复`);
            seenBadge.set(badge, line);
          }
          const pinCell = pick(row, f.pin);
          const pin = pinCell === null ? null : cellText(pinCell).trim();
          if (pin && !/^\d{4,8}$/.test(pin)) throw new BizError(`工位 PIN“${pin}”须为 4–8 位数字（以 0 开头的 PIN 请把单元格设为文本格式）`);
          const srcText = cellText(pick(row, f.auth_source) || '').trim();
          if (srcText && !has(AUTH_SOURCE, srcText)) throw new BizError(`无法识别的登录方式：${srcText}（可选：本系统、金蝶）`);
          const auth_source = srcText ? AUTH_SOURCE[srcText] : 'LOCAL';
          const r = await createUserTx(tx, {
            username, full_name: fullName, roles, department: cellText(pick(row, f.department) || '') || null, email: cellText(pick(row, f.email) || '') || null,
            auth_source, password: cellText(pick(row, f.password) || '') || null, generate_password: true, badge_no: badge, pin, generate_pin: true,
          }, admin, check);
          created++;
          if (!check) {
            passwords.push({
              row: line, username, full_name: fullName, roles: roles.map((c) => ROLES[c]?.name ?? c).join('、'), department: r.user.department,
              badge_no: r.user.badge_no, auth_source, temp_password: auth_source === 'KINGDEE' ? null : r.temp_password ?? '（文件中指定）', temp_pin: r.temp_pin,
            });
          }
        });
      } catch (e) {
        errors.push({ row: line, message: errMsg(e) });
      }
    }
    return { created, updated: 0, extra: check ? {} : { passwords } };
  }
}
