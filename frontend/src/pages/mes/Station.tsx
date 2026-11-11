import {
  Alert, App, Button, Card, Col, Descriptions, Empty, Form, Input, InputNumber, Modal, Row, Select, Space, Spin, Steps, Tag, Timeline, Typography, type InputRef,
} from 'antd';
import {
  CheckOutlined, CloseOutlined, IdcardOutlined, LockOutlined, PoweroffOutlined, ScanOutlined, SettingOutlined, ToolOutlined, WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import { EquipmentSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { dictLabel } from '../../utils/dict';
import ReworkPanel, { KeyPartActionTag } from './ReworkPanel';
import { ValuesText, errDetail, inSpec, num, specText, type SpecParam } from './spec';
import StationLock from './StationLock';
import {
  httpStatus, loadIdleMinutes, loadSession, saveIdleMinutes, saveSession, stationGet, stationPost, type StationSession,
} from './stationApi';

const LS_OP = 'nuon_station_op';
const LS_EQ = 'nuon_station_eq';
const LS_CODES = 'nuon_station_op_codes';
/** 常见工序代码（扫码后会用真实工艺路线中的名称补充） */
const DEFAULT_CODES: Record<string, string> = { ASM: '整机组装', OPT: '光学性能测试', AGE: '老化测试', SAFE: '安规测试', FQC: '终检', PACK: '包装' };

/** 工位终端额外样式（只作用于 .station 内） */
const STATION_CSS = `
.station .ant-input-affix-wrapper-lg { padding-top: 0; padding-bottom: 0; height: 56px; font-size: 22px; align-items: center; }
.station .ant-input-affix-wrapper-lg input.ant-input-lg { height: 100%; }
.station .ant-input-search-large .ant-input-search-button { height: 56px; font-size: 18px; padding: 0 28px; }
.station .ant-input-number-lg input.ant-input-number-input,
.station .ant-input-number-affix-wrapper-lg input.ant-input-number-input { font-size: 24px; height: 52px; font-weight: 600; }
.station .ant-input-number-affix-wrapper-lg .ant-input-number-suffix { font-size: 16px; }
.station .ant-select-single.ant-select-lg .ant-select-selector { height: 56px; font-size: 17px; align-items: center; }
.station .station-btn { height: 68px; font-size: 22px; font-weight: 600; }
.station .station-banner-title { font-size: 30px; font-weight: 800; line-height: 1.3; }
.station .station-param { border-left: 6px solid #d9d9d9; padding: 8px 12px; border-radius: 6px; background: #fafafa; }
.station .station-param.ok { border-left-color: #52c41a; background: #f6ffed; }
.station .station-param.ng { border-left-color: #ff4d4f; background: #fff1f0; }
.station .station-operator { display: flex; align-items: center; gap: 12px; padding: 6px 14px; border-radius: 10px; background: #f4f0ff; border: 1px solid #d3c7ff; }
.station .station-operator .name { font-size: 26px; font-weight: 800; line-height: 1.2; color: #2b1d6e; }
`;

/** 空闲多久后在页头提示即将锁定（秒） */
const IDLE_WARN_SECONDS = 30;

const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string | null | undefined) => {
  try {
    if (v === null || v === undefined || v === '') localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* 浏览器禁止存储时忽略 */
  }
};
const loadCodes = (): Record<string, string> => {
  try {
    return { ...DEFAULT_CODES, ...JSON.parse(lsGet(LS_CODES) || '{}') };
  } catch {
    return { ...DEFAULT_CODES };
  }
};

/** 支持直接扫 UDI 条码（人工可读格式）：取 (21) 后的序列号 */
const extractSn = (raw: string) => {
  const s = raw.trim();
  const m = s.match(/\(21\)([^()]+)/);
  return m ? m[1].trim() : s;
};

const calExpired = (eq?: Rec) => !!eq?.calibration_required && (!eq.next_calibration_date || dayjs(eq.next_calibration_date).isBefore(dayjs(), 'day'));

interface Banner {
  kind: 'pass' | 'fail' | 'error';
  title: string;
  body?: ReactNode;
}

export default function Station() {
  const { user } = useAuth();
  const { modal, message } = App.useApp();
  const nav = useNavigate();
  // ---- 当前操作员（刷工牌登录；与办公端登录账号相互独立） ----
  const [idleMinutes, setIdleMinutes] = useState<number>(loadIdleMinutes);
  const [session, setSession] = useState<StationSession | null>(() => loadSession(loadIdleMinutes()));
  const [lockReason, setLockReason] = useState<string | null>(null);
  const [idleLeft, setIdleLeft] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const lastActive = useRef<number>(session?.last ?? Date.now());
  const token = session?.token ?? '';
  const operator = session?.user;
  /** 当前操作员是否有报工权限（工牌登录接口只允许 mes 权限用户，此处再做一次界面判断） */
  const can = (...perms: string[]) => !!operator && perms.some((p) => operator.permissions?.includes(p));
  const [lockCode, setLockCode] = useState<string | undefined>(() => lsGet(LS_OP) || undefined);
  const [codes, setCodes] = useState<Record<string, string>>(loadCodes);
  const [defaultEq, setDefaultEq] = useState<number | undefined>(() => Number(lsGet(LS_EQ)) || undefined);
  const [eqRecs, setEqRecs] = useState<Record<number, Rec>>({});

  const [snText, setSnText] = useState('');
  const [scan, setScan] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(false);
  const [values, setValues] = useState<Record<string, number | null>>({});
  const [keyLot, setKeyLot] = useState('');
  const [equipmentId, setEquipmentId] = useState<number | undefined>();
  const [remark, setRemark] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [stats, setStats] = useState({ pass: 0, fail: 0 });

  const scanRef = useRef<InputRef>(null);
  const remarkRef = useRef<InputRef>(null);
  /** 回车依次跳转的输入框：0 = 关键件，1.. = 测试项 */
  const inputs = useRef<({ focus: () => void } | null)[]>([]);

  /** 锁定终端：清除操作员令牌与屏幕上的产品信息（交班 / 空闲超时 / 令牌失效） */
  const lock = useCallback((reason: string | null) => {
    saveSession(null);
    setSession(null);
    setLockReason(reason);
    setScan(null);
    setSnText('');
    setBanner(null);
    setValues({});
    setKeyLot('');
    setRemark('');
    setIdleLeft(null);
  }, []);

  const unlock = (s: StationSession) => {
    saveSession(s);
    lastActive.current = Date.now();
    setSession(s);
    setLockReason(null);
    setStats({ pass: 0, fail: 0 });
    message.success(`${s.user.full_name}，开始作业：后续报工记录将归属到您名下`);
  };

  /** 工位请求出错：令牌失效 → 锁定重新刷卡 */
  const authFailed = (e: unknown) => {
    if (httpStatus(e) === 401) {
      lock('登录已失效，请重新刷工牌');
      return true;
    }
    return false;
  };

  // 空闲自动锁定：任何点击 / 按键 / 触摸都算操作
  useEffect(() => {
    if (!session) return;
    const onActive = () => {
      lastActive.current = Date.now();
    };
    const evs = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;
    evs.forEach((ev) => window.addEventListener(ev, onActive, { passive: true }));
    let persisted = 0;
    const timer = setInterval(() => {
      const idle = Date.now() - lastActive.current;
      const limit = idleMinutes * 60_000;
      if (idle >= limit) {
        lock(`超过 ${idleMinutes} 分钟无操作，终端已自动锁定`);
        return;
      }
      setIdleLeft(idle >= limit - IDLE_WARN_SECONDS * 1000 ? Math.ceil((limit - idle) / 1000) : null);
      // 记录最近操作时间（刷新页面后据此判断是否需要重新刷卡）
      if (lastActive.current !== persisted) {
        persisted = lastActive.current;
        saveSession({ ...session, last: lastActive.current });
      }
    }, 1000);
    return () => {
      evs.forEach((ev) => window.removeEventListener(ev, onActive));
      clearInterval(timer);
    };
  }, [session, idleMinutes, lock]);

  // 恢复默认设备的详情（用于校准有效期提示）
  useEffect(() => {
    if (defaultEq && !eqRecs[defaultEq]) {
      get(`/equipment/${defaultEq}`, undefined, true)
        .then((r) => setEqRecs((m) => ({ ...m, [r.id]: r })))
        .catch(() => setDefaultEq(undefined));
    }
  }, [defaultEq]); // eslint-disable-line react-hooks/exhaustive-deps

  const next: Rec | null = scan?.next_operation || null;
  const params: SpecParam[] = next?.params || [];
  const kp: Rec | null = scan?.key_part_material || null;
  const ops: Rec[] = scan?.operations || [];
  const lockedOp = lockCode ? ops.find((o) => o.code === lockCode) : undefined;
  const lockMismatch = !!(lockCode && next && next.code !== lockCode);
  const lockMissing = !!(lockCode && scan && !lockedOp);
  const submitSeq = lockCode ? lockedOp?.seq : next?.seq;
  const canReport = !!(scan && next && can('mes') && !lockMissing && ['RELEASED', 'IN_PROGRESS'].includes(scan.wo?.status));
  const curSeq: number | undefined = next?.seq ?? (scan?.status === 'NG' ? ops.find((o) => !o.done)?.seq : undefined);
  const selectedEq = equipmentId ? eqRecs[equipmentId] : undefined;

  // 扫码后聚焦第一个录入框；没有录入项或无法报工时回到扫码框
  useEffect(() => {
    const t = setTimeout(() => {
      const first = inputs.current.find(Boolean);
      if (scan && canReport && first) first.focus();
      else {
        scanRef.current?.focus();
        scanRef.current?.select();
      }
    }, 80);
    return () => clearTimeout(t);
  }, [scan]); // eslint-disable-line react-hooks/exhaustive-deps

  const focusScan = () => setTimeout(() => {
    scanRef.current?.focus();
    scanRef.current?.select();
  }, 50);

  const doScan = async (raw: string) => {
    const sn = extractSn(raw);
    if (!sn) return;
    setSnText(sn);
    setLoading(true);
    try {
      const d = await stationGet(token, `/mes/scan/${encodeURIComponent(sn)}`);
      // 记住出现过的工序代码，供“工位锁定”选择
      const learned = { ...codes };
      (d.operations || []).forEach((o: Rec) => (learned[o.code] = o.name));
      if (JSON.stringify(learned) !== JSON.stringify(codes)) {
        setCodes(learned);
        const extra = Object.fromEntries(Object.entries(learned).filter(([k, v]) => DEFAULT_CODES[k] !== v));
        lsSet(LS_CODES, JSON.stringify(extra));
      }
      setValues({});
      setKeyLot('');
      setRemark('');
      setEquipmentId(d.next_operation?.requires_equipment ? defaultEq : undefined);
      setBanner(null);
      setScan(d);
    } catch (e) {
      setScan(null);
      if (authFailed(e)) return;
      setBanner({ kind: 'error', title: '扫码失败', body: errDetail(e) });
      focusScan();
    } finally {
      setLoading(false);
    }
  };

  /** 返工换件登记后刷新当前产品信息（不清除横幅） */
  const rescan = async () => {
    if (!scan) return;
    try {
      setScan(await stationGet(token, `/mes/scan/${encodeURIComponent(scan.sn)}`));
    } catch (e) {
      authFailed(e);
    }
  };

  const focusNext = (from: number) => {
    for (let i = from + 1; i < inputs.current.length; i++) {
      if (inputs.current[i]) {
        inputs.current[i]!.focus();
        return;
      }
    }
    submit('PASS');
  };

  const doSubmit = async (result: 'PASS' | 'FAIL') => {
    if (!scan || !next) return;
    const opText = `${next.seq} ${next.name}`;
    setSubmitting(true);
    try {
      const r = await stationPost(token, '/mes/report', {
        sn: scan.sn,
        seq: submitSeq,
        result: result === 'FAIL' ? 'FAIL' : undefined,
        values,
        equipment_id: equipmentId,
        remark: remark.trim() || undefined,
        key_parts: kp && keyLot.trim() ? [{ lot_no: keyLot.trim() }] : [],
      });
      const vals = r.values?.length ? <div style={{ marginTop: 8 }}><ValuesText values={r.values} /></div> : null;
      if (r.result === 'PASS') {
        setStats((s) => ({ ...s, pass: s.pass + 1 }));
        setBanner({
          kind: 'pass',
          title: `✓ 合格  ${r.sn}`,
          body: (
            <>
              <div style={{ fontSize: 18 }}>已通过【{opText}】</div>
              <div style={{ fontSize: 18, marginTop: 4 }}>
                {r.next_operation ? <>下一道工序：<b>{r.next_operation.seq} {r.next_operation.name}</b></> : r.sn_status === 'COMPLETED' ? <b>已完成全部工序，可完工入库</b> : null}
              </div>
              {vals}
            </>
          ),
        });
      } else {
        setStats((s) => ({ ...s, fail: s.fail + 1 }));
        setBanner({
          kind: 'fail',
          title: `✗ 不合格  ${r.sn}`,
          body: (
            <>
              <div style={{ fontSize: 18 }}>
                【{opText}】判定不合格，系统已自动开具 <b>{r.ncr_no}</b>（<Link to={`/quality/ncrs?q=${encodeURIComponent(r.ncr_no || '')}`}>查看</Link>）
              </div>
              <div style={{ fontSize: 18, marginTop: 4 }}>请贴不良标识放入不良品区，等待 QA 评审处置（返工/报废）。</div>
              {vals}
            </>
          ),
        });
      }
      setScan(null);
      setSnText('');
      focusScan();
    } catch (e) {
      if (authFailed(e)) return;
      setBanner({ kind: 'error', title: '⚠ 提交被拦截', body: <div style={{ fontSize: 18 }}>{errDetail(e)}</div> });
    } finally {
      setSubmitting(false);
    }
  };

  const submit = (result: 'PASS' | 'FAIL') => {
    if (!canReport || submitting) return;
    if (kp && !keyLot.trim()) {
      setBanner({ kind: 'error', title: '请先扫描关键件', body: `本工序需绑定关键件【${kp.code} ${kp.name}】的批号` });
      inputs.current[0]?.focus();
      return;
    }
    const missing = params.findIndex((p) => values[p.code!] === null || values[p.code!] === undefined);
    if (missing >= 0) {
      setBanner({ kind: 'error', title: '测试数据未录完', body: `请录入【${params[missing].name}】的测量值` });
      inputs.current[missing + 1]?.focus();
      return;
    }
    if (next?.requires_equipment && !equipmentId) {
      setBanner({ kind: 'error', title: '请选择设备/仪器', body: `工序【${next.name}】必须记录所用设备（校准有效期内）` });
      return;
    }
    if (result === 'FAIL') {
      if (!remark.trim()) {
        setBanner({ kind: 'error', title: '判不合格需填写原因', body: '请在“备注”中描述不良现象（如：外观划伤、按键失灵）' });
        remarkRef.current?.focus();
        return;
      }
      doSubmit('FAIL');
      return;
    }
    const out = params.filter((p) => inSpec(p, values[p.code!]) === false);
    if (out.length) {
      modal.confirm({
        title: '测试值超出规格',
        icon: <WarningOutlined style={{ color: '#cf1322' }} />,
        autoFocusButton: 'cancel',
        okText: '确认提交（判不合格）',
        okButtonProps: { danger: true },
        cancelText: '返回修改',
        content: (
          <div>
            {out.map((p) => (
              <div key={p.code} style={{ color: '#cf1322' }}>{p.name} = {num(values[p.code!])} {p.unit}（规格 {specText(p)}）</div>
            ))}
            <div style={{ marginTop: 8 }}>提交后系统将判定不合格并自动开具 NCR。如为录入错误请返回修改。</div>
          </div>
        ),
        onOk: () => doSubmit('PASS'),
      });
      return;
    }
    doSubmit('PASS');
  };

  const pickEq = (r?: Rec) => r && setEqRecs((m) => ({ ...m, [r.id]: r }));

  // ---------- 渲染 ----------
  inputs.current = [];
  const lockOptions = Object.entries(codes).map(([value, name]) => ({ value, label: `${value} ${name}` }));

  const scanAlerts: ReactNode[] = [];
  if (scan) {
    if (scan.open_ncr || scan.status === 'NG') {
      scanAlerts.push(
        <Alert key="ncr" type="error" showIcon message={<b style={{ fontSize: 18 }}>存在未处置 NCR，请联系 QA</b>}
          description={<>不合格报告 {scan.open_ncr ? <Link to={`/quality/ncrs?q=${encodeURIComponent(scan.open_ncr)}`}>{scan.open_ncr}</Link> : ''} 尚未评审处置，该产品已被隔离，不能继续过站。</>} />,
      );
    } else if (['COMPLETED', 'IN_STOCK', 'SHIPPED'].includes(scan.status)) {
      scanAlerts.push(<Alert key="done" type="success" showIcon message={`该产品已完成全部工序（${dictLabel('sn_status', scan.status)}）`} />);
    } else if (scan.status === 'SCRAPPED') {
      scanAlerts.push(<Alert key="scr" type="error" showIcon message="该产品已报废，禁止继续生产" />);
    } else if (!['RELEASED', 'IN_PROGRESS'].includes(scan.wo?.status)) {
      scanAlerts.push(<Alert key="wo" type="warning" showIcon message={`工单 ${scan.wo?.no} 当前为【${dictLabel('wo_status', scan.wo?.status)}】，不能报工`} />);
    }
    if (lockMissing) {
      scanAlerts.push(<Alert key="lm" type="error" showIcon message={`该产品工艺路线中没有本工位工序【${lockCode} ${codes[lockCode!] ?? ''}】，不能在本工位报工`} />);
    } else if (lockMismatch) {
      scanAlerts.push(
        <Alert key="lk" type="error" showIcon message={<b style={{ fontSize: 18 }}>防呆：工序不符</b>}
          description={`本工位锁定为【${lockedOp?.seq} ${lockedOp?.name}】，该产品的下一道工序是【${next!.seq} ${next!.name}】。禁止跳站/重复过站，提交将被系统拦截。`} />,
      );
    }
  }

  /** 生产履历 = 过站记录 + 返工换件（拆下/装上），按时间倒序 */
  const history: Rec[] = scan
    ? [
      ...(scan.history || []).map((h: Rec) => ({ ...h, _kind: 'record' })),
      ...(scan.key_parts || []).filter((k: Rec) => k.action !== 'BIND').map((k: Rec) => ({ ...k, _kind: 'part' })),
    ].sort((a, b) => dayjs(b.ts).valueOf() - dayjs(a.ts).valueOf())
    : [];

  if (!session) {
    return (
      <div className="station">
        <StationLock reason={lockReason} terminalUser={user ? `${user.full_name}（${user.username}）` : null} onUnlock={unlock} onExit={() => nav('/')} />
      </div>
    );
  }

  return (
    <div className="station">
      <style>{STATION_CSS}</style>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={[16, 12]} align="middle">
          <Col flex="none">
            <Typography.Title level={4} style={{ margin: 0 }}><ScanOutlined /> 工位终端</Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>终端账号：{user?.full_name ?? '-'}</Typography.Text>
          </Col>
          <Col flex="none">
            <div className="station-operator">
              <IdcardOutlined style={{ fontSize: 30, color: '#5b3cc4' }} />
              <div>
                <div style={{ fontSize: 12, color: '#8c8c9e' }}>当前操作员（报工记录归属）</div>
                <div className="name">{operator?.full_name}</div>
                <div style={{ fontSize: 12, color: '#8c8c9e' }}>
                  {operator?.username}{operator?.department ? ` · ${operator.department}` : ''} · {dayjs(session.since).format('HH:mm')} 起
                </div>
              </div>
              <Space direction="vertical" size={4}>
                <Button danger type="primary" icon={<PoweroffOutlined />} onClick={() => lock(`${operator?.full_name} 已交班，终端已锁定`)}>交班 / 锁定</Button>
                <Button size="small" icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>终端设置</Button>
              </Space>
            </div>
            {idleLeft !== null && <Typography.Text type="warning">无操作，{idleLeft} 秒后自动锁定</Typography.Text>}
          </Col>
          <Col flex="240px">
            <div style={{ fontSize: 12, color: '#8c8c9e' }}><LockOutlined /> 本工位工序（防跳站）</div>
            <Select size="large" allowClear placeholder="不锁定：按下一道工序" style={{ width: '100%' }} value={lockCode} options={lockOptions}
              onChange={(v) => {
                setLockCode(v);
                lsSet(LS_OP, v);
                focusScan();
              }} />
          </Col>
          <Col flex="280px">
            <div style={{ fontSize: 12, color: '#8c8c9e' }}><ToolOutlined /> 本工位默认设备/仪器</div>
            <EquipmentSelect size="large" params={{ status: 'NORMAL' }} placeholder="选择或扫描设备" style={{ width: '100%' }} value={defaultEq}
              onPick={pickEq}
              onChange={(v) => {
                setDefaultEq(v ?? undefined);
                lsSet(LS_EQ, v ? String(v) : null);
                if (scan && next?.requires_equipment) setEquipmentId(v ?? undefined);
                focusScan();
              }} />
            {defaultEq && calExpired(eqRecs[defaultEq]) && <Typography.Text type="danger" style={{ fontSize: 12 }}>该仪器校准已过期，系统将禁止使用</Typography.Text>}
          </Col>
          <Col flex="auto" style={{ textAlign: 'right' }}>
            <Space size={8}>
              <Tag color="green" style={{ fontSize: 16, padding: '4px 10px' }}>本次合格 {stats.pass}</Tag>
              <Tag color="red" style={{ fontSize: 16, padding: '4px 10px' }}>不合格 {stats.fail}</Tag>
            </Space>
          </Col>
        </Row>
      </Card>

      <Row gutter={16}>
        <Col xs={24} xl={15}>
          <Card style={{ marginBottom: 16 }}>
            <Input.Search
              ref={scanRef}
              size="large"
              autoFocus
              allowClear
              enterButton="查询"
              loading={loading}
              prefix={<ScanOutlined style={{ fontSize: 22, color: '#8c8c9e' }} />}
              placeholder="扫描产品序列号（也可直接扫 UDI 条码）"
              value={snText}
              onChange={(e) => setSnText(e.target.value)}
              onSearch={(v) => doScan(v)}
            />
          </Card>

          {banner && (
            <Card className={banner.kind === 'pass' ? 'station-result-pass' : 'station-result-fail'} style={{ marginBottom: 16 }}>
              <div className="station-banner-title" style={{ color: banner.kind === 'pass' ? '#389e0d' : '#cf1322' }}>{banner.title}</div>
              {banner.body && <div style={{ marginTop: 6 }}>{banner.body}</div>}
            </Card>
          )}

          {loading && !scan && <div style={{ textAlign: 'center', padding: 40 }}><Spin size="large" /></div>}

          {scan && (
            <Card style={{ marginBottom: 16 }}>
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Space wrap align="center">
                  <span style={{ fontSize: 22, fontWeight: 700 }}>{scan.product?.name}</span>
                  {scan.product?.model && <Tag color="blue" style={{ fontSize: 14 }}>{scan.product.model}</Tag>}
                  <StatusTag dict="sn_status" value={scan.status} />
                </Space>
                <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }} items={[
                  { key: 'sn', label: '序列号', children: <b className="mono" style={{ fontSize: 16 }}>{scan.sn}</b> },
                  { key: 'wo', label: '工单', children: <Link to={`/mes/work-orders/${scan.wo?.id}`}>{scan.wo?.no}</Link> },
                  { key: 'lot', label: '批号', children: <span className="mono">{scan.lot_no}</span> },
                  { key: 'c', label: '客户', children: scan.wo?.customer_name || '-' },
                  { key: 'q', label: '工单完工', children: `${num(scan.wo?.completed_qty)} / ${num(scan.wo?.planned_qty)}` },
                  { key: 'code', label: '产品编码', children: scan.product?.code },
                  { key: 'udi', label: 'UDI', span: 3, children: <span className="mono" style={{ wordBreak: 'break-all' }}>{scan.udi || '-'}</span> },
                ]} />
                <Steps
                  size="small"
                  labelPlacement="vertical"
                  items={ops.map((o) => ({
                    title: o.name,
                    description: o.code,
                    status: o.done ? 'finish' : o.seq === curSeq ? (scan.status === 'NG' ? 'error' : 'process') : 'wait',
                  }))}
                />
                {scanAlerts}
              </Space>
            </Card>
          )}

          {scan?.rework && ['RELEASED', 'IN_PROGRESS'].includes(scan.wo?.status) && (
            <ReworkPanel key={scan.sn} scan={scan} token={token} onDone={rescan} readOnly={!can('mes')} />
          )}

          {scan && next && (
            <Card style={{ marginBottom: 16, borderColor: lockMismatch || lockMissing ? '#ff4d4f' : '#5b3cc4', borderWidth: 2 }}>
              <Space direction="vertical" size={14} style={{ width: '100%' }}>
                <div>
                  <Typography.Text type="secondary">本次工序</Typography.Text>
                  <div className="station-op">
                    {next.seq} {next.name} <Tag color="purple" style={{ fontSize: 16, verticalAlign: 'middle' }}>{next.op_type_text || dictLabel('op_type', next.op_type)}</Tag>
                  </div>
                  <Typography.Text type="secondary">
                    {next.work_center_name || ''}{next.sop_no ? ` · 作业指导书 ${next.sop_no}` : ''}
                  </Typography.Text>
                  {next.instructions && <Alert type="info" style={{ marginTop: 8 }} message={<span style={{ whiteSpace: 'pre-wrap' }}>{next.instructions}</span>} />}
                </div>

                {kp && (
                  <div>
                    <div style={{ fontSize: 16, marginBottom: 4 }}>关键件：<b>{kp.code} {kp.name}</b>（扫描批号，用于单台追溯）</div>
                    <Input
                      size="large"
                      ref={(el) => {
                        inputs.current[0] = el;
                      }}
                      placeholder="扫描关键件批号"
                      value={keyLot}
                      onChange={(e) => setKeyLot(e.target.value)}
                      onPressEnter={() => focusNext(0)}
                    />
                  </div>
                )}

                {params.length > 0 && (
                  <Row gutter={[12, 12]}>
                    {params.map((p, i) => {
                      const v = values[p.code!];
                      const ok = inSpec(p, v);
                      return (
                        <Col xs={24} md={12} key={p.code}>
                          <div className={`station-param${ok === true ? ' ok' : ok === false ? ' ng' : ''}`}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 16 }}>
                              <b>{p.name}</b>
                              {ok !== null && <b style={{ color: ok ? '#389e0d' : '#cf1322' }}>{ok ? '✓ 合格' : '✗ 超差'}</b>}
                            </div>
                            <div style={{ color: '#8c8c9e', marginBottom: 6 }}>
                              规格：{specText(p)}{p.target !== null && p.target !== undefined ? `（目标 ${num(p.target)}）` : ''}
                            </div>
                            <InputNumber
                              size="large"
                              style={{ width: '100%' }}
                              ref={(el) => {
                                inputs.current[i + 1] = el;
                              }}
                              value={v ?? null}
                              suffix={p.unit}
                              status={ok === false ? 'error' : undefined}
                              placeholder="测量值"
                              onChange={(nv) => setValues((m) => ({ ...m, [p.code!]: nv === null || nv === undefined ? null : Number(nv) }))}
                              onPressEnter={() => focusNext(i + 1)}
                            />
                          </div>
                        </Col>
                      );
                    })}
                  </Row>
                )}

                <Row gutter={[12, 12]}>
                  <Col xs={24} md={12}>
                    <div style={{ fontSize: 14, marginBottom: 4 }}>
                      {next.requires_equipment && <span style={{ color: '#cf1322' }}>* </span>}设备/仪器{next.requires_equipment ? '（必填）' : '（选填）'}
                    </div>
                    <EquipmentSelect size="large" params={{ status: 'NORMAL' }} style={{ width: '100%' }} value={equipmentId} onPick={pickEq}
                      onChange={(v) => setEquipmentId(v ?? undefined)} />
                    {calExpired(selectedEq) && <Typography.Text type="danger">校准已过期（{selectedEq?.next_calibration_date || '未校准'}），禁止使用</Typography.Text>}
                  </Col>
                  <Col xs={24} md={12}>
                    <div style={{ fontSize: 14, marginBottom: 4 }}>备注（判不合格时必填：不良现象）</div>
                    <Input size="large" ref={remarkRef} value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="如：外观划伤" />
                  </Col>
                </Row>

                <Row gutter={12}>
                  <Col span={14}>
                    <Button block type="primary" className="station-btn" icon={<CheckOutlined />} loading={submitting} disabled={!canReport}
                      style={canReport ? { background: '#389e0d', borderColor: '#389e0d' } : undefined} onClick={() => submit('PASS')}>
                      合格提交
                    </Button>
                  </Col>
                  <Col span={10}>
                    <Button block danger className="station-btn" icon={<CloseOutlined />} loading={submitting} disabled={!canReport} onClick={() => submit('FAIL')}>
                      判不合格
                    </Button>
                  </Col>
                </Row>
                {!can('mes') && <Alert type="warning" showIcon message="当前操作员没有生产报工权限" />}
                {params.length > 0 && <Typography.Text type="secondary">提示：在最后一个测量值输入框按回车 = 合格提交；超出规格的值系统会自动判不合格并开具 NCR。</Typography.Text>}
              </Space>
            </Card>
          )}
        </Col>

        <Col xs={24} xl={9}>
          {scan ? (
            <Card title={`生产履历 - ${scan.sn}`} size="small">
              {history.length ? (
                <Timeline
                  style={{ marginTop: 8 }}
                  items={history.map((h: Rec, i: number) => (h._kind === 'part'
                    ? {
                      key: `p${i}`,
                      color: h.action === 'REMOVE' ? 'orange' : 'purple',
                      children: (
                        <div>
                          <Space size={4} wrap>
                            <KeyPartActionTag action={h.action} text={h.action_text} />
                            <b>{h.material_code} {h.material_name}</b>
                          </Space>
                          <div style={{ fontSize: 12 }}>
                            批号 <span className="mono">{h.lot_no || '-'}</span>{h.part_sn ? ` · 部件 ${h.part_sn}` : ''}{h.ncr_no ? ` · ${h.ncr_no}` : ''}
                          </div>
                          <div style={{ fontSize: 12, color: '#8c8c9e' }}>
                            {dayjs(h.ts).format('MM-DD HH:mm:ss')} · {h.operator_name || '-'}{h.remark ? ` · ${h.remark}` : ''}
                          </div>
                        </div>
                      ),
                    }
                    : {
                      key: `r${i}`,
                      color: h.result === 'PASS' ? 'green' : 'red',
                      children: (
                        <div>
                          <Space size={4} wrap>
                            <b>{h.seq} {h.op_name}</b>
                            <StatusTag dict="result" value={h.result} />
                            {h.is_rework && <Tag color="orange">返工</Tag>}
                          </Space>
                          <div style={{ fontSize: 12, color: '#8c8c9e' }}>
                            {dayjs(h.ts).format('MM-DD HH:mm:ss')} · {h.operator_name}{h.equipment_code ? ` · ${h.equipment_code}` : ''}
                          </div>
                          {h.values?.length > 0 && <div style={{ fontSize: 12 }}><ValuesText values={h.values} block /></div>}
                        </div>
                      ),
                    }))}
                />
              ) : <Empty description="尚未开始生产" />}
            </Card>
          ) : (
            <Card title="操作说明" size="small">
              <ol style={{ paddingLeft: 20, lineHeight: 2, fontSize: 15, margin: 0 }}>
                <li>上岗刷工牌并输入 PIN，报工记录归属到当前操作员；离开时点【交班 / 锁定】，无操作 {idleMinutes} 分钟自动锁定；</li>
                <li>（可选）设置本工位工序并选择默认仪器，下次打开自动记住；</li>
                <li>扫描产品序列号（或 UDI 条码），系统显示下一道工序与测试规格；</li>
                <li>依次录入测量值，绿色 = 合格、红色 = 超差，回车跳到下一项；</li>
                <li>点【合格提交】或判不合格，系统自动判定并记录到 DHR；</li>
                <li>不合格自动开具 NCR，产品被隔离，需 QA 处置后才能继续；返工时如更换零件，先在【返工换件】中登记再重新测试。</li>
              </ol>
              <Alert style={{ marginTop: 12 }} type="info" showIcon message="防呆：系统禁止跳站/重复过站，禁止使用校准过期的仪器，关键件批号必须是本工单已领用的批次；操作员须持有该工序的上岗资质。" />
            </Card>
          )}
        </Col>
      </Row>
      <StationSettings open={settingsOpen} minutes={idleMinutes} onClose={() => setSettingsOpen(false)}
        onSave={(m) => {
          saveIdleMinutes(m);
          setIdleMinutes(m);
          lastActive.current = Date.now();
          setSettingsOpen(false);
          message.success(`已设置：无操作 ${m} 分钟自动锁定`);
        }} />
    </div>
  );
}

/** 终端设置（保存在本机浏览器）：空闲自动锁定时间 */
function StationSettings({ open, minutes, onClose, onSave }: { open: boolean; minutes: number; onClose: () => void; onSave: (m: number) => void }) {
  const [form] = Form.useForm();
  return (
    <Modal open={open} title="工位终端设置" okText="保存" onCancel={onClose} destroyOnHidden
      afterOpenChange={(o) => o && form.setFieldsValue({ minutes })}
      onOk={async () => onSave((await form.validateFields()).minutes)}>
      <Alert type="info" showIcon style={{ marginBottom: 16 }} message="共用工位终端无人操作时自动锁定，需重新刷工牌才能继续，防止他人以当前操作员身份报工（GMP / 21 CFR Part 11 记录可归属）。设置仅保存在本终端。" />
      <Form form={form} layout="vertical">
        <Form.Item name="minutes" label="空闲自动锁定（分钟）" rules={[{ required: true, message: '请填写分钟数' }]}>
          <InputNumber min={1} max={240} precision={0} style={{ width: 200 }} suffix="分钟" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
