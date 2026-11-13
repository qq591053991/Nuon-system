/**
 * RFID 完工入库：选工单与入库库位 → 成品（每台一张单台标签，绑定序列号）推过读写器 → 只入库读到且“完工待入库”的序列号。
 * 没有标签的成品：点“为本工单发卡”生成单台标签（RFID 打印机写入）；标签损坏：扫机身 SN 条码兜底。
 */
import { Button, Card, Col, Form, Result, Row, Statistic, Tag, Typography, message } from 'antd';
import { TagsOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { post } from '../../../api/http';
import PageHeader from '../../../components/PageHeader';
import RemoteSelect, { LocationSelect } from '../../../components/RemoteSelect';
import { ItemsTable, OpenSessions, ReaderPicker, RfidLinks, SessionBar, errText, useSession, useSessionParam } from './kit';
import { AutoSession, Detected, primaryOf } from './live';

const FALLBACK = { to: '/wms/pda/fg', text: '条码完工入库（兜底）' };

function Start({ onStarted }: { onStarted: (id: number) => void }) {
  const [sp] = useSearchParams();
  const [reader, setReader] = useState<number | null>(null);
  const [wo, setWo] = useState<number | null>(Number(sp.get('wo_id')) || null);
  const [loc, setLoc] = useState<number | null>(null);
  const start = async () => {
    if (!reader || !wo) return message.warning('请选择读写器和工单');
    const d = await post('/rfid/sessions', { session_type: 'FG_RECEIPT', reader_id: reader, wo_id: wo, location_id: loc || undefined });
    onStarted(d.session.id);
  };
  return (
    <>
      <Card title="开始完工入库" style={{ maxWidth: 820 }}>
        <Form layout="vertical">
          <Form.Item label="读写器" required><ReaderPicker purposes={['SHIP', 'RECEIVE', 'COUNT']} value={reader} onChange={(id) => setReader(id)} /></Form.Item>
          <Form.Item label="生产工单（选择，或扫工单号后回车）" required>
            <RemoteSelect url="/work-orders" params={{ status: 'IN_PROGRESS,COMPLETED' }} noun="工单" matchKeys={['no']} style={{ width: 460 }}
              labelOf={(r) => `${r.no} · ${r.material_code} · 完工 ${r.completed_qty ?? 0}/${r.planned_qty}`} value={wo ?? undefined} onChange={(v) => setWo(v as number)} />
          </Form.Item>
          <Form.Item label="入库库位（空 = 按成品默认/建议库位）"><LocationSelect style={{ width: 300 }} allowClear value={loc ?? undefined} onChange={(v) => setLoc((v as number) ?? null)} /></Form.Item>
          <Button type="primary" size="large" onClick={start}>开始</Button>
        </Form>
      </Card>
      <OpenSessions type="FG_RECEIPT" onPick={onStarted} />
    </>
  );
}

export default function RfidFg() {
  const nav = useNavigate();
  const [sid, setSid] = useSessionParam();
  const { d, setD, reload } = useSession(sid);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (!d) return;
    setBusy(true);
    try {
      const r = await post(`/rfid/sessions/${d.session.id}/confirm`, {}, true);
      setD(r);
      message.success(`已入库 ${r.result.qty} 台：${r.result.receipt_no}`);
    } catch (e) {
      message.error(errText(e), 6);
    } finally {
      setBusy(false);
    }
  };
  const issueTags = async () => {
    const r = await post('/rfid/tags/issue-serials', { wo_id: d!.check.wo.id });
    message.success(`已为 ${r.created.length} 台发卡，请用 RFID 打印机写入并贴到机身/彩盒`);
    reload();
  };
  const c = d?.check;
  return (
    <div>
      <PageHeader title="RFID 完工入库" sub="读到的成品单台标签对应序列号；只入库本工单完工待入库的" extra={<RfidLinks fallback={FALLBACK} />} />
      {!sid ? <><Detected type="FG_RECEIPT" onEnter={setSid} waitText="把完工的成品推过读写器，系统自动按工单开始入库核对" /><Start onStarted={setSid} /></> : !d ? <Card loading /> : d.session.session_type === 'AUTO' ? <AutoSession d={d} onChange={setD} /> : (
        <>
          <SessionBar d={d} onChange={setD} onClosed={() => setSid(null)} fallbackLink={FALLBACK} primary={{ text: primaryOf(d).text, disabled: !primaryOf(d).enabled, loading: busy, onClick: confirm }} />
          {d.session.status === 'CONFIRMED' && (
            <Result status="success" title={`完工入库单 ${d.session.ref_no}`} subTitle={c.wo.dhr_status === 'RELEASED' ? '已放行，入库为合格' : 'DHR 尚未放行，入库为“待检/待放行”，QA 放行后才能发货'}
              extra={[<Button key="w" onClick={() => nav(`/mes/work-orders/${c.wo.id}`)}>查看工单</Button>, <Button key="n" type="primary" onClick={() => setSid(null)}>下一工单</Button>]} />
          )}
          {d.session.status === 'OPEN' && <Row gutter={12} style={{ marginBottom: 12 }}>
            <Col span={6}><Card size="small"><Statistic title={`工单 ${c.wo.no} 完工待入库`} value={c.waiting} suffix="台" /></Card></Col>
            <Col span={6}><Card size="small"><Statistic title="读到（可入库）" value={c.read_ok} suffix="台" valueStyle={{ color: '#389e0d' }} /></Card></Col>
            <Col span={6}><Card size="small"><Statistic title="入库库位" value={c.location_code ?? '-'} /></Card></Col>
            <Col span={6}>
              <Card size="small">
                <Statistic title="完工待入库但未发卡" value={c.untagged} suffix="台" valueStyle={{ color: c.untagged ? '#d46b08' : undefined }} />
                {!!c.untagged && d.session.status === 'OPEN' && <Button size="small" icon={<TagsOutlined />} onClick={issueTags}>为本工单发卡</Button>}
              </Card>
            </Col>
          </Row>}
          {!!c.missing?.length && d.session.status === 'OPEN' && (
            <Typography.Paragraph type="secondary">还没读到：{c.missing.map((x: string) => <Tag key={x}>{x}</Tag>)}（不在场的可以下次再入库）</Typography.Paragraph>
          )}
          <Card size="small" title="读到的标签"><ItemsTable d={d} onChange={setD} /></Card>
        </>
      )}
    </div>
  );
}
