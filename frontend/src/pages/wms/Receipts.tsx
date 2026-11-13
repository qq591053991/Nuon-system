import { Alert, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Radio, Row, Select, Space, Table, Tag, Tooltip, Typography, message, type TableColumnsType } from 'antd';
import { DeleteOutlined, FileSearchOutlined, ImportOutlined, InboxOutlined, MobileOutlined, PlusOutlined, PrinterOutlined, ReloadOutlined, TagsOutlined, WifiOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import { CustomerSelect, LocationSelect, MaterialSelect } from '../../components/RemoteSelect';
import ResponsiveTable, { useNarrow, type RColumn } from '../../components/ResponsiveTable';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictLabel, dictOptions } from '../../utils/dict';
import { fmtDate, toDate } from '../../utils/format';
import { ExpiryDate, LotLink, MaterialCell, Qty } from './common';

type ReceiptKind = 'CUSTOMER_SUPPLIED' | 'OTHER' | 'OPENING';

const KIND_OPTIONS: { value: ReceiptKind; label: string }[] = [
  { value: 'CUSTOMER_SUPPLIED', label: '客供料收货' },
  { value: 'OTHER', label: '其他入库' },
  { value: 'OPENING', label: '期初库存' },
];

const KIND_HINT: Record<ReceiptKind, string> = {
  CUSTOMER_SUPPLIED: '客户提供的物料（货主为客户）：单独记账、只能用于该客户的工单，需检验的物料收货后为“待检”并自动生成 IQC 检验单。',
  OTHER: '赠品、样品退回等非采购入库。需检验的物料收货后为“待检”并自动生成 IQC 检验单。',
  OPENING: '系统上线时录入现有库存（期初），直接记为“合格”。大批量请使用“数据导入”。',
};

/** 收货明细（入库单展开行） */
function ReceiptLines({ lines }: { lines: Rec[] }) {
  const columns: TableColumnsType<Rec> = [
    { title: '行', dataIndex: 'line_no', width: 50 },
    { title: '物料', key: 'm', render: (_, r) => <MaterialCell code={r.material_code} name={r.material_name} spec={r.material_spec} /> },
    { title: '批号', dataIndex: 'lot_no', render: (v, r) => <LotLink code={r.material_code} lot={v} /> },
    { title: '原厂批号', dataIndex: 'supplier_lot', render: (v) => (v ? <span className="mono">{v}</span> : '-') },
    { title: '数量', dataIndex: 'qty', align: 'right', render: (v, r) => <Qty qty={v} uom={r.uom} strong /> },
    { title: '库位', dataIndex: 'location_code', render: (v) => <span className="mono">{v}</span> },
    { title: '收货时状态', dataIndex: 'status', render: (v) => <StatusTag dict="stock_status" value={v} /> },
    { title: '生产日期', dataIndex: 'mfg_date', render: (v) => fmtDate(v) },
    { title: '有效期至', dataIndex: 'expiry_date', render: (v) => <ExpiryDate value={v} /> },
    {
      title: '来料检验', dataIndex: 'inspection_id',
      render: (v) => (v ? <Link to={`/quality/inspections/${v}`}><FileSearchOutlined /> 查看检验单</Link> : <Typography.Text type="secondary">免检</Typography.Text>),
    },
  ];
  return <Table rowKey="id" size="small" columns={columns} dataSource={lines} pagination={false} scroll={{ x: 'max-content' }} />;
}

