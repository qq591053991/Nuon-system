import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import express from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { config } from './config';

async function main() {
  const app = configureApp(await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] }));
  const log = new Logger('Nuon');
  if (config.secretKey.startsWith('nuon-dev-secret-key')) log.warn('正在使用默认 SECRET_KEY，生产环境请通过环境变量 SECRET_KEY 设置随机密钥！');

  const doc = new DocumentBuilder().setTitle(config.appName).setDescription('光疗医疗器械代工 ERP/MES/WMS/QMS 接口').setVersion('1.0').addBearerAuth().build();
  SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, doc));

  // 可选：直接托管前端构建产物（生产推荐由 Nginx 托管）
  const dist = resolve(process.env.FRONTEND_DIST || join(__dirname, '..', '..', 'frontend', 'dist'));
  if (existsSync(join(dist, 'index.html'))) {
    const http = app.getHttpAdapter().getInstance();
    http.use(express.static(dist, { index: false }));
    http.get(/^\/(?!api\/).*/, (_req: express.Request, res: express.Response) => res.sendFile(join(dist, 'index.html')));
  }
  await app.listen(config.port, '0.0.0.0');
  log.log(`${config.appName} 已启动：http://localhost:${config.port}/api/docs`);
}
main();
