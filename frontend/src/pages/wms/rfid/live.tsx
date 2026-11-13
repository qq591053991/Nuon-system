/**
 * RFID 现场：自动识别 + 一键确认（作业台首页与各作业页共用）。
 *   runConfirm(d, extra)   按作业类型确认（收货/库门遇湿敏警告先弹确认；盘点先弹过账确认）
 *   primaryOf(d)           主按钮文字与是否可点（全部相符才可点；规则同后端：库门只确认绿色/无需移库，发货须完全一致）
 *   LiveCard               一张作业卡：“已识别：发货单 FHxxx”、下一步提示、唯一的主按钮；识别中时列出候选单据一键选择
 *   Detected               作业页的“等待读取 / 已识别”区：读写器读到的单据自动识别后直接进入核对
 */
import { Alert, Button, Card, Checkbox, Empty, Input, Modal, Space, Spin, Tag, Typography, message } from 'antd';
import { CheckOutlined, ExperimentOutlined, RightOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post, type Rec } from '../../../api/http';
import { OnlineBadge, SimulateModal, errText, postConfirmable, sessionUrl, useRfidOptions } from './kit';

export const CONFIRM_TEXT: Record<string, string> = {
  RECEIVE: '确认收货', ISSUE: '确认领料', FG_RECEIPT: '确认入库', SHIP: '确认发货', COUNT: '写入盘点单并过账', RETURN: '登记退货', GATE: '确认移库',
};

/** 库门可一键确认的标签：绿色（待移库）与“无需移库” */
export const gateOkKeys = (d: Rec): string[] => (d.items as Rec[]).filter((i) => !i.action && (i.level === 'ok' || i.level === 'info') && i.known).map((i) => i.epc);

/** 可以确认但有差异时的说明（盘点：没读到的按盘亏、读到但不在此库位的按盘盈） */
export function diffText(d: Rec): string | null {
  const c = d.check ?? {};
  if (d.session.session_type !== 'COUNT') return null;
  const parts = [c.missing?.length ? `${c.missing.length} 包账面有但没读到（按盘亏）` : '', c.read_elsewhere ? `${c.read_elsewhere} 包不在此库位账上（按盘盈）` : ''].filter(Boolean);
  return parts.length ? `有差异：${parts.join('，')}；确认后按读到的数量过账` : null;
}

export function primaryOf(d: Rec): { text: string; enabled: boolean } {
  const t = d.session.session_type;
  const c = d.check ?? {};
  if (t === 'GATE') {
    const n = gateOkKeys(d).length;
    return { text: `${CONFIRM_TEXT.GATE}（${n}）`, enabled: n > 0 };
  }
  let text = CONFIRM_TEXT[t] ?? '确认';
  if (t === 'SHIP') text = `确认发货（${c.expected ?? 0} 台）`;
  if (t === 'FG_RECEIPT') text = `确认入库 ${c.read_ok ?? 0} 台`;
  if (t === 'RECEIVE') text = `确认收货（${c.bound ?? 0} 包）`;
  if (t === 'RETURN') text = `登记退货（${c.serials?.length ?? 0} 台）`;
  const enabled = !!d.can_confirm && (t !== 'SHIP' || !!c.all_match) && (t !== 'ISSUE' || !c.need_partial);
  return { text, enabled };
}

/** 确认（返回新的会话详情；用户在确认框中取消时返回 null） */
export async function runConfirm(d: Rec, extra: Rec = {}): Promise<Rec | null> {
  const s = d.session;
  const url = `/rfid/sessions/${s.id}/confirm`;
  try {
    if (s.session_type === 'RECEIVE') return await postConfirmable(url, extra, 'confirm_placement', '湿敏物料放非防潮柜，确认放入？');
    if (s.session_type === 'GATE') return await postConfirmable(url, { items: gateOkKeys(d).map((epc) => ({ epc })), ...extra }, 'confirm_placement', '湿敏物料放非防潮柜，确认移入？');
    if (s.session_type === 'COUNT' && extra.post === undefined) {
      const untagged = ((d.check?.lines ?? []) as Rec[]).filter((l) => l.untagged_qty > 0).length;
      let asBook = false;
      const ok = await new Promise<boolean>((resolve) => Modal.confirm({
        title: '写入盘点单并过账？',
        content: (
          <div>
            调整量 = 实盘（读到的标签数量）− 过账时的当前账面；盘盈入库、盘亏出库。
            {untagged > 0 && <div style={{ marginTop: 8 }}><Checkbox onChange={(e) => { asBook = e.target.checked; }}>有 {untagged} 个批次的部分库存没有标签，按当前账面处理（不调整）</Checkbox></div>}
          </div>
        ),
        okText: '过账', cancelText: '返回', onOk: () => resolve(true), onCancel: () => resolve(false),
      }));
      if (!ok) return null;
      return await post(url, { post: true, uncounted_as_book: asBook, ...extra }, true);
    }
    return await post(url, extra, true);
  } catch (e) {
    message.error(errText(e), 6);
    return null;
  }
}

