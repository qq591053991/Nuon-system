/**
 * RFID 领料核对：选领料单 → 拣好的料盘/料箱放到读写器上（或手持机扫过）→ 按领料单逐行核对批次与数量：
 * 多读（不在单上 / 本批次已够数）、少读（还差多少）、读错批次都明确标红；全部够数后确认 = 拣料 + 领料过账（标签数量随之扣减）。
 * 有少读行时可“部分过账”：少读的行转入新领料单。
 */
import { Alert, Button, Card, Col, Form, Modal, Result, Row, Space, Table, Tag, message } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { post, type Rec } from '../../../api/http';
import PageHeader from '../../../components/PageHeader';
import RemoteSelect from '../../../components/RemoteSelect';
import { fmtQty } from '../../../utils/format';
import { ItemsTable, OpenSessions, ReaderPicker, RfidLinks, SessionBar, errText, useSession, useSessionParam } from './kit';
import { AutoSession, Detected, primaryOf } from './live';

const FALLBACK = { to: '/wms/pda/pick', text: '条码拣料（兜底）' };
const ST: Record<string, [string, string]> = { OK: ['够数', 'green'], PARTIAL: ['少读', 'orange'], MISSING: ['未读到', 'red'] };

function Start({ onStarted }: { onStarted: (id: number) => void }) {
  const nav = useNavigate();
  const [reader, setReader] = useState<number | null>(null);
  const [issue, setIssue] = useState<number | null>(null);
  const start = async (id = issue) => {
    if (!reader || !id) return message.warning('请选择读写器和领料单');
    const d = await post('/rfid/sessions', { session_type: 'ISSUE', reader_id: reader, issue_id: id });
    onStarted(d.session.id);
  };
  return (
    <>
      <Card title="开始领料核对" style={{ maxWidth: 820 }}>
        <Form layout="vertical">
          <Form.Item label="核对用读写器（收货台/发货口桌面读写器或手持机）" required><ReaderPicker purposes={['RECEIVE', 'COUNT', 'SHIP']} value={reader} onChange={(id) => setReader(id)} /></Form.Item>
          <Form.Item label="待过账领料单（选择，或扫拣料单上的单号后回车）" required>
            <RemoteSelect url="/issues" params={{ status: 'DRAFT', issue_type: 'ISSUE' }} noun="领料单" matchKeys={['no']} style={{ width: 460 }}
              labelOf={(r) => `${r.no} · 工单 ${r.wo_no ?? ''} · ${r.lines?.length ?? 0} 行`} value={issue ?? undefined}
              onChange={(v) => setIssue(v as number)} onPick={(r) => { if (r && reader) start(r.id); }} />
          </Form.Item>
          <Space>
            <Button type="primary" size="large" onClick={() => start()}>开始核对</Button>
            <Button onClick={() => nav('/wms/issues')}>从工单生成领料单</Button>
          </Space>
        </Form>
      </Card>
      <OpenSessions type="ISSUE" onPick={onStarted} />
    </>
  );
}

export default function RfidIssue() {
  const nav = useNavigate();
  const [sid, setSid] = useSessionParam();
  const { d, setD } = useSession(sid);
  const [busy, setBusy] = useState(false);
  const confirm = async (partial: boolean) => {
    if (!d) return;
    if (partial) {
      const ok = await new Promise<boolean>((resolve) => Modal.confirm({
        title: '部分过账？', content: `只过账读到够数的 ${d.check.ok_lines} 行；少读的 ${d.check.short_lines} 行转入新领料单，稍后再拣。`,
        okText: '部分过账', cancelText: '返回继续读', onOk: () => resolve(true), onCancel: () => resolve(false),
      }));
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await post(`/rfid/sessions/${d.session.id}/confirm`, { partial }, true);
      setD(r);
      message.success(`领料单 ${r.result.issue_no} 已过账${r.result.partial ? '（部分过账）' : ''}`);
    } catch (e) {
      message.error(errText(e), 6);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <PageHeader title="RFID 领料核对" sub="读到的包装与领料单逐行核对批次、数量；一致后确认即拣料并过账" extra={<RfidLinks fallback={FALLBACK} />} />
      {!sid ? <><Detected type="ISSUE" onEnter={setSid} waitText="把拣好的料盘/料箱放上读写器，系统自动识别领料单" /><Start onStarted={setSid} /></> : !d ? <Card loading /> : d.session.session_type === 'AUTO' ? <AutoSession d={d} onChange={setD} /> : (
        <>
          <SessionBar d={d} onChange={setD} onClosed={() => setSid(null)} fallbackLink={FALLBACK} primary={{ text: primaryOf(d).text, disabled: !primaryOf(d).enabled, loading: busy, onClick: () => confirm(false) }}>
            {d.check.need_partial && d.check.ok_lines > 0 && d.can_confirm && (
              <Alert type="info" showIcon style={{ marginTop: 10 }} message={`还有 ${d.check.short_lines} 行少读；可以继续读，或只过账够数的行`} action={<Button size="small" loading={busy} onClick={() => confirm(true)}>部分过账（少读行转新单）</Button>} />
            )}
          </SessionBar>
          {d.session.status === 'CONFIRMED' && (
            <Result status="success" title={`领料单 ${d.session.ref_no} 已过账`} extra={[
              <Button key="i" onClick={() => nav(`/wms/issues?id=${d.session.ref_id}`)}>查看领料单</Button>,
              <Button key="n" type="primary" onClick={() => setSid(null)}>核对下一单</Button>,
            ]} />
          )}
          <Row gutter={12}>
            {d.session.status === 'OPEN' && <Col xs={24} xxl={11} style={{ marginBottom: 12 }}>
              <Card size="small" title={<span>领料单 {d.check.issue?.no} · 工单 {d.check.issue?.wo_no}</span>}
                extra={<Space><Tag color="green">够数 {d.check.ok_lines}</Tag>{!!d.check.short_lines && <Tag color="orange">少读 {d.check.short_lines}</Tag>}</Space>}>
                <Table size="small" rowKey="line_id" dataSource={d.check.lines ?? []} pagination={false} scroll={{ x: 'max-content' }}
                  onRow={(r) => ({ style: { background: r.status === 'OK' ? '#f6ffed' : '#fffbe6' } })}
                  columns={[
                    { title: '库位', dataIndex: 'location_code', width: 80 },
                    { title: '物料 / 批次', key: 'm', render: (_: any, r: Rec) => <div><b>{r.material_code}</b> <span className="mono">{r.lot_no || '-'}</span><div style={{ fontSize: 12, color: '#8c8c8c' }}>{r.material_name}</div></div> },
                    { title: '应领', dataIndex: 'qty', align: 'right', render: (v: number, r: Rec) => `${fmtQty(v)} ${r.uom}` },
                    { title: '读到', dataIndex: 'read_qty', align: 'right', render: (v: number) => fmtQty(v) },
                    { title: '状态', dataIndex: 'status', render: (v: string, r: Rec) => <span><Tag color={ST[v][1]}>{ST[v][0]}</Tag>{v !== 'OK' && <span style={{ fontSize: 12 }}>{r.message}</span>}</span> },
                  ]} />
              </Card>
            </Col>}
            <Col xs={24} xxl={d.session.status === 'OPEN' ? 13 : 24}>
              <Card size="small" title="读到的标签"><ItemsTable d={d} onChange={setD} /></Card>
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}
