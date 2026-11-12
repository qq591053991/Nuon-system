/**
 * PDA 盘点：按库位路线逐条录入（每行 = 输入实盘数 + 回车，自动跳到下一条未盘）。
 *   扫库位 → 定位到该库位第一条未盘；扫批号 → 定位到该批次；账上没有的批次可新增盘盈行。
 *   盲盘时不显示账面数；非盲盘可在 PDA 上直接过账（未盘行按账面需确认）。
 */
import { Alert, Button, Card, Empty, Form, Input, Progress, Space, Switch, Tag, Typography, message } from 'antd';
import { AuditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { InputRef } from 'antd';
import { get, post, put, type Rec } from '../../../api/http';
import { useAuth } from '../../../auth';
import { LocationSelect, WarehouseSelect } from '../../../components/RemoteSelect';
import ScanInput, { type ScanInputHandle } from '../../../components/ScanInput';
import StatusTag from '../../../components/StatusTag';
import { fmtDateTime, fmtQty } from '../../../utils/format';
import type { ScanResult } from '../../../utils/scan';
import { BigButton, confirmEnter, errText, FeedbackBar, focusLater, numText, PdaField, PdaPage, useFeedback } from './kit';

const sortLines = (ls: Rec[]) => [...ls].sort((a, b) => String(a.location_code).localeCompare(String(b.location_code))
  || String(a.material_code).localeCompare(String(b.material_code)) || String(a.lot_no).localeCompare(String(b.lot_no)) || a.id - b.id);
const isCounted = (l: Rec) => l.counted_qty !== null && l.counted_qty !== undefined;

/** 盘点单列表 + 新建（PDA） */
export function PdaCountList() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  const load = () => get('/stock-counts', { status: 'OPEN', page_size: 50 }).then((d) => setRows(d.items || []));
  useEffect(() => { load(); }, []);
  const create = async () => {
    const v = await form.validateFields();
    setBusy(true);
    try {
      const c = await post('/stock-counts', { warehouse_id: v.warehouse_id, location_ids: v.location_ids?.length ? v.location_ids : null, blind: !!v.blind, remark: v.remark || null });
      message.success(`盘点单 ${c.no} 已生成，共 ${c.lines.length} 行`);
      nav(`/wms/pda/count/${c.id}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <PdaPage title="盘点" sub="选择进行中的盘点单，或新建（可只盘几个库位）">
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        {rows.map((r) => (
          <Card key={r.id} size="small" hoverable onClick={() => nav(`/wms/pda/count/${r.id}`)} styles={{ body: { padding: 12 } }}>
            <div style={{ fontSize: 17, fontWeight: 700 }} className="mono">{r.no} {r.blind && <Tag color="purple">盲盘</Tag>}</div>
            <div>{r.warehouse_name} · {r.location_ids ? '指定库位' : '整仓'} · {r.created_by} {fmtDateTime(r.created_at)}</div>
          </Card>
        ))}
        {!rows.length && <Empty description="没有进行中的盘点单" />}
        {can('wms') && !creating && <BigButton icon={<PlusOutlined />} onClick={() => setCreating(true)}>新建盘点单</BigButton>}
        {creating && (
          <Card size="small" title="新建盘点单">
            <Form form={form} layout="vertical" size="large">
              <Form.Item name="warehouse_id" label="仓库" rules={[{ required: true, message: '请选择仓库' }]}><WarehouseSelect /></Form.Item>
              <Form.Item noStyle shouldUpdate>
                {() => (
                  <Form.Item name="location_ids" label="库位范围（可扫码多选，留空 = 整仓）">
                    <LocationSelect mode="multiple" params={{ warehouse_id: form.getFieldValue('warehouse_id') }} disabled={!form.getFieldValue('warehouse_id')} />
                  </Form.Item>
                )}
              </Form.Item>
              <Form.Item name="blind" label="盲盘（录入时不显示账面数）" valuePropName="checked"><Switch /></Form.Item>
              <Form.Item name="remark" label="备注"><Input placeholder="如：11 月防潮柜循环盘点" /></Form.Item>
            </Form>
            <BigButton loading={busy} onClick={create}>生成盘点单</BigButton>
          </Card>
        )}
      </Space>
    </PdaPage>
  );
}

export default function PdaCount() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const [d, setD] = useState<Rec | null>(null);
  const [curId, setCurId] = useState<number | null>(null);
  const [val, setVal] = useState('');
  const [locFilter, setLocFilter] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ lot: string; location_id: number; location_code: string; material?: Rec | null } | null>(null);
  const [addMat, setAddMat] = useState('');
  const [addQty, setAddQty] = useState('');
  const [busy, setBusy] = useState(false);
  const { fb, show } = useFeedback();
  const scanRef = useRef<ScanInputHandle>(null);
  const qtyRef = useRef<InputRef>(null);
  const addMatRef = useRef<InputRef>(null);
  const addQtyRef = useRef<InputRef>(null);

  const lines = useMemo(() => sortLines(d?.lines || []), [d]);
  const cur = lines.find((l) => l.id === curId) ?? null;
  const counted = lines.filter(isCounted).length;
  const open = d?.status === 'OPEN' && can('wms');
  const blind = !!d?.book_hidden;

  const load = async (keepCur = true) => {
    const r = await get(`/stock-counts/${id}`);
    setD(r);
    if (!keepCur || !curId) {
      const first = sortLines(r.lines).find((l) => !isCounted(l));
      setCurId(first?.id ?? null);
      setVal('');
    }
    return r;
  };
  useEffect(() => { load(false).then(() => focusLater(qtyRef)); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const select = (l: Rec, from?: string) => {
    setCurId(l.id);
    setVal(isCounted(l) ? String(l.counted_qty) : '');
    setLocFilter(l.location_code);
    if (from) show('info', from, false);
    focusLater(qtyRef, true);
  };

  /** 下一条未盘（同库位优先，再按路线顺序） */
  const nextAfter = (ls: Rec[], after: Rec | null) => {
    const sorted = sortLines(ls);
    const idx = after ? sorted.findIndex((l) => l.id === after.id) : -1;
    return sorted.slice(idx + 1).find((l) => !isCounted(l)) ?? sorted.find((l) => !isCounted(l)) ?? null;
  };

  const save = async () => {
    if (!cur || !open) return;
    const n = numText(val);
    if (n === null || Number.isNaN(n)) {
      // 在数量框里扫到条码：当作定位
      if (val.trim()) { const code = val.trim(); setVal(''); return locate(code); }
      return show('err', '请输入实盘数量（没有实物填 0）');
    }
    if (n < 0) return show('err', '实盘数量不能为负数');
    setBusy(true);
    try {
      const r = await put(`/stock-counts/${id}/lines`, [{ id: cur.id, counted_qty: n }]);
      setD(r);
      const saved = (r.lines as Rec[]).find((l) => l.id === cur.id);
      const diff = saved?.diff_qty;
      if (!blind && diff) show('warn', <>{cur.location_code} {cur.material_code} 批号 {cur.lot_no || '-'}：实盘 {fmtQty(n)}，差异 <b>{diff > 0 ? '+' : ''}{fmtQty(diff)}</b>。请复点确认</>);
      else show('ok', <>已记：{cur.location_code} {cur.material_code} {cur.lot_no || '-'} = <b>{fmtQty(n)}</b></>);
      const nx = nextAfter(r.lines, saved ?? cur);
      if (nx) {
        setCurId(nx.id);
        setVal('');
        setLocFilter(nx.location_code);
        focusLater(qtyRef);
      } else {
        setCurId(null);
        show('ok', '全部行已盘完。请核对差异后过账');
      }
    } catch (e) {
      show('err', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const locate = async (raw: string, parsed?: ScanResult) => {
    const code = (parsed?.raw ?? raw).trim();
    const lot = parsed?.lot || code;
    // 库位
    const byLoc = lines.filter((l) => String(l.location_code).toUpperCase() === code.toUpperCase());
    if (byLoc.length) {
      const l = byLoc.find((x) => !isCounted(x)) ?? byLoc[0];
      return select(l, `库位 ${l.location_code}：${byLoc.length} 行，未盘 ${byLoc.filter((x) => !isCounted(x)).length} 行`);
    }
    // 批号（优先当前库位）
    const byLot = lines.filter((l) => String(l.lot_no).toUpperCase() === lot.toUpperCase());
    if (byLot.length) {
      const l = byLot.find((x) => x.location_code === locFilter) ?? byLot.find((x) => !isCounted(x)) ?? byLot[0];
      return select(l, `定位到 ${l.location_code} ${l.material_code} 批号 ${l.lot_no}`);
    }
    // 账上没有：库位编码 → 定位空库位；批号 → 新增盘盈行
    try {
      const s = await get('/wms/scan', { code, lot: parsed?.lot, gtin: parsed?.gtin }, true);
      if (s.kind === 'LOCATION') {
        const inRange = !d?.range_codes?.length || d.range_codes.includes(s.code);
        if (!inRange || s.location.warehouse_id !== d?.warehouse_id) return show('err', `库位 ${s.code} 不在本盘点单范围内`);
        setLocFilter(s.code);
        return show('info', `库位 ${s.code} 账上没有库存。若有实物，请扫批次标签新增盘盈行`);
      }
      if (!locFilter) return show('err', `“${code}” 不在盘点单中。新增盘盈行前请先扫所在库位`);
      const locId = lines.find((l) => l.location_code === locFilter)?.location_id ?? (await get('/wms/scan', { code: locFilter }, true)).location?.id;
      const mat = s.kind === 'MATERIAL' ? s.material : s.rows?.[0] ? { id: s.rows[0].material_id, code: s.rows[0].material_code, name: s.rows[0].material_name } : s.sn ? { id: s.sn.material_id, code: s.sn.material_code } : null;
      const ok = await confirmEnter('账上没有这一批', <div style={{ fontSize: 16 }}>“{lot}” 不在本盘点单的 {locFilter} 中。是否作为<b>盘盈</b>新增一行？</div>, '新增盘盈行（回车）');
      if (!ok) return;
      setAdding({ lot: s.kind === 'MATERIAL' ? '' : lot, location_id: locId, location_code: locFilter, material: mat });
      setAddMat(mat?.code ?? '');
      setAddQty('');
      focusLater(mat ? addQtyRef : addMatRef);
    } catch (e) {
      show('err', errText(e));
    }
  };

  const addLine = async () => {
    if (!adding) return;
    let mid = adding.material?.id;
    if (!mid) {
      const m = await get('/materials', { q: addMat.trim(), page_size: 5 }, true).catch(() => ({ items: [] }));
      const hit = (m.items as Rec[]).find((x) => x.code.toUpperCase() === addMat.trim().toUpperCase());
      if (!hit) return show('err', `物料“${addMat}”不存在，请扫物料编码`);
      mid = hit.id;
    }
    const n = numText(addQty);
    if (n === null || !(n >= 0)) return show('err', '请输入实盘数量');
    try {
      const r = await post(`/stock-counts/${id}/add-line`, { material_id: mid, location_id: adding.location_id, lot_no: adding.lot || null, counted_qty: n }, true);
      setD(r);
      show('ok', `已新增盘盈行：${adding.location_code} 批号 ${adding.lot || '-'} = ${fmtQty(n)}`);
      setAdding(null);
      scanRef.current?.focus();
    } catch (e) {
      show('err', errText(e));
    }
  };

  const doPost = async () => {
    const chk = await get(`/stock-counts/${id}`, { review: 1 });
    const unc = (chk.lines as Rec[]).filter((l) => !isCounted(l));
    const diffs = (chk.lines as Rec[]).filter((l) => l.diff_qty);
    if (chk.moved_count) {
      const ok = await confirmEnter('盘点期间有库存变动', <div>有 {chk.moved_count} 行在建单后发生过收发/调拨（账面已变）。过账按“实盘 − 当前账面”调整，请确认这些行是在变动之后盘的。</div>, '已确认，继续');
      if (!ok) return;
    }
    let asBook = false;
    if (unc.length) {
      asBook = await confirmEnter(`还有 ${unc.length} 行未盘`, <div>未盘行将<b>按当前账面</b>处理（不调整库存）。确定过账？<br />如需继续盘点请点“返回”。</div>, '未盘按账面，过账', true);
      if (!asBook) return;
    } else {
      const ok = await confirmEnter('确认盘点过账', <div>共 {diffs.length} 行有差异，将按“实盘 − 当前账面”生成盘盈/盘亏调整。</div>, '过账（回车）');
      if (!ok) return;
    }
    try {
      const r = await post(`/stock-counts/${id}/post`, { uncounted_as_book: asBook }, true);
      setD(r);
      show('ok', `盘点单 ${r.no} 已过账，${(r.lines as Rec[]).filter((l) => l.diff_qty).length} 行生成调整`);
    } catch (e) {
      show('err', errText(e));
    }
  };

  if (!d) return <PdaPage title="盘点" back="/wms/pda/count"><Empty /></PdaPage>;
  const shown = locFilter ? lines.filter((l) => l.location_code === locFilter) : lines;

  return (
    <PdaPage
      title={<span className="mono">{d.no}</span>}
      sub={<>{d.warehouse_name} · {d.range_codes?.length ? d.range_codes.join('、') : '整仓'}{blind ? ' · 盲盘' : ''} · <StatusTag dict="doc_status" value={d.status} /></>}
      back="/wms/pda/count"
      extra={<Button size="large" icon={<ReloadOutlined />} onClick={() => load(true)} aria-label="刷新" />}
      footer={open ? (blind
        ? <Typography.Text type="secondary" style={{ padding: 8 }}>盲盘：盘完后请主管在电脑端“库存盘点”复核差异并过账</Typography.Text>
        : <BigButton icon={<AuditOutlined />} onClick={doPost}>过账（已盘 {counted}/{lines.length}）</BigButton>) : undefined}
    >
      <Progress percent={lines.length ? Math.round((counted / lines.length) * 100) : 0} format={() => `${counted}/${lines.length}`} />
      {d.moved_count > 0 && !blind && open && <Alert type="warning" showIcon style={{ margin: '6px 0' }} message={`${d.moved_count} 行在建单后有收发/调拨，账面已变（以当前账面为准）`} />}
      {open && <ScanInput ref={scanRef} onScan={(c, p) => locate(c, p)} autoFocus={false} placeholder="扫库位 / 批次标签定位" style={{ height: 48, fontSize: 17, marginTop: 6 }} />}
      <FeedbackBar fb={fb} />

      {open && adding && (
        <Card size="small" title={`新增盘盈行 · ${adding.location_code}`} style={{ margin: '8px 0', borderColor: '#faad14' }} extra={<Button size="large" onClick={() => setAdding(null)}>返回</Button>}>
          <div style={{ marginBottom: 6 }}>批号 <b className="mono">{adding.lot || '（无）'}</b></div>
          {!adding.material && <PdaField ref={addMatRef} label="物料编码（扫物料条码）" scan value={addMat} onChange={setAddMat} onEnter={() => addQtyRef.current?.focus()} />}
          {adding.material && <div style={{ marginBottom: 6 }}>物料 <b>{adding.material.code}</b> {adding.material.name}</div>}
          <PdaField ref={addQtyRef} label="实盘数量" value={addQty} onChange={setAddQty} inputMode="decimal" onEnter={addLine} />
          <BigButton onClick={addLine}>新增</BigButton>
        </Card>
      )}

      {open && cur && !adding && (
        <Card size="small" style={{ margin: '8px 0', borderColor: '#1677ff', borderWidth: 2 }} styles={{ body: { padding: 12 } }}>
          <div style={{ fontSize: 26, fontWeight: 800 }} className="mono">{cur.location_code}</div>
          <div style={{ fontSize: 17, fontWeight: 600 }}>{cur.material_code} <span style={{ fontWeight: 400, fontSize: 13, color: '#888' }}>{cur.material_name}</span></div>
          <div style={{ fontSize: 16 }}>批号 <b className="mono">{cur.lot_no || '-'}</b> <StatusTag dict="stock_status" value={cur.status} />{cur.owner_customer_id ? <Tag color="purple">客供</Tag> : null}</div>
          {!blind && <div style={{ fontSize: 15, color: '#595959' }}>账面 {fmtQty(cur.current_qty)} {cur.uom}{cur.moved ? <Tag color="orange" style={{ marginLeft: 6 }}>建单后有变动（快照 {fmtQty(cur.system_qty)}）</Tag> : null}</div>}
          <div style={{ marginTop: 8 }}>
            <PdaField ref={qtyRef} label={`实盘数量（${cur.uom}），回车保存并跳下一条`} value={val} onChange={setVal} onEnter={save} inputMode="decimal" active
              placeholder={blind ? '输入清点数量' : '输入清点数量，没有实物填 0'} />
          </div>
          <BigButton loading={busy} onClick={save}>保存并下一条</BigButton>
        </Card>
      )}
      {open && !cur && !adding && counted === lines.length && <Alert type="success" showIcon message="全部行已盘完" style={{ margin: '8px 0' }} />}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '10px 0 6px' }}>
        <b>{locFilter ? `库位 ${locFilter}` : '全部库位'}（{shown.filter(isCounted).length}/{shown.length}）</b>
        {locFilter && <Button onClick={() => setLocFilter(null)}>看全部</Button>}
      </div>
      <Space direction="vertical" style={{ width: '100%' }} size={4}>
        {shown.map((l) => (
          <div key={l.id} onClick={() => open && select(l)} role="button"
            style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', borderRadius: 6, border: `1px solid ${l.id === curId ? '#1677ff' : '#f0f0f0'}`, background: isCounted(l) ? '#fafafa' : '#fff', cursor: open ? 'pointer' : 'default' }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: 14 }}>
              <b className="mono">{l.location_code}</b> · {l.material_code} · <span className="mono">{l.lot_no || '-'}</span>
            </div>
            <div style={{ textAlign: 'right', fontSize: 15, minWidth: 70 }}>
              {isCounted(l) ? <b>{fmtQty(l.counted_qty)}</b> : <span style={{ color: '#bbb' }}>未盘</span>}
              {!blind && l.diff_qty ? <div style={{ color: l.diff_qty > 0 ? '#389e0d' : '#cf1322', fontSize: 12 }}>{l.diff_qty > 0 ? '+' : ''}{fmtQty(l.diff_qty)}</div> : null}
            </div>
          </div>
        ))}
      </Space>
      {!open && <Button type="link" onClick={() => nav(`/wms/counts?id=${d.id}`)}>在电脑端查看</Button>}
    </PdaPage>
  );
}
