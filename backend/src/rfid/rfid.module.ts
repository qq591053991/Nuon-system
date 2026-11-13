import { Module } from '@nestjs/common';
import { WmsModule } from '../wms/wms.module';
import { RfidController } from './rfid.controller';
import { RfidSessionService } from './rfid-session.service';
import { RfidService } from './rfid.service';

/** RFID（仓库）：读写器、标签、读取接入、作业会话（收货台 / 库门 / 领料核对 / 完工入库 / 发货核对 / 盘点 / 客户退货）。库存变动全部复用 WmsModule 的服务。 */
@Module({
  imports: [WmsModule],
  controllers: [RfidController],
  providers: [RfidService, RfidSessionService],
  exports: [RfidService],
})
export class RfidModule {}
