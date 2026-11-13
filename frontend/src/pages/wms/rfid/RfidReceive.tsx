/**
 * RFID 收货台：选一次采购单（或先放货、后选单）→ 每包放上读写器，新标签自动绑定到“还有未收数量”的订单行
 * （只剩一行直接绑；多行时第一包点一下物料，之后沿用；每包数量默认 = 采购换算率 / 最小包装量，批号沿用上一包）→ 点一次确认：生成入库单（需检验物料为待检并自动生成 IQC），同时给每张标签发卡（绑定物料、批号、数量、货主、库位）。
 * 库位规则照常：自有/客供与仓库不符直接拒绝；湿敏物料放非防潮柜须确认。
 */
import { Alert, Button, Card, Col, Collapse, DatePicker, Form, Input, InputNumber, Result, Row, Select, Space, Table, Tag, Typography, message } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { post, type Rec } from '../../../api/http';
import PageHeader from '../../../components/PageHeader';
import RemoteSelect, { LocationSelect } from '../../../components/RemoteSelect';
import { fmtQty, toDate } from '../../../utils/format';
import { ItemsTable, OpenSessions, ReaderPicker, RfidLinks, SessionBar, postConfirmable, useSession, useSessionParam } from './kit';
import { AutoSession, Detected, primaryOf } from './live';

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

