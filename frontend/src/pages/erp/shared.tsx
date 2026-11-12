/** ERP 页面内部共用的小组件与工具（仅 pages/erp 使用） */
import { Alert, Button, DatePicker, Form, Input, InputNumber, Modal, Progress, Select, Space, Table, Tag, Tooltip, Typography, message, type TableColumnsType } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
  /** 单价参考（如该客户上次成交价）：选物料时没填单价则自动带入，单价下方显示提示，可点击带入 */
  priceHint?: (materialId: number) => { price: number; text: string } | undefined;
  /** 行级锁定（订单变更：已排产/已发货的行不能换物料、不能删、数量不得少于已发货） */
  lockedRow?: (r: LineRow) => LineLock | null;
  /** 物料下拉无结果时的提示 */
  materialEmpty?: ReactNode;
}

export interface LineLock {
  /** 不能更换物料的原因 */
  material?: string;
  /** 不能修改单价的原因 */
  price?: string;
  /** 不能删除的原因 */
  noDelete?: string;
  /** 数量下限与提示 */
  minQty?: number;
  qtyHint?: string;
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

/** 明细编辑可回车跳转的列：0 物料 → 1 数量 → 2 单价 → 3 日期 → 4 备注 → 下一行物料（最后一行回车自动新增一行） */
const NAV_LAST = 4;

export function OrderLinesEditor({
  value, onChange, dateField, dateLabel, currency, materialParams, materialLabel = '物料', defaultDate, defaultPrice, purchaseUnit, priceHint,
  lockedRow, materialEmpty,
}: LinesEditorProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const latest = useRef(value);
  latest.current = value;
  const [pending, setPending] = useState<string | null>(null);
  const patch = (key: string, p: Rec) => onChange(value.map((r) => (r._key === key ? syncPurchase({ ...r, ...p }) : r)));
  const replace = (key: string, fn: (r: LineRow) => LineRow) => onChange(latest.current.map((r) => (r._key === key ? fn(r) : r)));
  const total = value.reduce((s, r) => s + lineAmount(r), 0);
  const newRow = (): LineRow => ({ _key: uid(), [dateField]: defaultDate ?? null });

  /** 聚焦某行某列的输入框（物料下拉聚焦其搜索框） */
  const focusCell = useCallback((key: string, col: number) => {
    const el = wrap.current?.querySelector<HTMLElement>(`[data-nav="${key}|${col}"] input`);
    if (el) {
      el.focus();
      if (el instanceof HTMLInputElement && col > 0) el.select();
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    if (!pending) return;
    const [key, col] = pending.split('|');
    if (focusCell(key, Number(col))) setPending(null);
  }, [pending, value, focusCell]);

  /** 回车跳到下一个输入框；最后一行的备注回车 = 新增一行并聚焦其物料（不会落到删除按钮上） */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]');
    if (!cell) return;
    const [key, colText] = String(cell.dataset.nav).split('|');
    const col = Number(colText);
    if (col === 0) return; // 物料列：回车由扫码下拉按编码精确匹配，选中后自动跳到数量
    e.preventDefault();
    const idx = latest.current.findIndex((r) => r._key === key);
    const go = () => {
      if (col < NAV_LAST) {
        setPending(`${key}|${col + 1}`);
        return;
      }
      const next = latest.current[idx + 1];
      if (next) {
        setPending(`${next._key}|0`);
        return;
      }
      const row = newRow();
      onChange([...latest.current, row]);
      setPending(`${row._key}|0`);
    };
    // 日期框回车先让日期选择器确认输入再跳转
    if (col === 3) setTimeout(go, 0);
    else go();
  };

  /** 删除行：不弹确认，6 秒内可撤销 */
  const remove = (r: LineRow) => {
    const idx = latest.current.findIndex((x) => x._key === r._key);
    onChange(latest.current.filter((x) => x._key !== r._key));
    const mkey = `undo-${r._key}`;
    message.open({
      key: mkey,
      type: 'info',
      duration: 6,
      content: (
        <span>
          已删除第 {idx + 1} 行{r.material_code ? `（${r.material_code}）` : ''}{' '}
          <Typography.Link
            onClick={() => {
              const cur = [...latest.current];
              cur.splice(Math.min(idx, cur.length), 0, r);
              onChange(cur);
              message.destroy(mkey);
            }}
          >
            撤销
          </Typography.Link>
        </span>
      ),
    });
  };

