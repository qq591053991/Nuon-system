import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsBoolean, IsString } from 'class-validator';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { getSpec } from './import-specs';
import { ImportService } from './import.service';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

class MigrationModeDto {
  @IsBoolean() enabled: boolean;
}
class RevertDto {
  @IsString() reason: string;
}

/**
 * 数据导入：GET 模板（.xlsx，含填写说明与下拉）；POST 上传（multipart 字段 file，.xlsx 或 .csv）。
 * 上传时可带 mode=check（预检查，不写入）与 on_duplicate=overwrite（期初库存覆盖为导入数），表单字段或查询参数均可。
 * 每类数据按实体分权限（GET /import/options 返回当前账号可导入哪些）。
 */
@Controller('import')
export class ImportController {
  constructor(private readonly svc: ImportService) {}

  /** 导入页面：各类数据的列定义、当前账号能否导入及原因、上线迁移模式、已有数据量 */
  @Get('options')
  options(@User() user: CurrentUser) {
    return this.svc.options(user);
  }

  /** 上线迁移模式（管理员）：开启时系统管理员可导入全部业务数据；上线完成后关闭 */
  @Post('migration-mode')
  @Perms('admin')
  setMigrationMode(@Body() b: MigrationModeDto, @User() user: CurrentUser) {
    return this.svc.setMigrationMode(b.enabled, user);
  }

  @Get('templates/:entity')
  async template(@Param('entity') entity: string) {
    const buf = await this.svc.template(entity);
    const name = encodeURIComponent(`${getSpec(entity)?.title ?? entity}导入模板.xlsx`);
    return new StreamableFile(buf, { type: XLSX_MIME, disposition: `attachment; filename=${entity}_template.xlsx; filename*=UTF-8''${name}` });
  }

  /** 期初库存导入批次（期初入库单） */
  @Get('stock/batches')
  @Perms('wms', 'admin')
  stockBatches(@Query() q: Record<string, string>) {
    return this.svc.stockBatches(q);
  }

  /** 整批撤销期初导入（反向流水；库存已被领用则不能撤销） */
  @Post('stock/batches/:id/revert')
  @Perms('wms', 'admin')
  revert(@Param('id', ParseIntPipe) id: number, @Body() b: RevertDto, @User() user: CurrentUser) {
    return this.svc.revertStockBatch(id, b.reason, user);
  }

  @Post(':entity')
  @Perms('master', 'engineering', 'wms', 'admin')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  run(
    @Param('entity') entity: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @User() user: CurrentUser,
    @Body() body: Record<string, string> = {},
    @Query() query: Record<string, string> = {},
  ) {
    const mode = (body?.mode ?? query.mode) === 'check' ? 'check' : 'import';
    const onDuplicate = (body?.on_duplicate ?? query.on_duplicate) === 'overwrite' ? 'overwrite' : 'error';
    return this.svc.run(entity, file, user, { mode, onDuplicate });
  }
}
