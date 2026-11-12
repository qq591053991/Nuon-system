/**
 * 工程数据（BOM / 工艺路线）详情页共用：
 * - SignatureHistory：电子签名记录（编制提交、驳回、批准）；
 * - DiffCard：与上一版本的差异（F11 / D#2：新增绿、删除红、修改显示旧值 → 新值，判定规格变化醒目；变更原因未覆盖时提示）；
 * - useUnsavedGuard：有未保存修改时拦截离开页面（F10）。
 */
import { Alert, App, Card, Empty, Space, Spin, Table, Tag, Typography, type TableColumnsType } from 'antd';
import { DiffOutlined, WarningOutlined } from '@ant-design/icons';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { UNSAFE_NavigationContext } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { dictLabel } from '../../utils/dict';
import { fmtDateTime } from '../../utils/format';

const color = (meaning: string) => (meaning.includes('驳回') ? 'red' : meaning.includes('批准') ? 'green' : 'blue');

export function SignatureHistory({ entity, id, stamp }: { entity: 'eng_bom' | 'eng_routing'; id: number; stamp?: string }) {
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    get(`/${entity === 'eng_bom' ? 'boms' : 'routings'}/${id}/signatures`, undefined, true)
      .then((d) => setRows(Array.isArray(d) ? [...d].reverse() : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [entity, id, stamp]);

  const columns: TableColumnsType<Rec> = [
    { title: '时间', dataIndex: 'ts', width: 170, render: (v) => fmtDateTime(v) },
    { title: '签名含义', dataIndex: 'meaning', width: 160, render: (v) => <Tag color={color(v)}>{v}</Tag> },
    { title: '签名人', key: 'who', width: 160, render: (_, r) => <span>{r.full_name} <Typography.Text type="secondary">({r.username})</Typography.Text></span> },
    { title: '理由 / 意见', dataIndex: 'reason', render: (v) => v || '-' },
  ];
  return (
    <Table
      rowKey="id"
      size="small"
      loading={loading}
      columns={columns}
      dataSource={rows}
      pagination={false}
      locale={{ emptyText: '尚无签名记录' }}
      scroll={{ x: 'max-content' }}
    />
  );
}

// ------------------------------------------------------------------ 版本差异
export interface DiffItem {
  kind: 'added' | 'removed' | 'changed';
  scope: 'operation' | 'param' | 'line';
  key: string;
  title: string;
  field?: string;
  label?: string;
  before?: unknown;
  after?: unknown;
  limit?: boolean;
  text: string;
}
export interface DiffResult {
  base: { id: number; version: string; status: string } | null;
  items: DiffItem[];
  summary: string;
}

const KIND: Record<DiffItem['kind'], [string, string]> = { added: ['新增', 'green'], removed: ['删除', 'red'], changed: ['修改', 'blue'] };
const shown = (v: unknown, field?: string) => {
  if (v === null || v === undefined || v === '') return '空';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (field === 'param_type') return v === 'OKNG' ? 'OK/NG 判定' : '数值';
  if (field === 'scrap_rate' && typeof v === 'number') return `${Math.round(v * 10000) / 100}%`;
  return String(v);
};

/** 差异的定位：按 key 汇总（编辑表格高亮行用） */
export function diffIndex(d: DiffResult | null) {
  const m = new Map<string, DiffItem['kind']>();
  for (const i of d?.items ?? []) if (!m.has(i.key) || i.kind !== 'changed') m.set(i.key, i.kind);
  return m;
}

/** 需要在变更原因里说明的变化（D-N13）：判定规格 / 用量、增删工序 / 测试项 / 组件 / 附件、工时、SOP、需设备、关键件、测试项顺序 */
const IMPORTANT_FIELDS = new Set(['std_minutes', 'sop_no', 'requires_equipment', 'key_part_material_id', 'param_order', 'attachment', 'op_type', 'seq']);
export const importantChange = (i: DiffItem) => !!i.limit || i.kind !== 'changed' || IMPORTANT_FIELDS.has(i.field ?? '');

/** 变更原因是否提到了这些变化（按测试项/组件/工序的编码或名称、名称前两个字粗略判断；纯数字不算） */
function uncovered(items: DiffItem[], reason?: string | null) {
  const r = (reason || '').toUpperCase();
  return items.filter((i) => {
    if (!importantChange(i)) return false;
    const obj = i.title.split(' · ')[i.title.includes(' · 测试项') ? 1 : 0] || i.title;
    const words = obj.split(/\s+/).filter((w) => w.length >= 2 && !/^\d+$/.test(w) && !['工序', '测试项', '组件', '附件'].includes(w));
    return !words.some((w) => r.includes(w.toUpperCase()) || (/[\u4e00-\u9fa5]/.test(w) && r.includes(w.slice(0, 2))));
  });
}

/** 关键变化的叫法：工艺 = 判定规格变化；BOM = 用量变化 */
const limitName = (i: DiffItem) => (i.scope === 'line' ? '用量变化' : '判定规格变化');

interface DiffProps {
  /** GET 差异地址（如 /routings/12/diff） */
  url: string;
  /** 编辑中：未保存内容（POST 实时对比） */
  draft?: Rec | null;
  /** 变更原因（检查判定规格变化是否写进原因） */
  reason?: string | null;
  /** 数据变化标记（已保存内容变化时刷新） */
  stamp?: unknown;
  onResult?: (d: DiffResult | null) => void;
  /** 默认展开（审批页） */
  emphasize?: boolean;
}

/** 与上一版本的差异卡片 */
export function DiffCard({ url, draft, reason, stamp, onResult, emphasize }: DiffProps) {
  const [d, setD] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const body = useMemo(() => (draft ? JSON.stringify(draft) : null), [draft]);
  const cb = useRef(onResult);
  cb.current = onResult;

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      setLoading(true);
      (body ? post(url, JSON.parse(body), true) : get(url, undefined, true))
        .then((r: DiffResult) => {
          if (!alive) return;
          setD(r);
          cb.current?.(r);
        })
        .catch(() => alive && setD(null))
        .finally(() => alive && setLoading(false));
    }, body ? 500 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [url, body, stamp]);

  const items = d?.items ?? [];
  const limits = items.filter((i) => i.limit);
  const miss = reason === undefined ? [] : uncovered(items, reason);
  const count = (k: DiffItem['kind']) => items.filter((i) => i.kind === k).length;

  const columns: TableColumnsType<DiffItem> = [
    { title: '变化', dataIndex: 'kind', width: 70, render: (v: DiffItem['kind']) => <Tag color={KIND[v][1]}>{KIND[v][0]}</Tag> },
    { title: '对象', dataIndex: 'title', width: 300, render: (v, r) => <span style={{ fontWeight: r.limit ? 700 : 400 }}>{v}</span> },
    {
      title: '内容',
      key: 'c',
      render: (_, r) => {
        if (r.kind === 'changed') {
          return (
            <span style={r.limit ? { background: '#fff1f0', padding: '2px 6px', borderRadius: 4 } : undefined}>
              {r.limit && <WarningOutlined style={{ color: '#cf1322', marginRight: 4 }} />}
              {r.label}：<del style={{ color: '#cf1322' }}>{shown(r.before, r.field)}</del> → <b style={{ color: '#237804' }}>{shown(r.after, r.field)}</b>
              {r.limit && <Tag color="red" style={{ marginLeft: 8 }}>{limitName(r)}</Tag>}
            </span>
          );
        }
        return <span style={{ color: r.kind === 'added' ? '#237804' : '#cf1322' }}>{r.text}{r.limit && <Tag color="red" style={{ marginLeft: 8 }}>{r.scope === 'line' ? '用量变化' : '影响判定'}</Tag>}</span>;
      },
    },
  ];

  return (
    <Card
      size="small"
      style={emphasize && items.length ? { borderColor: '#5b3cc4', borderWidth: 2 } : undefined}
      title={
        <Space wrap>
          <DiffOutlined />与上一版本差异
          {d?.base && <Typography.Text type="secondary">对比 {d.base.version}（{dictLabel('eng_status', d.base.status)}）</Typography.Text>}
          {loading && <Spin size="small" />}
          {items.length > 0 && (
            <>
              <Tag color="green">新增 {count('added')}</Tag>
              <Tag color="red">删除 {count('removed')}</Tag>
              <Tag color="blue">修改 {count('changed')}</Tag>
              {limits.length > 0 && <Tag color="red" icon={<WarningOutlined />}>{limitName(limits[0])} {limits.length}</Tag>}
            </>
          )}
        </Space>
      }
    >
      {!d ? (
        <Typography.Text type="secondary">{loading ? '正在与上一版本对比…' : '暂时无法对比'}</Typography.Text>
      ) : !d.base ? (
        <Typography.Text type="secondary">{d.summary || '首个版本，没有可对比的上一版本'}</Typography.Text>
      ) : !items.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="与上一版本相比没有内容变化" />
      ) : (
        <>
          {miss.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 8 }}
              message={`以下 ${miss.length} 处变化未在“变更原因”中说明：${[...new Set(miss.map((i) => `${i.title}${i.label && i.kind === 'changed' ? `（${i.label}）` : i.kind === 'added' ? '（新增）' : i.kind === 'removed' ? '（删除）' : ''}`))].slice(0, 6).join('；')}${miss.length > 6 ? '…' : ''}`}
            />
          )}
          <Table<DiffItem>
            rowKey={(r, i) => `${r.key}-${r.field ?? r.kind}-${i}`}
            size="small"
            columns={columns}
            dataSource={items}
            pagination={items.length > 12 ? { pageSize: 12, size: 'small' } : false}
            tableLayout="fixed"
          />
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ 未保存提示
/**
 * 有未保存修改时：关闭/刷新浏览器弹出浏览器提示；站内跳转（菜单、返回列表等）先确认。
 * 返回 bypass()：确定要离开时（如删除草稿后）先调用，再跳转。
 */
export function useUnsavedGuard(when: boolean, text = '有未保存的修改，离开后将丢失。') {
  const { modal } = App.useApp();
  const { navigator } = useContext(UNSAFE_NavigationContext) as unknown as { navigator: Rec };
  const skip = useRef(false);

  useEffect(() => {
    if (!when) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (skip.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    const push = navigator.push;
    const replace = navigator.replace;
    const guard = (fn: (...a: unknown[]) => void) => (...args: unknown[]) => {
      if (skip.current) return fn.apply(navigator, args);
      modal.confirm({
        title: '离开此页？',
        content: `${text}如需保留，请先点【保存草稿】。`,
        okText: '放弃修改并离开',
        okButtonProps: { danger: true },
        cancelText: '留下继续编辑',
        onOk: () => fn.apply(navigator, args),
      });
    };
    navigator.push = guard(push);
    navigator.replace = guard(replace);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      navigator.push = push;
      navigator.replace = replace;
    };
  }, [when, navigator, text, modal]);

  return () => {
    skip.current = true;
  };
}
