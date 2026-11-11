import { Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Switch, Table, Tooltip, message } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { del, post, put, type Rec } from '../api/http';
import { useAuth } from '../auth';
import { dictOptions } from '../utils/dict';
import { fmtDate } from '../utils/format';
import PageHeader from './PageHeader';
import RemoteSelect from './RemoteSelect';
import StatusTag from './StatusTag';
import { usePaged } from './usePaged';

export interface Field {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'textarea' | 'switch' | 'date' | 'select' | 'remote';
  dict?: string;
  options?: { value: any; label: string }[];
  /** type=remote 时的接口，如 /suppliers */
  url?: string;
  urlParams?: Rec;
  /** 列表中显示关联名称的字段，如 default_supplier_name */
  displayName?: string;
  required?: boolean;
  /** 是否在列表显示（默认 true） */
  list?: boolean;
  /** 是否在表单显示（默认 true） */
  form?: boolean;
  render?: (v: any, row: Rec) => ReactNode;
  width?: number;
  span?: number;
  help?: string;
  default?: any;
  precision?: number;
  min?: number;
  fixed?: 'left' | 'right';
}

interface Props {
  title: string;
  sub?: ReactNode;
  url: string;
  perm: string | string[];
  fields: Field[];
  /** 顶部筛选（下拉） */
  filters?: { name: string; label: string; dict?: string; options?: { value: any; label: string }[] }[];
  rowActions?: (row: Rec, reload: () => void) => ReactNode;
  extra?: ReactNode;
  scrollX?: number;
  modalWidth?: number;
  /** 提交前转换 */
  beforeSubmit?: (v: Rec, editing: Rec | null) => Rec;
  deletable?: boolean;
}

function cellRender(f: Field) {
  return (v: any, row: Rec) => {
    if (f.render) return f.render(v, row);
    if (f.type === 'switch') return v ? '是' : <span style={{ color: '#bbb' }}>否</span>;
    if (f.dict) return <StatusTag dict={f.dict} value={v} />;
    if (f.type === 'date') return fmtDate(v);
    if (f.type === 'remote') return row[f.displayName || ''] ?? '-';
    if (f.type === 'select' && f.options) return f.options.find((o) => o.value === v)?.label ?? v ?? '-';
    return v ?? '-';
  };
}

/**
 * 按字段类型渲染输入控件。
 * 注意：Form.Item 会向直接子组件注入 value / onChange / checked / id 等属性，这里必须原样转发给实际控件，
 * 否则表单与控件不绑定（编辑时不回显、提交时取不到值）。
 */
export function FieldInput({ f, ...rest }: { f: Field } & Record<string, any>) {
  switch (f.type) {
    case 'number':
      return <InputNumber style={{ width: '100%' }} precision={f.precision} min={f.min} {...rest} />;
    case 'textarea':
      return <Input.TextArea rows={2} {...rest} />;
    case 'switch':
      return <Switch {...rest} />;
    case 'date':
      return <DatePicker style={{ width: '100%' }} {...rest} />;
    case 'select':
      return <Select allowClear options={f.options || dictOptions(f.dict!)} {...rest} />;
    case 'remote':
      return <RemoteSelect url={f.url!} params={f.urlParams} {...rest} />;
    default:
      return <Input {...rest} />;
  }
}

