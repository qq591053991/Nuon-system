/**
 * RFID 作业台共用：选项、会话轮询、读写器选择、作业栏（读写器状态 / 条码手输兜底 / 模拟读取 / 误读 / 取消）、标签结果表、模拟读取弹窗。
 * 面向电脑/仓库大屏（1366×768 及以上）：读写器自动读取，页面每 1.5 秒刷新读取结果，仓管只需核对并点确认。
 */
import { Alert, Badge, Button, Card, Checkbox, Empty, InputNumber, Modal, Popconfirm, Radio, Select, Space, Spin, Table, Tag, Tooltip, Typography, message } from 'antd';
import { ExperimentOutlined, ReloadOutlined, StopOutlined, WifiOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { get, post, type Rec } from '../../../api/http';
import ScanInput from '../../../components/ScanInput';
import { fmtDateTime, fmtQty } from '../../../utils/format';

export interface RfidOptions { simulate: boolean; rssi_min: number; gate_window_seconds: number; online_seconds: number }

let optCache: RfidOptions | null = null;
/** 系统 RFID 选项（模拟读取是否开放、RSSI 阈值等） */
export function useRfidOptions(): RfidOptions | null {
  const [o, setO] = useState<RfidOptions | null>(optCache);
  useEffect(() => {
    if (optCache) return;
    get('/rfid/options', undefined, true).then((x) => { optCache = x; setO(x); }).catch(() => undefined);
  }, []);
  return o;
}

/** 作业类型 → 作业台页面 */
export const SESSION_PATH: Record<string, string> = {
  RECEIVE: '/wms/rfid/receive', GATE: '/wms/rfid/gate', ISSUE: '/wms/rfid/issue', FG_RECEIPT: '/wms/rfid/fg', SHIP: '/wms/rfid/ship', COUNT: '/wms/rfid/count', RETURN: '/wms/rfid/return',
};
export const sessionUrl = (s: Rec) => (s.session_type === 'GATE' ? SESSION_PATH.GATE : `${SESSION_PATH[s.session_type]}?session=${s.id}`);

/** 会话详情轮询：进行中每 interval 毫秒刷新一次（页面不可见时暂停） */
export function useSession(id: number | null, interval = 1500) {
  const [d, setD] = useState<Rec | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const busy = useRef(false);
  const reload = useCallback(async () => {
    if (!id || busy.current) return;
    busy.current = true;
    try {
      setD(await get(`/rfid/sessions/${id}`, undefined, true));
      setErr(null);
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? '读取作业失败');
    } finally {
      busy.current = false;
    }
  }, [id]);
  useEffect(() => {
    setD(null);
    if (id) reload();
  }, [id, reload]);
  const open = d?.session?.status === 'OPEN';
  useEffect(() => {
    if (!id || !open) return;
    const h = setInterval(() => { if (!document.hidden) reload(); }, interval);
    return () => clearInterval(h);
  }, [id, open, interval, reload]);
  return { d, setD, reload, err };
}

/** URL 中的 ?session=ID（开始/继续作业时写入，刷新页面不丢） */
export function useSessionParam(): [number | null, (id: number | null) => void] {
  const [sp, setSp] = useSearchParams();
  const id = Number(sp.get('session')) || null;
  const set = useCallback((v: number | null) => {
    const n = new URLSearchParams(sp);
    if (v) n.set('session', String(v));
    else n.delete('session');
    setSp(n, { replace: false });
  }, [sp, setSp]);
  return [id, set];
}

/** 错误提示文本（后端 detail） */
export const errText = (e: any): string => e?.response?.data?.detail || e?.message || '操作失败';

/** POST（自行处理“【需确认】”类提示：弹确认框后带 confirm 字段重试） */
export async function postConfirmable(url: string, body: Rec, confirmKey: string, title = '请确认放置位置'): Promise<Rec | null> {
  try {
    return await post(url, body, true);
  } catch (e: any) {
    const detail: string = e?.response?.data?.detail ?? '';
    if (detail.includes('【需确认】')) {
      const ok = await new Promise<boolean>((resolve) =>
        Modal.confirm({ title, content: detail.replace('【需确认】', ''), okText: '确认放入', cancelText: '返回修改', onOk: () => resolve(true), onCancel: () => resolve(false) }),
      );
      if (!ok) return null;
      return post(url, { ...body, [confirmKey]: true });
    }
    message.error(detail || '操作失败');
    throw e;
  }
}

