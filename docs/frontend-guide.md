# 前端开发约定（Frontend Guide）

技术栈：React 18 + TypeScript 5（strict）+ Vite 6 + Ant Design 5（zh_CN）+ react-router-dom 6 + ECharts 5。
源码在 `frontend/src`，路由与菜单在 `src/routes.tsx`（每个页面文件 `export default` 一个组件）。

## 设计原则（为什么不像金蝶那么难用）

1. **单据按状态只显示当前能做的动作**：例如工单“计划”状态只显示【下达】【取消】，“生产中”显示【完工入库】【查看 DHR】。按钮文字用动词，主动作用 `type="primary"`。
2. **单号可点击跳转**：任何单号/序列号/批号都用 `<Link>` 指向详情或追溯页（`/sales/orders/:id`、`/mes/work-orders/:id`、`/trace?sn=xx`、`/trace?material_code=xx&lot_no=yy`）。
3. **系统帮用户做决定**：FEFO 自动分配批次、自动带出默认值、自动计算抽样方案，用户只需确认。
4. **合规规则写在界面上**：用 `<Alert type="info" showIcon>` 一句话说明 GMP 规则（如“未放行的成品不能发货”）。
5. **扫码友好**：扫码输入框 `autoFocus`、回车即提交，提交后自动清空并重新聚焦。
6. 全中文；表格 `size="middle"`、`scroll={{ x: 'max-content' }}`、`rowKey="id"`；危险/过账操作用 `Popconfirm` 或 `Modal.confirm`。

## 共享模块（只用不改）

```ts
// API（baseURL = /api，自动带 token，错误自动 message.error 弹出后端 detail）
import { get, post, put, del, download, http, type Rec, type Page } from '../../api/http';
const so = await get(`/sales-orders/${id}`);          // 注意：路径不带 /api 前缀
await post(`/sales-orders/${id}/confirm`);
// 后端异常时 Promise 会 reject，且已弹出错误提示；调用方一般只需 try/finally 复位 loading。

// 分页列表 hook
import { usePaged } from '../../components/usePaged';
const { rows, loading, setQuery, reload, pagination, query } = usePaged('/sales-orders', { status: undefined });
<Table rowKey="id" dataSource={rows} loading={loading} pagination={pagination} />
setQuery({ q: 'xx' })   // 合并查询参数并回到第 1 页

// 权限
import { useAuth } from '../../auth';
const { user, can } = useAuth();  can('qa')  can('wms', 'plan')   // 任一即可
// 权限点：master engineering sales purchase plan wms mes qc qa finance admin

// 状态标签与字典（见 src/utils/dict.ts 的全部字典名）
import StatusTag from '../../components/StatusTag';   <StatusTag dict="wo_status" value={row.status} />
import { dictLabel, dictOptions } from '../../utils/dict';  <Select options={dictOptions('so_status')} />

// 电子签名（关键质量操作必须）：返回 {password, reason}；用户取消会 throw，用 isCancel 忽略
import { useESign, isCancel } from '../../components/ESign';
const [sign, signHolder] = useESign();   // 组件 JSX 中必须渲染 {signHolder}
try { const signature = await sign({ meaning: '产品放行（DHR审核批准）' }); await post(url, { ..., signature }); }
catch (e) { if (!isCancel(e)) throw e; }

// 远程搜索下拉（Form.Item 内直接用，value=id）
import RemoteSelect, { MaterialSelect, CustomerSelect, SupplierSelect, WarehouseSelect, LocationSelect, EquipmentSelect, WorkCenterSelect } from '../../components/RemoteSelect';
<MaterialSelect params={{ category: 'FINISHED' }} onPick={(rec) => ...} />   // onPick 回调整条记录
<RemoteSelect url="/sales-orders" params={{ status: 'CONFIRMED,IN_PRODUCTION,PARTIAL_SHIPPED' }} labelOf={(r) => `${r.no} ${r.customer_name}`} />

// 其他
import PageHeader from '../../components/PageHeader';   <PageHeader title="..." sub="..." extra={<Button/>} />
import CrudPage, { FieldInput, type Field } from '../../components/CrudPage';
import Chart from '../../components/Chart';   // <Chart option={echartsOption} height={260} />
import { fmtDate, fmtDateTime, fmtQty, fmtMoney, fmtPct, toDate } from '../../utils/format';  // toDate(dayjs) → 'YYYY-MM-DD'
```

## 后端接口

* 交互式文档：启动后端后访问 `http://127.0.0.1:8000/api/docs`。
* 路由源码：`backend/app/routers/*.py`（请求体 = Pydantic 模型；响应 = `ser()` 序列化的 dict）。
* `ser(obj)` 输出：**所有数据库字段 + 模型上的全部 `@property`**（如 `customer_name`、`material_code`、`progress`）+ 指定的子表（如 `lines`）。看 `backend/app/models/*.py` 就能知道字段。
* 列表接口统一返回 `{items, total, page, page_size}`，支持 `q`、`page`、`page_size` 及各自筛选参数。
* 业务错误统一 HTTP 400 + `{detail: "中文提示"}`；无权限 403；未登录 401。

本地联调：

```bash
cd backend
DATABASE_URL=sqlite:///./dev.db .venv/bin/python -m app.seed --reset --demo
DATABASE_URL=sqlite:///./dev.db .venv/bin/uvicorn app.main:app --port 8000
cd ../frontend && npm run dev     # http://localhost:5173 ，/api 代理到 8000（VITE_API_TARGET 可改）
```

演示账号密码均为 `Nuon@2026`：admin、manager、sales、buyer、pmc、engineer、wh、op1、op2、qc、qa、finance。
