# 好用性修复：并行开发规则（7 个修复代理共用）

背景：`docs/ux-review.md` 是 5 个岗位代理用真实浏览器体验后的问题清单。本轮目标是把系统从“能用”改到“好用、顺手”。
数据库结构已由协调者一次性改好并迁移（`backend/prisma/migrations/20261112090000_ux_improvements`，字段见下文“已备好的字段”）；通用组件（G0）已完成，**各代理必须复用**，不要自己另写一套。

**评价标准**：修完后同一批岗位代理会按原场景复测，并对照 `docs/ux-review.md` 第三节的“步数目标”验收。每改一处都要问：高频操作是否更少步？扫码/键盘能否不碰鼠标？出错提示是否说清“哪里错、怎么办”？默认值能否少填？

## 一、硬性规则

1. **不得修改** `backend/prisma/schema.prisma` 与 `backend/prisma/migrations/`，不得运行 `prisma migrate` / `prisma generate`。确需结构变更时：先用已有字段完成其余工作，在最终报告中写出**确切**的字段定义，由协调者统一加。
2. **不得运行** `npm install`、`npm run build` / `vite build`、任何 `git` 命令。不要停止 PostgreSQL（127.0.0.1:55432）。**绝对不要用 `pkill`/`killall` 按名字杀进程**（会杀掉其他代理的服务），只用 `fuser -k <你的端口>/tcp`。
3. **只修改自己负责的文件**（见第四节）。**共享文件**允许小范围修改：每次编辑前重新读取，只追加/修改与自己任务相关的行，不重排、不重写别人的内容：
   - 后端：`src/common/presenter.ts`（VIEWS 追加/修改自己模型的计算字段）、各 `*.module.ts` 的注册列表、`src/app.module.ts`、`src/config.ts`、`src/erp/erp.controller.ts` 与 `src/erp/erp.dto.ts`（G3 只改 `SalesOrderController`/`MrpController` 及相关 DTO，G4 只改 `PurchaseOrderController`/`FinanceController` 及相关 DTO；新接口优先放进自己新建的控制器文件）、`src/master/master.module.ts` 中的通用 CRUD 定义（只改自己负责的实体）
   - 前端：`src/routes.tsx`（追加路由与菜单项；菜单结构与权限由 G1 负责）、`src/utils/dict.ts`（追加字典项）、`src/pages/master/MasterPages.tsx`（只改自己负责的实体段落：客户→G3，供应商→G4，设备→G5，物料默认库位/库位→G7）
   - **G0 通用组件**（`components/RemoteSelect.tsx`、`ESign.tsx`、`ExportButton.tsx`、`Print.tsx`、`ResponsiveTable.tsx`、`ScanInput.tsx`、`usePaged.ts`、`utils/scan.ts`、`backend/src/system/export.controller.ts`、`common/paginate.ts`）：**不要修改**；发现缺陷在报告里写明，可在自己的文件里临时包一层。
4. 类型检查：`cd backend && npx tsc --noEmit -p tsconfig.json`；`cd frontend && npx tsc -b --noEmit`。你的文件必须零错误（别人进行中的文件报错可忽略，但要在报告中注明）。
5. **测试只用自己的测试库**（会被清空）：`cd backend && DATABASE_URL=postgresql://postgres@127.0.0.1:55432/<测试库> npx jest --runInBand test/<文件>`。新增测试写在自己的新文件 `test/ux-<组>.e2e-spec.ts`；修改已有测试只限于因自己的改动导致的预期变化（在报告中逐条说明）。结束前对自己的测试库跑一遍完整套件。
6. **浏览器自测**（必须做，好用性靠眼睛验证）：后端用自己的端口和**演示库**（已迁移并灌好演示数据，可随意改；需要重置时 `DATABASE_URL=… npx ts-node --transpile-only src/seed/seed.ts --reset --demo`）：
   ```bash
   cd /home/user/Nuon-system/backend
   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/<演示库> PORT=<后端端口> ATTACHMENT_DIR=<临时目录>/att \
     nohup npx ts-node --transpile-only src/main.ts > <临时目录>/server.log 2>&1 &
   cd ../frontend && VITE_API_TARGET=http://127.0.0.1:<后端端口> nohup npx vite --port <前端端口> --strictPort > <临时目录>/vite.log 2>&1 &
   ```
   改了后端代码要重启自己的后端（`fuser -k <后端端口>/tcp` 后重启）；Vite 会热更新。Playwright：`require('playwright')`，`chromium.launch()`（不要远程调试端口），截图后用 Read 查看。临时文件只放在 `/tmp/claude-0/-home-user-Nuon-system/d5c71dc8-f3d1-5d57-b7c6-c69615d38274/scratchpad/fix-<组>/`。结束时停止自己启动的所有进程。
   账号（密码均 `Nuon@2026`）：admin、manager、sales、buyer、pmc、engineer、wh、op1/op2（工牌 E1001/PIN 1234、E1002/PIN 5678）、qc、qa、finance。屏幕：办公室 1366×768；车间一体机 1280×800；PDA 360×780。