// ---------------- 读写器 ----------------

/** 读写器在线状态小标签 */
export function OnlineBadge({ r }: { r?: Rec | null }) {
  if (!r) return null;
  if (!r.is_active) return <Badge status="default" text="已停用" />;
  return r.online
    ? <Badge status="success" text="在线" />
    : <Tooltip title={r.last_heartbeat_at ? `最后心跳 ${fmtDateTime(r.last_heartbeat_at)}` : '从未连接'}><span><Badge status="error" text="离线" /></span></Tooltip>;
}

/** 读写器选择（按用途筛选，默认选第一台符合用途的在用读写器） */
export function ReaderPicker({ purposes, value, onChange, style }: { purposes: string[]; value?: number | null; onChange: (id: number, r: Rec) => void; style?: React.CSSProperties }) {
  const [rows, setRows] = useState<Rec[]>([]);
  useEffect(() => {
    get('/rfid/readers', undefined, true).then((rs: Rec[]) => {
      const list = rs.filter((r) => r.is_active && r.purpose !== 'GATE');
      list.sort((a, b) => Number(!purposes.includes(a.purpose)) - Number(!purposes.includes(b.purpose)) || String(a.code).localeCompare(String(b.code)));
      setRows(list);
      if (!value && list.length) onChange(list[0].id, list[0]);
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Select
      style={{ minWidth: 260, ...style }}
      value={value ?? undefined}
      placeholder="选择读写器"
      onChange={(v) => onChange(v, rows.find((r) => r.id === v)!)}
      options={rows.map((r) => ({
        value: r.id,
        label: <Space size={6}><span>{r.name}</span><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.code} · {r.reader_type_text}</Typography.Text><OnlineBadge r={r} /></Space>,
      }))}
    />
  );
}

// ---------------- 结果表 ----------------

export const LEVEL: Record<string, [string, string]> = {
  ok: ['相符', 'green'], warn: ['需处理', 'orange'], error: ['不符', 'red'], info: ['提示', 'blue'], done: ['已处理', 'default'], ignored: ['误读', 'default'],
};
export const LevelTag = ({ level }: { level: string }) => <Tag color={LEVEL[level]?.[1]}>{LEVEL[level]?.[0] ?? level}</Tag>;
const ROW_BG: Record<string, string> = { error: '#fff1f0', warn: '#fffbe6', ok: '#f6ffed' };

/** 标签简述：单台 = 序列号；包装 = 物料 · 批次 · 数量 */
export function TagWhat({ r }: { r: Rec }) {
  if (!r.known && !r.sn) return r.po_line_id ? <b>新标签（待发卡）</b> : <Typography.Text type="secondary">未登记</Typography.Text>;
  if (r.tag_type === 'UNIT' || r.sn) {
    return <span><b className="mono">{r.sn}</b> <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.material_code} · {r.sn_status_text ?? ''}</Typography.Text></span>;
  }
  return (
    <span>
      <b>{r.material_code}</b> <span className="mono">{r.lot_no || '-'}</span>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}> · {fmtQty(r.qty)} {r.uom ?? ''}</Typography.Text>
    </span>
  );
}

const SRC: Record<string, string> = { READER: '读写器', MANUAL: '条码/手输', SIMULATED: '模拟' };

