import { Alert, Anchor, Button, Card, Descriptions, Empty, Result, Space, Spin, Switch, Table, Tag, Tooltip, Typography, message } from 'antd';
import {
  ArrowLeftOutlined, CheckCircleFilled, CloseCircleFilled, ExclamationCircleFilled, SafetyCertificateOutlined, SplitCellsOutlined, StopOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import { isCancel, useESign } from '../../components/ESign';
import { PrintButton, PrintHeader, PrintSignatures } from '../../components/Print';
import StatusTag from '../../components/StatusTag';
import { dictLabel } from '../../utils/dict';
import { fmtDate, fmtDateTime, fmtQty } from '../../utils/format';
import { ReleaseBatchModal, ReleaseTable, snText } from '../mes/ReleaseBatch';
import { ParamsText, ValuesText } from '../mes/spec';

const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三'];

/** 打印友好的样式（只作用于 .dhr-doc） */
const DHR_CSS = `
.dhr-doc .dhr-section { margin-top: 24px; scroll-margin-top: 120px; }
.dhr-doc .dhr-section h3 { font-size: 16px; font-weight: 700; border-left: 4px solid #5b3cc4; padding-left: 8px; margin: 0 0 10px; }
.dhr-doc .dhr-check { display: flex; gap: 10px; align-items: flex-start; padding: 6px 0; border-bottom: 1px dashed #f0f0f0; }
.dhr-doc .dhr-nav { position: sticky; top: 64px; z-index: 5; background: #fff; padding: 4px 8px; margin-bottom: 12px; border-radius: 6px; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
.dhr-doc .verdict td { vertical-align: top; }
@media print {
  .dhr-doc { font-size: 12px; }
  .dhr-doc .ant-card { border: none !important; box-shadow: none !important; }
  .dhr-doc .ant-card-body { padding: 0 !important; }
  .dhr-doc .dhr-section { break-inside: auto; }
  .dhr-doc .dhr-section h3 { break-after: avoid; }
  .dhr-doc .ant-table { font-size: 10px; }
  .dhr-doc a { color: inherit !important; text-decoration: none !important; }
}
`;

const SECTIONS: { key: string; title: string }[] = [
  { key: 'verdict', title: '放行结论' },
  { key: 'product', title: '产品与批信息' },
  { key: 'checks', title: '整单放行条件' },
  { key: 'materials', title: '物料批次' },
  { key: 'ops', title: '工序直通率' },
  { key: 'serials', title: '序列号与 UDI' },
  { key: 'records', title: '过站与测试' },
  { key: 'keyparts', title: '关键件' },
  { key: 'equipment', title: '设备' },
  { key: 'ncrs', title: '不合格品' },
  { key: 'releases', title: '放行记录' },
  { key: 'signatures', title: '电子签名' },
];

function Section({ id, index, title, extra, children }: { id: string; index: number; title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="dhr-section" id={`dhr-${id}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h3>{CN[index]}、{title}</h3>
        {extra}
      </div>
      {children}
    </div>
  );
}

const calStatus = (e: Rec) => {
  if (!e.calibration_required) return <Tag>无需校准</Tag>;
  if (!e.next_calibration_date) return <Tag color="red">未校准</Tag>;
  return dayjs(e.next_calibration_date).isBefore(dayjs(), 'day') ? <Tag color="red">已过期</Tag> : <Tag color="green">有效</Tag>;
};

/** 检查项图标：通过 / 提示 / 不通过 */
function Mark({ c }: { c?: Rec }) {
  if (!c) return <span>-</span>;
  const icon = c.level === 'ok'
    ? <CheckCircleFilled style={{ color: '#52c41a', fontSize: 16 }} />
    : c.level === 'warn' ? <ExclamationCircleFilled style={{ color: '#faad14', fontSize: 16 }} /> : <CloseCircleFilled style={{ color: '#ff4d4f', fontSize: 16 }} />;
  return <Tooltip title={c.text}><span style={{ cursor: 'help' }}>{icon}<span className="print-only" style={{ display: 'none', fontSize: 9 }}>{c.text}</span></span></Tooltip>;
}

/** 放行结论卡：按序列号逐项检查 */
function VerdictCard({ rc, onRelease, canBatch }: { rc: Rec; onRelease: (sns: string[]) => void; canBatch: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const defs: Rec[] = rc.checks_def || [];
  const s: Rec = rc.summary || {};
  if (!rc.serial_control) {
    const lv: Rec = rc.wo_level || {};
    return (
      <Table<Rec> size="small" pagination={false} rowKey="key" className="verdict"
        dataSource={[...defs.map((d) => ({ key: d.key, label: d.label, c: lv[d.key] })), { key: 'issue', label: '物料足额领用', c: rc.wo_checks?.issue }]}
        columns={[
          { title: '检查项', dataIndex: 'label', width: 140 },
          { title: '结论', key: 'm', width: 60, render: (_, r) => <Mark c={r.c} /> },
          { title: '说明', key: 't', render: (_, r) => <Typography.Text type={r.c?.level === 'fail' ? 'danger' : r.c?.level === 'warn' ? 'warning' : 'secondary'}>{r.c?.text}</Typography.Text> },
        ]} />
    );
  }
  const units: Rec[] = (rc.units || []).filter((u: Rec) => showAll || u.eligible);
  const ready: string[] = (rc.units || []).filter((u: Rec) => u.eligible && u.ok).map((u: Rec) => u.sn);
  const issue = rc.wo_checks?.issue;
  return (
    <>
      <Space wrap style={{ marginBottom: 8 }} className="no-print">
        <Tag color={s.ready ? 'green' : 'default'} style={{ fontSize: 14, padding: '2px 10px' }}>可放行 {s.ready} 台</Tag>
        {s.blocked > 0 && <Tag color="red" style={{ fontSize: 14, padding: '2px 10px' }}>有问题 {s.blocked} 台</Tag>}
        <Tag>已放行 {s.released} 台</Tag>
        <Tag>在制/未入库 {s.in_process} 台</Tag>
        {canBatch && ready.length > 0 && issue?.ok && (
          <Button type="primary" icon={<SafetyCertificateOutlined />} onClick={() => onRelease(ready)}>放行检查通过的 {ready.length} 台（电子签名）</Button>
        )}
        <Space size={4}><Switch size="small" checked={showAll} onChange={setShowAll} /><span>显示全部序列号</span></Space>
      </Space>
      {issue && !issue.ok && <Alert type="error" showIcon style={{ marginBottom: 8 }} message={`物料未足额领用，不能放行：${issue.text}`} />}
      <Table<Rec>
        rowKey="sn"
        size="small"
        className="verdict"
        dataSource={units}
        pagination={units.length > 20 ? { pageSize: 20, size: 'small' } : false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: showAll ? '无序列号' : '暂无待放行的产品（已完工入库、尚未放行）' }}
        rowClassName={(u) => (u.ok ? '' : 'ant-table-row-danger')}
        onRow={(u) => ({ style: !u.ok && u.eligible ? { background: '#fff1f0' } : undefined })}
        columns={[
          { title: '序列号', dataIndex: 'sn', fixed: 'left', render: (v) => <Link className="mono" to={`/trace?sn=${encodeURIComponent(v)}`}>{v}</Link> },
          {
            title: '结论', key: 'ok',
            render: (_, u) => (u.released ? <Tag color="green">已放行 {u.release_no}</Tag>
              : u.release_status === 'REJECTED' ? <Tag color="red">已拒绝</Tag>
                : !u.eligible ? <Tag>{dictLabel('sn_status', u.status)}</Tag>
                  : u.ok ? <Tag color="green">可放行</Tag> : <Tag color="red">不可放行</Tag>),
          },
          ...defs.map((d) => ({ title: d.label, key: d.key, align: 'center' as const, render: (_: any, u: Rec) => <Mark c={u.checks?.[d.key]} /> })),
          {
            title: '问题说明', key: 'why',
            render: (_, u) => {
              const bad = defs.map((d) => [d.label, u.checks?.[d.key]] as [string, Rec]).filter(([, c]) => c && c.level !== 'ok');
              return bad.length ? <Space direction="vertical" size={0}>{bad.map(([l, c]) => <Typography.Text key={l} type={c.level === 'fail' ? 'danger' : 'warning'} style={{ fontSize: 12 }}>{l}：{c.text}</Typography.Text>)}</Space> : <Typography.Text type="secondary" style={{ fontSize: 12 }}>全部通过</Typography.Text>;
            },
          },
        ]}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        <CheckCircleFilled style={{ color: '#52c41a' }} /> 通过　<ExclamationCircleFilled style={{ color: '#faad14' }} /> 提示（不阻止放行，请审核）　<CloseCircleFilled style={{ color: '#ff4d4f' }} /> 不通过。鼠标悬停查看依据。
      </Typography.Text>
    </>
  );
}

/** 过站记录：按序列号折叠（批量报工单独列出），打印时展开全部 */
function RecordsBySn({ records }: { records: Rec[] }) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const groups = useMemo(() => {
    const m = new Map<string, Rec[]>();
    for (const r of records) {
      const k = r.sn ?? '（批量报工）';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return [...m].map(([sn, recs]) => ({
      sn, recs, n: recs.length, fail: recs.filter((x) => x.result === 'FAIL').length, rework: recs.some((x) => x.is_rework),
      last: recs[recs.length - 1], operators: [...new Set(recs.map((x) => x.operator_name).filter(Boolean))].join('、'),
    }));
  }, [records]);
  const recColumns: any[] = [
    { title: '时间', dataIndex: 'ts', render: (v: string) => dayjs(v).format('MM-DD HH:mm:ss') },
    { title: '序列号', dataIndex: 'sn', render: (v: string, r: Rec) => (v ? <span className="mono">{v}</span> : `批量 ${fmtQty(r.qty)}`) },
    { title: '工序', key: 'op', render: (_: any, r: Rec) => `${r.seq} ${r.op_name}` },
    { title: '结果', dataIndex: 'result', render: (v: string, r: Rec) => <Space size={4}><StatusTag dict="result" value={v} />{r.is_rework && <Tag color="orange">返工</Tag>}</Space> },
    { title: '测试数据（实测值(规格) 判定）', dataIndex: 'values', render: (v: Rec[]) => <ValuesText values={v} block /> },
    { title: '操作员', dataIndex: 'operator_name' },
    { title: '设备', dataIndex: 'equipment_code', render: (v: string) => v || '-' },
  ];
  if (!records.length) return <Typography.Text type="secondary">尚无报工记录</Typography.Text>;
  return (
    <>
      <div className="no-print">
        <Space style={{ marginBottom: 8 }}>
          <Button size="small" onClick={() => setExpanded(groups.map((g) => g.sn))}>全部展开</Button>
          <Button size="small" onClick={() => setExpanded([])}>全部折叠</Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>共 {groups.length} 台 / {records.length} 条记录，点击行展开该台的过站与测试数据</Typography.Text>
        </Space>
        <Table<Rec>
          rowKey="sn" size="small" dataSource={groups} pagination={groups.length > 30 ? { pageSize: 30, size: 'small' } : false} scroll={{ x: 'max-content' }}
          expandable={{
            expandedRowKeys: expanded,
            onExpandedRowsChange: (k) => setExpanded(k as string[]),
            expandRowByClick: true,
            expandedRowRender: (g) => <Table<Rec> rowKey={(r) => `${r.ts}-${r.seq}`} size="small" pagination={false} dataSource={g.recs} columns={recColumns.filter((c) => c.dataIndex !== 'sn')} scroll={{ x: 'max-content' }} />,
          }}
          columns={[
            { title: '序列号', dataIndex: 'sn', render: (v) => <span className="mono">{v}</span> },
            { title: '记录数', dataIndex: 'n', align: 'right' },
            { title: '最后工序', key: 'last', render: (_, g) => <Space size={4}>{`${g.last.seq} ${g.last.op_name}`}<StatusTag dict="result" value={g.last.result} /></Space> },
            { title: '不合格/返工', key: 'f', render: (_, g) => <Space size={4}>{g.fail > 0 && <Tag color="red">不合格 {g.fail} 次</Tag>}{g.rework && <Tag color="orange">返工</Tag>}{!g.fail && !g.rework && '-'}</Space> },
            { title: '操作员', dataIndex: 'operators' },
          ]}
        />
      </div>
      <div className="print-only">
        <Table<Rec> rowKey={(r) => `${r.sn}-${r.ts}-${r.seq}`} size="small" pagination={false} dataSource={records} columns={recColumns} />
      </div>
    </>
  );
}

export default function DhrView() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { can } = useAuth();
  const [sign, signHolder] = useESign();
  const [d, setD] = useState<Rec | null>(null);
  const [rc, setRc] = useState<Rec | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [batch, setBatch] = useState<{ open: boolean; preselect: string[] | null }>({ open: false, preselect: null });

  const load = useCallback(() => {
    get(`/work-orders/${id}/dhr`).then(setD).catch(() => setFailed(true));
    get(`/quality/release-check/${id}`, undefined, true).then(setRc).catch(() => setRc(null));
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  if (failed && !d) return <Result status="404" title="DHR 不存在" extra={<Button onClick={() => nav('/quality/release')}>返回放行中心</Button>} />;
  if (!d) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>;

  const wo: Rec = d.work_order;
  const p: Rec = d.product;
  const checks: Rec[] = d.checks || [];
  const bad = checks.filter((c) => !c.ok);
  const canDecide = can('qa') && wo.dhr_status === 'OPEN' && wo.status === 'COMPLETED';
  const rs: Rec = d.release_summary || {};
  const unit = wo.serial_control ? ' 台' : ` ${wo.uom ?? ''}`;
  /** 可分批放行：已入库、尚未放行（也未拒绝）的产品 */
  const canBatch = can('qa') && wo.dhr_status === 'OPEN' && ['IN_PROGRESS', 'COMPLETED'].includes(wo.status) && (rs.releasable_qty || 0) > 0;
  const remaining = Math.max(0, (wo.received_qty || 0) - (wo.released_qty || 0) - (rs.rejected_qty || 0));
  const unitsBad = (rc?.units || []).filter((u: Rec) => u.eligible && !u.ok);
  let sec = 0;

  // 签名区：DHR/放行签名 + 本批 NCR 处置/关闭签名，按时间排序；放行签名列出序列号
  const relBy = new Map<string, Rec>((d.releases || []).map((r: Rec) => [r.no, r]));
  const sigs: Rec[] = [...(d.signatures || []), ...(rc?.ncr_signatures || [])]
    .sort((a, b) => dayjs(a.ts).valueOf() - dayjs(b.ts).valueOf())
    .map((s, i) => ({ ...s, _k: i, sn_list: relBy.get(s.doc_no)?.sn_list ?? null }));

  const approve = async () => {
    setBusy(true);
    try {
      await sign({
        meaning: '产品放行（DHR审核批准）',
        description: `批准工单 ${wo.no}（批号 ${wo.lot_no}）整单放行：剩余未放行的 ${remaining}${unit} 成品由“待放行”转为“合格”，可以发货；工单关闭。${wo.serial_control && rs.serials?.length ? ` 序列号：${snText(rs.serials.map((s: Rec) => s.sn))}。` : ''}`,
        defaultReason: '记录完整，批准放行',
        submit: (signature) => post(`/work-orders/${id}/dhr/release`, { approve: true, reason: signature.reason, signature }, true),
      });
      message.success('已放行全部剩余：该批成品已转为合格库存，可以发货');
      load();
    } catch (e) {
      if (!isCancel(e)) throw e;
    } finally {
      setBusy(false);
    }
  };

  /** 放行结论中全部检查通过的产品：一次签名直接放行（无需再选） */
  const releaseReady = async (sns: string[]) => {
    setBusy(true);
    try {
      const r = await sign({
        meaning: '产品放行（分批）',
        description: `批准工单 ${wo.no}（批号 ${wo.lot_no}）本批 ${sns.length} 台放行（放行结论六项检查全部通过）：成品由“待放行”转为“合格”，可以发货。序列号：${snText([...sns].sort())}。`,
        defaultReason: `放行检查全部通过，批准放行${sns.length <= 6 ? `（${[...sns].sort().join('、')}）` : ''}`,
        submit: (signature) => post(`/work-orders/${id}/releases`, { serials: sns, approve: true, reason: signature.reason, signature }, true),
      });
      message.success(`放行批 ${r.release.no} 已放行 ${sns.length} 台${r.dhr_status === 'RELEASED' ? '；该工单已全部放行并关闭' : ''}`);
      load();
    } catch (e) {
      if (!isCancel(e)) throw e;
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    setBusy(true);
    try {
      await sign({
        meaning: '产品放行（DHR审核拒绝）',
        description: '拒绝放行后，该批剩余未放行的成品库存将被冻结（HOLD），不能发货（已放行的批次不受影响）。请填写拒绝原因。',
        reasonRequired: true,
        submit: (signature) => post(`/work-orders/${id}/dhr/release`, { approve: false, reason: signature.reason, signature }, true),
      });
      message.warning('已拒绝放行，该批成品已冻结');
      load();
    } catch (e) {
      if (!isCancel(e)) throw e;
    } finally {
      setBusy(false);
    }
  };

  const sectionItems = SECTIONS.filter((s) => s.key !== 'serials' || d.serials?.length).map((s) => ({ key: s.key, href: `#dhr-${s.key}`, title: s.title }));

  return (
    <div className="dhr-doc">
      <style>{DHR_CSS}</style>
      {signHolder}
      <ReleaseBatchModal wo={wo} open={batch.open} preselect={batch.preselect} onClose={() => setBatch({ open: false, preselect: null })} onDone={load} />
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <Space wrap>
          <Button icon={<ArrowLeftOutlined />} onClick={() => nav(-1)}>返回</Button>
          <Button onClick={() => nav(`/mes/work-orders/${wo.id}`)}>打开工单</Button>
          <PrintButton landscape title={`DHR ${wo.no}`} />
        </Space>
        {(canDecide || canBatch) && (
          <Space wrap>
            {canBatch && (
              <Button icon={<SplitCellsOutlined />} type={canDecide ? 'default' : 'primary'} onClick={() => setBatch({ open: true, preselect: null })}>
                分批放行（可放行 {rs.releasable_qty}{unit}）
              </Button>
            )}
            {canDecide && <Button danger icon={<StopOutlined />} loading={busy} onClick={reject}>拒绝放行</Button>}
            {canDecide && (
              <Tooltip title={bad.length ? `以下条件未满足，不能整单放行：${bad.map((c) => c.item).join('；')}` : unitsBad.length ? `${unitsBad.length} 台放行检查未通过，请先核对` : ''}>
                <Button type="primary" icon={<SafetyCertificateOutlined />} loading={busy} disabled={bad.length > 0} onClick={approve}>放行全部剩余（电子签名）</Button>
              </Tooltip>
            )}
          </Space>
        )}
      </div>

      <div className="dhr-nav no-print">
        <Anchor direction="horizontal" affix={false} targetOffset={120} items={sectionItems} />
      </div>

      <Card>
        <PrintHeader title="器械生产记录（DHR）" no={wo.no} extra={<div>生产批号 {wo.lot_no || '-'} · {p.code} {p.name}</div>} />
        <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <Typography.Text type="secondary">Nuon 智造云 · 电子记录</Typography.Text>
          <Space>
            <StatusTag dict="dhr_status" value={wo.dhr_status} />
          </Space>
        </div>
        <div className="no-print" style={{ textAlign: 'center', margin: '8px 0 4px' }}>
          <Typography.Title level={3} style={{ margin: 0 }}>器械生产记录（DHR）</Typography.Title>
          <Typography.Text type="secondary">Device History Record · 工单 {wo.no} · 生产批号 <span className="mono">{wo.lot_no || '-'}</span></Typography.Text>
        </div>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center', fontSize: 12, marginBottom: 0 }}>
          本记录由系统根据工单、领料、过站报工、检验与电子签名数据自动汇编，不可手工修改。
        </Typography.Paragraph>

        <Section id="verdict" index={sec++} title={wo.serial_control ? `放行结论（按序列号逐项检查）` : '放行结论'}
          extra={rc && <Typography.Text type={rc.summary?.blocked ? 'danger' : 'success'}>{wo.serial_control ? `待放行 ${rc.summary?.candidates ?? 0} 台：可放行 ${rc.summary?.ready ?? 0} 台${rc.summary?.blocked ? `，有问题 ${rc.summary.blocked} 台` : ''}` : ''}</Typography.Text>}>
          {wo.dhr_status === 'RELEASED' && <Alert type="success" showIcon style={{ marginBottom: 8 }} message="本批已全部放行。" />}
          {rc ? <VerdictCard rc={rc} canBatch={canBatch} onRelease={releaseReady} /> : <Spin />}
        </Section>

        <Section id="product" index={sec++} title="产品与生产批信息">
          <Descriptions size="small" bordered column={{ xs: 1, sm: 2, lg: 3 }} items={[
            { key: 'code', label: '产品', children: `${p.code} ${p.name}` },
            { key: 'model', label: '型号 / 规格', children: `${p.model || '-'} / ${p.spec || '-'}` },
            { key: 'reg', label: '注册证/备案号', children: p.registration_no || '-' },
            { key: 'cls', label: '管理类别', children: dictLabel('device_class', p.device_class) },
            { key: 'gtin', label: 'UDI-DI（GTIN）', children: <span className="mono">{p.gtin || '-'}</span> },
            { key: 'no', label: '工单号', children: <Link to={`/mes/work-orders/${wo.id}`}>{wo.no}</Link> },
            { key: 'lot', label: '生产批号', children: <span className="mono">{wo.lot_no || '-'}</span> },
            { key: 'st', label: '工单 / DHR 状态', children: <Space size={4}><StatusTag dict="wo_status" value={wo.status} /><StatusTag dict="dhr_status" value={wo.dhr_status} /></Space> },
            { key: 'pq', label: '计划 / 完工 / 报废', children: <span>{fmtQty(wo.planned_qty)} / <b>{fmtQty(wo.completed_qty)}</b> / <span style={{ color: wo.scrap_qty > 0 ? '#cf1322' : undefined }}>{fmtQty(wo.scrap_qty)}</span></span> },
            { key: 'rq', label: '已入库 / 已放行', children: <span>{fmtQty(wo.received_qty)} / <b style={{ color: '#389e0d' }}>{fmtQty(wo.released_qty)}</b>{rs.rejected_qty > 0 && <span style={{ color: '#cf1322' }}>（拒绝 {fmtQty(rs.rejected_qty)}）</span>}</span> },
            { key: 'as', label: '实际开工 / 完工', children: `${fmtDateTime(wo.actual_start)} / ${fmtDateTime(wo.actual_end)}` },
            { key: 'ver', label: 'BOM / 工艺版本', children: `${wo.bom_version || '-'} / ${wo.routing_version || '-'}` },
            { key: 'cus', label: '客户（注册人）', children: wo.customer_name || '-' },
            { key: 'so', label: '销售订单', children: wo.so_no || '-' },
          ]} />
        </Section>

        <Section id="checks" index={sec++} title="整单放行条件" extra={<Typography.Text type="secondary">{checks.length - bad.length} / {checks.length} 项已满足</Typography.Text>}>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
            以下是【放行全部剩余并关闭工单】的条件；生产中的工单未完工属正常，已完工入库的产品可按上方放行结论先分批放行。
          </Typography.Paragraph>
          {checks.map((c, i) => {
            const partialOk = !c.ok && c.item.startsWith('工单已完工') && wo.status !== 'COMPLETED';
            return (
              <div className="dhr-check" key={i}>
                {c.ok ? <CheckCircleFilled style={{ color: '#52c41a', fontSize: 18, marginTop: 2 }} />
                  : partialOk ? <ExclamationCircleFilled style={{ color: '#d9d9d9', fontSize: 18, marginTop: 2 }} />
                    : <CloseCircleFilled style={{ color: '#ff4d4f', fontSize: 18, marginTop: 2 }} />}
                <div>
                  <div style={{ fontWeight: 600 }}>{c.item}</div>
                  <Typography.Text type={c.ok || partialOk ? 'secondary' : 'danger'}>{c.detail}{partialOk ? '（生产中，不影响分批放行）' : ''}</Typography.Text>
                </div>
              </div>
            );
          })}
        </Section>

        <Section id="materials" index={sec++} title={`物料批次追溯（${d.materials?.length || 0}）`}>
          <Table<Rec> rowKey={(r) => `${r.material_code}|${r.lot_no}|${r.source}`} size="small" pagination={false} dataSource={d.materials} scroll={{ x: 'max-content' }}
            locale={{ emptyText: '尚无已过账的领料记录' }} columns={[
              { title: '物料', dataIndex: 'material_code', render: (v, r) => <span>{v} {r.material_name}</span> },
              {
                title: '批号', dataIndex: 'lot_no',
                render: (v, r) => <Link className="mono" to={`/trace?material_code=${encodeURIComponent(r.material_code)}&lot_no=${encodeURIComponent(v)}`}>{v || '-'}</Link>,
              },
              { title: '数量', dataIndex: 'qty', align: 'right', render: (v) => fmtQty(v) },
              { title: '供应商', dataIndex: 'supplier_name', render: (v, r) => v || (r.customer_supplied ? '客户提供' : '-') },
              {
                title: '来料检验', dataIndex: 'iqc_no',
                render: (v, r) => {
                  const lot = (rc?.lots || []).find((l: Rec) => l.material_code === r.material_code && l.lot_no === r.lot_no);
                  if (v) return <Space size={4}><Link to={`/quality/inspections?q=${encodeURIComponent(v)}`}>{v}</Link><StatusTag dict="insp_status" value={r.iqc_status} /></Space>;
                  return lot ? <Tag color={lot.level === 'ok' ? 'default' : lot.level === 'warn' ? 'gold' : 'red'}>{lot.text}</Tag> : <Typography.Text type="secondary">-</Typography.Text>;
                },
              },
              { title: '来源', dataIndex: 'source', render: (v) => (v === 'REWORK' ? <Tag color="orange">返工补料</Tag> : '领料') },
            ]} />
        </Section>

        <Section id="ops" index={sec++} title="工序与一次直通率">
          <Table<Rec> rowKey="seq" size="small" pagination={false} dataSource={d.operations} scroll={{ x: 'max-content' }} columns={[
            { title: '工序', dataIndex: 'seq', width: 56 },
            { title: '名称', dataIndex: 'name', render: (v, r) => <span>{v}{r.sop_no && <Typography.Text type="secondary" style={{ fontSize: 12 }}>（{r.sop_no}）</Typography.Text>}</span> },
            { title: '类型', dataIndex: 'op_type', render: (v) => <StatusTag dict="op_type" value={v} /> },
            { title: '测试规格', dataIndex: 'params', render: (v) => <ParamsText params={v} /> },
            { title: '合格', dataIndex: 'good_qty', align: 'right', render: (v) => fmtQty(v) },
            { title: '不良', dataIndex: 'ng_qty', align: 'right', render: (v) => <span style={{ color: v > 0 ? '#cf1322' : undefined }}>{fmtQty(v)}</span> },
            {
              title: '一次直通率', dataIndex: 'first_pass_yield', align: 'right',
              render: (v) => (v === null || v === undefined ? '-' : <b style={{ color: v < 95 ? '#d4380d' : '#389e0d' }}>{v}%</b>),
            },
          ]} />
        </Section>

        {d.serials?.length > 0 && (
          <Section id="serials" index={sec++} title={`序列号与 UDI（${d.serials.length}）`}>
            <Table<Rec> rowKey="sn" size="small" pagination={false} dataSource={d.serials} scroll={{ x: 'max-content' }} columns={[
              { title: '#', key: 'i', width: 48, render: (_, __, i) => i + 1 },
              { title: '序列号', dataIndex: 'sn', render: (v) => <Link className="mono" to={`/trace?sn=${encodeURIComponent(v)}`}>{v}</Link> },
              { title: 'UDI（GS1）', dataIndex: 'udi', render: (v) => <span className="mono">{v || '-'}</span> },
              { title: '状态', dataIndex: 'status', render: (v) => <StatusTag dict="sn_status" value={v} /> },
              {
                title: '放行批', dataIndex: 'release_no',
                render: (v, r) => (v ? <Space size={4}><span className="mono">{v}</span><StatusTag dict="release_status" value={r.release_status} /></Space> : <Typography.Text type="secondary">未放行</Typography.Text>),
              },
            ]} />
          </Section>
        )}

        <Section id="records" index={sec++} title={`过站与测试记录（${d.records?.length || 0}）`}>
          <RecordsBySn records={d.records || []} />
        </Section>

        <Section id="keyparts" index={sec++} title={`关键件与返工换件（${d.key_parts?.length || 0}）`}>
          <Table<Rec> rowKey="id" size="small" pagination={false} dataSource={d.key_parts} scroll={{ x: 'max-content' }}
            locale={{ emptyText: '无关键件绑定或返工换件记录' }} columns={[
              { title: '时间', dataIndex: 'ts', render: (v) => dayjs(v).format('MM-DD HH:mm:ss') },
              { title: '序列号', dataIndex: 'sn', render: (v) => (v ? <Link className="mono" to={`/trace?sn=${encodeURIComponent(v)}`}>{v}</Link> : '-') },
              { title: '动作', dataIndex: 'action', render: (v) => <StatusTag dict="key_part_action" value={v} /> },
              { title: '零件', dataIndex: 'material_code', render: (v, r) => `${v} ${r.material_name}` },
              {
                title: '批号', dataIndex: 'lot_no',
                render: (v, r) => (v ? <Link className="mono" to={`/trace?material_code=${encodeURIComponent(r.material_code)}&lot_no=${encodeURIComponent(v)}`}>{v}</Link> : '-'),
              },
              { title: '部件序列号', dataIndex: 'part_sn', render: (v) => v || '-' },
              { title: 'NCR', dataIndex: 'ncr_no', render: (v) => (v ? <Link to={`/quality/ncrs?q=${encodeURIComponent(v)}`}>{v}</Link> : '-') },
              { title: '操作员', dataIndex: 'operator_name', render: (v) => v || '-' },
            ]} />
        </Section>

        <Section id="equipment" index={sec++} title="设备与计量器具">
          <Table<Rec> rowKey="code" size="small" pagination={false} dataSource={d.equipment} scroll={{ x: 'max-content' }}
            locale={{ emptyText: '未使用设备' }} columns={[
              { title: '设备编码', dataIndex: 'code' },
              { title: '名称', dataIndex: 'name' },
              { title: '上次校准', dataIndex: 'last_calibration_date', render: (v, r) => (r.calibration_required ? fmtDate(v) : '-') },
              { title: '校准有效期至', dataIndex: 'next_calibration_date', render: (v, r) => (r.calibration_required ? fmtDate(v) : '-') },
              { title: '当前校准状态', key: 'cal', render: (_, r) => calStatus(r) },
            ]} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>系统在报工时已强制校验：校准过期的仪器不能用于报工；放行结论按每台使用当日核对校准有效期。</Typography.Text>
        </Section>

        <Section id="ncrs" index={sec++} title={`不合格品（${d.ncrs?.length || 0}）`}>
          {d.ncrs?.length ? (
            <Table<Rec> rowKey="no" size="small" pagination={false} dataSource={d.ncrs} scroll={{ x: 'max-content' }} columns={[
              { title: 'NCR', dataIndex: 'no', render: (v) => <Link to={`/quality/ncrs?q=${encodeURIComponent(v)}`}>{v}</Link> },
              { title: '序列号', dataIndex: 'sn', render: (v) => (v ? <span className="mono">{v}</span> : '-') },
              { title: '工序', dataIndex: 'op_name', render: (v) => v || '-' },
              { title: '描述', dataIndex: 'description', width: 360 },
              { title: '状态', dataIndex: 'status', render: (v) => <StatusTag dict="ncr_status" value={v} /> },
              { title: '处置', dataIndex: 'disposition', render: (v) => <StatusTag dict="disposition" value={v} /> },
            ]} />
          ) : <Typography.Text type="secondary">本批无不合格品记录。</Typography.Text>}
        </Section>

        <Section id="releases" index={sec++} title={`产品放行记录（${d.releases?.length || 0}）`}
          extra={<Typography.Text type="secondary">已入库 {fmtQty(wo.received_qty)} / 已放行 {fmtQty(wo.released_qty)}{rs.rejected_qty > 0 ? ` / 拒绝 ${fmtQty(rs.rejected_qty)}` : ''}</Typography.Text>}>
          {d.releases?.length ? <ReleaseTable rows={d.releases} /> : <Typography.Text type="secondary">尚未放行。</Typography.Text>}
        </Section>

        <Section id="signatures" index={sec++} title={`电子签名（${sigs.length}）`}>
          {sigs.length ? (
            <Table<Rec> rowKey="_k" size="small" pagination={false} dataSource={sigs} scroll={{ x: 'max-content' }} columns={[
              { title: '签名时间', dataIndex: 'ts', render: (v) => fmtDateTime(v) },
              { title: '签名人', dataIndex: 'full_name' },
              { title: '签名含义', dataIndex: 'meaning', render: (v) => <b>{v}</b> },
              { title: '单据', dataIndex: 'doc_no', render: (v) => (v ? <span className="mono">{v}</span> : '-') },
              {
                title: '意见/理由', dataIndex: 'reason',
                render: (v, r) => (
                  <div style={{ maxWidth: 420 }}>
                    <div>{v || '-'}</div>
                    {r.sn_list?.length > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>放行序列号（{r.sn_list.length} 台）：{r.sn_list.join('、')}</Typography.Text>}
                  </div>
                ),
              },
            ]} />
          ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未审核放行" />}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>含本批 NCR 的评审处置与关闭签名、DHR 放行签名。</Typography.Text>
        </Section>
        <div className="print-only"><PrintSignatures roles={['生产负责人', 'QA 审核', '质量负责人批准']} /></div>
      </Card>
    </div>
  );
}