7. 规范遵循 `docs/backend-guide.md`、`docs/frontend-guide.md`：写操作走 `this.db.tx`、库存只走 `InventoryService`、业务错误 `BizError('中文')`、关键质量操作电子签名、DTO + class-validator（whitelist 会丢弃未加装饰器的字段）、金额 `Prisma.Decimal`（计算前 `num()`，写入 `round2()`）。电子记录（审计、签名、库存流水）不可改删——冲销一律用**反向流水**。
8. 全部 UI 文案中文、用工厂里的叫法；按状态只显示可执行操作；危险/过账操作二次确认；报错说清“哪里错了、怎么办”。

## 二、分工、数据库与端口

| 组 | 范围（详见 ux-review.md 第二节） | 测试库 | 演示库 | 后端/前端端口 |
|---|---|---|---|---|
| G1 平台与岗位工作台 | 权限可读矩阵、按岗位菜单/工作台/首页、待办与 KPI 下钻、交付风险、窄屏外壳、全局搜索、登录页 | nuon_e2e_a | nuon_fix_g1 | 8211 / 5311 |
| G2 系统管理与导入 | 期初重复导入、预置账号、强制改密、导入权限与模板、审计可读、用户管理批量、签名台账 | nuon_e2e_b | nuon_fix_g2 | 8212 / 5312 |
| G3 销售/计划/MRP | 订单变更/反审核、订单与 MRP 工单去重、MRP 例外、齐套分析、行录入、倒排、工单调整、订单打印 | nuon_e2e_c | nuon_fix_g3 | 8213 / 5313 |
| G4 采购/财务 | 采购单变更与回复交期、催货清单、采购单位、采购单打印、财务筛选导出、汇率与汇兑、收付款作废 | nuon_e2e_d | nuon_fix_g4 | 8214 / 5314 |
| G5 工位/工程 | 工位回车/焦点 P0、全屏工位模式、扫码即过站、PIN/锁屏、设备与资质校验、返工引导、工艺/BOM 编辑与对比 | nuon_e2e_e | nuon_fix_g5 | 8215 / 5315 |
| G6 质量 | NCR 期限/返工关闭/退供应商单、定量 IQC、检验单快照、资质登记、DHR 结论卡、客诉法规字段、附件、CAPA 等 | nuon_e2e_f | nuon_fix_g6 | 8216 / 5316 |
| G7 仓储/PDA | 库位校验、盘点、拣料、PDA 收货/上架/盘点、发货与 RMA 扫码、冲销、仓库单据打印 | nuon_e2e_g | nuon_fix_g7 | 8217 / 5317 |

## 三、通用组件（G0，已完成，必须复用）