/** 读到的标签（每个 EPC 一行，去重后）：状态、标签内容、库位、核对结果、读取次数/信号、来源；可标记误读/恢复 */
export function ItemsTable({ d, onChange, extraCols = [], rowSelection, filter }: {
  d: Rec; onChange: (nd: Rec) => void; extraCols?: any[]; rowSelection?: any; filter?: (r: Rec) => boolean;
}) {
  const open = d.session.status === 'OPEN';
  const sid = d.session.id;
  const act = async (url: string, epc: string) => onChange(await post(`/rfid/sessions/${sid}/${url}`, { epcs: [epc] }));
  const rows: Rec[] = (d.items as Rec[]).filter(filter ?? (() => true));
  return (
    <Table
      size="small"
      rowKey="epc"
      dataSource={rows}
      pagination={rows.length > 50 ? { pageSize: 50, size: 'small' } : false}
      scroll={{ x: 'max-content' }}
      rowSelection={rowSelection}
      onRow={(r) => ({ style: { background: r.action ? undefined : ROW_BG[r.level] } })}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有读到标签" /> }}
      columns={[
        { title: '结果', dataIndex: 'level', width: 72, render: (v: string) => <LevelTag level={v} /> },
        { title: '标签内容', key: 'what', render: (_: any, r: Rec) => <TagWhat r={r} /> },
        ...extraCols,
        { title: '核对说明', dataIndex: 'message', render: (v: string) => <span style={{ whiteSpace: 'normal' }}>{v}</span> },
        { title: '账面库位', dataIndex: 'location_code', width: 90, render: (v: string) => v || '-' },
        {
          title: 'EPC / 读取', key: 'epc', width: 210,
          render: (_: any, r: Rec) => (
            <div style={{ lineHeight: 1.3 }}>
              <div className="mono" style={{ fontSize: 12 }}>{r.epc}</div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {SRC[r.source] ?? r.source} · {r.read_count} 次{r.max_rssi !== null && r.max_rssi !== undefined ? ` · ${r.max_rssi} dBm` : ''}{r.antennas ? ` · 天线 ${r.antennas}` : ''}
              </Typography.Text>
            </div>
          ),
        },
        ...(open ? [{
          title: '', key: '_op', width: 84,
          render: (_: any, r: Rec) => r.action === 'IGNORED'
            ? <Button size="small" onClick={() => act('restore', r.epc)}>恢复</Button>
            : !r.action ? <Button size="small" onClick={() => act('ignore', r.epc)}>误读</Button> : null,
        }] : []),
      ]}
    />
  );
}

// ---------------- 作业栏 ----------------

/** 不能确认的原因 */
export function Blockers({ d }: { d: Rec }) {
  if (d.session.status !== 'OPEN' || !d.blockers?.length) return null;
  return <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="还不能确认" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{d.blockers.map((b: string) => <li key={b}>{b}</li>)}</ul>} />;
}

/**
 * 作业栏：单号、类型、读写器与在线状态、统计；条码/手输兜底输入；模拟读取（仅演示/测试）；异常标签一键标记误读；取消作业。
 */
export function SessionBar({ d, onChange, onClosed, fallbackLink, children }: {
  d: Rec; onChange: (nd: Rec) => void; onClosed?: () => void; fallbackLink?: { to: string; text: string }; children?: ReactNode;
}) {
  const opts = useRfidOptions();
  const [simOpen, setSimOpen] = useState(false);
  const s = d.session;
  const open = s.status === 'OPEN';
  // 收货台读到的未登记标签是待发卡的新标签，不算异常
  const errors = (d.items as Rec[]).filter((i) => !i.action && (i.level === 'error' || (s.session_type !== 'RECEIVE' && !i.known && !i.sn))).length;
  const manual = async (code: string) => {
    try {
      const r = await post(`/rfid/sessions/${s.id}/manual`, { code }, true);
      onChange(r);
      message.success(`已记入：${r.manual?.epc ?? code}`);
    } catch (e) {
      message.error(errText(e));
    }
  };
  return (
    <Card size="small" style={{ marginBottom: 12 }} styles={{ body: { padding: '10px 14px' } }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <Space size={8} wrap>
          <Tag color={open ? 'processing' : s.status === 'CONFIRMED' ? 'success' : 'default'}>{s.status_text}</Tag>
          <b>{s.type_text} {s.no}</b>
          {s.context_no && <Typography.Text type="secondary">· {s.context_no}</Typography.Text>}
        </Space>
        <Space size={6}><WifiOutlined style={{ color: '#5b3cc4' }} />{d.reader?.name ?? s.reader_name}<OnlineBadge r={d.reader} /></Space>
        <Space size={12} style={{ color: '#595959' }}>
          <span>标签 <b>{d.summary.tags}</b></span>
          <span>待处理 <b>{d.summary.pending}</b></span>
          <span>读取 <b>{d.summary.reads}</b> 次</span>
          {!!d.summary.unknown && <span style={{ color: '#d46b08' }}>{s.session_type === 'RECEIVE' ? '新标签' : '未登记'} <b>{d.summary.unknown}</b></span>}
          {!!d.summary.ignored && <span>误读 <b>{d.summary.ignored}</b></span>}
        </Space>
        <div style={{ flex: 1 }} />
        {open && opts?.simulate && <Button icon={<ExperimentOutlined />} onClick={() => setSimOpen(true)}>模拟读取</Button>}
        {open && errors > 0 && (
          <Button onClick={async () => onChange(await post(`/rfid/sessions/${s.id}/ignore`, { all_errors: true }))}>异常标签全部标记为误读（{errors}）</Button>
        )}
        {open && (
          <Popconfirm title="取消这次作业？" description="不影响库存；已读到的原始记录保留。" okText="取消作业" cancelText="返回"
            onConfirm={async () => { onChange(await post(`/rfid/sessions/${s.id}/cancel`, {})); onClosed?.(); }}>
            <Button icon={<StopOutlined />}>取消作业</Button>
          </Popconfirm>
        )}
      </div>
      {open && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <Typography.Text type="secondary" style={{ flex: 'none' }}>标签读不到？</Typography.Text>
          <div style={{ flex: '1 1 360px', maxWidth: 520 }}>
            <ScanInput size="middle" autoFocus={false} onScan={manual} placeholder="条码/手输兜底：扫序列号/UDI、批号，或输入标签上印的 EPC，回车" />
          </div>
          {fallbackLink && <Link to={fallbackLink.to}>{fallbackLink.text}</Link>}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>页面每 1.5 秒自动刷新读取结果</Typography.Text>
        </div>
      )}
      {children}
      {simOpen && <SimulateModal sessionId={s.id} readerId={s.reader_id} onClose={() => setSimOpen(false)} onDone={() => { setSimOpen(false); get(`/rfid/sessions/${s.id}`).then(onChange); }} />}
    </Card>
  );
}

