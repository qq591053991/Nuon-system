/**
 * RFID 标签管理：查询（EPC / 序列号 / 批号 / 物料）、发卡（单张：包装 = 物料+批号+数量+库位；单台 = 序列号）、
 * 按入库单各批次批量发卡、按工单为成品序列号批量发卡、换标（旧标签作废，新标签继承绑定）、作废、打印标签（条码 + EPC）。
 */
import { Button, Card, Form, Input, InputNumber, Modal, Radio, Select, Space, Table, Tag, Typography, message } from 'antd';
import { PlusOutlined, PrinterOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { get, post, type Rec } from '../../../api/http';
import { useAuth } from '../../../auth';
import PageHeader from '../../../components/PageHeader';
import RemoteSelect, { LocationSelect, MaterialSelect } from '../../../components/RemoteSelect';
import ScanInput from '../../../components/ScanInput';
import { usePaged } from '../../../components/usePaged';
import { fmtDateTime, fmtQty } from '../../../utils/format';
import { RfidLinks } from './kit';

function IssueModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const type = Form.useWatch('tag_type', form) ?? 'PACKAGE';
  const submit = async () => {
    const v = await form.validateFields();
    const t = await post('/rfid/tags', v);
    message.success(`已发卡：${t.epc}`);
    onDone();
  };
  return (
    <Modal open title="发卡 / 绑定一张标签" onCancel={onClose} onOk={submit} okText="发卡" width={560} destroyOnHidden>
      <Form form={form} layout="vertical" initialValues={{ tag_type: 'PACKAGE' }}>
        <Form.Item name="tag_type" label="类型"><Radio.Group optionType="button" options={[{ value: 'PACKAGE', label: '包装（料盘/箱/托盘）' }, { value: 'UNIT', label: '单台（成品序列号）' }]} /></Form.Item>
        <Form.Item name="epc" label="EPC（空 = 系统生成，用 RFID 打印机写入；已预编码的标签放上收货台读出或照标签输入）"><Input placeholder="24 位十六进制，如 E2806894…" /></Form.Item>
        {type === 'UNIT' ? (
          <Form.Item name="sn" label="序列号" rules={[{ required: true, message: '请输入序列号' }]}><Input placeholder="扫机身 SN 条码" /></Form.Item>
        ) : (
          <>
            <Form.Item name="material_id" label="物料" rules={[{ required: true, message: '请选择物料' }]}><MaterialSelect /></Form.Item>
            <Space>
              <Form.Item name="lot_no" label="批号"><Input style={{ width: 200 }} /></Form.Item>
              <Form.Item name="qty" label="包装数量" rules={[{ required: true, message: '请填写数量' }]}><InputNumber min={0.0001} style={{ width: 140 }} /></Form.Item>
            </Space>
            <Form.Item name="location_id" label="当前库位"><LocationSelect /></Form.Item>
          </>
        )}
      </Form>
    </Modal>
  );
}

function ReceiptModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [rc, setRc] = useState<Rec | null>(null);
  const [packs, setPacks] = useState<Record<number, number>>({});
  const pick = async (id: number) => {
    const r = await get(`/receipts/${id}`);
    setRc(r);
    setPacks(Object.fromEntries((r.lines as Rec[]).map((l) => [l.id, 1])));
  };
  const submit = async () => {
    if (!rc) return message.warning('请选择入库单');
    const r = await post('/rfid/tags/issue-receipt', { receipt_id: rc.id, packages: Object.entries(packs).map(([line_id, packages]) => ({ line_id: Number(line_id), packages })) });
    Modal.success({
      title: `已发卡 ${r.created.length} 张`, content: <div>{r.skipped.length ? <div>跳过：{r.skipped.join('；')}</div> : null}<div>请打印标签（RFID 打印机按标签上的 EPC 写入）。</div></div>,
      okText: '打印标签', onOk: () => window.open(`/wms/print/labels?tags=${r.created.map((x: Rec) => x.id).join(',')}`, '_blank'),
    });
    onDone();
  };
  return (
    <Modal open title="为入库单的各批次批量发卡" width={760} onCancel={onClose} onOk={submit} okText="发卡" destroyOnHidden>
      <RemoteSelect url="/receipts" noun="入库单" matchKeys={['no']} style={{ width: 420 }} placeholder="选择或扫入库单号" labelOf={(r) => `${r.no} · ${r.partner_name ?? r.receipt_type} · ${r.lines?.length ?? 0} 行`} onChange={(v) => pick(v as number)} />
      {rc && (
        <Table size="small" rowKey="id" style={{ marginTop: 12 }} dataSource={rc.lines} pagination={false} columns={[
          { title: '行', dataIndex: 'line_no', width: 40 }, { title: '物料', dataIndex: 'material_code' }, { title: '批号', dataIndex: 'lot_no' },
          { title: '数量', dataIndex: 'qty', render: (v: number, r: Rec) => `${fmtQty(v)} ${r.uom ?? ''}` }, { title: '库位', dataIndex: 'location_code' },
          { title: '包装数（张）', key: 'p', render: (_: any, r: Rec) => <InputNumber min={1} max={500} value={packs[r.id]} onChange={(v) => setPacks({ ...packs, [r.id]: Number(v) || 1 })} /> },
          { title: '每包', key: 'pp', render: (_: any, r: Rec) => fmtQty(r.qty / (packs[r.id] || 1)) },
        ]} />
      )}
    </Modal>
  );
}

function SerialModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [wo, setWo] = useState<number | null>(null);
  const submit = async () => {
    if (!wo) return message.warning('请选择工单');
    const r = await post('/rfid/tags/issue-serials', { wo_id: wo });
    message.success(`已为 ${r.created.length} 台发卡${r.skipped.length ? `，${r.skipped.length} 台已有标签跳过` : ''}`);
    window.open(`/wms/print/labels?tags=${r.created.map((x: Rec) => x.id).join(',')}`, '_blank');
    onDone();
  };
  return (
    <Modal open title="为成品序列号批量发卡（单台标签）" onCancel={onClose} onOk={submit} okText="发卡并打印" destroyOnHidden>
      <Typography.Paragraph type="secondary">为工单中已完工 / 在库 / 已发货、还没有启用标签的序列号各生成一张单台标签。</Typography.Paragraph>
      <RemoteSelect url="/work-orders" params={{ status: 'IN_PROGRESS,COMPLETED,CLOSED' }} noun="工单" matchKeys={['no']} style={{ width: '100%' }}
        labelOf={(r) => `${r.no} · ${r.material_code} · 完工 ${r.completed_qty ?? 0}`} onChange={(v) => setWo(v as number)} />
    </Modal>
  );
}

export default function RfidTags() {
  const { can } = useAuth();
  const { rows, loading, pagination, setQuery, reload, query } = usePaged('/rfid/tags', { status: 'ACTIVE' }, 50);
  const [modal, setModal] = useState<'one' | 'rc' | 'sn' | null>(null);
  const [found, setFound] = useState<Rec | null>(null);
  const [modalApi, holder] = Modal.useModal();
  const askReason = (title: string, ok: (reason: string, epc?: string) => Promise<void>, withEpc = false) => {
    let reason = '';
    let epc = '';
    modalApi.confirm({
      title,
      content: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input placeholder="原因（必填，如：标签破损读不到）" onChange={(e) => { reason = e.target.value; }} />
          {withEpc && <Input placeholder="新标签 EPC（空 = 系统生成，用打印机写入）" onChange={(e) => { epc = e.target.value; }} />}
        </Space>
      ),
      okText: '确定', cancelText: '返回',
      onOk: async () => { if (!reason.trim()) { message.warning('请填写原因'); throw new Error('reason'); } await ok(reason, epc || undefined); reload(); },
    });
  };
  const lookup = async (code: string) => {
    const r = await get('/rfid/tags/lookup', { code });
    setFound(r);
    if (!r.tags.length) message.info(r.kind === 'LOCATION' ? `这是库位标签：${r.location?.code}` : `没有找到“${code}”对应的标签`);
  };
  return (
    <div>
      {holder}
      <PageHeader title="RFID 标签管理" sub="一个包装标签 = 一个批次的一个包装（带数量）；成品每台一个标签，与序列号绑定" extra={
        <>
          {can('wms') && <Button type="primary" icon={<PlusOutlined />} onClick={() => setModal('one')}>发卡（单张）</Button>}
          {can('wms') && <Button onClick={() => setModal('rc')}>按入库单批量发卡</Button>}
          {can('wms') && <Button onClick={() => setModal('sn')}>按工单为成品发卡</Button>}
          <RfidLinks />
        </>
      } />
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap>
          <div style={{ width: 380 }}><ScanInput size="middle" autoFocus={false} onScan={lookup} placeholder="查标签：EPC / 序列号 / 批号，回车" /></div>
          <Input.Search allowClear placeholder="筛选：EPC、批号、物料编码、序列号" style={{ width: 300 }} onSearch={(q) => setQuery({ q: q || undefined })} />
          <Select style={{ width: 120 }} allowClear placeholder="类型" value={query.tag_type} onChange={(v) => setQuery({ tag_type: v })} options={[{ value: 'PACKAGE', label: '包装' }, { value: 'UNIT', label: '单台' }]} />
          <Select style={{ width: 120 }} allowClear placeholder="状态" value={query.status} onChange={(v) => setQuery({ status: v })} options={[{ value: 'ACTIVE', label: '启用' }, { value: 'VOID', label: '作废' }]} />
          <Select style={{ width: 120 }} allowClear placeholder="在库" value={query.in_stock} onChange={(v) => setQuery({ in_stock: v })} options={[{ value: '1', label: '在库' }]} />
        </Space>
        {found && found.tags.length > 0 && (
          <div style={{ marginTop: 8 }}>查到 {found.tags.length} 张：{found.tags.map((t: Rec) => <Tag key={t.id} color={t.status === 'VOID' ? 'default' : 'blue'} className="mono">{t.epc}（{t.sn ?? `${t.material_code} ${t.lot_no}`}，{t.location_code ?? '不在库'}，{t.status_text}）</Tag>)}</div>
        )}
      </Card>
      <Table size="middle" rowKey="id" dataSource={rows} loading={loading} pagination={pagination} scroll={{ x: 'max-content' }} columns={[
        { title: 'EPC', dataIndex: 'epc', render: (v: string) => <span className="mono">{v}</span> },
        { title: '类型', dataIndex: 'tag_type_text', width: 60 },
        { title: '状态', dataIndex: 'status', width: 70, render: (v: string, r: Rec) => <Tag color={v === 'ACTIVE' ? 'green' : 'default'}>{r.status_text}</Tag> },
        { title: '物料', dataIndex: 'material_code', render: (v: string, r: Rec) => <div><b>{v}</b><div style={{ fontSize: 12, color: '#8c8c8c' }}>{r.material_name}</div></div> },
        { title: '批号 / 序列号', key: 'l', render: (_: any, r: Rec) => (r.sn ? <b className="mono">{r.sn}</b> : <span className="mono">{r.lot_no || '-'}</span>) },
        { title: '数量', dataIndex: 'qty', align: 'right', render: (v: number, r: Rec) => (r.tag_type === 'UNIT' ? '1 台' : `${fmtQty(v)} ${r.uom ?? ''}`) },
        { title: '当前库位', dataIndex: 'location_code', render: (v: string, r: Rec) => v || <Typography.Text type="secondary">{r.sn_status === 'SHIPPED' ? '已发货' : '不在库'}</Typography.Text> },
        { title: '最后读到', key: 'seen', render: (_: any, r: Rec) => (r.last_seen_at ? <span>{fmtDateTime(r.last_seen_at)}<div style={{ fontSize: 12, color: '#8c8c8c' }}>{r.last_reader_name} {r.last_rssi !== null ? `${r.last_rssi} dBm` : ''}</div></span> : '-') },
        { title: '备注', key: 'rm', render: (_: any, r: Rec) => <span style={{ fontSize: 12 }}>{r.void_reason ? `作废：${r.void_reason}${r.replaced_by_epc ? `（新 ${r.replaced_by_epc}）` : ''}` : r.remark}</span> },
        {
          title: '操作', key: '_op', fixed: 'right',
          render: (_: any, r: Rec) => (
            <Space size={4}>
              <Button size="small" icon={<PrinterOutlined />} onClick={() => window.open(`/wms/print/labels?tags=${r.id}`, '_blank')}>打印</Button>
              {r.status === 'ACTIVE' && can('wms') && <Button size="small" onClick={() => askReason(`换标：${r.epc}`, async (reason, epc) => { const n = await post(`/rfid/tags/${r.id}/replace`, { reason, new_epc: epc }); message.success(`新标签 ${n.epc}`); }, true)}>换标</Button>}
              {r.status === 'ACTIVE' && can('wms') && <Button size="small" danger onClick={() => askReason(`作废标签 ${r.epc}`, async (reason) => { await post(`/rfid/tags/${r.id}/void`, { reason }); message.success('已作废'); })}>作废</Button>}
            </Space>
          ),
        },
      ]} />
      {modal === 'one' && <IssueModal onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === 'rc' && <ReceiptModal onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === 'sn' && <SerialModal onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
    </div>
  );
}
