import { Module } from '@nestjs/common';
import { QmsModule } from '../qms/qms.module';
import { WmsService } from './wms.service';

@Module({ imports: [QmsModule], providers: [WmsService], exports: [WmsService] })
export class WmsModule {}
