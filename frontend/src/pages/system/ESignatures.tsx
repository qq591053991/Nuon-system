import { Alert, Button, Card, Select, Space, Table, Tag, Tooltip, Typography, type TableColumnsType } from 'antd';
import { ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { Link } from 'react-router-dom';
import type { Rec } from '../../api/http';
import PageHeader from '../../components/PageHeader';
import { usePaged } from '../../components/usePaged';
import { ENTITY_OPTIONS, entityName, entityUrl } from './entities';

export default function ESignatures() {
  const { rows, loading, setQuery, reload, pagination } = usePaged('/system/esignatures', {}, 50);

  const columns: TableColumnsType<Rec> = [
    { title: '签名时间', dataIndex: 'ts', width: 160, render: (v) => <span className="mono" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'}</span> },
    {
      title: '签名人', key: 'user', width: 160,
      render: (_, r) => <span><b>{r.full_name}</b> <Typography.Text type="secondary">({r.username})</Typography.Text></span>,
    },
    {
      title: '签名含义', dataIndex: 'meaning', width: 240,
      render: (v) => <Tag color="purple" icon={<SafetyCertificateOutlined />} style={{ marginInlineEnd: 0 }}>{v}</Tag>,
    },
    { title: '对象', dataIndex: 'entity', width: 120, render: (v) => <Tooltip title={v}><span>{entityName(v)}</span></Tooltip> },
    {
      title: '单号', dataIndex: 'doc_no', width: 150,
      render: (v, r) => {
        const url = entityUrl(r.entity, r.entity_id, v);
        const text = v || `#${r.entity_id}`;
        return url ? <Link className="mono" to={url}>{text}</Link> : <span className="mono">{text}</span>;
      },
    },
    { title: '签名理由 / 意见', dataIndex: 'reason', render: (v) => v || <Typography.Text type="secondary">-</Typography.Text> },
  ];

  return (
    <>
      <PageHeader title="电子签名记录" sub="IQC 判定、NCR 处置、DHR 放行等关键质量操作的电子签名台账。" />
      <Alert
        type="info"
        showIcon
        icon={<SafetyCertificateOutlined />}
        style={{ marginBottom: 16 }}
        message="电子签名参照 21 CFR Part 11 / GMP 要求：签名时需再次输入本人密码并声明签名含义；记录与业务单据永久关联，不可删除或篡改。"
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="对象（数据表）"
            style={{ width: 240 }}
            options={ENTITY_OPTIONS}
            onChange={(v) => setQuery({ entity: v })}
          />
          <Button icon={<ReloadOutlined />} onClick={reload} />
        </Space>
        <Table rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} scroll={{ x: 'max-content' }} />
      </Card>
    </>
  );
}
