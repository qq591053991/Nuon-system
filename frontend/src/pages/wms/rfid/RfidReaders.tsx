/**
 * RFID 读写器管理：编码、名称、类型（桌面/门式/手持）、用途（收货台/库门/发货口/盘点）、绑定仓库与库位、门的方向规则（天线号）、
 * 信号阈值、启用；接口密钥只在新增/重新生成时显示一次（库里只存哈希）。附接入说明与请求示例。
 */
import { Alert, Button, Card, Collapse, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, Typography, message } from 'antd';
import { KeyOutlined, PlusOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { get, post, put, type Rec } from '../../../api/http';
import PageHeader from '../../../components/PageHeader';
import { LocationSelect, WarehouseSelect } from '../../../components/RemoteSelect';
import { fmtDateTime } from '../../../utils/format';
import { OnlineBadge, RfidLinks, useRfidOptions } from './kit';

const TYPES = [{ value: 'DESKTOP', label: '桌面读写器' }, { value: 'GATE', label: '门式读写器' }, { value: 'HANDHELD', label: '手持读写器' }];
const PURPOSES = [{ value: 'RECEIVE', label: '收货台' }, { value: 'GATE', label: '库门' }, { value: 'SHIP', label: '发货口' }, { value: 'COUNT', label: '盘点' }];
const DIRS = [
  { value: 'ANTENNA', label: '按天线先后判定（外→内 = 进库）' }, { value: 'FIXED_IN', label: '固定进库（单向门）' },
  { value: 'FIXED_OUT', label: '固定出库（单向门）' }, { value: 'NONE', label: '不判定方向' },
];
const DIR_SHORT: Record<string, string> = { ANTENNA: '按天线先后', FIXED_IN: '固定进库', FIXED_OUT: '固定出库', NONE: '不判定' };

function showKey(r: Rec) {
  const origin = window.location.origin;
  Modal.success({
    width: 720,
    title: `读写器 ${r.code} 的接口密钥（只显示这一次）`,
    content: (
      <div>
        <Typography.Paragraph copyable={{ text: r.key }} className="mono" style={{ fontSize: 16, background: '#f5f5f5', padding: 8 }}>{r.key}</Typography.Paragraph>
        <Typography.Paragraph type="secondary">请立即配置到读写器或中间件（请求头 X-Reader-Key）。系统只保存哈希，丢失后只能重新生成。</Typography.Paragraph>
        <pre style={{ fontSize: 12, background: '#fafafa', padding: 8, whiteSpace: 'pre-wrap' }}>{`curl -X POST ${origin}/api/rfid/readings \\
  -H "Content-Type: application/json" -H "X-Reader-Key: ${r.key}" \\
  -d '{"reader_code":"${r.code}","reads":[{"epc":"4E5501000000000000000001","antenna":1,"rssi":-52,"ts":"2026-11-13T09:30:00+08:00"}]}'`}</pre>
      </div>
    ),
  });
}

function EditModal({ row, onClose, onDone }: { row: Rec | null; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const mode = Form.useWatch('direction_mode', form);
  const purpose = Form.useWatch('purpose', form);
  const submit = async () => {
    const v = await form.validateFields();
    if (row?.id) {
      await put(`/rfid/readers/${row.id}`, v);
      message.success('已保存');
    } else {
      showKey(await post('/rfid/readers', v));
    }
    onDone();
  };
  return (
    <Modal open title={row?.id ? `编辑读写器 ${row.code}` : '新增读写器'} width={720} onCancel={onClose} onOk={submit} okText="保存" destroyOnHidden>
      <Form form={form} layout="vertical" initialValues={row ?? { reader_type: 'DESKTOP', purpose: 'RECEIVE', direction_mode: 'NONE', is_active: true }}>
        <Space wrap>
          <Form.Item name="code" label="编码" rules={[{ required: true }]}><Input disabled={!!row?.id} style={{ width: 160 }} placeholder="如 RD-RCV-02" /></Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input style={{ width: 240 }} placeholder="如 2 号收货台" /></Form.Item>
          <Form.Item name="reader_type" label="类型"><Select style={{ width: 140 }} options={TYPES} /></Form.Item>
          <Form.Item name="purpose" label="用途"><Select style={{ width: 120 }} options={PURPOSES} /></Form.Item>
        </Space>
        <Space wrap>
          <Form.Item name="warehouse_id" label="所属仓库"><WarehouseSelect style={{ width: 200 }} allowClear /></Form.Item>
          <Form.Item name="location_id" label={purpose === 'GATE' ? '库内侧默认库位（进库目标）' : '绑定库位（可空）'}><LocationSelect style={{ width: 240 }} allowClear /></Form.Item>
          {purpose === 'GATE' && <Form.Item name="outside_location_id" label="库外侧库位（出库目标，如线边仓）"><LocationSelect style={{ width: 240 }} allowClear /></Form.Item>}
        </Space>
        {purpose === 'GATE' && (
          <Space wrap>
            <Form.Item name="direction_mode" label="方向规则"><Select style={{ width: 300 }} options={DIRS} /></Form.Item>
            {mode === 'ANTENNA' && <Form.Item name="inner_antenna" label="库内侧天线号" rules={[{ required: true }]}><InputNumber min={1} max={16} /></Form.Item>}
            {mode === 'ANTENNA' && <Form.Item name="outer_antenna" label="库外侧天线号" rules={[{ required: true }]}><InputNumber min={1} max={16} /></Form.Item>}
          </Space>
        )}
        <Space wrap>
          <Form.Item name="rssi_min" label="信号阈值（dBm，空 = 系统默认）" tooltip="低于该值的读取视为误读（隔壁货架、擦边），只记录不计入；门口货架多时调高（如 -60）"><InputNumber style={{ width: 160 }} max={0} min={-120} /></Form.Item>
          <Form.Item name="is_active" label="启用" valuePropName="checked"><Switch /></Form.Item>
        </Space>
        <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
      </Form>
    </Modal>
  );
}

export default function RfidReaders() {
  const opts = useRfidOptions();
  const [rows, setRows] = useState<Rec[]>([]);
  const [edit, setEdit] = useState<Rec | null | undefined>(undefined);
  const load = useCallback(() => { get('/rfid/readers').then(setRows); }, []);
  useEffect(load, [load]);
  const rotate = (r: Rec) => Modal.confirm({
    title: `重新生成 ${r.code} 的接口密钥？`, content: '旧密钥立即失效，读写器/中间件要换成新密钥才能继续推送读取。', okText: '重新生成', cancelText: '返回',
    onOk: async () => { showKey(await post(`/rfid/readers/${r.id}/rotate-key`)); load(); },
  });
  return (
    <div>
      <PageHeader title="RFID 读写器管理" sub="固定式为主：收货台（桌面）、库门（门式，带方向）、发货口；盘点用手持" extra={<><Button type="primary" icon={<PlusOutlined />} onClick={() => setEdit(null)}>新增读写器</Button><RfidLinks /></>} />
      <Table size="middle" rowKey="id" dataSource={rows} pagination={false} scroll={{ x: 'max-content' }} columns={[
        { title: '读写器', dataIndex: 'name', render: (v: string, r: Rec) => <div><b>{v}</b><div style={{ fontSize: 12, color: '#8c8c8c' }}>{r.code} · {r.reader_type_text} · {r.purpose_text}</div></div> },
        { title: '仓库 / 库位', key: 'w', render: (_: any, r: Rec) => <div>{r.warehouse_name ?? '-'}<div style={{ fontSize: 12, color: '#8c8c8c' }}>{r.location_code ? `库内 ${r.location_code}` : ''}{r.outside_location_code ? ` ↔ 外侧 ${r.outside_location_code}` : ''}</div></div> },
        { title: '方向', key: 'd', render: (_: any, r: Rec) => (r.purpose === 'GATE' ? <div>{DIR_SHORT[r.direction_mode]}{r.direction_mode === 'ANTENNA' && <div style={{ fontSize: 12, color: '#8c8c8c' }}>内 {r.inner_antenna} / 外 {r.outer_antenna}</div>}</div> : '-') },
        { title: '阈值', dataIndex: 'rssi_min_effective', render: (v: number, r: Rec) => <span>{v} dBm{r.rssi_min === null ? <div style={{ fontSize: 12, color: '#8c8c8c' }}>系统默认</div> : null}</span> },
        { title: '状态', key: 's', render: (_: any, r: Rec) => <div><OnlineBadge r={r} /><div style={{ fontSize: 12, color: '#8c8c8c' }}>{r.last_heartbeat_at ? fmtDateTime(r.last_heartbeat_at) : '从未连接'}{r.last_ip ? ` · ${r.last_ip}` : ''}</div></div> },
        { title: '密钥', key: 'k', render: (_: any, r: Rec) => (r.has_key ? <Tag className="mono">…{r.key_hint}</Tag> : <Tag color="red">未设置</Tag>) },
        { title: '操作', key: '_op', fixed: 'right' as const, render: (_: any, r: Rec) => <Space><Button size="small" onClick={() => setEdit(r)}>编辑</Button><Button size="small" icon={<KeyOutlined />} onClick={() => rotate(r)}>新密钥</Button></Space> },
      ]} />
      <Card size="small" style={{ marginTop: 12 }}>
        <Collapse ghost items={[{
          key: '1', label: '接入说明（读写器 / 中间件 → 系统）',
          children: (
            <div>
              <Alert type="info" showIcon style={{ marginBottom: 8 }} message="读写器或其中间件把读取批量推送到 POST /api/rfid/readings（请求头 X-Reader-Key = 接口密钥），每 30 秒发一次 POST /api/rfid/heartbeat。同一作业同一 EPC 只算一次；信号低于阈值的只记录不计入；库门读写器自动按时间窗口归为一次过门。详见 docs/hardware-integration.md。" />
              <pre style={{ fontSize: 12, background: '#fafafa', padding: 8 }}>{`POST /api/rfid/readings
X-Reader-Key: <接口密钥>
{ "reader_code": "RD-GATE-RAW",
  "reads": [ { "epc": "4E5501000000000000000010", "antenna": 1, "rssi": -52, "ts": "2026-11-13T09:30:00.120+08:00" },
             { "epc": "4E5501000000000000000010", "antenna": 2, "rssi": -49, "ts": "2026-11-13T09:30:01.050+08:00" } ] }
→ { "session_no": "RF261113001", "accepted": 1, "duplicates": 1, "low_rssi": 0, "unknown": [], "no_session": 0 }`}</pre>
              {opts && <Typography.Text type="secondary">当前系统默认：信号阈值 {opts.rssi_min} dBm，过门时间窗 {opts.gate_window_seconds} 秒，心跳超时 {opts.online_seconds} 秒{opts.simulate ? '；模拟读取已开启（仅演示/测试）' : ''}。</Typography.Text>}
            </div>
          ),
        }]} />
      </Card>
      {edit !== undefined && <EditModal row={edit} onClose={() => setEdit(undefined)} onDone={() => { setEdit(undefined); load(); }} />}
    </div>
  );
}
