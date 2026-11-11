# 评审改进：并行开发规则（4 个开发代理共用）

背景：`docs/design-review.md` 列出了上线前问题。数据库结构已由协调者一次性改好并迁移（`backend/prisma/migrations/20261111210000_review_improvements`），**各代理只写业务代码，不改数据库结构**。

## 硬性规则

1. **不得修改** `backend/prisma/schema.prisma` 与 `backend/prisma/migrations/`，不得运行 `prisma migrate`。确需结构变更时，在最终报告中说明。
2. **不得运行** `npm install`、`vite build`/`npm run build`（前端）、任何 `git` 命令。不要停止 PostgreSQL（127.0.0.1:55432）。
3. **只在自己负责的文件中修改**（见各自任务说明）。下列**共享文件**允许小范围追加，但每次编辑前必须重新读取该文件，只追加/修改与自己任务相关的几行，不要重排或重写其他内容：
   - 后端：`src/config.ts`、`src/app.module.ts`、`src/common/presenter.ts`（VIEWS 中追加新模型视图）、各 `*.module.ts` 的注册列表、`src/seed/seed-base.ts`（在末尾 `return` 之前追加自己的独立代码块）
   - 前端：`src/routes.tsx`（追加路由与菜单项）、`src/utils/dict.ts`（追加字典项）
4. 类型检查：`cd backend && npx tsc --noEmit -p tsconfig.json`；`cd frontend && npx tsc -b --noEmit`。你的文件必须零错误（其他代理进行中的文件报错可忽略）。
5. 测试只用自己的数据库：`cd backend && DATABASE_URL=postgresql://postgres@127.0.0.1:55432/<你的库> npx jest --runInBand test/<文件>`。新增测试写在自己的新测试文件中；修改已有测试只限于因自己的改动导致的预期变化。结束前请对自己的库跑一遍完整套件 `npx jest --runInBand`，并在报告中说明失败项及原因（是否由他人的进行中改动引起）。
6. 如需启动服务或浏览器自测：后端用自己的端口，前端 `npx vite --port <端口> --strictPort` 并设置 `VITE_API_TARGET=http://127.0.0.1:<后端端口>`；Playwright 直接 `chromium.launch()`，**不要**使用远程调试端口；临时文件放在 scratchpad 下自己的子目录。结束时停止自己启动的所有进程。
7. 规范遵循 `docs/backend-guide.md`、`docs/frontend-guide.md`：写操作走 `this.db.tx`、库存只走 `InventoryService`、业务错误 `BizError('中文')`、关键质量操作电子签名、DTO + class-validator（whitelist 会丢弃未加装饰器的字段）。金额字段是 `Prisma.Decimal`，计算前用 `num()` 转数字，写入用 `round2()`。
8. 全部 UI 文案中文；前端按状态显示可执行操作；危险/过账操作二次确认。

## 分工与数据库

| 代理 | 范围 | 测试库 | 自测端口（后端/前端） |
|---|---|---|---|
| 1 数据与财务 | 库存并发、汇率与多币别、金额、采购单位换算、MRP 分时段 | nuon_e2e_a | 8101 / 5201 |
| 2 安全与合规 | 职责分离、BOM/工艺双人签名、审计封存与校验、密码策略与锁定、工牌登录接口、空闲超时、安全响应头 | nuon_e2e_b | 8102 / 5202 |
| 3 生产 | 工位刷卡切换操作员、返工换件追溯、DHR 分批放行、人员资质校验 | nuon_e2e_c | 8103 / 5203 |
| 4 质量/仓储逆向与运维 | 物料检验规范、退料、客户退货、客诉、附件、备份与运维文档 | nuon_e2e_d | 8104 / 5204 |

## 跨代理接口约定（按此编码，不要等待对方）

- **工牌登录（代理 2 实现，代理 3 调用）**：`POST /api/auth/badge-login`，请求 `{ badge_no, pin }`，响应与 `/api/auth/login` 相同 `{ access_token, token_type, user }`；失败 401 `{detail}`。只允许启用状态、且拥有 `mes` 权限的用户。
- **放行判定（代理 3 实现）**：成品序列号可发货的条件改为 `SerialNumber.release_id` 不为空（属于某个已放行批），批量产品按放行数量控制；原整单放行接口保留（等价于把剩余全部放行）。
- **采购单位（代理 1 实现）**：`PurchaseOrderLine.qty` 始终是库存单位数量；`purchase_qty/purchase_uom/purchase_price` 仅为下单单位信息。收货仍按库存单位。
- **汇率（代理 1 实现）**：`md_exchange_rate`（1 外币 = rate 本位币），本位币由环境变量 `BASE_CURRENCY`（默认 CNY）决定。
