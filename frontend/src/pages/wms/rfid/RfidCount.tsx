/**
 * RFID 盘点对账：选库位（或扫库位标签）→ 手持读写器扫过整个库位后上传 → 与账面对比：
 *   读到（账面在此库位）/ 账面有但没读到 / 读到但账面不在此库位 / 账面有库存但没有标签（需人工清点）；
 * 确认 = 写入盘点单（沿用现有盘点单），可直接过账：调整量 = 实盘 − 过账时的当前账面。
 */
import { Alert, Button, Card, Checkbox, Col, Form, Modal, Result, Row, Statistic, Table, Tag, Typography, message } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { post, type Rec } from '../../../api/http';
import PageHeader from '../../../components/PageHeader';
import { LocationSelect } from '../../../components/RemoteSelect';
import { fmtQty } from '../../../utils/format';
import { ItemsTable, OpenSessions, ReaderPicker, RfidLinks, SessionBar, errText, useSession, useSessionParam } from './kit';
import { AutoSession, Detected, diffText, primaryOf } from './live';

const FALLBACK = { to: '/wms/pda/count', text: '条码盘点（兜底）' };

function Start({ onStarted }: { onStarted: (id: number) => void }) {
  const [reader, setReader] = useState<number | null>(null);
  const [loc, setLoc] = useState<number | null>(null);
  const start = async (id = loc) => {
    if (!reader || !id) return message.warning('请选择手持读写器和库位');
    const d = await post('/rfid/sessions', { session_type: 'COUNT', reader_id: reader, location_id: id });
    onStarted(d.session.id);
  };
  return (
    <>
      <Card title="开始盘点（一次一个库位）" style={{ maxWidth: 820 }}>
        <Form layout="vertical">
          <Form.Item label="手持读写器" required><ReaderPicker purposes={['COUNT']} value={reader} onChange={(id) => setReader(id)} /></Form.Item>
          <Form.Item label="库位（选择，或扫库位条码后回车）" required>
            <LocationSelect style={{ width: 360 }} value={loc ?? undefined} onChange={(v) => setLoc(v as number)} onPick={(r) => { if (r && reader) start(r.id); }} />
          </Form.Item>
          <Button type="primary" size="large" onClick={() => start()}>开始盘点</Button>
        </Form>
        <Alert type="info" showIcon style={{ marginTop: 16 }} message="手持机扫完整个库位（货架前后、上下层都要扫到）后点手持机上的“上传”；上传的读取会自动计入本次盘点。" />
      </Card>
      <OpenSessions type="COUNT" onPick={onStarted} />
    </>
  );
}

