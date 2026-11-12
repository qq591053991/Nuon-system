/** 系统设置（R1）：公司信息——形式发票、采购单、出入库单等打印抬头；保存逐项记审计。仅系统管理员可修改。 */
import { Alert, Button, Card, Col, Descriptions, Form, Input, Result, Row, Space, Typography, message } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { get, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import { invalidateCompany } from '../../utils/company';
import { fmtDateTime } from '../../utils/format';

const FIELDS: { name: string; label: string; placeholder?: string; span?: number; area?: boolean }[] = [
  { name: 'name', label: '公司名称（中文）', placeholder: '如 深圳市诺恩光电医疗科技有限公司' },
  { name: 'name_en', label: '公司名称（英文）', placeholder: '如 Shenzhen Nuon Phototherapy Medical Co., Ltd.' },
  { name: 'address', label: '地址（中文）', span: 24, area: true },
  { name: 'address_en', label: '地址（英文，外销单据用）', span: 24, area: true },
  { name: 'phone', label: '电话' },
  { name: 'tax_no', label: '税号（统一社会信用代码）' },
  { name: 'bank', label: '开户行及账号', span: 24, area: true, placeholder: '如 中国银行深圳宝安支行 7xxx xxxx xxxx（美元账户另起一行）' },
  { name: 'swift', label: 'SWIFT', placeholder: '如 BKCHCNBJ45A' },
];

export default function Settings() {
  const { can } = useAuth();
  const [form] = Form.useForm();
  const [data, setData] = useState<Rec | null>(null);
  const [saving, setSaving] = useState(false);
  const admin = can('admin');

  useEffect(() => {
    get('/system/settings/company').then((d) => {
      setData(d);
      form.setFieldsValue(d);
    });
  }, [form]);

  const save = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    setSaving(true);
    try {
      const d = await put('/system/settings/company', v);
      setData(d);
      form.setFieldsValue(d);
      invalidateCompany();
      message.success('公司信息已保存，打印单据抬头即时生效');
    } finally {
      setSaving(false);
    }
  };

  if (!can('admin', 'audit', 'finance', 'sales', 'purchase')) return <Result status="403" title="403" subTitle="无权查看系统设置。" />;

  return (
    <>
      <PageHeader title="系统设置" sub="公司信息用于形式发票、采购订单、出入库单等对外单据的抬头；修改后逐项记入审计追踪。" />
      <Card title="公司信息（单据打印抬头）" extra={admin && <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>保存</Button>}>
        {!admin && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="仅系统管理员可修改，如需调整请联系管理员。" />}
        {admin ? (
          <Form form={form} layout="vertical" onFinish={save}>
            <Row gutter={16}>
              {FIELDS.map((f) => (
                <Col key={f.name} xs={24} md={f.span ?? 12}>
                  <Form.Item name={f.name} label={f.label} rules={f.name === 'name' ? [{ required: true, message: '请填写公司名称' }] : undefined} style={{ marginBottom: 12 }}>
                    {f.area ? <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} placeholder={f.placeholder} /> : <Input placeholder={f.placeholder} />}
                  </Form.Item>
                </Col>
              ))}
            </Row>
          </Form>
        ) : (
          <Descriptions bordered size="small" column={1} items={FIELDS.map((f) => ({ key: f.name, label: f.label, children: <span style={{ whiteSpace: 'pre-wrap' }}>{data?.[f.name] || '-'}</span> }))} />
        )}
        <Space style={{ marginTop: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {data?.updated_at ? `最近修改：${data.updated_by ?? ''} ${fmtDateTime(data.updated_at)}` : '尚未在系统中维护：当前显示的是服务器环境变量中的默认值（如有）。'}
          </Typography.Text>
        </Space>
      </Card>
    </>
  );
}
