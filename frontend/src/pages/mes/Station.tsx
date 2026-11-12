/**
 * 工位终端（全屏工位模式，按车间一体机 1280×800 设计，无侧栏/顶栏/全局搜索，页面不滚动）。
 *
 * 好用性修复（docs/ux-review.md G5）：
 * - C-F01 [P0] 回车跳转失灵：录入框按 DOM 顺序跳转（station/fields.tsx），空闲倒计时隔离在 IdleGuard，不再每秒重渲染整页；
 *   数字框逐键过滤（一个小数点、小数位、合理范围），错误贴在框下且不前进；
 * - C-F03 无测试项工序：扫码后回车（或再扫一次）确认，或由班组长设为“扫码即过站”；
 * - C-F04 已过站 / 工序不符：整块红色大字说明谁何时测过、应送往哪道工序，不显示录入表；
 * - C-F05 / C-N2 焦点不在输入框时：含字母的输入转给扫码框，纯数字转给第一个未录的测量框（本页自己的全局键盘监听，读取最新状态）；
 *   测量框里出现字母（扫进条码）自动转回扫码框；任何弹窗关闭后焦点回到第一个未录的测量框；
 * - C-N1 “再扫一次本序列号 = 合格提交”在任何焦点下生效；“上一台未提交”全屏警告 + 提示音；
 * - C-N3 设定 / 设置 / 退出由班组长刷本人工牌 + PIN 授权（须 mes_lead）；
 * - N6 本人刷卡恢复后 1.5 秒内的纯数字（习惯性按的 PIN）被吞掉并大字提示；
 * - C-F06/F07/F08 全屏工位、退出与设置需班组长刷工牌 + PIN 授权、本工位工序由班组长设定后锁定、设备按适用工序校验；
 * - C-F12–F18 PIN、空闲锁定保留数据、解锁校验资质、关键件即时校验、不良代码、返工换件引导、整屏闪色 + 提示音。
 */