  const cell = (r: LineRow, col: number, node: ReactNode) => <div data-nav={`${r._key}|${col}`}>{node}</div>;
  const locked = (r: LineRow) => lockedRow?.(r) ?? null;

  const columns: TableColumnsType<LineRow> = [
    { title: '#', key: 'idx', width: 44, render: (_, __, i) => i + 1 },
    {
      title: materialLabel, key: 'material', width: 320,
      render: (_, r) => {
        const lk = locked(r);
        if (lk?.material) {
          return (
            <Tooltip title={lk.material}>
              <div style={{ width: 300 }}>
                <span className="mono">{r.material_code}</span> {r.material_name}
              </div>
            </Tooltip>
          );
        }
        return cell(
          r, 0,
          <MaterialSelect
            style={{ width: 300 }}
            params={materialParams}
            value={r.material_id}
            notFoundContent={materialEmpty}
            onPick={(m) => {
              replace(r._key, (old) => {
                const hint = m ? priceHint?.(m.id) : undefined;
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
                  ...(m && !old.unit_price && hint ? { unit_price: hint.price } : {}),
                  ...(m && !old.unit_price && !hint && defaultPrice?.(m) ? { unit_price: defaultPrice(m) } : {}),
                };
                // 物料有采购单位：默认按采购单位录入
                if (purchaseUnit && m && hasPurchaseUnit(row)) row = switchUnit(row, true);
                return row;
              });
              if (m) setPending(`${r._key}|1`);
            }}
          />,
        );
      },
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
              tabIndex={-1}
            />
          </Tooltip>
        ) : (
          r.uom || '-'
        ),
    },
    {
      title: '数量', key: 'qty', width: 130,
      render: (_, r) => {
        const lk = locked(r);
        return cell(
          r, 1,
          r.purchase_uom ? (
            <div>
              <InputNumber min={0} style={{ width: 120 }} value={r.purchase_qty} onChange={(v) => patch(r._key, { purchase_qty: v })} status={r.material_id && !(r.purchase_qty > 0) ? 'error' : undefined} />
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>= {fmtQty(r.qty)} {r.uom}</Typography.Text>
            </div>
          ) : (
            <div>
              <InputNumber
                min={lk?.minQty ?? 0}
                style={{ width: 120 }}
                value={r.qty}
                onChange={(v) => patch(r._key, { qty: v })}
                status={(r.material_id && !(r.qty > 0)) || (lk?.minQty !== undefined && Number(r.qty) < lk.minQty) ? 'error' : undefined}
              />
              {lk?.qtyHint && <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>{lk.qtyHint}</Typography.Text>}
            </div>
          ),
        );
      },
    },
    {
      title: '单价', key: 'unit_price', width: 140,
      render: (_, r) => {
        const lk = locked(r);
        const hint = r.material_id ? priceHint?.(r.material_id) : undefined;
        if (lk?.price) {
          return (
            <Tooltip title={lk.price}>
              <span>{fmtMoney(r.unit_price, currency)}</span>
            </Tooltip>
          );
        }
        return cell(
          r, 2,
          r.purchase_uom ? (
            <div>
              <InputNumber min={0} style={{ width: 130 }} value={r.purchase_price} onChange={(v) => patch(r._key, { purchase_price: v })} />
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>每{r.purchase_uom}，= {fmtQty(r.unit_price, 6)}/{r.uom}</Typography.Text>
            </div>
          ) : (
            <div>
              <InputNumber min={0} style={{ width: 130 }} value={r.unit_price} onChange={(v) => patch(r._key, { unit_price: v })} />
              {hint && (
                <Tooltip title="该客户上次成交价（点击带入）">
                  <Typography.Link style={{ display: 'block', fontSize: 12 }} tabIndex={-1} onClick={() => patch(r._key, { unit_price: hint.price })}>
                    {hint.text}
                  </Typography.Link>
                </Tooltip>
              )}
            </div>
          ),
        );
      },
    },
    { title: '金额', key: 'amount', width: 130, align: 'right', render: (_, r) => fmtMoney(lineAmount(r), currency) },
    {
      title: dateLabel, key: 'date', width: 150,
      render: (_, r) =>
        cell(
          r, 3,
          <DatePicker style={{ width: 140 }} value={r[dateField] ? dayjs(r[dateField]) : null} onChange={(d) => patch(r._key, { [dateField]: d ? d.format('YYYY-MM-DD') : null })} />,
        ),
    },
    {
      title: '备注', key: 'remark', width: 180,
      render: (_, r) => cell(r, 4, <Input value={r.remark ?? ''} onChange={(e) => patch(r._key, { remark: e.target.value })} placeholder={r._key === value[value.length - 1]?._key ? '回车新增一行' : undefined} />),
    },
    {
      title: '', key: 'op', width: 50, fixed: 'right',
      render: (_, r) => {
        const lk = locked(r);
        if (lk?.noDelete) {
          return (
            <Tooltip title={lk.noDelete}>
              <Button type="text" size="small" icon={<DeleteOutlined />} disabled tabIndex={-1} />
            </Tooltip>
          );
        }
        return (
          <Tooltip title="删除此行（可撤销）">
            <Button type="text" danger size="small" icon={<DeleteOutlined />} tabIndex={-1} onClick={() => remove(r)} />
          </Tooltip>
        );
      },
    },
  ];
  return (
    <div ref={wrap} onKeyDown={onKeyDown}>
      <Table<LineRow>
        rowKey="_key"
        size="middle"
        columns={columns}
        dataSource={value}
        pagination={false}
        scroll={{ x: 'max-content' }}
        footer={() => (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <Space size={12} wrap>
              <Button
                type="dashed"
                icon={<PlusOutlined />}
                onClick={() => {
                  const row = newRow();
                  onChange([...value, row]);
                  setPending(`${row._key}|0`);
                }}
              >
                添加一行
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                录入技巧：物料框扫码/输编码回车 → 数量 → 回车依次到单价、日期、备注 → 最后一行回车自动新增一行
              </Typography.Text>
            </Space>
            <span>
              合计金额：<b style={{ fontSize: 16 }}>{fmtMoney(total, currency)}</b>
            </span>
          </div>
        )}
      />
    </div>
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
export function linesBody(rows: LineRow[], dateField: 'delivery_date' | 'expected_date', opts: { withId?: boolean } = {}) {
  return rows
    .filter((r) => r.material_id)
    .map((r) => ({
      ...(opts.withId && r.id ? { id: r.id } : {}),
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

// ---------------- 齐套分析（订单详情 / 工单详情共用，只读） ----------------

/** 在途单据链接：采购单 / 半成品工单 */
function OnOrderLink({ o }: { o: Rec }) {
  const date = o.promised_date || o.delivery_date || o.date;
  if (o.type === 'PO') {
    return (
      <span style={{ whiteSpace: 'nowrap' }}>
        <Link to={`/purchase/orders/${o.po_id}`} className="mono">{o.po_no}</Link>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {' '}未到 {fmtQty(o.open_qty)}{date ? ` · ${o.promised_date ? '回复' : '预计'} ${fmtDate(date)}` : ' · 未填到货日'}
          {o.status === 'DRAFT' && <Tag color="default" style={{ marginInlineStart: 4 }}>草稿未审批</Tag>}
        </Typography.Text>
      </span>
    );
  }
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      <Link to={`/mes/work-orders/${o.wo_id}`} className="mono">{o.wo_no}</Link>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}> 在制 {fmtQty(o.open_qty)}{o.date ? ` · 计划完工 ${fmtDate(o.date)}` : ''}</Typography.Text>
    </span>
  );
}

/** 齐套结论一句话 */
export function kittingSummary(k: Rec | null | undefined): { type: 'success' | 'warning' | 'error' | 'info'; text: string } {
  if (!k) return { type: 'info', text: '正在计算齐套…' };
  if (k.applicable === false) return { type: 'info', text: k.message || '无需齐套检查' };
  if (!k.lines?.length) return { type: 'success', text: k.message || '没有待领物料' };
  if (k.kitted) return { type: 'success', text: '物料齐套：现有合格库存可以满足全部待领需求，可以领料开工' };
  const noEta = (k.lines as Rec[]).filter((l) => l.shortage > 1e-9 && !l.eta).length;
  if (noEta) return { type: 'error', text: `缺料 ${k.shortage_count} 项，其中 ${noEta} 项没有足够的在途（需采购/通知客户补料/安排生产）` };
  return { type: 'warning', text: `缺料 ${k.shortage_count} 项，按在途到货预计 ${fmtDate(k.eta)} 齐套` };
}

/** 齐套明细表：需求、可用、缺口、待检、在途采购单（可点）、预计齐套日 */
export function KittingTable({ data, loading }: { data: Rec | null; loading?: boolean }) {
  const sum = kittingSummary(data);
  const lines: Rec[] = data?.lines || [];
  const columns: TableColumnsType<Rec> = [
    {
      title: '物料', dataIndex: 'material_code', fixed: 'left', width: 220,
      render: (v, r) => (
        <div>
          <Space size={4} wrap>
            <span className="mono">{v}</span>
            {r.customer_supplied && <Tag color="purple">客供料</Tag>}
            {r.category === 'SEMI' && <Tag color="blue">半成品</Tag>}
          </Space>
          <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.material_name}</Typography.Text></div>
        </div>
      ),
    },
    {
      title: <Tooltip title="还要领的数量 = BOM 需求 − 已领">待领需求</Tooltip>, dataIndex: 'required', align: 'right',
      render: (v, r) => (
        <div>
          <b>{fmtQty(v)}</b> <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.uom}</Typography.Text>
          {r.issued > 0 && <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>已领 {fmtQty(r.issued)}/{fmtQty(r.required_total)}</Typography.Text></div>}
        </div>
      ),
    },
    {
      title: <Tooltip title="分给本单的合格库存。库存按 已开工 → 已下达 → 计划开工日 先后分给各工单，排在前面的先用">可用</Tooltip>, dataIndex: 'available', align: 'right',
      render: (v, r) => (
        <div>
          {fmtQty(v)}
          {r.reserved_by_others > 1e-9 && (
            <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>库存 {fmtQty(r.stock_total)}，前序工单占 {fmtQty(r.reserved_by_others)}</Typography.Text></div>
          )}
        </div>
      ),
    },
    {
      title: '缺口', dataIndex: 'shortage', align: 'right',
      render: (v) => (v > 1e-9 ? <b style={{ color: '#cf1322' }}>{fmtQty(v)}</b> : <span style={{ color: '#389e0d' }}>齐套</span>),
    },
    { title: <Tooltip title="已到货待 IQC 检验，检验合格后可用">待检</Tooltip>, dataIndex: 'inspecting', align: 'right', render: (v) => (v > 1e-9 ? fmtQty(v) : '-') },
    {
      title: '在途采购 / 在制', key: 'on_order',
      render: (_, r) =>
        r.on_order?.length ? (
          <Space direction="vertical" size={0}>{r.on_order.map((o: Rec) => <OnOrderLink key={`${o.type}${o.line_id ?? o.wo_id}`} o={o} />)}</Space>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: <Tooltip title="缺口被待检/在途/在制补足的日期">预计齐套</Tooltip>, dataIndex: 'eta',
      render: (v, r) =>
        r.shortage > 1e-9 ? (
          v ? <span style={{ color: '#d48806', whiteSpace: 'nowrap' }}>{fmtDate(v)}</span> : <Typography.Text type="danger" style={{ whiteSpace: 'nowrap' }}>{r.on_order?.length ? '在途不足' : '无在途'}</Typography.Text>
        ) : (
          '-'
        ),
    },
    { title: '说明', dataIndex: 'note', render: (v) => (v ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{v}</Typography.Text> : '') },
  ];
  return (
    <div>
      <Alert type={sum.type} showIcon message={sum.text} style={{ marginBottom: 12 }}
        description={
          data?.uncovered?.length
            ? `含未排产部分：${data.uncovered.map((u: Rec) => `第${u.line_no}行 ${u.material_code} ${fmtQty(u.qty)}${u.has_bom ? '' : '（无已发布 BOM，无法展开）'}`).join('；')}（按 BOM 展开，排在已有工单之后）`
            : undefined
        }
      />
      <Table<Rec>
        rowKey="material_id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={lines}
        pagination={false}
        scroll={{ x: 'max-content' }}
        onRow={(r) => ({ style: r.shortage > 1e-9 ? { background: '#fff7f6' } : undefined })}
        locale={{ emptyText: data?.message || '没有待领物料' }}
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
        齐套检查只读，不生成领料单、不占用库存。可用 = 合格库存（不含不合格品区、过期批次；客供料只算该客户的）按工单先后分配后剩给本单的数量。
      </Typography.Paragraph>
    </div>
  );
}

/** 单号 → 详情链接（已知 id 时直接跳转） */
export function DocLink({ kind, id, no }: { kind: 'po' | 'wo' | 'so'; id?: number | null; no?: string | null }) {
  if (!no) return <span>-</span>;
  if (!id) return <DocNoLink kind={kind} no={no} />;
  const path = kind === 'po' ? '/purchase/orders' : kind === 'wo' ? '/mes/work-orders' : '/sales/orders';
  return <Link to={`${path}/${id}`} className="mono">{no}</Link>;
}
