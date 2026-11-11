import { Alert, Button, Card, Col, Empty, List, Result, Row, Space, Statistic, Tag, Tooltip, Typography } from 'antd';
import { ArrowRightOutlined, NodeIndexOutlined, PlusOutlined, ScanOutlined, ThunderboltOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, type Rec } from '../api/http';
import { useAuth } from '../auth';
import Chart from '../components/Chart';
import { dictLabel } from '../utils/dict';
import { fmtMoney } from '../utils/format';

// 图表配色（单系列统一使用一个色相；网格/坐标轴弱化）
const SERIES = '#2a78d6';
const AXIS = { axisLine: { lineStyle: { color: '#d9d9d9' } }, axisLabel: { color: '#595959' }, axisTick: { show: false } };
const SPLIT = { splitLine: { lineStyle: { color: '#f0f0f0' } } };

function Kpi({ title, value, suffix, hint, onClick, warn }: { title: string; value: any; suffix?: string; hint?: ReactNode; onClick?: () => void; warn?: boolean }) {
  return (
    <Card size="small" hoverable={!!onClick} onClick={onClick} className="kpi-card" style={{ height: '100%' }}>
      <Statistic title={title} value={value ?? '-'} suffix={suffix} valueStyle={{ fontSize: 24, color: warn ? '#cf1322' : undefined }} />
      {hint && <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>{hint}</Typography.Paragraph>}
    </Card>
  );
}

