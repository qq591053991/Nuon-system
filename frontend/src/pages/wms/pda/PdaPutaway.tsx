/**
 * PDA 上架 / 调拨：① 扫批次标签（批号）→ ② 扫目标库位 = 完成（数量默认整批）。
 * 先扫库位则列出该库位上的库存，可点选后再扫目标库位（整库位逐批转移）。下方列出待上架清单，可直接点选。
 */
import { Button, Card, Empty, Space, Tag, Typography } from 'antd';
import { SwapOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { InputRef } from 'antd';
import { get, post, type Rec } from '../../../api/http';
import ScanInput, { type ScanInputHandle } from '../../../components/ScanInput';
import StatusTag from '../../../components/StatusTag';
import { fmtDate, fmtQty } from '../../../utils/format';
import type { ScanResult } from '../../../utils/scan';
import { BigButton, checkPlace, confirmEnter, errText, FeedbackBar, numText, PdaField, PdaPage, useFeedback } from './kit';

function StockCard({ r, onPick, active }: { r: Rec; onPick?: () => void; active?: boolean }) {
  return (
    <Card size="small" hoverable={!!onPick} onClick={onPick} style={{ borderColor: active ? '#1677ff' : undefined, borderWidth: active ? 2 : 1 }} styles={{ body: { padding: '8px 10px' } }}>
      <div style={{ fontSize: 16, fontWeight: 600 }}>{r.material_code} <span style={{ fontWeight: 400, fontSize: 13, color: '#888' }}>{r.material_name}</span></div>
      <div style={{ fontSize: 15 }}>批号 <b className="mono">{r.lot_no || '-'}</b> · <b>{fmtQty(r.qty)}</b> {r.uom} <StatusTag dict="stock_status" value={r.status} /></div>
      <div style={{ fontSize: 15 }}>
        当前库位 <b className="mono" style={{ fontSize: 17 }}>{r.location_code}</b>
        {r.suggest_location_code && <> → 建议 <b className="mono" style={{ fontSize: 17, color: '#1677ff' }}>{r.suggest_location_code}</b></>}
      </div>
      {(r.putaway_reason || r.expiry_date || r.owner_customer_name) && (
        <div style={{ color: '#888', fontSize: 13 }}>
          {r.putaway_reason && <Tag color="orange">{r.putaway_reason}</Tag>}
          {r.owner_customer_name && <Tag color="purple">客供 {r.owner_customer_name}</Tag>}
          {r.expiry_date && <>有效期 {fmtDate(r.expiry_date)}</>}
        </div>
      )}
    </Card>
  );
}

export default function PdaPutaway() {
  const [sp] = useSearchParams();
  const [sel, setSel] = useState<Rec | null>(null);
  const [choices, setChoices] = useState<Rec[]>([]);
  const [choiceTitle, setChoiceTitle] = useState('');
  const [qty, setQty] = useState('');
  const [pending, setPending] = useState<Rec[]>([]);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(0);
  const { fb, show, clear } = useFeedback();
  const scanRef = useRef<ScanInputHandle>(null);
  const qtyRef = useRef<InputRef>(null);

  const loadPending = () => get('/wms/putaway', undefined, true).then((d) => setPending(d.items || [])).catch(() => setPending([]));
  useEffect(() => {
    loadPending();
    const sid = Number(sp.get('stock_id'));
    if (sid) {
      Promise.all([get('/wms/putaway', undefined, true), get('/stock', { ids: sid }, true)]).then(([pa, st]) => {
        const r = (pa.items as Rec[]).find((x) => x.id === sid) ?? (st.items as Rec[])[0];
        if (r) pick(r);
      }).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const withSuggest = (r: Rec): Rec => {
    const p = pending.find((x) => x.id === r.id);
    return p ? { ...r, ...p } : r;
  };

  const pick = (r: Rec) => {
    const row = withSuggest(r);
    setSel(row);
    setChoices([]);
    setQty(String(row.qty));
    show('info', <>已选 <b>{row.material_code}</b> 批号 <b>{row.lot_no || '-'}</b>（{row.location_code}，{fmtQty(row.qty)} {row.uom}）。请扫<b>目标库位</b>{row.suggest_location_code ? `，建议 ${row.suggest_location_code}` : ''}</>, false);
    setTimeout(() => scanRef.current?.focus(), 30);
  };

  const doMove = async (target: string) => {
    if (!sel) return;
    const n = numText(qty);
    if (n === null || !(n > 0) || n > sel.qty + 1e-9) {
      show('err', `数量不对：本批在 ${sel.location_code} 共 ${fmtQty(sel.qty)}，请输入 0 ~ ${fmtQty(sel.qty)}`);
      return qtyRef.current?.focus();
    }
    setBusy(true);
    try {
      const r = await checkPlace(sel.material_id, target, sel.owner_customer_id ?? null);
      if (!r.ok || !r.location) return show('err', r.errors.join('；'));
      if (r.location.id === sel.location_id) return show('err', `批次已经在 ${r.location.code}，请扫其他库位`);
      let confirm = false;
      if (r.warnings.length) {
        show('warn', r.warnings.join('；'));
        confirm = await confirmEnter('库位确认', <div style={{ fontSize: 16 }}>{r.warnings.join('；')}。<br />确定仍放入 <b>{r.location.code}</b>？</div>, '仍放入（回车）');
        if (!confirm) return;
      }
      await post('/stock/transfer', { stock_id: sel.id, qty: n >= sel.qty - 1e-9 ? null : n, to_location_id: r.location.id, confirm, remark: '扫码上架' }, true);
      setCount((c) => c + 1);
      show('ok', <>已上架：<b>{sel.material_code}</b> 批号 {sel.lot_no || '-'} {fmtQty(n)} {sel.uom}：{sel.location_code} → <b style={{ fontSize: 18 }}>{r.location.code}</b>。请扫下一批</>);
      setSel(null);
      setQty('');
      loadPending();
    } catch (e) {
      show('err', errText(e));
    } finally {
      setBusy(false);
      setTimeout(() => scanRef.current?.focus(), 30);
    }
  };

  const onScan = async (_code: string, parsed: ScanResult) => {
    try {
      const d = await get('/wms/scan', { code: parsed.raw.trim(), lot: parsed.lot, gtin: parsed.gtin }, true);
      if (d.kind === 'LOCATION') {
        if (sel) return doMove(d.code);
        const rows = d.rows as Rec[];
        if (!rows.length) return show('err', `库位 ${d.code} 上没有库存。请先扫要上架的批次标签`);
        setChoices(rows.map(withSuggest));
        setChoiceTitle(`库位 ${d.code} 上的库存（点选一批，再扫目标库位）`);
        return show('info', `库位 ${d.code} 有 ${rows.length} 批库存，请点选要移走的一批`, false);
      }
      const rows = (d.rows as Rec[]).filter((r) => r.qty > 0);
      if (!rows.length) {
        return show('err', d.kind === 'UNKNOWN' ? `“${parsed.raw}” 不是批号、库位或物料条码，请核对标签` : `“${d.code}” 没有在库数量（可能已领用或调走）`);
      }
      // 多个库位都有：优先待上架的那一行
      const pend = rows.filter((r) => pending.some((p) => p.id === r.id));
      if (rows.length === 1 || pend.length === 1) return pick(pend[0] ?? rows[0]);
      setChoices(rows.map(withSuggest));
      setChoiceTitle(`“${d.code}” 在 ${rows.length} 个位置有库存，请点选`);
      show('info', '找到多行库存，请点选要上架的那一行', false);
    } catch (e) {
      show('err', errText(e));
    }
  };

  return (
    <PdaPage title="上架 / 调拨" sub={`扫批次标签 → 扫目标库位${count ? ` · 本次已上架 ${count} 批` : ''}`}>
      <ScanInput ref={scanRef} onScan={onScan} captureGlobal placeholder={sel ? `扫目标库位${sel.suggest_location_code ? `（建议 ${sel.suggest_location_code}）` : ''}` : '扫批次标签 / 批号（或先扫库位）'} style={{ height: 52, fontSize: 18 }} />
      <FeedbackBar fb={fb} />
      {sel && (
        <div style={{ margin: '8px 0' }}>
          <StockCard r={sel} active />
          <div style={{ marginTop: 8 }}>
            <PdaField ref={qtyRef} label={`上架数量（默认整批 ${fmtQty(sel.qty)}）`} value={qty} onChange={setQty} inputMode="decimal" onEnter={() => scanRef.current?.focus()} />
          </div>
          <Space direction="vertical" style={{ width: '100%' }}>
            {sel.suggest_location_code && (
              <BigButton icon={<SwapOutlined />} loading={busy} onClick={() => doMove(sel.suggest_location_code)}>上架到建议库位 {sel.suggest_location_code}</BigButton>
            )}
            <BigButton type="default" onClick={() => { setSel(null); clear(); scanRef.current?.focus(); }}>换一批</BigButton>
          </Space>
        </div>
      )}
      {!sel && choices.length > 0 && (
        <>
          <div style={{ fontWeight: 600, margin: '10px 0 6px' }}>{choiceTitle}</div>
          <Space direction="vertical" style={{ width: '100%' }} size={6}>
            {choices.map((r) => <StockCard key={r.id} r={r} onPick={() => pick(r)} />)}
          </Space>
        </>
      )}
      {!sel && !choices.length && (
        <>
          <div style={{ fontWeight: 600, margin: '10px 0 6px' }}>待上架（{pending.length}）</div>
          {pending.length ? (
            <Space direction="vertical" style={{ width: '100%' }} size={6}>
              {pending.slice(0, 30).map((r) => <StockCard key={r.id} r={r} onPick={() => pick(r)} />)}
            </Space>
          ) : <Empty description={<Typography.Text type="secondary">没有待上架的物料</Typography.Text>} />}
          <Button type="link" onClick={loadPending}>刷新</Button>
        </>
      )}
    </PdaPage>
  );
}
