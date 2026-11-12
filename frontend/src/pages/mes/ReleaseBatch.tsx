/**
 * DHR 分批放行（评审 P1-2）：同一工单内已完工入库的产品按“放行批”分批审核放行。
 *   序列号产品：勾选已入库、尚未放行的序列号；批量产品：填写放行数量（≤ 已入库 − 已放行 − 已拒绝）。
 *   批准 → 该部分成品 待放行→合格，可发货；拒绝 → 冻结（HOLD）。均需 QA 电子签名。
 * 供 DHR 页、放行中心、工单详情共用。
 */
import { Alert, App, Button, Descriptions, Empty, Input, InputNumber, Modal, Space, Spin, Table, Tag, Typography } from 'antd';
import { SafetyCertificateOutlined, StopOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { isCancel, useESign } from '../../components/ESign';
import StatusTag from '../../components/StatusTag';
import { fmtDateTime, fmtQty } from '../../utils/format';

/** 放行批记录表 */
export function ReleaseTable({ rows, loading }: { rows: Rec[]; loading?: boolean }) {
  return (
    <Table<Rec>
      rowKey="id"
      size="small"
      loading={loading}
      pagination={false}
      dataSource={rows}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: '尚无放行记录' }}
      expandable={{
        rowExpandable: (r) => !!r.sn_list?.length,
        expandedRowRender: (r) => (
          <Space size={[6, 6]} wrap>
            {r.sn_list.map((sn: string) => <Link key={sn} className="mono" to={`/trace?sn=${encodeURIComponent(sn)}`}>{sn}</Link>)}
          </Space>
        ),
      }}
      columns={[
        { title: '放行批号', dataIndex: 'no', render: (v) => <span className="mono">{v}</span> },
        { title: '结论', dataIndex: 'status', render: (v) => <StatusTag dict="release_status" value={v} /> },
        { title: '数量', dataIndex: 'qty', align: 'right', render: (v, r) => <b>{fmtQty(v)}{r.sn_list?.length ? ` 台` : ''}</b> },
        {
          title: '序列号', key: 'sn',
          render: (_, r) => (r.sn_list?.length
            ? <Typography.Text style={{ maxWidth: 360 }} ellipsis={{ tooltip: r.sn_list.join('、') }}>{r.sn_list.join('、')}</Typography.Text>
            : '-'),
        },
        { title: '审核人', dataIndex: 'released_by', render: (v) => v || '-' },
        { title: '审核时间', dataIndex: 'released_at', render: (v) => fmtDateTime(v) },
        { title: '意见/理由', dataIndex: 'reason', render: (v) => v || '-' },
      ]}
    />
  );
}

/** 工单的放行批记录（自动加载） */
export function WoReleaseHistory({ woId, refreshKey }: { woId: number | string; refreshKey?: unknown }) {
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    get(`/work-orders/${woId}/releases`, undefined, true)
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [woId, refreshKey]);
  return <ReleaseTable rows={rows} loading={loading} />;
}

interface Props {
  wo: Rec | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  /** 预先勾选的序列号（如 DHR 放行结论中全部检查通过的产品）；不传则默认勾选全部可放行 */
  preselect?: string[] | null;
}

/** 签名说明中的序列号清单（过多时截断） */
export const snText = (sns: string[], max = 30) => (sns.length > max ? `${sns.slice(0, max).join('、')} 等 ${sns.length} 台` : sns.join('、'));

