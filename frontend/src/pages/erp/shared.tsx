/** ERP 页面内部共用的小组件与工具（仅 pages/erp 使用） */
import { Button, DatePicker, Form, Input, InputNumber, Modal, Progress, Select, Table, Tooltip, Typography, message, type TableColumnsType } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, type Rec } from '../../api/http';
import { MaterialSelect } from '../../components/RemoteSelect';
import { fmtDate, fmtMoney, fmtQty } from '../../utils/format';

export const CURRENCY_OPTIONS = ['CNY', 'USD', 'EUR'].map((v) => ({ value: v, label: v }));

let seq = 0;
/** 前端临时行 key */
export const uid = () => `k${Date.now().toString(36)}${(seq++).toString(36)}`;

/** 日期是否早于今天 */
export const isPast = (d?: string | null) => !!d && dayjs(d).isBefore(dayjs(), 'day');

/** 明细行某字段求和 */
export const sumBy = (rows: Rec[] | undefined, k: string) => (rows || []).reduce((s, r) => s + (Number(r[k]) || 0), 0);

/** 'YYYY-MM-DD' → dayjs（表单回显） */
export const toDayjs = (d?: string | null) => (d ? dayjs(d) : undefined);

/** 交期/到期日：逾期标红 */
export function DueDate({ value, overdue, hint = '已逾期' }: { value?: string | null; overdue?: boolean; hint?: string }) {
  if (!value) return <span>-</span>;
  if (!overdue) return <span>{fmtDate(value)}</span>;
  return (
    <Tooltip title={hint}>
      <span style={{ color: '#cf1322', fontWeight: 500 }}>{fmtDate(value)}</span>
    </Tooltip>
  );
}

/** 数量进度：进度条 + “已完成/总数” */
export function QtyProgress({ done, total, width = 160 }: { done: number; total: number; width?: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 1000) / 10) : 0;
  return (
    <div style={{ width, display: 'flex', alignItems: 'center', gap: 8 }}>
      <Progress percent={pct} size="small" showInfo={false} status={pct >= 100 ? 'success' : 'normal'} style={{ flex: 1, margin: 0 }} />
      <span style={{ fontSize: 12, color: '#595959', whiteSpace: 'nowrap' }}>{fmtQty(done)}/{fmtQty(total)}</span>
    </div>
  );
}

const DOC_ROUTES = {
  po: { api: '/purchase-orders', path: '/purchase/orders' },
  so: { api: '/sales-orders', path: '/sales/orders' },
  wo: { api: '/work-orders', path: '/mes/work-orders' },
} as const;