| 组件 | 用法 |
|---|---|
| `RemoteSelect` 及 `MaterialSelect/CustomerSelect/SupplierSelect/WarehouseSelect/LocationSelect/EquipmentSelect/WorkCenterSelect` | 扫码安全：输入/扫码后回车按 `code/no/sn/username/lot_no/id` **精确匹配**再选中，查无提示“未找到“X”对应的{noun}”。新建专用下拉时传 `noun="工单"`、必要时 `matchKeys={['no']}`；`onPick(row)` 拿整条记录；受控/非受控都支持。 |
| `useESign()` | `const [sign, holder] = useESign();` 推荐 `await sign({ meaning, submit: (signature) => post(url, {..., signature}) })`：弹窗自动聚焦密码框、回车提交、密码错误弹窗不关闭并显示原因。取消时抛错，用 `isCancel(e)` 忽略。**所有签名操作都改用 submit 写法。** |
| `ExportButton` | `<ExportButton url="/xxx" params={query} filename="采购订单" columns={[{title:'单号', key:'no'}, {title:'金额', key:'amount', type:'money'}, {title:'状态', value:(r)=>dictLabel(r.status)}]} />`：按当前筛选导出全部（≤5000 行/请求）；也可传 `rows` 导出前端数据。后端 `POST /api/export/xlsx`（`{filename, sheet?, title?, columns, rows}`）。 |
| `PrintButton` / `PrintHeader` / `PrintSignatures` | 单据详情页：`<PrintButton landscape />` 打印（A4、页码、页脚“电子记录打印件”）；`<PrintHeader title="采购订单" no={po.no} />` 只在打印时显示；`<PrintSignatures roles={['制单','审核','批准']} />`。界面元素加 `className="no-print"` 不打印，`page-break` 分页。 |
| `ResponsiveTable` | 替代 `Table`：窄屏（默认 <600px）自动变卡片。列可加 `mobile: 'title'|'subtitle'|'hidden'|'actions'`，操作列 key 为 `_op` 时自动作为卡片操作区。`useNarrow(768)` 判断窄屏。 |
| `ScanInput` + `parseScan()` | 扫码框：保持焦点、回车回调 `onScan(code, parsed)` 后自动清空并重新聚焦（失败也清空）；`captureGlobal` 在焦点不在输入框时也能收扫码枪输入。`parseScan` 解析 UDI/GS1（`(01)…(17)…(10)…(21)…` 及原始串），`code` 优先取 SN、再取批号。 |
| 列表排序 | `usePaged` 返回 `onTableChange`：`<Table onChange={onTableChange} …>`，列加 `sorter: true`（字段 = dataIndex，须是模型字段）；后端 `paginate()` 自动处理 `sort/order`。 |

## 四、文件归属

| 组 | 后端 | 前端 |
|---|---|---|
| G1 | `report/report.service.ts`、`report/report.controller.ts`（工作台、待办、KPI、全局搜索、交付风险）、`auth/roles.ts` | `layouts/MainLayout.tsx`、`pages/Dashboard.tsx`、`pages/Login.tsx`、新建 `pages/workbench/*`、`routes.tsx` 菜单结构与权限、`auth.tsx`、`api/http.ts` |
| G2 | `auth/*`（除 roles.ts）、`system/system.controller.ts`、`system/audit-seal.service.ts`、`imports/*`、`seed/*` | `pages/system/Users.tsx`、`AuditLogs.tsx`、`DataImport.tsx`、`ESignatures.tsx`、`entities.ts` |
| G3 | `erp/sales.service.ts`、`erp/mrp.service.ts`、`erp/query.ts`、新建 `erp/kitting.service.ts` 等、工单下达后调整（新建文件，不改 `production.service.ts` 的过站逻辑；如必须改其中工单创建/下达函数，只改那几个函数） | `pages/erp/SalesOrders.tsx`、`SalesOrderDetail.tsx`、`Mrp.tsx`、`erp/shared.tsx`、`pages/mes/WorkOrders.tsx`、`WorkOrderDetail.tsx` |
| G4 | `erp/purchase.service.ts`、`erp/finance.service.ts`、`erp/po-line.ts`、`erp/currency.ts`、`master/exchange-rate.crud.ts` | `pages/erp/PurchaseOrders.tsx`、`PurchaseOrderDetail.tsx`、`Finance.tsx`、`pages/master/ExchangeRates.tsx` |
| G5 | `mes/production.service.ts`（过站/测试/返工/工位）、`mes/mes.controller.ts`、`mes/key-parts.ts`、`master/engineering.service.ts`、`bom.controller.ts`、`routing.controller.ts`、`engineering.dto.ts`、`calibration.controller.ts`、`core/engineering.ts` | `pages/mes/Station.tsx`、`StationLock.tsx`、`ReworkPanel.tsx`、`spec.tsx`、`stationApi.ts`、新建 `pages/mes/station/*`、`pages/erp/Boms.tsx`、`BomDetail.tsx`、`Routings.tsx`、`RoutingDetail.tsx`、`EngSignatures.tsx` |
| G6 | `qms/*`、`mes/qualification.controller.ts`、`attachments/*`、`report/trace.service.ts`、`core/aql.ts`、退供应商单（新建 `qms/supplier-return.*`） | `pages/quality/*`、`pages/system/Qualifications.tsx`、`components/Attachments.tsx`、`pages/Trace.tsx`、`pages/mes/ReleaseBatch.tsx` |
| G7 | `wms/*`、`core/inventory.service.ts`（谨慎：只加校验与新函数，不改已有函数签名） | `pages/wms/*`、新建 `pages/wms/pda/*` |