const doneText = (r: Rec) => {
  const x = r.result ?? {};
  return x.receipt_no ? `已生成入库单 ${x.receipt_no}` : x.shipment_no ? `发货单 ${x.shipment_no} 已发货` : x.issue_no ? `领料单 ${x.issue_no} 已过账`
    : x.count_no ? `盘点单 ${x.count_no}${x.count_status === 'POSTED' ? ' 已过账' : ' 已写入'}` : x.return_no ? `已登记退货 ${x.return_no}` : x.moved !== undefined ? `已移库 ${x.moved} 包` : '已确认';
};

/** 一张作业卡（首页 / 作业页“已识别”区） */
export function LiveCard({ d, onChanged, showOpen = true }: { d: Rec; onChanged: (nd?: Rec) => void; showOpen?: boolean }) {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const s = d.session;
  const c = d.check ?? {};
  const auto = s.session_type === 'AUTO';
  const p = primaryOf(d);
  const adopt = async (cand: Rec) => {
    setBusy(true);
    try {
      const nd = await post(`/rfid/sessions/${s.id}/adopt`, cand);
      message.success(`已识别为${nd.session.type_text}：${nd.session.context_no ?? ''}`);
      onChanged(nd);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (s.session_type === 'RETURN' && !reason.trim()) return message.warning('请填写退货原因');
    setBusy(true);
    try {
      const r = await runConfirm(d, s.session_type === 'RETURN' ? { reason } : {});
      if (r) {
        message.success(doneText(r));
        onChanged(r);
      }
    } finally {
      setBusy(false);
    }
  };
  const errors = (d.items as Rec[]).filter((i) => !i.action && i.level === 'error').length;
  const title = auto ? '识别中' : s.session_type === 'GATE' ? `库门过门 ${s.no}` : `已识别：${s.type_text}${s.context_no ? ` · ${s.context_no}` : ''}`;
  return (
    <Card size="small" style={{ borderColor: p.enabled && !auto ? '#52c41a' : auto ? '#91caff' : '#ffe58f' }}
      title={<Space wrap><b>{title}</b><Typography.Text type="secondary" style={{ fontSize: 12 }}>{d.reader?.name} <OnlineBadge r={d.reader} /> · 标签 {d.summary.tags}</Typography.Text></Space>}
      extra={showOpen && !auto ? <a onClick={() => nav(sessionUrl(s))}>详情 <RightOutlined /></a> : null}>
      {auto ? (
        <>
          <Typography.Paragraph style={{ marginBottom: 8 }}>{c.hint}</Typography.Paragraph>
          {(c.candidates as Rec[] | undefined)?.length ? (
            <Space wrap>
              {(c.candidates as Rec[]).map((x) => (
                <Button key={`${x.session_type}-${x.shipment_id ?? x.issue_id ?? x.wo_id ?? x.location_id ?? ''}`} type="primary" ghost loading={busy} onClick={() => adopt(x)}>
                  {x.type_text}：{x.label}
                </Button>
              ))}
            </Space>
          ) : null}
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <Typography.Text type="secondary">识别不对？</Typography.Text> <a onClick={() => post(`/rfid/sessions/${s.id}/cancel`, { reason: '识别结果不用' }).then(() => onChanged())}>清空这次读取</a>
          </div>
        </>
      ) : (
        <>
          <div style={{ marginBottom: 10 }}>
            {p.enabled
              ? (diffText(d) ? <Typography.Text type="warning">{diffText(d)}，下一步：点“{p.text}”</Typography.Text> : <Typography.Text type="success"><CheckOutlined /> 全部相符，下一步：点“{p.text}”</Typography.Text>)
              : <Typography.Text type="warning">下一步：{d.blockers?.[0] ?? (s.session_type === 'SHIP' && !c.all_match ? '读到的与发货单不一致，点“去处理”查看'
                : s.session_type === 'GATE' && c.unclear ? `${c.unclear} 个方向不明，点“去处理”选择方向或标为误读` : '点“去处理”')}</Typography.Text>}
            {errors > 0 && <Tag color="red" style={{ marginLeft: 8 }}>{errors} 个不符</Tag>}
          </div>
          <Space wrap>
            {s.session_type === 'RETURN' && <Input style={{ width: 240 }} placeholder="退货原因（必填）" value={reason} onChange={(e) => setReason(e.target.value)} />}
            {s.session_type === 'RECEIVE' && !p.enabled
              ? <Button type="primary" onClick={() => nav(sessionUrl(s))}>去收货台</Button>
              : <Button type="primary" size="large" icon={<CheckOutlined />} disabled={!p.enabled} loading={busy} onClick={confirm}
                  style={p.enabled ? { background: '#389e0d', borderColor: '#389e0d' } : undefined}>{p.text}</Button>}
            {!p.enabled && s.session_type !== 'RECEIVE' && <Button onClick={() => nav(sessionUrl(s))}>去处理</Button>}
          </Space>
        </>
      )}
    </Card>
  );
}

/** 轮询一组进行中的会话详情 */
export function useLiveSessions(types: string[] | null, interval = 2000) {
  const [list, setList] = useState<Rec[] | null>(null);
  const busy = useRef(false);
  const key = types?.join(',') ?? '';
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const p = await get('/rfid/sessions', { status: 'OPEN', ...(key ? { session_type: key } : {}), page_size: 50 }, true);
      const ds = await Promise.all((p.items as Rec[]).map((x) => get(`/rfid/sessions/${x.id}`, undefined, true).catch(() => null)));
      setList(ds.filter(Boolean) as Rec[]);
    } catch {
      /* 下次再取 */
    } finally {
      busy.current = false;
    }
  }, [key]);
  useEffect(() => {
    load();
    const h = setInterval(() => { if (!document.hidden) load(); }, interval);
    return () => clearInterval(h);
  }, [load, interval]);
  return { list, reload: load };
}

