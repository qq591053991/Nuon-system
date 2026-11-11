# Nuon 智造云 · 光疗医疗器械代工一体化平台

面向 **光疗医疗器械（LED 红光/近红外治疗仪、新生儿蓝光治疗仪、LED 面罩等）代工厂（OEM/ODM）** 的现代化管理系统，
一套系统、一份数据覆盖 **ERP + MES + WMS + QMS**，内置医疗器械 GMP / ISO 13485 合规控制，用来替代难用的传统 ERP（如金蝶）。

> 设计目标：**让一线员工不培训也能用**；让质量合规“系统自动做对”，而不是靠人记规则。

---

## 为什么比金蝶好用

| 金蝶等传统 ERP 的痛点 | 本系统的做法 |
|---|---|
| 菜单深、单据多、字段多，找不到入口 | 按角色显示菜单；**工作台“我的待办”** 直接告诉你今天要处理什么，点一下就到 |
| 单据流转靠人记：下推、审核、反审核… | 单据**按状态只显示当前能做的动作**（如工单：下达 → 领料 → 报工 → 完工入库 → 放行） |
| 查一个批次要翻 5 张报表 | **全局搜索框**：单号/序列号/批号/物料一框搞定，支持扫码枪；**一键正反向追溯** |
| ERP 管不到车间，MES/WMS 另买另接口 | ERP、MES、WMS、QMS 同库同源，**零接口**，数据实时一致 |
| 医疗器械合规靠纸质记录、事后补签 | **电子签名 + 审计追踪 + 电子 DHR + UDI**，系统强制执行 GMP 规则 |
| 车间报工要坐电脑录单 | **工位终端**：扫码 → 自动显示下一道工序和测试规格 → 录入测量值自动判定 → 一键提交 |
| 老系统数据迁移难 | **金蝶导出的 Excel 直接导入**（兼容金蝶列名），出错整单回滚 |
| 又要多记一套账号密码 | **用金蝶云星空账号密码直接登录**，金蝶改密/停用即时生效 |

## 功能模块

| 模块 | 功能 |
|---|---|
| **工作台** | KPI 驾驶舱（在手订单、逾期、在制、今日产出、一次直通率 FPY、待检/NCR/待放行、库存金额、校准到期）、我的待办、预警、产出/直通率/NCR 图表 |
| **销售与计划（ERP）** | 销售订单（品牌客户/注册人校验）、一键生成工单、**MRP 多级展开**（安全库存、采购在途、在制、客供料识别）、建议一键转采购单/工单 |
| **采购（ERP）** | 采购订单，**只允许向合格供方下单**（资质到期自动拦截）、收货自动生成 IQC 检验单与应付 |
| **生产执行（MES）** | 工单下达时**快照受控 BOM/工艺**、自动生成**生产批号、序列号和 UDI**（GS1）；工位扫码报工、**防跳站/防重复过站**、**校准过期仪器禁止使用**、测试数据按规格**自动判定**、不合格**自动开 NCR**、关键件（如医用电源）批次绑定、返工记录、批量报工（半成品） |
| **质量（QMS）** | IQC 来料检验（**GB/T 2828.1 AQL 抽样方案自动计算**）、电子签名判定后库存状态自动转换；NCR 评审处置（返工/报废/让步/退货，生产过程不合格不允许让步放行）；CAPA；**电子 DHR 审核与产品放行**（未放行不能发货） |
| **仓储（WMS）** | 库存按 **物料 + 库位 + 批次 + 质量状态（待检/合格/不合格/冻结）+ 货主** 管理；**FEFO 先到期先出**自动推荐批次；**客供料隔离**（只能用于该客户工单）；过期物料禁用；发货逐台校验序列号；调拨、盘点、不可篡改的库存流水 |
| **追溯** | 反向：序列号 → 工单/批号 → 每个物料批次（供应商、IQC）→ 每道工序的操作人/设备/测试数据 → 发货客户；正向：物料批次 → 工单 → 序列号 → 客户（**召回范围秒级评估**） |
| **工程数据** | BOM（多级、位号、损耗率）、工艺路线 + 测试规格（峰值波长、辐照度、老化时长、耐压/漏电流…），**草稿 → 电子签名发布 → 升版（ECN）** |
| **财务** | 发货自动生成应收、采购入库自动生成应付、收付款登记、账龄分析 |
| **系统与合规** | 用户/角色/权限、**金蝶云星空账号直接登录**、**审计追踪**（字段级前后值）、电子签名记录、登录锁定与登录日志、金蝶数据导入 |