## 五、跨组接口约定（按此编码，不要等待对方）

- **读权限矩阵（G1 定义权限点，各组在自己的控制器 GET 接口上加 `@Perms`）**：
  - G1 在 `roles.ts` 新增权限点 `audit`（审计追踪/电子签名台账查阅），授予 admin、manager、qa。
  - 财务数据（应收应付、收付款、账龄、汇兑）GET：`@Perms('finance')`（manager 已含）——G4。
  - 审计追踪、电子签名台账 GET：`@Perms('audit', 'admin')`——G2。
  - 采购订单 GET：`@Perms('purchase', 'plan', 'wms', 'qc', 'qa', 'finance')`——G4；销售订单 GET：`@Perms('sales', 'plan', 'wms', 'finance', 'qa')`——G3。
  - 库存金额/单价类字段：仅 `finance`/`purchase`/`manager` 可见（G7 在库存接口按权限去掉金额字段）。
  - 前端菜单按同一矩阵隐藏（G1），各组新页面在 `routes.tsx` 加菜单时写好 `perm`。
- **待办数据源（G1 汇总）**：G1 在工作台/待办中引用以下列表页 URL 与查询参数（各组保证列表页读取 URL 查询参数作为初始筛选，`usePaged` 已支持 `?status=…` 形式时直接用）：
  - 待 IQC `/quality/inspections?status=PENDING&type=IQC`；待处置 NCR `/quality/ncrs?status=OPEN`；超期 NCR `/quality/ncrs?overdue=1`（G6 后端支持 `overdue=1`）；待放行 `/quality/release`；
  - 待收货 `/purchase/orders?status=APPROVED`；逾期未到货（催货）`/purchase/chase`（G4 新页面）；待审批采购单 `/purchase/orders?status=SUBMITTED`；
  - 待审核订单 `/sales/orders?status=DRAFT`；缺料工单 `/mes/work-orders?kitting=SHORT`（G3 后端支持 `kitting=SHORT`）；
  - 待上架 `/wms/putaway`（G7 新页面）；待领料 `/wms/issues?status=DRAFT`；待出库退供应商单 `/quality/supplier-returns?status=PENDING`（G6 页面，仓管可出库）。
  - 列表页必须读取 URL 查询参数作为初始筛选（G1 负责检查并在报告中列出不支持的页面）。
