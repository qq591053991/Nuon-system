/** 质量模块共用小组件：URL 查询参数初始筛选、日期区间筛选、期限标签。 */
import { DatePicker, Tag, Tooltip } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { http, type Rec } from '../../api/http';
import { toDate } from '../../utils/format';

/** 读取 URL 查询参数作为列表初始筛选（只取 keys 中的参数；alias 把 URL 参数名映射为接口参数名） */
export function useUrlFilters(keys: string[], alias: Record<string, string> = {}): Rec {
  const [sp] = useSearchParams();
  const key = sp.toString();
  return useMemo(() => {
    const out: Rec = {};
    for (const k of keys) {
      const v = sp.get(k);
      if (v !== null && v !== '') out[alias[k] ?? k] = v;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** 日期区间筛选：onChange({date_from, date_to}) */
export function DateRangeFilter({ onChange, placeholder = ['开始日期', '结束日期'], from, to }: {
  onChange: (v: { date_from?: string; date_to?: string }) => void; placeholder?: [string, string]; from?: string; to?: string;
}) {
  const value: [Dayjs, Dayjs] | undefined = from && to ? [dayjs(from), dayjs(to)] : undefined;
  return (
    <DatePicker.RangePicker
      allowClear
      defaultValue={value}
      placeholder={placeholder}
      style={{ width: 240 }}
      presets={[
        { label: '今天', value: [dayjs(), dayjs()] },
        { label: '最近 7 天', value: [dayjs().subtract(6, 'day'), dayjs()] },
        { label: '本月', value: [dayjs().startOf('month'), dayjs()] },
        { label: '上月', value: [dayjs().subtract(1, 'month').startOf('month'), dayjs().subtract(1, 'month').endOf('month')] },
      ]}
      onChange={(v) => onChange({ date_from: v?.[0] ? toDate(v[0])! : undefined, date_to: v?.[1] ? toDate(v[1])! : undefined })}
    />
  );
}

/** NCR 处置期限标签：超期红色、3 天内橙色 */
export function DueTag({ r }: { r: Rec }) {
  if (!r.due_on) return <span>-</span>;
  if (r.status !== 'OPEN') return <span style={{ color: '#8c8c8c' }}>{r.due_on}</span>;
  const left: number = r.days_left ?? 0;
  const tip = r.due_date ? '处置期限' : '处置期限（按严重度自动推算）';
  if (left < 0) return <Tooltip title={tip}><Tag color="red" style={{ marginInlineEnd: 0 }}>超期 {-left} 天 · {r.due_on.slice(5)}</Tag></Tooltip>;
  if (left === 0) return <Tooltip title={tip}><Tag color="volcano" style={{ marginInlineEnd: 0 }}>今天到期</Tag></Tooltip>;
  if (left <= 3) return <Tooltip title={tip}><Tag color="orange" style={{ marginInlineEnd: 0 }}>剩 {left} 天 · {r.due_on.slice(5)}</Tag></Tooltip>;
  return <Tooltip title={tip}><span>{r.due_on}（剩 {left} 天）</span></Tooltip>;
}

/** 数字格式：去掉多余 0 */
export const g = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(Math.round(v * 10000) / 10000));

/** 上下限文本：655 ~ 665 nm / ≥ 10 / ≤ 5 */
export function limitText(lower?: number | null, upper?: number | null, unit?: string | null) {
  const u = unit ? ` ${unit}` : '';
  if (lower !== null && lower !== undefined && upper !== null && upper !== undefined) return `${g(lower)} ~ ${g(upper)}${u}`;
  if (lower !== null && lower !== undefined) return `≥ ${g(lower)}${u}`;
  if (upper !== null && upper !== undefined) return `≤ ${g(upper)}${u}`;
  return '-';
}

/** PUT（不弹出错误提示：用于签名弹窗内提交，由弹窗显示错误原因） */
export async function putSilent<T = any>(url: string, body?: unknown): Promise<T> {
  return (await http.put<T>(url, body, { silent: true } as any)).data;
}
