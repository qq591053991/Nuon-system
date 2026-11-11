/** BOM / 工艺路线的电子签名记录（编制提交、驳回、批准），供详情页“签名记录”使用 */
import { Table, Tag, Typography, type TableColumnsType } from 'antd';
import { useEffect, useState } from 'react';
import { get, type Rec } from '../../api/http';
import { fmtDateTime } from '../../utils/format';

const color = (meaning: string) => (meaning.includes('驳回') ? 'red' : meaning.includes('批准') ? 'green' : 'blue');

export function SignatureHistory({ entity, id, stamp }: { entity: 'eng_bom' | 'eng_routing'; id: number; stamp?: string }) {
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    get('/system/esignatures', { entity, entity_id: id, page_size: 100 }, true)
      .then((d) => setRows(d.items || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [entity, id, stamp]);

  const columns: TableColumnsType<Rec> = [
    { title: '时间', dataIndex: 'ts', width: 170, render: (v) => fmtDateTime(v) },
    { title: '签名含义', dataIndex: 'meaning', width: 160, render: (v) => <Tag color={color(v)}>{v}</Tag> },
    { title: '签名人', key: 'who', width: 160, render: (_, r) => <span>{r.full_name} <Typography.Text type="secondary">({r.username})</Typography.Text></span> },
    { title: '理由 / 意见', dataIndex: 'reason', render: (v) => v || '-' },
  ];
  return (
    <Table
      rowKey="id"
      size="small"
      loading={loading}
      columns={columns}
      dataSource={rows}
      pagination={false}
      locale={{ emptyText: '尚无签名记录' }}
      scroll={{ x: 'max-content' }}
    />
  );
}
