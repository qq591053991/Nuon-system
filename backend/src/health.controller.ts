import { Controller, Get } from '@nestjs/common';
import { Public } from './auth';
import { config } from './config';

@Controller()
export class HealthController {
  @Public()
  @Get('health')
  health() {
    return { status: 'ok', app: config.appName };
  }
}
