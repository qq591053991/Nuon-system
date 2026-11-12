/**
 * 通用 Excel 导出：前端把当前筛选条件下的全部数据按列定义提交，这里生成 .xlsx。
 * 只做格式化，不读取数据库（数据可见性由各列表接口的权限控制）。
 */
import { Body, Controller, Post, Res } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsNumber, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { AllowNoRole } from '../auth';
import { BizError } from '../common/errors';

class ExportColumnDto {
  @IsString() @MaxLength(64) title: string;
  @IsString() @MaxLength(64) key: string;
  @IsOptional() @IsNumber() width?: number;
  @IsOptional() @IsIn(['text', 'number', 'money', 'date', 'datetime']) type?: string;
}

class ExportDto {
  @IsString() @MaxLength(100) filename: string;
  @IsOptional() @IsString() @MaxLength(31) sheet?: string;
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => ExportColumnDto) columns: ExportColumnDto[];
  @IsArray() rows: Record<string, unknown>[];
}

const MAX_ROWS = 50000;

@Controller('export')
export class ExportController {
  @AllowNoRole()
  @Post('xlsx')
  async xlsx(@Body() b: ExportDto, @Res() res: Response) {
    if (!b.columns.length) throw new BizError('没有可导出的列');
    if (b.rows.length > MAX_ROWS) throw new BizError(`一次最多导出 ${MAX_ROWS} 行，请缩小筛选范围`);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Nuon 智造云';
    wb.created = new Date();
    const ws = wb.addWorksheet((b.sheet || b.filename).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');
    let headerRow = 1;
    if (b.title) {
      ws.addRow([b.title]).font = { bold: true, size: 13 };
      ws.mergeCells(1, 1, 1, b.columns.length);
      headerRow = 2;
    }
    const header = ws.addRow(b.columns.map((c) => c.title));
    header.font = { bold: true };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEAFB' } };
    for (const r of b.rows) {
      ws.addRow(
        b.columns.map((c) => {
          const v = r?.[c.key];
          if (v === null || v === undefined || v === '') return null;
          if (c.type === 'number' || c.type === 'money') {
            const n = Number(v);
            return Number.isFinite(n) ? n : String(v);
          }
          if (c.type === 'date' || c.type === 'datetime') {
            const d = new Date(String(v));
            return Number.isNaN(d.getTime()) ? String(v) : d;
          }
          return typeof v === 'object' ? JSON.stringify(v) : (v as any);
        }),
      );
    }
    b.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = c.width ?? Math.min(40, Math.max(10, c.title.length * 2 + 2));
      if (c.type === 'money') col.numFmt = '#,##0.00';
      if (c.type === 'date') col.numFmt = 'yyyy-mm-dd';
      if (c.type === 'datetime') col.numFmt = 'yyyy-mm-dd hh:mm';
    });
    ws.views = [{ state: 'frozen', ySplit: headerRow }];
    ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: b.columns.length } };
    const name = `${b.filename.replace(/[\\/:*?"<>|]/g, '_')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`);
    await wb.xlsx.write(res);
    res.status(200).end();
  }
}
