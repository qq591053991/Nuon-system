/**
 * PDA 完工入库：扫工单号（或任一台 SN）→ 逐台扫 SN 核对（可选）→ 库位（默认成品库位）→ 入库。
 * 不逐台扫码时可“全部入库”（按完工数量）。
 */
import { Alert, Button, Card, Empty, Space, Tag } from 'antd';
import { CheckCircleFilled, DeleteOutlined, InboxOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { InputRef } from 'antd';
import { get, post, type Rec } from '../../../api/http';
import ScanInput, { type ScanInputHandle } from '../../../components/ScanInput';
import { useAuth } from '../../../auth';
import { dictLabel } from '../../../utils/dict';
import { fmtQty } from '../../../utils/format';
import type { ScanResult } from '../../../utils/scan';
import { BigButton, checkPlace, clearDraft, confirmEnter, errText, FeedbackBar, loadDraft, PdaField, PdaPage, saveDraft, useFeedback, useLeaveGuard } from './kit';

/** 本机暂存的已扫未入库 SN */
interface FgDraft { wo_id: number; wo_no: string; serials: string[] }

export default function PdaFgReceipt() {
  const [wo, setWo] = useState<Rec | null>(null);
  const [ready, setReady] = useState<Rec[]>([]); // 完工待入库的序列号
  const [scanned, setScanned] = useState<string[]>([]);
  const [loc, setLoc] = useState('');
  const [busy, setBusy] = useState(false);
  const { fb, show, clear } = useFeedback();
  const scanRef = useRef<ScanInputHandle>(null);
  const locRef = useRef<InputRef>(null);
  const [sp] = useSearchParams();
  const { user } = useAuth();
  /** 最近一次入库结果：一直显示到下一次入库（不被“待入库 N 台”提示覆盖） */
  const asked = useRef(false);
  const [lastDone, setLastDone] = useState<{ no: string; qty: number; loc: string; status: string } | null>(null);

  // 从工单详情跳转过来（?wo=<工单id>）时直接带出工单；否则检查本机是否有未入库的扫码
  useEffect(() => {
    const id = sp.get('wo');
    if (id) {
      get(`/work-orders/${id}`).then((w) => loadWo(w)).catch((e) => show('err', errText(e)));
      return;
    }
    const d = loadDraft<FgDraft>('fg', user?.username);
    if (!d?.data?.serials?.length || asked.current) return;
    asked.current = true; // 只询问一次（开发模式下副作用会执行两次）
    confirmEnter('恢复未入库的扫码？', `工单 ${d.data.wo_no} 已扫 ${d.data.serials.length} 台尚未入库。恢复后可继续扫或直接入库。`, `恢复 ${d.data.serials.length} 台`).then(async (ok) => {
      if (!ok) return clearDraft('fg', user?.username);
      const w = await get(`/work-orders/${d.data.wo_id}`, undefined, true).catch(() => null);
      if (w) await loadWo(w, undefined, d.data.serials);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 已扫未入库的 SN 暂存本机（刷新、锁屏后可恢复）
  useEffect(() => {
    if (wo && scanned.length) saveDraft<FgDraft>('fg', user?.username, { wo_id: wo.id, wo_no: wo.no, serials: scanned });
    else if (wo) clearDraft('fg', user?.username);
  }, [wo, scanned, user?.username]);
  useLeaveGuard(scanned.length > 0);

  const loadWo = async (w: Rec, firstSn?: string, restoreSns?: string[], quiet = false) => {
    if (!['IN_PROGRESS', 'COMPLETED'].includes(w.status)) return show('err', `工单 ${w.no} 状态不允许完工入库（需生产中或已完工）`);
    const sns: Rec[] = w.serial_control ? await get(`/work-orders/${w.id}/serials`, { status: 'COMPLETED' }, true) : [];
    const sug = await get('/wms/suggest-location', { material_id: w.material_id }, true).catch(() => null);
    setWo(w);
    setReady(sns);
    const keep = (restoreSns ?? []).filter((x) => sns.some((s) => s.sn === x));
    setScanned(keep.length ? keep : firstSn && sns.some((s) => s.sn === firstSn) ? [firstSn] : []);
    setLoc(sug?.code ?? '');
    const avail = w.serial_control ? sns.length : Math.max(0, (w.completed_qty || 0) - (w.received_qty || 0));
    if (restoreSns?.length) show('ok', <>已恢复工单 <b>{w.no}</b> 已扫 {keep.length} 台{restoreSns.length > keep.length ? `（${restoreSns.length - keep.length} 台已不在待入库清单，已移除）` : ''}</>);
    else if (quiet) clear();
    else show(avail ? 'ok' : 'warn', <>工单 <b>{w.no}</b> {w.material_code}：完工待入库 <b>{fmtQty(avail)}</b>{w.serial_control ? ' 台，请逐台扫 SN（可选）' : ''}</>);
  };

  const onScan = async (code: string, p: ScanResult) => {
    const raw = p.raw.trim();
    if (!wo) {
      try {
        const d = await get('/work-orders', { q: raw, status: 'IN_PROGRESS,COMPLETED', page_size: 5 }, true);
        const w = (d.items as Rec[]).find((x) => x.no.toUpperCase() === raw.toUpperCase());
        if (w) return loadWo(w);
        // 扫到 SN：找到所属工单
        const sn = p.sn || code;
        const s = await get('/wms/scan', { code: sn }, true);
        if (s.kind === 'SN') return loadWo(await get(`/work-orders/${s.sn.wo_id}`), s.sn.status === 'COMPLETED' ? s.sn.sn : undefined);
        return show('err', `“${raw}” 不是可入库的工单号或序列号`);
      } catch (e) {
        return show('err', errText(e));
      }
    }
    const sn = p.sn || code;
    if (scanned.includes(sn)) return show('err', `${sn} 已扫过，请勿重复扫描`);
    if (!ready.some((s) => s.sn === sn)) {
      const s = await get('/wms/scan', { code: sn }, true).catch(() => null);
      if (s?.kind === 'SN') {
        const st = s.sn.status;
        return show('err', st === 'IN_STOCK' ? `${sn} 已入库，请放到成品区` : st === 'COMPLETED' ? `${sn} 不是工单 ${wo.no} 的产品` : `${sn} 尚未完成全部工序（当前：${dictLabel('sn_status', st)}），不能入库`);
      }
      return show('err', `${sn} 不是本工单完工待入库的序列号`);
    }
    setScanned((x) => [sn, ...x]);
    show('ok', <>✓ {sn}（已扫 <b>{scanned.length + 1}</b> / {ready.length}）</>);
  };

  const submit = async (all: boolean) => {
    if (!wo) return;
    if (!all && !scanned.length) return show('err', '还没有扫描序列号；不逐台核对请点“全部入库”');
    const r = await checkPlace(wo.material_id, loc.trim(), null).catch((e) => ({ ok: false, errors: [errText(e)], warnings: [], location: null }));
    if (!r.ok || !r.location) {
      show('err', r.errors.join('；') || '请扫描入库库位');
      return locRef.current?.focus();
    }
    if (all && wo.serial_control && scanned.length) {
      const ok = await confirmEnter('全部入库', `已扫 ${scanned.length} 台，确定改为全部 ${ready.length} 台入库？`);
      if (!ok) return;
    }
    setBusy(true);
    try {
      const rc = all
        ? await post(`/work-orders/${wo.id}/fg-receipt`, { location_id: r.location.id }, true)
        : await post('/wms/fg-receipt', { wo_id: wo.id, location_id: r.location.id, serials: scanned }, true);
      const result = { no: rc.no, qty: rc.lines?.[0]?.qty ?? 0, loc: r.location.code, status: rc.lines?.[0]?.status === 'QUARANTINE' ? '待放行' : '合格' };
      setLastDone(result);
      clearDraft('fg', user?.username);
      const w = await get(`/work-orders/${wo.id}`);
      await loadWo(w, undefined, undefined, true); // 不覆盖入库结果
      show('ok', <>入库单 <b>{result.no}</b>：{fmtQty(result.qty)} 台入 <b>{result.loc}</b>（{result.status}）</>);
    } catch (e) {
      show('err', errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PdaPage title="完工入库" sub={wo ? `${wo.no} · ${wo.material_code}` : '扫工单号或任一台 SN'}
      extra={wo ? <Button size="large" onClick={() => { setWo(null); setScanned([]); clear(); }}>换单</Button> : undefined}
      footer={wo ? (
        <>
          {wo.serial_control && <BigButton loading={busy} icon={<InboxOutlined />} onClick={() => submit(false)}>入库已扫 {scanned.length} 台</BigButton>}
          <BigButton type={wo.serial_control ? 'default' : 'primary'} loading={busy} onClick={() => submit(true)}>全部入库</BigButton>
        </>
      ) : undefined}
    >
      {lastDone && (
        <div role="status" className="pda-last-done" style={{ background: '#f6ffed', border: '2px solid #52c41a', borderRadius: 8, padding: '10px 12px', marginBottom: 8, fontSize: 16, color: '#237804' }}>
          <CheckCircleFilled /> 已入库：入库单 <b>{lastDone.no}</b>，{fmtQty(lastDone.qty)} 台 → 库位 <b style={{ fontSize: 18 }}>{lastDone.loc}</b>（{lastDone.status}）
        </div>
      )}
      <ScanInput ref={scanRef} onScan={onScan} captureGlobal placeholder={wo ? '逐台扫 SN 核对' : '扫工单号 / SN'} style={{ height: 52, fontSize: 18 }} />
      <FeedbackBar fb={fb} />
      {wo && (
        <>
          <PdaField ref={locRef} label="入库库位（扫库位条码）" scan value={loc} onChange={setLoc} onEnter={() => scanRef.current?.focus()} hint="默认成品库位；未放行的产品入库后为“待放行”" />
          {wo.serial_control && (
            <>
              <div style={{ fontWeight: 600, margin: '8px 0 6px' }}>已扫 {scanned.length} / 待入库 {ready.length}</div>
              <Space direction="vertical" style={{ width: '100%' }} size={4}>
                {scanned.map((sn) => (
                  <div key={sn} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', border: '1px solid #f0f0f0', borderRadius: 6 }}>
                    <span className="mono" style={{ flex: 1, fontSize: 16 }}>{sn}</span>
                    <Button danger size="large" icon={<DeleteOutlined />} aria-label={`删除 ${sn}`} style={{ width: 48, height: 44 }}
                      onClick={() => { setScanned((x) => x.filter((s) => s !== sn)); show('info', `已移除 ${sn}`, false); scanRef.current?.focus(); }} />
                  </div>
                ))}
              </Space>
              {ready.length > scanned.length && (
                <Alert type="info" style={{ marginTop: 8 }} message={<>未扫：{ready.filter((s) => !scanned.includes(s.sn)).slice(0, 12).map((s) => <Tag key={s.sn} className="mono">{s.sn}</Tag>)}{ready.length - scanned.length > 12 ? '…' : ''}</>} />
              )}
            </>
          )}
        </>
      )}
      {!wo && <Card size="small" style={{ marginTop: 8 }}><Empty description="扫生产工单号开始；扫任一台整机 SN 也可自动找到工单" /></Card>}
    </PdaPage>
  );
}
