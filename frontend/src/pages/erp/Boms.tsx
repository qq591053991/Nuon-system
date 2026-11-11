import { Alert, Button, Card, Form, Input, Modal, Select, Space, Table, Tag, message, type TableColumnsType } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import { MaterialSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictOptions } from '../../utils/dict';
import { fmtDate, fmtDateTime } from '../../utils/format';

export default function Boms() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const { rows, loading, setQuery, reload, pagination, query } = usePaged('/boms', { q: sp.get('q') || undefined, status: sp.get('status') || undefined });
  // 从待办跳转（?status=SUBMITTED 等）时同步筛选条件
  const urlStatus = sp.get('status') || undefined;
  const appliedStatus = useRef(urlStatus);
  useEffect(() => {
    if (appliedStatus.current === urlStatus) return;
    appliedStatus.current = urlStatus;
    setQuery({ status: urlStatus });
  }, [urlStatus, setQuery]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const create = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    setSaving(true);
    try {
      const b = await post('/boms', { ...v, lines: [] });
      message.success('BOM 草稿已创建，请录入组件');
      nav(`/engineering/boms/${b.id}`);
    } finally {
      setSaving(false);
    }
  };

  const columns: TableColumnsType<Rec> = [
    { title: '产品编码', dataIndex: 'material_code', fixed: 'left', render: (v, r) => <Link to={`/engineering/boms/${r.id}`} className="mono">{v}</Link> },
    { title: '产品名称', dataIndex: 'material_name' },
    { title: '版本', dataIndex: 'version', render: (v) => <Tag>{v}</Tag> },
    { title: '状态', dataIndex: 'status', render: (v) => <StatusTag dict="eng_status" value={v} /> },
    { title: 'ECN 编号', dataIndex: 'ecn_no', render: (v) => v || '-' },
    { title: '生效日期', dataIndex: 'effective_date', render: fmtDate },
    { title: '提交人（编制）', dataIndex: 'submitted_by', render: (v) => v || '-' },
    { title: '批准人（QA）', dataIndex: 'released_by', render: (v) => v || '-' },
    { title: '批准时间', dataIndex: 'released_at', render: fmtDateTime },
    { title: '备注', dataIndex: 'remark', ellipsis: true, width: 200, render: (v) => v || '-' },
    { title: '操作', key: 'op', fixed: 'right', render: (_, r) => <Link to={`/engineering/boms/${r.id}`}>{r.status === 'DRAFT' && can('engineering') ? '编辑' : r.status === 'SUBMITTED' && can('qa') ? '审批' : '查看'}</Link> },
  ];

  return (
    <>
      <PageHeader
        title="BOM 物料清单"
        sub="BOM 是受控文件：工程师编制并提交（电子签名），QA 审核批准（电子签名）后才生效；每个产品同一时间只有一个“已发布”版本，MRP 与工单都使用它。"
        extra={
          can('engineering') && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新建 BOM</Button>
          )
        }
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search allowClear placeholder="产品编码 / 名称 / ECN" defaultValue={sp.get('q') || ''} style={{ width: 260 }} onSearch={(q) => setQuery({ q })} />
          <Select allowClear placeholder="状态" style={{ width: 140 }} options={dictOptions('eng_status')} value={query.status} onChange={(v) => setQuery({ status: v })} />
          <Button icon={<ReloadOutlined />} onClick={reload} />
        </Space>
        <Table rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} scroll={{ x: 'max-content' }} />
      </Card>
      <Modal open={open} title="新建 BOM" okText="创建并录入组件" onOk={create} onCancel={() => setOpen(false)} confirmLoading={saving} destroyOnHidden maskClosable={false}>
        <Alert type="info" showIcon style={{ marginBottom: 16 }} message="已有发布版本的产品请在原 BOM 上“升版”，不要重复新建。" />
        <Form form={form} layout="vertical" preserve={false} initialValues={{ version: 'A0' }}>
          <Form.Item name="material_id" label="产品 / 半成品" rules={[{ required: true, message: '请选择产品' }]}>
            <MaterialSelect />
          </Form.Item>
          <Form.Item name="version" label="版本号" rules={[{ required: true, message: '请填写版本号' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="ecn_no" label="ECN / 设计文件编号">
            <Input placeholder="如 ECN-2026-001（首版可填设计转换文件号）" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
