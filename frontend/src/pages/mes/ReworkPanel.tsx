/**
 * 工位终端 · 返工换件（评审 P1-1）：产品按 NCR 返工时，先登记拆下 / 装上的零件批次（或部件序列号），再重新测试。
 * 装上的零件从合格库存补领（系统校验合格、未过期、客供料隔离），记入单台追溯与 DHR。
 */
import { Alert, App, Button, Card, Col, Empty, Input, InputNumber, Row, Select, Space, Table, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined, SwapOutlined } from '@ant-design/icons';
import { useState } from 'react';
import type { Rec } from '../../api/http';
import { MaterialSelect } from '../../components/RemoteSelect';
import { fmtDate, fmtDateTime } from '../../utils/format';
import { errDetail, num } from './spec';
import { stationGet, stationPost } from './stationApi';

interface RemovedRow { key: number; material_id: number; material: string; lot_no?: string; part_sn?: string; remark?: string }
interface InstalledRow { key: number; material_id: number; material: string; lot_no: string; location_id: number; location: string; qty: number; part_sn?: string }

const ACTION_COLOR: Record<string, string> = { REMOVE: 'volcano', INSTALL: 'green', BIND: 'blue' };

export function KeyPartActionTag({ action, text }: { action: string; text?: string }) {
  return <Tag color={ACTION_COLOR[action] || 'default'} style={{ marginInlineEnd: 0 }}>{text || action}</Tag>;
}

interface Props {
  scan: Rec;
  token: string;
  /** 登记成功后刷新扫码信息 */
  onDone: () => void;
  /** 无报工权限时只读 */
  readOnly?: boolean;
}

let seq = 0;