/** 客供料收货 / 其他入库 / 期初 */
function ReceiptModal({ kind, onClose, onDone }: { kind: ReceiptKind | null; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm();
  const [modal, holder] = Modal.useModal();
  const [saving, setSaving] = useState(false);
  const [picked, setPicked] = useState<Record<number, Rec | undefined>>({});
  const [csLocation, setCsLocation] = useState<number | undefined>();
  const type: ReceiptKind | undefined = Form.useWatch('receipt_type', form);
  const customerId: number | undefined = Form.useWatch('customer_id', form);
  const isCs = type === 'CUSTOMER_SUPPLIED';

  // 客供料默认放客供料仓的第一个库位
  useEffect(() => {
    get('/locations', { page_size: 200, is_active: true }, true)
      .then((d) => setCsLocation((d.items as Rec[]).find((l) => l.warehouse_type === 'CUSTOMER')?.id))
      .catch(() => undefined);
  }, []);

  const firstLine = (t?: ReceiptKind) => [{ location_id: t === 'CUSTOMER_SUPPLIED' ? csLocation : undefined }];

  useEffect(() => {
    if (kind) {
      form.resetFields();
      setPicked({});
      form.setFieldsValue({ receipt_type: kind, lines: firstLine(kind) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const submit = async () => {
    const v = await form.validateFields();
    const lines = (v.lines || []).map((l: Rec) => ({
      material_id: l.material_id,
      qty: l.qty,
      location_id: l.location_id,
      lot_no: l.lot_no?.trim() || null,
      supplier_lot: l.supplier_lot?.trim() || null,
      mfg_date: toDate(l.mfg_date),
      expiry_date: toDate(l.expiry_date),
    }));
    if (!lines.length) {
      message.warning('请至少录入一行收货明细');
      return;
    }
    // 库位规则：自有/客供与仓库不符直接提示；湿敏物料放非防潮柜需确认
    const checks = await Promise.all(lines.map((l: Rec) => post('/wms/placement-check', { material_id: l.material_id, location_id: l.location_id }, true).catch(() => null)));
    const errs = checks.flatMap((c, i) => (c && !c.ok ? c.errors.map((e: string) => `第 ${i + 1} 行：${e}`) : []));
    if (errs.length) {
      message.error(errs.join('；'), 6);
      return;
    }
    const warns = checks.flatMap((c, i) => (c?.warnings?.length ? c.warnings.map((w: string) => `第 ${i + 1} 行：${w}`) : []));
    if (warns.length && !(await modal.confirm({ title: '库位确认', content: <div>{warns.map((w) => <div key={w}>{w}</div>)}<div style={{ marginTop: 8 }}>确定仍按所选库位收货？</div></div>, okText: '仍放入', cancelText: '返回修改' }))) return;
    setSaving(true);
    try {
      const rc = await post('/receipts', {
        receipt_type: v.receipt_type,
        customer_id: v.receipt_type === 'CUSTOMER_SUPPLIED' ? v.customer_id : null,
        delivery_note: v.delivery_note,
        remark: v.remark,
        lines,
        confirm_placement: warns.length > 0, // 湿敏物料放非防潮柜：上一步已确认
      });
      const iqc = (rc.lines as Rec[]).filter((l) => l.inspection_id).length;
      message.success(`入库单 ${rc.no} 已生成：${(rc.lines as Rec[]).map((l) => `${l.material_code}→${l.location_code}`).join('、')}${iqc ? `；${iqc} 行需来料检验，已自动生成 IQC 检验单` : ''}`, 6);
      modal.confirm({ title: `入库单 ${rc.no} 已生成`, content: `共 ${rc.lines.length} 个批次。是否打印批次标签贴在料盘/包装上？`, okText: '打印批次标签', cancelText: '不用',
        onOk: () => { window.open(`/wms/print/labels?receipt=${rc.id}`, '_blank'); } });
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!kind}
      title={<span><InboxOutlined style={{ marginRight: 8 }} />{isCs ? '客供料收货' : type === 'OPENING' ? '期初库存录入' : '其他入库'}</span>}
      width={1280}
      onCancel={onClose}
      onOk={submit}
      okText="确认收货"
      confirmLoading={saving}
      destroyOnHidden
      maskClosable={false}
    >
      {holder}
      <Form form={form} layout="vertical">
        <Row gutter={16}>
          <Col xs={24} md={10}>
            <Form.Item name="receipt_type" label="入库类型" rules={[{ required: true }]}>
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                options={KIND_OPTIONS}
                onChange={(e) => {
                  setPicked({});
                  form.setFieldsValue({ lines: firstLine(e.target.value) });
                }}
              />
            </Form.Item>
          </Col>
          {isCs && (
            <Col xs={24} md={14}>
              <Form.Item name="customer_id" label="客户（货主）" rules={[{ required: true, message: '客供料收货必须选择客户' }]}>
                <CustomerSelect
                  placeholder="选择提供物料的客户"
                  onChange={() => {
                    setPicked({});
                    form.setFieldsValue({ lines: firstLine('CUSTOMER_SUPPLIED') });
                  }}
                />
              </Form.Item>
            </Col>
          )}
        </Row>
        {type && <Alert type="info" showIcon style={{ marginBottom: 16 }} message={KIND_HINT[type]} />}
        <Row gutter={16}>
          <Col xs={24} md={8}>
            <Form.Item name="delivery_note" label="送货单号">
              <Input placeholder="对方送货单/快递单号" />
            </Form.Item>
          </Col>
          <Col xs={24} md={16}>
            <Form.Item name="remark" label="备注">
              <Input />
            </Form.Item>
          </Col>
        </Row>

        <Form.List name="lines">
          {(fields, { add, remove }) => {
            const columns: TableColumnsType<(typeof fields)[number]> = [
              {
                title: '物料', key: 'material', width: 240,
                render: (_, f) => (
                  <Form.Item name={[f.name, 'material_id']} rules={[{ required: true, message: '请选择物料' }]} style={{ margin: 0 }}>
                    <MaterialSelect
                      style={{ width: 240 }}
                      disabled={isCs && !customerId}
                      placeholder={isCs && !customerId ? '请先选择客户' : '输入编码或名称搜索'}
                      params={isCs ? { owner_customer_id: customerId, is_active: true } : { is_active: true }}
                      onPick={(r) => {
                        setPicked((p) => ({ ...p, [f.key]: r }));
                        // 物料默认库位 / 建议库位自动带出
                        if (r?.id) {
                          get('/wms/suggest-location', { material_id: r.id }, true).then((sug) => {
                            if (sug?.id) form.setFieldValue(['lines', f.name, 'location_id'], sug.id);
                          }).catch(() => undefined);
                        }
                      }}
                    />
                  </Form.Item>
                ),
              },
              {
                title: '数量', key: 'qty', width: 100,
                render: (_, f) => (
                  <Form.Item name={[f.name, 'qty']} rules={[{ required: true, message: '必填' }]} style={{ margin: 0 }}>
                    <InputNumber min={0.0001} style={{ width: 100 }} placeholder={picked[f.key]?.uom || '数量'} />
                  </Form.Item>
                ),
              },
              {
                title: '库位', key: 'loc', width: 180,
                render: (_, f) => (
                  <Form.Item name={[f.name, 'location_id']} rules={[{ required: true, message: '请选择库位' }]} style={{ margin: 0 }}>
                    <LocationSelect style={{ width: 180 }} placeholder="收货库位" />
                  </Form.Item>
                ),
              },
              {
                title: '批号', key: 'lot', width: 120,
                render: (_, f) => (
                  <Form.Item name={[f.name, 'lot_no']} style={{ margin: 0 }}>
                    <Input style={{ width: 120 }} placeholder="留空自动生成" />
                  </Form.Item>
                ),
              },
              {
                title: '原厂批号', key: 'slot', width: 110,
                render: (_, f) => (
                  <Form.Item name={[f.name, 'supplier_lot']} style={{ margin: 0 }}>
                    <Input style={{ width: 110 }} placeholder="包装上的批号" />
                  </Form.Item>
                ),
              },
              {
                title: '生产日期', key: 'mfg', width: 120,
                render: (_, f) => (
                  <Form.Item name={[f.name, 'mfg_date']} style={{ margin: 0 }}>
                    <DatePicker style={{ width: 120 }} />
                  </Form.Item>
                ),
              },
              {
                title: <Tooltip title="留空时按“生产日期 + 物料保质期”自动计算">有效期至</Tooltip>, key: 'exp', width: 120,
                render: (_, f) => (
                  <Form.Item name={[f.name, 'expiry_date']} style={{ margin: 0 }}>
                    <DatePicker style={{ width: 120 }} placeholder={picked[f.key]?.shelf_life_days ? '自动计算' : '选择日期'} />
                  </Form.Item>
                ),
              },
              {
                title: '收货后', key: 'hint', width: 60,
                render: (_, f) => {
                  const m = picked[f.key];
                  if (!m) return null;
                  return m.iqc_required && type !== 'OPENING'
                    ? <Tooltip title="该物料需来料检验，收货后自动生成 IQC 检验单"><Tag color="gold">待检</Tag></Tooltip>
                    : <Tag color="green">合格</Tag>;
                },
              },
              {
                title: '', key: 'op', width: 32,
                render: (_, f) => (
                  <Button type="text" danger size="small" icon={<DeleteOutlined />} disabled={fields.length <= 1} onClick={() => remove(f.name)} />
                ),
              },
            ];
            return (
              <>
                <Table rowKey="key" size="small" columns={columns} dataSource={fields} pagination={false} scroll={{ x: 'max-content' }} />
                <Button
                  type="dashed"
                  block
                  icon={<PlusOutlined />}
                  style={{ marginTop: 8 }}
                  disabled={isCs && !customerId}
                  onClick={() => {
                    // 新行沿用上一行库位，减少重复选择
                    const last = (form.getFieldValue('lines') || []).slice(-1)[0];
                    add({ location_id: last?.location_id ?? (isCs ? csLocation : undefined) });
                  }}
                >
                  添加一行
                </Button>
              </>
            );
          }}
        </Form.List>
      </Form>
    </Modal>
  );
}

export default function Receipts() {
  const { can } = useAuth();
  const nav = useNavigate();
  const narrow = useNarrow();
  const [sp] = useSearchParams();
  const { rows, loading, query, setQuery, reload, pagination, onTableChange } = usePaged('/receipts', { q: sp.get('q') || undefined, receipt_type: sp.get('receipt_type') || undefined });
  const [kind, setKind] = useState<ReceiptKind | null>(null);

  const columns: RColumn[] = [
    { title: '入库单号', dataIndex: 'no', width: 130, sorter: true, fixed: narrow ? undefined : 'left', mobile: 'title', render: (v) => <b className="mono">{v}</b> },
    { title: '类型', dataIndex: 'receipt_type', width: 110, render: (v) => <StatusTag dict="receipt_type" value={v} /> },
    { title: '供应商 / 客户', dataIndex: 'partner_name', width: 200, ellipsis: true, render: (v) => v || '-' },
    { title: '采购订单', dataIndex: 'po_no', width: 130, render: (v, r) => (v ? <Link to={`/purchase/orders/${r.po_id}`}>{v}</Link> : '-') },
    { title: '生产工单', dataIndex: 'wo_no', width: 130, render: (v, r) => (v ? <Link to={`/mes/work-orders/${r.wo_id}`}>{v}</Link> : '-') },
    { title: '收货日期', dataIndex: 'receipt_date', width: 110, render: (v) => fmtDate(v) },
    { title: '送货单号', dataIndex: 'delivery_note', width: 130, render: (v) => v || '-' },
    { title: '行数', key: 'cnt', width: 70, align: 'right', render: (_, r) => r.lines?.length ?? 0 },
    {
      title: '待检行', key: 'iqc', width: 80, align: 'right',
      render: (_, r) => {
        const n = (r.lines as Rec[] | undefined)?.filter((l) => l.inspection_id).length || 0;
        return n ? <Tag color="gold" style={{ marginInlineEnd: 0 }}>{n}</Tag> : '-';
      },
    },
    { title: '经办人', dataIndex: 'created_by', width: 90, mobile: 'hidden' },
    { title: '备注', dataIndex: 'remark', width: 180, ellipsis: true, mobile: 'hidden', render: (v) => v || '-' },
    {
      title: '打印', key: '_op', width: 150,
      render: (_, r) => (
        <Space size={4}>
          <Button size={narrow ? 'large' : 'small'} icon={<PrinterOutlined />} onClick={(e) => { e.stopPropagation(); window.open(`/wms/print/receipt/${r.id}`, '_blank'); }}>入库单</Button>
          <Button size={narrow ? 'large' : 'small'} icon={<TagsOutlined />} onClick={(e) => { e.stopPropagation(); window.open(`/wms/print/labels?receipt=${r.id}`, '_blank'); }}>标签</Button>
        </Space>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="收货入库"
        sub="所有入库单（采购收货、完工入库、客供料、期初）。点击行首“+”展开明细。"
        extra={can('wms') && (
          <Space wrap>
            <Button type="primary" icon={<WifiOutlined />} onClick={() => nav('/wms/rfid/receive')}>RFID 收货台（采购）</Button>
            <Button icon={<MobileOutlined />} onClick={() => nav('/wms/pda/receive')}>条码收货（兜底）</Button>
            <Button icon={<InboxOutlined />} onClick={() => (narrow ? nav('/wms/pda/receive?mode=cs') : setKind('CUSTOMER_SUPPLIED'))}>客供料收货</Button>
            {!narrow && <Button icon={<ImportOutlined />} onClick={() => setKind('OTHER')}>其他入库 / 期初</Button>}
          </Space>
        )}
      />
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="采购收货请在采购订单中操作；完工入库请在生产工单中操作。需检验物料收货后为“待检”，IQC 判定合格后才能领用。"
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search allowClear placeholder="入库单号 / 送货单号" defaultValue={sp.get('q') || ''} style={{ width: 240 }} onSearch={(q) => setQuery({ q: q.trim() })} />
          <Select allowClear placeholder="入库类型" style={{ width: 150 }} defaultValue={sp.get('receipt_type') || undefined} options={dictOptions('receipt_type')} onChange={(v) => setQuery({ receipt_type: v })} />
          <Button icon={<ReloadOutlined />} onClick={reload} />
          <ExportButton url="/receipts" params={query} filename="入库明细" columns={[
            { title: '入库单号', key: 'no' }, { title: '类型', value: (r) => dictLabel('receipt_type', r.receipt_type) }, { title: '供应商/客户', key: 'partner_name' },
            { title: '采购订单', key: 'po_no' }, { title: '生产工单', key: 'wo_no' }, { title: '收货日期', key: 'receipt_date', type: 'date' },
            { title: '送货单号', key: 'delivery_note' }, { title: '行数', value: (r) => r.lines?.length ?? 0, type: 'number' },
            { title: '明细', value: (r) => (r.lines as Rec[] | undefined)?.map((l) => `${l.material_code} ${l.lot_no} ×${l.qty} @${l.location_code}`).join('；') },
            { title: '经办人', key: 'created_by' }, { title: '备注', key: 'remark' },
          ]} />
        </Space>
        <ResponsiveTable
          rowKey="id"
          size="middle"
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={pagination}
          onChange={onTableChange}
          scroll={{ x: 'max-content' }}
          expandable={{ expandedRowRender: (r) => <ReceiptLines lines={r.lines || []} />, rowExpandable: (r) => !!r.lines?.length }}
        />
      </Card>
      <ReceiptModal kind={kind} onClose={() => setKind(null)} onDone={() => { setKind(null); reload(); }} />
    </>
  );
}
