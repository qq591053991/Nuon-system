import { Select, type SelectProps } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { get, type Rec } from '../api/http';

interface Props extends Omit<SelectProps, 'options' | 'onSearch'> {
  /** 列表接口，如 /materials（需返回 {items}，或数组） */
  url: string;
  params?: Rec;
  /** 选项显示文本 */
  labelOf?: (r: Rec) => string;
  valueKey?: string;
  /** 选中时回调整条记录 */
  onPick?: (r: Rec | undefined) => void;
}

/** 远程搜索下拉框（输入关键字实时搜索） */
export default function RemoteSelect({ url, params, labelOf, valueKey = 'id', onPick, ...rest }: Props) {
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<any>();
  const cache = useRef<Map<any, Rec>>(new Map());
  const label = labelOf || ((r: Rec) => (r.code ? `${r.code} ${r.name ?? ''}` : r.name ?? String(r[valueKey])));
  const pkey = JSON.stringify(params || {});

  const load = (q?: string) => {
    setLoading(true);
    get(url, { q, page_size: 50, ...(params || {}) }, true)
      .then((d) => {
        const items: Rec[] = Array.isArray(d) ? d : d.items;
        items.forEach((r) => cache.current.set(r[valueKey], r));
        setRows(items);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, pkey]);

  // 确保已选中的值在选项中（编辑表单回显）
  useEffect(() => {
    const v = rest.value;
    if (v !== undefined && v !== null && !Array.isArray(v) && !cache.current.has(v) && typeof v === 'number') {
      get(`${url}/${v}`, undefined, true).then((r) => {
        cache.current.set(v, r);
        setRows((old) => (old.some((o) => o[valueKey] === v) ? old : [r, ...old]));
      }).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rest.value]);

  const options = useMemo(() => rows.map((r) => ({ value: r[valueKey], label: label(r) })), [rows]); // eslint-disable-line

  return (
    <Select
      showSearch
      allowClear
      filterOption={false}
      loading={loading}
      placeholder="输入编码或名称搜索"
      onSearch={(q) => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => load(q), 250);
      }}
      options={options}
      {...rest}
      onChange={(v, o) => {
        rest.onChange?.(v, o);
        onPick?.(cache.current.get(v));
      }}
    />
  );
}

type P = Omit<Props, 'url'>;
export const MaterialSelect = (p: P) => <RemoteSelect url="/materials" {...p} labelOf={(r) => `${r.code} ${r.name}${r.spec ? ' | ' + r.spec : ''}`} />;
export const CustomerSelect = (p: P) => <RemoteSelect url="/customers" {...p} />;
export const SupplierSelect = (p: P) => <RemoteSelect url="/suppliers" {...p} />;
export const WarehouseSelect = (p: P) => <RemoteSelect url="/warehouses" {...p} />;
export const LocationSelect = (p: P) => <RemoteSelect url="/locations" {...p} labelOf={(r) => `${r.code} ${r.name ?? ''}（${r.warehouse_name ?? ''}）`} />;
export const EquipmentSelect = (p: P) => <RemoteSelect url="/equipment" {...p} labelOf={(r) => `${r.code} ${r.name}`} />;
export const WorkCenterSelect = (p: P) => <RemoteSelect url="/work-centers" {...p} />;
