/**
 * PDA 收货作业页（采购收货 / 客供料收货）：竖排、按扫描顺序录入、回车跳下一项。
 *   采购：① 扫采购单号 → ② 扫物料/料盘标签（GS1 自动带出原厂批号、生产日期）→ ③ 原厂批号 → ④ 数量（默认未收数）→ ⑤ 库位（默认带出）→ 回车加入本次收货
 *   同一订单行可连续收多个批次；全部扫完点“提交收货”，生成一张入库单，可直接打印批次标签。
 */
import { Alert, Button, Card, Empty, Segmented, Space, Spin, Tag, Typography } from 'antd';
import { DeleteOutlined, InboxOutlined, PrinterOutlined, ReloadOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { InputRef } from 'antd';
import { get, post, type Rec } from '../../../api/http';
import { CustomerSelect } from '../../../components/RemoteSelect';
import ScanInput, { type ScanInputHandle } from '../../../components/ScanInput';
import { fmtDate, fmtQty } from '../../../utils/format';
import { parseScan, type ScanResult } from '../../../utils/scan';
import { useAuth } from '../../../auth';
import {
  BigButton, checkPlace, clearDraft, confirmEnter, errText, FeedbackBar, focusLater, gs1Date, loadDraft, numText, parseDateText, PdaField, PdaPage, savedAgo, saveDraft, useFeedback, useLeaveGuard,
  type Draft,
} from './kit';

/** 本机暂存的未提交收货 */
interface ReceiveDraft { mode: Mode; po_no?: string | null; customer?: Rec | null; dn: string; cart: Batch[] }

type Mode = 'PO' | 'CS';
type Step = 'item' | 'lot' | 'mfg' | 'qty' | 'loc';

interface Line {
  key: string;
  po_line_id?: number;
  material_id: number;
  material_code: string;
  material_name: string;
  material_spec?: string | null;
  uom: string;
  remaining?: number; // 采购：订单未收数
  max_qty?: number; // 采购：允许超收 5%
  shelf_life_days?: number | null;
  msl_level?: string | null;
  iqc_required?: boolean;
  gtin?: string | null;
  owner_customer_id?: number | null;
  suggest_location?: Rec | null;
}

interface Batch {
  id: number;
  line: Line;
  supplier_lot: string;
  mfg_date: string | null;
  expiry_date: string | null;
  qty: number;
  location_id: number;
  location_code: string;
  warned?: boolean;
}

let seq = 1;

export default function PdaReceive() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [restore, setRestore] = useState<Draft<ReceiveDraft> | null>(() => {
    const d = loadDraft<ReceiveDraft>('receive', user?.username);
    return d?.data?.cart?.length ? d : null;
  });
  const [sp, setSp] = useSearchParams();
  const [mode, setMode] = useState<Mode>(sp.get('mode') === 'cs' ? 'CS' : 'PO');
  const [po, setPo] = useState<Rec | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [customer, setCustomer] = useState<Rec | null>(null);
  const [openPos, setOpenPos] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(false);
  const [dn, setDn] = useState('');
  const [cart, setCart] = useState<Batch[]>([]);
  const [cur, setCur] = useState<Line | null>(null);
  const [step, setStep] = useState<Step>('item');
  const [lot, setLot] = useState('');
  const [mfg, setMfg] = useState('');
  const [exp, setExp] = useState<string | null>(null);
  const [qty, setQty] = useState('');
  const [loc, setLoc] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<Rec | null>(null);
  const { fb, show, clear } = useFeedback();
  const scanRef = useRef<ScanInputHandle>(null);
  const lotRef = useRef<InputRef>(null);
  const mfgRef = useRef<InputRef>(null);
  const qtyRef = useRef<InputRef>(null);
  const locRef = useRef<InputRef>(null);

  // 未提交的批次随时暂存本机（刷新、锁屏、换页后可恢复）；有待恢复的草稿时先不覆盖
  useEffect(() => {
    if (restore) return;
    if (cart.length) saveDraft<ReceiveDraft>('receive', user?.username, { mode, po_no: po?.no ?? null, customer, dn, cart });
    else clearDraft('receive', user?.username);
  }, [cart, dn, mode, po, customer, restore, user?.username]);
  useLeaveGuard(cart.length > 0);

  const inCart = (l: Line) => cart.filter((b) => b.line.key === l.key).reduce((s, b) => s + b.qty, 0);
  const left = (l: Line) => (l.remaining === undefined ? undefined : Math.max(0, Math.round((l.remaining - inCart(l)) * 10000) / 10000));

  // 待收货采购订单（便于没有条码时点选）
  useEffect(() => {
    if (mode !== 'PO' || po) return;
    get('/purchase-orders', { status: 'APPROVED,PARTIAL_RECEIVED', page_size: 30 }, true).then((d) => setOpenPos(d.items || [])).catch(() => setOpenPos([]));
  }, [mode, po]);

  useEffect(() => {
    const k = sp.get('po');
    if (k && mode === 'PO' && !po) loadPo(k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetItem = () => {
    setCur(null);
    setStep('item');
    setLot('');
    setMfg('');
    setExp(null);
    setQty('');
    setLoc('');
    setTimeout(() => scanRef.current?.focus(), 30);
  };

  const loadPo = async (key: string, restoreCart?: Batch[]) => {
    setLoading(true);
    try {
      const ctx = await get('/wms/receive-context', { po: key }, true);
      setPo(ctx.po);
      setLines((ctx.lines as Rec[]).map((l) => ({ ...l, key: `po${l.po_line_id}` }) as Line));
      setCart(restoreCart ?? []);
      setDone(null);
      resetItem();
      const open = (ctx.lines as Rec[]).filter((l) => l.remaining > 0);
      if (restoreCart?.length) show('ok', <>已恢复 <b>{ctx.po.no}</b> 未提交的 {restoreCart.length} 批，核对后点“提交收货”</>);
      else show('ok', <>采购订单 <b>{ctx.po.no}</b>（{ctx.po.supplier_name}）：{open.length} 行待收。请扫物料或料盘标签</>);
      const next = new URLSearchParams(sp);
      next.set('po', ctx.po.no);
      setSp(next, { replace: true });
    } catch (e) {
      show('err', errText(e));
    } finally {
      setLoading(false);
    }
  };

  const doRestore = async () => {
    const d = restore?.data;
    setRestore(null);
    if (!d) return;
    setMode(d.mode);
    setDn(d.dn || '');
    if (d.mode === 'PO' && d.po_no) await loadPo(d.po_no, d.cart);
    else {
      setCustomer(d.customer ?? null);
      setCart(d.cart);
      show('ok', <>已恢复未提交的客供料收货 {d.cart.length} 批（{d.customer?.name}），核对后点“提交收货”</>);
    }
  };
  const dropRestore = async () => {
    if (!(await confirmEnter('丢弃未提交的收货？', `将丢弃暂存的 ${restore?.data.cart.length ?? 0} 批（未生成入库单，不影响库存）。`, '丢弃', true, 'cancel'))) return;
    clearDraft('receive', user?.username);
    setRestore(null);
    setTimeout(() => scanRef.current?.focus(), 30);
  };

  /** 选中某行开始录入一个批次 */
  const startLine = (l: Line, parsed?: ScanResult) => {
    const rest = left(l);
    if (rest !== undefined && rest <= 0) {
      const room = l.max_qty !== undefined ? Math.round((l.max_qty - inCart(l)) * 10000) / 10000 : 0;
      if (room <= 0) return show('err', `${l.material_code} 本订单已收齐（订单 ${fmtQty((l as Rec).qty)} ${l.uom}，已收 ${fmtQty((l as Rec).received_qty)}），不能再收。请核对送货单`);
    }
    clear();
    if (rest !== undefined && rest <= 0) show('warn', `${l.material_code} 订单已收齐，只能超收 5% 以内，请核对`);
    setCur(l);
    const pl = parsed?.lot || '';
    const pm = gs1Date(parsed?.mfg) ?? '';
    setLot(pl);
    setMfg(pm);
    setExp(gs1Date(parsed?.exp));
    setQty(rest !== undefined && rest > 0 ? String(rest) : '');
    setLoc(l.suggest_location?.code ?? '');
    // 下一项：未带出原厂批号 → 原厂批号；有保质期且未带出生产日期 → 生产日期；否则数量
    const next: Step = !pl ? 'lot' : l.shelf_life_days && !pm ? 'mfg' : 'qty';
    go(next);
  };

  const go = (s: Step) => {
    setStep(s);
    const ref = { lot: lotRef, mfg: mfgRef, qty: qtyRef, loc: locRef, item: null }[s];
    if (ref) focusLater(ref, true);
    else setTimeout(() => scanRef.current?.focus(), 30);
  };

  // ---------- 扫码 ----------
  const onScanTop = async (code: string, parsed: ScanResult) => {
    if (restore) return show('warn', '有未提交的收货：请先点“恢复”或“丢弃”');
    if (mode === 'PO' && !po) return loadPo(code);
    if (mode === 'CS' && !customer) {
      // 客供料：先扫/输入客户编码
      const d = await get('/customers', { q: parsed.raw.trim(), page_size: 20 }, true).catch(() => ({ items: [] }));
      const items: Rec[] = d.items || [];
      const c = items.find((x) => String(x.code).toUpperCase() === parsed.raw.trim().toUpperCase()) ?? (items.length === 1 ? items[0] : null);
      if (!c) return show('err', `“${parsed.raw}” 不是客户编码，请扫描或输入客户编码（如 C001）`);
      setCustomer(c);
      return show('ok', <>客户（货主）：<b>{c.name}</b>。请扫客供料物料条码</>);
    }
    const raw = parsed.raw.trim();
    if (mode === 'PO' && po && raw.toUpperCase() === String(po.no).toUpperCase()) return show('info', `已是当前订单 ${po.no}，请扫物料`);
    // 物料匹配：GTIN → 物料编码（原始码 / 解析主值）
    const keys = [parsed.gtin, raw, parsed.code].filter(Boolean).map((s) => String(s).toUpperCase());
    if (mode === 'PO') {
      const hit = lines.filter((l) => (parsed.gtin && l.gtin === parsed.gtin) || keys.includes(l.material_code.toUpperCase()));
      const l = hit.find((x) => (left(x) ?? 1) > 0) ?? hit[0];
      if (l) return startLine(l, parsed);
      if (/^PO/i.test(raw)) {
        if (cart.length) return show('err', `本单还有 ${cart.length} 批未提交。请先提交收货，再扫下一张采购单`);
        return loadPo(raw);
      }
      return show('err', <>“{raw}” 不是本订单的物料。本单物料：{lines.map((x) => x.material_code).join('、')}</>);
    }
    // 客供料：按编码查该客户的客供料
    try {
      const d = await get('/materials', { q: parsed.gtin || parsed.code || raw, owner_customer_id: customer!.id, is_active: true, page_size: 20 }, true);
      const items: Rec[] = d.items || [];
      const m = items.find((x) => keys.includes(String(x.code).toUpperCase()) || (parsed.gtin && x.gtin === parsed.gtin)) ?? (items.length === 1 ? items[0] : null);
      if (!m) return show('err', `“${raw}” 不是 ${customer!.name} 的客供料，请核对物料标签`);
      const sug = await get('/wms/suggest-location', { material_id: m.id }, true).catch(() => null);
      startLine({
        key: `m${m.id}`, material_id: m.id, material_code: m.code, material_name: m.name, material_spec: m.spec, uom: m.uom, shelf_life_days: m.shelf_life_days,
        msl_level: m.msl_level, iqc_required: m.iqc_required, gtin: m.gtin, owner_customer_id: m.owner_customer_id, suggest_location: sug,
      }, parsed);
    } catch (e) {
      show('err', errText(e));
    }
  };

  // ---------- 字段回车 ----------
  const enterLot = () => {
    const p = parseScan(lot);
    if (p.lot && p.lot !== lot) {
      // 扫到整串 GS1：拆出批号与日期
      setLot(p.lot);
      if (p.mfg) setMfg(gs1Date(p.mfg) ?? '');
      if (p.exp) setExp(gs1Date(p.exp));
    }
    go(cur?.shelf_life_days && !mfg && !p.mfg ? 'mfg' : 'qty');
  };
  const enterMfg = () => {
    const d = parseDateText(mfg);
    if (d === undefined) {
      show('err', `生产日期“${mfg}”看不懂，请按 261020 或 2026-10-20 输入；不知道可留空`);
      return focusLater(mfgRef, true); // 全选原内容，下一枪直接覆盖
    }
    setMfg(d ?? '');
    go('qty');
  };
  const enterQty = () => {
    const n = numText(qty);
    if (n === null || !(n > 0)) {
      show('err', '请输入本批数量（大于 0）');
      return focusLater(qtyRef, true);
    }
    if (cur?.max_qty !== undefined) {
      const room = Math.round((cur.max_qty - inCart(cur)) * 10000) / 10000;
      if (n > room + 1e-9) {
        show('err', `超收：${cur.material_code} 订单未收 ${fmtQty(left(cur))}，本批 ${fmtQty(n)}（最多允许超收 5%）`);
        return focusLater(qtyRef, true);
      }
    }
    go('loc');
  };
  const enterLoc = async () => {
    if (!cur) return;
    const code = loc.trim();
    if (!code) return show('err', '请扫描库位条码');
    const n = numText(qty);
    if (n === null || !(n > 0)) return go('qty');
    try {
      const r = await checkPlace(cur.material_id, code, cur.owner_customer_id ?? null);
      if (!r.ok || !r.location) {
        // 被拒：填回建议库位并全选（回车 = 用建议库位，扫码 = 直接覆盖）
        show('err', <>{r.errors.join('；')}{cur.suggest_location ? <>。已填回建议库位 <b>{cur.suggest_location.code}</b>，回车确认或重扫</> : ''}</>);
        setLoc(cur.suggest_location?.code ?? '');
        return focusLater(locRef, true);
      }
      let warned = false;
      if (r.warnings.length) {
        show('warn', r.warnings.join('；'));
        const ok = await confirmEnter('库位确认', <div style={{ fontSize: 16 }}>{r.warnings.join('；')}。<br />确定仍放入 <b>{r.location.code}</b>？</div>, '仍放入（回车）');
        if (!ok) {
          setLoc(cur.suggest_location?.code ?? '');
          return focusLater(locRef, true);
        }
        warned = true;
      }
      const b: Batch = {
        id: seq++, line: cur, supplier_lot: lot.trim(), mfg_date: parseDateText(mfg) ?? null, expiry_date: exp, qty: n, location_id: r.location.id, location_code: r.location.code, warned,
      };
      setCart((c) => [...c, b]);
      const nth = cart.filter((x) => x.line.key === cur.key).length + 1;
      show('ok', <>已加入：<b>{cur.material_code}</b> {fmtQty(n)} {cur.uom} → <b>{r.location.code}</b>（本行第 {nth} 批）。继续扫下一盘，或点“提交收货”</>);
      resetItem();
    } catch (e) {
      show('err', errText(e));
    }
  };

  const submit = async (confirmAll = false) => {
    if (!cart.length) return show('err', '还没有收货明细：请先扫物料');
    setSaving(true);
    try {
      const body = {
        // 湿敏物料放非防潮柜：录入时已逐批确认
        confirm_placement: confirmAll || cart.some((b) => b.warned),
        delivery_note: dn.trim() || null,
        lines: cart.map((b) => ({
          ...(mode === 'PO' ? { po_line_id: b.line.po_line_id } : { material_id: b.line.material_id }),
          qty: b.qty, location_id: b.location_id, supplier_lot: b.supplier_lot || null, mfg_date: b.mfg_date, expiry_date: b.expiry_date,
        })),
      };
      const rc = mode === 'PO'
        ? await post(`/purchase-orders/${po!.id}/receive`, body, true)
        : await post('/receipts', { ...body, receipt_type: 'CUSTOMER_SUPPLIED', customer_id: customer!.id }, true);
      setDone(rc);
      setCart([]);
      clearDraft('receive', user?.username);
      show('ok', <>入库单 <b>{rc.no}</b> 已生成（{rc.lines.length} 批）</>);
    } catch (e) {
      const msg = errText(e);
      if (msg.startsWith('【需确认】') && !confirmAll) {
        setSaving(false);
        if (await confirmEnter('库位确认', <div style={{ fontSize: 16 }}>{msg.replace('【需确认】', '')}</div>, '仍放入并提交')) return submit(true);
        return show('warn', '已返回，可删除该批重新录入库位');
      }
      show('err', msg);
    } finally {
      setSaving(false);
    }
  };

  const restart = (keepPo: boolean) => {
    setDone(null);
    clear();
    if (keepPo && po) loadPo(po.no);
    else {
      setPo(null);
      setLines([]);
      setDn('');
      const next = new URLSearchParams(sp);
      next.delete('po');
      setSp(next, { replace: true });
      resetItem();
    }
  };

  const openLines = useMemo(() => lines.filter((l) => (left(l) ?? 1) > 0), [lines, cart]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 完成页 ----------
  if (done) {
    const iqc = (done.lines as Rec[]).filter((l) => l.inspection_id).length;
    return (
      <PdaPage title="收货完成" sub={`${done.no} · ${done.partner_name ?? ''}`}>
        <FeedbackBar fb={fb} />
        {iqc > 0 && <Alert type="warning" showIcon style={{ marginBottom: 10 }} message={`${iqc} 批需来料检验（已自动生成 IQC 检验单），检验合格前为“待检”，不能领用`} />}
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          {(done.lines as Rec[]).map((l) => (
            <Card key={l.id} size="small" styles={{ body: { padding: 10 } }}>
              <div style={{ fontWeight: 600, fontSize: 16 }}>{l.material_code} <span style={{ fontWeight: 400, color: '#888', fontSize: 13 }}>{l.material_name}</span></div>
              <div style={{ fontSize: 15 }}>批号 <b className="mono">{l.lot_no || '-'}</b> · {fmtQty(l.qty)} {l.uom}</div>
              <div style={{ fontSize: 15 }}>放入库位 <b className="mono" style={{ fontSize: 18 }}>{l.location_code}</b> · {l.status === 'QUARANTINE' ? <Tag color="gold">待检</Tag> : <Tag color="green">合格</Tag>}</div>
            </Card>
          ))}
          <BigButton icon={<PrinterOutlined />} onClick={() => window.open(`/wms/print/labels?receipt=${done.id}`, '_blank')}>打印批次标签（{done.lines.length} 张）</BigButton>
          {mode === 'PO' && po && <BigButton type="default" onClick={() => restart(true)}>继续收本单剩余</BigButton>}
          <BigButton type="default" onClick={() => restart(false)}>收下一单</BigButton>
          <Button type="link" size="large" onClick={() => nav(`/wms/receipts?q=${encodeURIComponent(done.no)}`)}>查看入库单</Button>
        </Space>
      </PdaPage>
    );
  }

  const header = mode === 'PO' ? (po ? (
    <Card size="small" styles={{ body: { padding: 10 } }} style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }} className="mono">{po.no}</div>
          <Typography.Text type="secondary">{po.supplier_name}</Typography.Text>
        </div>
        <Button size="large" icon={<ReloadOutlined />} onClick={() => (cart.length ? show('err', '本单还有未提交的批次，请先提交或删除') : restart(false))}>换单</Button>
      </div>
      <input
        value={dn}
        onChange={(e) => setDn(e.target.value)}
        placeholder="送货单号（可选，可扫码）"
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); scanRef.current?.focus(); } }}
        style={{ width: '100%', marginTop: 8, height: 40, fontSize: 15, border: '1px solid #d9d9d9', borderRadius: 6, padding: '0 10px' }}
      />
    </Card>
  ) : null) : (
    <Card size="small" styles={{ body: { padding: 10 } }} style={{ marginBottom: 8 }}>
      <div style={{ marginBottom: 4, color: '#595959' }}>客户（货主）</div>
      <CustomerSelect size="large" value={customer?.id} onPick={(r) => { if (cart.length) { show('err', '已有未提交的批次，不能换客户'); return; } setCustomer(r ?? null); setTimeout(() => scanRef.current?.focus(), 50); }} placeholder="扫描或输入客户编码" />
      <input
        value={dn}
        onChange={(e) => setDn(e.target.value)}
        placeholder="送货单号（可选）"
        style={{ width: '100%', marginTop: 8, height: 40, fontSize: 15, border: '1px solid #d9d9d9', borderRadius: 6, padding: '0 10px' }}
      />
    </Card>
  );

  const scanPlaceholder = mode === 'PO' && !po ? '扫采购订单号' : mode === 'CS' && !customer ? '扫客户编码（或在上方选择客户）' : cur ? '（正在录入本批，扫新物料会切换）' : '扫物料条码 / 料盘标签';

  return (
    <PdaPage
      title={mode === 'PO' ? '采购收货' : '客供料收货'}
      sub="扫码 = 键入 + 回车；回车自动跳下一项"
      dirtyText={cart.length ? `还有 ${cart.length} 批未提交收货` : null}
      extra={<Segmented value={mode} onChange={(v) => { if (cart.length) return show('err', '有未提交的批次'); setMode(v as Mode); setPo(null); setCustomer(null); resetItem(); }} options={[{ value: 'PO', label: '采购' }, { value: 'CS', label: '客供' }]} />}
      footer={cart.length > 0 ? (
        <BigButton loading={saving} icon={<InboxOutlined />} onClick={() => submit()}>提交收货（{cart.length} 批）</BigButton>
      ) : undefined}
    >
      <Spin spinning={loading}>
        {restore && (
          <Alert type="warning" showIcon style={{ marginBottom: 8 }}
            message={<b>有未提交的收货 {restore.data.cart.length} 批</b>}
            description={(
              <div>
                <div>{restore.data.mode === 'PO' ? `采购订单 ${restore.data.po_no}` : `客供料 ${restore.data.customer?.name ?? ''}`} · 暂存于 {savedAgo(restore.saved_at)}</div>
                <div style={{ color: '#666' }}>{restore.data.cart.map((b) => `${b.line.material_code} ${fmtQty(b.qty)}→${b.location_code}`).join('；')}</div>
                <Space style={{ marginTop: 8 }}>
                  <Button type="primary" size="large" onClick={doRestore}>恢复 {restore.data.cart.length} 批</Button>
                  <Button size="large" onClick={dropRestore}>丢弃</Button>
                </Space>
              </div>
            )} />
        )}
        {header}
        <ScanInput ref={scanRef} onScan={onScanTop} placeholder={scanPlaceholder} captureGlobal={!cur} style={{ height: 52, fontSize: 18 }} />
        <FeedbackBar fb={fb} />

        {cur && (
          <Card size="small" style={{ margin: '8px 0', borderColor: '#1677ff' }} styles={{ body: { padding: 12 } }}
            title={<span style={{ fontSize: 16 }}>{cur.material_code} <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 400 }}>{cur.material_name}</Typography.Text></span>}
            extra={<Button size="large" onClick={resetItem}>放弃</Button>}>
            <Space size={4} wrap style={{ marginBottom: 8 }}>
              {left(cur) !== undefined && <Tag color="blue">未收 {fmtQty(left(cur))} {cur.uom}</Tag>}
              {cur.msl_level && cur.msl_level !== '1' && <Tag color="volcano">湿敏 MSL {cur.msl_level}</Tag>}
              {cur.iqc_required && <Tag color="gold">需 IQC</Tag>}
              {cur.shelf_life_days ? <Tag>保质期 {cur.shelf_life_days} 天</Tag> : null}
            </Space>
            <PdaField ref={lotRef} label="① 原厂批号（扫料盘标签）" scan value={lot} onChange={setLot} onEnter={enterLot} active={step === 'lot'} placeholder="扫描或输入，没有可直接回车"
              hint="系统批号自动生成，收货后打印批次标签贴在料盘上" />
            {!!cur.shelf_life_days && (
              <PdaField ref={mfgRef} label="② 生产日期" value={mfg} onChange={setMfg} onEnter={enterMfg} active={step === 'mfg'} inputMode="numeric" placeholder="如 261020"
                hint={exp ? `有效期 ${fmtDate(exp)}（来自标签）` : `有效期 = 生产日期 + ${cur.shelf_life_days} 天；不知道可留空回车`} />
            )}
            <PdaField ref={qtyRef} label={`③ 本批数量（${cur.uom}）`} value={qty} onChange={setQty} onEnter={enterQty} active={step === 'qty'} inputMode="decimal"
              hint={left(cur) !== undefined ? `默认 = 未收数量，直接回车确认` : undefined} />
            <PdaField ref={locRef} label="④ 库位（扫库位条码）" scan value={loc} onChange={setLoc} onEnter={enterLoc} active={step === 'loc'}
              hint={cur.suggest_location ? <>建议 <b>{cur.suggest_location.code}</b>（{cur.suggest_location.reason}），直接回车确认</> : '请扫描库位条码'} />
            <BigButton onClick={() => (step === 'loc' ? enterLoc() : step === 'qty' ? enterQty() : step === 'mfg' ? enterMfg() : enterLot())}>
              {step === 'loc' ? '加入本次收货' : '下一项'}
            </BigButton>
          </Card>
        )}

        {cart.length > 0 && (
          <>
            <div style={{ fontWeight: 600, margin: '12px 0 6px', fontSize: 15 }}>本次收货（{cart.length} 批，未提交）</div>
            <Space direction="vertical" style={{ width: '100%' }} size={6}>
              {cart.map((b) => (
                <Card key={b.id} size="small" styles={{ body: { padding: '8px 10px' } }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0, fontSize: 15 }}>
                      <b>{b.line.material_code}</b> {fmtQty(b.qty)} {b.line.uom} → <b className="mono">{b.location_code}</b>
                      <div style={{ color: '#888', fontSize: 13 }}>原厂批号 {b.supplier_lot || '-'}{b.mfg_date ? ` · 生产 ${b.mfg_date}` : ''}{b.warned ? ' · 已确认非防潮柜' : ''}</div>
                    </div>
                    <Button danger size="large" icon={<DeleteOutlined />} aria-label="删除这一批" style={{ width: 48, height: 48 }}
                      onClick={() => { setCart((c) => c.filter((x) => x.id !== b.id)); show('info', `已删除 ${b.line.material_code} ${fmtQty(b.qty)}`); scanRef.current?.focus(); }} />
                  </div>
                </Card>
              ))}
            </Space>
          </>
        )}

        {mode === 'PO' && po && !cur && (
          <>
            <div style={{ fontWeight: 600, margin: '12px 0 6px', fontSize: 15 }}>待收明细（点一行也可开始）</div>
            {openLines.length ? (
              <Space direction="vertical" style={{ width: '100%' }} size={6}>
                {openLines.map((l) => (
                  <Card key={l.key} size="small" hoverable onClick={() => startLine(l)} styles={{ body: { padding: '8px 10px' } }}>
                    <div style={{ fontSize: 16, fontWeight: 600 }}>{l.material_code}</div>
                    <div style={{ color: '#888', fontSize: 13 }}>{l.material_name}{l.material_spec ? ` | ${l.material_spec}` : ''}</div>
                    <div style={{ fontSize: 15 }}>未收 <b>{fmtQty(left(l))}</b> {l.uom}{inCart(l) ? `（本次已扫 ${fmtQty(inCart(l))}）` : ''} · 建议库位 <b className="mono">{l.suggest_location?.code ?? '-'}</b></div>
                  </Card>
                ))}
              </Space>
            ) : <Empty description="本订单已全部扫完" />}
          </>
        )}

        {mode === 'PO' && !po && (
          <>
            <div style={{ fontWeight: 600, margin: '12px 0 6px', fontSize: 15 }}>待收货的采购订单</div>
            {openPos.length ? (
              <Space direction="vertical" style={{ width: '100%' }} size={6}>
                {openPos.map((o) => (
                  <Card key={o.id} size="small" hoverable onClick={() => loadPo(o.no)} styles={{ body: { padding: '8px 10px' } }}>
                    <div style={{ fontSize: 16, fontWeight: 600 }} className="mono">{o.no}</div>
                    <div style={{ color: '#666' }}>{o.supplier_name} · 交期 {fmtDate(o.expected_date)}</div>
                  </Card>
                ))}
              </Space>
            ) : <Empty description="没有待收货的采购订单" />}
          </>
        )}
      </Spin>
    </PdaPage>
  );
}
