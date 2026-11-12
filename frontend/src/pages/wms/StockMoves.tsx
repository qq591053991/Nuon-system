import { Alert, Button, Card, DatePicker, Input, Select, Space, Typography } from 'antd';
import { ArrowRightOutlined, LockOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import ExportButton from '../../components/ExportButton';
import PageHeader from '../../components/PageHeader';
import ResponsiveTable, { useNarrow, type RColumn } from '../../components/ResponsiveTable';
import StatusTag from '../../components/StatusTag';
import { usePaged } from '../../components/usePaged';
import { dictLabel, dictOptions } from '../../utils/dict';
import { fmtDateTime, toDate } from '../../utils/format';
import { CsTag, LotLink, MaterialCell, Qty, refLink } from './common';

const dash = <span style={{ color: '#ccc' }}>-</span>;

/** 起止：A → B（任一侧为空时只显示一侧） */
function FromTo({ from, to }: { from: ReactNode | null; to: ReactNode | null }) {
  if (!from && !to) return dash;
  return (
    <Space size={4} style={{ whiteSpace: 'nowrap' }}>
      {from || dash}
      <ArrowRightOutlined style={{ color: '#bfbfbf', fontSize: 11 }} />
      {to || dash}
    </Space>
  );
}

export default function StockMoves() {
  const [sp] = useSearchParams();
  const narrow = useNarrow();
  const { rows, loading, query, setQuery, reload, pagination } = usePaged('/stock-moves', {
    q: sp.get('q') || undefined, lot_no: sp.get('lot_no') || undefined, ref_no: sp.get('ref_no') || undefined, move_type: sp.get('move_type') || undefined,
  }, 50);

  const columns: RColumn[] = [
    { title: '时间', dataIndex: 'ts', width: 140, fixed: narrow ? undefined : 'left', mobile: 'subtitle', render: (v) => fmtDateTime(v) },
    { title: '业务类型', dataIndex: 'move_type', width: 110, render: (v) => <StatusTag dict="move_type" value={v} /> },
    {
      title: '物料', key: 'material', width: 220, mobile: 'title',
      render: (_, r) => <MaterialCell code={r.material_code} name={r.material_name} spec={r.material_spec} extra={r.owner_customer_id ? <CsTag /> : undefined} />,
    },
    { title: '批号', dataIndex: 'lot_no', width: 130, render: (v, r) => <LotLink code={r.material_code} lot={v} /> },
    { title: '数量', dataIndex: 'qty', width: 100, align: 'right', render: (v, r) => <Qty qty={v} uom={r.uom} strong /> },
    {
      title: '库位', key: 'loc', width: 170,
      render: (_, r) => (
        <FromTo
          from={r.from_location_code ? <span className="mono">{r.from_location_code}</span> : null}
          to={r.to_location_code ? <span className="mono">{r.to_location_code}</span> : null}
        />
      ),
    },
    {
      title: '质量状态', key: 'status', width: 220,
      render: (_, r) => (
        <FromTo
          from={r.from_status ? <StatusTag dict="stock_status" value={r.from_status} /> : null}
          to={r.to_status ? <StatusTag dict="stock_status" value={r.to_status} /> : null}
        />
      ),
    },
    { title: '来源单据', dataIndex: 'ref_no', width: 130, render: (v, r) => refLink(r.ref_type, r.ref_id, v) },
    { title: '操作人', dataIndex: 'username', width: 90, mobile: 'hidden' },
    { title: '备注', dataIndex: 'remark', width: 220, ellipsis: true, mobile: 'hidden', render: (v) => v || dash },
  ];

  return (
    <>
      <PageHeader title="库存流水" sub="每一次库存变动的完整台账：收货、检验判定、领料、完工、放行、发货、调拨、盘点。" />
      <Alert
        type="info"
        showIcon
        icon={<LockOutlined />}
        style={{ marginBottom: 16 }}
        message="库存流水只增不改：系统自动记录，任何人都不能修改或删除；如需更正请通过盘点调整等业务单据，流水中会留下完整痕迹。"
      />
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search allowClear placeholder="物料编码 / 批号 / 单据号" defaultValue={sp.get('q') || ''} style={{ width: 260 }} onSearch={(q) => setQuery({ q: q.trim() })} />
          <Select allowClear showSearch optionFilterProp="label" placeholder="业务类型" style={{ width: 150 }} defaultValue={sp.get('move_type') || undefined} options={dictOptions('move_type')} onChange={(v) => setQuery({ move_type: v })} />
          <DatePicker.RangePicker
            onChange={(v) => setQuery({ date_from: toDate(v?.[0]) || undefined, date_to: toDate(v?.[1]) || undefined })}
          />
          <Button icon={<ReloadOutlined />} onClick={reload} />
          <ExportButton url="/stock-moves" params={query} filename="库存流水" columns={[
            { title: '时间', key: 'ts', type: 'datetime' }, { title: '业务类型', value: (r) => dictLabel('move_type', r.move_type) },
            { title: '物料编码', key: 'material_code' }, { title: '物料名称', key: 'material_name' }, { title: '批号', key: 'lot_no' },
            { title: '数量', key: 'qty', type: 'number' }, { title: '单位', key: 'uom' }, { title: '从库位', key: 'from_location_code' }, { title: '到库位', key: 'to_location_code' },
            { title: '原状态', value: (r) => dictLabel('stock_status', r.from_status) }, { title: '新状态', value: (r) => dictLabel('stock_status', r.to_status) },
            { title: '来源单据', key: 'ref_no' }, { title: '操作人', key: 'username' }, { title: '备注', key: 'remark' },
          ]} />
        </Space>
        <ResponsiveTable rowKey="id" size="middle" columns={columns} dataSource={rows} loading={loading} pagination={pagination} scroll={{ x: 'max-content' }} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>提示：点击批号可查看该批次从来料到客户的完整追溯链。</Typography.Text>
      </Card>
    </>
  );
}
