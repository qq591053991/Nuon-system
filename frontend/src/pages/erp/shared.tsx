/** ERP 页面内部共用的小组件与工具（仅 pages/erp 使用） */
import { Button, DatePicker, Form, Input, InputNumber, Modal, Progress, Table, Tooltip, Typography, message, type TableColumnsType } from 'antd';
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
  /** 选中物料时带出默认单价 */
  defaultPrice?: (m: Rec) => number | undefined;
}

export const lineAmount = (r: Rec) => Math.round((Number(r.qty) || 0) * (Number(r.unit_price) || 0) * 100) / 100;

export function OrderLinesEditor({ value, onChange, dateField, dateLabel, currency, materialParams, materialLabel = '物料', defaultDate, defaultPrice }: LinesEditorProps) {
  const patch = (key: string, p: Rec) => onChange(value.map((r) => (r._key === key ? { ...r, ...p } : r)));
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
            patch(r._key, {
              material_id: m?.id,
              material_code: m?.code,
              material_name: m?.name,
              material_spec: m?.spec,
              uom: m?.uom,
              ...(m && !r.unit_price && defaultPrice?.(m) ? { unit_price: defaultPrice(m) } : {}),
            })
          }
        />
      ),
    },
    { title: '单位', dataIndex: 'uom', width: 60, render: (v) => v || '-' },
    {
      title: '数量', key: 'qty', width: 120,
      render: (_, r) => <InputNumber min={0} style={{ width: 110 }} value={r.qty} onChange={(v) => patch(r._key, { qty: v })} status={r.material_id && !(r.qty > 0) ? 'error' : undefined} />,
    },
    {
      title: '单价', key: 'unit_price', width: 130,
      render: (_, r) => <InputNumber min={0} style={{ width: 120 }} value={r.unit_price} onChange={(v) => patch(r._key, { unit_price: v })} />,
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

/** 明细行 → 提交体 */
export function linesBody(rows: LineRow[], dateField: 'delivery_date' | 'expected_date') {
  return rows
    .filter((r) => r.material_id)
    .map((r) => ({
      material_id: r.material_id,
      qty: Number(r.qty),
      unit_price: Number(r.unit_price) || 0,
      [dateField]: r[dateField] || null,
      remark: r.remark || null,
    }));
}
