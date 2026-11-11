import { BadRequestException, type INestApplication, ValidationPipe } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { als } from './common/context';
import { config } from './config';
import { securityHeaders } from './security-headers';

/** 应用全局配置（main.ts 与端到端测试共用） */
export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('api');
  // 安全响应头（X-Content-Type-Options / X-Frame-Options / Referrer-Policy / CSP 等），并隐藏 X-Powered-By
  app.getHttpAdapter().getInstance().disable?.('x-powered-by');
  app.use(securityHeaders);
  app.enableCors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins, credentials: true });
  // 每个请求一个上下文（当前用户、当前事务），供审计追踪使用
  app.use((_req: Request, _res: Response, next: NextFunction) => als.run({}, () => next()));
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      transformOptions: { enableImplicitConversion: false },
      exceptionFactory: (errors) =>
        new BadRequestException({
          detail: errors
            .flatMap(function flat(e): string[] {
              return [...Object.values(e.constraints ?? {}).map((m) => `${e.property}: ${m}`), ...(e.children ?? []).flatMap(flat)];
            })
            .join('；'),
        }),
    }),
  );
  return app;
}
