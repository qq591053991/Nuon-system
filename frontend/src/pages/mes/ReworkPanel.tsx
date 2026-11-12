/**
 * 工位终端 · 返工换件引导（C-F17）：产品按 NCR 返工时，重测前先登记换件（或确认未换件）。
 *   ① 点选拆下的零件（本机已绑定的关键件 / 工单 BOM 用料，原批号自动带出）；
 *   ② 扫描装上的新零件批号（从合格库存按先到期先出补领；未选拆下件时自动生成同物料的拆下行）；
 *   ③【提交换件记录】→ 确认。约 4 步（原 12 次点击 + 6 次输入）。
 * QA 处置意见要求换件时，不能跳过登记（后端同样拦截）。
 */
import { Alert, App, Button, Card, Input, Space, Table, Tag, Typography, type InputRef } from 'antd';
import { CloseOutlined, SwapOutlined } from '@ant-design/icons';
import { useRef, useState } from 'react';
import type { Rec } from '../../api/http';
import { fmtDateTime } from '../../utils/format';
import { beep } from './station/feedback';
import { errDetail, num } from './spec';
import { stationGet, stationPost } from './stationApi';

interface RemovedRow { key: number; material_id: number; material: string; lot_no?: string | null; part_sn?: string | null }
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

export default function ReworkPanel({ scan, token, onDone, onSkip, readOnly, sound = true }: Props) {
  const { modal, message } = App.useApp();
  const rw: Rec = scan.rework;
  const candidates: Rec[] = rw.candidates || [];
  const done: Rec[] = (scan.key_parts || []).filter((k: Rec) => k.action !== 'BIND' && k.ncr_no === rw.ncr_no);
  const [removed, setRemoved] = useState<RemovedRow[]>([]);
  const [installed, setInstalled] = useState<InstalledRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [lot, setLot] = useState('');
  const [looking, setLooking] = useState(false);
  const [lookErr, setLookErr] = useState<string | null>(null);
  const [choices, setChoices] = useState<Rec[]>([]);
  const lotRef = useRef<InputRef>(null);

  const candOf = (materialId: number) => candidates.find((c) => c.material_id === materialId);
  const isRemoved = (c: Rec) => removed.some((r) => r.material_id === c.material_id && (r.part_sn ?? null) === (c.part_sn ?? null));

  const toggleRemoved = (c: Rec) => {
    if (isRemoved(c)) {
      setRemoved((l) => l.filter((r) => !(r.material_id === c.material_id && (r.part_sn ?? null) === (c.part_sn ?? null))));
      return;
    }
    setRemoved((l) => [...l, { key: ++seq, material_id: c.material_id, material: `${c.code} ${c.name}`, lot_no: c.lot_no ?? null, part_sn: c.part_sn ?? null }]);
    setTimeout(() => lotRef.current?.focus(), 30);
  };

  const addInstalled = (s: Rec) => {
    setInstalled((l) => [...l, { key: ++seq, material_id: s.material_id, material: `${s.material_code} ${s.material_name}`, lot_no: s.lot_no, qty: 1 }]);
    // 未选拆下件时，默认拆下同一物料（常见：坏件换新件），原批号取本机绑定/工单领用记录
    if (!removed.some((r) => r.material_id === s.material_id)) {
      const c = candOf(s.material_id);
      setRemoved((l) => [...l, { key: ++seq, material_id: s.material_id, material: `${s.material_code} ${s.material_name}`, lot_no: c?.lot_no ?? null, part_sn: c?.part_sn ?? null }]);
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
            removed: removed.map(({ material_id, lot_no, part_sn }) => ({ material_id, lot_no: lot_no || undefined, part_sn: part_sn || undefined })),
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

  return (
    <Card className="station-rework" size="small" title={<Space><SwapOutlined style={{ color: '#fa8c16' }} />返工换件<Tag color="orange">{rw.ncr_no}</Tag><span style={{ fontWeight: 400 }}>工序 {rw.ng_seq} {rw.op_name} 不合格</span></Space>}>
      <Alert
        type={rw.require_parts && !done.length ? 'error' : 'warning'}
        showIcon
        style={{ marginBottom: 10 }}
        message={<b style={{ fontSize: 17 }}>QA 处置意见：{rw.disposition_remark || '返工'}</b>}
        description={
          rw.require_parts && !done.length
            ? '要求更换零件：必须先登记拆下 / 装上的零件（①点选拆下件 → ②扫新零件批号 → ③提交），才能重新测试。'
            : '如更换了零件请先登记（①点选拆下件 → ②扫新零件批号 → ③提交）；未换件请点【未更换零件，直接重测】。'
        }
      />
      {done.length > 0 && (
        <Table<Rec> rowKey="id" size="small" pagination={false} style={{ marginBottom: 10 }} dataSource={done} columns={[
          { title: '本次已登记', dataIndex: 'action', render: (v, r) => <KeyPartActionTag action={v} text={r.action_text} /> },
          { title: '零件', key: 'm', render: (_, r) => `${r.material_code} ${r.material_name}` },
          { title: '批号', dataIndex: 'lot_no', render: (v) => <span className="mono">{v || '-'}</span> },
          { title: '部件序列号', dataIndex: 'part_sn', render: (v) => v || '-' },
          { title: '操作员', dataIndex: 'operator_name' },
          { title: '时间', dataIndex: 'ts', render: (v) => fmtDateTime(v) },
        ]} />
      )}
      {!readOnly && (
        <>
          <Typography.Text strong style={{ fontSize: 16 }}>① 点选拆下的零件</Typography.Text>
          <div className="rw-cands">
            {candidates.map((c) => (
              <button key={`${c.material_id}-${c.part_sn ?? ''}`} type="button" className={`rw-cand${isRemoved(c) ? ' on' : ''}`} onClick={() => toggleRemoved(c)}>
                <b className="mono">{c.code}</b> {c.name}
                <div className="rw-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {c.source === 'BIND' ? '本机绑定' : 'BOM'} · 批号 {c.lot_no || (c.lots?.length ? c.lots.join('/') : '-')}
                  {c.part_sn ? ` · ${c.part_sn}` : ''}
                </div>
              </button>
            ))}
          </div>
          <Typography.Text strong style={{ fontSize: 16 }}>② 扫描装上的新零件批号</Typography.Text>
          <Input
            ref={lotRef}
            size="large"
            style={{ marginTop: 6 }}
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
          {lookErr && <div className="sp-err" style={{ fontSize: 16 }}>{lookErr}</div>}
          {choices.length > 0 && (
            <Space wrap style={{ marginTop: 8 }}>
              该批号对应多个物料，请选择：
              {choices.map((s) => <Button key={s.material_id} size="large" onClick={() => addInstalled(s)}>{s.material_code} {s.material_name}</Button>)}
            </Space>
          )}
          {total > 0 && (
            <div className="rw-list">
              {removed.map((r) => (
                <div key={r.key} className="rw-row">
                  <KeyPartActionTag action="REMOVE" text="拆下" />
                  <span>{r.material}</span>
                  <span className="mono">{r.lot_no || ''}{r.part_sn ? ` · ${r.part_sn}` : ''}</span>
                  <Button type="text" danger className="rw-del" icon={<CloseOutlined />} onClick={() => setRemoved((l) => l.filter((x) => x.key !== r.key))} />
                </div>
              ))}
              {installed.map((r) => (
                <div key={r.key} className="rw-row">
                  <KeyPartActionTag action="INSTALL" text="装上" />
                  <span>{r.material}</span>
                  <span className="mono">{r.lot_no} × {num(r.qty)}</span>
                  <Button type="text" danger className="rw-del" icon={<CloseOutlined />} onClick={() => setInstalled((l) => l.filter((x) => x.key !== r.key))} />
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
            <Button size="large" type="primary" className="station-btn-md" style={{ flex: 2, background: total ? '#fa8c16' : undefined, borderColor: total ? '#fa8c16' : undefined }}
              loading={saving} disabled={!total} onClick={submit}>
              ③ 提交换件记录{total ? `（${total} 项）` : ''}
            </Button>
            {onSkip && !(rw.require_parts && !done.length) && (
              <Button size="large" className="station-btn-md" style={{ flex: 1 }} onClick={onSkip}>{done.length ? '换件已登记，开始重测' : '未更换零件，直接重测'}</Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
