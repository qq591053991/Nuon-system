import { Alert, Button, Card, Descriptions, Empty, Result, Space, Spin, Table, Tag, Tooltip, Typography, message } from 'antd';
import {
  ArrowLeftOutlined, CheckCircleFilled, CloseCircleFilled, PrinterOutlined, SafetyCertificateOutlined, SplitCellsOutlined, StopOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import { isCancel, useESign } from '../../components/ESign';
import StatusTag from '../../components/StatusTag';
import { dictLabel } from '../../utils/dict';
import { fmtDate, fmtDateTime, fmtQty } from '../../utils/format';
import { ReleaseBatchModal, ReleaseTable } from '../mes/ReleaseBatch';
import { ParamsText, ValuesText } from '../mes/spec';

const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

/** 打印友好的样式（只作用于 .dhr-doc） */
const DHR_CSS = `
.dhr-doc .dhr-section { margin-top: 24px; }
.dhr-doc .dhr-section h3 { font-size: 16px; font-weight: 700; border-left: 4px solid #5b3cc4; padding-left: 8px; margin: 0 0 10px; }
.dhr-doc .dhr-check { display: flex; gap: 10px; align-items: flex-start; padding: 6px 0; border-bottom: 1px dashed #f0f0f0; }
@media print {
  .dhr-doc { font-size: 12px; }
  .dhr-doc .ant-card { border: none !important; box-shadow: none !important; }
  .dhr-doc .ant-card-body { padding: 0 !important; }
  .dhr-doc .dhr-section { break-inside: avoid-page; }
  .dhr-doc .ant-table { font-size: 11px; }
  .dhr-doc a { color: inherit !important; text-decoration: none !important; }
}
`;

function Section({ index, title, extra, children }: { index: number; title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="dhr-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
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

export default function DhrView() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { can } = useAuth();
  const [sign, signHolder] = useESign();
  const [d, setD] = useState<Rec | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);

  const load = useCallback(() => {
    get(`/work-orders/${id}/dhr`).then(setD).catch(() => setFailed(true));
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
  let sec = 0;

  const approve = async () => {
    try {
      const signature = await sign({
        meaning: '产品放行（DHR审核批准）',
        description: `批准工单 ${wo.no}（批号 ${wo.lot_no}）整单放行：剩余未放行的 ${remaining}${unit} 成品由“待放行”转为“合格”，可以发货；工单关闭。`,
        defaultReason: '记录完整，批准放行',
      });
      setBusy(true);
      await post(`/work-orders/${id}/dhr/release`, { approve: true, reason: signature.reason, signature });
      message.success('已放行全部剩余：该批成品已转为合格库存，可以发货');
      load();
    } catch (e) {
      if (!isCancel(e)) throw e;
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    try {
      const signature = await sign({
        meaning: '产品放行（DHR审核拒绝）',
        description: '拒绝放行后，该批剩余未放行的成品库存将被冻结（HOLD），不能发货（已放行的批次不受影响）。请填写拒绝原因。',
        reasonRequired: true,
      });
      setBusy(true);
      await post(`/work-orders/${id}/dhr/release`, { approve: false, reason: signature.reason, signature });
      message.warning('已拒绝放行，该批成品已冻结');
      load();
    } catch (e) {
      if (!isCancel(e)) throw e;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dhr-doc">
      <style>{DHR_CSS}</style>
      {signHolder}
      <ReleaseBatchModal wo={wo} open={batchOpen} onClose={() => setBatchOpen(false)} onDone={load} />
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        <Space wrap>
          <Button icon={<ArrowLeftOutlined />} onClick={() => nav(-1)}>返回</Button>
          <Button onClick={() => nav(`/mes/work-orders/${wo.id}`)}>打开工单</Button>
          <Button icon={<PrinterOutlined />} onClick={() => window.print()}>打印 / 导出 PDF</Button>
        </Space>
        {(canDecide || canBatch) && (
          <Space wrap>
            {canBatch && (
              <Button icon={<SplitCellsOutlined />} type={canDecide ? 'default' : 'primary'} onClick={() => setBatchOpen(true)}>
                分批放行（可放行 {rs.releasable_qty}{unit}）
              </Button>
            )}
            {canDecide && <Button danger icon={<StopOutlined />} loading={busy} onClick={reject}>拒绝放行</Button>}
            {canDecide && (
              <Tooltip title={bad.length ? `以下检查未通过，不能放行：${bad.map((c) => c.item).join('；')}` : ''}>
                <Button type="primary" icon={<SafetyCertificateOutlined />} loading={busy} disabled={bad.length > 0} onClick={approve}>放行全部剩余（电子签名）</Button>
              </Tooltip>
            )}
          </Space>
        )}
      </div>

      {can('qa') && wo.dhr_status === 'OPEN' && wo.status !== 'COMPLETED' && (
        <Alert className="no-print" style={{ marginBottom: 16 }} type="info" showIcon
          message={`该批尚未完工（完工 + 报废 = 计划数），完工并全部入库后方可整单审核放行；${canBatch ? `已入库的 ${rs.releasable_qty}${unit} 可先【分批放行】。` : '已完工入库的部分可分批放行。'}`} />
      )}
      {canDecide && (
        <Alert className="no-print" style={{ marginBottom: 16 }} type={bad.length ? 'warning' : 'info'} showIcon
          message={bad.length
            ? `整单放行检查有 ${bad.length} 项未通过，处理完成后才能放行全部剩余${canBatch ? '（满足条件的产品可先分批放行）' : ''}。`
            : `放行检查全部通过。请逐项审核记录后电子签名放行；【放行全部剩余】将放行剩余 ${remaining}${unit} 并关闭工单，也可【分批放行】。`} />
      )}

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <Typography.Text type="secondary">Nuon 智造云 · 电子记录</Typography.Text>
          <Space>
            <StatusTag dict="dhr_status" value={wo.dhr_status} />
            <Typography.Text type="secondary">打印时间 {dayjs().format('YYYY-MM-DD HH:mm')}</Typography.Text>
          </Space>
        </div>
        <div style={{ textAlign: 'center', margin: '8px 0 4px' }}>
          <Typography.Title level={3} style={{ margin: 0 }}>器械生产记录（DHR）</Typography.Title>
          <Typography.Text type="secondary">Device History Record · 工单 {wo.no} · 生产批号 <span className="mono">{wo.lot_no || '-'}</span></Typography.Text>
        </div>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center', fontSize: 12, marginBottom: 0 }}>
          本记录由系统根据工单、领料、过站报工、检验与电子签名数据自动汇编，不可手工修改。
        </Typography.Paragraph>

        <Section index={sec++} title="产品信息">
          <Descriptions size="small" bordered column={{ xs: 1, sm: 2, lg: 3 }} items={[
            { key: 'code', label: '产品编码', children: p.code },
            { key: 'name', label: '产品名称', children: p.name },
            { key: 'model', label: '型号', children: p.model || '-' },
            { key: 'spec', label: '规格', children: p.spec || '-' },
            { key: 'reg', label: '注册证/备案号', children: p.registration_no || '-' },
            { key: 'cls', label: '管理类别', children: dictLabel('device_class', p.device_class) },
            { key: 'gtin', label: 'UDI-DI（GTIN）', children: <span className="mono">{p.gtin || '-'}</span> },
          ]} />
        </Section>

        <Section index={sec++} title="生产批信息">
          <Descriptions size="small" bordered column={{ xs: 1, sm: 2, lg: 3 }} items={[
            { key: 'no', label: '工单号', children: <Link to={`/mes/work-orders/${wo.id}`}>{wo.no}</Link> },
            { key: 'lot', label: '生产批号', children: <span className="mono">{wo.lot_no || '-'}</span> },
            { key: 'st', label: '工单状态', children: <StatusTag dict="wo_status" value={wo.status} /> },
            { key: 'pq', label: '计划数量', children: fmtQty(wo.planned_qty) },
            { key: 'cq', label: '完工 / 报废', children: <span><b>{fmtQty(wo.completed_qty)}</b> / <span style={{ color: wo.scrap_qty > 0 ? '#cf1322' : undefined }}>{fmtQty(wo.scrap_qty)}</span></span> },
            { key: 'rq', label: '已入库 / 已放行', children: <span>{fmtQty(wo.received_qty)} / <b style={{ color: '#389e0d' }}>{fmtQty(wo.released_qty)}</b>{rs.rejected_qty > 0 && <span style={{ color: '#cf1322' }}>（拒绝 {fmtQty(rs.rejected_qty)}）</span>}</span> },
            { key: 'as', label: '实际开工', children: fmtDateTime(wo.actual_start) },
            { key: 'ae', label: '实际完工', children: fmtDateTime(wo.actual_end) },
            { key: 'ver', label: 'BOM / 工艺版本', children: `${wo.bom_version || '-'} / ${wo.routing_version || '-'}` },
            { key: 'cus', label: '客户（注册人）', children: wo.customer_name || '-' },
            { key: 'so', label: '销售订单', children: wo.so_no || '-' },
            { key: 'dhr', label: 'DHR 状态', children: <StatusTag dict="dhr_status" value={wo.dhr_status} /> },
          ]} />
        </Section>

        <Section index={sec++} title="放行检查" extra={<Typography.Text type={bad.length ? 'danger' : 'success'}>{checks.length - bad.length} / {checks.length} 项通过</Typography.Text>}>
          {checks.map((c, i) => (
            <div className="dhr-check" key={i}>
              {c.ok ? <CheckCircleFilled style={{ color: '#52c41a', fontSize: 18, marginTop: 2 }} /> : <CloseCircleFilled style={{ color: '#ff4d4f', fontSize: 18, marginTop: 2 }} />}
              <div>
                <div style={{ fontWeight: 600 }}>{c.item}</div>
                <Typography.Text type={c.ok ? 'secondary' : 'danger'}>{c.detail}</Typography.Text>
              </div>
            </div>
          ))}
        </Section>

        <Section index={sec++} title={`物料批次追溯（${d.materials?.length || 0}）`}>
          <Table<Rec> rowKey={(r) => `${r.material_code}|${r.lot_no}`} size="small" pagination={false} dataSource={d.materials} scroll={{ x: 'max-content' }}
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
                render: (v, r) => (v ? <Space size={4}><Link to={`/quality/inspections?q=${encodeURIComponent(v)}`}>{v}</Link><StatusTag dict="insp_status" value={r.iqc_status} /></Space> : <Typography.Text type="secondary">无检验记录</Typography.Text>),
              },
              { title: '客供料', dataIndex: 'customer_supplied', render: (v) => (v ? <Tag color="purple">客供料</Tag> : '-') },
              { title: '来源', dataIndex: 'source', render: (v) => (v === 'REWORK' ? <Tag color="orange">返工补料</Tag> : '领料') },
            ]} />
        </Section>

        <Section index={sec++} title="工序与一次直通率">
          <Table<Rec> rowKey="seq" size="small" pagination={false} dataSource={d.operations} scroll={{ x: 'max-content' }} columns={[
            { title: '工序', dataIndex: 'seq', width: 56 },
            { title: '名称', dataIndex: 'name', render: (v, r) => <span>{v}{r.sop_no && <Typography.Text type="secondary" style={{ fontSize: 12 }}>（{r.sop_no}）</Typography.Text>}</span> },
            { title: '类型', dataIndex: 'op_type', render: (v) => <StatusTag dict="op_type" value={v} /> },
            { title: '工作中心', dataIndex: 'work_center_name', render: (v) => v || '-' },
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
          <Section index={sec++} title={`序列号与 UDI（${d.serials.length}）`}>
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

        <Section index={sec++} title={`过站与测试记录（${d.records?.length || 0}）`}>
          <Table<Rec> rowKey="_k" size="small" pagination={false} dataSource={(d.records || []).map((r: Rec, i: number) => ({ ...r, _k: i }))} scroll={{ x: 'max-content' }}
            locale={{ emptyText: '尚无报工记录' }} columns={[
              { title: '时间', dataIndex: 'ts', render: (v) => dayjs(v).format('MM-DD HH:mm:ss') },
              { title: '序列号', dataIndex: 'sn', render: (v, r) => (v ? <span className="mono">{v}</span> : `批量 ${fmtQty(r.qty)}`) },
              { title: '工序', key: 'op', render: (_, r) => `${r.seq} ${r.op_name}` },
              { title: '结果', dataIndex: 'result', render: (v, r) => <Space size={4}><StatusTag dict="result" value={v} />{r.is_rework && <Tag color="orange">返工</Tag>}</Space> },
              { title: '测试数据（实测值(规格) 判定）', dataIndex: 'values', render: (v) => <ValuesText values={v} block /> },
              { title: '操作员', dataIndex: 'operator_name' },
              { title: '设备', dataIndex: 'equipment_code', render: (v) => v || '-' },
            ]} />
        </Section>

        <Section index={sec++} title={`关键件与返工换件（${d.key_parts?.length || 0}）`}>
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
              { title: '说明', dataIndex: 'remark', render: (v) => v || '-' },
            ]} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>返工换件：拆下的零件与装上的新零件批次均记录在单台追溯中，装上的零件从合格库存补领（返工补料）。</Typography.Text>
        </Section>

        <Section index={sec++} title="设备与计量器具">
          <Table<Rec> rowKey="code" size="small" pagination={false} dataSource={d.equipment} scroll={{ x: 'max-content' }}
            locale={{ emptyText: '未使用设备' }} columns={[
              { title: '设备编码', dataIndex: 'code' },
              { title: '名称', dataIndex: 'name' },
              { title: '上次校准', dataIndex: 'last_calibration_date', render: (v, r) => (r.calibration_required ? fmtDate(v) : '-') },
              { title: '校准有效期至', dataIndex: 'next_calibration_date', render: (v, r) => (r.calibration_required ? fmtDate(v) : '-') },
              { title: '当前校准状态', key: 'cal', render: (_, r) => calStatus(r) },
            ]} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>系统在报工时已强制校验：校准过期的仪器不能用于报工。</Typography.Text>
        </Section>

        <Section index={sec++} title={`不合格品（${d.ncrs?.length || 0}）`}>
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

        <Section index={sec++} title={`产品放行记录（${d.releases?.length || 0}）`}
          extra={<Typography.Text type="secondary">已入库 {fmtQty(wo.received_qty)} / 已放行 {fmtQty(wo.released_qty)}{rs.rejected_qty > 0 ? ` / 拒绝 ${fmtQty(rs.rejected_qty)}` : ''}</Typography.Text>}>
          {d.releases?.length ? <ReleaseTable rows={d.releases} /> : <Typography.Text type="secondary">尚未放行。</Typography.Text>}
        </Section>

        <Section index={sec++} title="电子签名">
          {d.signatures?.length ? (
            <Table<Rec> rowKey="_k" size="small" pagination={false} dataSource={d.signatures.map((r: Rec, i: number) => ({ ...r, _k: i }))} columns={[
              { title: '签名时间', dataIndex: 'ts', render: (v) => fmtDateTime(v) },
              { title: '签名人', dataIndex: 'full_name' },
              { title: '签名含义', dataIndex: 'meaning', render: (v) => <b>{v}</b> },
              { title: '单据', dataIndex: 'doc_no', render: (v) => (v ? <span className="mono">{v}</span> : '-') },
              { title: '意见/理由', dataIndex: 'reason', render: (v) => v || '-' },
            ]} />
          ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未审核放行" />}
        </Section>
      </Card>
    </div>
  );
}
