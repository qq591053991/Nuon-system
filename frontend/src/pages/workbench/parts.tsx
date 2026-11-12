/** 岗位工作台的各个区块（G1）：KPI 卡、待办、待我拍板、财务应收应付、管理员账号安全、操作员首页、仓管九宫格、厂长图表与下钻。 */
import { Alert, Badge, Button, Card, Col, Empty, List, Modal, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import {
  ArrowRightOutlined, AuditOutlined, BarcodeOutlined, CarOutlined, ContainerOutlined, DatabaseOutlined, ExportOutlined, ImportOutlined,
  InboxOutlined, RollbackOutlined, ScanOutlined, SwapOutlined, ToolOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import * as echarts from 'echarts';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { get, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import ResponsiveTable, { type RColumn } from '../../components/ResponsiveTable';
import { dictLabel } from '../../utils/dict';
import { fmtDateTime, fmtMoney } from '../../utils/format';
import { canPath, firstRoute, useGo } from './links';

/** ECharts 封装（支持点击下钻） */
export function ClickChart({ option, height = 260, onClick }: { option: echarts.EChartsOption; height?: number; onClick?: (p: any) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts>();
  const cb = useRef(onClick);
  cb.current = onClick;
  useEffect(() => {
    if (!el.current) return;
    inst.current = echarts.init(el.current);
    inst.current.on('click', (p) => cb.current?.(p));
    const ro = new ResizeObserver(() => inst.current?.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      inst.current?.dispose();
    };
  }, []);
  useEffect(() => {
    inst.current?.setOption(option, true);
  }, [option]);
  return <div ref={el} style={{ width: '100%', height, cursor: onClick ? 'pointer' : undefined }} />;
}

const fmtVal = (v: any, suffix?: string) => {
  if (typeof v !== 'number') return v ?? '-';
  const money = !!suffix && /^[A-Z]{3}$/.test(suffix);
  return v.toLocaleString('zh-CN', { minimumFractionDigits: money ? 2 : 0, maximumFractionDigits: 2 });
};

/** KPI 卡片：点击跳到带筛选的列表；#xxx 交给 onHash（工作台内下钻） */
export function KpiGrid({ kpis, onHash, limit }: { kpis: Rec[]; onHash?: (h: string) => void; limit?: number }) {
  const go = useGo();
  const [all, setAll] = useState(false);
  // 窄屏只先显示最关键的几项（异常的优先），其余点“更多指标”展开
  const shown = !limit || all || kpis.length <= limit
    ? kpis
    : [...kpis.filter((k) => k.level === 'error' || k.level === 'warning'), ...kpis.filter((k) => !(k.level === 'error' || k.level === 'warning'))].slice(0, limit);
  return (
    <Row gutter={[12, 12]}>
      {shown.map((k) => {
        const click = k.path ? () => (k.path.startsWith('#') || k.path.startsWith('/?') ? onHash?.(k.path) : go(k.path)) : undefined;
        return (
          <Col key={k.key} xs={12} sm={8} lg={6} xl={4}>
            <Card size="small" hoverable={!!click} onClick={click} className={`kpi-card ${click ? 'clickable' : ''} ${k.level ? `lv-${k.level}` : ''}`}>
              <div className="kpi-title"><span>{k.title}</span>{click && <ArrowRightOutlined style={{ fontSize: 11, color: '#bfbfbf' }} />}</div>
              <div className="kpi-value">{fmtVal(k.value, k.suffix)}{k.suffix && <small>{k.suffix}</small>}</div>
              {k.hint && <div className="kpi-hint">{k.hint}</div>}
            </Card>
          </Col>
        );
      })}
      {shown.length < kpis.length && (
        <Col span={24}><Button block type="dashed" onClick={() => setAll(true)}>更多指标（共 {kpis.length} 项）</Button></Col>
      )}
    </Row>
  );
}

/** 我的待办卡片 */
export function TodoCard({ todos, title = '我的待办', onHash }: { todos: Rec[]; title?: string; onHash?: (h: string) => void }) {
  const go = useGo();
  return (
    <Card title={title} size="small" style={{ height: '100%' }}>
      {todos.length ? (
        <List
          dataSource={todos}
          renderItem={(t) => (
            <List.Item
              className="todo-item"
              onClick={() => (t.path.startsWith('/?') || t.path.startsWith('#') ? onHash?.(t.path) : go(t.path))}
              actions={[<Button type="link" key="go" style={{ padding: 0 }}>去处理 <ArrowRightOutlined /></Button>]}
            >
              <Space>
                <Tag color={t.level === 'error' ? 'red' : t.level === 'warning' ? 'orange' : 'volcano'} style={{ minWidth: 32, textAlign: 'center' }}>{t.count}</Tag>
                {t.title}
              </Space>
            </List.Item>
          )}
        />
      ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待办" />}
    </Card>
  );
}

/** 岗位快捷按钮（按菜单权限裁剪） */
export interface Shortcut { label: string; path: string; icon?: ReactNode; primary?: boolean }
export function useShortcuts(list: Shortcut[]) {
  const { can } = useAuth();
  return list.filter((s) => s.path.startsWith('#') || canPath(s.path, can));
}

/** 财务：逾期应收、7 天内到期应付 */
export function FinancePanel({ f }: { f: Rec }) {
  const go = useGo();
  const base = f.base_currency || 'CNY';
  const cols = (kind: 'AR' | 'AP'): RColumn<Rec>[] => [
    { title: '单号', dataIndex: 'no', mobile: 'title', render: (v) => <a className="mono" onClick={() => go(`/finance?tab=${kind}&q=${encodeURIComponent(v)}`)}>{v}</a> },
    { title: kind === 'AR' ? '客户' : '供应商', dataIndex: 'partner', mobile: 'subtitle' },
    { title: '未结金额', dataIndex: 'balance', align: 'right', render: (v, r) => fmtMoney(v, r.currency) },
    { title: `折合${base}`, dataIndex: 'base_balance', align: 'right', render: (v) => (v == null ? <Tag color="orange">缺汇率</Tag> : fmtMoney(v, base)) },
    { title: '到期日', dataIndex: 'due_date' },
    { title: kind === 'AR' ? '逾期天数' : '状态', dataIndex: 'days_overdue', render: (v) => (v > 0 ? <Tag color="red">逾期 {v} 天</Tag> : <Tag color="gold">即将到期</Tag>) },
  ];
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={12}>
        <Card size="small" title={`逾期应收（${f.ar_overdue.length}）`} extra={<a onClick={() => go('/finance?tab=AR&overdue=1')}>全部</a>}>
          {f.ar_overdue.length ? <ResponsiveTable rowKey="id" size="small" columns={cols('AR')} dataSource={f.ar_overdue} pagination={false} scroll={{ x: 'max-content' }} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有逾期应收" />}
        </Card>
      </Col>
      <Col xs={24} xl={12}>
        <Card size="small" title={`7 天内到期应付（${f.ap_due.length}）`} extra={<a onClick={() => go('/finance?tab=AP&due_within=7')}>全部</a>}>
          {f.ap_due.length ? <ResponsiveTable rowKey="id" size="small" columns={cols('AP')} dataSource={f.ap_due} pagination={false} scroll={{ x: 'max-content' }} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="7 天内没有到期应付" />}
        </Card>
      </Col>
      {f.missing_rates?.length > 0 && (
        <Col span={24}>
          <Alert type="warning" showIcon message={`缺少 ${f.missing_rates.join('、')} → ${base} 汇率：相关单据未折算本位币`} action={<Button size="small" onClick={() => go('/master/exchange-rates')}>去维护汇率</Button>} />
        </Col>
      )}
    </Row>
  );
}

/** 管理员：账号安全 */
export function SecurityPanel({ s }: { s: Rec }) {
  const go = useGo();
  const userList = (rows: Rec[], extra?: (r: Rec) => ReactNode) => (
    <List
      size="small"
      dataSource={rows.slice(0, 8)}
      locale={{ emptyText: '无' }}
      renderItem={(u) => (
        <List.Item>
          <Space wrap>
            <b className="mono">{u.username}</b>
            <span>{u.full_name}</span>
            {u.department && <Typography.Text type="secondary">{u.department}</Typography.Text>}
            {extra?.(u)}
          </Space>
        </List.Item>
      )}
    />
  );
  return (
    <Row gutter={[16, 16]}>
      {s.demo_password?.length > 0 && (
        <Col span={24}>
          <Alert
            type="error"
            showIcon
            message={`仍有 ${s.demo_password.length} 个账号使用公开的演示密码`}
            description="上线前请为这些账号重置密码（本人首次登录须修改）或停用，否则任何人都可冒用其电子签名。"
            action={<Button danger size="small" onClick={() => go('/system/users?status=initial_password')}>去处理</Button>}
          />
        </Col>
      )}
      <Col xs={24} lg={8}>
        <Card size="small" title={`已锁定账号（${s.locked.length}）`} extra={<a onClick={() => go('/system/users?status=locked')}>去解锁</a>}>
          {userList(s.locked, (u) => <Tag color="red">锁定至 {dayjs(u.locked_until).format('HH:mm')}</Tag>)}
        </Card>
      </Col>
      <Col xs={24} lg={8}>
        <Card size="small" title={`待分配角色（${s.no_role.length}）`} extra={<a onClick={() => go('/system/users?status=no_role')}>去分配</a>}>
          {userList(s.no_role)}
        </Card>
      </Col>
      <Col xs={24} lg={8}>
        <Card size="small" title={`初始密码未改（${s.initial_password.length}）`} extra={<a onClick={() => go('/system/users?status=initial_password')}>查看</a>}>
          {userList(s.initial_password, (u) => (
            <>
              {u.demo_password && <Tag color="red">公开演示密码</Tag>}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{u.last_login_at ? `最近登录 ${dayjs(u.last_login_at).format('MM-DD HH:mm')}` : '从未登录'}</Typography.Text>
            </>
          ))}
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card size="small" title={`近 24 小时登录失败（${s.failed_24h}）`} extra={<a onClick={() => go('/system/audit?entity=sys_login')}>审计追踪</a>}>
          <List
            size="small"
            dataSource={s.recent_failed}
            locale={{ emptyText: '无' }}
            renderItem={(r: Rec) => (
              <List.Item>
                <Space wrap><Typography.Text type="secondary">{fmtDateTime(r.ts)}</Typography.Text><b className="mono">{r.username}</b><span>{r.reason}</span></Space>
              </List.Item>
            )}
          />
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card size="small" title="审计追踪完整性" extra={<a onClick={() => go('/system/audit')}>去校验</a>}>
          <Row gutter={16}>
            <Col span={8}><Statistic title="已封存（哈希链）" value={s.sealed} /></Col>
            <Col span={8}><Statistic title="待封存" value={s.unsealed} /></Col>
            <Col span={8}><Statistic title="账号（启用/全部）" value={`${s.total - s.inactive}/${s.total}`} /></Col>
          </Row>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '8px 0 0' }}>审计记录每分钟自动接入哈希链；在“审计追踪”页可一键校验是否被篡改。</Typography.Paragraph>
        </Card>
      </Col>
    </Row>
  );
}

/** 操作员首页：大按钮进工位 + 今日报工 + 上岗资质 + 生产中工单 */
export function OperatorHome({ o, kpis }: { o: Rec; kpis?: ReactNode }) {
  const go = useGo();
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Button type="primary" block icon={<ScanOutlined style={{ fontSize: 28 }} />} style={{ height: 96, fontSize: 22 }} onClick={() => go('/mes/station')}>进入工位终端</Button>
      {kpis}
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card size="small" title="我的上岗资质">
            <List
              size="small"
              dataSource={o.quals}
              locale={{ emptyText: '暂无有效资质，请联系 QA 登记' }}
              renderItem={(q: Rec) => (
                <List.Item>
                  <Space><Tag color="purple">{q.op_code === '*' ? '全部工序' : q.op_code}</Tag>{dictLabel('qual_level', q.level)}</Space>
                  <Typography.Text type={q.expires_at && dayjs(q.expires_at).diff(dayjs(), 'day') <= 30 ? 'warning' : 'secondary'}>{q.expires_at ? `有效至 ${q.expires_at}` : '长期有效'}</Typography.Text>
                </List.Item>
              )}
            />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small" title="生产中的工单">
            <List
              size="small"
              dataSource={o.active_wos}
              locale={{ emptyText: '暂无' }}
              renderItem={(w: Rec) => (
                <List.Item>
                  <Space direction="vertical" size={0}>
                    <b className="mono">{w.no}</b>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{w.material_code} {w.material_name}</Typography.Text>
                  </Space>
                  <span>{w.completed_qty}/{w.planned_qty}</span>
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

/** 仓管九宫格：大按钮 + 待办数（PDA 单手可点） */
export function WarehouseGrid({ todos, narrow }: { todos: Rec[]; narrow: boolean }) {
  const go = useGo();
  const { can } = useAuth();
  const [putaway, setPutaway] = useState<number | null>(null);
  useEffect(() => {
    // G7 待上架清单（接口未上线时不显示数字）
    get('/wms/putaway', undefined, true)
      .then((r: any) => setPutaway(Array.isArray(r) ? r.length : Array.isArray(r?.items) ? r.items.length : typeof r?.total === 'number' ? r.total : null))
      .catch(() => setPutaway(null));
  }, []);
  const n = (key: string) => todos.find((t) => t.key === key)?.count ?? 0;
  // 窄屏（PDA）优先进 G7 的 PDA 作业页（竖排、扫码连续作业），电脑进列表页
  const pick = (pda: string[], pc: string[]) => (narrow ? firstRoute(...pda, ...pc) : firstRoute(...pc));
  const tiles: { label: string; icon: ReactNode; path: string; count?: number | null; sub?: string }[] = [
    { label: '采购收货', icon: <ImportOutlined />, path: pick(['/wms/pda/receive'], ['/wms/receipts']), count: n('po_receive'), sub: '扫采购单收货' },
    { label: '上架/调拨', icon: <SwapOutlined />, path: pick(['/wms/pda/putaway'], ['/wms/putaway', '/wms/stock']), count: putaway, sub: '扫批号→扫库位' },
    { label: '拣料领料', icon: <ExportOutlined />, path: pick(['/wms/pda/pick'], ['/wms/issues?status=DRAFT']), count: n('issue'), sub: '按单拣料、过账' },
    { label: '发货出库', icon: <CarOutlined />, path: n('ship') ? '/wms/shipments?status=DRAFT' : '/wms/shipments?new=1', count: n('ship') + n('shippable'), sub: '扫序列号发货' },
    { label: '盘点', icon: <ContainerOutlined />, path: pick(['/wms/pda/count'], ['/wms/counts']), count: n('count_open'), sub: '扫库位逐条录入' },
    { label: '完工入库', icon: <ToolOutlined />, path: pick(['/wms/pda/fg'], ['/mes/work-orders?status=IN_PROGRESS,COMPLETED']), count: n('fg') },
    { label: '库存查询', icon: <DatabaseOutlined />, path: '/wms/stock', sub: '扫物料/批号/库位' },
    { label: '客户退货', icon: <RollbackOutlined />, path: n('rma') ? '/wms/customer-returns?status=RECEIVED' : '/wms/customer-returns', count: n('rma') },
    { label: '退供应商', icon: <BarcodeOutlined />, path: firstRoute('/quality/supplier-returns?status=PENDING', '/quality/ncrs'), count: n('supplier_return'), sub: '不合格品出库' },
    ...(narrow ? [] : [{ label: '库存流水', icon: <InboxOutlined />, path: '/wms/moves' }]),
  ].filter((t) => canPath(t.path, can));
  return (
    <div className="wh-grid">
      {tiles.map((t) => (
        <div key={t.label} className="wh-tile" role="button" tabIndex={0} onClick={() => go(t.path)} onKeyDown={(e) => e.key === 'Enter' && go(t.path)}>
          {!!t.count && <Badge className="wh-badge" count={t.count} overflowCount={99} />}
          {t.icon}
          <span className="wh-label">{t.label}</span>
          {t.sub && !narrow && <span className="wh-sub">{t.sub}</span>}
        </div>
      ))}
    </div>
  );
}

/** 厂长：待我拍板 */
export function Approvals({ items, risk, onHash }: { items: Rec[]; risk: number; onHash: (h: string) => void }) {
  const go = useGo();
  const rows = [
    ...(risk ? [{ key: 'risk_red', title: '交付风险红灯订单（会延误）', count: risk, path: '#risk-red', level: 'error' }] : []),
    ...items,
  ];
  return (
    <Card size="small" title={<Space><AuditOutlined />待我拍板</Space>} style={{ height: '100%' }}>
      {rows.length ? (
        <List
          dataSource={rows}
          renderItem={(t: Rec) => (
            <List.Item className="todo-item" onClick={() => (t.path.startsWith('#') || t.path.startsWith('/?') ? onHash(t.path) : go(t.path))} actions={[<ArrowRightOutlined key="a" />]}>
              <Space><Tag color={t.level === 'error' ? 'red' : 'orange'} style={{ minWidth: 32, textAlign: 'center' }}>{t.count}</Tag>{t.title}</Space>
            </List.Item>
          )}
        />
      ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无需要您拍板的事项" />}
    </Card>
  );
}

// 图表配色（单系列统一使用一个色相；网格/坐标轴弱化）
const SERIES = '#2a78d6';
const AXIS = { axisLine: { lineStyle: { color: '#d9d9d9' } }, axisLabel: { color: '#595959' }, axisTick: { show: false } };
const SPLIT = { splitLine: { lineStyle: { color: '#f0f0f0' } } };
const fpyColor = (v: number) => (v >= 95 ? '#52c41a' : v >= 90 ? '#faad14' : '#ff4d4f');

/** 厂长图表：产出（点柱子看当日完工明细）、工序 FPY（点柱子看首次不合格明细，低于目标标色）、NCR 来源（点柱子进 NCR 列表） */
export function ManagerCharts({ d, drill }: { d: Rec; drill: { output: (date?: string) => void; fpy: (op?: string) => void } }) {
  const go = useGo();
  const outputOpt = useMemo(() => ({
    grid: { left: 36, right: 12, top: 16, bottom: 28 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (p: any) => `${p[0].axisValue}<br/>完工 <b>${p[0].value}</b> 台（点击看明细）` },
    xAxis: { type: 'category', data: (d.output_trend || []).map((r: Rec) => dayjs(r.date).format('MM-DD')), ...AXIS },
    yAxis: { type: 'value', minInterval: 1, ...AXIS, ...SPLIT },
    series: [{ type: 'bar', barMaxWidth: 24, itemStyle: { color: SERIES, borderRadius: [4, 4, 0, 0] }, data: (d.output_trend || []).map((r: Rec) => r.qty) }],
  }), [d]);
  const fpyOpt = useMemo(() => {
    const rows: Rec[] = d.fpy_by_op || [];
    return {
      grid: { left: 8, right: 48, top: 8, bottom: 8, containLabel: true },
      tooltip: { trigger: 'item', formatter: (p: any) => `${p.name}<br/>一次直通率 <b>${p.value}%</b><br/>测试 ${rows[p.dataIndex]?.tested ?? '-'} 台（点击看不合格明细）` },
      xAxis: { type: 'value', min: (v: any) => Math.max(0, Math.floor(v.min / 10) * 10 - 10), max: 100, splitNumber: 3, ...AXIS, ...SPLIT, axisLabel: { color: '#595959', formatter: '{value}%', hideOverlap: true } },
      yAxis: { type: 'category', inverse: true, data: rows.map((r) => r.op_name), ...AXIS },
      series: [{
        type: 'bar', barMaxWidth: 18, data: rows.map((r) => ({ value: r.fpy, itemStyle: { color: fpyColor(r.fpy), borderRadius: [0, 4, 4, 0] } })),
        label: { show: true, position: 'right', color: '#262626', formatter: '{c}%' },
        markLine: { silent: true, symbol: 'none', lineStyle: { color: '#8c8c8c', type: 'dashed' }, label: { show: false }, data: [{ xAxis: 95 }] },
      }],
    };
  }, [d]);
  const ncrRows: Rec[] = d.ncr_by_source || [];
  const ncrOpt = useMemo(() => ({
    grid: { left: 36, right: 12, top: 16, bottom: 28 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: { type: 'category', data: ncrRows.map((r) => dictLabel('ncr_source', r.source)), ...AXIS },
    yAxis: { type: 'value', minInterval: 1, ...AXIS, ...SPLIT },
    series: [{ type: 'bar', name: 'NCR 数量', barMaxWidth: 24, itemStyle: { color: SERIES, borderRadius: [4, 4, 0, 0] }, data: ncrRows.map((r) => r.count) }],
  }), [ncrRows]);
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={10}>
        <Card title="近 14 天产出（台）" size="small" extra={<a onClick={() => drill.output()}>今日明细</a>}>
          <ClickChart option={outputOpt as any} onClick={(p) => drill.output(d.output_trend?.[p.dataIndex]?.date)} />
        </Card>
      </Col>
      <Col xs={24} lg={8}>
        <Card title={<span>工序一次直通率（近 30 天）<Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}> 虚线 = 目标 95%</Typography.Text></span>} size="small" extra={<a onClick={() => drill.fpy()}>不合格明细</a>}>
          {d.fpy_by_op?.length ? <ClickChart option={fpyOpt as any} onClick={(p) => drill.fpy(p.name)} /> : <Empty style={{ height: 260 }} description="近 30 天无测试记录" />}
        </Card>
      </Col>
      <Col xs={24} lg={6}>
        <Card title="NCR 来源（近 30 天）" size="small" extra={<a onClick={() => go('/quality/ncrs')}>全部</a>}>
          {ncrRows.length ? <ClickChart option={ncrOpt as any} onClick={(p) => go(`/quality/ncrs?source=${ncrRows[p.dataIndex]?.source}`)} /> : <Empty style={{ height: 260 }} description="近 30 天无 NCR" />}
        </Card>
      </Col>
    </Row>
  );
}

/** 产出下钻：某日完工序列号按工单汇总 */
export function OutputDrill({ date, onClose }: { date: string | null; onClose: () => void }) {
  const [d, setD] = useState<Rec | null>(null);
  useEffect(() => {
    if (date === null) return;
    setD(null);
    get('/workbench/output', date ? { date } : undefined).then(setD).catch(() => setD({ work_orders: [] }));
  }, [date]);
  return (
    <Modal open={date !== null} onCancel={onClose} footer={null} width={720} title={`完工明细 ${d?.date ?? ''}（共 ${d?.total ?? '-'} 台）`}>
      <Table<Rec>
        rowKey="wo_id"
        size="small"
        loading={!d}
        dataSource={d?.work_orders ?? []}
        pagination={false}
        columns={[
          { title: '工单', dataIndex: 'wo_no', render: (v, r) => <Link to={`/mes/work-orders/${r.wo_id}`} onClick={onClose}>{v}</Link> },
          { title: '产品', dataIndex: 'material_code', render: (v, r) => `${v} ${r.material_name ?? ''}` },
          { title: '完工（台）', dataIndex: 'qty', align: 'right' },
        ]}
        expandable={{ expandedRowRender: (r) => <Space wrap>{r.serials.map((s: string) => <Link key={s} to={`/trace?sn=${s}`} className="mono" onClick={onClose}>{s}</Link>)}</Space> }}
        locale={{ emptyText: '当天没有完工' }}
      />
    </Modal>
  );
}

/** FPY 下钻：各工序首次测试与首次不合格明细 */
export function FpyDrill({ op, onClose }: { op: string | null; onClose: () => void }) {
  const [d, setD] = useState<Rec | null>(null);
  useEffect(() => {
    if (op === null) return;
    setD(null);
    get('/workbench/fpy', op ? { op_name: op } : undefined).then(setD).catch(() => setD({ ops: [], fails: [] }));
  }, [op]);
  return (
    <Modal open={op !== null} onCancel={onClose} footer={null} width={820} title={`一次直通率明细（近 30 天）${op ? ` · ${op}` : ''}`}>
      <Table<Rec>
        rowKey="op_name"
        size="small"
        loading={!d}
        dataSource={d?.ops ?? []}
        pagination={false}
        columns={[
          { title: '工序', dataIndex: 'op_name' },
          { title: '首次测试', dataIndex: 'tested', align: 'right' },
          { title: '首次不合格', dataIndex: 'failed', align: 'right' },
          { title: 'FPY', dataIndex: 'fpy', align: 'right', render: (v) => <Tag color={v >= 95 ? 'green' : v >= 90 ? 'gold' : 'red'}>{v}%</Tag> },
        ]}
      />
      <Typography.Title level={5} style={{ marginTop: 16 }}>首次不合格记录</Typography.Title>
      <Table<Rec>
        rowKey="id"
        size="small"
        loading={!d}
        dataSource={d?.fails ?? []}
        pagination={{ pageSize: 8, size: 'small' }}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '时间', dataIndex: 'ts', render: (v) => fmtDateTime(v) },
          { title: '工序', dataIndex: 'op_name' },
          { title: '序列号', dataIndex: 'sn', render: (v) => <Link to={`/trace?sn=${v}`} className="mono" onClick={onClose}>{v}</Link> },
          { title: '工单', dataIndex: 'wo_no', render: (v, r) => <Link to={`/mes/work-orders/${r.wo_id}`} onClick={onClose}>{v}</Link> },
          { title: '操作员', dataIndex: 'operator' },
          { title: '备注', dataIndex: 'remark' },
        ]}
        locale={{ emptyText: '没有首次不合格' }}
      />
    </Modal>
  );
}
