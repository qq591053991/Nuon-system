/**
 * 交付风险卡（厂长/计划/销售）：每张未发完订单的交期、进度、缺料、阻塞原因，红黄绿。
 * 交期按未发完行中最早的行交期；缺料来自订单齐套分析（按物料去重，含未排产部分按 BOM 展开）；
 * 预计完工 = 预计齐套日 + 生产周期，晚于交期直接标红并写“预计晚 N 天”。齐套分析不可用时用后端估算（标注“估算”）。
 */
import { Card, Empty, Progress, Segmented, Space, Tag, Tooltip, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, type Rec } from '../../api/http';
import ResponsiveTable, { type RColumn } from '../../components/ResponsiveTable';
import { dictLabel } from '../../utils/dict';

type Level = 'red' | 'yellow' | 'green';
const LEVEL_TEXT: Record<Level, string> = { red: '红：会延误/已逾期', yellow: '黄：有阻塞需跟进', green: '绿：正常' };

export default function DeliveryRisk({ initialFilter, title = '交付风险', onSummary }: { initialFilter?: string; title?: string; onSummary?: (s: { red: number; yellow: number; overdue: number }) => void }) {
  const [data, setData] = useState<Rec | null>(null);
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>(['red', 'yellow', 'overdue'].includes(initialFilter ?? '') ? initialFilter! : 'all');
  const [kitSource, setKitSource] = useState<'kitting' | 'estimate'>('estimate');

  useEffect(() => {
    let alive = true;
    (async () => {
      const d: Rec = await get('/workbench/delivery-risk', undefined, true).catch(() => null);
      if (!alive) return;
      setData(d);
      const items: Rec[] = d?.items ?? [];
      setRows(items);
      setLoading(false);
      setKitSource(items.some((r) => r.shortage_source === 'kitting') || !items.length ? 'kitting' : 'estimate');
    })();
    return () => {
      alive = false;
    };
  }, []);

  const summary = useMemo(() => ({
    red: rows.filter((r) => r.level === 'red').length,
    yellow: rows.filter((r) => r.level === 'yellow').length,
    green: rows.filter((r) => r.level === 'green').length,
    overdue: rows.filter((r) => r.days_left !== null && r.days_left < 0).length,
  }), [rows]);
  useEffect(() => {
    if (!loading) onSummary?.(summary);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary, loading]);

  const shown = rows.filter((r) => filter === 'all' || (filter === 'overdue' ? r.days_left !== null && r.days_left < 0 : r.level === filter));

  const columns: RColumn<Rec>[] = [
    {
      title: '订单', dataIndex: 'no', mobile: 'title',
      render: (v, r) => (
        <Space size={6} wrap>
          <Tooltip title={LEVEL_TEXT[r.level as Level]}><span className={`risk-dot risk-${r.level}`} /></Tooltip>
          <Link to={`/sales/orders/${r.id}`} className="mono">{v}</Link>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.customer_name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '交期', dataIndex: 'delivery_date', width: 120,
      render: (v, r) => (
        <div>
          <div>{v ?? '未定'}{r.later_delivery_date && <Typography.Text type="secondary" style={{ fontSize: 12 }}>（另有 {String(r.later_delivery_date).slice(5)}）</Typography.Text>}</div>
          {r.days_left !== null && (
            <Typography.Text type={r.days_left < 0 ? 'danger' : r.days_left <= 7 ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
              {r.days_left < 0 ? `逾期 ${-r.days_left} 天` : r.days_left === 0 ? '今天到期' : `剩 ${r.days_left} 天`}
            </Typography.Text>
          )}
        </div>
      ),
    },
    {
      title: '进度', dataIndex: 'progress', width: 190,
      render: (v, r) => (
        <Tooltip title={`订单 ${r.ordered_qty}；已完工 ${r.completed_qty}；已放行可发 ${r.ready_qty}；已发 ${r.shipped_qty}${r.planned_end ? `；工单计划完工 ${r.planned_end}` : ''}${r.est_finish ? `；预计完成 ${r.est_finish}（齐套 ${r.kit_eta ?? '已齐'} + 生产周期 ${r.cycle_days} 天）` : ''}`}>
          <div style={{ minWidth: 150 }}>
            <Progress percent={v} success={{ percent: r.ship_progress }} size="small" status="normal" strokeColor={r.level === 'red' ? '#ff7875' : undefined} format={(p) => `${p}%`} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>已发 {r.shipped_qty}/{r.ordered_qty} · 完工 {r.completed_qty}</Typography.Text>
          </div>
        </Tooltip>
      ),
    },
    {
      title: '缺料', dataIndex: 'shortage_count', width: 80,
      render: (v, r) => (v > 0
        ? <Link to={`/sales/orders/${r.id}?tab=kitting`}><Tag color="red">{v} 种{r.shortage_source === 'estimate' ? '（估算）' : ''}</Tag></Link>
        : <Typography.Text type="secondary">齐套</Typography.Text>),
    },
    {
      title: '阻塞原因 / 状态', dataIndex: 'reasons',
      render: (v: string[], r) => (
        <div className="risk-reasons">
          {v.length ? v.map((x) => (
            <Tag key={x} color={x.startsWith('已逾期') || x.includes('晚于交期') || x.startsWith('预计晚') ? 'red' : x.startsWith('成品已备齐') ? 'green' : 'orange'}>{x}</Tag>
          )) : <Tag color="green">正常</Tag>}
          {r.work_orders.filter((w: Rec) => w.status !== 'CLOSED').map((w: Rec) => (
            <Link key={w.id} to={`/mes/work-orders/${w.id}`} style={{ fontSize: 12, marginRight: 8 }}>{w.no}（{dictLabel('wo_status', w.status)}）</Link>
          ))}
        </div>
      ),
    },
  ];

  return (
    <Card
      id="risk"
      size="small"
      title={<Space wrap><span>{title}</span><Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>未发完订单 {rows.length} 张</Typography.Text></Space>}
      extra={(
        <Segmented
          size="small"
          value={filter}
          onChange={(v) => setFilter(String(v))}
          options={[
            { value: 'all', label: `全部 ${rows.length}` },
            { value: 'red', label: <span><span className="risk-dot risk-red" /> {summary.red}</span> },
            { value: 'yellow', label: <span><span className="risk-dot risk-yellow" /> {summary.yellow}</span> },
            { value: 'overdue', label: `逾期 ${summary.overdue}` },
          ]}
        />
      )}
    >
      {!loading && !rows.length ? (
        <Empty description={data ? '没有未发完的订单' : '无权查看交付风险'} />
      ) : (
        <>
          <ResponsiveTable<Rec> rowKey="id" size="small" columns={columns} dataSource={shown} loading={loading} pagination={shown.length > 10 ? { pageSize: 10, size: 'small' } : false} scroll={{ x: 'max-content' }} />
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '8px 0 0' }}>
            红：已逾期、预计完成（齐套日 + 生产周期）晚于交期、3 天内到期未备货，或 7 天内到期仍缺料/未排产；黄：有阻塞需跟进。交期取未发完行中最早的行交期。
            缺料{kitSource === 'kitting' ? '来自齐套分析（含在途采购）' : '为估算（剩余需求 > 合格可用库存）'}。
          </Typography.Paragraph>
        </>
      )}
    </Card>
  );
}
