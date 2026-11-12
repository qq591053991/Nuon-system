import { Alert, Button, Card, DatePicker, Input, Select, Space, Table, Tag, Tooltip, Typography, type TableColumnsType } from 'antd';
import { ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, type Rec } from '../../api/http';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import { usePaged } from '../../components/usePaged';
import { toDate } from '../../utils/format';
import { entityName, rowUrl } from './entities';

const fmtTs = (v?: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-');

interface Opt { value: string; label?: string; count: number }

/** 电子签名台账：中文对象名、单号可点到详情、按签名人/含义/对象/单号/日期筛选、导出 Excel */
export default function ESignatures() {
  const [sp] = useSearchParams();
  const eid = sp.get('entity_id');
  const init = {
    entity: sp.get('entity') || undefined, entity_id: eid ? Number(eid) : undefined, doc: sp.get('doc') || undefined,
    user: sp.get('user') || undefined, meaning: sp.get('meaning') || undefined,
  };
  const { rows, loading, setQuery, reload, pagination, query, onTableChange } = usePaged('/system/esignatures', init, 50);
  const [opts, setOpts] = useState<{ meanings: Opt[]; entities: Opt[] }>({ meanings: [], entities: [] });
  const [doc, setDoc] = useState(init.doc || '');
  const [user, setUser] = useState(init.user || '');

  useEffect(() => {
    get('/system/esignatures/options', undefined, true).then(setOpts).catch(() => undefined);
  }, []);

  const columns: TableColumnsType<Rec> = [
    { title: '签名时间', dataIndex: 'ts', width: 160, sorter: true, render: (v) => <span className="mono" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{fmtTs(v)}</span> },
    {
      title: '签名人', key: 'user', width: 150,
      render: (_, r) => <span style={{ whiteSpace: 'nowrap' }}><b>{r.full_name}</b> <Typography.Text type="secondary">({r.username})</Typography.Text></span>,
    },
    {
      title: '签名含义', dataIndex: 'meaning', width: 220,
      render: (v) => <Tag color="purple" icon={<SafetyCertificateOutlined />} style={{ marginInlineEnd: 0 }}>{v}</Tag>,
    },
    { title: '对象', dataIndex: 'entity', width: 110, render: (v, r) => <Tooltip title={v}><span style={{ whiteSpace: 'nowrap' }}>{r.entity_name || entityName(v)}</span></Tooltip> },
    {
      title: '单号', dataIndex: 'doc_no', width: 170,
      render: (v, r) => {
        const url = rowUrl(r);
        const text = v || `#${r.entity_id}`;
        return url ? <Tooltip title="打开单据详情"><Link className="mono" to={url}>{text}</Link></Tooltip> : <span className="mono">{text}</span>;
      },
    },
    { title: '签名理由 / 意见', dataIndex: 'reason', render: (v) => v || <Typography.Text type="secondary">-</Typography.Text> },
  ];

  return (
    <>
      <PageHeader title="电子签名记录" sub="IQC 判定、NCR 处置、DHR 放行、BOM/工艺批准等关键质量操作的电子签名台账。单号可点击打开单据。" />
      <Alert
        type="info"
        showIcon
        icon={<SafetyCertificateOutlined />}
        style={{ marginBottom: 16 }}
        message="电子签名参照 21 CFR Part 11 / GMP 要求：签名时需再次输入本人密码并声明签名含义；记录与业务单据永久关联，不可删除或篡改。"
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search allowClear placeholder="单号，如 NCR、批次号" style={{ width: 200 }} value={doc} onChange={(e) => setDoc(e.target.value)} onSearch={(v) => setQuery({ doc: v.trim() || undefined })} />
          <Input.Search allowClear placeholder="签名人姓名或账号" style={{ width: 170 }} value={user} onChange={(e) => setUser(e.target.value)} onSearch={(v) => setQuery({ user: v.trim() || undefined })} />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="签名含义"
            style={{ width: 210 }}
            value={query.meaning}
            options={opts.meanings.map((m) => ({ value: m.value, label: `${m.value}（${m.count}）` }))}
            onChange={(v) => setQuery({ meaning: v })}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="对象"
            style={{ width: 160 }}
            value={query.entity}
            options={opts.entities.map((e) => ({ value: e.value, label: `${e.label}（${e.count}）` }))}
            onChange={(v) => setQuery({ entity: v, entity_id: undefined })}
          />
          <DatePicker.RangePicker onChange={(v) => setQuery({ date_from: toDate(v?.[0]) || undefined, date_to: toDate(v?.[1]) || undefined })} />
          <Button icon={<ReloadOutlined />} onClick={reload} />
          <ExportButton
            url="/system/esignatures"
            params={query}
            filename="电子签名记录"
            title="电子签名台账"
            columns={[
              { title: '签名时间', key: 'ts', type: 'datetime', width: 20 },
              { title: '签名人', key: 'full_name', width: 12 },
              { title: '账号', key: 'username', width: 12 },
              { title: '签名含义', key: 'meaning', width: 26 },
              { title: '对象', value: (r) => r.entity_name || entityName(r.entity), width: 12 },
              { title: '单号', value: (r) => r.doc_no || `#${r.entity_id}`, width: 20 },
              { title: '签名理由/意见', key: 'reason', width: 40 },
            ]}
          />
        </Space>
        <Table rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} onChange={onTableChange} scroll={{ x: 'max-content' }} />
      </Card>
    </>
  );
}
