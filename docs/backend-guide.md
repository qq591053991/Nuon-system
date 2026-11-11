# 后端开发约定（NestJS + Prisma + PostgreSQL）

代码在 `backend/`。启动：`cd backend && npm install && npx prisma migrate deploy && npm run seed -- --demo && npm run start:dev`，接口文档 `http://localhost:8000/api/docs`。

## 目录

```
backend/
  prisma/schema.prisma        数据模型（字段 snake_case，与接口 JSON 一致）；改模型后 `npx prisma migrate dev --name xxx`
  src/
    common/                   基础设施（一般不用改）
      prisma.service.ts       PrismaService：db.client（带审计的客户端）、db.tx(fn)（事务）
      presenter.ts            输出视图：ser()/serList()/inc()，以及每个模型的计算字段（customer_name 等）
      paginate.ts             paginate()、like()、inList()
      crud.ts                 通用主数据 CRUD 控制器工厂
      errors.ts               BizError（400 + 中文提示）、NotFound（404）
      dates.ts                today()、dateOnly()、addDays()、yymmdd()…（工厂时区）
      num.ts                  round()(4 位)、round2()、EPS、g()（数字转文本）
    auth/                     @Public()、@Perms('qa')、@User() user、角色定义
    core/                     全局服务：InventoryService（库存核心）、NumberingService（单据号）、EsignService（电子签名）、aql、udi、engineering（已发布 BOM/工艺）
    master/ erp/ wms/ qms/ mes/ report/ imports/ system/   各业务域：*.service.ts（业务规则）+ *.controller.ts（接口）+ *.module.ts
    seed/                     基础数据 + 演示数据
  test/                       Jest 端到端测试（harness.ts 提供 api.as('qa').ok('post', url, body)）
```

## 必须遵守的规则

1. **所有写操作放进事务**：`return this.db.tx(async (tx) => { ... })`，事务内只用 `tx` 访问数据库。审计追踪、库存流水会自动与业务数据同事务提交/回滚。只读查询用 `this.db.client`。
2. **库存只能通过 `InventoryService` 变动**（addStock / removeStock / moveStock / changeLotStatus / allocate），不要直接改 `wms_stock`。
3. **返回值统一用视图序列化**：查询时 `include: inc('SalesOrder', ['lines'])`，返回 `ser('SalesOrder', row, ['lines'])`；列表用 `paginate(this.db.client.salesOrder, 'SalesOrder', { where, orderBy, children }, query)`。新增计算字段时在 `presenter.ts` 的 `VIEWS` 里登记。
4. **业务错误抛 `BizError('中文提示')`**，前端会直接弹出；找不到记录抛 `NotFound('销售订单')`。
5. **权限**：控制器方法加 `@Perms('wms', 'plan')`（任一即可）；默认所有接口都要求登录，公开接口加 `@Public()`。
6. **关键质量操作必须电子签名**：`await this.esign.sign(tx, user, body.signature, '产品放行（DHR审核批准）', 'mes_work_order', wo.id, wo.no)`。
7. **单据号**：`await this.numbering.nextNo(tx, 'SO')` → `SO261111001`。
8. **请求体用 DTO 类 + class-validator 装饰器**。全局 `ValidationPipe` 开了 `whitelist`：**没有装饰器的字段会被丢弃**，可选字段加 `@IsOptional()`；嵌套数组用 `@ValidateNested({ each: true }) @Type(() => LineDto)`。纯日期字段按字符串接收，用 `dateOnly()` 转换。
9. **数量/金额**：Float 存储，计算后 `round()`（数量 4 位）/ `round2()`（金额）。
10. 成功的 POST 返回 200（全局拦截器处理）；错误格式统一为 `{ "detail": "..." }`。

## 测试

```bash
cd backend
DATABASE_URL=postgresql://user@host/nuon_test npx prisma migrate deploy   # 测试库（会被清空！）
DATABASE_URL=postgresql://user@host/nuon_test npm test
```

每个用例前 `t.reset()` 会清空数据库并写入基础数据（与演示环境相同的客户、物料、BOM、工艺、期初库存、销售订单）。