- **齐套（G3 实现，G1 交付风险卡调用）**：`GET /api/kitting/sales-orders/:id`、`GET /api/kitting/work-orders/:id` → `{ lines: [{material_id, material_code, material_name, uom, required, available, shortage, on_order: [{po_id, po_no, open_qty, promised_date|delivery_date}], eta}] , kitted: boolean, shortage_count }`；`GET /api/kitting/work-orders?ids=1,2` 批量返回 `{[wo_id]: {kitted, shortage_count}}`。只读、无副作用。
- **退供应商单（G6 实现）**：NCR 处置为 RETURN 时创建 `SupplierReturn`（PENDING，不扣库存，库存批次保持冻结/隔离）；`POST /api/supplier-returns/:id/ship`（`@Perms('wms')`）由仓管出库，此时通过 `InventoryService` 扣减；`cancel` 恢复。页面放在质量菜单“退供应商”，仓管也可见（perm: ['qa','qc','wms']）。
- **强制改密（G2 实现，G1 前端处理）**：登录/`me` 返回的 `user.must_change_password` 为 true 时，前端只允许进入改密页（已有强制改密流程则复用）；`user.password_expires_at`（ISO 日期或 null）由 G2 在 presenter 中计算，G1 在到期前 7 天提示。
- **演示模式（G2 实现）**：`GET /api/auth/options` 增加 `demo: boolean`（环境变量 `DEMO_MODE=1` 或数据库中仍有演示账号且未改密时为 true，G2 定），G1 的登录页只在 `demo` 为 true 时显示演示账号下拉。
- **工位（G5）**：工位模式沿用路由 `/mes/station`，进入后为全屏工位模式（无侧栏/顶栏/全局搜索）。由 G5 负责实现：在 `routes.tsx` 中把工位路由放到主外壳之外，或在 `MainLayout` 中对 `/mes/station` 不渲染外壳——为避免冲突，**G5 只改 routes.tsx 中工位路由那一项，G1 在 MainLayout 中对 `/mes/station` 路径直接渲染 `<Outlet/>` 不带外壳**（两者同时生效也无害）。
- **全局搜索（G1）**：`GET /api/search?q=` 返回 `[{type, id, no|code, title, status, status_label, url}]`；支持 UDI/GS1 原始串（用后端解析，规则同 `frontend/src/utils/scan.ts`）、序列号、批号、各类单号、库位、RMA；唯一结果回车直接跳转。各组新单据类型的详情 URL 规则：`/sales/orders/:id`、`/purchase/orders/:id`、`/mes/work-orders/:id`、`/quality/inspections/:id`、`/quality/ncrs?id=`、`/wms/issues?id=`、`/wms/counts?id=`、`/wms/stock?material_id=&lot_no=`。

## 六、交付（最终回复给协调者）

1. 已完成的条目（按 ux-review 编号），每条一句话说明“现在怎么用、几步”；
2. 未完成/部分完成的条目及原因；需要协调者处理的事项（结构变更、共享组件缺陷、与其他组的接口问题）；
3. 改动文件列表；新增测试文件与结果（完整套件通过数/失败项及原因）；类型检查结果；
4. 关键页面截图路径（修复前后对比更好）。

---

# 第二轮修复（5 个代理，2026-11-12）

任务清单：`docs/ux-review.md` 第五节“第二轮修复清单”（R1–R5）；原始复测报告 `scratchpad/retest-A.txt … retest-E.txt`。第一节“硬性规则”、第三节“通用组件”全部继续适用。数据库结构已由协调者加好并迁移（`20261112150000_ux_round2`，字段见第五节清单），**不得修改 schema**。

## 分工、数据库、端口与文件归属

| 组 | 范围 | 测试库 | 演示库（已按新种子重建） | 后端/前端端口 | 文件归属（= 第一轮对应组的文件） |
|---|---|---|---|---|---|
| R1 平台/系统/账号 | 清单 R1 | nuon_e2e_a | nuon_fix_g1 | 8211 / 5311 | 第一轮 G1 + G2 的全部文件；新建系统设置相关文件 |
| R2 销售/计划/采购/财务 | 清单 R2 | nuon_e2e_b | nuon_fix_g2 | 8212 / 5312 | 第一轮 G3 + G4 的全部文件（含 `pages/mes/WorkOrders.tsx`、`WorkOrderDetail.tsx`、`PurchaseOrderDetail.tsx`） |
| R3 质量 | 清单 R3 | nuon_e2e_c | nuon_fix_g3 | 8213 / 5313 | 第一轮 G6 的全部文件 |
| R4 工位/工程 | 清单 R4 | nuon_e2e_d | nuon_fix_g4 | 8214 / 5314 | 第一轮 G5 的全部文件 |
| R5 仓储/PDA | 清单 R5 | nuon_e2e_e | nuon_fix_g5 | 8215 / 5315 | 第一轮 G7 的全部文件 |

共享文件规则同第一轮（presenter.ts、*.module.ts、app.module.ts、config.ts、routes.tsx、dict.ts、MasterPages.tsx 各改自己的部分；`auth/roles.ts` 由协调者维护，已加 `mes_lead`、`po_big_approve` 权限点与 leader/station 角色，**不要再改**）。

新增演示账号（密码同为 `Nuon@2026`）：`leader` 赵班长（班组长，工牌 **E3001 / PIN 1357**，全部工序资质）、`station1` 总装线工位终端（设备账号，只有 mes）。

## 第二轮跨组接口约定

