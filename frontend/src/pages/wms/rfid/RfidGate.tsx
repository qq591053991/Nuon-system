/**
 * RFID 库门待确认：门式读写器读到包装/单台标签过门，按天线先后判定进/出方向，生成“待确认的调拨/上架”。
 * 仓管在大屏上核对后勾选确认才移库（不自动过账，防止误读改库存）；方向不明的可手选方向，目标库位可改；误读一键忽略。
 */
import { Alert, Button, Card, Empty, Popconfirm, Select, Space, Table, Tag, Typography, message } from 'antd';
import { CheckOutlined, ExperimentOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { get, post, type Rec } from '../../../api/http';
import PageHeader from '../../../components/PageHeader';
import { LocationSelect } from '../../../components/RemoteSelect';
import ScanInput from '../../../components/ScanInput';
import { fmtDateTime, fmtQty } from '../../../utils/format';
import { LevelTag, OnlineBadge, RfidLinks, SimulateModal, TagWhat, errText, postConfirmable, useRfidOptions } from './kit';

const FALLBACK = { to: '/wms/pda/putaway', text: '条码调拨（兜底）' };

function GateSession({ d, onChanged }: { d: Rec; onChanged: () => void }) {
  const s = d.session;
  const [sel, setSel] = useState<string[]>([]);
  const [over, setOver] = useState<Record<string, { direction?: string; to_location_id?: number }>>({});
  const [busy, setBusy] = useState(false);
  const pending: Rec[] = (d.items as Rec[]).filter((i) => !i.action);
  const done: Rec[] = (d.items as Rec[]).filter((i) => i.action);
  const okKeys = pending.filter((i) => i.level === 'ok' || i.level === 'info').map((i) => i.epc);
  useEffect(() => {
    setSel((cur) => cur.filter((e) => pending.some((p) => p.epc === e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);
  const confirm = async (epcs: string[]) => {
    if (!epcs.length) return message.warning('请勾选要确认的标签');
    setBusy(true);
    try {
      const items = epcs.map((epc) => ({ epc, ...(over[epc] ?? {}) }));
      const r = await postConfirmable(`/rfid/sessions/${s.id}/confirm`, { items }, 'confirm_placement', '湿敏物料放非防潮柜，确认移入？');
      if (r) {
        message.success(`已确认移库 ${r.result.moved} 包${r.result.transfer_nos?.length ? `（调拨 ${r.result.transfer_nos.join('、')}）` : ''}`);
        setSel([]);
        onChanged();
      }
    } catch {
      /* 已提示 */
    } finally {
      setBusy(false);
    }
  };
  const ignore = async (epcs: string[]) => {
    if (!epcs.length) return message.warning('请勾选要忽略的标签');
    await post(`/rfid/sessions/${s.id}/ignore`, { epcs, note: '库门误读（仓管确认不是过门货物）' });
    setSel([]);
    onChanged();
  };
  const manual = async (code: string) => {
    try {
      await post(`/rfid/sessions/${s.id}/manual`, { code }, true);
      onChanged();
    } catch (e) {
      message.error(errText(e));
    }
  };
  return (
    <Card size="small" style={{ marginBottom: 12 }}
      title={<Space wrap><b>{s.no}</b><span>{d.reader?.name}</span><OnlineBadge r={d.reader} /><Typography.Text type="secondary">{fmtDateTime(s.created_at)} 起 · 最后读取 {s.last_read_at ? dayjs(s.last_read_at).format('HH:mm:ss') : '-'}</Typography.Text></Space>}
      extra={<Space>
        <Tag color="blue">出库 {d.check.out}</Tag><Tag color="cyan">进库 {d.check.in}</Tag>{!!d.check.unclear && <Tag color="orange">方向不明 {d.check.unclear}</Tag>}
      </Space>}>
      <Table size="small" rowKey="epc" dataSource={pending} pagination={false} scroll={{ x: 'max-content' }}
        rowSelection={{ selectedRowKeys: sel, onChange: (k) => setSel(k as string[]), getCheckboxProps: (r) => ({ disabled: !r.known || r.tag_status !== 'ACTIVE' }) }}
        onRow={(r) => ({ style: { background: r.level === 'error' ? '#fff1f0' : r.level === 'warn' ? '#fffbe6' : undefined } })}
        columns={[
          { title: '结果', dataIndex: 'level', width: 72, render: (v: string) => <LevelTag level={v} /> },
          { title: '标签内容', key: 'w', render: (_: any, r: Rec) => <TagWhat r={r} /> },
          {
            title: '方向', key: 'dir', width: 130,
            render: (_: any, r: Rec) => (r.direction
              ? <Tag color={r.direction === 'OUT' ? 'blue' : 'cyan'}>{r.direction_text}</Tag>
              : r.known ? <Select size="small" style={{ width: 110 }} placeholder="选择方向" value={over[r.epc]?.direction}
                  onChange={(v) => setOver({ ...over, [r.epc]: { ...over[r.epc], direction: v } })}
                  options={[{ value: 'OUT', label: '出库' }, { value: 'IN', label: '进库' }]} /> : '-'),
          },
          { title: '从', dataIndex: 'location_code', width: 80, render: (v: string) => v || '-' },
          {
            title: '到（可改）', key: 'to', width: 210,
            render: (_: any, r: Rec) => (r.known && r.tag_status === 'ACTIVE'
              ? <LocationSelect size="small" style={{ width: 190 }} placeholder={r.to_location_code ?? '按方向自动'} value={over[r.epc]?.to_location_id}
                  onChange={(v) => setOver({ ...over, [r.epc]: { ...over[r.epc], to_location_id: v as number } })} />
              : '-'),
          },
          { title: '数量', key: 'q', align: 'right', render: (_: any, r: Rec) => (r.move_qty !== undefined ? fmtQty(r.move_qty) : r.qty ? fmtQty(r.qty) : '-') },
          { title: '核对说明', dataIndex: 'message', render: (v: string) => <span style={{ whiteSpace: 'normal' }}>{v}</span> },
          { title: '读取', key: 'rd', render: (_: any, r: Rec) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>天线 {r.antennas ?? '-'} · {r.read_count} 次 · {r.max_rssi ?? '-'} dBm<div className="mono">{r.epc}</div></Typography.Text> },
        ]} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
        <Button type="primary" icon={<CheckOutlined />} loading={busy} disabled={!okKeys.length} onClick={() => confirm(okKeys)}>确认全部绿色/无需移库（{okKeys.length}）</Button>
        <Button loading={busy} disabled={!sel.length} onClick={() => confirm(sel)}>确认选中（{sel.length}）</Button>
        <Popconfirm title="把选中的标签标记为误读？" description="不移库；原始读取记录保留。" onConfirm={() => ignore(sel)} okText="标记误读" cancelText="返回">
          <Button disabled={!sel.length}>选中的标记为误读</Button>
        </Popconfirm>
        <Button onClick={() => ignore(pending.filter((i) => !i.known || i.tag_status !== 'ACTIVE' || i.level === 'error').map((i) => i.epc))}
          disabled={!pending.some((i) => !i.known || i.tag_status !== 'ACTIVE' || i.level === 'error')}>未登记/不能移库的全部忽略</Button>
        <div style={{ flex: 1 }} />
        <div style={{ width: 360 }}><ScanInput size="middle" autoFocus={false} onScan={manual} placeholder="兜底：补记一包（EPC / 批号 / 序列号）回车" /></div>
      </div>
      {!!done.length && (
        <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0', fontSize: 12 }}>
          已处理：{done.map((i) => `${i.material_code ?? i.epc}（${i.action === 'IGNORED' ? '误读' : i.action_note}）`).join('；')}
        </Typography.Paragraph>
      )}
    </Card>
  );
}

export default function RfidGate() {
  const opts = useRfidOptions();
  const [list, setList] = useState<Rec[] | null>(null);
  const [recent, setRecent] = useState<Rec[]>([]);
  const [gates, setGates] = useState<Rec[]>([]);
  const [sim, setSim] = useState<number | null>(null);
  const load = useCallback(async () => {
    const p = await get('/rfid/sessions', { status: 'OPEN', session_type: 'GATE' }, true).catch(() => null);
    if (!p) return;
    const ds = await Promise.all((p.items as Rec[]).map((s) => get(`/rfid/sessions/${s.id}`, undefined, true).catch(() => null)));
    setList(ds.filter(Boolean) as Rec[]);
    const r = await get('/rfid/sessions', { status: 'CONFIRMED,CANCELLED', session_type: 'GATE', page_size: 10 }, true).catch(() => null);
    if (r) setRecent(r.items);
  }, []);
  useEffect(() => {
    load();
    get('/rfid/readers', undefined, true).then((rs: Rec[]) => setGates(rs.filter((r) => r.purpose === 'GATE'))).catch(() => undefined);
    const h = setInterval(() => { if (!document.hidden) load(); }, 2000);
    return () => clearInterval(h);
  }, [load]);
  return (
    <div>
      <PageHeader title="RFID 库门待确认" sub="过门的货物按方向生成待确认调拨；仓管核对后确认才移库" extra={
        <>
          {opts?.simulate && gates.map((g) => <Button key={g.id} icon={<ExperimentOutlined />} onClick={() => setSim(g.id)}>模拟过门：{g.name}</Button>)}
          <RfidLinks fallback={FALLBACK} />
        </>
      } />
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="方向判定：先被库外侧天线、后被库内侧天线读到 = 进库；反之 = 出库；只被一侧读到或进出折返 = 方向不明（可能是门边静止货物），须人工选择方向或标记误读。信号弱于阈值的读取已自动过滤。" />
      {gates.length > 0 && (
        <Space style={{ marginBottom: 12 }} wrap>
          {gates.map((g) => <Card key={g.id} size="small"><Space><b>{g.name}</b><OnlineBadge r={g} /><Typography.Text type="secondary">库内 {g.location_code ?? '-'} ↔ 外侧 {g.outside_location_code ?? '-'} · 天线 {g.inner_antenna ?? '-'}=库内 / {g.outer_antenna ?? '-'}=库外</Typography.Text></Space></Card>)}
        </Space>
      )}
      {list === null ? <Card loading /> : !list.length ? <Card><Empty description="没有待确认的过门记录" /></Card> : list.map((d) => <GateSession key={d.session.id} d={d} onChanged={load} />)}
      {!!recent.length && (
        <Card size="small" title="最近处理的过门" style={{ marginTop: 12 }}>
          <Table size="small" rowKey="id" dataSource={recent} pagination={false} columns={[
            { title: '过门', dataIndex: 'no' },
            { title: '读写器', dataIndex: 'reader_name' },
            { title: '标签', dataIndex: 'tag_count' },
            { title: '结果', dataIndex: 'status_text', render: (v: string, r: Rec) => <Tag color={r.status === 'CONFIRMED' ? 'success' : 'default'}>{v}</Tag> },
            { title: '调拨单', dataIndex: 'ref_no', render: (v: string) => v || '-' },
            { title: '确认', dataIndex: 'confirmed_at', render: (v: string, r: Rec) => `${r.confirmed_by ?? ''} ${fmtDateTime(v)}` },
          ]} />
        </Card>
      )}
      {sim && <SimulateModal readerId={sim} onClose={() => setSim(null)} onDone={() => { setSim(null); load(); }} />}
    </div>
  );
}