// ---------------- 模拟读取 ----------------

const rndHex = (n: number) => Array.from({ length: n }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('');
/** 模拟空白标签 EPC（外购预编码标签常见 E280 开头） */
export const blankEpc = () => `E2806894${rndHex(16)}`;

/**
 * 模拟读取（仅演示/测试，没有读写器硬件时使用；正式环境 RFID_SIMULATE=0 关闭）：
 * 勾选要“读到”的标签，可附加空白新标签、未登记标签、弱信号读取；库门可选方向（天线先后）。
 */
export function SimulateModal({ sessionId, readerId, onClose, onDone }: { sessionId?: number | null; readerId: number; onClose: () => void; onDone: (r: Rec) => void }) {
  const [c, setC] = useState<Rec | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [blank, setBlank] = useState(0);
  const [unknown, setUnknown] = useState(false);
  const [weak, setWeak] = useState(true);
  const [dir, setDir] = useState<'OUT' | 'IN' | 'ONE'>('OUT');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get('/rfid/sim-candidates', { session_id: sessionId || undefined, reader_id: readerId }).then((x) => {
      setC(x);
      setSel((x.items as Rec[]).filter((i) => i.kind === 'expected').slice(0, x.gate ? 2 : 50).map((i) => i.epc));
      if (x.blank) setBlank(2);
    });
  }, [sessionId, readerId]);
  const submit = async () => {
    const g = c?.gate;
    const ants = (): (number | null)[] => {
      if (!g || g.mode !== 'ANTENNA') return [1];
      if (dir === 'ONE') return [g.inner_antenna];
      return dir === 'OUT' ? [g.inner_antenna, g.outer_antenna] : [g.outer_antenna, g.inner_antenna];
    };
    const reads: Rec[] = [];
    const t0 = Date.now();
    const add = (epc: string, rssi = -50 - Math.round(Math.random() * 12)) => ants().forEach((a, k) => reads.push({ epc, antenna: a, rssi, ts: new Date(t0 + k * 600 + reads.length * 10).toISOString() }));
    sel.forEach((e) => add(e));
    for (let i = 0; i < blank; i++) add(blankEpc());
    if (unknown) add(`E2003412${rndHex(16)}`);
    if (weak) reads.push({ epc: `E2806894${rndHex(16)}`, antenna: ants()[0], rssi: -85, ts: new Date(t0).toISOString() });
    if (!reads.length) return message.warning('请至少选择一张标签');
    setBusy(true);
    try {
      const r = await post('/rfid/simulate', { reader_id: readerId, session_id: sessionId || undefined, reads });
      message.success(`模拟读取：计入 ${r.accepted}，重复 ${r.duplicates}，弱信号过滤 ${r.low_rssi}${r.unknown?.length ? `，未登记 ${r.unknown.length}` : ''}`);
      onDone(r);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open title="模拟读取（仅演示 / 测试）" width={820} onCancel={onClose} onOk={submit} okText="读取" confirmLoading={busy} destroyOnHidden>
      <Alert type="warning" showIcon style={{ marginBottom: 10 }} message="没有读写器硬件时用于演示和测试：效果等同于读写器推送了这些读取。正式环境关闭（RFID_SIMULATE=0），此入口不显示。" />
      {!c ? <Spin /> : (
        <>
          {c.gate && (
            <div style={{ marginBottom: 10 }}>
              <span style={{ marginRight: 8 }}>过门方向：</span>
              <Radio.Group value={dir} onChange={(e) => setDir(e.target.value)} optionType="button" options={[
                { value: 'OUT', label: `出库（天线 ${c.gate.inner_antenna} → ${c.gate.outer_antenna}）` },
                { value: 'IN', label: `进库（天线 ${c.gate.outer_antenna} → ${c.gate.inner_antenna}）` },
                { value: 'ONE', label: '只被一侧读到（方向不明）' },
              ]} />
            </div>
          )}
          {!!c.items.length && (
            <Table size="small" rowKey="epc" dataSource={c.items} pagination={false} scroll={{ y: 300 }}
              rowSelection={{ selectedRowKeys: sel, onChange: (k) => setSel(k as string[]) }}
              columns={[
                { title: '', dataIndex: 'kind', width: 70, render: (v: string) => (v === 'expected' ? <Tag color="green">应读到</Tag> : <Tag>其他</Tag>) },
                { title: '标签', key: 'w', render: (_: any, r: Rec) => (r.sn ? <b className="mono">{r.sn}</b> : <span><b>{r.material_code}</b> {r.lot_no} · {fmtQty(r.qty)}</span>) },
                { title: '库位', dataIndex: 'location_code', width: 90 },
                { title: '说明', dataIndex: 'note', width: 160 },
                { title: 'EPC', dataIndex: 'epc', render: (v: string) => <span className="mono" style={{ fontSize: 12 }}>{v}</span> },
              ]} />
          )}
          <Space wrap style={{ marginTop: 10 }}>
            <span>空白新标签</span><InputNumber min={0} max={50} value={blank} onChange={(v) => setBlank(Number(v) || 0)} style={{ width: 70 }} />张
            <Checkbox checked={unknown} onChange={(e) => setUnknown(e.target.checked)}>加 1 张未登记标签</Checkbox>
            <Checkbox checked={weak} onChange={(e) => setWeak(e.target.checked)}>加 1 次弱信号读取（-85 dBm，应被过滤）</Checkbox>
          </Space>
        </>
      )}
    </Modal>
  );
}