完整的业务规则见 [docs/architecture.md](docs/architecture.md)，合规条款对照见 [docs/compliance.md](docs/compliance.md)，
从金蝶迁移方案见 [docs/kingdee-migration.md](docs/kingdee-migration.md)，金蝶账号登录见 [docs/kingdee-sso.md](docs/kingdee-sso.md)，
设计评审与上线前待办见 [docs/design-review.md](docs/design-review.md)，
运维（HTTPS、备份与恢复演练、记录保存、数据库账号加固、时间同步、升级）见 [docs/operations.md](docs/operations.md)。
硬件对接（扫码枪、标签打印、测试仪器采集、预算与采购条款）见 [docs/hardware-integration.md](docs/hardware-integration.md)。

## 核心业务流程

```mermaid
flowchart LR
  SO[销售订单] -->|一键生成| WO[生产工单]
  SO --> MRP[MRP 运算]
  MRP -->|转单| PO[采购订单]
  PO -->|收货| RK[入库·待检]
  RK --> IQC{IQC 抽检<br/>电子签名}
  IQC -->|合格| OK[合格库存]
  IQC -->|不合格| NCR[NCR 评审处置]
  WO -->|下达：批号/序列号/UDI| LL[FEFO 领料]
  OK --> LL
  LL --> ST[工位扫码报工<br/>组装→光学测试→老化→安规→终检→包装]
  ST -->|测试超规格| NCR
  NCR -->|返工| ST
  ST --> FG[完工入库·待放行]
  FG --> DHR{DHR 审核<br/>QA 电子签名放行}
  DHR --> SH[发货·逐台校验 SN]
  SH --> AR[应收]
```

## 快速开始

### 方式一：Docker 一键部署（推荐）

```bash
cp .env.example .env          # 修改数据库密码、SECRET_KEY
docker compose up -d --build
# 浏览器打开 http://<服务器IP>:8080
```

### 方式二：本地开发

需要 Node.js 20+ 与 PostgreSQL 14+（数据库需为 UTF8 编码；无 PostgreSQL 时可 `docker run -p 5432:5432 -e POSTGRES_PASSWORD=nuon postgres:16`）。

后端（NestJS）：

```bash
cd backend
cp .env.example .env                  # 修改 DATABASE_URL 等
npm install
npx prisma migrate deploy             # 建表/升级数据库结构
npm run seed -- --reset --demo        # 初始化 + 演示数据
npm run start:dev                     # API 文档：http://localhost:8000/api/docs
```

