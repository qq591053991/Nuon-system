import { Module } from '@nestjs/common';
import { WmsModule } from '../wms/wms.module';

@Module({ imports: [WmsModule] })
export class ErpModule {}