export default function RfidCount() {
  const nav = useNavigate();
  const [sid, setSid] = useSessionParam();
  const { d, setD } = useSession(sid, 2000);
  const [busy, setBusy] = useState(false);
  const confirm = async (postNow: boolean) => {
    if (!d) return;
    let asBook = false;
    if (postNow) {
      const untagged = (d.check.lines as Rec[]).filter((l) => l.untagged_qty > 0).length;
      const ok = await new Promise<boolean>((resolve) => Modal.confirm({
        title: '写入盘点单并过账？',
        content: (
          <div>
            调整量 = 实盘（读到的标签数量）− 过账时的当前账面；盘盈入库、盘亏出库。
            {untagged > 0 && <div style={{ marginTop: 8 }}><Checkbox onChange={(e) => { asBook = e.target.checked; }}>有 {untagged} 个批次的部分库存没有标签，按当前账面处理（不调整）</Checkbox></div>}
          </div>
        ),
        okText: '过账', cancelText: '返回', onOk: () => resolve(true), onCancel: () => resolve(false),
      }));
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await post(`/rfid/sessions/${d.session.id}/confirm`, { post: postNow, uncounted_as_book: asBook }, true);
      setD(r);
      message.success(`已写入盘点单 ${r.result.count_no}${r.result.count_status === 'POSTED' ? '并过账' : ''}`);
    } catch (e) {
      message.error(errText(e), 8);
    } finally {
      setBusy(false);
    }
  };
  const c = d?.check;
  const here = d ? (d.items as Rec[]).filter((i) => i.level === 'ok' || (i.action === 'DONE')) : [];
  const elsewhere = d ? (d.items as Rec[]).filter((i) => !i.action && i.known && i.level === 'warn') : [];
  return (
    <div>
      <PageHeader title="RFID 盘点对账" sub="手持读写器批量读取一个库位，与账面逐包对比" extra={<RfidLinks fallback={FALLBACK} />} />
      {!sid ? <><Detected type="COUNT" onEnter={setSid} waitText="用手持机扫库位标签和货架，系统自动按库位开始盘点" /><Start onStarted={setSid} /></> : !d ? <Card loading /> : d.session.session_type === 'AUTO' ? <AutoSession d={d} onChange={setD} /> : (
        <>
          <SessionBar d={d} onChange={setD} onClosed={() => setSid(null)} fallbackLink={FALLBACK} readyText={diffText(d)} primary={{ text: primaryOf(d).text, disabled: !primaryOf(d).enabled, loading: busy, onClick: () => confirm(true) }}>
            <div style={{ marginTop: 8, fontSize: 13 }}><a onClick={() => confirm(false)}>只写入盘点单（稍后在“库存盘点”复核过账）</a></div>
          </SessionBar>
          {d.session.status === 'CONFIRMED' && (
            <Result status="success" title={`已写入盘点单 ${d.session.ref_no}`} subTitle="没有标签的库存需在盘点单中人工录入实盘；未过账的盘点单可在“库存盘点”中复核后过账。"
              extra={[<Button key="c" onClick={() => nav(`/wms/counts?id=${d.session.ref_id}`)}>打开盘点单</Button>, <Button key="n" type="primary" onClick={() => setSid(null)}>盘下一个库位</Button>]} />
          )}
          {d.session.status === 'OPEN' && (<>
          <Row gutter={12} style={{ marginBottom: 12 }}>
            <Col span={5}><Card size="small"><Statistic title={`库位 ${c.location.code} 账面标签`} value={c.book_tags} suffix="张" /></Card></Col>
            <Col span={5}><Card size="small"><Statistic title="读到（账面在此）" value={c.read_here} valueStyle={{ color: '#389e0d' }} /></Card></Col>
            <Col span={5}><Card size="small"><Statistic title="账面有但没读到" value={c.missing.length} valueStyle={{ color: c.missing.length ? '#cf1322' : undefined }} /></Card></Col>
            <Col span={5}><Card size="small"><Statistic title="读到但账面不在此库位" value={c.read_elsewhere} valueStyle={{ color: c.read_elsewhere ? '#d46b08' : undefined }} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title="未登记标签" value={d.summary.unknown} /></Card></Col>
          </Row>
          <Card size="small" title="按物料批次对比（实盘 = 读到的标签数量）" style={{ marginBottom: 12 }}>
            <Table size="small" rowKey="key" dataSource={c.lines} pagination={false} scroll={{ x: 'max-content' }}
              onRow={(r) => ({ style: { background: Math.abs(r.diff) > 1e-9 ? '#fffbe6' : undefined } })}
              columns={[
                { title: '物料', dataIndex: 'material_code', render: (v: string, r: Rec) => <div><b>{v}</b><div style={{ fontSize: 12, color: '#8c8c8c' }}>{r.material_name}</div></div> },
                { title: '批次', dataIndex: 'lot_no', render: (v: string) => <span className="mono">{v || '-'}</span> },
                { title: '账面', dataIndex: 'book_qty', align: 'right', render: (v: number, r: Rec) => `${fmtQty(v)} ${r.uom}` },
                { title: '有标签', dataIndex: 'tag_qty', align: 'right', render: (v: number) => fmtQty(v) },
                { title: '读到', dataIndex: 'read_qty', align: 'right', render: (v: number) => <b>{fmtQty(v)}</b> },
                { title: '差异', dataIndex: 'diff', align: 'right', render: (v: number) => (Math.abs(v) > 1e-9 ? <b style={{ color: v < 0 ? '#cf1322' : '#d46b08' }}>{v > 0 ? '+' : ''}{fmtQty(v)}</b> : '0') },
                { title: '备注', dataIndex: 'note', render: (v: string) => (v ? <Typography.Text type="warning">{v}</Typography.Text> : '') },
              ]} />
          </Card>
          <Row gutter={12}>
            <Col xs={24} xl={12}>
              <Card size="small" title={<span>账面有但没读到 <Tag color="red">{c.missing.length}</Tag></span>} style={{ marginBottom: 12 }}>
                <Table size="small" rowKey="epc" dataSource={c.missing} pagination={false} locale={{ emptyText: '无' }} columns={[
                  { title: '标签', key: 'w', render: (_: any, r: Rec) => (r.sn ? <b className="mono">{r.sn}</b> : <span><b>{r.material_code}</b> {r.lot_no} · {fmtQty(r.qty)}</span>) },
                  { title: 'EPC', dataIndex: 'epc', render: (v: string) => <span className="mono" style={{ fontSize: 12 }}>{v}</span> },
                ]} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>先在货架上找一找（被金属遮挡、贴在背面）；找到后再扫一遍。确认时没读到的按盘亏处理。</Typography.Text>
              </Card>
            </Col>
            <Col xs={24} xl={12}>
              <Card size="small" title={<span>读到但账面不在此库位 <Tag color="orange">{elsewhere.length}</Tag></span>} style={{ marginBottom: 12 }}>
                <Table size="small" rowKey="epc" dataSource={elsewhere} pagination={false} locale={{ emptyText: '无' }} columns={[
                  { title: '标签', key: 'w', render: (_: any, r: Rec) => (r.sn ? <b className="mono">{r.sn}</b> : <span><b>{r.material_code}</b> {r.lot_no} · {fmtQty(r.qty)}</span>) },
                  { title: '账面库位', dataIndex: 'location_code', render: (v: string) => v ?? '不在库' },
                ]} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>确认后按此处实物盘盈；原库位盘点时会盘亏（或先用库门/调拨移回）。</Typography.Text>
              </Card>
            </Col>
          </Row>
          </>)}
          <Card size="small" title={`全部读取（读到 ${here.length}）`}><ItemsTable d={d} onChange={setD} /></Card>
        </>
      )}
    </div>
  );
}