前端：

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173 （/api 自动代理到 8000）
```

金蝶云星空账号登录：配置 `KINGDEE_ENABLED / KINGDEE_URL / KINGDEE_ACCT_ID`，详见 [docs/kingdee-sso.md](docs/kingdee-sso.md)。

### 演示账号（密码均为 `Nuon@2026`）

| 账号 | 角色 | 建议体验 |
|---|---|---|
| admin | 系统管理员 | 用户与权限、工牌/PIN、账号解锁、审计追踪与完整性校验（可查看业务数据，但不能做业务操作） |
| manager | 厂长 | 工作台驾驶舱、各业务操作（**不能做质量签名**：产品放行、NCR 处置、让步接收、CAPA 关闭、BOM/工艺批准） |
| sales | 销售 | 销售订单、发货申请 |
| pmc | PMC 计划 | MRP、生产工单下达 |
| buyer | 采购 | 采购订单（试试向“新锐光电”下单会被拦截） |
| wh | 仓管 | 收货、领料过账、完工入库、发货 |
| op1 / op2 | 产线操作员 | **工位终端扫码报工**（工牌登录：`E1001` / PIN `1234`，`E1002` / PIN `5678`） |
| qc | 质检员 | IQC 来料检验 |
| qa | QA | NCR 处置、CAPA、**DHR 审核放行**、BOM / 工艺路线批准 |
| engineer | 工艺工程师 | BOM / 工艺路线 / 测试规格编制与提交（QA 批准后生效） |
| finance | 财务 | 应收应付、收付款 |

### 5 分钟体验路线

1. `qc` 登录 → 待办「待检验的来料」→ 打开 LED 来料检验单，看系统自动算出的 AQL 抽样方案 → 判定合格（电子签名）→ 库存自动从“待检”变“合格”。
2. `op1` 登录 → 工位终端 → 扫描生产中的序列号（工单详情的“序列号”页签可复制），按提示录入光学测试值；输入超规格的辐照度试试，系统自动判不合格并开 NCR；故意扫描跳站的工位也会被拦截。
3. `qa` 登录 → NCR 处置为“返工” → 操作员重新测试 → 完工后仓管完工入库 → QA 在「DHR 审核与放行」中查看电子 DHR 并签名放行。
4. 在顶部搜索框输入电源批号 `HY2609A` → 批次正向追溯：一眼看到用在哪些工单、哪些序列号、发给了哪个客户。

## 技术架构

- 后端：TypeScript · NestJS 11 · Prisma 6（含数据库迁移）· PostgreSQL · JWT · 金蝶云星空账号登录
- 前端：React 18 · TypeScript · Ant Design 5（中文）· Vite · ECharts
- 部署：Docker Compose（Nginx + API + PostgreSQL），单台服务器即可支撑数百用户

前后端都是 TypeScript；NestJS 的模块/依赖注入与 Spring Boot 结构相近，熟悉 Java 的同事也容易上手。

```
backend/
  prisma/schema.prisma   数据模型（46 张表）；prisma/migrations 数据库结构变更脚本
  src/common/            基础设施：事务、审计追踪（Prisma 扩展，字段级前后值）、输出视图、通用 CRUD、错误格式
  src/auth/              登录（本地 + 金蝶云星空）、角色权限、登录锁定
  src/core/              库存核心（行锁、FEFO、客供料隔离）、单据编号、电子签名、AQL、UDI
  src/master|erp|wms|qms|mes|report|imports/   各业务域：*.service.ts（规则）+ *.controller.ts（接口）
  src/seed/              初始化与演示数据
  test/                  Jest 端到端测试（34 项）
frontend/src
  pages/                 各业务页面
  components/            电子签名、远程搜索、配置化 CRUD、图表等通用组件
docs/                    架构、合规对照、设计评审、金蝶迁移与登录集成、前后端开发约定
```

运行测试（使用独立的测试库，会被清空）：

```bash
cd backend
DATABASE_URL=postgresql://user:pwd@localhost:5432/nuon_test npx prisma migrate deploy
DATABASE_URL=postgresql://user:pwd@localhost:5432/nuon_test npm test
```

## 路线图（建议后续迭代）

- 测试仪器联网自动采集（光谱辐照度计、安规测试仪 RS232/LAN 读数，免手工录入）
- 标签打印（UDI 二维码 GS1 DataMatrix、彩盒/外箱标签）、PDA 移动端收发货
- 供应商门户（送货预约、来料证书上传）、客户门户（订单进度、DHR/COC 下载）
- 金蝶财务凭证对接（保留金蝶总账，业务全部在本系统）
- 计算机化系统验证（CSV：IQ/OQ/PQ）文档包
- 上线前必须处理的问题与改进清单见 [docs/design-review.md](docs/design-review.md)
