import { Global, Module } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../common/prisma.service';
import { EsignService } from './esign.service';
import { InventoryService } from './inventory.service';
import { NumberingService } from './numbering.service';

/** 全局核心服务：数据库（含审计）、单据编号、库存核心、电子签名 */
@Global()
@Module({
  providers: [PrismaService, NumberingService, InventoryService, EsignService, AuthService],
  exports: [PrismaService, NumberingService, InventoryService, EsignService, AuthService],
})
export class CoreModule {}
