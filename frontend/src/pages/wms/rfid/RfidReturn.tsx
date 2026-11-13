/**
 * RFID 客户退货：退回的成品放上读写器 → 单台标签自动识别序列号、客户、原发货单 → 填退货原因 → 登记客户退货
 * （退货品冻结入库、序列号转“客户退回”、自动开具 NCR，规则同“客户退货”页）。
 */
import { Button, Card, Form, Input, Result, Space, Table, message } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { post, type Rec } from '../../../api/http';
import PageHeader from '../../../components/PageHeader';
import { LocationSelect } from '../../../components/RemoteSelect';
import { fmtDate } from '../../../utils/format';
import { ItemsTable, OpenSessions, ReaderPicker, RfidLinks, SessionBar, errText, useSession, useSessionParam } from './kit';
import { AutoSession, Detected, primaryOf } from './live';

const FALLBACK = { to: '/wms/customer-returns?new=1', text: '扫码登记退货（兜底）' };

function Start({ onStarted }: { onStarted: (id: number) => void }) {
  const [reader, setReader] = useState<number | null>(null);
  const start = async () => {
    if (!reader) return message.warning('请选择读写器');
    const d = await post('/rfid/sessions', { session_type: 'RETURN', reader_id: reader });
    onStarted(d.session.id);
  };
  return (
    <>
      <Card title="开始识别退货" style={{ maxWidth: 820 }}>
        <Form layout="vertical">
          <Form.Item label="读写器（一般用收货台）" required><ReaderPicker purposes={['RECEIVE']} value={reader} onChange={(id) => setReader(id)} /></Form.Item>
          <Button type="primary" size="large" onClick={start}>开始</Button>
        </Form>
      </Card>
      <OpenSessions type="RETURN" onPick={onStarted} />
    </>
  );
}

export default function RfidReturn() {
  const nav = useNavigate();
  const [sid, setSid] = useSessionParam();
  const { d, setD } = useSession(sid);
  const [reason, setReason] = useState('');
  const [loc, setLoc] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (!reason.trim()) return message.warning('请填写退货原因');
    setBusy(true);
    try {
      const r = await post(`/rfid/sessions/${d!.session.id}/confirm`, { reason, location_id: loc || undefined }, true);
      setD(r);
      message.success(`已登记客户退货 ${r.result.return_no}`);
    } catch (e) {
      message.error(errText(e), 6);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <PageHeader title="RFID 客户退货" sub="读单台标签识别序列号、客户与原发货单，登记退货（冻结入库并开 NCR）" extra={<RfidLinks fallback={FALLBACK} />} />
      {!sid ? <><Detected type="RETURN" onEnter={setSid} waitText="把客户退回的成品放上读写器，系统自动识别客户与原发货单" /><Start onStarted={setSid} /></> : !d ? <Card loading /> : d.session.session_type === 'AUTO' ? <AutoSession d={d} onChange={setD} /> : (
        <>
          <SessionBar d={d} onChange={setD} onClosed={() => setSid(null)} fallbackLink={FALLBACK} primary={{ text: primaryOf(d).text, disabled: !primaryOf(d).enabled, loading: busy, onClick: confirm }}>
            <Space wrap style={{ marginTop: 10 }}>
              <Input style={{ width: 320 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="退货原因（必填，如：客户反馈不亮）" />
              <LocationSelect style={{ width: 240 }} placeholder={`入库库位（默认 ${d.check.location_code ?? '不合格品区'}）`} allowClear value={loc ?? undefined} onChange={(v) => setLoc((v as number) ?? null)} />
            </Space>
          </SessionBar>
          {d.session.status === 'CONFIRMED' && (
            <Result status="success" title={`已登记客户退货 ${d.session.ref_no}`} subTitle="退货品已冻结，待 QA 评审 NCR 处置"
              extra={[<Button key="r" onClick={() => nav('/wms/customer-returns')}>查看退货单</Button>, <Button key="n" type="primary" onClick={() => setSid(null)}>继续</Button>]} />
          )}
          <Card size="small" title="识别到的退货产品" style={{ marginBottom: 12 }}>
            <Table size="small" rowKey="sn" dataSource={d.check.serials} pagination={false} locale={{ emptyText: '还没有识别到可退货的成品' }} columns={[
              { title: '序列号', dataIndex: 'sn', render: (v: string) => <b className="mono">{v}</b> },
              { title: '产品', dataIndex: 'material_code' }, { title: '批次', dataIndex: 'lot_no' },
              { title: '客户', dataIndex: 'customer_name' }, { title: '原发货单', dataIndex: 'shipment_no' },
              { title: '发货日期', dataIndex: 'ship_date', render: (v: string) => fmtDate(v) }, { title: '订单 / 客户PO', key: 'so', render: (_: any, r: Rec) => `${r.so_no ?? '-'} / ${r.customer_po ?? '-'}` },
            ]} />
          </Card>
          <Card size="small" title="读到的标签"><ItemsTable d={d} onChange={setD} /></Card>
        </>
      )}
    </div>
  );
}