- **订单与工单不符（R2 实现，R1 待办调用）**：R2 在 `erp/so-plan.ts` 导出 `woMismatches(db): Promise<{ so_id, so_no, line_id, material_code, so_qty, wo_qty, wo_ids: number[] }[]>`（订单行数量 − 已发 与 关联未关闭工单计划量不一致的行）；工单列表支持 `?mismatch=1`。R1 待办“订单变更待处理（N）”给 planner/manager，链接 `/mes/work-orders?mismatch=1`。
- **可关闭 NCR（R3 实现，R1 待办调用）**：R3 在 `qms/qms-rules.ts` 导出 `closableNcrIds(db): Promise<number[]>`（已满足关闭条件、仍未关闭）；NCR 列表支持 `?closable=1`。R1 给 QA 待办“可关闭的 NCR（N）”。
- **返工换件（R3 设置，R4 使用）**：NCR 处置 DTO 增加 `require_part_change: boolean`，写入 `Ncr.require_part_change`；R4 工位改为按该字段判断是否必须先登记换件（不再按处置意见关键词）。
- **大额采购单（R2 实现，R1 拍板卡调用）**：金额（本位币）≥ `PO_APPROVAL_THRESHOLD` 时，采购员只能“提交审批”（状态 `SUBMITTED`），审批须 `po_big_approve` 权限（厂长）并电子签名；厂长可“退回”（回 DRAFT，填原因）。R1 拍板卡链接 `/purchase/orders?status=SUBMITTED`，并在卡片上提供批准/退回（调用 R2 的 `POST /api/purchase-orders/:id/approve`、`POST /api/purchase-orders/:id/reject`，均带 `signature`）。
- **公司信息（R1 实现，R2/R3/R5 打印使用）**：`/api/auth/options` 的 `company` 字段改为读 `sys_setting`（键 `company`，JSON：`{name, name_en, address, phone, tax_no, bank, swift}`），环境变量作默认值；前端继续用 `utils/company.ts` 的 `useCompany()`（R1 给接口加 `swift` 字段并更新类型）。
- **工位授权与 PIN（R4 实现后端授权接口；R1 负责 PIN 规则）**：R4 新增 `POST /api/mes/station/authorize { badge_no, pin }` → 校验该工牌用户启用、PIN 正确、拥有 `mes_lead`，返回 `{ user: { username, full_name } }`（不切换会话，失败计入锁定）；工位设定/退出/终端设置一律用它。R1：管理员设置/重置 PIN 时置 `must_change_pin = true`，`badge-login` 响应的 `user.must_change_pin` 透出，`POST /api/auth/change-pin` 成功后清除（R4 读 `auth.controller.ts` 中该接口的请求格式，在刷卡后若须改 PIN 引导两次输入新 PIN）。
- **空闲锁屏（R1）**：MainLayout 空闲超时改为锁屏（保留页面状态），同一账号密码解锁，或有工牌的用户刷工牌 + PIN 解锁；换人则退出重新登录。**`/mes/station` 不适用**（工位有自己的 IdleGuard）。
- **PDA 九宫格（R5 定义，R1 复用）**：R5 在 `pages/wms/pda/tiles.ts` 导出 `PDA_TILES`（key、title、icon、path、badgeKey），R1 仓管工作台九宫格改为复用它（角标数据仍由工作台接口提供）。**（2026-11-13 起仓库改用 RFID：工作台九宫格改用 `pages/wms/rfid/tiles.ts` 的 `RFID_TILES`，`PDA_TILES` 只用于条码兜底页 `/wms/pda`，见 ux-review 第七节。）**
- **湿敏收货确认（R5 后端，R2 前端）**：`WmsService.receive` 对湿敏物料放非防潮库位的行，要求请求体 `confirm_placement: true`，否则 400，`detail` 以 `【需确认】` 开头并写明物料与库位；R5 同步改 PDA 收货与“其他/客供收货”页面，R2 改采购单详情收货弹窗（先调 `POST /api/wms/placement-check`，弹确认后带 `confirm_placement: true` 提交）。
- **税率（R2）**：`Customer.tax_rate` / `Supplier.tax_rate` 为空时用 `DEFAULT_VAT_RATE`（环境变量，默认 0.13）；客户、供应商主数据页加税率字段（MasterPages 中客户段落归 R2，供应商段落归 R2）。
