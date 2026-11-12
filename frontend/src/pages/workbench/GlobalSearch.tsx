/**
 * 全局搜索 / 扫码条（G1）：单号、序列号、批号、UDI/GS1 原始串、物料、库位，一个框搞定。
 *  - 扫码枪“键入 + 回车”：回车立即查询（不等防抖），唯一结果（或唯一的完全匹配）直接跳转；
 *    多条结果展开下拉让人选；查无结果提示“未找到”，并选中输入内容方便下一枪覆盖。
 *  - 用方向键在下拉中选中某一项后回车，跳到该项。
 *  - 状态显示中文（后端 status_label）。
 */
import { AutoComplete, Input, Tag, Typography, message, type InputRef } from 'antd';
import { LoadingOutlined, ScanOutlined } from '@ant-design/icons';
import { useRef, useState, type KeyboardEvent } from 'react';
import { get, type Rec } from '../../api/http';
import { useGo } from './links';

interface Hit extends Rec {
  type: string;
  type_text: string;
  title: string;
  sub?: string | null;
  status_label?: string | null;
  url: string;
  exact?: boolean;
  alt?: { label: string; url: string }[];
}

/** 结果唯一（或唯一完全匹配）时返回该条 */
export function pickUnique(rows: Hit[]): Hit | null {
  const exact = rows.filter((r) => r.exact);
  if (exact.length === 1) return exact[0];
  if (rows.length === 1) return rows[0];
  return null;
}

export default function GlobalSearch({ narrow }: { narrow?: boolean }) {
  const go = useGo();
  const [val, setVal] = useState('');
  const [rows, setRows] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const seq = useRef(0);
  const kbdNav = useRef(false);
  const inputRef = useRef<InputRef>(null);

  const fetchRows = async (q: string) => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const r: Hit[] = await get('/search', { q }, true).catch(() => []);
      if (my === seq.current) setRows(r);
      return r;
    } finally {
      if (my === seq.current) setLoading(false);
    }
  };

  const reset = () => {
    clearTimeout(timer.current);
    seq.current++;
    setVal('');
    setRows([]);
    setOpen(false);
    setLoading(false);
    kbdNav.current = false;
  };

  const jump = (h: Hit, url = h.url) => {
    reset();
    inputRef.current?.blur();
    go(url);
  };

  const onSearch = (q: string) => {
    setVal(q);
    kbdNav.current = false;
    clearTimeout(timer.current);
    if (!q.trim()) {
      seq.current++;
      setRows([]);
      setOpen(false);
      return;
    }
    timer.current = setTimeout(async () => {
      await fetchRows(q);
      setOpen(true);
    }, 250);
  };

  const onKeyDown = async (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      kbdNav.current = true;
      return;
    }
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (e.key !== 'Enter') return;
    // 用方向键选中了下拉项：交给下拉的 onSelect
    if (kbdNav.current && open && rows.length) return;
    e.preventDefault();
    const q = (e.currentTarget.value || val).trim();
    if (!q) return;
    clearTimeout(timer.current);
    const r = await fetchRows(q);
    const one = pickUnique(r);
    if (one) return jump(one);
    if (!r.length) {
      setOpen(false);
      message.warning(`未找到“${q}”。可搜索：单号、序列号、批号、UDI、物料编码、库位编码`);
      inputRef.current?.select();
      return;
    }
    setOpen(true);
    kbdNav.current = false;
    if (!narrow) message.info(`找到 ${r.length} 条结果，请用方向键或鼠标选择`);
  };

  // 完全匹配的排在最前（单独一组），其余按类型分组
  const exact = rows.filter((r) => r.exact);
  const groups: [string, Hit[]][] = [];
  if (exact.length && exact.length < rows.length) groups.push(['完全匹配', exact]);
  const rest = exact.length && exact.length < rows.length ? rows.filter((r) => !r.exact) : rows;
  for (const r of rest) {
    const g = groups.find(([label]) => label === r.type_text);
    if (g) g[1].push(r);
    else groups.push([r.type_text, [r]]);
  }
  const options = groups.map(([label, items]) => ({
    label,
    options: items.map((r) => ({
      value: String(rows.indexOf(r)),
      label: (
        <div className="gs-opt">
          <div className="gs-opt-main">
            <span className="gs-opt-title mono">{r.title}</span>
            {label === '完全匹配' && <Tag style={{ marginInlineEnd: 0 }}>{r.type_text}</Tag>}
            {r.status_label && <Tag color="blue" style={{ marginInlineEnd: 0 }}>{r.status_label}</Tag>}
          </div>
          <div className="gs-opt-sub">
            <Typography.Text type="secondary" ellipsis style={{ flex: 1, minWidth: 0 }}>{r.sub}</Typography.Text>
            {r.alt?.map((a) => (
              <a
                key={a.url}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  jump(r, a.url);
                }}
              >
                {a.label}
              </a>
            ))}
          </div>
        </div>
      ),
    })),
  }));

  return (
    <AutoComplete
      className="global-search"
      style={narrow ? { flex: 1, minWidth: 0 } : { width: 380, maxWidth: '40vw' }}
      options={options}
      value={val}
      open={open && rows.length > 0}
      onOpenChange={(v) => setOpen(v && rows.length > 0)}
      defaultActiveFirstOption={false}
      popupMatchSelectWidth={narrow ? true : 520}
      classNames={narrow ? { popup: { root: 'gs-popup-narrow' } } : undefined}
      onSearch={onSearch}
      onSelect={(v: string) => {
        const h = rows[Number(v)];
        if (h) jump(h);
      }}
    >
      <Input
        ref={inputRef}
        prefix={<ScanOutlined style={{ color: '#999' }} />}
        suffix={loading ? <LoadingOutlined style={{ color: '#999' }} /> : <span />}
        placeholder={narrow ? '搜索单号 / 扫码' : '搜索单号 / 序列号 / 批号 / UDI / 物料 / 库位（支持扫码枪）'}
        allowClear
        onKeyDown={onKeyDown}
        enterKeyHint="search"
      />
    </AutoComplete>
  );
}
