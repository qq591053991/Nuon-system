import { Module } from '@nestjs/common';
import { WmsModule } from '../wms/wms.module';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';

/** 数据导入（金蝶等旧系统迁移）：物料、客户、供应商、BOM、期初库存 */
@Module({ imports: [WmsModule], controllers: [ImportController], providers: [ImportService] })
export class ImportModule {}
