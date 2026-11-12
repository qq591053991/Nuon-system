import { Alert, Button, Card, DatePicker, Form, Input, InputNumber, Modal, Popover, Progress, Radio, Select, Space, Table, Tag, Typography, message } from 'antd';
import { PlusOutlined, ReloadOutlined, ScanOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import ExportButton from '../../components/ExportButton';
import { MaterialSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictLabel, dictOptions } from '../../utils/dict';
import { fmtDate, fmtQty, toDate } from '../../utils/format';
import { PRIORITY_OPTIONS } from './spec';

const STATUS_OPTIONS = [{ value: 'PLANNED,RELEASED,IN_PROGRESS', label: '未完工（计划/下达/生产中）' }, ...dictOptions('wo_status')];
const KIT_OPTIONS = [{ value: 'SHORT', label: '缺料（不齐套）' }, { value: 'KITTED', label: '已齐套' }];

/** 齐套列：未完工工单显示齐套/缺料，点开看缺哪些料、预计何时到 */
function KitCell({ k, id }: { k: Rec | null | undefined; id: number }) {
  if (!k) return <Typography.Text type="secondary">-</Typography.Text>;
  if (k.kitted) return <Tag color="green">齐套</Tag>;
  return (
    <Popover
      title={`缺料 ${k.shortage_count} 项${k.eta ? `，预计 ${fmtDate(k.eta)} 齐套` : ''}`}
      content={
        <div style={{ maxWidth: 360 }}>
          {(k.shortages || []).map((s: Rec) => (
            <div key={s.material_code}>
              <span className="mono">{s.material_code}</span> {s.material_name} 缺 <b style={{ color: '#cf1322' }}>{fmtQty(s.shortage)}</b> {s.uom}
              <Typography.Text type="secondary">{s.eta ? ` · 预计 ${fmtDate(s.eta)}` : ' · 无在途'}</Typography.Text>
            </div>
          ))}
          <Link to={`/mes/work-orders/${id}?tab=kitting`}>查看齐套明细 →</Link>
        </div>
      }
    >
      <Tag color={k.eta ? 'orange' : 'red'} style={{ cursor: 'pointer' }}>缺 {k.shortage_count} 项{k.eta ? ` · ${fmtDate(k.eta).slice(5)}` : ''}</Tag>
    </Popover>
  );
}

/** 新建工单弹窗 */
function CreateWoModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [form] = Form.useForm();
  const [category, setCategory] = useState<'FINISHED' | 'SEMI'>('FINISHED');
  const [product, setProduct] = useState<Rec | undefined>();
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = await form.validateFields();
    const [s, e] = v.range || [];
    setSaving(true);
    try {
      const r = await post('/work-orders', {
        material_id: v.material_id,
        planned_qty: v.planned_qty,
        planned_start: toDate(s),
        planned_end: toDate(e),
        priority: v.priority,
        remark: v.remark,
      });
      message.success(`工单 ${r.no} 已创建（计划状态），确认无误后请【下达】`);
      onClose();
      nav(`/mes/work-orders/${r.id}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title="新建生产工单"
      width={640}
      okText="创建工单"
      onOk={submit}
      confirmLoading={saving}
      onCancel={onClose}
      destroyOnHidden
      maskClosable={false}
      afterOpenChange={(o) => {
        if (o) {
          form.resetFields();
          setProduct(undefined);
        }
      }}
    >
      <Alert type="info" showIcon style={{ marginBottom: 16 }} message="来自销售订单的工单建议在 MRP 中一键生成；这里用于补单、试产或半成品工单。" />
      <Form form={form} layout="vertical" initialValues={{ priority: 3 }}>
        <Form.Item label="产品类别">
          <Radio.Group
            value={category}
            optionType="button"
            options={[{ value: 'FINISHED', label: '成品' }, { value: 'SEMI', label: '半成品' }]}
            onChange={(e) => {
              setCategory(e.target.value);
              form.setFieldValue('material_id', undefined);
              setProduct(undefined);
            }}
          />
        </Form.Item>
        <Form.Item name="material_id" label="生产的产品" rules={[{ required: true, message: '请选择产品' }]}>
          <MaterialSelect params={{ category, is_active: true }} onPick={setProduct} />
        </Form.Item>
        {product && (
          <Alert
            type={product.serial_control ? 'success' : 'warning'}
            style={{ marginBottom: 16 }}
            message={
              product.serial_control
                ? `序列号管理产品：下达时将按数量逐台生成序列号与 UDI${product.gtin ? `（UDI-DI ${product.gtin}）` : ''}，工位逐台扫码报工。`
                : '非序列号产品：按批次管理，在工单中批量报工。'
            }
          />
        )}
        <Space size={16} wrap style={{ width: '100%' }}>
          <Form.Item name="planned_qty" label="计划数量" rules={[{ required: true, message: '请填写数量' }]}>
            <InputNumber min={1} precision={product?.serial_control ? 0 : 4} style={{ width: 180 }} suffix={product?.uom || 'PCS'} />
          </Form.Item>
          <Form.Item name="priority" label="优先级">
            <Select options={PRIORITY_OPTIONS} style={{ width: 140 }} />
          </Form.Item>
        </Space>
        <Form.Item name="range" label="计划开始 ~ 计划完成">
          <DatePicker.RangePicker style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="remark" label="备注">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export default function WorkOrders() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  // 列表数据走齐套接口（筛选与 /work-orders 相同，另带齐套列与 kitting=SHORT 缺料筛选）
  const { rows, loading, setQuery, reload, pagination, query, onTableChange } = usePaged('/kitting/work-order-list', {
    q: sp.get('q') || undefined,
    status: sp.get('status') || (sp.get('kitting') ? 'PLANNED,RELEASED,IN_PROGRESS' : undefined),
    kitting: sp.get('kitting') || undefined,
    so_id: sp.get('so_id') || undefined,
  });
  const [open, setOpen] = useState(false);

  // 1366 宽度下先看到：工单、产品、状态、齐套、数量、计划日期；客户/订单/批号放后面
  const columns: any[] = [
    {
      title: '工单号', dataIndex: 'no', fixed: 'left', width: 140, sorter: true,
      render: (v: string, r: Rec) => (
        <Space size={4}>
          <Link to={`/mes/work-orders/${r.id}`}>{v}</Link>
          {r.priority <= 2 && <Tag color="red">{r.priority === 1 ? '特急' : '急'}</Tag>}
        </Space>
      ),
    },
    {
      title: '产品', dataIndex: 'material_name', width: 190,
      render: (v: string, r: Rec) => (
        <div>
          <div>{v}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.material_code}</Typography.Text>
        </div>
      ),
    },
    { title: '状态', dataIndex: 'status', width: 80, sorter: true, render: (v: string) => <StatusTag dict="wo_status" value={v} /> },
    { title: '齐套', key: 'kitting', width: 120, render: (_: any, r: Rec) => <KitCell k={r.kitting} id={r.id} /> },
    {
      title: '计划 / 完工 / 报废', key: 'qty', width: 130, align: 'right',
      render: (_: any, r: Rec) => (
        <span>
          {fmtQty(r.planned_qty)} / <b>{fmtQty(r.completed_qty)}</b> / <span style={{ color: r.scrap_qty > 0 ? '#cf1322' : undefined }}>{fmtQty(r.scrap_qty)}</span>
        </span>
      ),
    },
    { title: '计划开始 ~ 结束', dataIndex: 'planned_start', width: 190, sorter: true, render: (_: any, r: Rec) => `${fmtDate(r.planned_start)} ~ ${fmtDate(r.planned_end)}` },
    { title: '进度', dataIndex: 'progress', width: 130, render: (v: number, r: Rec) => <Progress percent={v} size="small" status={r.status === 'CANCELLED' ? 'exception' : undefined} /> },
    { title: '来源订单', dataIndex: 'so_no', width: 120, render: (v: string, r: Rec) => (v ? <Link to={`/sales/orders/${r.so_id}`}>{v}</Link> : <Typography.Text type="secondary">{r.source === 'MRP' ? 'MRP' : '-'}</Typography.Text>) },
    { title: '客户', dataIndex: 'customer_name', width: 150, ellipsis: true, render: (v: string) => v || '-' },
    { title: '批号', dataIndex: 'lot_no', width: 120, render: (v: string) => (v ? <span className="mono">{v}</span> : <Typography.Text type="secondary">下达后生成</Typography.Text>) },
    {
      title: 'DHR 状态', dataIndex: 'dhr_status', width: 100,
      render: (v: string, r: Rec) => (['COMPLETED', 'CLOSED'].includes(r.status) || r.received_qty > 0 ? <StatusTag dict="dhr_status" value={v} /> : '-'),
    },
  ];

  return (
    <>
      <PageHeader
        title="生产工单"
        sub="工单下达时锁定 BOM / 工艺版本并生成批号、序列号与 UDI；完工入库后需 QA 审核 DHR 放行才能发货。"
        extra={
          <>
            <Button icon={<ScanOutlined />} onClick={() => nav('/mes/station')}>工位终端</Button>
            {can('plan') && <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新建工单</Button>}
          </>
        }
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search allowClear placeholder="工单号 / 批号 / 产品" defaultValue={sp.get('q') || ''} style={{ width: 260 }} onSearch={(q) => setQuery({ q })} />
          <Select allowClear placeholder="工单状态" style={{ width: 220 }} options={STATUS_OPTIONS} defaultValue={query.status || undefined} onChange={(v) => setQuery({ status: v })} />
          <Select allowClear placeholder="DHR 状态" style={{ width: 130 }} options={dictOptions('dhr_status')} onChange={(v) => setQuery({ dhr_status: v })} />
          <Select
            allowClear
            placeholder="齐套情况"
            style={{ width: 150 }}
            options={KIT_OPTIONS}
            defaultValue={sp.get('kitting') || undefined}
            onChange={(v) => setQuery({ kitting: v })}
          />
          <Button icon={<ReloadOutlined />} onClick={reload} />
          <ExportButton
            url="/kitting/work-order-list"
            params={query}
            filename="生产工单"
            columns={[
              { title: '工单号', key: 'no' },
              { title: '产品编码', key: 'material_code' },
              { title: '产品', key: 'material_name' },
              { title: '客户', key: 'customer_name' },
              { title: '来源订单', key: 'so_no' },
              { title: '批号', key: 'lot_no' },
              { title: '计划数量', key: 'planned_qty', type: 'number' },
              { title: '完工数量', key: 'completed_qty', type: 'number' },
              { title: '报废数量', key: 'scrap_qty', type: 'number' },
              { title: '计划开始', key: 'planned_start', type: 'date' },
              { title: '计划结束', key: 'planned_end', type: 'date' },
              { title: '状态', value: (r) => dictLabel('wo_status', r.status) },
              { title: '齐套', value: (r) => (!r.kitting ? '' : r.kitting.kitted ? '齐套' : `缺 ${r.kitting.shortage_count} 项`) },
              { title: '预计齐套', value: (r) => r.kitting?.eta ?? '' },
            ]}
          />
        </Space>
        {sp.get('kitting') === 'SHORT' && (
          <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="当前只看缺料的未完工工单：库存按 已开工 → 已下达 → 计划开工日 先后分配，点“缺 N 项”查看缺哪些料、在途采购单和预计到货。" />
        )}
        <Table<Rec> rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} onChange={onTableChange} scroll={{ x: 'max-content' }} />
      </Card>
      <CreateWoModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
