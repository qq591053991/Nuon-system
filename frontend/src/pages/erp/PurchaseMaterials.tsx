/** 物料采购属性：采购自己维护采购单位与换算率、默认供应商、采购提前期、最小订购量（不需要找工程师） */
import { Alert, AutoComplete, Button, Card, Col, Form, Input, InputNumber, Modal, Row, Select, Space, Table, Tag, Typography, message, type TableColumnsType } from 'antd';
import { EditOutlined, ReloadOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import { usePaged } from '../../components/usePaged';
import { dictLabel } from '../../utils/dict';
import { fmtDate, fmtQty } from '../../utils/format';
import { QualifiedSupplierSelect } from './purchaseKit';

const CATS = [
  { value: 'RAW', label: '原材料' }, { value: 'PACKAGING', label: '包材' }, { value: 'CONSUMABLE', label: '辅料/耗材' }, { value: 'SEMI', label: '半成品（外协）' },
];
const UOMS = ['卷', '盘', '包', '袋', '盒', '箱', '托', '板', '捆', 'KG'].map((v) => ({ value: v }));

function EditModal({ mat, onClose, onSaved }: { mat: Rec | null; onClose: () => void; onSaved: () => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const uom: string | undefined = Form.useWatch('purchase_uom', form);
  const factor: number | undefined = Form.useWatch('purchase_factor', form);
  return (
    <Modal
      open={!!mat}
      title={mat ? `采购属性 · ${mat.code} ${mat.name}` : ''}
      okText="保存"
      onCancel={onClose}
      confirmLoading={saving}
      destroyOnHidden
      maskClosable={false}
      width={640}
      onOk={async () => {
        const v = await form.validateFields().catch(() => null);
        if (!v) return;
        setSaving(true);
        try {
          await put(`/purchase/materials/${mat!.id}`, {
            purchase_uom: v.purchase_uom || null,
            purchase_factor: v.purchase_uom ? v.purchase_factor : 1,
            default_supplier_id: v.default_supplier_id ?? null,
            lead_time_days: v.lead_time_days,
            min_order_qty: v.min_order_qty,
          });
          message.success(`${mat!.code} 采购属性已保存`);
          onSaved();
        } finally {
          setSaving(false);
        }
      }}
    >
      {mat && (
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          initialValues={{
            purchase_uom: mat.purchase_uom || undefined, purchase_factor: mat.purchase_uom ? mat.purchase_factor : undefined,
            default_supplier_id: mat.default_supplier_id ?? undefined, lead_time_days: mat.lead_time_days, min_order_qty: mat.min_order_qty,
          }}
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message={`库存单位：${mat.uom}。设置采购单位后，下单默认按整${uom || '包装'}录入（不出现小数），系统自动换算为库存单位收货；已下单的订单不受影响。`}
          />
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="purchase_uom" label="采购单位（包装单位）" extra="留空 = 按库存单位采购">
                <AutoComplete allowClear options={UOMS} placeholder="如 卷、包、箱（可直接输入）" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="purchase_factor"
                label={`换算率：1 ${uom || '采购单位'} = ? ${mat.uom}`}
                rules={[{ required: !!uom, message: '请填写每包装的库存单位数量' }]}
                extra={uom && factor ? `例：下单 2 ${uom} = ${fmtQty(2 * factor)} ${mat.uom}` : undefined}
              >
                <InputNumber min={0} style={{ width: '100%' }} disabled={!uom} placeholder="如 4000" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="default_supplier_id" label="默认供应商（MRP 转采购单时使用）">
                <QualifiedSupplierSelect allowClear />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="lead_time_days" label="采购提前期（天）" rules={[{ required: true, message: '请填写' }]}>
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="min_order_qty" label={`最小订购量（${mat.uom}）`}>
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      )}
    </Modal>
  );
}

export default function PurchaseMaterials() {
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const { rows, loading, setQuery, reload, pagination, query, onTableChange } = usePaged('/purchase/materials', { q: sp.get('q') || undefined }, 20);
  const [editing, setEditing] = useState<Rec | null>(null);
  const editable = can('purchase', 'master');

  const columns: TableColumnsType<Rec> = [
    { title: '物料编码', dataIndex: 'code', sorter: true, fixed: 'left', render: (v) => <span className="mono">{v}</span> },
    { title: '名称', dataIndex: 'name', sorter: true },
    { title: '规格', dataIndex: 'spec', ellipsis: true, width: 200, render: (v) => v || '-' },
    { title: '类别', dataIndex: 'category', render: (v) => dictLabel('material_category', v) },
    { title: '库存单位', dataIndex: 'uom' },
    {
      title: '采购单位', dataIndex: 'purchase_uom',
      render: (v, r) => (v ? <Tag color="purple">1 {v} = {fmtQty(r.purchase_factor)} {r.uom}</Tag> : <Typography.Text type="secondary">按{r.uom}</Typography.Text>),
    },
    { title: '默认供应商', dataIndex: 'default_supplier_name', ellipsis: true, width: 200, render: (v) => v || <Typography.Text type="warning">未设置</Typography.Text> },
    { title: '提前期', dataIndex: 'lead_time_days', sorter: true, align: 'right', render: (v) => `${v} 天` },
    { title: '最小订购量', dataIndex: 'min_order_qty', align: 'right', render: (v, r) => (v ? `${fmtQty(v)} ${r.uom}` : '-') },
    {
      title: '最近采购价', key: 'last',
      render: (_, r) =>
        r.last_po_no ? (
          <div>
            {r.last_purchase_uom ? `${r.last_purchase_price}/${r.last_purchase_uom}（= ${r.last_price}/${r.uom}）` : `${r.last_price}/${r.uom}`} {r.last_currency}
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
              <Link to={`/purchase/orders/${r.last_po_id}`}>{r.last_po_no}</Link> · {r.last_supplier_name} · {fmtDate(r.last_order_date)}
            </Typography.Text>
          </div>
        ) : (
          '-'
        ),
    },
    { title: '标准成本', dataIndex: 'std_cost', align: 'right', render: (v) => (v ? Number(v) : '-') },
  ];
  if (editable) {
    columns.push({
      title: '操作', key: '_op', fixed: 'right', width: 90,
      render: (_, r) => <Button type="link" size="small" icon={<EditOutlined />} onClick={() => setEditing(r)}>编辑</Button>,
    });
  }

  return (
    <>
      <PageHeader
        title="物料采购属性"
        sub="采购单位与换算率（如 LED 按卷，1 卷 = 4000 PCS）、默认供应商、采购提前期、最小订购量由采购维护，MRP 与下单自动使用；其余物料资料仍由工程/主数据维护。"
        extra={
          <ExportButton
            url="/purchase/materials"
            params={{ ...query, sort: undefined, order: undefined }}
            filename="物料采购属性"
            columns={[
              { title: '物料编码', key: 'code', width: 18 }, { title: '名称', key: 'name', width: 20 }, { title: '规格', key: 'spec', width: 24 },
              { title: '库存单位', key: 'uom' }, { title: '采购单位', key: 'purchase_uom' }, { title: '换算率', key: 'purchase_factor', type: 'number' },
              { title: '默认供应商', key: 'default_supplier_name', width: 28 }, { title: '提前期(天)', key: 'lead_time_days', type: 'number' },
              { title: '最小订购量', key: 'min_order_qty', type: 'number' }, { title: '最近采购单价(库存单位)', key: 'last_price', type: 'number' },
              { title: '最近采购单', key: 'last_po_no' }, { title: '最近供应商', key: 'last_supplier_name', width: 28 },
            ]}
          />
        }
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search allowClear placeholder="物料编码 / 名称 / 规格" defaultValue={sp.get('q') || ''} style={{ width: 260 }} onSearch={(q) => setQuery({ q })} />
          <Select allowClear placeholder="类别" style={{ width: 160 }} options={CATS} onChange={(v) => setQuery({ category: v })} />
          <QualifiedSupplierSelect style={{ width: 260 }} placeholder="按默认供应商筛选" onChange={(v) => setQuery({ supplier_id: v })} />
          <Select
            allowClear
            placeholder="采购单位"
            style={{ width: 160 }}
            options={[{ value: '1', label: '已设采购单位' }]}
            onChange={(v) => setQuery({ has_purchase_uom: v })}
          />
          <Button icon={<ReloadOutlined />} onClick={reload} />
        </Space>
        <Table rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} onChange={onTableChange} scroll={{ x: 'max-content' }} />
      </Card>
      <EditModal
        mat={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
    </>
  );
}
