import { Module } from '@nestjs/common';
import { QmsModule } from '../qms/qms.module';
import { WmsController } from './wms.controller';
import { WmsService } from './wms.service';
import { ReturnsController } from './returns.controller';
import { ReturnsService } from './returns.service';
import { CustomerReturnsController } from './customer-returns.controller';
import { CustomerReturnsService } from './customer-returns.service';
import { WmsOpsController } from './ops.controller';
import { WmsOpsService } from './ops.service';

/** 仓储：库存、收货、领料、发货、调拨、盘点（WmsService 供 ERP 采购收货、数据导入、演示数据调用） */
@Module({
  imports: [QmsModule],
  controllers: [WmsController, ReturnsController, CustomerReturnsController, WmsOpsController],
  providers: [WmsService, ReturnsService, CustomerReturnsService, WmsOpsService],
  exports: [WmsService],
})
export class WmsModule {}
