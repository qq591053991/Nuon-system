import { Module } from '@nestjs/common';
import { AuthController } from '../auth/auth.controller';
import { config } from '../config';
import { SystemController } from './system.controller';
import { TestSupportController } from './test-support.controller';

@Module({ controllers: [AuthController, SystemController, ...(config.enableTestReset ? [TestSupportController] : [])] })
export class SystemModule {}