/** 只知道单号时的跳转链接：点击后按单号检索出 id 再进入详情 */
export function DocNoLink({ kind, no }: { kind: keyof typeof DOC_ROUTES; no?: string | null }) {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!no) return <span>-</span>;
  const go = async () => {
    const r = DOC_ROUTES[kind];
    setBusy(true);
    try {
      const d = await get(r.api, { q: no, page_size: 10 });
      const hit = (d.items as Rec[]).find((x) => x.no === no);
      if (hit) nav(`${r.path}/${hit.id}`);
      else message.warning(`未找到单据 ${no}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Typography.Link className="mono" onClick={go} disabled={busy}>
      {no}
    </Typography.Link>
  );
}

/** 版本号自动递增：A0→A1，V1.9→V1.10，A→A1 */
export function nextVersion(v?: string | null) {
  const m = /^(.*?)(\d+)$/.exec(v || '');
  return m ? `${m[1]}${Number(m[2]) + 1}` : `${v || 'A'}1`;
}

/** 升版弹窗（BOM / 工艺路线共用） */
export function NewVersionModal({
  open, current, withEcn, onCancel, onOk,
}: {
  open: boolean;
  current?: string;
  withEcn?: boolean;
  onCancel: () => void;
  onOk: (v: { version: string; ecn_no?: string }) => Promise<void>;
}) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  return (
    <Modal
      open={open}
      title="升版（生成新版本草稿）"
      okText="生成新版本"
      onCancel={onCancel}
      confirmLoading={saving}
      destroyOnHidden
      maskClosable={false}
      onOk={async () => {
        const v = await form.validateFields();
        setSaving(true);
        try {
          await onOk(v);
        } finally {
          setSaving(false);
        }
      }}
    >
      <Typography.Paragraph type="secondary">
        系统将复制当前版本（{current}）的全部内容生成新版本草稿；新版本发布后，旧版本自动作废。
      </Typography.Paragraph>
      <Form form={form} layout="vertical" preserve={false} initialValues={{ version: nextVersion(current) }}>
        <Form.Item name="version" label="新版本号" rules={[{ required: true, message: '请填写版本号' }]}>
          <Input />
        </Form.Item>
        {withEcn && (
          <Form.Item name="ecn_no" label="ECN 变更单号" rules={[{ required: true, message: '工程变更请填写 ECN 编号' }]}>
            <Input placeholder="如 ECN-2026-015" />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}

// ---------------- 订单明细编辑（销售/采购共用） ----------------
export type LineRow = Rec & { _key: string };

interface LinesEditorProps {
  value: LineRow[];
  onChange: (rows: LineRow[]) => void;
  /** 行日期字段：delivery_date（销售交期）/ expected_date（采购到货） */
  dateField: 'delivery_date' | 'expected_date';
  dateLabel: string;
  currency: string;
  materialParams?: Rec;
  materialLabel?: string;
  /** 新增行默认日期（表头日期） */
  defaultDate?: string | null;
  /** 选中物料时带出默认单价（库存单位单价） */
  defaultPrice?: (m: Rec) => number | undefined;
  /** 采购订单：物料设置了采购单位时，允许按采购单位录入数量与单价 */
  purchaseUnit?: boolean;
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * 采购单位（行字段约定）：
 *   uom = 库存单位；purchase_uom_def / purchase_factor = 物料的采购单位与换算率（1 采购单位 = factor 库存单位）；
 *   purchase_uom 非空 = 本行按采购单位录入（purchase_qty / purchase_price），qty / unit_price 随之换算为库存单位。
 */
export const hasPurchaseUnit = (r: Rec) => !!r.purchase_uom_def && r.purchase_uom_def !== r.uom && Number(r.purchase_factor) > 0;

/** 按采购单位录入时同步库存单位数量与单价 */
function syncPurchase(r: LineRow): LineRow {
  if (!r.purchase_uom) return r;
  const f = Number(r.purchase_factor);
  if (!(f > 0)) return r;
  return {
    ...r,
    qty: r.purchase_qty === null || r.purchase_qty === undefined ? r.purchase_qty : r4(Number(r.purchase_qty) * f),
    unit_price: r.purchase_price === null || r.purchase_price === undefined ? r.purchase_price : r6(Number(r.purchase_price) / f),
  };
}

/** 切换录入单位（采购单位 ⇄ 库存单位），数量与单价按换算率互换 */
function switchUnit(r: LineRow, toPurchase: boolean): LineRow {
  const f = Number(r.purchase_factor);
  if (toPurchase && f > 0) {
    return syncPurchase({
      ...r,
      purchase_uom: r.purchase_uom_def,
      purchase_qty: r.qty ? r4(Number(r.qty) / f) : r.qty,
      purchase_price: r.unit_price !== null && r.unit_price !== undefined ? r6(Number(r.unit_price) * f) : r.unit_price,
    });
  }
  return { ...r, purchase_uom: null, purchase_qty: null, purchase_price: null };
}

/**
 * 金额四舍五入到分，与后端十进制计算一致：先取 12 位有效数字消除浮点误差（3 × 1.005 = 3.0149999…→ 3.015），
 * 再用科学计数法移位取整（避免 3.015 × 100 = 301.49999…）
 */
export const toCents = (v: number): number => {
  const n = Number(v.toPrecision(12));
  const r = Number(`${Math.round(Number(`${n}e2`))}e-2`);
  return Number.isFinite(r) ? r : Math.round(v * 100) / 100;
};

/** 行金额：按采购单位录入时 = 采购数量 × 采购单价，否则 = 数量 × 单价 */
export const lineAmount = (r: Rec) =>
  r.purchase_uom
    ? toCents((Number(r.purchase_qty) || 0) * (Number(r.purchase_price) || 0))
    : toCents((Number(r.qty) || 0) * (Number(r.unit_price) || 0));

export function OrderLinesEditor({ value, onChange, dateField, dateLabel, currency, materialParams, materialLabel = '物料', defaultDate, defaultPrice, purchaseUnit }: LinesEditorProps) {
  const patch = (key: string, p: Rec) => onChange(value.map((r) => (r._key === key ? syncPurchase({ ...r, ...p }) : r)));
  const replace = (key: string, fn: (r: LineRow) => LineRow) => onChange(value.map((r) => (r._key === key ? fn(r) : r)));
  const total = value.reduce((s, r) => s + lineAmount(r), 0);
  const columns: TableColumnsType<LineRow> = [
    { title: '#', key: 'idx', width: 44, render: (_, __, i) => i + 1 },
    {
      title: materialLabel, key: 'material', width: 320,
      render: (_, r) => (
        <MaterialSelect
          style={{ width: 300 }}
          params={materialParams}
          value={r.material_id}
          onPick={(m) =>
            replace(r._key, (old) => {
              let row: LineRow = {
                ...old,
                material_id: m?.id,
                material_code: m?.code,
                material_name: m?.name,
                material_spec: m?.spec,
                uom: m?.uom,
                purchase_uom_def: m?.purchase_uom ?? null,
                purchase_factor: m?.purchase_factor ?? null,
                purchase_uom: null,
                purchase_qty: null,
                purchase_price: null,
                ...(m && !old.unit_price && defaultPrice?.(m) ? { unit_price: defaultPrice(m) } : {}),
              };
              // 物料有采购单位：默认按采购单位录入
              if (purchaseUnit && m && hasPurchaseUnit(row)) row = switchUnit(row, true);
              return row;
            })
          }
        />
      ),
    },
    {
      title: '单位', key: 'uom', width: purchaseUnit ? 100 : 60,
      render: (_, r) =>
        purchaseUnit && hasPurchaseUnit(r) ? (
          <Tooltip title={`1 ${r.purchase_uom_def} = ${fmtQty(r.purchase_factor)} ${r.uom}`}>
            <Select
              size="small"
              style={{ width: 90 }}
              value={r.purchase_uom ? 'P' : 'S'}
              onChange={(v) => replace(r._key, (old) => switchUnit(old, v === 'P'))}
              options={[{ value: 'P', label: r.purchase_uom_def }, { value: 'S', label: r.uom }]}
            />
          </Tooltip>
        ) : (
          r.uom || '-'
        ),
    },
    {
      title: '数量', key: 'qty', width: 130,
      render: (_, r) =>
        r.purchase_uom ? (
          <div>
            <InputNumber min={0} style={{ width: 120 }} value={r.purchase_qty} onChange={(v) => patch(r._key, { purchase_qty: v })} status={r.material_id && !(r.purchase_qty > 0) ? 'error' : undefined} />
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>= {fmtQty(r.qty)} {r.uom}</Typography.Text>
          </div>
        ) : (
          <InputNumber min={0} style={{ width: 120 }} value={r.qty} onChange={(v) => patch(r._key, { qty: v })} status={r.material_id && !(r.qty > 0) ? 'error' : undefined} />
        ),
    },
    {
      title: '单价', key: 'unit_price', width: 140,
      render: (_, r) =>
        r.purchase_uom ? (
          <div>
            <InputNumber min={0} style={{ width: 130 }} value={r.purchase_price} onChange={(v) => patch(r._key, { purchase_price: v })} />
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>每{r.purchase_uom}，= {fmtQty(r.unit_price, 6)}/{r.uom}</Typography.Text>
          </div>
        ) : (
          <InputNumber min={0} style={{ width: 130 }} value={r.unit_price} onChange={(v) => patch(r._key, { unit_price: v })} />
        ),
    },
    { title: '金额', key: 'amount', width: 130, align: 'right', render: (_, r) => fmtMoney(lineAmount(r), currency) },
    {
      title: dateLabel, key: 'date', width: 150,
      render: (_, r) => (
        <DatePicker style={{ width: 140 }} value={r[dateField] ? dayjs(r[dateField]) : null} onChange={(d) => patch(r._key, { [dateField]: d ? d.format('YYYY-MM-DD') : null })} />
      ),
    },
    { title: '备注', key: 'remark', width: 180, render: (_, r) => <Input value={r.remark ?? ''} onChange={(e) => patch(r._key, { remark: e.target.value })} /> },
    {
      title: '', key: 'op', width: 50, fixed: 'right',
      render: (_, r) => (
        <Tooltip title="删除此行">
          <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => onChange(value.filter((x) => x._key !== r._key))} />
        </Tooltip>
      ),
    },
  ];
  return (
    <Table<LineRow>
      rowKey="_key"
      size="middle"
      columns={columns}
      dataSource={value}
      pagination={false}
      scroll={{ x: 'max-content' }}
      footer={() => (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
          <Button type="dashed" icon={<PlusOutlined />} onClick={() => onChange([...value, { _key: uid(), [dateField]: defaultDate ?? null }])}>
            添加一行
          </Button>
          <span>
            合计金额：<b style={{ fontSize: 16 }}>{fmtMoney(total, currency)}</b>
          </span>
        </div>
      )}
    />
  );
}

/** 校验明细行，返回错误提示（无错误返回 null） */
export function checkLines(rows: LineRow[], what = '物料'): string | null {
  const used = rows.filter((r) => r.material_id || r.qty);
  if (!used.length) return '请至少录入一行明细';
  for (const [i, r] of used.entries()) {
    if (!r.material_id) return `第 ${i + 1} 行请选择${what}`;
    if (!(Number(r.qty) > 0)) return `第 ${i + 1} 行数量必须大于 0`;
  }
  return null;
}

/** 明细行 → 提交体（按采购单位录入的行附带 purchase_qty / purchase_uom / purchase_price，后端据此换算库存单位） */
export function linesBody(rows: LineRow[], dateField: 'delivery_date' | 'expected_date') {
  return rows
    .filter((r) => r.material_id)
    .map((r) => ({
      material_id: r.material_id,
      qty: Number(r.qty),
      unit_price: Number(r.unit_price) || 0,
      ...(r.purchase_uom
        ? { purchase_qty: Number(r.purchase_qty), purchase_uom: r.purchase_uom, purchase_price: Number(r.purchase_price) || 0 }
        : {}),
      [dateField]: r[dateField] || null,
      remark: r.remark || null,
    }));
}