import { Alert, App, Button, Empty, Modal, Spin, Tag, Timeline } from 'antd';
import {
  CheckOutlined, CloseOutlined, FileImageOutlined, IdcardOutlined, LockOutlined, LogoutOutlined, PoweroffOutlined, ScanOutlined, SettingOutlined, StopOutlined, ToolOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import ScanInput, { type ScanInputHandle } from '../../components/ScanInput';
import { dictLabel } from '../../utils/dict';
import ReworkPanel, { KeyPartActionTag } from './ReworkPanel';
import { ValuesText, errDetail, inSpec, isOkNg, num, specText, type SpecParam } from './spec';
import StationLock from './StationLock';
import { feedback } from './station/feedback';
import { checkValue, findNext, focusField, KeyPartField, NumField, OkNgField, type FieldApi } from './station/fields';
import IdleGuard from './station/IdleGuard';
import { AuthModal, EquipmentPicker, FailDialog, SetupModal, type StationEq } from './station/StationDialogs';
import {
  httpStatus, loadConfig, loadSession, saveConfig, saveSession, stationBlob, stationGet, stationPost, type StationConfig, type StationSession,
} from './stationApi';

/** 作业指导附件：图片 / PDF 在工位上直接打开（用操作员令牌下载） */
function InstrFiles({ files, token, onClosed }: { files: Rec[]; token: string; onClosed?: () => void }) {
  const [view, setView] = useState<{ url: string; name: string; type: string } | null>(null);
  const openFile = async (f: Rec) => {
    try {
      const b = await stationBlob(token, `/attachments/${f.id}/download`);
      setView({ url: URL.createObjectURL(b), name: f.filename, type: f.content_type || b.type || '' });
    } catch (e) {
      Modal.error({ title: '附件打开失败', content: errDetail(e) });
    }
  };
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        {files.map((f) => (
          <Button key={f.id} size="large" icon={<FileImageOutlined />} onClick={() => openFile(f)} style={{ height: 48, maxWidth: '100%' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}>{f.filename}</span>
          </Button>
        ))}
      </div>
      <Modal open={!!view} title={view?.name} width="90vw" footer={null} centered destroyOnHidden afterClose={onClosed}
        onCancel={() => {
          if (view) URL.revokeObjectURL(view.url);
          setView(null);
        }}>
        {view && (view.type.startsWith('image/')
          ? <img src={view.url} alt={view.name} style={{ maxWidth: '100%', maxHeight: '72vh', display: 'block', margin: '0 auto' }} />
          : view.type.includes('pdf')
            ? <iframe title={view.name} src={view.url} style={{ width: '100%', height: '72vh', border: 0 }} />
            : <a href={view.url} download={view.name}>下载 {view.name}</a>)}
      </Modal>
    </>
  );
}

const STATION_CSS = `
.station-root { position: fixed; inset: 0; z-index: 900; display: flex; flex-direction: column; background: #eceef5; overflow: hidden; font-size: 16px; }
.station-root .mono { font-family: 'SFMono-Regular', Consolas, Menlo, monospace; }
.st-top { flex: none; height: 76px; display: flex; align-items: center; gap: 12px; padding: 0 12px; background: #1d1537; color: #fff; }
.st-top .lbl { font-size: 13px; color: rgba(255,255,255,.62); white-space: nowrap; }
.st-stop { min-width: 0; max-width: 300px; }
.st-stop .v { font-size: 22px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.st-oper { display: flex; align-items: center; gap: 10px; padding: 6px 12px; border-radius: 10px; background: rgba(255,255,255,.09); min-width: 0; }
.st-oper .name { font-size: 24px; font-weight: 800; line-height: 1.1; white-space: nowrap; }
.st-eq { flex: 1; min-width: 0; }
.st-eq .v { font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.st-eq .v.bad { color: #ff7875; }
.st-stats { display: flex; gap: 6px; }
.st-stats span { font-size: 17px; font-weight: 700; padding: 8px 10px; border-radius: 8px; white-space: nowrap; }
.st-stats .ok { background: #389e0d; } .st-stats .ng { background: #cf1322; }
.st-top .ant-btn.st-tbtn { height: 52px; min-width: 52px; font-size: 16px; padding: 0 12px; }
.st-main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 12px; padding: 12px; }
.st-left { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
.st-right { min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.st-card { background: #fff; border-radius: 10px; padding: 12px 14px; box-shadow: 0 1px 3px rgba(20,17,43,.08); }
.st-scan .ant-input-affix-wrapper { height: 62px; font-size: 24px; border: 2px solid #5b3cc4; border-radius: 10px; }
.st-scan .ant-input-affix-wrapper input { font-size: 24px; }
.st-scan .ant-input-clear-icon { font-size: 26px; padding: 8px; }
.st-banner { border-radius: 10px; padding: 10px 16px; border: 2px solid; }
.st-banner .t { font-size: 26px; font-weight: 800; line-height: 1.25; }
.st-banner .b { font-size: 17px; margin-top: 2px; }
.st-banner.pass { background: #f6ffed; border-color: #52c41a; color: #237804; }
.st-banner.fail, .st-banner.error { background: #fff1f0; border-color: #ff4d4f; color: #a8071a; }
.st-banner.warn { background: #fffbe6; border-color: #faad14; color: #874d00; padding: 4px 14px; }
.st-banner.warn .t { font-size: 17px; font-weight: 700; }
.st-prod { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; }
.st-sn { font-size: 28px; font-weight: 800; white-space: nowrap; letter-spacing: .5px; }
.st-prod .info { font-size: 15px; color: #595970; }
.st-ops { display: flex; flex-wrap: nowrap; gap: 6px; width: 100%; overflow: hidden; }
.st-chip { font-size: 14px; padding: 3px 10px; border-radius: 14px; background: #f0f0f5; color: #8c8c9e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px; flex: 0 1 auto; }
.st-chip.cur { max-width: none; flex: none; }
.st-chip.done { background: #f6ffed; color: #389e0d; } .st-chip.cur { background: #5b3cc4; color: #fff; font-weight: 700; }
.st-chip.ng { background: #ff4d4f; color: #fff; }
.st-blocked { background: #cf1322; color: #fff; border-radius: 12px; padding: 22px 26px; }
.st-blocked .t { font-size: 34px; font-weight: 900; line-height: 1.2; }
.st-blocked .m { font-size: 22px; margin-top: 10px; line-height: 1.45; }
.st-blocked .to { font-size: 30px; font-weight: 800; margin-top: 14px; background: rgba(255,255,255,.16); border-radius: 8px; padding: 8px 14px; display: inline-block; }
.st-blocked .h { font-size: 16px; margin-top: 12px; opacity: .85; }
.st-form { border: 2px solid #5b3cc4; }
.st-form-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.st-form-head .op { font-size: 26px; font-weight: 800; }
.st-params { display: grid; gap: 10px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.st-params.c3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.station-param { border-left: 6px solid #d9d9d9; padding: 6px 10px 2px; border-radius: 8px; background: #fafafc; min-width: 0; }
.station-param.wide { grid-column: 1 / -1; }
.station-param.ok { border-left-color: #52c41a; background: #f6ffed; }
.station-param.ng { border-left-color: #ff4d4f; background: #fff1f0; }
.station-param.err { border-left-color: #ff4d4f; background: #fff1f0; box-shadow: 0 0 0 2px #ff4d4f inset; }
.station-param .sp-head { display: flex; justify-content: space-between; gap: 8px; font-size: 17px; }
.station-param .sp-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.station-param .sp-spec { font-size: 15px; color: #3f3f55; margin-bottom: 4px; }
.station-param .sp-input { position: relative; }
.station-param .sp-num { width: 100%; height: 54px; font-size: 26px; font-weight: 700; padding: 0 64px 0 12px; border: 2px solid #c9c9d6; border-radius: 8px; outline: none; background: #fff; }
.station-param .sp-num:focus { border-color: #5b3cc4; box-shadow: 0 0 0 4px rgba(91,60,196,.22); background: #fffef0; }
.station-param.err .sp-num { border-color: #ff4d4f; }
.station-param .sp-unit { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); font-size: 16px; color: #595970; pointer-events: none; }
.station-param .sp-err { min-height: 20px; font-size: 15px; font-weight: 700; color: #cf1322; line-height: 20px; }
.sp-err { color: #cf1322; font-weight: 700; }
.station-param .sp-okng { display: flex; gap: 8px; }
.station-param .sp-okng-val { width: 110px; height: 54px; font-size: 24px; font-weight: 800; text-align: center; border: 2px solid #c9c9d6; border-radius: 8px; outline: none; caret-color: transparent; }
.station-param .sp-okng-val:focus { border-color: #5b3cc4; box-shadow: 0 0 0 4px rgba(91,60,196,.22); }
.station-param .sp-btn { flex: 1; height: 54px; font-size: 22px; font-weight: 800; border-radius: 8px; border: 2px solid #d9d9d9; background: #fff; cursor: pointer; }
.station-param .sp-btn.ok.on { background: #389e0d; color: #fff; border-color: #389e0d; }
.station-param .sp-btn.ng.on { background: #cf1322; color: #fff; border-color: #cf1322; }
.st-eqline { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.st-eqline .ant-select-selector { min-height: 52px !important; }
.st-buttons { display: flex; gap: 12px; margin-top: 10px; }
.st-buttons .ant-btn { height: 64px; font-size: 22px; font-weight: 700; border-radius: 10px; }
.st-buttons .pass:not(:disabled) { background: #389e0d; border-color: #389e0d; }
.st-buttons .pass:focus-visible { outline: 4px solid #95de64; outline-offset: 2px; }
.st-hint { font-size: 14px; color: #6b6b80; margin-top: 6px; }
.st-instr { white-space: pre-wrap; font-size: 15px; line-height: 1.6; }
.st-right h4 { margin: 0 0 6px; font-size: 16px; }
.st-right .ant-timeline-item { padding-bottom: 10px; }
.station-btn { height: 64px; font-size: 22px; font-weight: 700; }
.station-btn-md { height: 56px !important; font-size: 18px !important; font-weight: 600; }
.station-defects { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.station-defect { height: 72px; font-size: 20px; font-weight: 700; border-radius: 10px; border: 2px solid #ffccc7; background: #fff; cursor: pointer; text-align: left; padding: 0 14px; }
.station-defect .k { display: inline-block; width: 28px; height: 28px; line-height: 28px; text-align: center; border-radius: 50%; background: #f0f0f5; margin-right: 8px; font-size: 16px; }
.station-defect.on { background: #cf1322; border-color: #cf1322; color: #fff; }
.station-defect.on .k { background: rgba(255,255,255,.3); }
.station-rework { background: #fff; border: 2px solid #fa8c16; border-radius: 10px; padding: 8px 12px 0; }
.rw-head { font-size: 16px; }
.rw-qa { font-size: 16px; margin-top: 4px; padding: 4px 10px; border-radius: 6px; background: #fffbe6; border: 1px solid #ffe58f; }
.rw-qa.must { background: #fff1f0; border-color: #ffa39e; color: #a8071a; }
.rw-done { font-size: 14px; margin-top: 6px; }
.rw-step { display: flex; align-items: center; gap: 8px; margin: 6px 0 4px; font-size: 15px; }
.rw-cands { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.rw-cand { min-height: 46px; text-align: left; padding: 3px 8px; border-radius: 8px; border: 2px solid #ffd591; background: #fff; cursor: pointer; font-size: 14px; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rw-cand.sug { border-color: #fa541c; }
.rw-cand.on { background: #fa8c16; border-color: #fa8c16; color: #fff; }
.rw-cand .rw-sub { font-size: 12px; opacity: .8; overflow: hidden; text-overflow: ellipsis; }
.rw-list { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.rw-row { display: flex; align-items: center; gap: 8px; font-size: 15px; background: #fafafc; border-radius: 8px; padding: 2px 4px 2px 8px; }
.rw-row .rw-mat { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rw-row .rw-del { width: 44px; height: 44px; }
.rw-bar { position: sticky; bottom: 0; display: flex; gap: 12px; padding: 8px 0 10px; margin-top: 8px; background: #fff; border-top: 1px solid #f0f0f0; z-index: 2; }
.station-idle { position: fixed; inset: 0; z-index: 1400; background: rgba(20,17,43,.78); color: #fff; display: flex; align-items: center; justify-content: center; text-align: center; }
.station-idle-num { font-size: 120px; font-weight: 900; line-height: 1; margin-top: 8px; }
.station-idle-title { font-size: 34px; font-weight: 800; }
.station-idle-sub { font-size: 18px; opacity: .85; margin-top: 10px; max-width: 640px; }
.st-notice { position: fixed; inset: 0; z-index: 1300; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; pointer-events: none; padding: 24px; }
.st-notice.warn { background: rgba(212,107,8,.9); color: #fff; }
.st-notice.ok { background: rgba(56,158,13,.88); color: #fff; }
.st-notice .t { font-size: 40px; font-weight: 900; line-height: 1.3; }
.st-notice .s { font-size: 22px; margin-top: 12px; opacity: .95; }
.st-setup { position: fixed; inset: 0; z-index: 950; display: flex; align-items: center; justify-content: center; background: radial-gradient(circle at 50% 30%, #2b2357 0%, #14112b 70%); color: #fff; text-align: center; }
`;

interface Banner {
  kind: 'pass' | 'fail' | 'error' | 'warn';
  title: string;
  body?: ReactNode;
}

const hasParams = (d: Rec | null) => !!d?.next_operation?.params?.length;
/** 本台没有需要录入的内容（无测试项、无关键件） */
const noInput = (d: Rec | null) => !!d?.next_operation && !hasParams(d) && !d.key_part_material;

export default function Station() {
  const { user } = useAuth();
  const { modal, message } = App.useApp();
  const nav = useNavigate();
  const [cfg, setCfg] = useState<StationConfig>(loadConfig);
  const [session, setSession] = useState<StationSession | null>(() => loadSession(loadConfig().idle_minutes));
  const [lockReason, setLockReason] = useState<string | null>(() => (session?.locked ? `超过 ${cfg.idle_minutes} 分钟无操作，终端已自动锁定` : null));
  const [dialog, setDialog] = useState<null | 'auth-settings' | 'auth-exit' | 'settings'>(null);
  const [authedBy, setAuthedBy] = useState('');
  const [eqList, setEqList] = useState<StationEq[]>([]);
  const [scan, setScan] = useState<Rec | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [stats, setStats] = useState({ pass: 0, fail: 0 });
  const [equipmentId, setEquipmentId] = useState<number | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [failOpen, setFailOpen] = useState(false);
  const [reworkReady, setReworkReady] = useState(false);

  const scanRef = useRef<ScanInputHandle>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const passBtnRef = useRef<HTMLButtonElement>(null);
  /** 测量值 / 关键件批号：录入时同步写入，提交时读取（录入过程中不触发整页重渲染） */
  const values = useRef<Record<string, number | null>>({});
  const keyLot = useRef('');
  const fields = useRef(new Map<string, FieldApi>());
  const busy = useRef({ scan: false, submit: false });
  /** 本人刷卡恢复的时间（随后 1.5 秒内的纯数字视为习惯性按的 PIN，吞掉） */
  const resumedAt = useRef(0);
  /** 全屏提示（“上一台未提交”警告 / 已恢复作业） */
  const [notice, setNotice] = useState<{ kind: 'warn' | 'ok'; title: string; sub?: string } | null>(null);
  /** 最新的处理函数（全局键盘监听 / 定时器里调用，保证读到最新状态，C-N1） */
  const latest = useRef<{ runScan: (c: string) => void; focusStart: () => void }>({ runScan: () => undefined, focusStart: () => undefined });

  const locked = !session || !!session.locked;
  const token = session?.token ?? '';
  const operator = session?.user;
  const canMes = !!operator?.permissions?.includes('mes');
  const configured = !!cfg.op_code;
  const sound = cfg.sound;

  const register = useCallback((code: string, api: FieldApi | null) => {
    if (api) fields.current.set(code, api);
    else fields.current.delete(code);
  }, []);

  // 本工位可选设备（按工序标注能否使用）
  useEffect(() => {
    if (!cfg.op_code) return;
    get('/mes/station/equipment', { op_type: cfg.op_type, op_name: cfg.op_name, work_center_id: cfg.work_center_id ?? '' }, true)
      .then(setEqList)
      .catch(() => setEqList([]));
  }, [cfg.op_code, cfg.op_type, cfg.op_name, cfg.work_center_id]);

  const usableEq = (id?: number | null) => (id ? eqList.find((e) => e.id === id && !e.issue) : undefined);
  /** 本台默认设备：终端默认设备（可用时）；工序必须记录设备且只有一台可用时自动带出 */
  const defaultEq = (d: Rec): number | undefined => {
    if (usableEq(cfg.equipment_id)) return cfg.equipment_id!;
    const ok = eqList.filter((e) => !e.issue);
    return d.next_operation?.requires_equipment && ok.length === 1 ? ok[0].id : undefined;
  };

  const clearWork = () => {
    setScan(null);
    setBanner(null);
    values.current = {};
    keyLot.current = '';
    setReworkReady(false);
    setFailOpen(false);
  };

  const focusScan = () => setTimeout(() => scanRef.current?.focus(), 0);

  /** 交班：清除操作员与屏幕上的数据 */
  const handover = () => {
    saveSession(null);
    setSession(null);
    setLockReason(`${operator?.full_name ?? ''} 已交班，终端已锁定`);
    clearWork();
  };

  /** 空闲锁定：保留会话与未提交数据，本人刷工牌即可继续 */
  const lockIdle = () => {
    if (!session) return;
    const n = { ...session, locked: true };
    saveSession(n);
    setSession(n);
    setLockReason(`超过 ${cfg.idle_minutes} 分钟无操作，终端已自动锁定`);
    setFailOpen(false);
  };

  /** 工位请求出错：令牌失效 → 锁定重新刷卡 */
  const authFailed = (e: unknown) => {
    if (httpStatus(e) === 401) {
      saveSession(null);
      setSession(null);
      setLockReason('登录已失效，请重新刷工牌');
      return true;
    }
    return false;
  };

  /** 当前屏幕上未提交的内容（锁屏提示 / 切换产品提示） */
  const pending = (): string | null => {
    if (!scan || (scan.station && !scan.station.ok) || !scan.next_operation) return null;
    const n = Object.values(values.current).filter((v) => v !== null && v !== undefined).length + (keyLot.current ? 1 : 0);
    return n ? `${scan.sn}（已录 ${n} 项）` : scan.sn;
  };

  const focusStart = () => {
    const st = scan?.station;
    if (!scan || (st && !st.ok)) {
      scanRef.current?.focus();
      return;
    }
    // 返工中：焦点到②“扫描新零件批号”（N5）
    const rw = document.querySelector<HTMLInputElement>('[data-rework-lot]');
    if (rw) {
      rw.focus();
      return;
    }
    const all = Array.from(formRef.current?.querySelectorAll<HTMLInputElement>('[data-sfield]') ?? []);
    const first = all.find((x) => !x.value) ?? all[0];
    if (first) focusField(first);
    else if (passBtnRef.current && !passBtnRef.current.disabled) passBtnRef.current.focus();
    else scanRef.current?.focus();
  };

  // 扫码 / 返工步骤完成后：焦点到第一个录入框（无录入项时到【合格提交】，回车即提交）
  useEffect(() => {
    if (!formKey) return;
    const t = setTimeout(focusStart, 0);
    return () => clearTimeout(t);
  }, [formKey, reworkReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const unlock = async (s: StationSession): Promise<string | null> => {
    if (cfg.op_code) {
      try {
        const q = await stationGet(s.token, '/mes/station/qualification', { op_code: cfg.op_code });
        if (!q.ok) return `${s.user.full_name} 不能在本工位作业：${q.message}`;
      } catch (e) {
        return errDetail(e);
      }
    }
    if (!session || session.user.id !== s.user.id) {
      clearWork();
      setStats({ pass: 0, fail: 0 });
    }
    saveSession(s);
    setSession(s);
    setLockReason(null);
    message.success(`${s.user.full_name}，开始作业：报工记录将归属到您名下`);
    setTimeout(focusStart, 150);
    return null;
  };

  const resume = async (badge: string): Promise<string | null> => {
    if (!session) return '会话已失效';
    try {
      await stationPost(session.token, '/mes/station/resume', { badge_no: badge });
    } catch (e) {
      return httpStatus(e) === 401 ? '登录已过期' : errDetail(e);
    }
    const n = { ...session, locked: false, last: Date.now() };
    saveSession(n);
    setSession(n);
    setLockReason(null);
    // 习惯性接着按的 PIN 数字在 1.5 秒内吞掉，并大字提示（N6）
    resumedAt.current = Date.now();
    setNotice({ kind: 'ok', title: `${session.user.full_name}，已恢复作业`, sub: `无需输入 PIN${scan ? '，已保留的数据可继续录入' : ''}` });
    setTimeout(() => setNotice((x) => (x?.kind === 'ok' ? null : x)), 1800);
    setTimeout(focusStart, 150);
    return null;
  };

  // ---------------- 报工 ----------------
  const doSubmit = async (result: 'PASS' | 'FAIL', fail?: { code: string; remark: string }, d: Rec | null = scan, eqId: number | undefined = equipmentId) => {
    if (!d?.next_operation || busy.current.submit) return;
    busy.current.submit = true;
    setSubmitting(true);
    const op = d.next_operation;
    const opText = `${op.seq} ${op.name}`;
    try {
      const r = await stationPost(token, '/mes/report', {
        sn: d.sn,
        seq: op.seq,
        result: result === 'FAIL' ? 'FAIL' : undefined,
        defect_code: fail?.code,
        remark: fail?.remark || undefined,
        values: values.current,
        equipment_id: eqId,
        key_parts: d.key_part_material && keyLot.current ? [{ lot_no: keyLot.current }] : [],
      });
      setFailOpen(false);
      const vals = r.values?.length ? <div style={{ marginTop: 4, fontSize: 15 }}><ValuesText values={r.values} /></div> : null;
      if (r.result === 'PASS') {
        setStats((s) => ({ ...s, pass: s.pass + 1 }));
        setBanner({
          kind: 'pass',
          title: `✓ 合格  ${r.sn}`,
          body: (
            <>
              已通过【{opText}】
              {r.next_operation ? <>，请送往 <b>{r.next_operation.seq} {r.next_operation.name}</b></> : r.sn_status === 'COMPLETED' ? <b>，已完成全部工序，可完工入库</b> : null}
              {vals}
            </>
          ),
        });
        feedback('pass', sound);
      } else {
        setStats((s) => ({ ...s, fail: s.fail + 1 }));
        setBanner({
          kind: 'fail',
          title: `✗ 不合格  ${r.sn}`,
          body: (
            <>
              【{opText}】判定不合格，已自动开具 <b>{r.ncr_no}</b>。请贴不良标识放入不良品区，等待 QA 处置。
              <div style={{ fontSize: 15 }}>如为录入错误：请通知 QA 将 {r.ncr_no} 处置为“返工”后重新测试。</div>
              {vals}
            </>
          ),
        });
        feedback('fail', sound);
      }
      values.current = {};
      keyLot.current = '';
      setScan(null);
      focusScan();
    } catch (e) {
      if (authFailed(e)) return;
      const msg = errDetail(e);
      // 错误贴到对应的录入框
      const p = ((op.params || []) as SpecParam[]).find((x) => msg.includes(`【${x.name}】`));
      const f = p ? fields.current.get(p.code!) : /关键件/.test(msg) ? fields.current.get('__key_part__') : undefined;
      if (f) {
        f.setError(msg);
        f.focus();
      }
      setBanner({ kind: 'error', title: '⚠ 提交被拦截', body: msg });
      feedback('error', sound);
    } finally {
      busy.current.submit = false;
      setSubmitting(false);
    }
  };

  const fieldError = (code: string, msg: string) => {
    const f = fields.current.get(code);
    f?.setError(msg);
    f?.focus();
    feedback('error', sound);
  };

  /** 合格提交：依次检查关键件、测试值（缺项/合理范围）、设备；超规格二次确认（默认焦点“返回修改”） */
  const submitPass = () => {
    const d = scan;
    if (!d?.next_operation || locked || busy.current.submit) return;
    if (d.station && !d.station.ok) return;
    if (!canMes) {
      setBanner({ kind: 'error', title: '当前操作员没有生产报工权限' });
      return;
    }
    if (d.rework && !reworkReady && !d.rework.registered) {
      setBanner({ kind: 'error', title: '请先完成返工换件登记', body: '登记换件，或确认【未更换零件，直接重测】后再录入测试数据' });
      feedback('error', sound);
      return;
    }
    if (d.key_part_material && !keyLot.current) return fieldError('__key_part__', '请先扫描关键件批号');
    const params: SpecParam[] = d.next_operation.params || [];
    for (const p of params) {
      const v = values.current[p.code!];
      if (v === null || v === undefined) return fieldError(p.code!, isOkNg(p) ? '请判定：按 1 = OK，按 0 = NG' : '请录入测量值');
      if (!isOkNg(p)) {
        const c = checkValue(p, String(v));
        if (c.error) return fieldError(p.code!, c.error);
      }
    }
    if (d.next_operation.requires_equipment && !equipmentId) {
      setBanner({ kind: 'error', title: '请选择设备/仪器', body: `工序【${d.next_operation.name}】必须记录所用设备（校准有效期内）：在下方选择，或直接扫描设备编号` });
      feedback('error', sound);
      return;
    }
    const out = params.filter((p) => inSpec(p, values.current[p.code!]) === false);
    if (out.length) {
      modal.confirm({
        title: <span style={{ fontSize: 20 }}>测试值超出规格</span>,
        icon: <WarningOutlined style={{ color: '#cf1322' }} />,
        autoFocusButton: 'cancel',
        width: 560,
        okText: '确认提交（判不合格）',
        okButtonProps: { danger: true, size: 'large' },
        cancelText: '返回修改',
        cancelButtonProps: { size: 'large' },
        content: (
          <div style={{ fontSize: 17 }}>
            {out.map((p) => (
              <div key={p.code} style={{ color: '#cf1322' }}>
                {p.name} = {isOkNg(p) ? 'NG' : `${num(values.current[p.code!])} ${p.unit ?? ''}`}（规格 {specText(p)}）
              </div>
            ))}
            <div style={{ marginTop: 8 }}>提交后系统判定不合格并自动开具 NCR。如为录入错误请返回修改。</div>
          </div>
        ),
        onOk: () => doSubmit('PASS'),
        onCancel: () => setTimeout(() => fields.current.get(out[0].code!)?.focus(), 400),
      });
      return;
    }
    doSubmit('PASS');
  };

  /** 回车跳到下一个录入框；最后一项回车 = 合格提交 */
  const onFieldDone = (el: HTMLElement) => {
    const nx = findNext(formRef.current, el);
    if (nx) focusField(nx);
    else submitPass();
  };

  // ---------------- 扫码 ----------------
  const runScan = async (raw: string) => {
    const code = raw.trim();
    if (!code || locked) return;
    // 扫到设备编号：切换本台使用的设备/仪器
    const eq = eqList.find((e) => e.code.toUpperCase() === code.toUpperCase());
    if (eq) {
      if (eq.issue) {
        setBanner({ kind: 'error', title: `设备 ${eq.code} 不能使用`, body: eq.issue });
        feedback('error', sound);
      } else {
        setEquipmentId(eq.id);
        message.success(`已选择设备：${eq.code} ${eq.name}`);
        setTimeout(focusStart, 0);
      }
      return;
    }
    // 同一序列号再扫一次 = 确认过站（无录入项的工序）
    if (scan && scan.sn.toUpperCase() === code.toUpperCase() && noInput(scan) && scan.station?.ok !== false) {
      submitPass();
      return;
    }
    // 纯数字的短串不是序列号（多半是测量值打到了扫码框）：不清掉当前产品（C-N2）
    if (!/[A-Za-z(\]]/.test(code) && code.length < 13) {
      setBanner({ kind: 'warn', title: `“${code}” 不是序列号（纯数字），已忽略`, body: scan ? '测量值请录在测量框里；当前产品保持不变' : '请扫描产品序列号' });
      feedback('warn', sound);
      setTimeout(() => latest.current.focusStart(), 0);
      return;
    }
    if (!configured) {
      setBanner({ kind: 'error', title: '本工位尚未设定工序', body: '请班组长点右上角【设置】设定本工位工序后再作业' });
      feedback('error', sound);
      return;
    }
    if (busy.current.scan) return;
    busy.current.scan = true;
    setLoading(true);
    const prev = scan && !busy.current.submit ? pending() : null;
    try {
      const d = await stationGet(token, `/mes/scan/${encodeURIComponent(code)}`, { op: cfg.op_code });
      values.current = {};
      keyLot.current = '';
      setReworkReady(false);
      const eqId = defaultEq(d);
      setEquipmentId(eqId);
      setScan(d);
      setFormKey((k) => k + 1);
      const switched = !!prev && prev !== d.sn && !prev.startsWith(`${d.sn}（`);
      if (switched) {
        // 上一台还没提交（未过站）：全屏警告 + 提示音（C-N1），并留一行黄条
        setNotice({ kind: 'warn', title: `上一台 ${prev} 还没有提交（未过站）`, sub: `已切换到 ${d.sn}。如上一台已完成本工序，请重新扫码提交` });
        setTimeout(() => setNotice((x) => (x?.kind === 'warn' ? null : x)), 2600);
      }
      if (d.station && !d.station.ok) {
        setBanner(switched ? { kind: 'warn', title: `上一台 ${prev} 未提交` } : null);
        feedback('error', sound);
      } else {
        setBanner(switched ? { kind: 'warn', title: `上一台 ${prev} 未提交，已切换到 ${d.sn}` } : null);
        if (switched) feedback('error', sound);
        if (cfg.pass_mode === 'scan' && noInput(d) && !d.rework && canMes && (!d.next_operation.requires_equipment || eqId)) {
          await doSubmit('PASS', undefined, d, eqId);
        }
      }
    } catch (e) {
      if (authFailed(e)) return;
      setScan(null);
      setBanner({ kind: 'error', title: '扫码失败', body: errDetail(e) });
      feedback('error', sound);
    } finally {
      busy.current.scan = false;
      setLoading(false);
    }
  };

  /** 返工换件登记后刷新当前产品（不清除已录数据） */
  const rescan = async () => {
    if (!scan) return;
    try {
      setScan(await stationGet(token, `/mes/scan/${encodeURIComponent(scan.sn)}`, { op: cfg.op_code }));
      setReworkReady(true);
    } catch (e) {
      authFailed(e);
    }
  };

  // 全局键盘（C-N1 / C-N2 / N6）：焦点不在输入框（如在按钮上、弹窗刚关闭）时，
  // 纯数字 / 小数点 / 负号 → 交给第一个未录的测量框；其他字符（条码）→ 交给扫码框。按键随焦点进入目标框，不会丢。
  latest.current = { runScan: (c: string) => void runScan(c), focusStart };
  const blockedKeys = useRef(false);
  blockedKeys.current = locked || !configured || !!dialog || failOpen;
  useEffect(() => {
    const editable = (el: Element | null) =>
      !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable);
    const modalOpen = () => Array.from(document.querySelectorAll<HTMLElement>('.ant-modal-wrap')).some((m) => getComputedStyle(m).display !== 'none');
    const onKey = (e: KeyboardEvent) => {
      if (Date.now() - resumedAt.current < 1500 && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (blockedKeys.current || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      if (editable(document.activeElement) || modalOpen()) return;
      if (/^[0-9.\-]$/.test(e.key)) {
        const f = Array.from(document.querySelectorAll<HTMLInputElement>('.st-form input.sp-num[data-sfield]')).find((x) => !x.value);
        if (f) {
          f.focus();
          return;
        }
      }
      scanRef.current?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // ---------------- 渲染 ----------------
  const next: Rec | null = scan?.next_operation || null;
  const st = scan?.station;
  const blocked = !!(scan && st && !st.ok);
  const showRework = !!(scan && !blocked && scan.rework && !reworkReady && !scan.rework.registered);
  const params: SpecParam[] = next?.params || [];
  const kp: Rec | null = scan?.key_part_material || null;
  const ops: Rec[] = scan?.operations || [];
  const curSeq: number | undefined = next?.seq ?? (scan?.status === 'NG' ? ops.find((o) => !o.done)?.seq : undefined);
  const eqSel = equipmentId ? eqList.find((e) => e.id === equipmentId) : undefined;
  const cfgEq = cfg.equipment_id ? eqList.find((e) => e.id === cfg.equipment_id) : undefined;
  const topEq = eqSel ?? cfgEq;
  const canReport = !!(scan && next && canMes && !blocked && ['RELEASED', 'IN_PROGRESS'].includes(scan.wo?.status));
  const fieldCount = params.length + (kp ? 1 : 0);

  const history: Rec[] = scan
    ? [
      ...(scan.history || []).map((h: Rec) => ({ ...h, _kind: 'record' })),
      ...(scan.key_parts || []).filter((k: Rec) => k.action !== 'BIND').map((k: Rec) => ({ ...k, _kind: 'part' })),
    ].sort((a, b) => dayjs(b.ts).valueOf() - dayjs(a.ts).valueOf())
    : [];

  const openSettings = () => setDialog('auth-settings');
  const terminalText = user ? `${user.full_name}（${user.username}）` : null;
  const stationText = configured ? `本工位：${cfg.op_code} ${cfg.op_name}` : null;

  return (
    <div className="station-root">
      <style>{STATION_CSS}</style>
      <header className="st-top">
        <div className="st-stop">
          <div className="lbl"><LockOutlined /> 本工位工序（班组长设定）</div>
          <div className="v">{configured ? `${cfg.op_code} ${cfg.op_name}` : '未设定'}</div>
        </div>
        <div className="st-oper">
          <IdcardOutlined style={{ fontSize: 28, color: '#b7a6ff' }} />
          <div>
            <div className="lbl">当前操作员</div>
            <div className="name">{operator?.full_name ?? '—'}</div>
          </div>
          {session && <div className="lbl">{operator?.username}<br />{dayjs(session.since).format('HH:mm')} 起</div>}
        </div>
        <div className="st-eq">
          <div className="lbl"><ToolOutlined /> 设备/仪器</div>
          <div className={`v${topEq?.issue ? ' bad' : ''}`}>{topEq ? `${topEq.code} ${topEq.name}${topEq.issue ? '（不可用）' : ''}` : '未选择（可直接扫设备编号）'}</div>
        </div>
        <div className="st-stats">
          <span className="ok">合格 {stats.pass}</span>
          <span className="ng">不合格 {stats.fail}</span>
        </div>
        <Button className="st-tbtn" danger type="primary" icon={<PoweroffOutlined />} disabled={!session} onClick={handover}>交班/锁定</Button>
        <Button className="st-tbtn" icon={<SettingOutlined />} onClick={openSettings} aria-label="终端设置">设置</Button>
        <Button className="st-tbtn" icon={<LogoutOutlined />} onClick={() => setDialog('auth-exit')} aria-label="退出工位">退出</Button>
      </header>

      <main className="st-main">
        <section className="st-left">
          <div className="st-scan">
            <ScanInput
              ref={scanRef}
              disabled={locked || !configured || !!dialog || failOpen}
              placeholder="扫描产品序列号（也可直接扫 UDI 条码）"
              prefix={<ScanOutlined style={{ fontSize: 26, color: '#5b3cc4' }} />}
              onScan={(c) => {
                void latest.current.runScan(c);
              }}
            />
          </div>

          {banner && (
            <div className={`st-banner ${banner.kind}`} role="status">
              <div className="t">{banner.title}</div>
              {banner.body && <div className="b">{banner.body}</div>}
            </div>
          )}

          {loading && !scan && <div style={{ textAlign: 'center', padding: 24 }}><Spin size="large" /></div>}

          {scan && (
            <div className="st-card st-prod">
              <span className="st-sn mono">{scan.sn}</span>
              <span className="info">
                <b style={{ color: '#1d1537' }}>{scan.product?.name}</b>
                {scan.product?.model ? ` ${scan.product.model}` : ''} · 工单 {scan.wo?.no} · 批号 <span className="mono">{scan.lot_no}</span> · 完工 {num(scan.wo?.completed_qty)}/{num(scan.wo?.planned_qty)}
              </span>
              <div className="st-ops">
                {ops.map((o) => (
                  <span key={o.seq} className={`st-chip${o.done ? ' done' : o.seq === curSeq ? (scan.status === 'NG' ? ' ng' : ' cur') : ''}`}>
                    {o.done ? '✓ ' : ''}{o.seq} {o.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {blocked && (
            <div className="st-blocked" role="alert">
              <div className="t"><StopOutlined /> {st.title}</div>
              <div className="m">{st.message}</div>
              {st.send_to && ['PASSED', 'EARLY', 'NOT_IN_ROUTING'].includes(st.kind) && (
                <div className="to">→ 送往 {st.send_to.seq} {st.send_to.name}</div>
              )}
              <div className="h">本工位不能录入。请把产品放到对应位置，然后扫描下一台。</div>
            </div>
          )}

          {showRework && (
            <ReworkPanel key={scan!.sn} scan={scan!} token={token} sound={sound} readOnly={!canMes} onDone={rescan}
              onSkip={() => {
                setReworkReady(true);
              }} />
          )}

          {scan && next && !blocked && !showRework && (
            <div className="st-card st-form" ref={formRef} key={formKey}>
              <div className="st-form-head">
                <span className="op">{next.seq} {next.name}</span>
                <Tag color="purple" style={{ fontSize: 14 }}>{next.op_type_text || dictLabel('op_type', next.op_type)}</Tag>
                {scan.rework && <Tag color="orange" style={{ fontSize: 14 }}>返工重测 {scan.rework.ncr_no}</Tag>}
                <span style={{ color: '#6b6b80' }}>{next.work_center_name || ''}{next.sop_no ? ` · ${next.sop_no}` : ''}</span>
              </div>
              {fieldCount > 0 ? (
                <div className={`st-params${fieldCount > 4 ? ' c3' : ''}`}>
                  {kp && (
                    <KeyPartField
                      label={`${kp.code} ${kp.name}`}
                      sound={sound}
                      register={register}
                      check={async (lot) => {
                        try {
                          const r = await stationPost(token, '/mes/station/key-part-check', { sn: scan.sn, lot_no: lot });
                          return r.ok ? null : r.message;
                        } catch (e) {
                          return authFailed(e) ? '登录已失效' : errDetail(e);
                        }
                      }}
                      onValue={(lot) => (keyLot.current = lot)}
                      onDone={onFieldDone}
                    />
                  )}
                  {params.map((p) => (isOkNg(p) ? (
                    <OkNgField key={p.code} param={p} sound={sound} register={register} onEscape={() => scanRef.current?.focus()}
                      onValue={(c, v) => (values.current[c] = v)} onDone={onFieldDone} />
                  ) : (
                    <NumField key={p.code} param={p} sound={sound} register={register} onEscape={() => scanRef.current?.focus()}
                      onValue={(c, v) => (values.current[c] = v)} onDone={onFieldDone} />
                  )))}
                </div>
              ) : (
                <Alert type="info" showIcon style={{ fontSize: 16 }}
                  message={<b style={{ fontSize: 17 }}>本工序没有测试项：按回车（或再扫一次本序列号）= 合格提交</b>}
                  description={next.instructions ? <span style={{ whiteSpace: 'pre-wrap' }}>{next.instructions}</span> : undefined} />
              )}
              {(next.requires_equipment || equipmentId) && (
                <div className="st-eqline">
                  <span style={{ whiteSpace: 'nowrap', fontSize: 16 }}>
                    {next.requires_equipment && <span style={{ color: '#cf1322' }}>* </span>}设备/仪器
                  </span>
                  <EquipmentPicker list={eqList} value={equipmentId} style={{ flex: 1, minWidth: 0 }}
                    onChange={(v) => {
                      setEquipmentId(v);
                      setTimeout(() => latest.current.focusStart(), 50);
                    }} />
                </div>
              )}
              <div className="st-buttons">
                <Button ref={passBtnRef} block type="primary" className="pass" icon={<CheckOutlined />} loading={submitting} disabled={!canReport} style={{ flex: 3 }}
                  onClick={submitPass}>
                  合格提交{fieldCount ? '' : '（回车）'}
                </Button>
                <Button block danger className="fail" icon={<CloseOutlined />} disabled={!canReport || submitting} style={{ flex: 2 }} onClick={() => setFailOpen(true)}>
                  判不合格
                </Button>
              </div>
              {fieldCount > 0 && fieldCount <= 4 && <div className="st-hint">回车跳到下一项，最后一项回车 = 合格提交；超出规格自动判不合格并开 NCR；录错了按 Esc 回扫码框重扫。</div>}
              {!canMes && <Alert type="warning" showIcon message="当前操作员没有生产报工权限" />}
            </div>
          )}

          {!scan && !banner && !loading && (
            <div className="st-card" style={{ textAlign: 'center', padding: 40, color: '#6b6b80', fontSize: 20 }}>
              <ScanOutlined style={{ fontSize: 56, color: '#b7a6ff' }} />
              <div style={{ marginTop: 10 }}>{configured ? `请扫描产品序列号（本工位：${cfg.op_code} ${cfg.op_name}）` : '本工位尚未设定工序'}</div>
            </div>
          )}
        </section>

        <aside className="st-right">
          {scan && next && !blocked && (next.instructions || next.sop_no || next.attachments?.length > 0) && (
            <div className="st-card">
              <h4>作业指导{next.sop_no ? ` · ${next.sop_no}` : ''}</h4>
              <div className="st-instr">{next.instructions || (next.attachments?.length ? '' : '见作业指导书')}</div>
              {next.attachments?.length > 0 && <InstrFiles files={next.attachments} token={token} onClosed={() => setTimeout(focusStart, 30)} />}
            </div>
          )}
          {scan ? (
            <div className="st-card" style={{ flex: 1 }}>
              <h4>生产履历 · {scan.sn}</h4>
              {history.length ? (
                <Timeline
                  style={{ marginTop: 8 }}
                  items={history.map((h: Rec, i: number) => (h._kind === 'part'
                    ? {
                      key: `p${i}`,
                      color: h.action === 'REMOVE' ? 'orange' : 'purple',
                      children: (
                        <div style={{ fontSize: 14 }}>
                          <KeyPartActionTag action={h.action} text={h.action_text} /> <b>{h.material_code} {h.material_name}</b>
                          <div style={{ fontSize: 12, color: '#8c8c9e' }}>
                            批号 {h.lot_no || '-'}{h.part_sn ? ` · ${h.part_sn}` : ''} · {dayjs(h.ts).format('MM-DD HH:mm')} · {h.operator_name || '-'}
                          </div>
                        </div>
                      ),
                    }
                    : {
                      key: `r${i}`,
                      color: h.result === 'PASS' ? 'green' : 'red',
                      children: (
                        <div style={{ fontSize: 14 }}>
                          <b>{h.seq} {h.op_name}</b> <Tag color={h.result === 'PASS' ? 'green' : 'red'}>{h.result === 'PASS' ? '合格' : '不合格'}</Tag>
                          {h.is_rework && <Tag color="orange">返工</Tag>}
                          <div style={{ fontSize: 12, color: '#8c8c9e' }}>
                            {dayjs(h.ts).format('MM-DD HH:mm:ss')} · {h.operator_name}{h.equipment_code ? ` · ${h.equipment_code}` : ''}
                          </div>
                          {h.remark && <div style={{ fontSize: 12 }}>{h.remark}</div>}
                          {h.values?.length > 0 && <div style={{ fontSize: 12 }}><ValuesText values={h.values} block /></div>}
                        </div>
                      ),
                    }))}
                />
              ) : <Empty description="尚未开始生产" />}
            </div>
          ) : (
            <div className="st-card">
              <h4>操作说明</h4>
              <ol style={{ paddingLeft: 20, lineHeight: 1.9, fontSize: 15, margin: 0 }}>
                <li>上岗刷工牌并输入 PIN；离开点【交班/锁定】。无操作 {cfg.idle_minutes} 分钟自动锁定，本人回来刷工牌即可继续（数据保留）；</li>
                <li>扫描产品序列号（或 UDI），焦点自动到第一项；</li>
                <li>录入测量值，回车跳到下一项，最后一项回车 = 合格提交；</li>
                <li>无测试项的工序：扫码后按回车（或再扫一次）即过站；</li>
                <li>判不合格：点【判不合格】→ 点不良现象 → 确认，系统自动开 NCR；</li>
                <li>扫设备编号可切换本台使用的仪器。</li>
              </ol>
              <Alert style={{ marginTop: 10 }} type="info" showIcon message="防呆：禁止跳站/重复过站，禁止使用校准过期或不适用本工序的仪器，关键件须为本工单已领用批次，操作员须持有本工序上岗资质。" />
            </div>
          )}
        </aside>
      </main>

      {notice && (
        <div className={`st-notice ${notice.kind}`} role="alert">
          <div className="t">{notice.kind === 'warn' ? <WarningOutlined /> : <CheckOutlined />} {notice.title}</div>
          {notice.sub && <div className="s">{notice.sub}</div>}
        </div>
      )}

      <IdleGuard active={!!session && !session.locked} minutes={cfg.idle_minutes} sound={sound} initialLast={session?.last}
        onLock={lockIdle}
        onPersist={(last) => {
          if (session && !session.locked) saveSession({ ...session, last });
        }} />

      {configured && locked && (
        <StationLock
          reason={lockReason}
          terminalUser={terminalText}
          stationText={stationText}
          resume={session?.locked ? { full_name: session.user.full_name, badge_no: session.user.badge_no, pending: pending() } : null}
          onUnlock={unlock}
          onResume={resume}
          onExit={() => setDialog('auth-exit')}
        />
      )}

      {!configured && (
        <div className="st-setup">
          <div style={{ maxWidth: 560 }}>
            <SettingOutlined style={{ fontSize: 64, color: '#b7a6ff' }} />
            <div style={{ fontSize: 32, fontWeight: 800, marginTop: 8 }}>本工位尚未设定工序</div>
            <div style={{ fontSize: 17, opacity: 0.8, margin: '8px 0 24px' }}>
              首次使用请由班组长设定本工位负责的工序和默认仪器（班组长刷本人工牌 + PIN 授权）。设定后操作员不能更改，扫到其他工序的产品会被拦截。
            </div>
            <Button type="primary" size="large" style={{ height: 60, fontSize: 20, padding: '0 36px' }} icon={<LockOutlined />} onClick={openSettings}>班组长设定</Button>
            <div style={{ marginTop: 18 }}>
              <Button type="link" style={{ color: 'rgba(255,255,255,.8)', fontSize: 16, height: 44 }} icon={<LogoutOutlined />} onClick={() => setDialog('auth-exit')}>
                退出工位终端（需班组长授权）
              </Button>
            </div>
          </div>
        </div>
      )}

      <AuthModal
        open={dialog === 'auth-settings' || dialog === 'auth-exit'}
        onClosed={() => latest.current.focusStart()}
        title={dialog === 'auth-exit' ? '退出工位终端（班组长授权）' : '班组长授权'}
        hint={dialog === 'auth-exit'
          ? '退出后本终端回到办公界面。请班组长刷本人工牌并输入 PIN 授权，防止操作员进入办公功能。'
          : '设定本工位工序、默认仪器、锁定时间与过站方式需班组长授权：请班组长刷本人工牌并输入 PIN。'}
        onCancel={() => {
          setDialog(null);
          setTimeout(() => latest.current.focusStart(), 50);
        }}
        onOk={(who) => {
          if (dialog === 'auth-exit') {
            saveSession(null);
            setDialog(null);
            nav('/');
          } else {
            setAuthedBy(who);
            setDialog('settings');
          }
        }}
      />
      <SetupModal
        open={dialog === 'settings'}
        onClosed={() => latest.current.focusStart()}
        config={cfg}
        by={authedBy}
        first={!configured}
        onCancel={() => {
          setDialog(null);
          setTimeout(() => latest.current.focusStart(), 50);
        }}
        onSave={(c) => {
          const changed = c.op_code !== cfg.op_code;
          saveConfig(c);
          setCfg(c);
          setDialog(null);
          if (changed) clearWork();
          message.success(`本工位已设定为【${c.op_code} ${c.op_name}】（${authedBy}）`);
          setTimeout(() => latest.current.focusStart(), 50);
        }}
      />
      <FailDialog
        open={failOpen}
        sn={scan?.sn}
        opName={next?.name}
        codes={scan?.defect_codes || [{ code: 'OTHER', name: '其他（请说明）' }]}
        busy={submitting}
        onCancel={() => setFailOpen(false)}
        onClosed={() => latest.current.focusStart()}
        onConfirm={(code, remark) => doSubmit('FAIL', { code, remark })}
      />
    </div>
  );
}