export default function ReworkPanel({ scan, token, onDone, readOnly }: Props) {
  const { modal, message } = App.useApp();
  const rw: Rec = scan.rework;
  const done: Rec[] = (scan.key_parts || []).filter((k: Rec) => k.action !== 'BIND' && k.ncr_no === rw.ncr_no);
  const [removed, setRemoved] = useState<RemovedRow[]>([]);
  const [installed, setInstalled] = useState<InstalledRow[]>([]);
  const [remark, setRemark] = useState('');
  const [saving, setSaving] = useState(false);
  // 拆下：物料 + 批号/部件序列号
  const [rmMat, setRmMat] = useState<Rec | undefined>();
  const [rmLot, setRmLot] = useState('');
  const [rmPsn, setRmPsn] = useState('');
  const [rmRemark, setRmRemark] = useState('');
  // 装上：扫批号 → 带出合格库存（物料 + 库位）
  const [inLot, setInLot] = useState('');
  const [stocks, setStocks] = useState<Rec[]>([]);
  const [stockId, setStockId] = useState<number | undefined>();
  const [inQty, setInQty] = useState<number>(1);
  const [inPsn, setInPsn] = useState('');
  const [looking, setLooking] = useState(false);
  const [lookErr, setLookErr] = useState<string | null>(null);

  const lookup = async (lot: string) => {
    const v = lot.trim();
    if (!v) return;
    setLooking(true);
    setLookErr(null);
    setStocks([]);
    setStockId(undefined);
    try {
      const d = await stationGet(token, '/stock', { lot_no: v, status: 'AVAILABLE', page_size: 50 });
      const rows: Rec[] = (d.items || []).filter((s: Rec) => s.qty > 0);
      if (!rows.length) setLookErr(`批次 ${v} 没有合格（已检验放行）库存，不能用于返工`);
      setStocks(rows);
      if (rows.length) setStockId(rows[0].id);
    } catch (e) {
      setLookErr(errDetail(e));
    } finally {
      setLooking(false);
    }
  };

  const picked = stocks.find((s) => s.id === stockId);
  const expired = !!picked?.expiry_date && new Date(picked.expiry_date) < new Date(new Date().toDateString());

  const addRemoved = () => {
    if (!rmMat) return;
    setRemoved((l) => [...l, {
      key: ++seq, material_id: rmMat.id, material: `${rmMat.code} ${rmMat.name}`,
      lot_no: rmLot.trim() || undefined, part_sn: rmPsn.trim() || undefined, remark: rmRemark.trim() || undefined,
    }]);
    setRmLot('');
    setRmPsn('');
    setRmRemark('');
  };

  const addInstalled = () => {
    if (!picked) return;
    setInstalled((l) => [...l, {
      key: ++seq, material_id: picked.material_id, material: `${picked.material_code} ${picked.material_name}`, lot_no: picked.lot_no,
      location_id: picked.location_id, location: picked.location_code, qty: inQty || 1, part_sn: inPsn.trim() || undefined,
    }]);
    // 拆下清单为空时，默认登记拆下同一物料（常见：坏件换新件）
    if (!removed.length && !rmMat) setRmMat({ id: picked.material_id, code: picked.material_code, name: picked.material_name });
    setInLot('');
    setStocks([]);
    setStockId(undefined);
    setInQty(1);
    setInPsn('');
  };

  const submit = () => {
    if (!removed.length && !installed.length) {
      message.warning('请先加入拆下或装上的零件');
      return;
    }
    modal.confirm({
      title: `提交返工换件记录（${scan.sn}）？`,
      width: 520,
      content: (
        <div>
          <p>拆下 {removed.length} 项，装上 {installed.length} 项，关联不合格报告 <b>{rw.ncr_no}</b>。</p>
          {installed.length > 0 && <p>装上的零件将从合格库存扣减（返工补料，记入单台追溯与 DHR），提交后不可修改。</p>}
        </div>
      ),
      okText: '确认提交',
      onOk: async () => {
        setSaving(true);
        try {
          await stationPost(token, '/mes/rework-parts', {
            sn: scan.sn,
            removed: removed.map(({ material_id, lot_no, part_sn, remark: r }) => ({ material_id, lot_no, part_sn, remark: r })),
            installed: installed.map(({ material_id, lot_no, location_id, qty, part_sn }) => ({ material_id, lot_no, location_id, qty, part_sn })),
            remark: remark.trim() || undefined,
          });
          message.success('返工换件已登记，请重新测试该工序');
          setRemoved([]);
          setInstalled([]);
          setRemark('');
          onDone();
        } catch (e) {
          modal.error({ title: '登记失败', content: errDetail(e) });
        } finally {
          setSaving(false);
        }
      },
    });
  };

  return (
    <Card
      style={{ marginBottom: 16, borderColor: '#fa8c16', borderWidth: 2 }}
      title={<Space><SwapOutlined style={{ color: '#fa8c16' }} />返工换件<Tag color="orange">{rw.ncr_no}</Tag></Space>}
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message={<b style={{ fontSize: 16 }}>该产品按 NCR 返工中（工序 {rw.ng_seq} {rw.op_name} 不合格）</b>}
        description={
          <>
            {rw.disposition_remark && <div>QA 处置意见：{rw.disposition_remark}</div>}
            <div>如更换了零件，请先登记<b>拆下</b>与<b>装上</b>的零件批号（或部件序列号），再重新测试；装上的零件须为合格、未过期的批次。</div>
          </>
        }
      />

      {done.length > 0 && (
        <Table<Rec> rowKey="id" size="small" pagination={false} style={{ marginBottom: 12 }} dataSource={done} columns={[
          { title: '已登记', dataIndex: 'action', render: (v, r) => <KeyPartActionTag action={v} text={r.action_text} /> },
          { title: '零件', key: 'm', render: (_, r) => `${r.material_code} ${r.material_name}` },
          { title: '批号', dataIndex: 'lot_no', render: (v) => <span className="mono">{v || '-'}</span> },
          { title: '部件序列号', dataIndex: 'part_sn', render: (v) => v || '-' },
          { title: '操作员', dataIndex: 'operator_name' },
          { title: '时间', dataIndex: 'ts', render: (v) => fmtDateTime(v) },
        ]} />
      )}

      {readOnly ? null : (
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Typography.Title level={5} style={{ marginTop: 0 }}><Tag color="volcano">拆下</Tag>坏件 / 被替换的零件</Typography.Title>
            <Space direction="vertical" style={{ width: '100%' }}>
              <MaterialSelect size="large" style={{ width: '100%' }} placeholder="选择拆下零件的物料" value={rmMat?.id}
                onChange={(v) => !v && setRmMat(undefined)} onPick={(r) => setRmMat(r)} />
              <Space.Compact style={{ width: '100%' }}>
                <Input size="large" placeholder="原批号（可选）" value={rmLot} onChange={(e) => setRmLot(e.target.value)} />
                <Input size="large" placeholder="部件序列号/位号（可选）" value={rmPsn} onChange={(e) => setRmPsn(e.target.value)} />
              </Space.Compact>
              <Input size="large" placeholder="拆下原因（如：驱动IC击穿）" value={rmRemark} onChange={(e) => setRmRemark(e.target.value)} onPressEnter={addRemoved} />
              <Button size="large" icon={<PlusOutlined />} disabled={!rmMat} onClick={addRemoved}>加入拆下清单</Button>
            </Space>
          </Col>
          <Col xs={24} lg={12}>
            <Typography.Title level={5} style={{ marginTop: 0 }}><Tag color="green">装上</Tag>新零件（从合格库存补领）</Typography.Title>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Input.Search size="large" placeholder="扫描新零件批号" enterButton="查询" loading={looking} value={inLot}
                onChange={(e) => setInLot(e.target.value)} onSearch={lookup} />
              {lookErr && <Typography.Text type="danger">{lookErr}</Typography.Text>}
              {stocks.length > 0 && (
                <Select size="large" style={{ width: '100%' }} value={stockId} onChange={setStockId}
                  options={stocks.map((s) => ({
                    value: s.id,
                    label: `${s.material_code} ${s.material_name} · ${s.location_code} · 可用 ${num(s.qty)}${s.owner_customer_name ? ` · 客供(${s.owner_customer_name})` : ''}${s.expiry_date ? ` · 有效期 ${fmtDate(s.expiry_date)}` : ''}`,
                  }))} />
              )}
              {expired && <Typography.Text type="danger">该批次已过期，系统将禁止使用</Typography.Text>}
              <Space.Compact style={{ width: '100%' }}>
                <InputNumber size="large" min={0.0001} value={inQty} onChange={(v) => setInQty(Number(v) || 1)} prefix="数量" style={{ width: "50%" }} />
                <Input size="large" placeholder="部件序列号/位号（可选）" value={inPsn} onChange={(e) => setInPsn(e.target.value)} style={{ width: '50%' }} />
              </Space.Compact>
              <Button size="large" icon={<PlusOutlined />} disabled={!picked || expired} onClick={addInstalled}>加入装上清单</Button>
            </Space>
          </Col>
          <Col span={24}>
            {removed.length + installed.length > 0 ? (
              <Table<Rec> rowKey="key" size="small" pagination={false} dataSource={[
                ...removed.map((r) => ({ ...r, action: 'REMOVE', action_text: '拆下' })),
                ...installed.map((r) => ({ ...r, action: 'INSTALL', action_text: '装上' })),
              ]} columns={[
                { title: '动作', dataIndex: 'action', render: (v, r) => <KeyPartActionTag action={v} text={r.action_text} /> },
                { title: '零件', dataIndex: 'material' },
                { title: '批号', dataIndex: 'lot_no', render: (v) => <span className="mono">{v || '-'}</span> },
                { title: '库位', dataIndex: 'location', render: (v) => v || '-' },
                { title: '数量', dataIndex: 'qty', render: (v) => (v ? num(v) : '-') },
                { title: '部件序列号', dataIndex: 'part_sn', render: (v) => v || '-' },
                { title: '原因', dataIndex: 'remark', render: (v) => v || '-' },
                {
                  title: '', key: 'del', width: 48,
                  render: (_, r) => (
                    <Button type="text" danger icon={<DeleteOutlined />} onClick={() => (r.action === 'REMOVE'
                      ? setRemoved((l) => l.filter((x) => x.key !== r.key))
                      : setInstalled((l) => l.filter((x) => x.key !== r.key)))} />
                  ),
                },
              ]} />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未换件可直接重新测试；换件请先加入清单" />
            )}
          </Col>
          <Col xs={24} md={16}>
            <Input size="large" placeholder="返工说明（可选）" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </Col>
          <Col xs={24} md={8}>
            <Button block size="large" type="primary" style={{ background: '#fa8c16', borderColor: '#fa8c16' }} loading={saving}
              disabled={!removed.length && !installed.length} onClick={submit}>
              提交换件记录
            </Button>
          </Col>
        </Row>
      )}
    </Card>
  );
}
