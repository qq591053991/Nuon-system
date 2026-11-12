import { Select, message, type SelectProps } from 'antd';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
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
  /** 扫码/回车时用于精确匹配的字段（默认 code、no、sn、username、lot_no 与 valueKey） */
  matchKeys?: string[];
  /** 查无结果时提示用的对象名，如“库位” */
  noun?: string;
}

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();

/**
 * 远程搜索下拉框（输入关键字实时搜索）。
 * 扫码安全：输入/扫码后按回车，按编码等字段**精确匹配**后再选中；搜索结果未返回时不会误选列表第一项；
 * 查无此码时明确提示，不会选中其他记录（扫码枪 = 键入 + 回车）。
 */
export default function RemoteSelect({ url, params, labelOf, valueKey = 'id', onPick, matchKeys, noun = '记录', ...rest }: Props) {
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  // 非受控用法（未传 value，如列表筛选框）时自己保存选中值，保证扫码选中后界面能显示
  const controlled = 'value' in rest;
  const [inner, setInner] = useState<any>(rest.defaultValue);
  const timer = useRef<any>();
  const cache = useRef<Map<any, Rec>>(new Map());
  const label = labelOf || ((r: Rec) => (r.code ? `${r.code} ${r.name ?? ''}` : r.name ?? String(r[valueKey])));
  const pkey = JSON.stringify(params || {});
  const keys = matchKeys ?? ['code', 'no', 'sn', 'username', 'lot_no', valueKey];

  const fetchRows = async (q?: string): Promise<Rec[]> => {
    const d = await get(url, { q, page_size: 50, ...(params || {}) }, true);
    const items: Rec[] = Array.isArray(d) ? d : d.items;
    items.forEach((r) => cache.current.set(r[valueKey], r));
    return items;
  };

  const load = (q?: string) => {
    setLoading(true);
    fetchRows(q).then(setRows).catch(() => undefined).finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, pkey]);

  // 确保已选中的值在选项中（编辑表单回显）
  useEffect(() => {
    const v = controlled ? rest.value : inner;
    if (v !== undefined && v !== null && !Array.isArray(v) && !cache.current.has(v) && typeof v === 'number') {
      get(`${url}/${v}`, undefined, true).then((r) => {
        cache.current.set(v, r);
        setRows((old) => (old.some((o) => o[valueKey] === v) ? old : [r, ...old]));
      }).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rest.value, inner]);

  const options = useMemo(() => rows.map((r) => ({ value: r[valueKey], label: label(r) })), [rows]); // eslint-disable-line

  const pick = (r: Rec) => {
    const v = r[valueKey];
    setRows((old) => (old.some((o) => o[valueKey] === v) ? old : [r, ...old]));
    const next = rest.mode === 'multiple' || rest.mode === 'tags'
      ? [...new Set([...(Array.isArray(controlled ? rest.value : inner) ? (controlled ? rest.value : inner) : []), v])]
      : v;
    if (!controlled) setInner(next);
    rest.onChange?.(next as any, { value: v, label: label(r) } as any);
    onPick?.(r);
    setText('');
    setOpen(false);
  };

  /** 回车：按输入精确匹配（扫码），而不是选中列表里高亮的第一项 */
  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || !text.trim()) return;
    e.preventDefault();
    e.stopPropagation();
    const q = text.trim();
    clearTimeout(timer.current);
    setLoading(true);
    fetchRows(q)
      .then((items) => {
        setRows(items);
        const exact = items.filter((r) => keys.some((k) => norm(r[k]) === norm(q)) || norm(label(r).split(' ')[0]) === norm(q));
        if (exact.length === 1) return pick(exact[0]);
        if (exact.length === 0 && items.length === 1) return pick(items[0]); // 手工输入片段且只有一个结果
        if (exact.length > 1) return void message.warning(`“${q}”匹配到多个${noun}，请从列表中选择`);
        message.error(`未找到“${q}”对应的${noun}，请核对后重扫`);
        setText(''); // 清空错误的码，原选中值保持不变，可直接重扫
      })
      .catch(() => message.error('查询失败，请重试'))
      .finally(() => setLoading(false));
  };

  return (
    <div onKeyDownCapture={onKeyDownCapture} style={{ width: (rest.style as any)?.width ?? '100%' }}>
      <Select
        showSearch
        allowClear
        filterOption={false}
        loading={loading}
        placeholder="输入编码或名称搜索（可扫码）"
        searchValue={text}
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setText('');
        }}
        onSearch={(q) => {
          setText(q);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => load(q), 250);
        }}
        options={options}
        {...rest}
        value={controlled ? rest.value : inner}
        style={{ ...(rest.style || {}), width: '100%' }}
        onChange={(v, o) => {
          if (!controlled) setInner(v);
          rest.onChange?.(v, o);
          onPick?.(cache.current.get(v));
          setText('');
        }}
      />
    </div>
  );
}

type P = Omit<Props, 'url'>;
export const MaterialSelect = (p: P) => <RemoteSelect url="/materials" noun="物料" {...p} labelOf={(r) => `${r.code} ${r.name}${r.spec ? ' | ' + r.spec : ''}`} />;
export const CustomerSelect = (p: P) => <RemoteSelect url="/customers" noun="客户" {...p} />;
export const SupplierSelect = (p: P) => <RemoteSelect url="/suppliers" noun="供应商" {...p} />;
export const WarehouseSelect = (p: P) => <RemoteSelect url="/warehouses" noun="仓库" {...p} />;
export const LocationSelect = (p: P) => <RemoteSelect url="/locations" noun="库位" {...p} labelOf={(r) => `${r.code} ${r.name ?? ''}（${r.warehouse_name ?? ''}）`} />;
export const EquipmentSelect = (p: P) => <RemoteSelect url="/equipment" noun="设备" {...p} labelOf={(r) => `${r.code} ${r.name}`} />;
export const WorkCenterSelect = (p: P) => <RemoteSelect url="/work-centers" noun="工作中心" {...p} />;
