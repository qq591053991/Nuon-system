/**
 * 工位终端的对话框：班组长授权（终端账号密码）、终端设置（本工位工序 / 默认设备 / 空闲锁定 / 过站方式）、
 * 判不合格（不良现象大按钮 + 确认）、设备选择（不可用设备置灰并写明原因）。
 */
import { Alert, Button, Form, Input, InputNumber, Modal, Radio, Select, Switch, Tag, Typography, type InputRef } from 'antd';
import { CloseOutlined, LockOutlined, SafetyCertificateOutlined, WarningOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { get, post, type Rec } from '../../../api/http';
import { errDetail } from '../spec';
import type { StationConfig } from '../stationApi';

// ---------------------------------------------------------------- 班组长授权
interface AuthProps {
  open: boolean;
  title: string;
  /** 说明：为什么需要授权 */
  hint: string;
  terminalUser?: string | null;
  onOk: (who: string) => void;
  onCancel: () => void;
}

/** 输入本终端登录账号的密码（工位专用账号，班组长 / 管理员掌握）；回车提交，错误不关闭 */
export function AuthModal({ open, title, hint, terminalUser, onOk, onCancel }: AuthProps) {
  const [pwd, setPwd] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<InputRef>(null);

  useEffect(() => {
    if (open) {
      setPwd('');
      setErr(null);
      setTimeout(() => ref.current?.focus(), 60);
    }
  }, [open]);

  const submit = async () => {
    if (!pwd) {
      setErr('请输入密码');
      return;
    }
    setBusy(true);
    try {
      const r = await post('/mes/station/authorize', { password: pwd }, true);
      onOk(r.full_name);
    } catch (e) {
      setErr(errDetail(e));
      setPwd('');
      ref.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={<span><LockOutlined /> {title}</span>}
      okText="确认"
      cancelText="取消"
      onOk={submit}
      onCancel={onCancel}
      confirmLoading={busy}
      destroyOnHidden
      maskClosable={false}
      zIndex={2100}
      okButtonProps={{ size: 'large' }}
      cancelButtonProps={{ size: 'large' }}
    >
      <Typography.Paragraph>{hint}</Typography.Paragraph>
      <Input.Password
        ref={ref}
        size="large"
        autoComplete="off"
        placeholder={`终端账号${terminalUser ? `（${terminalUser}）` : ''}的密码`}
        value={pwd}
        onChange={(e) => {
          setPwd(e.target.value);
          setErr(null);
        }}
        onPressEnter={submit}
      />
      {err && <Alert style={{ marginTop: 12 }} type="error" showIcon message={err} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- 设备选择
export interface StationEq extends Rec {
  id: number;
  code: string;
  name: string;
  issue: string | null;
}

/** 本工位可选设备：不可用（停用 / 校准过期 / 不适用本工序）的置灰不可选，并写明原因（F22 / F08） */
export function EquipmentPicker({ list, value, onChange, size = 'large', style, placeholder = '选择或扫描设备编号' }: {
  list: StationEq[];
  value?: number | null;
  onChange: (id: number | undefined) => void;
  size?: 'large' | 'middle';
  style?: React.CSSProperties;
  placeholder?: string;
}) {
  const sorted = useMemo(() => [...list].sort((a, b) => Number(!!a.issue) - Number(!!b.issue) || a.code.localeCompare(b.code)), [list]);
  const [text, setText] = useState('');
  return (
    <div
      style={style}
      onKeyDownCapture={(e) => {
        // 扫码安全：回车按编号精确匹配，不选列表第一项
        if (e.key !== 'Enter' || !text.trim()) return;
        e.preventDefault();
        e.stopPropagation();
        const q = text.trim().toUpperCase();
        const hit = list.find((x) => x.code.toUpperCase() === q);
        if (!hit) Modal.error({ title: `未找到设备“${text.trim()}”`, zIndex: 2200 });
        else if (hit.issue) Modal.error({ title: `${hit.code} ${hit.name} 不能使用`, content: hit.issue, zIndex: 2200 });
        else onChange(hit.id);
        setText('');
      }}
    >
      <Select
        showSearch
        allowClear
        size={size}
        style={{ width: '100%' }}
        placeholder={placeholder}
        value={value ?? undefined}
        searchValue={text}
        onSearch={setText}
        onChange={(v) => {
          setText('');
          onChange(v ?? undefined);
        }}
        filterOption={(input, o) => String(o?.search ?? '').toLowerCase().includes(input.toLowerCase())}
        labelRender={(o) => {
          const x = list.find((e) => e.id === o.value);
          return x ? <span><b className="mono">{x.code}</b> {x.name}{x.next_calibration_date ? `（校准至 ${String(x.next_calibration_date).slice(0, 10)}）` : ''}</span> : o.label;
        }}
        options={sorted.map((x) => ({
          value: x.id,
          disabled: !!x.issue,
          search: `${x.code} ${x.name}`,
          label: (
            <div style={{ lineHeight: 1.3, padding: '4px 0', whiteSpace: 'normal' }}>
              <b className="mono">{x.code}</b> {x.name}
              {x.issue && <div style={{ color: '#cf1322', fontSize: 13 }}>不可用：{x.issue}</div>}
              {!x.issue && x.next_calibration_date && <div style={{ color: '#8c8c9e', fontSize: 13 }}>校准有效期至 {String(x.next_calibration_date).slice(0, 10)}</div>}
            </div>
          ),
        }))}
      />
    </div>
  );
}

// ---------------------------------------------------------------- 终端设置
interface SetupProps {
  open: boolean;
  config: StationConfig;
  by: string;
  /** 首次设定（必须选择工序，不能取消到作业界面） */
  first?: boolean;
  onSave: (c: StationConfig) => void;
  onCancel: () => void;
}

/** 终端设置（班组长授权后打开）：本工位工序设定后锁定，操作员不能更改 */
export function SetupModal({ open, config, by, first, onSave, onCancel }: SetupProps) {
  const [form] = Form.useForm();
  const [ops, setOps] = useState<Rec[]>([]);
  const [eqs, setEqs] = useState<StationEq[]>([]);
  const opCode: string | undefined = Form.useWatch('op_code', form);
  const op = ops.find((o) => o.code === opCode);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({ ...config });
    get('/mes/station/ops', undefined, true).then(setOps).catch(() => setOps([]));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || !op) return;
    get('/mes/station/equipment', { op_type: op.op_type, op_name: op.name, work_center_id: op.work_center_id ?? '' }, true)
      .then((l: StationEq[]) => {
        setEqs(l);
        const cur = form.getFieldValue('equipment_id');
        const okList = l.filter((x) => !x.issue);
        if (cur && !okList.some((x) => x.id === cur)) form.setFieldsValue({ equipment_id: undefined });
        if (!form.getFieldValue('equipment_id') && op.requires_equipment && okList.length === 1) form.setFieldsValue({ equipment_id: okList[0].id });
      })
      .catch(() => setEqs([]));
  }, [open, op?.code]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    const v = await form.validateFields();
    const o = ops.find((x) => x.code === v.op_code);
    onSave({
      ...config,
      ...v,
      op_name: o?.name ?? v.op_code,
      op_type: o?.op_type,
      work_center_id: o?.work_center_id ?? null,
      equipment_id: v.equipment_id ?? null,
      set_by: by,
      set_at: Date.now(),
    });
  };

  return (
    <Modal
      open={open}
      width={640}
      title={<span><SafetyCertificateOutlined /> {first ? '设定本工位工序（首次使用）' : '工位终端设置'}</span>}
      okText="保存设置"
      cancelText={first ? '暂不设定' : '取消'}
      onOk={save}
      onCancel={onCancel}
      destroyOnHidden
      maskClosable={false}
      okButtonProps={{ size: 'large' }}
      cancelButtonProps={{ size: 'large' }}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="本工位工序由班组长设定后锁定：操作员扫到不属于本工序的产品时，系统整块红色提示并拒绝录入（防跳站 / 重复过站）。设置保存在本终端。"
      />
      <Form form={form} layout="vertical" requiredMark>
        <Form.Item name="op_code" label="本工位工序" rules={[{ required: true, message: '请选择本工位负责的工序' }]}>
          <Select
            size="large"
            showSearch
            optionFilterProp="search"
            placeholder="选择工序（来自已发布的工艺路线）"
            options={ops.map((o) => ({
              value: o.code,
              search: `${o.code} ${o.name}`,
              label: (
                <span>
                  <b className="mono">{o.code}</b> {o.name} <Tag color="purple">{o.op_type_text}</Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{o.products.join(' / ')}</Typography.Text>
                </span>
              ),
            }))}
          />
        </Form.Item>
        <Form.Item
          name="equipment_id"
          label="本工位默认设备 / 仪器"
          extra={op?.requires_equipment ? '该工序必须记录所用设备；校准过期或不适用本工序的设备不能选。' : '该工序不强制记录设备。'}
        >
          <EquipmentPicker list={eqs} onChange={(id) => form.setFieldsValue({ equipment_id: id })} />
        </Form.Item>
        <Form.Item name="pass_mode" label="无测试项工序（如整机组装、终检）的过站方式">
          <Radio.Group
            optionType="button"
            buttonStyle="solid"
            size="large"
            options={[
              { value: 'confirm', label: '扫码后按回车（或再扫一次）确认' },
              { value: 'scan', label: '扫码即过站' },
            ]}
          />
        </Form.Item>
        <div style={{ display: 'flex', gap: 32 }}>
          <Form.Item name="idle_minutes" label="无操作自动锁定" rules={[{ required: true, message: '请填写分钟数' }]}>
            <InputNumber size="large" min={1} max={60} precision={0} suffix="分钟" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="sound" label="提示音" valuePropName="checked">
            <Switch />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
}

// ---------------------------------------------------------------- 判不合格
interface FailProps {
  open: boolean;
  sn?: string;
  opName?: string;
  codes: { code: string; name: string }[];
  busy?: boolean;
  onConfirm: (code: string, remark: string) => void;
  onCancel: () => void;
}

/** 判不合格：点选不良现象（大按钮，键盘 1–9 也可）→ 确认（Enter），“其他”须说明（C-F16） */
export function FailDialog({ open, sn, opName, codes, busy, onConfirm, onCancel }: FailProps) {
  const [code, setCode] = useState<string | null>(null);
  const [remark, setRemark] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const remarkRef = useRef<InputRef>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      setCode(null);
      setRemark('');
      setErr(null);
    }
  }, [open]);

  // 键盘：1–9 选不良现象，回车确认，Esc 取消（焦点在哪里都有效，补充说明输入框除外）
  const keys = useRef({ codes, code, remark });
  keys.current = { codes, code, remark };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const inInput = (e.target as HTMLElement)?.tagName === 'INPUT';
      const n = Number(e.key);
      if (!inInput && n >= 1 && n <= keys.current.codes.length) {
        e.preventDefault();
        pickRef.current(keys.current.codes[n - 1].code);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelRef.current();
      } else if (e.key === 'Enter' && !inInput && keys.current.code) {
        e.preventDefault();
        confirmRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const confirm = () => {
    if (!code) {
      setErr('请先点选不良现象');
      return;
    }
    if (code === 'OTHER' && !remark.trim()) {
      setErr('选择“其他”时请写明不良现象');
      remarkRef.current?.focus();
      return;
    }
    onConfirm(code, remark.trim());
  };

  const pick = (c: string) => {
    setCode(c);
    setErr(null);
    setTimeout(() => (c === 'OTHER' ? remarkRef.current?.focus() : okRef.current?.focus()), 30);
  };
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  return (
    <Modal
      open={open}
      width={860}
      zIndex={2000}
      footer={null}
      closable={false}
      destroyOnHidden
      maskClosable={false}
      title={<span style={{ fontSize: 22 }}><WarningOutlined style={{ color: '#cf1322' }} /> 判不合格：{sn}（{opName}）</span>}
    >
      <div>
        <Typography.Paragraph style={{ fontSize: 16 }}>点选不良现象（键盘 1–{codes.length}），再点【确认判不合格】（回车）。提交后系统自动开具 NCR，产品隔离待 QA 处置。</Typography.Paragraph>
        <div className="station-defects">
          {codes.map((c, i) => (
            <button key={c.code} type="button" className={`station-defect${code === c.code ? ' on' : ''}`} onClick={() => pick(c.code)} autoFocus={i === 0}>
              <span className="k">{i + 1}</span>
              {c.name}
            </button>
          ))}
        </div>
        <Input
          ref={remarkRef}
          size="large"
          style={{ marginTop: 16 }}
          placeholder={code === 'OTHER' ? '请写明不良现象（必填）' : '补充说明（选填）'}
          value={remark}
          onChange={(e) => {
            setRemark(e.target.value);
            setErr(null);
          }}
          onPressEnter={confirm}
        />
        {err && <Alert style={{ marginTop: 12 }} type="error" showIcon message={<b style={{ fontSize: 16 }}>{err}</b>} />}
        <div style={{ display: 'flex', gap: 16, marginTop: 20 }}>
          <Button ref={okRef} danger type="primary" className="station-btn" style={{ flex: 2 }} loading={busy} disabled={!code} onClick={confirm}>
            确认判不合格
          </Button>
          <Button className="station-btn" style={{ flex: 1 }} icon={<CloseOutlined />} onClick={onCancel}>取消</Button>
        </div>
      </div>
    </Modal>
  );
}