/**
 * 作业页的“等待读取 / 已识别”区：读写器读到标签后系统自动识别；识别成本页作业（由读写器自动开启）时直接进入核对；
 * 识别中（多张候选 / 没识别出）显示卡片让仓管点选。手工选单仍在下方（兜底）。
 */
const PURPOSE_OF: Record<string, string[]> = { SHIP: ['SHIP'], FG_RECEIPT: ['SHIP', 'RECEIVE'], RETURN: ['RECEIVE'], ISSUE: ['RECEIVE'], COUNT: ['COUNT'], RECEIVE: ['RECEIVE'] };

export function Detected({ type, onEnter, waitText }: { type: string; onEnter: (id: number) => void; waitText: string }) {
  const { list, reload } = useLiveSessions([type, 'AUTO']);
  const opts = useRfidOptions();
  const [simReader, setSimReader] = useState<Rec | null>(null);
  const [readers, setReaders] = useState<Rec[]>([]);
  useEffect(() => { get('/rfid/readers', undefined, true).then((rs: Rec[]) => setReaders(rs.filter((r) => r.is_active && (PURPOSE_OF[type] ?? []).includes(r.purpose)))).catch(() => undefined); }, [type]);
  const entered = useRef(new Set<number>());
  const nav = useNavigate();
  useEffect(() => {
    for (const d of list ?? []) {
      const s = d.session;
      if (s.session_type === type && String(s.created_by ?? '').startsWith('rfid:') && !entered.current.has(s.id)) {
        entered.current.add(s.id);
        message.success(`已识别：${s.type_text} ${s.context_no ?? ''}`);
        onEnter(s.id);
        return;
      }
    }
  }, [list, type, onEnter]);
  const autos = (list ?? []).filter((d) => d.session.session_type === 'AUTO');
  const mine = (list ?? []).filter((d) => d.session.session_type === type);
  return (
    <Card style={{ marginBottom: 12, borderStyle: 'dashed' }} styles={{ body: { padding: 16 } }}>
      <Space align="center" style={{ marginBottom: autos.length || mine.length ? 12 : 0 }}>
        <Spin size="small" />
        <b style={{ fontSize: 16 }}>{waitText}</b>
        <Typography.Text type="secondary">不用先选单：读写器读到标签后自动识别单据</Typography.Text>
        {opts?.simulate && readers.map((r) => <Button key={r.id} size="small" icon={<ExperimentOutlined />} onClick={() => setSimReader(r)}>模拟读取：{r.name}</Button>)}
      </Space>
      {simReader && <SimulateModal readerId={simReader.id} onClose={() => setSimReader(null)} onDone={() => { setSimReader(null); reload(); }} />}
      {!list ? null : !autos.length && !mine.length ? null : (
        <Space direction="vertical" style={{ width: '100%' }}>
          {autos.map((d) => <LiveCard key={d.session.id} d={d} onChanged={(nd) => { if (nd && nd.session.session_type !== 'AUTO') { if (nd.session.session_type === type) onEnter(nd.session.id); else nav(sessionUrl(nd.session)); } else reload(); }} />)}
          {mine.map((d) => (
            <Alert key={d.session.id} type="info" showIcon message={<span>进行中：{d.session.type_text} {d.session.context_no ?? ''}（{d.reader?.name}，标签 {d.summary.tags}）</span>}
              action={<Button type="primary" size="small" onClick={() => onEnter(d.session.id)}>继续</Button>} />
          ))}
        </Space>
      )}
    </Card>
  );
}

/** 识别中的会话（作业页里打开时）：显示候选，选定后跳到对应作业页 */
export function AutoSession({ d, onChange }: { d: Rec; onChange: (nd: Rec) => void }) {
  const nav = useNavigate();
  return (
    <LiveCard d={d} showOpen={false} onChanged={(nd) => {
      if (!nd) return nav('/wms/rfid');
      if (nd.session.session_type !== 'AUTO') nav(sessionUrl(nd.session), { replace: true });
      onChange(nd);
    }} />
  );
}

export const EmptyLive = () => <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="读写器还没有读到需要处理的货物" />;
