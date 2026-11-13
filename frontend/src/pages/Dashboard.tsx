/**
 * 工作台（G1）：每个岗位登录后看到自己的首页。
 *  - 厂长：KPI（可下钻）+ 待我拍板 + 交付风险（红黄绿）+ 产出/FPY/NCR 图表（点击下钻）；
 *  - 计划/销售：KPI + 待办 + 交付风险；财务：应收应付与逾期；管理员：账号安全；
 *  - 仓管：九宫格大按钮（进入 RFID 作业台各页面）+ 待办；操作员：进入工位大按钮 + 今日报工与上岗资质；
 *  - QA/质检/采购/工程：KPI + 待办。
 * KPI 与待办点进去都带筛选参数（见后端 workbench.service.ts 的 PATHS）。
 */
import { Alert, Button, Card, Col, Result, Row, Skeleton, Space, Typography } from 'antd';
import {
  AccountBookOutlined, ApartmentOutlined, AuditOutlined, ExperimentOutlined, FileSearchOutlined, NodeIndexOutlined, PlusOutlined,
  SafetyCertificateOutlined, ShoppingCartOutlined, TeamOutlined, ThunderboltOutlined, ToolOutlined, UploadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, type Rec } from '../api/http';
import { useAuth } from '../auth';
import { useNarrow } from '../components/ResponsiveTable';
import DeliveryRisk from './workbench/DeliveryRisk';
import { useGo } from './workbench/links';
import {
  Approvals, ExpiryCard, FinancePanel, FpyDrill, KpiGrid, ManagerCharts, OperatorHome, OutputDrill, SecurityPanel, TodoCard, WarehouseGrid, useShortcuts, type Shortcut,
} from './workbench/parts';

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
  return user?.roles.length ? <Workbench /> : <AwaitingRole />;
}

/** 各岗位的快捷按钮（按菜单权限再裁剪） */
const SHORTCUTS: Record<string, Shortcut[]> = {
  manager: [
    { label: '交付风险', path: '#risk', icon: <ThunderboltOutlined /> },
    { label: '质量追溯', path: '/trace', icon: <NodeIndexOutlined /> },
    { label: '应收应付', path: '/finance', icon: <AccountBookOutlined /> },
    { label: '审计追踪', path: '/system/audit', icon: <AuditOutlined /> },
  ],
  sales: [
    { label: '新建销售订单', path: '/sales/orders/new', icon: <PlusOutlined />, primary: true },
    { label: '销售订单', path: '/sales/orders' },
    { label: '发货申请', path: '/wms/shipments?new=1' },
    { label: '客户投诉', path: '/quality/complaints' },
  ],
  planner: [
    { label: '运行 MRP', path: '/plan/mrp', icon: <ThunderboltOutlined />, primary: true },
    { label: '缺料工单', path: '/mes/work-orders?kitting=SHORT' },
    { label: '生产工单', path: '/mes/work-orders' },
    { label: '销售订单', path: '/sales/orders' },
  ],
  purchaser: [
    { label: '新建采购订单', path: '/purchase/orders/new', icon: <PlusOutlined />, primary: true },
    { label: '催货清单', path: '/purchase/chase', icon: <ShoppingCartOutlined /> },
    { label: 'MRP 采购建议', path: '/plan/mrp' },
    { label: '采购订单', path: '/purchase/orders' },
  ],
  qa: [
    { label: 'DHR 审核放行', path: '/quality/release', icon: <SafetyCertificateOutlined />, primary: true },
    { label: '待处置 NCR', path: '/quality/ncrs?status=OPEN' },
    { label: 'CAPA', path: '/quality/capas' },
    { label: '质量追溯', path: '/trace', icon: <NodeIndexOutlined /> },
  ],
  qc: [
    { label: '来料检验', path: '/quality/inspections?status=PENDING&type=IQC', icon: <ExperimentOutlined />, primary: true },
    { label: '不合格品 NCR', path: '/quality/ncrs' },
    { label: '质量追溯', path: '/trace', icon: <NodeIndexOutlined /> },
  ],
  engineer: [
    { label: 'BOM', path: '/engineering/boms', icon: <ApartmentOutlined />, primary: true },
    { label: '工艺路线', path: '/engineering/routings' },
    { label: '物料', path: '/master/materials' },
    { label: '设备与仪器', path: '/master/equipment', icon: <ToolOutlined /> },
  ],
  finance: [
    { label: '应收账款', path: '/finance?tab=AR', icon: <AccountBookOutlined />, primary: true },
    { label: '应付账款', path: '/finance?tab=AP' },
    { label: '账龄分析', path: '/finance?tab=AGING' },
    { label: '月结导出', path: '/finance?tab=EXPORT' },
  ],
  admin: [
    { label: '用户与角色', path: '/system/users', icon: <TeamOutlined />, primary: true },
    { label: '审计追踪', path: '/system/audit', icon: <FileSearchOutlined /> },
    { label: '电子签名记录', path: '/system/esign' },
    { label: '数据导入', path: '/system/import', icon: <UploadOutlined /> },
  ],
};

