import { Module } from '@nestjs/common';
import { QmsModule } from '../qms/qms.module';
import { WmsController } from './wms.controller';
import { WmsService } from './wms.service';

/** 仓储：库存、收货、领料、发货、调拨、盘点（WmsService 供 ERP 采购收货、数据导入、演示数据调用） */
@Module({ imports: [QmsModule], controllers: [WmsController], providers: [WmsService], exports: [WmsService] })
export class WmsModule {}
