/** WMS / 追溯页面共用的小组件（仅本目录及 Trace 页使用） */
import { Tag, Tooltip, Typography } from 'antd';
import dayjs from 'dayjs';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { fmtDate, fmtQty } from '../../utils/format';

export const traceLotUrl = (code?: string | null, lot?: string | null) =>
  `/trace?material_code=${encodeURIComponent(code || '')}&lot_no=${encodeURIComponent(lot || '')}`;
export const traceSnUrl = (sn: string) => `/trace?sn=${encodeURIComponent(sn)}`;

/** 物料：编码（粗体）+ 名称/规格（灰色） */
export function MaterialCell({ code, name, spec, extra }: { code?: string | null; name?: string | null; spec?: string | null; extra?: ReactNode }) {
  return (
    <div style={{ lineHeight: 1.35, minWidth: 140 }}>
      <span style={{ fontWeight: 600 }}>{code || '-'}</span>
      {extra && <span style={{ marginLeft: 6 }}>{extra}</span>}
      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {name}
          {spec ? ` | ${spec}` : ''}
        </Typography.Text>
      </div>
    </div>
  );
}

/** 批号：点击跳转批次正向追溯 */
export function LotLink({ code, lot }: { code?: string | null; lot?: string | null }) {
  if (!lot) return <span style={{ color: '#bbb' }}>-</span>;
  if (!code) return <span className="mono">{lot}</span>;
  return (
    <Tooltip title="查看批次追溯">
      <Link className="mono" to={traceLotUrl(code, lot)}>{lot}</Link>
    </Tooltip>
  );
}

/** 序列号：点击跳转序列号反向追溯 */
export function SnLink({ sn }: { sn?: string | null }) {
  if (!sn) return <span>-</span>;
  return <Link className="mono" to={traceSnUrl(sn)}>{sn}</Link>;
}

/** 有效期：已过期红色、warnDays 天内到期橙色 */
export function ExpiryDate({ value, warnDays = 30 }: { value?: string | null; warnDays?: number }) {
  if (!value) return <span style={{ color: '#bbb' }}>-</span>;
  const days = dayjs(value).startOf('day').diff(dayjs().startOf('day'), 'day');
  if (days < 0) {
    return <Tooltip title={`已过期 ${-days} 天，禁止使用`}><span style={{ color: '#cf1322', fontWeight: 600 }}>{fmtDate(value)} 已过期</span></Tooltip>;
  }
  if (days <= warnDays) {
    return <Tooltip title={`${days} 天后到期`}><span style={{ color: '#d46b08', fontWeight: 600 }}>{fmtDate(value)}</span></Tooltip>;
  }
  return <span>{fmtDate(value)}</span>;
}

/** 客供料标记 */
export function CsTag({ name }: { name?: string | null }) {
  return (
    <Tooltip title={name ? `客供料，货主：${name}` : '客供料（客户提供，只能用于该客户订单）'}>
      <Tag color="purple" style={{ marginInlineEnd: 0 }}>客供</Tag>
    </Tooltip>
  );
}

/** 数量 + 单位 */
export function Qty({ qty, uom, strong }: { qty?: number | null; uom?: string | null; strong?: boolean }) {
  return (
    <span style={{ whiteSpace: 'nowrap', fontWeight: strong ? 600 : undefined }}>
      {fmtQty(qty)}
      {uom && <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 3 }}>{uom}</Typography.Text>}
    </span>
  );
}

/** 库存流水来源单据 → 链接 */
export function refLink(type?: string | null, id?: number | null, no?: string | null): ReactNode {
  if (!no) return '-';
  const q = encodeURIComponent(no);
  const to: Record<string, string | undefined> = {
    RECEIPT: `/wms/receipts?q=${q}`,
    ISSUE: `/wms/issues?q=${q}`,
    SHIPMENT: `/wms/shipments?q=${q}`,
    CUSTOMER_RETURN: `/wms/customer-returns?q=${q}`,
    STOCK_COUNT: id ? `/wms/counts?id=${id}` : undefined,
    INSPECTION: id ? `/quality/inspections/${id}` : undefined,
    NCR: `/quality/ncrs?q=${q}`,
    WORK_ORDER: id ? `/mes/work-orders/${id}` : undefined,
  };
  const url = type ? to[type] : undefined;
  return url ? <Link className="mono" to={url}>{no}</Link> : <span className="mono">{no}</span>;
}

/** 将数组导出为 CSV（Excel 可直接打开，含 BOM 防中文乱码） */
export function exportCsv(filename: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const esc = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = '﻿' + [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
