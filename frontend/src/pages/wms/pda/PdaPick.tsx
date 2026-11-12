/**
 * PDA 拣料（领料单拣料模式）：按库位路线逐行 ——（可选）扫库位核对 → 扫批号核对 → 数量回车（默认应拣数）。
 *   实拣少于应拣：差额自动从下一 FEFO 批次补足（新行待拣）；扫到单外批次可确认替换；
 *   全部拣完过账；未拣完可“部分过账”，未拣行转入新领料单。
 */
import { Alert, Button, Card, Empty, Progress, Space, Tag, Typography } from 'antd';
import { CheckOutlined, PrinterOutlined, ReloadOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { InputRef } from 'antd';
import { get, post, type Rec } from '../../../api/http';
import ScanInput, { type ScanInputHandle } from '../../../components/ScanInput';
import StatusTag from '../../../components/StatusTag';
import { fmtDate, fmtDateTime, fmtQty } from '../../../utils/format';
import type { ScanResult } from '../../../utils/scan';
import { BigButton, confirmEnter, errText, FeedbackBar, focusLater, numText, PdaField, PdaPage, useFeedback } from './kit';

const route = (ls: Rec[]) => [...ls].sort((a, b) => String(a.location_code).localeCompare(String(b.location_code)) || String(a.material_code).localeCompare(String(b.material_code)) || a.id - b.id);
const picked = (l: Rec) => l.picked_qty !== null && l.picked_qty !== undefined;

/** 待拣领料单列表 */
export function PdaPickList() {
  const nav = useNavigate();
  const [rows, setRows] = useState<Rec[]>([]);
  useEffect(() => {
    get('/issues', { status: 'DRAFT', issue_type: 'ISSUE', page_size: 50 }).then((d) => setRows(d.items || []));
  }, []);
  return (
    <PdaPage title="拣料" sub="选择待过账的领料单，按库位路线扫码拣料">
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        {rows.map((r) => {
          const n = (r.lines as Rec[]).filter(picked).length;
          return (
            <Card key={r.id} size="small" hoverable onClick={() => nav(`/wms/pda/pick/${r.id}`)} styles={{ body: { padding: 12 } }}>
              <div style={{ fontSize: 17, fontWeight: 700 }} className="mono">{r.no}</div>
              <div>工单 {r.wo_no} · {r.lines.length} 行{n ? ` · 已拣 ${n}` : ''} · {fmtDateTime(r.created_at)}</div>
            </Card>
          );
        })}
        {!rows.length && <Empty description="没有待拣的领料单" />}
      </Space>
    </PdaPage>
  );
}

export default function PdaPick() {
  const { id } = useParams();
  const nav = useNavigate();
  const [d, setD] = useState<Rec | null>(null);
  const [curId, setCurId] = useState<number | null>(null);
  const [locOk, setLocOk] = useState(false);
  const [lotOk, setLotOk] = useState(false);
  const [qty, setQty] = useState('');
  const [busy, setBusy] = useState(false);
  const { fb, show } = useFeedback();
  const scanRef = useRef<ScanInputHandle>(null);
  const qtyRef = useRef<InputRef>(null);

  const lines = useMemo(() => route(d?.lines || []), [d]);
  const cur = lines.find((l) => l.id === curId) ?? null;
  const done = lines.filter(picked).length;
  const draft = d?.status === 'DRAFT';

  const setCurrent = (l: Rec | null) => {
    setCurId(l?.id ?? null);
    setLocOk(false);
    setLotOk(false);
    setQty(l ? String(l.qty) : '');
  };
  const apply = (r: Rec, keep?: number) => {
    setD(r);
    const ls = route(r.lines || []);
    const nx = (keep ? ls.find((l) => l.id === keep && !picked(l)) : null) ?? ls.find((l) => !picked(l)) ?? null;
    setCurrent(nx);
    setTimeout(() => scanRef.current?.focus(), 30);
  };
  const load = async () => apply(await get(`/issues/${id}`));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  // 扫码框挂载后立即获得焦点（扫码枪直接可用）
  useEffect(() => { if (d?.status === 'DRAFT') setTimeout(() => scanRef.current?.focus(), 80); }, [d?.id, d?.status]);

  const onScan = async (_code: string, p: ScanResult) => {
    if (!d || !draft) return;
    const raw = p.raw.trim().toUpperCase();
    const lot = (p.lot || p.raw).trim().toUpperCase();
    const open = lines.filter((l) => !picked(l));
    // 库位
    if (open.some((l) => String(l.location_code).toUpperCase() === raw) || lines.some((l) => String(l.location_code).toUpperCase() === raw)) {
      if (cur && String(cur.location_code).toUpperCase() === raw) {
        setLocOk(true);
        return show('ok', `库位 ${cur.location_code} 正确，请扫批号 ${cur.lot_no || ''}`);
      }
      const l = open.find((x) => String(x.location_code).toUpperCase() === raw);
      if (l) {
        setCurrent(l);
        setLocOk(true);
        return show('ok', `已切换到库位 ${l.location_code}：${l.material_code} 批号 ${l.lot_no || '-'}，请扫批号`);
      }
      return show('err', `库位 ${p.raw} 的行都已拣完`);
    }
    // 批号
    const same = open.filter((l) => String(l.lot_no).toUpperCase() === lot);
    if (same.length) {
      const l = same.find((x) => x.id === cur?.id) ?? same[0];
      if (l.id !== cur?.id) setCurrent(l);
      setLotOk(true);
      setQty(String(l.qty));
      show('ok', <>批号正确：{l.material_code} <b>{l.lot_no}</b>，应拣 <b>{fmtQty(l.qty)}</b> {l.uom}。确认数量后回车</>);
      return focusLater(qtyRef, true);
    }
    if (lines.some((l) => picked(l) && String(l.lot_no).toUpperCase() === lot)) return show('err', `批号 ${p.raw} 这一行已拣过`);
    // 单外批次：同物料 → 询问替换
    try {
      const s = await get('/wms/scan', { code: p.raw.trim(), lot: p.lot }, true);
      const rows = (s.rows as Rec[]).filter((r) => r.status === 'AVAILABLE');
      const target = cur && rows.find((r) => r.material_id === cur.material_id) ? cur : open.find((l) => rows.some((r) => r.material_id === l.material_id));
      const st = target ? rows.find((r) => r.material_id === target.material_id) : null;
      if (!target || !st) {
        return show('err', s.kind === 'UNKNOWN' ? `“${p.raw}” 不是批号或库位条码` : `“${p.raw}” 不是本领料单需要的物料/批次（或不是合格库存）`);
      }
      show('warn', `批次 ${st.lot_no} 不在拣料单上`);
      const ok = await confirmEnter('批次不在拣料单上', (
        <div style={{ fontSize: 16 }}>
          扫到 <b>{st.material_code}</b> 批号 <b>{st.lot_no}</b>（{st.location_code}，{fmtQty(st.qty)}{st.expiry_date ? `，有效期 ${fmtDate(st.expiry_date)}` : ''}）。<br />
          是否用它替换拣料单上的批号 <b>{target.lot_no}</b>（{target.location_code}）？
        </div>
      ), '替换（回车）');
      if (!ok) return;
      const r = await post(`/issues/${id}/replace`, { line_id: target.id, stock_id: st.id }, true);
      show('ok', r.messages.join('；'));
      setD(r.issue);
      const nl = route(r.issue.lines).find((l) => l.lot_no === st.lot_no && l.location_id === st.location_id && !picked(l));
      setCurrent(nl ?? null);
      if (nl) { setLotOk(true); focusLater(qtyRef, true); }
    } catch (e) {
      show('err', errText(e));
    }
  };

  const doPick = async () => {
    if (!cur) return;
    const n = numText(qty);
    if (n === null || !(n >= 0)) return show('err', '请输入实拣数量（实物没有填 0）');
    if (n > cur.qty + 1e-9) return show('err', `实拣 ${fmtQty(n)} 超过应拣 ${fmtQty(cur.qty)}，多拣的请放回`);
    if (!lotOk) {
      const ok = await confirmEnter('未扫批号核对', <div>没有扫批号核对 <b>{cur.lot_no || '-'}</b>，确定按此批次记实拣 {fmtQty(n)}？</div>, '确定（回车）');
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await post(`/issues/${id}/pick`, { line_id: cur.id, picked_qty: n }, true);
      show(n < cur.qty - 1e-9 ? 'warn' : 'ok', r.messages.join('；'));
      apply(r.issue);
    } catch (e) {
      show('err', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmPost = async () => {
    const left = lines.filter((l) => !picked(l));
    if (!done) {
      const ok = await confirmEnter('还没有扫码拣料', <div>直接按拣料单全部数量过账？（不核对实物）</div>, '全部过账');
      if (!ok) return;
    } else if (left.length) {
      const ok = await confirmEnter(`还有 ${left.length} 行未拣`, <div>部分过账：已拣 {done} 行扣库存；未拣 {left.length} 行转入新的领料单，稍后再拣。</div>, '部分过账（回车）');
      if (!ok) return;
    } else {
      const ok = await confirmEnter('确认过账', <div>已拣齐 {done} 行。过账后扣减库存，批次与工单 {d?.wo_no} 绑定。</div>, '过账（回车）');
      if (!ok) return;
    }
    try {
      const r = await post(`/issues/${id}/confirm`, { partial: done > 0 && left.length > 0 }, true);
      setD(r);
      show('ok', `领料单 ${r.no} 已过账${left.length && done ? `，未拣 ${left.length} 行已转入新领料单` : ''}`);
    } catch (e) {
      show('err', errText(e));
    }
  };

  if (!d) return <PdaPage title="拣料" back="/wms/pda/pick"><Empty /></PdaPage>;

  return (
    <PdaPage
      title={<span className="mono">{d.no}</span>}
      sub={<>工单 {d.wo_no} · <StatusTag dict="doc_status" value={d.status} /></>}
      back="/wms/pda/pick"
      extra={<Space><Button size="large" icon={<PrinterOutlined />} onClick={() => window.open(`/wms/print/issue/${d.id}`, '_blank')} aria-label="打印拣料单" /><Button size="large" icon={<ReloadOutlined />} onClick={load} aria-label="刷新" /></Space>}
      footer={draft ? <BigButton icon={<CheckOutlined />} onClick={confirmPost}>{done && done < lines.length ? `部分过账（已拣 ${done}/${lines.length}）` : `过账（已拣 ${done}/${lines.length}）`}</BigButton> : undefined}
    >
      <Progress percent={lines.length ? Math.round((done / lines.length) * 100) : 0} format={() => `${done}/${lines.length}`} />
      {draft && <ScanInput ref={scanRef} onScan={onScan} captureGlobal placeholder="扫库位 / 批号核对" style={{ height: 52, fontSize: 18, marginTop: 6 }} />}
      <FeedbackBar fb={fb} />
      {!draft && <Alert type="success" showIcon message={`已过账 · ${d.confirmed_by ?? ''} ${fmtDateTime(d.confirmed_at)}`} />}

      {draft && cur && (
        <Card size="small" style={{ margin: '8px 0', borderColor: '#1677ff', borderWidth: 2 }} styles={{ body: { padding: 12 } }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 28, fontWeight: 800 }} className="mono">{cur.location_code}</span>
            <span>{locOk ? <Tag color="green">库位已核对</Tag> : <Tag>库位未核对</Tag>}</span>
          </div>
          <div style={{ fontSize: 17, fontWeight: 600 }}>{cur.material_code} <span style={{ fontWeight: 400, fontSize: 13, color: '#888' }}>{cur.material_name}</span></div>
          <div style={{ fontSize: 17 }}>批号 <b className="mono">{cur.lot_no || '-'}</b> {lotOk ? <Tag color="green">已核对</Tag> : <Tag color="orange">请扫批号</Tag>}{cur.owner_customer_id ? <Tag color="purple">客供</Tag> : null}</div>
          <div style={{ fontSize: 17 }}>应拣 <b style={{ fontSize: 22 }}>{fmtQty(cur.qty)}</b> {cur.uom}{cur.expiry_date ? <span style={{ color: '#888', fontSize: 13 }}> · 有效期 {fmtDate(cur.expiry_date)}</span> : null}</div>
          <div style={{ marginTop: 8 }}>
            <PdaField ref={qtyRef} label="实拣数量（默认应拣数，实物不够改小）" value={qty} onChange={setQty} onEnter={doPick} inputMode="decimal" active={lotOk} />
          </div>
          <BigButton loading={busy} onClick={doPick}>确认已拣</BigButton>
        </Card>
      )}
      {draft && !cur && done === lines.length && lines.length > 0 && <Alert type="success" showIcon style={{ margin: '8px 0' }} message="全部拣齐，请点下方“过账”" />}

      <div style={{ fontWeight: 600, margin: '10px 0 6px' }}>拣料清单（按库位路线）</div>
      <Space direction="vertical" style={{ width: '100%' }} size={4}>
        {lines.map((l, i) => (
          <div key={l.id} role="button" onClick={() => draft && !picked(l) && setCurrent(l)}
            style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', borderRadius: 6, border: `1px solid ${l.id === curId ? '#1677ff' : '#f0f0f0'}`, background: picked(l) ? '#f6ffed' : '#fff' }}>
            <span style={{ width: 22, color: '#999' }}>{i + 1}</span>
            <div style={{ flex: 1, minWidth: 0, fontSize: 14 }}><b className="mono">{l.location_code}</b> · {l.material_code} · <span className="mono">{l.lot_no || '-'}</span></div>
            <div style={{ textAlign: 'right', fontSize: 15 }}>{picked(l) ? <><CheckOutlined style={{ color: '#52c41a' }} /> <b>{fmtQty(l.picked_qty)}</b></> : fmtQty(l.qty)}</div>
          </div>
        ))}
      </Space>
      {!draft && <Button type="link" onClick={() => nav(`/wms/issues?id=${d.id}`)}>在电脑端查看</Button>}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>系统已按先到期先出（FEFO）推荐批次；实物不足时改小实拣数，系统自动从下一批补足。</Typography.Paragraph>
    </PdaPage>
  );
}
