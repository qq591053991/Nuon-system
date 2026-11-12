/**
 * 端到端测试工具：每个用例前重置数据库并写入基础数据。
 *   const t = await bootApp();  beforeEach(() => t.reset());  afterAll(() => t.close());
 *   const so = await t.api.as('sales').ok('post', '/api/sales-orders/1/confirm');
 * 需要环境变量 DATABASE_URL 指向测试库（会被清空！）。
 */
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/common/prisma.service';
import { resetLoginFailures } from '../src/auth/auth.service';
import { DEMO_PASSWORD, resetDatabase, seedBase } from '../src/seed/seed-base';

export const SIG = { password: DEMO_PASSWORD, reason: '测试' };

type Method = 'get' | 'post' | 'put' | 'delete';

export class Api {
  constructor(private readonly app: INestApplication, private readonly tokens: Map<string, string>, readonly user = 'admin') {}

  as(user: string) {
    return new Api(this.app, this.tokens, user);
  }

  private async token(): Promise<string> {
    if (!this.tokens.has(this.user)) {
      const r = await request(this.app.getHttpServer()).post('/api/auth/login').send({ username: this.user, password: DEMO_PASSWORD });
      if (r.status !== 200) throw new Error(`登录失败 ${this.user}: ${r.status} ${JSON.stringify(r.body)}`);
      this.tokens.set(this.user, r.body.access_token);
    }
    return this.tokens.get(this.user)!;
  }

  /** 发请求，返回 supertest 响应（status/body） */
  async req(method: Method, url: string, body?: unknown, query?: Record<string, unknown>) {
    const r = request(this.app.getHttpServer())[method](url).set('Authorization', `Bearer ${await this.token()}`);
    if (query) r.query(query);
    return body !== undefined ? r.send(body as object) : r;
  }
  get = (url: string, query?: Record<string, unknown>) => this.req('get', url, undefined, query);
  post = (url: string, body?: unknown) => this.req('post', url, body ?? {});
  put = (url: string, body?: unknown) => this.req('put', url, body ?? {});
  del = (url: string) => this.req('delete', url);

  /** 断言 200 并返回 body */
  async ok(method: Method, url: string, body?: unknown, query?: Record<string, unknown>) {
    const r = await this.req(method, url, method === 'get' ? undefined : (body ?? {}), method === 'get' ? (body as Record<string, unknown>) ?? query : query);
    if (r.status !== 200 && r.status !== 201) throw new Error(`${method.toUpperCase()} ${url} -> ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  }

  /** 未登录请求 */
  c_get_noauth(url: string) {
    return request(this.app.getHttpServer()).get(url);
  }
  c_login(username: string, password: string) {
    return request(this.app.getHttpServer()).post('/api/auth/login').send({ username, password });
  }

  /** 上传文件（multipart, 字段名 file） */
  async upload(url: string, filename: string, content: Buffer) {
    return request(this.app.getHttpServer()).post(url).set('Authorization', `Bearer ${await this.token()}`).attach('file', content, filename);
  }

  /** 列表第一条 */
  async find(url: string, query: Record<string, unknown>) {
    // 查找辅助（非权限测试）：admin 只管账号与审计、读不到业务单据，此时改用厂长账号查
    const reader = this.user === 'admin' ? this.as('manager') : this;
    const items = (await reader.ok('get', url, query)).items;
    if (!items.length) throw new Error(`no items for ${url} ${JSON.stringify(query)}`);
    return items[0];
  }

  /** 常用主数据 id 映射 */
  async ids() {
    const m: Record<string, number> = {};
    const loc: Record<string, number> = {};
    const eq: Record<string, number> = {};
    for (const x of (await this.ok('get', '/api/materials', { page_size: 200 })).items) m[x.code] = x.id;
    for (const x of (await this.ok('get', '/api/locations', { page_size: 200 })).items) loc[x.code] = x.id;
    for (const x of (await this.ok('get', '/api/equipment', { page_size: 200 })).items) eq[x.code] = x.id;
    return { m, loc, eq };
  }
}

export async function bootApp() {
  process.env.BCRYPT_ROUNDS ||= '4';
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(mod.createNestApplication({ logger: ['error'] }));
  await app.init();
  const db = app.get(PrismaService);
  const tokens = new Map<string, string>();
  return {
    app,
    db,
    api: new Api(app, tokens),
    async reset() {
      tokens.clear();
      resetLoginFailures();
      await resetDatabase(db);
      await seedBase(db);
    },
    close: () => app.close(),
  };
}
