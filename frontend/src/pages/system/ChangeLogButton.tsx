import { Button, Drawer, Space, Table, Typography, type TableColumnsType } from 'antd';
import { HistoryOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Rec } from '../../api/http';
import { useAuth } from '../../auth';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { CompactDiff, FullDiff } from './AuditLogs';
import { changeLogUrl, entityName } from './entities';

function ChangeLogList({ entity, id }: { entity: string; id: number }) {
  const { rows, loading, pagination } = usePaged('/system/audit-logs', { entity, entity_id: id }, 20);
  const columns: TableColumnsType<Rec> = [
    { title: '时间', dataIndex: 'ts', width: 150, render: (v) => <span className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{dayjs(v).format('YYYY-MM-DD HH:mm:ss')}</span> },
    { title: '操作人', dataIndex: 'full_name', width: 90, render: (v, r) => <Typography.Text title={r.username}>{v || r.username}</Typography.Text> },
    { title: '动作', dataIndex: 'action', width: 70, render: (v) => <StatusTag dict="audit_action" value={v} /> },
    { title: '变更内容', key: 'c', render: (_, r) => <CompactDiff row={r} /> },
  ];
  return (
    <Table rowKey="id" size="small" tableLayout="fixed" columns={columns} dataSource={rows} loading={loading} pagination={pagination}
      expandable={{ expandedRowRender: (r) => <FullDiff row={r} />, columnWidth: 32 }} />
  );
}

/**
 * 详情页“变更记录”按钮（评审 E-08）：抽屉内显示该单据的审计追踪（谁、何时、改了什么，明细逐行差异）。
 * 用法：<ChangeLogButton entity="eng_bom" id={bom.id} />；任何能查看该单据的人都可看（后端按单张单据放行）。
 */
export default function ChangeLogButton({ entity, id, text = '变更记录', size = 'middle' }: { entity: string; id?: number | null; text?: string; size?: 'small' | 'middle' }) {
  const [open, setOpen] = useState(false);
  const { can } = useAuth();
  if (!id) return null;
  return (
    <>
      <Button size={size} icon={<HistoryOutlined />} className="no-print" onClick={() => setOpen(true)}>{text}</Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        width={Math.min(900, window.innerWidth)}
        title={`${entityName(entity)}变更记录`}
        destroyOnHidden
        extra={can('audit', 'admin') && <Link to={changeLogUrl(entity, id)}>在审计追踪中打开</Link>}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>审计追踪由系统自动记录，不可修改或删除。明细行（如 BOM 子项）的修改逐行显示“修改前 → 修改后”。</Typography.Text>
          <ChangeLogList entity={entity} id={id} />
        </Space>
      </Drawer>
    </>
  );
}
