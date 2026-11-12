/**
 * 工位终端 · 返工换件引导：产品按 NCR 返工时，重测前先登记换件（或确认未换件）。
 *   ① 点选拆下的零件：本机已绑定的关键件、工单 BOM 用料，以及组件内的下级零件（如灯板里的驱动 IC，C-N4）；
 *      QA 处置意见里提到的零件自动预选；拆下行可补原批号、位号 / 部件序列号；
 *   ② 扫描装上的新零件批号（从合格库存按先到期先出补领；未选拆下件时自动生成同物料的拆下行）——扫码后焦点就在这里（N5）；
 *   ③【提交换件记录】（固定在面板底部，N9）→ 确认。
 * QA 处置时勾选“需更换零件”（Ncr.require_part_change）时，不能跳过登记（后端同样拦截）。
 */
import { Alert, App, Button, Input, Space, Tag, Typography, type InputRef } from 'antd';
import { CloseOutlined, DownOutlined, SwapOutlined, UpOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import type { Rec } from '../../api/http';
import { beep } from './station/feedback';
import { errDetail, num } from './spec';
import { stationGet, stationPost } from './stationApi';

interface RemovedRow { key: number; material_id: number; material: string; lot_no: string; part_sn: string; lots: string[]; designator?: string | null }
interface InstalledRow { key: number; material_id: number; material: string; lot_no: string; qty: number }

const ACTION_COLOR: Record<string, string> = { REMOVE: 'volcano', INSTALL: 'green', BIND: 'blue' };

export function KeyPartActionTag({ action, text }: { action: string; text?: string }) {
  return <Tag color={ACTION_COLOR[action] || 'default'} style={{ marginInlineEnd: 0 }}>{text || action}</Tag>;
}

interface Props {
  scan: Rec;
  token: string;
  /** 登记成功后刷新扫码信息 */
  onDone: () => void;
  /** 未更换零件，直接重测 */
  onSkip?: () => void;
  /** 无报工权限时只读 */
  readOnly?: boolean;
  sound?: boolean;
}

let seq = 0;

const rowOf = (c: Rec): RemovedRow => ({
  key: ++seq, material_id: c.material_id, material: `${c.code} ${c.name}`, lot_no: c.lot_no ?? '', part_sn: c.part_sn ?? '',
  lots: c.lots ?? [], designator: c.designator ?? null,
});

export default function ReworkPanel({ scan, token, onDone, onSkip, readOnly, sound = true }: Props) {
  const { modal, message } = App.useApp();
  const rw: Rec = scan.rework;
  const candidates: Rec[] = rw.candidates || [];
  const done: Rec[] = (scan.key_parts || []).filter((k: Rec) => k.action !== 'BIND' && k.ncr_no === rw.ncr_no);
  // QA 意见里提到的零件预选为拆下件
  const [removed, setRemoved] = useState<RemovedRow[]>(() => (readOnly ? [] : candidates.filter((c) => c.suggested).slice(0, 2).map(rowOf)));
  const [installed, setInstalled] = useState<InstalledRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [lot, setLot] = useState('');
  const [looking, setLooking] = useState(false);
  const [lookErr, setLookErr] = useState<string | null>(null);
  const [choices, setChoices] = useState<Rec[]>([]);
  const [showSub, setShowSub] = useState(false);
  const lotRef = useRef<InputRef>(null);

  // 扫码进入返工：焦点直接到②新零件批号框（N5）
  useEffect(() => {
    const t = setTimeout(() => lotRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, []);

  const candOf = (materialId: number) => candidates.find((c) => c.material_id === materialId);
  const sameCand = (r: RemovedRow, c: Rec) => r.material_id === c.material_id;
  const isRemoved = (c: Rec) => removed.some((r) => sameCand(r, c));
  const subCount = candidates.filter((c) => c.source === 'SUB' && !c.suggested).length;
  const visible = candidates.filter((c) => c.source !== 'SUB' || c.suggested || showSub || isRemoved(c));

  const toggleRemoved = (c: Rec) => {
    if (isRemoved(c)) setRemoved((l) => l.filter((r) => !sameCand(r, c)));
    else setRemoved((l) => [...l, rowOf(c)]);
    setTimeout(() => lotRef.current?.focus(), 30);
  };

  const patchRemoved = (key: number, p: Partial<RemovedRow>) => setRemoved((l) => l.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const addInstalled = (s: Rec) => {
    setInstalled((l) => [...l, { key: ++seq, material_id: s.material_id, material: `${s.material_code} ${s.material_name}`, lot_no: s.lot_no, qty: 1 }]);
    // 未选拆下件时，默认拆下同一物料（常见：坏件换新件），原批号取本机绑定/工单领用记录
    if (!removed.some((r) => r.material_id === s.material_id)) {
      const c = candOf(s.material_id);
      setRemoved((l) => [...l, c ? rowOf(c) : { key: ++seq, material_id: s.material_id, material: `${s.material_code} ${s.material_name}`, lot_no: '', part_sn: '', lots: [] }]);
    }
    setChoices([]);
    setLot('');
    setLookErr(null);
  };

  const lookup = async () => {
    const raw = lot.trim();
    if (!raw) return;
    const m = raw.match(/\(10\)([^()]+)/);
    const v = (m ? m[1] : raw).trim();
    setLooking(true);
    setLookErr(null);
    setChoices([]);
    try {
      const d = await stationGet(token, '/stock', { lot_no: v, status: 'AVAILABLE', page_size: 50 });
      const rows: Rec[] = (d.items || []).filter((s: Rec) => s.qty > 0 && s.lot_no === v);
      const mats = new Map<number, Rec>();
      rows.forEach((r) => mats.has(r.material_id) || mats.set(r.material_id, r));
      if (!mats.size) {
        setLookErr(`批次 ${v} 没有合格（已检验放行）库存，不能用于返工，请核对批号`);
        setLot('');
        beep('error', sound);
      } else if (mats.size === 1) addInstalled([...mats.values()][0]);
      else setChoices([...mats.values()]);
    } catch (e) {
      setLookErr(errDetail(e));
      setLot('');
      beep('error', sound);
    } finally {
      setLooking(false);
      setTimeout(() => lotRef.current?.focus(), 30);
    }
  };

  const submit = () => {
    if (!removed.length && !installed.length) {
      message.warning('请先点选拆下的零件或扫描装上的新零件');
      return;
    }
    modal.confirm({
      title: `提交返工换件记录（${scan.sn}）？`,
      width: 560,
      zIndex: 2100,
      okText: '确认提交',
      cancelText: '返回修改',
      content: (
        <div style={{ fontSize: 16 }}>
          <p>拆下 {removed.length} 项、装上 {installed.length} 项，关联不合格报告 <b>{rw.ncr_no}</b>。</p>
          {installed.length > 0 && <p>装上的零件从合格库存按先到期先出扣减（返工补料，记入单台追溯与 DHR），提交后不可修改。</p>}
        </div>
      ),
      onOk: async () => {
        setSaving(true);
        try {
          await stationPost(token, '/mes/rework-parts', {
            sn: scan.sn,
            removed: removed.map((r) => ({ material_id: r.material_id, lot_no: r.lot_no.trim() || undefined, part_sn: r.part_sn.trim() || undefined })),
            installed: installed.map(({ material_id, lot_no, qty }) => ({ material_id, lot_no, qty })),
          });
          message.success('返工换件已登记，请重新测试该工序');
          setRemoved([]);
          setInstalled([]);
          onDone();
        } catch (e) {
          modal.error({ title: '登记失败', content: errDetail(e), zIndex: 2200 });
        } finally {
          setSaving(false);
        }
      },
    });
  };

  const total = removed.length + installed.length;
  const mustRegister = rw.require_parts && !done.length;

  return (
    <div className="station-rework">
      <div className="rw-head">
        <Space wrap size={6}>
          <SwapOutlined style={{ color: '#fa8c16' }} />
          <b>返工换件</b>
          <Tag color="orange">{rw.ncr_no}</Tag>
          <span>工序 {rw.ng_seq} {rw.op_name} 不合格</span>
          {rw.require_parts && <Tag color="red">QA 要求换件</Tag>}
        </Space>
        <div className={`rw-qa${mustRegister ? ' must' : ''}`}>
          QA 处置意见：<b>{rw.disposition_remark || '返工'}</b>
          {mustRegister ? '（必须先登记换件才能重测）' : ''}
        </div>
      </div>
      {done.length > 0 && (
        <div className="rw-done">
          本次已登记：
          {done.map((k) => (
            <span key={k.id} style={{ marginRight: 10 }}>
              <KeyPartActionTag action={k.action} text={k.action_text} /> {k.material_code} {k.lot_no ? `· ${k.lot_no}` : ''}{k.part_sn ? ` · ${k.part_sn}` : ''}
            </span>
          ))}
        </div>
      )}
      {!readOnly && (
        <>
          <div className="rw-step">
            <Typography.Text strong>① 点选拆下的零件</Typography.Text>
            {subCount > 0 && (
              <Button size="small" type="link" icon={showSub ? <UpOutlined /> : <DownOutlined />} onClick={() => setShowSub((x) => !x)}>
                {showSub ? '收起组件内零件' : `显示组件内零件（${subCount}）`}
              </Button>
            )}
          </div>
          <div className="rw-cands">
            {visible.map((c) => (
              <button key={`${c.source}-${c.material_id}-${c.part_sn ?? ''}`} type="button" className={`rw-cand${isRemoved(c) ? ' on' : ''}${c.suggested ? ' sug' : ''}`} onClick={() => toggleRemoved(c)}>
                <b className="mono">{c.code}</b> {c.name}
                <div className="rw-sub">
                  {c.suggested ? 'QA 意见提到 · ' : ''}{c.source === 'BIND' ? '本机绑定' : c.source === 'SUB' ? `${c.parent_code} 内` : 'BOM'}
                  {c.designator ? ` · 位号 ${c.designator}` : ''}{c.lot_no || c.lots?.length ? ` · 批号 ${c.lot_no || c.lots.join('/')}` : ''}
                </div>
              </button>
            ))}
          </div>
          <div className="rw-step"><Typography.Text strong>② 扫描装上的新零件批号</Typography.Text></div>
          <Input
            ref={lotRef}
            data-rework-lot="1"
            size="large"
            disabled={looking}
            placeholder="扫描新零件批号后回车（从合格库存补领）"
            value={lot}
            onChange={(e) => {
              setLot(e.target.value);
              setLookErr(null);
            }}
            onPressEnter={(e) => {
              e.preventDefault();
              e.stopPropagation();
              lookup();
            }}
          />
          {lookErr && <div className="sp-err" style={{ fontSize: 15 }}>{lookErr}</div>}
          {choices.length > 0 && (
            <Space wrap style={{ marginTop: 6 }}>
              该批号对应多个物料，请选择：
              {choices.map((s) => <Button key={s.material_id} size="large" onClick={() => addInstalled(s)}>{s.material_code} {s.material_name}</Button>)}
            </Space>
          )}
          {total > 0 && (
            <div className="rw-list">
              {removed.map((r) => (
                <div key={r.key} className="rw-row">
                  <KeyPartActionTag action="REMOVE" text="拆下" />
                  <span className="rw-mat">{r.material}</span>
                  <Input size="middle" style={{ width: 150 }} placeholder="原批号（可选）" value={r.lot_no} list={`rw-lots-${r.key}`}
                    onChange={(e) => patchRemoved(r.key, { lot_no: e.target.value })} />
                  {r.lots.length > 0 && <datalist id={`rw-lots-${r.key}`}>{r.lots.map((x) => <option key={x} value={x} />)}</datalist>}
                  <Input size="middle" style={{ width: 170 }} placeholder={r.designator ? `位号（${r.designator}）` : '位号 / 部件序列号'} value={r.part_sn}
                    onChange={(e) => patchRemoved(r.key, { part_sn: e.target.value })} />
                  <Button type="text" danger className="rw-del" icon={<CloseOutlined />} onClick={() => setRemoved((l) => l.filter((x) => x.key !== r.key))} />
                </div>
              ))}
              {installed.map((r) => (
                <div key={r.key} className="rw-row">
                  <KeyPartActionTag action="INSTALL" text="装上" />
                  <span className="rw-mat">{r.material}</span>
                  <span className="mono">{r.lot_no} × {num(r.qty)}</span>
                  <Button type="text" danger className="rw-del" icon={<CloseOutlined />} onClick={() => setInstalled((l) => l.filter((x) => x.key !== r.key))} />
                </div>
              ))}
            </div>
          )}
          <div className="rw-bar">
            <Button size="large" type="primary" className="station-btn-md" style={{ flex: 2, background: total ? '#fa8c16' : undefined, borderColor: total ? '#fa8c16' : undefined }}
              loading={saving} disabled={!total} onClick={submit}>
              ③ 提交换件记录{total ? `（${total} 项）` : ''}
            </Button>
            {onSkip && !mustRegister && (
              <Button size="large" className="station-btn-md" style={{ flex: 1 }} onClick={onSkip}>{done.length ? '换件已登记，开始重测' : '未更换零件，直接重测'}</Button>
            )}
          </div>
        </>
      )}
      {readOnly && <Alert type="warning" showIcon message="当前操作员没有生产报工权限，不能登记返工换件" />}
    </div>
  );
}
