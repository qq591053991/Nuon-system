import { Module } from '@nestjs/common';
import { WmsModule } from '../wms/wms.module';
import { FinanceController, MrpController, PurchaseOrderController, SalesOrderController } from './erp.controller';
import { FinanceService } from './finance.service';
import { MrpService } from './mrp.service';
import { PurchaseService } from './purchase.service';
import { SalesService } from './sales.service';

/** ERP：销售订单、采购订单（收货调用仓储服务）、MRP、应收应付 */
@Module({
  imports: [WmsModule],
  controllers: [SalesOrderController, PurchaseOrderController, MrpController, FinanceController],
  providers: [SalesService, PurchaseService, MrpService, FinanceService],
  exports: [SalesService, PurchaseService, MrpService, FinanceService],
})
export class ErpModule {}
