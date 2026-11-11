import { Alert, Button, Card, DatePicker, Form, Input, InputNumber, Modal, Progress, Radio, Select, Space, Table, Tag, Typography, message } from 'antd';
import { PlusOutlined, ReloadOutlined, ScanOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import { MaterialSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictOptions } from '../../utils/dict';
import { fmtDate, fmtQty, toDate } from '../../utils/format';
import { PRIORITY_OPTIONS } from './spec';

const STATUS_OPTIONS = [{ value: 'PLANNED,RELEASED,IN_PROGRESS', label: '未完工（计划/下达/生产中）' }, ...dictOptions('wo_status')];

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
  const { rows, loading, setQuery, reload, pagination } = usePaged('/work-orders', { q: sp.get('q') || undefined, status: sp.get('status') || undefined });
  const [open, setOpen] = useState(false);

  const columns: any[] = [
    {
      title: '工单号', dataIndex: 'no', fixed: 'left', width: 150,
      render: (v: string, r: Rec) => (
        <Space size={4}>
          <Link to={`/mes/work-orders/${r.id}`}>{v}</Link>
          {r.priority <= 2 && <Tag color="red">{r.priority === 1 ? '特急' : '急'}</Tag>}
        </Space>
      ),
    },
    {
      title: '产品', dataIndex: 'material_name', width: 200,
      render: (v: string, r: Rec) => (
        <div>
          <div>{v}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.material_code}</Typography.Text>
        </div>
      ),
    },
    { title: '客户', dataIndex: 'customer_name', width: 150, render: (v: string) => v || '-' },
    { title: '来源订单', dataIndex: 'so_no', width: 130, render: (v: string, r: Rec) => (v ? <Link to={`/sales/orders/${r.so_id}`}>{v}</Link> : '-') },
    { title: '批号', dataIndex: 'lot_no', width: 120, render: (v: string) => (v ? <span className="mono">{v}</span> : <Typography.Text type="secondary">下达后生成</Typography.Text>) },
    {
      title: '计划 / 完工 / 报废', key: 'qty', width: 140, align: 'right',
      render: (_: any, r: Rec) => (
        <span>
          {fmtQty(r.planned_qty)} / <b>{fmtQty(r.completed_qty)}</b> / <span style={{ color: r.scrap_qty > 0 ? '#cf1322' : undefined }}>{fmtQty(r.scrap_qty)}</span>
        </span>
      ),
    },
    { title: '进度', dataIndex: 'progress', width: 140, render: (v: number, r: Rec) => <Progress percent={v} size="small" status={r.status === 'CANCELLED' ? 'exception' : undefined} /> },
    { title: '计划开始 ~ 结束', key: 'plan', width: 200, render: (_: any, r: Rec) => `${fmtDate(r.planned_start)} ~ ${fmtDate(r.planned_end)}` },
    { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <StatusTag dict="wo_status" value={v} /> },
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
          <Select allowClear placeholder="工单状态" style={{ width: 220 }} options={STATUS_OPTIONS} defaultValue={sp.get('status') || undefined} onChange={(v) => setQuery({ status: v })} />
          <Select allowClear placeholder="DHR 状态" style={{ width: 130 }} options={dictOptions('dhr_status')} onChange={(v) => setQuery({ dhr_status: v })} />
          <Button icon={<ReloadOutlined />} onClick={reload} />
        </Space>
        <Table<Rec> rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} scroll={{ x: 'max-content' }} />
      </Card>
      <CreateWoModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