/** 通用主数据维护页：列表 + 搜索 + 筛选 + 新增/编辑弹窗 + 删除 */
export default function CrudPage({ title, sub, url, perm, fields, filters, rowActions, extra, scrollX, modalWidth = 760, beforeSubmit, deletable = true }: Props) {
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const editable = can(...(Array.isArray(perm) ? perm : [perm]));
  const { rows, loading, setQuery, reload, pagination } = usePaged(url, { q: sp.get('q') || undefined });
  const [editing, setEditing] = useState<Rec | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [initValues, setInitValues] = useState<Rec>({});
  const [formKey, setFormKey] = useState(0);
  const formFields = fields.filter((f) => f.form !== false);

  // 弹窗关闭时内容会被销毁，表单在打开时才挂载：用 initialValues 回显（setFieldsValue 对未挂载的表单无效）
  const openForm = (row: Rec | null) => {
    const init: Rec = {};
    formFields.forEach((f) => {
      const v = row ? row[f.name] : f.default;
      init[f.name] = f.type === 'date' && v ? dayjs(v) : v;
    });
    setEditing(row);
    setInitValues(init);
    setFormKey((k) => k + 1);
    setOpen(true);
  };

  const submit = async () => {
    const v = await form.validateFields();
    formFields.forEach((f) => {
      if (f.type === 'date') v[f.name] = v[f.name] ? dayjs(v[f.name]).format('YYYY-MM-DD') : null;
      if (f.type === 'switch') v[f.name] = !!v[f.name];
    });
    const body = beforeSubmit ? beforeSubmit(v, editing) : v;
    setSaving(true);
    try {
      if (editing) await put(`${url}/${editing.id}`, body);
      else await post(url, body);
      message.success('已保存');
      setOpen(false);
      reload();
    } finally {
      setSaving(false);
    }
  };

  const columns: any[] = fields
    .filter((f) => f.list !== false)
    .map((f) => ({ title: f.label, dataIndex: f.name, key: f.name, width: f.width, fixed: f.fixed, ellipsis: f.type === 'textarea', render: cellRender(f) }));
  if (editable || rowActions) {
    columns.push({
      title: '操作',
      key: '_op',
      fixed: 'right',
      width: rowActions ? 200 : 110,
      render: (_: any, row: Rec) => (
        <Space size={4}>
          {rowActions?.(row, reload)}
          {editable && (
            <Tooltip title="编辑"><Button size="small" type="text" icon={<EditOutlined />} onClick={() => openForm(row)} /></Tooltip>
          )}
          {editable && deletable && (
            <Popconfirm title="确定删除？已被单据引用的数据不能删除，可改为停用。" onConfirm={async () => { await del(`${url}/${row.id}`); message.success('已删除'); reload(); }}>
              <Tooltip title="删除"><Button size="small" type="text" danger icon={<DeleteOutlined />} /></Tooltip>
            </Popconfirm>
          )}
        </Space>
      ),
    });
  }

  return (
    <>
      <PageHeader
        title={title}
        sub={sub}
        extra={
          <>
            {extra}
            {editable && <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm(null)}>新增</Button>}
          </>
        }
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search allowClear placeholder="编码 / 名称 搜索" defaultValue={sp.get('q') || ''} style={{ width: 260 }} onSearch={(q) => setQuery({ q })} />
          {filters?.map((f) => (
            <Select key={f.name} allowClear placeholder={f.label} style={{ width: 160 }} options={f.options || dictOptions(f.dict!)} onChange={(v) => setQuery({ [f.name]: v })} />
          ))}
          <Button icon={<ReloadOutlined />} onClick={reload} />
        </Space>
        <Table rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} scroll={{ x: scrollX || 'max-content' }} />
      </Card>
      <Modal open={open} title={(editing ? '编辑' : '新增') + title} width={modalWidth} onCancel={() => setOpen(false)} onOk={submit} confirmLoading={saving} destroyOnHidden maskClosable={false}>
        <Form form={form} layout="vertical" initialValues={initValues} key={formKey}>
          <Row gutter={16}>
            {formFields.map((f) => (
              <Col span={f.span || (f.type === 'textarea' ? 24 : 12)} key={f.name}>
                <Form.Item name={f.name} label={f.label} tooltip={f.help} valuePropName={f.type === 'switch' ? 'checked' : 'value'} rules={f.required ? [{ required: true, message: `请填写${f.label}` }] : undefined}>
                  <FieldInput f={f} />
                </Form.Item>
              </Col>
            ))}
          </Row>
        </Form>
      </Modal>
    </>
  );
}