function Workbench() {
  const { user } = useAuth();
  const narrow = useNarrow(768);
  const go = useGo();
  const [sp] = useSearchParams();
  const [wb, setWb] = useState<Rec | null>(null);
  const [todos, setTodos] = useState<Rec[]>([]);
  const [dash, setDash] = useState<Rec | null>(null);
  const [outDate, setOutDate] = useState<string | null>(null);
  const [fpyOp, setFpyOp] = useState<string | null>(null);
  const [riskFilter, setRiskFilter] = useState<string | undefined>(sp.get('risk') || undefined);
  const [riskNonce, setRiskNonce] = useState(0);
  const [riskRed, setRiskRed] = useState(0);
  const profile: string = wb?.profile ?? '';

  const load = useCallback(() => {
    get('/workbench').then(setWb).catch(() => setWb((old: Rec | null) => old ?? { profile: 'none', kpis: [], sections: {} }));
    get('/todos').then(setTodos).catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (profile === 'manager') get('/dashboard').then(setDash).catch(() => undefined);
  }, [profile]);
  useEffect(() => {
    const target = sp.get('risk') ? 'risk' : sp.get('panel') === 'expiry' ? 'expiry' : null;
    if (target && wb) setTimeout(() => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
  }, [sp, wb]);

  const scrollRisk = () => setTimeout(() => document.getElementById('risk')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  const onHash = useCallback((h: string) => {
    if (h === '#expiry' || h.includes('panel=expiry')) setTimeout(() => document.getElementById('expiry')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    else if (h === '#output') setOutDate('');
    else if (h === '#fpy') setFpyOp('');
    else if (h === '#risk-red' || h.includes('risk=overdue') || h === '#risk') {
      setRiskFilter(h === '#risk-red' ? 'red' : h === '#risk' ? 'all' : 'overdue');
      setRiskNonce((n) => n + 1);
      scrollRisk();
    }
  }, []);

  const shortcuts = useShortcuts(SHORTCUTS[profile] ?? []);
  const sections: Rec = wb?.sections ?? {};
  const kpis: Rec[] = wb?.kpis ?? [];
  const todoTotal = todos.reduce((s, t) => s + t.count, 0);
  const hour = new Date().getHours();
  const greet = hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好';
  const showRisk = ['manager', 'planner', 'sales'].includes(profile);
  // 厂长“其他预警”：校准/供应商资质已在“到期预警”卡中，这里只留缺汇率、低于安全库存、逾期订单等；手机上只留红色
  const managerAlerts: Rec[] = (dash?.alerts ?? []).filter((a: Rec) => !/^(设备|供应商)/.test(a.text) && (!narrow || a.level === 'error'));

  const banner = (
    <div className="wb-banner">
      <Row align="middle" gutter={[16, 12]}>
        <Col flex="auto">
          <Typography.Title level={3}>{greet}，{user?.full_name}</Typography.Title>
          <Typography.Text className="wb-sub">
            {dayjs().format(narrow ? 'M月D日 ddd' : 'YYYY年M月D日 dddd')} · {user?.role_names.join(' / ')} · 待办 {todoTotal} 项
          </Typography.Text>
        </Col>
        {!narrow && shortcuts.length > 0 && (
          <Col>
            <Space wrap>
              {shortcuts.map((s) => (
                <Button key={s.label} ghost icon={s.icon} onClick={() => (s.path.startsWith('#') ? onHash(s.path) : go(s.path))} style={s.primary ? { background: 'rgba(255,255,255,.18)' } : undefined}>
                  {s.label}
                </Button>
              ))}
            </Space>
          </Col>
        )}
      </Row>
    </div>
  );

  if (!wb) return <Card><Skeleton active paragraph={{ rows: 6 }} /></Card>;

  // 仓管：九宫格
  if (profile === 'warehouse') {
    return (
      <Space direction="vertical" size={narrow ? 12 : 16} style={{ width: '100%' }}>
        {banner}
        <WarehouseGrid todos={todos} narrow={narrow} />
        <TodoCard todos={todos} />
      </Space>
    );
  }

  // 操作员：进入工位
  if (profile === 'operator') {
    return (
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {banner}
        {sections.operator ? <OperatorHome o={sections.operator} kpis={<KpiGrid kpis={kpis} onHash={onHash} />} /> : <KpiGrid kpis={kpis} onHash={onHash} />}
      </Space>
    );
  }

  const narrowShortcuts = narrow && shortcuts.length > 0 && (
    <Row gutter={[8, 8]}>
      {shortcuts.map((s) => (
        <Col span={12} key={s.label}>
          <Button block type={s.primary ? 'primary' : 'default'} icon={s.icon} onClick={() => (s.path.startsWith('#') ? onHash(s.path) : go(s.path))}>{s.label}</Button>
        </Col>
      ))}
    </Row>
  );

  return (
    <Space direction="vertical" size={narrow ? 12 : 16} style={{ width: '100%' }}>
      {banner}
      {narrowShortcuts}
      {kpis.length > 0 && <KpiGrid kpis={kpis} onHash={onHash} limit={narrow ? 6 : undefined} />}

      {profile === 'qa' && sections.expiry && <ExpiryCard data={sections.expiry} />}

      {profile === 'manager' && (
        <Approvals items={sections.approvals ?? []} risk={riskRed} bigPos={sections.big_pos ?? []} onHash={onHash} onChanged={load} />
      )}

      {showRisk && <DeliveryRisk key={`${riskFilter}-${riskNonce}`} initialFilter={riskFilter} title={profile === 'sales' ? '订单交付跟踪' : '交付风险'} onSummary={(x) => setRiskRed(x.red)} />}

      {profile === 'manager' && sections.expiry && <ExpiryCard data={sections.expiry} />}
      {profile === 'manager' && managerAlerts.length > 0 && (
        <Card title="其他预警" size="small">
          <Space direction="vertical" style={{ width: '100%' }}>
            {managerAlerts.slice(0, narrow ? 3 : 6).map((a: Rec, i: number) => <Alert key={i} type={a.level} showIcon message={a.text} />)}
          </Space>
        </Card>
      )}

      {profile === 'finance' && sections.finance && <FinancePanel f={sections.finance} />}
      {profile === 'admin' && sections.security && <SecurityPanel s={sections.security} />}

      {profile !== 'manager' && <TodoCard todos={todos} onHash={onHash} />}
      {['purchaser', 'engineer'].includes(profile) && sections.expiry && <ExpiryCard data={sections.expiry} />}

      {profile === 'manager' && dash && !narrow && (
        <ManagerCharts d={dash} drill={{ output: (date) => setOutDate(date ?? ''), fpy: (op) => setFpyOp(op ?? '') }} />
      )}
      <OutputDrill date={outDate} onClose={() => setOutDate(null)} />
      <FpyDrill op={fpyOp} onClose={() => setFpyOp(null)} />
    </Space>
  );
}
