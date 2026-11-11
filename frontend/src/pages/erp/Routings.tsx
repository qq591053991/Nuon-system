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
import { fmtDateTime } from '../../utils/format';

export default function Routings() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const { rows, loading, setQuery, reload, pagination, query } = usePaged('/routings', { q: sp.get('q') || undefined, status: sp.get('status') || undefined });
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
      const r = await post('/routings', { ...v, operations: [] });
      message.success('工艺路线草稿已创建，请录入工序');
      nav(`/engineering/routings/${r.id}`);
    } finally {
      setSaving(false);
    }
  };

  const columns: TableColumnsType<Rec> = [
    { title: '产品编码', dataIndex: 'material_code', fixed: 'left', render: (v, r) => <Link to={`/engineering/routings/${r.id}`} className="mono">{v}</Link> },
    { title: '产品名称', dataIndex: 'material_name' },
    { title: '工艺名称', dataIndex: 'name', render: (v) => v || '-' },
    { title: '版本', dataIndex: 'version', render: (v) => <Tag>{v}</Tag> },
    { title: '状态', dataIndex: 'status', render: (v) => <StatusTag dict="eng_status" value={v} /> },
    { title: '提交人（编制）', dataIndex: 'submitted_by', render: (v) => v || '-' },
    { title: '批准人（QA）', dataIndex: 'released_by', render: (v) => v || '-' },
    { title: '批准时间', dataIndex: 'released_at', render: fmtDateTime },
    { title: '备注', dataIndex: 'remark', ellipsis: true, width: 200, render: (v) => v || '-' },
    { title: '操作', key: 'op', fixed: 'right', render: (_, r) => <Link to={`/engineering/routings/${r.id}`}>{r.status === 'DRAFT' && can('engineering') ? '编辑' : r.status === 'SUBMITTED' && can('qa') ? '审批' : '查看'}</Link> },
  ];

  return (
    <>
      <PageHeader
        title="工艺路线与测试规格"
        sub="定义每个产品的工序顺序、工作中心、关键件绑定和测试项上下限；工程师提交、QA 批准后生效，工单下达时复制当时的已发布版本。"
        extra={can('engineering') && <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新建工艺路线</Button>}
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search allowClear placeholder="产品编码 / 名称 / 工艺名称" defaultValue={sp.get('q') || ''} style={{ width: 260 }} onSearch={(q) => setQuery({ q })} />
          <Select allowClear placeholder="状态" style={{ width: 140 }} options={dictOptions('eng_status')} value={query.status} onChange={(v) => setQuery({ status: v })} />
          <Button icon={<ReloadOutlined />} onClick={reload} />
        </Space>
        <Table rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} scroll={{ x: 'max-content' }} />
      </Card>
      <Modal open={open} title="新建工艺路线" okText="创建并录入工序" onOk={create} onCancel={() => setOpen(false)} confirmLoading={saving} destroyOnHidden maskClosable={false}>
        <Alert type="info" showIcon style={{ marginBottom: 16 }} message="已有发布版本的产品请在原工艺路线上“升版”，不要重复新建。" />
        <Form form={form} layout="vertical" preserve={false} initialValues={{ version: 'A0' }}>
          <Form.Item name="material_id" label="产品 / 半成品" rules={[{ required: true, message: '请选择产品' }]}>
            <MaterialSelect onPick={(m) => m && !form.getFieldValue('name') && form.setFieldsValue({ name: `${m.code} 标准工艺` })} />
          </Form.Item>
          <Form.Item name="version" label="版本号" rules={[{ required: true, message: '请填写版本号' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="name" label="工艺名称">
            <Input placeholder="如 RL-300 标准工艺" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
