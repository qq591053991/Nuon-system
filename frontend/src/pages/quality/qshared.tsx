/** 质量模块共用小组件：URL 查询参数初始筛选、日期区间筛选、期限标签。 */
import { Button, DatePicker, Tag, Tooltip } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
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

/**
 * 打印质量单据（检验单、NCR、CAPA、客诉、DHR、追溯报告）：A4、每页页脚“第 x 页 / 共 y 页”、续页页眉（单据名 + 编号）。
 * drawer=true 时只打印当前打开的抽屉内容（不打印背后的列表页）。
 * 与通用 PrintButton 相同的页面设置，另加续页页眉与抽屉打印。
 */
export function printDoc(o: { title: string; landscape?: boolean; drawer?: boolean }) {
  const esc = (t: string) => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const style = document.createElement('style');
  style.id = 'nuon-quality-print';
  style.textContent = `@page { size: A4 ${o.landscape ? 'landscape' : 'portrait'}; margin: 14mm 10mm 14mm;
      @top-right { content: "${esc(o.title)}"; font-size: 8pt; color: #666; }
      @bottom-right { content: "第 " counter(page) " 页 / 共 " counter(pages) " 页"; font-size: 9pt; color: #666; }
      @bottom-left { content: "Nuon 智造云 · 电子记录打印件"; font-size: 9pt; color: #666; } }
    ${o.drawer ? `@media print {
      #root { display: none !important; }
      .ant-drawer { position: static !important; inset: auto !important; }
      .ant-drawer-content-wrapper { position: static !important; width: auto !important; transform: none !important; box-shadow: none !important; }
      .ant-drawer-content { overflow: visible !important; }
      .ant-drawer-mask, .ant-drawer-header { display: none !important; }
      .ant-drawer-body { overflow: visible !important; padding: 0 !important; }
    }` : ''}`;
  document.head.appendChild(style);
  const old = document.title;
  document.title = o.title;
  window.print();
  document.title = old;
  style.remove();
}

/** 打印按钮（质量单据） */
export function QPrintButton({ title, landscape, drawer, text = '打印 / 导出 PDF' }: { title: string; landscape?: boolean; drawer?: boolean; text?: string }) {
  return <Button icon={<PrinterOutlined />} className="no-print" onClick={() => printDoc({ title, landscape, drawer })}>{text}</Button>;
}

/** 打印件签字栏（仅打印时显示） */
export function QPrintSignatures({ roles }: { roles: string[] }) {
  return (
    <div className="print-only">
      <div style={{ display: 'flex', gap: 24, marginTop: 24, fontSize: 12 }}>
        {roles.map((r) => <div key={r} style={{ flex: 1, borderTop: '1px solid #000', paddingTop: 4 }}>{r}：　　　　　　日期：</div>)}
      </div>
    </div>
  );
}

/** 国家/地区（统一中文；决定不良事件上报时限） */
export const COUNTRIES = ['中国', '美国', '欧盟', '德国', '法国', '意大利', '西班牙', '荷兰', '英国', '日本', '韩国', '澳大利亚', '加拿大', '其他'];
const COUNTRY_ALIAS: Record<string, string> = { US: '美国', USA: '美国', EU: '欧盟', CN: '中国', DE: '德国', FR: '法国', IT: '意大利', ES: '西班牙', NL: '荷兰', GB: '英国', UK: '英国', JP: '日本', KR: '韩国', AU: '澳大利亚', CA: '加拿大' };
export const normCountry = (v?: string | null) => (v ? COUNTRY_ALIAS[String(v).trim().toUpperCase()] ?? String(v).trim() : v ?? null);
const EU = ['欧盟', '德国', '法国', '意大利', '西班牙', '荷兰'];
/** 上报时限（天）：美国 FDA MDR 30；欧盟 MDR 15；中国及其他 20（与后端一致） */
export const reportDays = (country?: string | null) => {
  const c = normCountry(country) ?? '';
  return c === '美国' ? 30 : EU.includes(c) ? 15 : 20;
};