/** 到货明细 + “修改默认值”（次要操作：新标签已按默认值自动绑定，需要时才改） */
function BindPanel({ d, onChange }: { d: Rec; onChange: (nd: Rec) => void }) {
  const lines: Rec[] = d.check.lines ?? [];
  const [form] = Form.useForm();
  const lineId = Form.useWatch('po_line_id', form);
  const line = lines.find((l) => l.po_line_id === lineId) ?? null;
  const items = (d.items as Rec[]).filter((i) => !i.action && !i.known && !i.sn);
  const bind = async () => {
    const v = await form.validateFields();
    const epcs = items.filter((i) => i.po_line_id === v.po_line_id || !i.po_line_id).map((i) => i.epc);
    if (!epcs.length) return message.warning('这一行还没有读到的新标签');
    const r = await post(`/rfid/sessions/${d.session.id}/bind`, { epcs, po_line_id: v.po_line_id, qty: v.qty, lot_no: v.lot_no, supplier_lot: v.supplier_lot, mfg_date: toDate(v.mfg_date), location_id: v.location_id });
    onChange(r);
    message.success(`已修改 ${r.bound} 包`);
    if (r.warnings?.length) message.warning(r.warnings.join('；'), 6);
  };
  const pick = (id: number) => {
    const l = lines.find((x) => x.po_line_id === id);
    const it = items.find((i) => i.po_line_id === id);
    form.setFieldsValue({ qty: it?.bind_qty, location_id: it?.bind_location_id ?? l?.suggest_location?.id, lot_no: it?.bind_lot_no, supplier_lot: it?.bind_supplier_lot, mfg_date: undefined });
  };
  return (
    <Card size="small" title={`到货明细 · 采购单 ${d.check.po?.no ?? ''} · ${d.check.po?.supplier_name ?? ''}`} style={{ marginBottom: 12 }}>
      <Table size="small" rowKey="po_line_id" dataSource={lines} pagination={false} scroll={{ x: 'max-content' }}
        columns={[
          { title: '行', dataIndex: 'line_no', width: 40 },
          { title: '物料', dataIndex: 'material_code', render: (v: string, r: Rec) => <span><b>{v}</b> <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.material_name}</Typography.Text>{r.msl_level && r.msl_level !== '1' && <Tag color="orange" style={{ marginLeft: 4 }}>MSL {r.msl_level}</Tag>}</span> },
          { title: '剩余待收', dataIndex: 'remaining', align: 'right', render: (v: number, r: Rec) => `${fmtQty(v)} ${r.uom}` },
          { title: '本次已读', key: 'b', align: 'right', render: (_: any, r: Rec) => <b style={{ color: r.over ? '#cf1322' : r.bound_qty >= r.remaining && r.remaining > 0 ? '#389e0d' : undefined }}>{r.bound_tags} 包 / {fmtQty(r.bound_qty)}</b> },
          { title: '建议库位', key: 's', render: (_: any, r: Rec) => r.suggest_location?.code ?? '-' },
        ]} />
      <Collapse ghost size="small" style={{ marginTop: 4 }} items={[{
        key: 'edit', label: <Typography.Text type="secondary">修改每包数量 / 批号 / 库位（默认已自动带出：采购换算率或最小包装量、沿用上一包批号）</Typography.Text>,
        children: (
          <Form form={form} layout="inline" style={{ rowGap: 8 }}>
            <Form.Item name="po_line_id" label="订单行" rules={[{ required: true, message: '选择订单行' }]}>
              <Select style={{ width: 220 }} onChange={pick} options={lines.map((l) => ({ value: l.po_line_id, label: `第 ${l.line_no} 行 ${l.material_code}` }))} />
            </Form.Item>
            <Form.Item name="qty" label="每包数量" rules={[{ required: true, message: '填写每包数量' }]}><InputNumber min={0.0001} style={{ width: 130 }} suffix={line?.uom} /></Form.Item>
            <Form.Item name="location_id" label="库位"><LocationSelect style={{ width: 200 }} /></Form.Item>
            <Form.Item name="lot_no" label="批号"><Input style={{ width: 140 }} placeholder="空 = 系统生成" /></Form.Item>
            <Form.Item name="supplier_lot" label="原厂批号"><Input style={{ width: 120 }} /></Form.Item>
            <Form.Item name="mfg_date" label="生产日期"><DatePicker style={{ width: 130 }} /></Form.Item>
            <Form.Item><Button onClick={bind}>应用到这一行的全部新标签</Button></Form.Item>
          </Form>
        ),
      }]} />
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
      <PageHeader title="RFID 收货台" sub="选一次采购单，之后每包放上读写器即自动绑定（数量、批号默认带出），最后点一次确认" extra={<RfidLinks fallback={FALLBACK} />} />
      {!sid ? <><Detected type="RECEIVE" onEnter={setSid} waitText="新标签的包装放上收货台；第一次请在下面选采购单" /><Start onStarted={setSid} /></> : !d ? <Card loading /> : d.session.session_type === 'AUTO' ? <AutoSession d={d} onChange={setD} /> : (
        <>
          <SessionBar d={d} onChange={setD} onClosed={() => setSid(null)} fallbackLink={FALLBACK} primary={{ text: primaryOf(d).text, disabled: !primaryOf(d).enabled, loading: busy, onClick: confirm }}>
            <Space style={{ marginTop: 8 }} size={6}><Typography.Text type="secondary" style={{ fontSize: 13 }}>送货单号（可选）</Typography.Text><Input size="small" style={{ width: 180 }} value={note} onChange={(e) => setNote(e.target.value)} /></Space>
          </SessionBar>
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
          {d.session.status === 'OPEN' && <BindPanel d={d} onChange={setD} />}
          <Row gutter={12}>
            <Col span={24}>
              <Card size="small" title={<span>读到的标签 <Typography.Link style={{ fontSize: 12, marginLeft: 8 }} onClick={() => nav(`/purchase/orders/${d.check.po?.id}`)}>{d.check.po?.no}</Typography.Link></span>}>
                <ItemsTable d={d} onChange={setD} extraCols={[{
                  title: '订单行（新标签自动绑定）', key: 'bind',
                  render: (_: any, r: Rec) => {
                    if (r.known || r.sn || r.action) return '-';
                    if (r.po_line_id) {
                      const l = (d.check.lines as Rec[]).find((x) => x.po_line_id === r.po_line_id);
                      return <span>第 {l?.line_no} 行 <b>{l?.material_code}</b> · {fmtQty(r.bind_qty)} · 批号 {r.bind_lot_no || '自动'} · {r.bind_location_code}</span>;
                    }
                    const open = (d.check.lines as Rec[]).filter((l) => l.remaining - l.bound_qty > 1e-9);
                    return open.length ? (
                      <Space wrap size={4}>
                        <Typography.Text type="warning">这是哪种料？</Typography.Text>
                        {open.map((l) => <Button key={l.po_line_id} size="small" type="primary" ghost onClick={async () => setD(await post(`/rfid/sessions/${d.session.id}/bind`, { epcs: [r.epc], po_line_id: l.po_line_id }))}>{l.material_code}</Button>)}
                      </Space>
                    ) : <Typography.Text type="danger">订单已收满（多出的包：拿开或标误读）</Typography.Text>;
                  },
                }]} />
              </Card>
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}
