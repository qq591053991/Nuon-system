/** 表格文件读取：Excel(.xlsx) / CSV（UTF-8，含 BOM；非 UTF-8 时按 GBK 解码，兼容金蝶/Excel 中文导出） */
import ExcelJS from 'exceljs';
import { dateOnly } from '../common/dates';
import { BizError } from '../common/errors';

export type Cell = string | number | boolean | Date | null;

/** 一行数据：line = 文件中的行号（与 Excel 行号一致，便于用户定位错误） */
export interface DataRow {
  line: number;
  data: Record<string, Cell>;
}

const isBlank = (c: Cell | undefined) => c === null || c === undefined || c === '';

/** 解码 CSV 文本：优先严格 UTF-8（自动去掉 BOM），失败则按 GBK 解码 */
export function decodeText(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('gbk').decode(buf);
  }
}

/** CSV 解析（RFC 4180：逗号分隔、双引号转义、引号内可换行） */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let atStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && atStart) {
      quoted = true;
      atStart = false;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      atStart = true;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      atStart = true;
    } else {
      field += ch;
      atStart = false;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function cellValue(v: ExcelJS.CellValue | undefined): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result as ExcelJS.CellValue); // 公式取计算结果
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text); // 超链接
    if ('error' in v) return null;
  }
  return String(v);
}

async function readXlsx(buf: Buffer): Promise<Cell[][]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as any);
  } catch {
    throw new BizError('无法读取文件，请上传 Excel(.xlsx) 或 CSV 文件');
  }
  const ws = wb.worksheets[wb.views?.[0]?.activeTab ?? 0] ?? wb.worksheets[0];
  if (!ws) return [];
  const grid: Cell[][] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells: Cell[] = [];
    for (let c = 1; c <= row.cellCount; c++) cells.push(cellValue(row.getCell(c).value));
    grid.push(cells);
  }
  return grid;
}

/**
 * 读取数据行：跳过金蝶导出顶部的标题行（取第一行至少两个非空单元格的行为表头），跳过空行。
 * 返回每行 {表头: 值}，行号为文件中的实际行号。
 */
export async function readRows(buf: Buffer, filename: string): Promise<DataRow[]> {
  const grid: Cell[][] = (filename || '').toLowerCase().endsWith('.csv') ? parseCsv(decodeText(buf)) : await readXlsx(buf);
  const hi = grid.findIndex((r) => r.filter((c) => !isBlank(c)).length >= 2);
  if (hi < 0) return [];
  const header = grid[hi].map((c) => (c === null || c === undefined ? '' : cellText(c).trim()));
  const out: DataRow[] = [];
  for (let r = hi + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row.length || row.every(isBlank)) continue;
    const data: Record<string, Cell> = {};
    for (let i = 0; i < Math.min(header.length, row.length); i++) data[header[i]] = row[i] ?? null;
    out.push({ line: r + 1, data });
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 单元格转文本（日期输出 YYYY-MM-DD[ HH:MM:SS]） */
export function cellText(v: Cell): string {
  if (v instanceof Date) {
    const d = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    const t = `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}`;
    return t === '00:00:00' ? d : `${d} ${t}`;
  }
  return String(v);
}

/** 按别名取值：第一个非空的列；文本去掉首尾空格 */
export function pick(row: Record<string, Cell>, aliases: string[]): Cell {
  for (const a of aliases) {
    const v = row[a];
    if (!isBlank(v)) return typeof v === 'string' ? v.trim() : v;
  }
  return null;
}

/** 数字（允许千分位逗号、百分号） */
export function num(v: Cell, def: number): number {
  if (isBlank(v)) return def;
  if (typeof v === 'number') return v;
  const s = cellText(v).replace(/,/g, '').replace(/%/g, '').trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) throw new BizError(`数值格式错误：${cellText(v)}`);
  return Number(s);
}

/** 日期：Excel 日期单元格、Excel 日期序列号或 YYYY-MM-DD / YYYY/MM/DD 文本（校验月/日范围） */
export function excelDate(v: Cell): Date | null {
  if (isBlank(v)) return null;
  if (typeof v === 'number' && v > 0 && v < 2958466) return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
  if (v instanceof Date) return dateOnly(v);
  const s = cellText(v).trim();
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || d.getUTCMonth() + 1 !== Number(m[2]) || d.getUTCDate() !== Number(m[3])) throw new BizError(`日期格式错误：${s}`);
  return d;
}