/** 分批放行弹窗：选择序列号 / 数量 → 批准或拒绝（电子签名） */
export function ReleaseBatchModal({ wo, open, onClose, onDone, preselect }: Props) {
  const { message } = App.useApp();
  const [sign, signHolder] = useESign();
  const [sum, setSum] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [qty, setQty] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !wo) return;
    setSum(null);
    setReason('');
    setLoading(true);
    get(`/work-orders/${wo.id}/releasable`)
      .then((d) => {
        setSum(d);
        const all: string[] = (d.serials || []).map((s: Rec) => s.sn);
        setSelected(preselect ? all.filter((sn) => preselect.includes(sn)) : all);
        setQty(d.releasable_qty || null);
      })
      .finally(() => setLoading(false));
  }, [open, wo]);

  const serial = !!sum?.serial_control;
  const count = serial ? selected.length : qty || 0;

  const decide = async (approve: boolean) => {
    if (!wo || !sum || count <= 0) return;
    if (!approve && !reason.trim()) {
      message.warning('拒绝放行须填写原因');
      return;
    }
    const unit = serial ? '台' : ` ${sum.uom ?? ''}`;
    const sns = serial ? [...selected].sort() : [];
    const list = sns.length ? ` 序列号：${snText(sns)}。` : '';
    setBusy(true);
    try {
      const r = await sign({
        meaning: approve ? '产品放行（分批）' : '产品放行（分批拒绝）',
        description: approve
          ? `批准工单 ${wo.no}（批号 ${wo.lot_no}）本批 ${fmtQty(count)}${unit} 放行：成品由“待放行”转为“合格”，可以发货。${list}`
          : `拒绝放行工单 ${wo.no} 本批 ${fmtQty(count)}${unit}：成品将被冻结（HOLD），不能发货。${list}`,
        defaultReason: reason.trim() || (approve ? `本批记录完整，批准放行${sns.length && sns.length <= 6 ? `（${sns.join('、')}）` : ''}` : undefined),
        reasonRequired: !approve,
        submit: (signature) => post(`/work-orders/${wo.id}/releases`, {
          ...(serial ? { serials: selected } : { qty }),
          approve,
          reason: signature.reason || reason.trim() || undefined,
          signature,
        }, true),
      });
      if (approve) {
        message.success(`放行批 ${r.release.no} 已放行 ${fmtQty(r.release.qty)}${unit}${r.dhr_status === 'RELEASED' ? '；该工单已全部放行并关闭' : ''}`);
      } else message.warning(`放行批 ${r.release.no} 已拒绝放行，成品已冻结`);
      onDone();
      onClose();
    } catch (e) {
      if (!isCancel(e)) throw e;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      width={820}
      title={`分批放行 - ${wo?.no ?? ''}`}
      onCancel={onClose}
      destroyOnHidden
      maskClosable={false}
      footer={[
        <Button key="c" onClick={onClose}>取消</Button>,
        <Button key="r" danger icon={<StopOutlined />} loading={busy} disabled={count <= 0} onClick={() => decide(false)}>拒绝本批（冻结）</Button>,
        <Button key="a" type="primary" icon={<SafetyCertificateOutlined />} loading={busy} disabled={count <= 0} onClick={() => decide(true)}>
          批准放行本批（电子签名）
        </Button>,
      ]}
    >
      {signHolder}
      {loading || !sum ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
      ) : (
        <>
          <Alert type="info" showIcon style={{ marginBottom: 12 }}
            message="分批放行：每批校验产品已完成全部工序、无未处置 NCR、物料已按 BOM 足额领用（按放行后累计数量）。批准后该批成品转为合格库存，可以发货。" />
          <Descriptions size="small" bordered column={{ xs: 1, sm: 2, md: 4, lg: 4, xl: 4, xxl: 4 }} style={{ marginBottom: 12 }} items={[
            { key: 'c', label: '已完工', children: fmtQty(sum.completed_qty) },
            { key: 'r', label: '已入库', children: fmtQty(sum.received_qty) },
            { key: 'rel', label: '已放行', children: <b style={{ color: '#389e0d' }}>{fmtQty(sum.released_qty)}</b> },
            { key: 'rej', label: '已拒绝（冻结）', children: <span style={{ color: sum.rejected_qty > 0 ? '#cf1322' : undefined }}>{fmtQty(sum.rejected_qty)}</span> },
          ]} />
          {serial ? (
            <>
              {sum.blocked?.length > 0 && (
                <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`${sum.blocked.length} 台暂不能放行`}
                  description={sum.blocked.map((b: Rec) => `${b.sn}：${b.reason}`).join('；')} />
              )}
              {sum.serials?.length ? (
                <Table<Rec>
                  rowKey="sn"
                  size="small"
                  dataSource={sum.serials}
                  pagination={sum.serials.length > 10 ? { pageSize: 10, size: 'small' } : false}
                  rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys as string[]) }}
                  columns={[
                    { title: '序列号', dataIndex: 'sn', render: (v) => <Link className="mono" to={`/trace?sn=${encodeURIComponent(v)}`}>{v}</Link> },
                    { title: '库位', dataIndex: 'location_code', render: (v) => v || '-' },
                    { title: '完工时间', dataIndex: 'completed_at', render: (v) => fmtDateTime(v) },
                  ]}
                />
              ) : <Empty description="没有可放行的产品（需已完工入库、完成全部工序且尚未放行）" />}
              <Typography.Text type="secondary">已选 <b>{selected.length}</b> / {sum.serials?.length ?? 0} 台{selected.length > 0 && selected.length <= 12 ? `：${[...selected].sort().join('、')}` : ''}</Typography.Text>
            </>
          ) : (
            <Space align="center" wrap style={{ marginBottom: 8 }}>
              <span>本批放行数量：</span>
              <InputNumber min={0} max={sum.releasable_qty} precision={4} value={qty} onChange={(v) => setQty(v === null ? null : Number(v))}
                suffix={sum.uom} style={{ width: 200 }} />
              <Tag color={sum.releasable_qty > 0 ? 'blue' : 'default'}>可放行 {fmtQty(sum.releasable_qty)} {sum.uom}</Tag>
              {sum.open_ncr > 0 && <Tag color="red">工单有 {sum.open_ncr} 条未处置 NCR，不能放行</Tag>}
            </Space>
          )}
          <Input.TextArea style={{ marginTop: 12 }} rows={2} placeholder="审核意见（拒绝放行时必填）" value={reason} onChange={(e) => setReason(e.target.value)} />
        </>
      )}
    </Modal>
  );
}
