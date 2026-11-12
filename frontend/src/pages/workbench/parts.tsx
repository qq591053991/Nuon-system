/** 岗位工作台的各个区块（G1）：KPI 卡、待办、待我拍板、财务应收应付、管理员账号安全、操作员首页、仓管九宫格、厂长图表与下钻。 */
import { Alert, Badge, Button, Card, Col, Empty, Input, List, Modal, Row, Space, Statistic, Table, Tag, Typography, message } from 'antd';
import { ArrowRightOutlined, AuditOutlined, ScanOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import * as echarts from 'echarts';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import { isCancel, useESign } from '../../components/ESign';
import ResponsiveTable, { type RColumn } from '../../components/ResponsiveTable';
import { dictLabel } from '../../utils/dict';
import { fmtDateTime, fmtMoney } from '../../utils/format';
import { PDA_TILES } from '../wms/pda/tiles';
import { canPath, useGo } from './links';

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

/**
 * 仓管九宫格：与 /wms/pda 共用同一份定义（R5 的 PDA_TILES），角标取工作台待办（与 badgeKey 同名）。
 * 电脑和 PDA 进入同一批扫码作业页，避免两处入口不一致（B-N12）。
 */
export function WarehouseGrid({ todos, narrow }: { todos: Rec[]; narrow: boolean }) {
  const go = useGo();
  const { can } = useAuth();
  const n = (key?: string) => (key ? todos.find((t) => t.key === key)?.count ?? 0 : 0);
  const tiles = PDA_TILES.filter((t) => !t.perm || can(...t.perm));
  return (
    <div className="wh-grid">
      {tiles.map((t) => {
        const count = n(t.badgeKey) + (t.key === 'ship' ? n('shippable') : 0);
        const Icon = t.icon;
        return (
          <div key={t.key} className="wh-tile" role="button" tabIndex={0} onClick={() => go(t.path)} onKeyDown={(e) => e.key === 'Enter' && go(t.path)}>
            {!!count && <Badge className="wh-badge" count={count} overflowCount={99} />}
            <Icon style={{ color: t.color }} />
            <span className="wh-label">{t.title}</span>
            {!narrow && t.badgeKey && count > 0 && <span className="wh-sub">{todos.find((x) => x.key === t.badgeKey)?.title ?? ''}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** 厂长：待我拍板 */
export function Approvals({ items, risk, bigPos = [], onHash, onChanged }: { items: Rec[]; risk: number; bigPos?: Rec[]; onHash: (h: string) => void; onChanged?: () => void }) {
  const go = useGo();
  const [sign, signHolder] = useESign();
  const [busy, setBusy] = useState<number | null>(null);
  const [rejecting, setRejecting] = useState<Rec | null>(null);
  const [reason, setReason] = useState('');
  const rows = [
    ...(risk ? [{ key: 'risk_red', title: '交付风险红灯订单（会延误）', count: risk, path: '#risk-red', level: 'error' }] : []),
    // 大额采购单在下方逐张列出，可直接批准/退回
    ...items.filter((t) => !(t.key === 'po_big' && bigPos.length)),
  ];
  const approve = async (po: Rec) => {
    setBusy(po.id);
    try {
      await sign({ meaning: `大额采购单审批（${po.no}）`, submit: (signature) => post(`/purchase-orders/${po.id}/approve`, { signature }) });
      message.success(`${po.no} 已批准`);
      onChanged?.();
    } catch (e) {
      if (!isCancel(e)) throw e;
    } finally {
      setBusy(null);
    }
  };
  const reject = async () => {
    const po = rejecting;
    if (!po) return;
    if (!reason.trim()) return message.warning('请填写退回原因（采购员据此修改）');
    setBusy(po.id);
    try {
      await sign({ meaning: `大额采购单退回（${po.no}）`, submit: (signature) => post(`/purchase-orders/${po.id}/reject`, { reason: reason.trim(), signature }) });
      message.success(`${po.no} 已退回采购员`);
      setRejecting(null);
      setReason('');
      onChanged?.();
    } catch (e) {
      if (!isCancel(e)) throw e;
    } finally {
      setBusy(null);
    }
  };
  // 没有要拍板的事：收成一行，不占首屏
  if (!rows.length && !bigPos.length) {
    return (
      <Card size="small" styles={{ body: { padding: '10px 16px' } }}>
        <Space><AuditOutlined style={{ color: '#52c41a' }} /><b>待我拍板</b><Typography.Text type="secondary">暂无需要您拍板的事项</Typography.Text></Space>
      </Card>
    );
  }
  return (
    <Card size="small" title={<Space><AuditOutlined />待我拍板</Space>} style={{ height: '100%' }}>
      {signHolder}
      {bigPos.length > 0 && (
        <List
          size="small"
          header={<Typography.Text strong>大额采购单待审批（{bigPos.length}）</Typography.Text>}
          dataSource={bigPos}
          renderItem={(po: Rec) => (
            <List.Item
              actions={[
                <Button key="ok" size="small" type="primary" loading={busy === po.id} onClick={() => approve(po)}>批准</Button>,
                <Button key="no" size="small" danger disabled={busy === po.id} onClick={() => { setRejecting(po); setReason(''); }}>退回</Button>,
              ]}
            >
              <Space direction="vertical" size={0}>
                <Space wrap>
                  <a className="mono" onClick={() => go(`/purchase/orders/${po.id}`)}>{po.no}</a>
                  <span>{po.supplier_name}</span>
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {fmtMoney(po.total_amount, po.currency)}{po.currency !== po.base_currency && po.base_amount != null ? `（折合 ${fmtMoney(po.base_amount, po.base_currency)}）` : ''} · 采购 {po.created_by ?? '-'}{po.expected_date ? ` · 要求到货 ${po.expected_date}` : ''}
                </Typography.Text>
              </Space>
            </List.Item>
          )}
        />
      )}
      {rows.length > 0 && (
        <List
          dataSource={rows}
          renderItem={(t: Rec) => (
            <List.Item className="todo-item" onClick={() => (t.path.startsWith('#') || t.path.startsWith('/?') ? onHash(t.path) : go(t.path))} actions={[<ArrowRightOutlined key="a" />]}>
              <Space><Tag color={t.level === 'error' ? 'red' : 'orange'} style={{ minWidth: 32, textAlign: 'center' }}>{t.count}</Tag>{t.title}</Space>
            </List.Item>
          )}
        />
      )}
      <Modal open={!!rejecting} title={`退回采购单 ${rejecting?.no ?? ''}`} okText="退回（电子签名）" okButtonProps={{ danger: true, loading: busy === rejecting?.id }}
        onOk={reject} onCancel={() => setRejecting(null)} destroyOnHidden>
        <Typography.Paragraph type="secondary">退回后采购单回到草稿，采购员按原因修改后重新提交审批。</Typography.Paragraph>
        <Input.TextArea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="退回原因，如：单价高于上次 8%，请再议价；或数量请按 MRP 建议调整" />
      </Modal>
    </Card>
  );
}

/** 到期预警（QA/厂长/采购/工程）：仪器校准、供应商资质、人员上岗资质、临期批次；点条目进对应资料 */
const EXPIRY_GROUPS: { key: string; title: string; window: string }[] = [
  { key: 'calibration', title: '仪器校准', window: '30 天内' },
  { key: 'supplier', title: '供应商资质', window: '60 天内' },
  { key: 'qualification', title: '人员上岗资质', window: '30 天内' },
  { key: 'lot', title: '临期批次', window: '30 天内' },
];
export function ExpiryCard({ data }: { data: Record<string, Rec[]> }) {
  const go = useGo();
  const groups = EXPIRY_GROUPS.filter((g) => data[g.key]);
  const total = groups.reduce((n, g) => n + (data[g.key]?.length ?? 0), 0);
  const dayTag = (d: number | null) => (d === null ? null : d < 0 ? <Tag color="red">已过期 {-d} 天</Tag> : d === 0 ? <Tag color="red">今天到期</Tag> : <Tag color={d <= 7 ? 'orange' : 'gold'}>剩 {d} 天</Tag>);
  return (
    <Card id="expiry" size="small" title={<Space><Badge count={total} size="small" offset={[6, -2]}><span>到期预警</span></Badge></Space>}>
      <Row gutter={[16, 8]}>
        {groups.map((g) => (
          <Col key={g.key} xs={24} md={12} xl={groups.length > 2 ? 6 : 12}>
            <Typography.Text strong>{g.title}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>{g.window}（{data[g.key].length}）</Typography.Text>
            <List
              size="small"
              dataSource={data[g.key].slice(0, 6)}
              locale={{ emptyText: '无' }}
              renderItem={(x: Rec) => (
                <List.Item className="todo-item" onClick={() => go(x.url)} style={{ paddingLeft: 0, paddingRight: 0 }}>
                  <Space direction="vertical" size={0} style={{ minWidth: 0 }}>
                    <span className="mono" style={{ fontSize: 13 }}>{x.code}</span>
                    <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: 200 }}>{x.name}{x.qty ? ` · ${x.qty}` : ''}</Typography.Text>
                  </Space>
                  <Space direction="vertical" size={0} style={{ alignItems: 'flex-end' }}>
                    {dayTag(x.days_left)}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{x.date}</Typography.Text>
                  </Space>
                </List.Item>
              )}
            />
            {data[g.key].length > 6 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>另有 {data[g.key].length - 6} 项</Typography.Text>}
          </Col>
        ))}
      </Row>
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
    // 横轴隔天显示，保证最右侧“今天”总有标签
    xAxis: {
      type: 'category', data: (d.output_trend || []).map((r: Rec, i: number, a: Rec[]) => (i === a.length - 1 ? '今天' : dayjs(r.date).format('MM-DD'))), ...AXIS,
      axisLabel: { color: '#595959', interval: (i: number) => (((d.output_trend || []).length - 1 - i) % 2 === 0) },
    },
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
