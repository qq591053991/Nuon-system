import { Button, DatePicker, Drawer, Form, Input, Select, Table, Tag, message } from 'antd';
import { SafetyOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import CrudPage, { type Field } from '../../components/CrudPage';
import { fmtDate, fmtQty } from '../../utils/format';

const active: Field = { name: 'is_active', label: '启用', type: 'switch', default: true, width: 70 };

export function Customers() {
  return (
    <CrudPage
      title="客户（品牌方/注册人）"
      sub="代工模式下，产品注册证属于客户（医疗器械注册人）。质量协议到期前系统会提醒。"
      url="/customers"
      perm="master"
      fields={[
        { name: 'code', label: '客户编码', required: true, width: 100, fixed: 'left' },
        { name: 'name', label: '客户名称', required: true, width: 220 },
        { name: 'short_name', label: '简称', width: 110 },
        { name: 'country', label: '国家/地区', width: 90 },
        { name: 'mah_name', label: '注册人/备案人', width: 200, help: '医疗器械注册人（MAH）名称' },
        { name: 'contact', label: '联系人', width: 100 },
        { name: 'phone', label: '电话', width: 120 },
        { name: 'email', label: '邮箱', list: false },
        { name: 'currency', label: '结算币别', type: 'select', options: ['CNY', 'USD', 'EUR'].map((v) => ({ value: v, label: v })), default: 'CNY', width: 90 },
        { name: 'payment_terms_days', label: '账期(天)', type: 'number', default: 30, width: 90 },
        { name: 'quality_agreement_no', label: '质量协议编号', width: 140 },
        { name: 'quality_agreement_expiry', label: '质量协议有效期', type: 'date', width: 130 },
        { name: 'tax_no', label: '税号', list: false },
        { name: 'address', label: '地址', type: 'textarea', list: false },
        active,
        { name: 'remark', label: '备注', type: 'textarea', list: false },
      ]}
      filters={[{ name: 'is_active', label: '启用状态', options: [{ value: true, label: '启用' }, { value: false, label: '停用' }] }]}
    />
  );
}

export function Suppliers() {
  return (
    <CrudPage
      title="供应商 / 合格供方名录"
      sub="只有“合格供方”且资质在有效期内的供应商才能审批采购订单（GMP 采购控制）。"
      url="/suppliers"
      perm="master"
      fields={[
        { name: 'code', label: '供应商编码', required: true, width: 100, fixed: 'left' },
        { name: 'name', label: '供应商名称', required: true, width: 220 },
        { name: 'short_name', label: '简称', width: 110 },
        { name: 'category', label: '供应类别', width: 130 },
        { name: 'status', label: '合格状态', type: 'select', dict: 'supplier_status', default: 'PENDING', width: 100 },
        {
          name: 'qualification_expiry', label: '资质有效期', type: 'date', width: 120,
          render: (v) => (v ? <span style={{ color: dayjs(v).isBefore(dayjs().add(60, 'day')) ? '#fa541c' : undefined }}>{fmtDate(v)}</span> : '-'),
        },
        { name: 'iso13485', label: 'ISO 13485', type: 'switch', width: 90 },
        { name: 'contact', label: '联系人', width: 100 },
        { name: 'phone', label: '电话', width: 120 },
        { name: 'email', label: '邮箱', list: false },
        { name: 'currency', label: '结算币别', type: 'select', options: ['CNY', 'USD'].map((v) => ({ value: v, label: v })), default: 'CNY', list: false },
        { name: 'payment_terms_days', label: '账期(天)', type: 'number', default: 30, list: false },
        { name: 'address', label: '地址', type: 'textarea', list: false },
        active,
        { name: 'remark', label: '备注', type: 'textarea', list: false },
      ]}
      filters={[{ name: 'status', label: '合格状态', dict: 'supplier_status' }]}
    />
  );
}

export function Materials() {
  return (
    <CrudPage
      title="物料主数据"
      sub="原材料、半成品、成品、包材统一编码。客供料请设置“货主客户”；成品需维护注册证号与 UDI-DI。"
      url="/materials"
      perm="master"
      modalWidth={900}
      fields={[
        { name: 'code', label: '物料编码', required: true, width: 140, fixed: 'left' },
        { name: 'name', label: '物料名称', required: true, width: 180 },
        { name: 'spec', label: '规格型号', width: 200 },
        { name: 'category', label: '物料类别', type: 'select', dict: 'material_category', default: 'RAW', required: true, width: 90 },
        { name: 'uom', label: '库存单位', default: 'PCS', width: 80, help: '库存、领料、BOM 用量、收货均按此单位' },
        {
          name: 'purchase_uom', label: '采购单位', width: 140, help: '供应商按此单位报价/发货（如 LED 按“卷”）；为空表示按库存单位采购',
          render: (v, r) => (v && v !== r.uom ? `1 ${v} = ${fmtQty(r.purchase_factor)} ${r.uom}` : '-'),
        },
        { name: 'purchase_factor', label: '换算率（1 采购单位 = ? 库存单位）', type: 'number', default: 1, min: 0, list: false, help: '如 1 卷 = 4000 PCS 填 4000；采购订单按采购单位下单时自动换算为库存单位' },
        { name: 'default_supplier_id', label: '默认供应商', type: 'remote', url: '/suppliers', displayName: 'default_supplier_name', width: 150 },
        { name: 'owner_customer_id', label: '货主客户（客供料）', type: 'remote', url: '/customers', displayName: 'owner_customer_name', width: 130, help: '设置后为客供料：只能客供料收货、只能用于该客户工单、不参与采购' },
        { name: 'customer_id', label: '所属品牌客户（成品）', type: 'remote', url: '/customers', displayName: 'customer_name', list: false },
        { name: 'safety_stock', label: '安全库存', type: 'number', default: 0, width: 90 },
        { name: 'lead_time_days', label: '提前期(天)', type: 'number', default: 7, list: false },
        { name: 'min_order_qty', label: '最小订货量', type: 'number', default: 0, list: false },
        { name: 'std_cost', label: '标准成本', type: 'number', default: 0, width: 90 },
        { name: 'shelf_life_days', label: '保质期(天)', type: 'number', list: false },
        { name: 'lot_control', label: '批次管理', type: 'switch', default: true, list: false },
        { name: 'serial_control', label: '序列号管理', type: 'switch', default: false, width: 90 },
        { name: 'iqc_required', label: '来料需检验', type: 'switch', default: true, width: 90 },
        { name: 'aql', label: 'AQL', type: 'number', default: 1.0, list: false, help: 'GB/T 2828.1 接收质量限，如 0.65 / 1.0 / 2.5' },
        { name: 'wavelength_nm', label: '波长(nm)', width: 80 },
        { name: 'msl_level', label: '湿敏等级 MSL', list: false },
        { name: 'esd_sensitive', label: '静电敏感 ESD', type: 'switch', list: false },
        { name: 'model', label: '产品型号', list: false },
        { name: 'registration_no', label: '注册证/备案号', list: false },
        { name: 'device_class', label: '管理类别', type: 'select', dict: 'device_class', list: false },
        { name: 'gtin', label: 'UDI-DI（GTIN-14）', list: false, help: '系统会校验 GS1 校验位' },
        { name: 'sn_prefix', label: '序列号前缀', list: false },
        active,
        { name: 'remark', label: '备注', type: 'textarea', list: false },
      ]}
      beforeSubmit={(v) => ({ ...v, purchase_uom: v.purchase_uom?.trim() || null, purchase_factor: v.purchase_factor ?? 1 })}
      filters={[
        { name: 'category', label: '物料类别', dict: 'material_category' },
        { name: 'serial_control', label: '序列号管理', options: [{ value: true, label: '是' }, { value: false, label: '否' }] },
      ]}
    />
  );
}

export function WorkCenters() {
  return (
    <CrudPage
      title="工作中心 / 产线"
      url="/work-centers"
      perm="master"
      fields={[
        { name: 'code', label: '编码', required: true, width: 120 },
        { name: 'name', label: '名称', required: true, width: 200 },
        { name: 'description', label: '说明', type: 'textarea' },
        active,
      ]}
    />
  );
}

function CalibrationDrawer({ eq, onClose }: { eq: Rec | null; onClose: () => void }) {
  const { can } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [form] = Form.useForm();
  const load = () => eq && get(`/equipment/${eq.id}/calibrations`).then(setRows);
  useEffect(() => {
    setRows([]);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eq?.id]);
  return (
    <Drawer open={!!eq} width={640} title={`校准记录 - ${eq?.code} ${eq?.name}`} onClose={onClose} destroyOnHidden>
      {can('master', 'qa') && (
        <Form form={form} layout="inline" style={{ marginBottom: 16, rowGap: 8 }}
          onFinish={async (v) => {
            await post(`/equipment/${eq!.id}/calibrations`, { ...v, calibration_date: dayjs(v.calibration_date).format('YYYY-MM-DD') });
            message.success('已登记，设备校准有效期已更新');
            form.resetFields();
            load();
          }}>
          <Form.Item name="calibration_date" rules={[{ required: true, message: '校准日期' }]}><DatePicker placeholder="校准日期" /></Form.Item>
          <Form.Item name="result" initialValue="PASS"><Select style={{ width: 90 }} options={[{ value: 'PASS', label: '合格' }, { value: 'FAIL', label: '不合格' }]} /></Form.Item>
          <Form.Item name="certificate_no"><Input placeholder="证书编号" style={{ width: 130 }} /></Form.Item>
          <Form.Item name="agency"><Input placeholder="校准机构" style={{ width: 130 }} /></Form.Item>
          <Button type="primary" htmlType="submit">登记</Button>
        </Form>
      )}
      <Table rowKey="id" size="small" pagination={false} dataSource={rows} columns={[
        { title: '校准日期', dataIndex: 'calibration_date' },
        { title: '结果', dataIndex: 'result', render: (v) => <Tag color={v === 'PASS' ? 'green' : 'red'}>{v === 'PASS' ? '合格' : '不合格'}</Tag> },
        { title: '证书编号', dataIndex: 'certificate_no' },
        { title: '机构', dataIndex: 'agency' },
        { title: '下次到期', dataIndex: 'next_due_date' },
      ]} />
    </Drawer>
  );
}

export function EquipmentPage() {
  const [cal, setCal] = useState<Rec | null>(null);
  return (
    <>
      <CrudPage
        title="设备与检测仪器"
        sub="光谱辐照度计、安规测试仪等计量器具需定期校准；校准过期的仪器系统禁止用于报工。"
        url="/equipment"
        perm="master"
        fields={[
          { name: 'code', label: '设备编码', required: true, width: 120, fixed: 'left' },
          { name: 'name', label: '设备名称', required: true, width: 200 },
          { name: 'model', label: '型号', width: 100 },
          { name: 'serial_no', label: '出厂编号', list: false },
          { name: 'equipment_type', label: '类型', type: 'select', dict: 'equipment_type', default: 'PRODUCTION', width: 100, render: (v) => ({ PRODUCTION: '生产设备', TEST: '检测仪器', AGING: '老化设备' } as Rec)[v] || v },
          { name: 'work_center_id', label: '工作中心', type: 'remote', url: '/work-centers', displayName: 'work_center_name', width: 120 },
          { name: 'status', label: '状态', type: 'select', dict: 'equipment_status', default: 'NORMAL', width: 90 },
          { name: 'calibration_required', label: '需校准', type: 'switch', width: 80 },
          { name: 'calibration_cycle_days', label: '校准周期(天)', type: 'number', list: false },
          { name: 'last_calibration_date', label: '上次校准', type: 'date', width: 110 },
          {
            name: 'next_calibration_date', label: '校准有效期至', type: 'date', width: 130,
            render: (v, r) => {
              if (!r.calibration_required) return '-';
              if (!v) return <Tag color="red">未校准</Tag>;
              const d = dayjs(v);
              if (d.isBefore(dayjs(), 'day')) return <Tag color="red">{fmtDate(v)} 已过期</Tag>;
              if (d.isBefore(dayjs().add(30, 'day'))) return <Tag color="orange">{fmtDate(v)} 即将到期</Tag>;
              return fmtDate(v);
            },
          },
          { name: 'remark', label: '备注', type: 'textarea', list: false },
        ]}
        filters={[{ name: 'status', label: '状态', dict: 'equipment_status' }, { name: 'equipment_type', label: '类型', dict: 'equipment_type' }]}
        rowActions={(row) => (row.calibration_required ? <Button size="small" icon={<SafetyOutlined />} onClick={() => setCal(row)}>校准</Button> : null)}
      />
      <CalibrationDrawer eq={cal} onClose={() => setCal(null)} />
    </>
  );
}

export function Warehouses() {
  return (
    <CrudPage
      title="仓库"
      url="/warehouses"
      perm="master"
      fields={[
        { name: 'code', label: '仓库编码', required: true, width: 120 },
        { name: 'name', label: '仓库名称', required: true, width: 200 },
        { name: 'warehouse_type', label: '仓库类型', type: 'select', dict: 'warehouse_type', default: 'RAW', width: 120, render: (v) => ({ RAW: '原材料仓', FG: '成品仓', CUSTOMER: '客供料仓', REJECT: '不合格品仓', WIP: '线边仓' } as Rec)[v] || v },
        { name: 'address', label: '地址' },
        active,
      ]}
    />
  );
}

export function Locations() {
  return (
    <CrudPage
      title="库位"
      sub="MSL 湿敏 LED 请放在“防潮柜”类型库位；不合格品区的库存不会被领料分配。"
      url="/locations"
      perm="master"
      fields={[
        { name: 'code', label: '库位编码', required: true, width: 120 },
        { name: 'name', label: '库位名称', width: 200 },
        { name: 'warehouse_id', label: '所属仓库', type: 'remote', url: '/warehouses', displayName: 'warehouse_name', required: true, width: 160 },
        { name: 'location_type', label: '库位类型', type: 'select', dict: 'location_type', default: 'STORAGE', width: 120, render: (v) => ({ STORAGE: '存储', DRY_CABINET: '防潮柜', REJECT: '不合格品区', STAGING: '暂存/线边' } as Rec)[v] || v },
        active,
      ]}
    />
  );
}