// ---------------- 开始 / 继续作业 ----------------

/** 进行中的同类作业（可继续） */
export function OpenSessions({ type, onPick }: { type: string; onPick: (id: number) => void }) {
  const [rows, setRows] = useState<Rec[]>([]);
  useEffect(() => { get('/rfid/sessions', { status: 'OPEN', session_type: type }, true).then((p) => setRows(p.items)).catch(() => undefined); }, [type]);
  if (!rows.length) return null;
  return (
    <Card size="small" title="进行中的作业（点继续）" style={{ marginTop: 12 }}>
      <Table size="small" rowKey="id" dataSource={rows} pagination={false} columns={[
        { title: '作业', dataIndex: 'no', render: (v: string, r: Rec) => <a onClick={() => onPick(r.id)}>{v}</a> },
        { title: '单据', dataIndex: 'context_no' },
        { title: '读写器', dataIndex: 'reader_name' },
        { title: '标签', dataIndex: 'tag_count' },
        { title: '开始', dataIndex: 'created_at', render: (v: string, r: Rec) => `${r.created_by ?? ''} ${dayjs(v).format('MM-DD HH:mm')}` },
        { title: '', key: 'op', render: (_: any, r: Rec) => <Button size="small" type="primary" onClick={() => onPick(r.id)}>继续</Button> },
      ]} />
    </Card>
  );
}

/** 页面标题右侧的通用链接 */
export function RfidLinks({ fallback }: { fallback?: { to: string; text: string } }) {
  const nav = useNavigate();
  return (
    <>
      <Button onClick={() => nav('/wms/rfid')}>RFID 作业台</Button>
      {fallback && <Button onClick={() => nav(fallback.to)}>{fallback.text}</Button>}
    </>
  );
}

/** 刷新按钮 */
export const ReloadButton = ({ onClick }: { onClick: () => void }) => <Button icon={<ReloadOutlined />} onClick={onClick}>刷新</Button>;
