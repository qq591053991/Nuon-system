/**
 * RFID 发货核对（发货口）：选待过账发货单 → 整托/整车推过发货口读写器 → 按发货单逐台核对：
 * 应发 N 台、读到 M 台、多出 / 缺少 / 未放行 / 不属于本单逐条列出，全部一致才能确认发货（过账、序列号出库、生成应收）。
 */
import { Alert, Button, Card, Col, Form, Result, Row, Space, Statistic, Table, Tag, message } from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { post, type Rec } from '../../../api/http';
import PageHeader from '../../../components/PageHeader';
import RemoteSelect from '../../../components/RemoteSelect';
import { fmtQty } from '../../../utils/format';
import { Blockers, ItemsTable, OpenSessions, ReaderPicker, RfidLinks, SessionBar, errText, useSession, useSessionParam } from './kit';

const FALLBACK = { to: '/wms/shipments?status=DRAFT', text: '条码发货（兜底）' };

function Start({ onStarted }: { onStarted: (id: number) => void }) {
  const nav = useNavigate();
  const [reader, setReader] = useState<number | null>(null);
  const [sh, setSh] = useState<number | null>(null);
  const start = async (id = sh) => {
    if (!reader || !id) return message.warning('请选择读写器和发货单');
    const d = await post('/rfid/sessions', { session_type: 'SHIP', reader_id: reader, shipment_id: id });
    onStarted(d.session.id);
  };
  return (
    <>
      <Card title="开始发货核对" style={{ maxWidth: 820 }}>
        <Form layout="vertical">
          <Form.Item label="发货口读写器" required><ReaderPicker purposes={['SHIP']} value={reader} onChange={(id) => setReader(id)} /></Form.Item>
          <Form.Item label="待过账发货单（选择，或扫发货单号后回车）" required>
            <RemoteSelect url="/shipments" params={{ status: 'DRAFT' }} noun="发货单" matchKeys={['no']} style={{ width: 460 }}
              labelOf={(r) => `${r.no} · ${r.customer_name ?? ''} · 订单 ${r.so_no ?? ''}`} value={sh ?? undefined}
              onChange={(v) => setSh(v as number)} onPick={(r) => { if (r && reader) start(r.id); }} />
          </Form.Item>
          <Space>
            <Button type="primary" size="large" onClick={() => start()}>开始核对</Button>
            <Button onClick={() => nav('/wms/shipments?new=1')}>新建发货单</Button>
          </Space>
        </Form>
      </Card>
      <OpenSessions type="SHIP" onPick={onStarted} />
    </>
  );
}

const List = ({ title, items, color }: { title: string; items: string[]; color: string }) =>
  items.length ? <div style={{ marginBottom: 6 }}><b style={{ marginRight: 8 }}>{title}（{items.length}）</b>{items.map((x) => <Tag key={x} color={color} className="mono">{x}</Tag>)}</div> : null;

export default function RfidShip() {
  const nav = useNavigate();
  const [sid, setSid] = useSessionParam();
  const { d, setD } = useSession(sid);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (!d) return;
    setBusy(true);
    try {
      const r = await post(`/rfid/sessions/${d.session.id}/confirm`, {}, true);
      setD(r);
      message.success(`发货单 ${r.result.shipment_no} 已发货过账`);
    } catch (e) {
      message.error(errText(e), 6);
    } finally {
      setBusy(false);
    }
  };
  const c = d?.check;
  const extra = c ? c.extra.length + c.not_mine.length : 0;
  return (
    <div>
      <PageHeader title="RFID 发货核对" sub="发货口读到的成品与发货单逐台核对，全部一致才能发货" extra={<RfidLinks fallback={FALLBACK} />} />
      {!sid ? <Start onStarted={setSid} /> : !d ? <Card loading /> : (
        <>
          <SessionBar d={d} onChange={setD} onClosed={() => setSid(null)} fallbackLink={FALLBACK} />
          {d.session.status === 'CONFIRMED' && (
            <Result status="success" title={`发货单 ${d.session.ref_no} 已发货`} extra={[
              <Button key="p" onClick={() => window.open(`/wms/print/shipment/${d.session.ref_id}`, '_blank')}>打印发货单/装箱单</Button>,
              <Button key="s" onClick={() => nav('/wms/shipments')}>发货列表（补运单号）</Button>,
              <Button key="n" type="primary" onClick={() => setSid(null)}>核对下一单</Button>,
            ]} />
          )}
          {d.session.status === 'OPEN' && (<>
          <Alert type={c.all_match ? 'success' : 'warning'} showIcon style={{ marginBottom: 12 }}
            message={<span>发货单 <b>{c.shipment.no}</b> · {c.shipment.customer_name} · 订单 {c.shipment.so_no}：{c.all_match ? '读到的与发货单完全一致，可以发货' : '与发货单不一致，见下方'}</span>} />
          <Row gutter={12} style={{ marginBottom: 12 }}>
            {[
              ['应发', c.expected, undefined], ['读到（应发的）', c.read, '#389e0d'], ['缺少', c.missing.length, c.missing.length ? '#cf1322' : undefined],
              ['多出', c.extra.length, c.extra.length ? '#cf1322' : undefined], ['未放行', c.not_released.length, c.not_released.length ? '#cf1322' : undefined],
              ['不属于本单', c.not_mine.length, c.not_mine.length ? '#cf1322' : undefined],
            ].map(([t, v, col]) => (
              <Col key={t as string} xs={8} xl={4}><Card size="small"><Statistic title={t as string} value={v as number} suffix="台" valueStyle={{ color: col as string | undefined }} /></Card></Col>
            ))}
          </Row>
          {(c.missing.length > 0 || extra > 0 || c.not_released.length > 0) && (
            <Card size="small" style={{ marginBottom: 12 }}>
              <List title="缺少（没读到，找到实物或检查标签）" items={c.missing} color="red" />
              <List title="多出（同型号已放行但不在本单，拿开）" items={c.extra} color="orange" />
              <List title="未放行（禁止发货，隔离）" items={c.not_released} color="red" />
              <List title="不属于本单" items={c.not_mine} color="orange" />
            </Card>
          )}
          {!!c.lot_lines?.length && (
            <Table size="small" rowKey={(r: Rec) => `${r.material_code}|${r.lot_no}`} style={{ marginBottom: 12 }} dataSource={c.lot_lines} pagination={false} columns={[
              { title: '非序列号产品', dataIndex: 'material_code' }, { title: '批次', dataIndex: 'lot_no' },
              { title: '应发', dataIndex: 'need', render: (v: number) => fmtQty(v) }, { title: '读到', dataIndex: 'read', render: (v: number) => fmtQty(v) },
              { title: '', dataIndex: 'ok', render: (v: boolean) => (v ? <Tag color="green">一致</Tag> : <Tag color="red">不一致</Tag>) },
            ]} />
          )}
          </>)}
          <Card size="small" title="读到的标签"><ItemsTable d={d} onChange={setD} /></Card>
          {d.session.status === 'OPEN' && (
            <Card size="small" style={{ marginTop: 12 }}>
              <Blockers d={d} />
              <Button type="primary" size="large" icon={<CheckOutlined />} loading={busy} disabled={!d.can_confirm || !c.all_match} onClick={confirm}>确认发货（{c.expected} 台）</Button>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