/** 金额 + 币别（常用币别带符号，其余显示代码） */
const money = (v: number | null | undefined, c: string) =>
  ['CNY', 'USD', 'EUR'].includes(c) ? fmtMoney(v, c) : `${c} ${Number(v ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** 在手订单金额：本位币合计 + 按币别明细（缺汇率的币别未计入合计） */
function OpenSoHint({ k }: { k: Rec }) {
  const base: string = k.base_currency || 'CNY';
  const rows: Rec[] = k.open_so_by_currency || [];
  const missing: string[] = k.missing_rates || [];
  const detail = rows.map((r) => money(r.amount, r.currency)).join(' + ');
  const foreign = rows.some((r) => r.currency !== base);
  return (
    <Tooltip title={foreign ? `按币别：${detail}；外币按今日汇率折算为 ${base}` : undefined}>
      <div>
        <div>金额 {money(k.open_so_amount, base)}{foreign ? `（折合${base}）` : ''}</div>
        {foreign && <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{detail}</div>}
        {missing.length > 0 && <div style={{ color: '#d48806' }}>缺 {missing.join('、')} 汇率，未计入合计</div>}
      </div>
    </Tooltip>
  );
}

/** 首次登录的金蝶账号等尚未分配角色的用户 */
function AwaitingRole() {
  const { user } = useAuth();
  return (
    <Card>
      <Result
        status="info"
        title={`欢迎，${user?.full_name}`}
        subTitle={user?.auth_source === 'KINGDEE'
          ? '您的金蝶云星空账号已接入本系统。为保障医疗器械质量数据安全，请联系系统管理员为您分配岗位角色后再使用业务功能。'
          : '您的账号尚未分配角色，请联系系统管理员开通权限。'}
      />
    </Card>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  return user?.roles.length ? <DashboardMain /> : <AwaitingRole />;
}

function DashboardMain() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [d, setD] = useState<Rec | null>(null);
  const [todos, setTodos] = useState<Rec[]>([]);
  useEffect(() => {
    get('/dashboard').then(setD);
    get('/todos').then(setTodos);
  }, []);
  const k = d?.kpi || {};

  const outputOpt = useMemo(() => ({
    grid: { left: 36, right: 12, top: 16, bottom: 28 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (p: any) => `${p[0].axisValue}<br/>完工 <b>${p[0].value}</b> 台` },
    xAxis: { type: 'category', data: (d?.output_trend || []).map((r: Rec) => dayjs(r.date).format('MM-DD')), ...AXIS },
    yAxis: { type: 'value', minInterval: 1, ...AXIS, ...SPLIT },
    series: [{ type: 'bar', barMaxWidth: 24, itemStyle: { color: SERIES, borderRadius: [4, 4, 0, 0] }, data: (d?.output_trend || []).map((r: Rec) => r.qty) }],
  }), [d]);

  const fpyOpt = useMemo(() => {
    const rows: Rec[] = d?.fpy_by_op || [];
    return {
      grid: { left: 8, right: 48, top: 8, bottom: 8, containLabel: true },
      tooltip: { trigger: 'item', formatter: (p: any) => `${p.name}<br/>一次直通率 <b>${p.value}%</b><br/>测试 ${rows[p.dataIndex]?.tested ?? '-'} 台` },
      xAxis: { type: 'value', min: (v: any) => Math.max(0, Math.floor(v.min / 10) * 10 - 10), max: 100, ...AXIS, ...SPLIT, axisLabel: { color: '#595959', formatter: '{value}%' } },
      yAxis: { type: 'category', inverse: true, data: rows.map((r) => r.op_name), ...AXIS },
      series: [{
        type: 'bar', barMaxWidth: 18, data: rows.map((r) => r.fpy),
        itemStyle: { color: SERIES, borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: 'right', color: '#262626', formatter: '{c}%' },
      }],
    };
  }, [d]);

  const ncrOpt = useMemo(() => {
    const rows: Rec[] = d?.ncr_by_source || [];
    return {
      grid: { left: 36, right: 12, top: 16, bottom: 28 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'category', data: rows.map((r) => dictLabel('ncr_source', r.source)), ...AXIS },
      yAxis: { type: 'value', minInterval: 1, ...AXIS, ...SPLIT },
      series: [{ type: 'bar', name: 'NCR 数量', barMaxWidth: 24, itemStyle: { color: SERIES, borderRadius: [4, 4, 0, 0] }, data: rows.map((r) => r.count) }],
    };
  }, [d]);

  const hour = new Date().getHours();
  const greet = hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好';

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card variant="borderless" style={{ background: 'linear-gradient(110deg,#2a1b5e,#5b3cc4 60%,#c2417a)', color: '#fff' }}>
        <Row align="middle" gutter={16}>
          <Col flex="auto">
            <Typography.Title level={3} style={{ color: '#fff', margin: 0 }}>{greet}，{user?.full_name}</Typography.Title>
            <Typography.Text style={{ color: 'rgba(255,255,255,.8)' }}>
              {dayjs().format('YYYY年M月D日 dddd')} · {user?.role_names.join(' / ')} · 今天有 {todos.reduce((s, t) => s + t.count, 0)} 项待办
            </Typography.Text>
          </Col>
          <Col>
            <Space wrap>
              <Button ghost icon={<PlusOutlined />} onClick={() => nav('/sales/orders/new')}>新建销售订单</Button>
              <Button ghost icon={<ThunderboltOutlined />} onClick={() => nav('/plan/mrp')}>运行 MRP</Button>
              <Button ghost icon={<ScanOutlined />} onClick={() => nav('/mes/station')}>工位终端</Button>
              <Button ghost icon={<NodeIndexOutlined />} onClick={() => nav('/trace')}>质量追溯</Button>
            </Space>
          </Col>
        </Row>
      </Card>

      <Row gutter={[12, 12]}>
        <Col xs={12} md={8} xl={4}><Kpi title="在手销售订单" value={k.open_so} hint={d ? <OpenSoHint k={k} /> : undefined} onClick={() => nav('/sales/orders')} /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="逾期订单" value={k.overdue_so} warn={k.overdue_so > 0} hint="交期已过未发完" onClick={() => nav('/sales/orders')} /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="在制工单" value={k.wip_wo} hint={`在制数量 ${k.wip_qty ?? '-'}`} onClick={() => nav('/mes/work-orders')} /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="今日产出（台）" value={k.today_output} hint="完成全部工序" /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="一次直通率 FPY" value={k.fpy} suffix={k.fpy != null ? '%' : ''} hint="近30天，按序列号首次测试" /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="库存金额" value={k.stock_value != null ? Math.round(k.stock_value).toLocaleString() : '-'} suffix="元" hint={`低于安全库存 ${k.below_safety ?? 0} 项`} onClick={() => nav('/wms/stock')} /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="待检来料 IQC" value={k.pending_iqc} warn={k.pending_iqc > 0} hint={`近30天合格率 ${k.iqc_pass_rate ?? '-'}%`} onClick={() => nav('/quality/inspections')} /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="待处置 NCR" value={k.open_ncr} warn={k.open_ncr > 0} onClick={() => nav('/quality/ncrs')} /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="待放行批次" value={k.pending_release} warn={k.pending_release > 0} hint="DHR 待 QA 审核" onClick={() => nav('/quality/release')} /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="进行中 CAPA" value={k.open_capa} onClick={() => nav('/quality/capas')} /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="校准到期仪器" value={k.calibration_due} warn={k.calibration_due > 0} hint="30天内到期/已过期" onClick={() => nav('/master/equipment')} /></Col>
        <Col xs={12} md={8} xl={4}><Kpi title="临期批次" value={k.expiring_lots} hint="30天内到期" onClick={() => nav('/wms/stock')} /></Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={10}>
          <Card title="我的待办" size="small" style={{ height: '100%' }}>
            {todos.length ? (
              <List dataSource={todos} renderItem={(t) => (
                <List.Item actions={[<Button type="link" key="go" onClick={() => nav(t.path)}>去处理 <ArrowRightOutlined /></Button>]}>
                  <Space><Tag color="volcano" style={{ minWidth: 32, textAlign: 'center' }}>{t.count}</Tag>{t.title}</Space>
                </List.Item>
              )} />
            ) : <Empty description="暂无待办" />}
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title="预警提醒" size="small" style={{ height: '100%' }}>
            {d?.alerts?.length ? (
              <Space direction="vertical" style={{ width: '100%' }}>
                {d.alerts.slice(0, 8).map((a: Rec, i: number) => <Alert key={i} type={a.level} showIcon message={a.text} />)}
              </Space>
            ) : <Empty description="一切正常" />}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={10}><Card title="近 14 天产出（台）" size="small"><Chart option={outputOpt as any} /></Card></Col>
        <Col xs={24} lg={8}><Card title="工序一次直通率（近 30 天）" size="small">{d?.fpy_by_op?.length ? <Chart option={fpyOpt as any} /> : <Empty style={{ height: 260 }} />}</Card></Col>
        <Col xs={24} lg={6}><Card title="NCR 来源（近 30 天）" size="small">{d?.ncr_by_source?.length ? <Chart option={ncrOpt as any} /> : <Empty style={{ height: 260 }} />}</Card></Col>
      </Row>
    </Space>
  );
}
