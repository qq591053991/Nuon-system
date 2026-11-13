/**
 * RFID 收货台：选择/扫描采购单 → 贴好空白标签的包装（料盘/箱/托盘）放上桌面读写器 → 读到的新标签绑定到订单行（每张标签 = 一包，填每包数量）
 * → 确认：生成入库单（需检验物料为待检并自动生成 IQC），同时给每张标签发卡（绑定物料、批号、数量、货主、库位）。
 * 库位规则照常：自有/客供与仓库不符直接拒绝；湿敏物料放非防潮柜须确认。
 */
import { Alert, Button, Card, Col, DatePicker, Form, Input, InputNumber, Result, Row, Space, Table, Tag, Typography, message } from 'antd';
import { CheckOutlined, PrinterOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { post, type Rec } from '../../../api/http';
import PageHeader from '../../../components/PageHeader';
import RemoteSelect, { LocationSelect } from '../../../components/RemoteSelect';
import { fmtQty, toDate } from '../../../utils/format';
import { Blockers, ItemsTable, OpenSessions, ReaderPicker, RfidLinks, SessionBar, postConfirmable, useSession, useSessionParam } from './kit';

const FALLBACK = { to: '/wms/pda/receive', text: '条码收货（兜底）' };

function Start({ onStarted }: { onStarted: (id: number) => void }) {
  const [sp] = useSearchParams();
  const [reader, setReader] = useState<number | null>(null);
  const [po, setPo] = useState<number | null>(Number(sp.get('po_id')) || null);
  const [busy, setBusy] = useState(false);
  const start = async (poId = po) => {
    if (!reader || !poId) return message.warning('请选择读写器和采购订单');
    setBusy(true);
    try {
      const d = await post('/rfid/sessions', { session_type: 'RECEIVE', reader_id: reader, po_id: poId });
      onStarted(d.session.id);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Card title="开始收货" style={{ maxWidth: 820 }}>
        <Form layout="vertical">
          <Form.Item label="收货台读写器" required><ReaderPicker purposes={['RECEIVE']} value={reader} onChange={(id) => setReader(id)} /></Form.Item>
          <Form.Item label="采购订单（选择，或扫送货单上的采购单号后回车）" required>
            <RemoteSelect url="/purchase-orders" params={{ status: 'APPROVED,PARTIAL_RECEIVED' }} noun="采购订单" matchKeys={['no']} style={{ width: 460 }}
              labelOf={(r) => `${r.no} ${r.supplier_name ?? ''}`} value={po ?? undefined}
              onChange={(v) => setPo(v as number)} onPick={(r) => { if (r && reader) start(r.id); }} />
          </Form.Item>
          <Button type="primary" size="large" loading={busy} onClick={() => start()}>开始收货</Button>
        </Form>
        <Alert type="info" showIcon style={{ marginTop: 16 }} message="每个料盘/箱/托盘贴一张空白 RFID 标签（一个标签 = 一个批次的一个包装）。湿敏 LED 料盘装在金属化防潮袋里，标签要贴在外箱或用抗金属标签，否则读不到。" />
      </Card>
      <OpenSessions type="RECEIVE" onPick={onStarted} />
    </>
  );
}

function BindPanel({ d, onChange }: { d: Rec; onChange: (nd: Rec) => void }) {
  const lines: Rec[] = d.check.lines ?? [];
  const [lineId, setLineId] = useState<number | null>(null);
  const [form] = Form.useForm();
  const line = lines.find((l) => l.po_line_id === lineId) ?? null;
  useEffect(() => {
    if (!lineId && lines.length) setLineId((lines.find((l) => l.remaining > l.bound_qty) ?? lines[0]).po_line_id);
  }, [lines, lineId]);
  useEffect(() => {
    if (!line) return;
    form.setFieldsValue({ location_id: line.suggest_location?.id, qty: undefined, lot_no: undefined, supplier_lot: undefined, mfg_date: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineId]);
  const unbound = (d.items as Rec[]).filter((i) => !i.action && !i.known && !i.sn && !i.po_line_id);
  const bind = async () => {
    const v = await form.validateFields();
    const r = await post(`/rfid/sessions/${d.session.id}/bind`, { po_line_id: lineId, qty: v.qty, lot_no: v.lot_no, supplier_lot: v.supplier_lot, mfg_date: toDate(v.mfg_date), location_id: v.location_id });
    onChange(r);
    message.success(`已绑定 ${r.bound} 张标签到第 ${line?.line_no} 行`);
    if (r.warnings?.length) message.warning(r.warnings.join('；'), 6);
  };
  const per = line ? Math.max(0, line.remaining - line.bound_qty) : 0;
  return (
    <Card size="small" title="到货明细（选中一行，把读到的新标签绑定到这一行）">
      <Table size="small" rowKey="po_line_id" dataSource={lines} pagination={false} scroll={{ x: 'max-content' }}
        rowSelection={{ type: 'radio', selectedRowKeys: lineId ? [lineId] : [], onChange: (k) => setLineId(Number(k[0])) }}
        onRow={(r) => ({ onClick: () => setLineId(r.po_line_id) })}
        columns={[
          { title: '行', dataIndex: 'line_no', width: 40 },
          { title: '物料', dataIndex: 'material_code', render: (v: string, r: Rec) => <div><b>{v}</b>{r.msl_level && r.msl_level !== '1' && <Tag color="orange" style={{ marginLeft: 4 }}>MSL {r.msl_level}</Tag>}<div style={{ fontSize: 12, color: '#8c8c8c' }}>{r.material_name}</div></div> },
          { title: '剩余待收', dataIndex: 'remaining', align: 'right', render: (v: number, r: Rec) => `${fmtQty(v)} ${r.uom}` },
          { title: '已绑定', key: 'b', align: 'right', render: (_: any, r: Rec) => <span style={{ color: r.over ? '#cf1322' : undefined }}>{r.bound_tags} 包 / {fmtQty(r.bound_qty)}</span> },
          { title: '建议库位', key: 's', render: (_: any, r: Rec) => r.suggest_location?.code ?? '-' },
        ]} />
      {line && (
        <Form form={form} layout="inline" style={{ marginTop: 12, rowGap: 8 }}>
          <Form.Item name="qty" label="每包数量" rules={[{ required: true, message: '填写每包数量' }]}>
            <InputNumber min={0.0001} style={{ width: 120 }} placeholder={per ? String(per) : ''} suffix={line.uom} />
          </Form.Item>
          <Form.Item name="location_id" label="库位" rules={[{ required: true, message: '选择库位' }]}><LocationSelect style={{ width: 220 }} /></Form.Item>
          <Form.Item name="lot_no" label="批号"><Input style={{ width: 150 }} placeholder="空 = 系统生成" /></Form.Item>
          <Form.Item name="supplier_lot" label="原厂批号"><Input style={{ width: 130 }} /></Form.Item>
          <Form.Item name="mfg_date" label="生产日期"><DatePicker style={{ width: 130 }} /></Form.Item>
          <Form.Item>
            <Button type="primary" disabled={!unbound.length} onClick={bind}>绑定 {unbound.length} 张未绑定新标签到第 {line.line_no} 行</Button>
          </Form.Item>
        </Form>
      )}
      <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0', fontSize: 12 }}>
        一包贴一张标签；同一行分几批放上读写器就分几次绑定（每次可改每包数量、批号）。绑错了在右侧该标签上点“误读”后重新读，或重新绑定会覆盖。
      </Typography.Paragraph>
    </Card>
  );
}

export default function RfidReceive() {
  const nav = useNavigate();
  const [sid, setSid] = useSessionParam();
  const { d, setD } = useSession(sid);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (!d) return;
    setBusy(true);
    try {
      const r = await postConfirmable(`/rfid/sessions/${d.session.id}/confirm`, { delivery_note: note || undefined }, 'confirm_placement', '湿敏物料放非防潮柜，确认放入？');
      if (r) {
        setD(r);
        message.success(`已生成入库单 ${r.result.receipt_no}，发卡 ${r.result.tags} 张`);
      }
    } catch (e) {
      /* 已提示 */
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <PageHeader title="RFID 收货台" sub="贴标的包装放上读写器即读到；绑定到订单行后确认，生成入库单并发卡" extra={<RfidLinks fallback={FALLBACK} />} />
      {!sid ? <Start onStarted={setSid} /> : !d ? <Card loading /> : (
        <>
          <SessionBar d={d} onChange={setD} onClosed={() => setSid(null)} fallbackLink={FALLBACK} />
          {d.session.status === 'CONFIRMED' && (
            <Result status="success" title={`收货完成：入库单 ${d.session.ref_no}`}
              subTitle={`已给 ${(d.items as Rec[]).filter((i) => i.action === 'DONE').length} 张标签发卡（EPC 已绑定物料、批号、数量、库位）。需检验的物料为“待检”，已通知 IQC。`}
              extra={[
                <Button key="p" icon={<PrinterOutlined />} onClick={() => window.open(`/wms/print/labels?receipt=${d.session.ref_id}`, '_blank')}>打印批次标签（含 EPC）</Button>,
                <Button key="r" onClick={() => window.open(`/wms/print/receipt/${d.session.ref_id}`, '_blank')}>打印入库单</Button>,
                <Button key="n" type="primary" onClick={() => setSid(null)}>收下一单</Button>,
              ]} />
          )}
          {d.session.status === 'CANCELLED' && <Result status="info" title="作业已取消" extra={<Button type="primary" onClick={() => setSid(null)}>重新开始</Button>} />}
          {d.check.po && d.session.status === 'OPEN' && (
            <Alert type="info" showIcon style={{ marginBottom: 12 }} message={<span>采购单 <a onClick={() => nav(`/purchase/orders/${d.check.po.id}`)}>{d.check.po.no}</a> · {d.check.po.supplier_name} · 新标签 {d.check.new_tags} 张（已绑定 {d.check.bound}，未绑定 {d.check.unbound}）</span>} />
          )}
          <Row gutter={12}>
            {d.session.status === 'OPEN' && <Col xs={24} xxl={11} style={{ marginBottom: 12 }}><BindPanel d={d} onChange={setD} /></Col>}
            <Col xs={24} xxl={d.session.status === 'OPEN' ? 13 : 24}>
              <Card size="small" title="读到的标签">
                <ItemsTable d={d} onChange={setD} extraCols={[{ title: '绑定', key: 'bind', render: (_: any, r: Rec) => (r.po_line_id ? <span>{fmtQty(r.bind_qty)} → {r.bind_location_code}</span> : '-') }]} />
              </Card>
            </Col>
          </Row>
          {d.session.status === 'OPEN' && (
            <Card size="small" style={{ marginTop: 12 }}>
              <Blockers d={d} />
              <Space wrap>
                <span>送货单号</span><Input style={{ width: 200 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="可选" />
                <Button type="primary" size="large" icon={<CheckOutlined />} disabled={!d.can_confirm} loading={busy} onClick={confirm}>确认收货（生成入库单并发卡）</Button>
              </Space>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
