/** MES/QMS 页面共用的小工具：测试规格文本、规格判定、测试值展示。 */
import { Space, Tag, Typography } from 'antd';
import type { Rec } from '../../api/http';

export interface SpecParam {
  code?: string;
  name: string;
  unit?: string | null;
  lower?: number | null;
  upper?: number | null;
  target?: number | null;
  /** NUMBER = 数值；OKNG = 合格判定（1 = OK，0 = NG） */
  param_type?: string | null;
  /** 小数位数（录入限制） */
  decimals?: number | null;
  /** 合理输入范围（超出 = 录入错误） */
  min_valid?: number | null;
  max_valid?: number | null;
}

/** OK/NG 判定型测试项在测试数据中的单位标记（值 1 = OK，0 = NG） */
export const OKNG_UNIT = 'OK/NG';
export const isOkNg = (p: { param_type?: string | null; unit?: string | null }) => p.param_type === 'OKNG' || p.unit === OKNG_UNIT;

export const PRIORITY_OPTIONS = [
  { value: 1, label: '1 - 特急' },
  { value: 2, label: '2 - 急' },
  { value: 3, label: '3 - 普通' },
  { value: 4, label: '4 - 低' },
  { value: 5, label: '5 - 最低' },
];

/** 数字的简洁显示（去掉多余的 0） */
export const num = (v?: number | null) => (v === null || v === undefined ? '-' : String(Number(Number(v).toFixed(6))));

/** 规格文本：40~60 mW/cm² / ≥4 h / ≤5 mA */
export function specText(p: SpecParam, withUnit = true): string {
  if (isOkNg(p)) return 'OK / NG 判定';
  const u = withUnit && p.unit ? ` ${p.unit}` : '';
  const lo = p.lower ?? null;
  const up = p.upper ?? null;
  if (lo !== null && up !== null) return `${num(lo)}~${num(up)}${u}`;
  if (lo !== null) return `≥${num(lo)}${u}`;
  if (up !== null) return `≤${num(up)}${u}`;
  return '记录值';
}

/** 是否在规格内；未录入返回 null */
export function inSpec(p: SpecParam, v?: number | null): boolean | null {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  if (isOkNg(p)) return v === 1;
  const eps = 1e-9;
  return (p.lower == null || v >= p.lower - eps) && (p.upper == null || v <= p.upper + eps);
}

/** 单个测试值的文本："辐照度=50.1mW/cm²(40~60) ✓" */
export function valueText(v: Rec): string {
  if (isOkNg(v)) return `${v.name}=${Number(v.value) === 1 ? 'OK' : 'NG'} ${v.result === 'FAIL' ? '✗' : '✓'}`;
  const spec = v.lower == null && v.upper == null ? '' : `(${specText(v as SpecParam, false)})`;
  return `${v.name}=${num(v.value)}${v.unit ?? ''}${spec} ${v.result === 'FAIL' ? '✗' : '✓'}`;
}

/** 测试值列表（不合格项标红） */
export function ValuesText({ values, block }: { values?: Rec[]; block?: boolean }) {
  if (!values?.length) return <Typography.Text type="secondary">-</Typography.Text>;
  return (
    <Space direction={block ? 'vertical' : 'horizontal'} size={block ? 0 : 12} wrap>
      {values.map((v, i) => (
        <span key={i} style={{ color: v.result === 'FAIL' ? '#cf1322' : undefined, whiteSpace: 'nowrap' }}>{valueText(v)}</span>
      ))}
    </Space>
  );
}

/** 测试规格列表（工序参数） */
export function ParamsText({ params }: { params?: SpecParam[] }) {
  if (!params?.length) return <Typography.Text type="secondary">无测试项</Typography.Text>;
  return (
    <Space size={[4, 4]} wrap style={{ maxWidth: 440 }}>
      {params.map((p) => (
        <Tag key={p.code || p.name} style={{ marginInlineEnd: 0, whiteSpace: 'normal' }}>{p.name}：{specText(p)}</Tag>
      ))}
    </Space>
  );
}

/** 从后端错误中取出中文提示 */
export const errDetail = (e: any): string => {
  const d = e?.response?.data?.detail;
  if (Array.isArray(d)) return d.map((x: any) => x.msg).join('；');
  return d || e?.message || '操作失败';
};
