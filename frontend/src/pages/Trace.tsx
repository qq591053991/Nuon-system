import {
  Alert, AutoComplete, Button, Card, Col, Descriptions, Empty, Input, Progress, Result, Row, Segmented, Space, Spin, Statistic, Steps, Table, Tabs, Tag,
  Timeline, Tooltip, Typography, type TableColumnsType,
} from 'antd';
import {
  AimOutlined, AuditOutlined, BarcodeOutlined, CarOutlined, CheckCircleFilled, CloseCircleFilled, DownloadOutlined, ExperimentOutlined,
  FileProtectOutlined, InboxOutlined, NodeIndexOutlined, PrinterOutlined, SearchOutlined, ToolOutlined, WarningOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, type Rec } from '../api/http';
import PageHeader from '../components/PageHeader';
import StatusTag from '../components/StatusTag';
import { dictLabel } from '../utils/dict';
import { fmtDate, fmtDateTime, fmtQty } from '../utils/format';
import { CsTag, LotLink, MaterialCell, SnLink, exportCsv } from './wms/common';

const C = { ok: '#389e0d', bad: '#cf1322', warn: '#d46b08', muted: '#8c8c8c', brand: '#5b3cc4' };

/** 兼容扫描整串 UDI：(01)GTIN(11)生产日期(10)批号(21)序列号 */
const parseSn = (raw: string) => {
  const s = raw.trim();
  const m = s.match(/\(21\)([^()]+)/);
  return (m ? m[1] : s).trim();
};

const errText = (e: any) => e?.response?.data?.detail || e?.message || '查询失败';

/** 最近查询（仅本机浏览器，便于反复切换） */
function useRecent(key: string): [string[], (v: string) => void] {
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(key) || '[]') as string[];
    } catch {
      return [];
    }
  };
  const [list, setList] = useState<string[]>(read);
  const push = useCallback((v: string) => {
    setList((old) => {
      const next = [v, ...old.filter((x) => x !== v)].slice(0, 6);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* 浏览器禁用存储时忽略 */
      }
      return next;
    });
  }, [key]);
  return [list, push];
}

function specText(lower?: number | null, upper?: number | null) {
  const has = (v?: number | null) => v !== null && v !== undefined;
  if (has(lower) && has(upper)) return `${lower} ~ ${upper}`;
  if (has(lower)) return `≥ ${lower}`;
  if (has(upper)) return `≤ ${upper}`;
  return '-';
}

function SectionTitle({ icon, children, extra }: { icon: ReactNode; children: ReactNode; extra?: ReactNode }) {
  return (
    <Space size={8}>
      <span style={{ color: C.brand }}>{icon}</span>
      <span>{children}</span>
      {extra}
    </Space>
  );
}

/* ============================== 序列号反向追溯 ============================== */

function SerialResult({ d }: { d: Rec }) {
  const s: Rec = d.serial;
  const p: Rec = d.product;
  const wo: Rec = d.work_order;
  const sh: Rec | null = d.shipment;
  const records: Rec[] = d.records || [];
  const materials: Rec[] = d.materials || [];
  const keyParts: Rec[] = d.key_parts || [];
  const ncrs: Rec[] = d.ncrs || [];
  const fails = records.filter((r) => r.result === 'FAIL').length;
  const reworks = records.filter((r) => r.is_rework).length;
  const ng = s.status === 'NG' || s.status === 'SCRAPPED';
  const side = keyParts.length > 0 || ncrs.length > 0;

  const steps = [
    { title: '来料批次', description: `${materials.length} 个物料批次`, status: materials.length ? 'finish' : 'wait', icon: <InboxOutlined /> },
    { title: '生产工单', description: wo.no, status: 'finish', icon: <ToolOutlined /> },
    {
      title: '工序 / 测试',
      description: `${records.length} 条记录${fails ? ` · ${fails} 次不合格` : ''}`,
      status: ng ? 'error' : s.completed_at ? 'finish' : records.length ? 'process' : 'wait',
      icon: <ExperimentOutlined />,
    },
    {
      title: 'DHR 放行',
      description: dictLabel('dhr_status', wo.dhr_status),
      status: wo.dhr_status === 'RELEASED' ? 'finish' : wo.dhr_status === 'REJECTED' ? 'error' : s.completed_at ? 'process' : 'wait',
      icon: <FileProtectOutlined />,
    },
    { title: '发货', description: sh ? sh.customer_name : '尚未发货', status: sh ? 'finish' : 'wait', icon: <CarOutlined /> },
  ] as const;

  const matColumns: TableColumnsType<Rec> = [
    {
      title: '物料', key: 'm', width: 220,
      render: (_, r) => <MaterialCell code={r.material_code} name={r.material_name} extra={r.customer_supplied ? <CsTag /> : undefined} />,
    },
    { title: '批号', dataIndex: 'lot_no', width: 120, render: (v, r) => <LotLink code={r.material_code} lot={v} /> },
    { title: '用量', dataIndex: 'qty', width: 70, align: 'right', render: (v) => fmtQty(v) },
    {
      title: '供应商 / 原厂批号', key: 'sup', width: 190,
      render: (_, r) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{r.supplier_name || (r.customer_supplied ? '客户提供' : '-')}</div>
          {r.supplier_lot && <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>{r.supplier_lot}</Typography.Text>}
        </div>
      ),
    },
    {
      title: '入库单', dataIndex: 'receipt_no', width: 130,
      render: (v, r) => (v ? (
        <div style={{ lineHeight: 1.35 }}>
          <Link className="mono" to={`/wms/receipts?q=${encodeURIComponent(v)}`}>{v}</Link>
          <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{fmtDate(r.receipt_date)}</Typography.Text></div>
        </div>
      ) : '-'),
    },
    {
      title: '来料检验', key: 'iqc', width: 150,
      render: (_, r) => (r.iqc_no ? (
        <Space size={4} direction="vertical">
          <span className="mono">{r.iqc_no}</span>
          <StatusTag dict="insp_status" value={r.iqc_status} />
        </Space>
      ) : <Typography.Text type="secondary">免检 / 期初</Typography.Text>),
    },
  ];

  const kpColumns: TableColumnsType<Rec> = [
    { title: '关键件', key: 'm', render: (_, r) => <MaterialCell code={r.material_code} name={r.material_name} /> },
    { title: '批号', dataIndex: 'lot_no', render: (v, r) => <LotLink code={r.material_code} lot={v} /> },
    { title: '部件序列号', dataIndex: 'part_sn', render: (v) => (v ? <span className="mono">{v}</span> : '-') },
    { title: '绑定时间', dataIndex: 'ts', render: (v) => fmtDateTime(v) },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* 概要 + 追溯链 */}
      <Card>
        <Row gutter={[24, 16]} align="middle">
          <Col flex="auto">
            <Space align="center" wrap>
              <Typography.Title level={3} className="mono" style={{ margin: 0 }} copyable={{ text: s.sn, tooltips: ['复制序列号', '已复制'] }}>{s.sn}</Typography.Title>
              <StatusTag dict="sn_status" value={s.status} />
              {reworks > 0 && <Tag color="orange">返工 {reworks} 次</Tag>}
            </Space>
            <div style={{ marginTop: 4, fontSize: 15 }}>
              <b>{p.name}</b>
              <Typography.Text type="secondary"> · 型号 {p.model || '-'} · {p.code}</Typography.Text>
            </div>
            {s.udi && (
              <Typography.Text className="mono" type="secondary" style={{ fontSize: 12 }} copyable={{ text: s.udi, tooltips: ['复制 UDI', '已复制'] }}>
                UDI {s.udi}
              </Typography.Text>
            )}
          </Col>
          <Col>
            <Space size={32}>
              <Statistic title="物料批次" value={materials.length} />
              <Statistic title="工序记录" value={records.length} />
              <Statistic title="不合格 / NCR" value={`${fails} / ${ncrs.length}`} valueStyle={{ color: fails || ncrs.length ? C.bad : undefined }} />
            </Space>
          </Col>
        </Row>
        <Steps size="small" style={{ marginTop: 20 }} items={steps.map((x) => ({ ...x }))} />
      </Card>

      {/* 产品 / 工单 / 发货 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <Card size="small" title={<SectionTitle icon={<BarcodeOutlined />}>产品信息</SectionTitle>} style={{ height: '100%' }}>
            <Descriptions size="small" column={1} styles={{ label: { width: 96 } }}>
              <Descriptions.Item label="产品编码">{p.code}</Descriptions.Item>
              <Descriptions.Item label="产品名称">{p.name}</Descriptions.Item>
              <Descriptions.Item label="型号">{p.model || '-'}</Descriptions.Item>
              <Descriptions.Item label="注册证号">{p.registration_no || '-'}</Descriptions.Item>
              <Descriptions.Item label="生产批号"><LotLink code={p.code} lot={s.lot_no} /></Descriptions.Item>
              <Descriptions.Item label="完工时间">{fmtDateTime(s.completed_at)}</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card
            size="small"
            title={<SectionTitle icon={<ToolOutlined />}>生产工单</SectionTitle>}
            extra={<Link to={`/quality/dhr/${wo.id}`}><AuditOutlined /> 查看 DHR</Link>}
            style={{ height: '100%' }}
          >
            <Descriptions size="small" column={1} styles={{ label: { width: 96 } }}>
              <Descriptions.Item label="工单号"><Link to={`/mes/work-orders/${wo.id}`}><b>{wo.no}</b></Link></Descriptions.Item>
              <Descriptions.Item label="客户">{wo.customer_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="销售订单">{wo.so_no || '-'}</Descriptions.Item>
              <Descriptions.Item label="BOM / 工艺">{wo.bom_version || '-'} / {wo.routing_version || '-'}</Descriptions.Item>
              <Descriptions.Item label="DHR 状态"><StatusTag dict="dhr_status" value={wo.dhr_status} /></Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card size="small" title={<SectionTitle icon={<CarOutlined />}>发货去向</SectionTitle>} style={{ height: '100%' }}>
            {sh ? (
              <Descriptions size="small" column={1} styles={{ label: { width: 96 } }}>
                <Descriptions.Item label="客户"><b>{sh.customer_name}</b></Descriptions.Item>
                <Descriptions.Item label="发货日期">{fmtDate(sh.ship_date)}</Descriptions.Item>
                <Descriptions.Item label="承运商">{sh.carrier || '-'}</Descriptions.Item>
                <Descriptions.Item label="运单号"><span className="mono">{sh.tracking_no || '-'}</span></Descriptions.Item>
                <Descriptions.Item label="发货单"><Link className="mono" to={`/wms/shipments?q=${encodeURIComponent(sh.no)}`}>{sh.no}</Link></Descriptions.Item>
                <Descriptions.Item label="销售订单">{sh.so_no || '-'}</Descriptions.Item>
              </Descriptions>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span>尚未发货<br /><Typography.Text type="secondary">当前状态：{dictLabel('sn_status', s.status)}</Typography.Text></span>} />
            )}
          </Card>
        </Col>
      </Row>

      <Card size="small" title={<SectionTitle icon={<InboxOutlined />} extra={<Tag>{materials.length}</Tag>}>所用物料批次</SectionTitle>}>
        <Table rowKey={(r) => `${r.material_id}-${r.lot_no}`} size="small" columns={matColumns} dataSource={materials} pagination={false} scroll={{ x: 'max-content' }} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>按工单已过账领料汇总；点击批号可查看该批次影响的全部产品（正向追溯）。</Typography.Text>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={side ? 14 : 24}>
          <Card size="small" title={<SectionTitle icon={<ExperimentOutlined />} extra={<Tag>{records.length}</Tag>}>工序过站 / 测试记录</SectionTitle>}>
            {records.length ? (
              <Timeline
                style={{ marginTop: 8 }}
                items={records.map((r) => {
                  const pass = r.result === 'PASS';
                  return {
                    color: pass ? 'green' : 'red',
                    dot: pass ? <CheckCircleFilled style={{ fontSize: 16, color: C.ok }} /> : <CloseCircleFilled style={{ fontSize: 16, color: C.bad }} />,
                    children: (
                      <div style={{ paddingBottom: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                          <Space size={6} wrap>
                            <b>{r.seq} {r.op_name}</b>
                            <Tag color={pass ? 'green' : 'red'} style={{ marginInlineEnd: 0 }}>{pass ? '合格' : '不合格'}</Tag>
                            {r.is_rework && <Tag color="orange" style={{ marginInlineEnd: 0 }}>返工</Tag>}
                          </Space>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{fmtDateTime(r.ts)}</Typography.Text>
                        </div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          操作员 {r.operator_name || '-'}
                          {r.equipment_code && <> · 设备 <span className="mono">{r.equipment_code}</span></>}
                        </Typography.Text>
                        {r.values?.length > 0 && (
                          <div style={{ marginTop: 6, background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 6, padding: '4px 10px' }}>
                            {(r.values as Rec[]).map((v, i) => {
                              const ok = v.result !== 'FAIL';
                              return (
                                <div
                                  key={`${v.name}-${i}`}
                                  style={{ display: 'grid', gridTemplateColumns: 'minmax(90px,1.4fr) minmax(80px,1fr) minmax(80px,1fr) 18px', gap: 8, padding: '3px 0', fontSize: 12, borderTop: i ? '1px dashed #eee' : undefined }}
                                >
                                  <span>{v.name}</span>
                                  <b style={{ color: ok ? undefined : C.bad, textAlign: 'right' }}>{v.value ?? '-'} {v.unit}</b>
                                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>规格 {specText(v.lower, v.upper)}</Typography.Text>
                                  {ok ? <CheckCircleFilled style={{ color: C.ok }} /> : <CloseCircleFilled style={{ color: C.bad }} />}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ),
                  };
                })}
              />
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无过站记录" />}
          </Card>
        </Col>
        {side && (
          <Col xs={24} xl={10}>
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              {ncrs.length > 0 && (
                <Card size="small" title={<SectionTitle icon={<WarningOutlined style={{ color: C.bad }} />}>不合格记录 NCR</SectionTitle>}>
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {ncrs.map((n) => (
                      <Alert
                        key={n.no}
                        type={n.status === 'CLOSED' ? 'info' : 'warning'}
                        message={(
                          <Space wrap>
                            <Link className="mono" to={`/quality/ncrs?q=${encodeURIComponent(n.no)}`}><b>{n.no}</b></Link>
                            <StatusTag dict="ncr_status" value={n.status} />
                            {n.disposition && <StatusTag dict="disposition" value={n.disposition} />}
                          </Space>
                        )}
                        description={n.description}
                      />
                    ))}
                  </Space>
                </Card>
              )}
              {keyParts.length > 0 && (
                <Card size="small" title={<SectionTitle icon={<NodeIndexOutlined />}>关键件绑定（逐台）</SectionTitle>}>
                  <Table rowKey={(r) => `${r.material_code}-${r.lot_no}-${r.part_sn}-${r.ts}`} size="small" columns={kpColumns} dataSource={keyParts} pagination={false} scroll={{ x: 'max-content' }} />
                </Card>
              )}
            </Space>
          </Col>
        )}
      </Row>
    </Space>
  );
}

function SerialTrace({ sn, onSearch }: { sn: string; onSearch: (sn: string) => void }) {
  const [text, setText] = useState(sn);
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [recent, pushRecent] = useRecent('nuon_trace_sn');
  const seq = useRef(0);

  const run = useCallback((v: string) => {
    if (!v) return;
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    get(`/trace/serial/${encodeURIComponent(v)}`, undefined, true)
      .then((d) => {
        if (my !== seq.current) return;
        setData(d);
        pushRecent(d.serial.sn);
      })
      .catch((e) => {
        if (my !== seq.current) return;
        setData(null);
        setError(errText(e));
      })
      .finally(() => my === seq.current && setLoading(false));
  }, [pushRecent]);

  useEffect(() => {
    setText(sn);
    run(sn);
  }, [sn, run]);

  const submit = (raw: string) => {
    const v = parseSn(raw);
    setText(v);
    if (!v) return;
    if (v === sn) run(v);
    else onSearch(v);
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card style={{ background: 'linear-gradient(120deg,#f3efff 0%,#ffffff 70%)' }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          扫描设备铭牌上的序列号或 UDI 条码，追溯这台设备：用了哪些物料批次（供应商、来料检验）、每道工序谁在哪台设备做的、测试数据、是否返工、何时发给了哪个客户。
        </Typography.Paragraph>
        <Input.Search
          size="large"
          autoFocus
          allowClear
          value={text}
          onChange={(e) => setText(e.target.value)}
          onSearch={submit}
          prefix={<BarcodeOutlined style={{ color: C.brand }} />}
          placeholder="扫描或输入整机序列号 / UDI，回车追溯"
          enterButton={<><SearchOutlined /> 追溯</>}
          loading={loading}
          style={{ maxWidth: 720 }}
        />
        {recent.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>最近查询：</Typography.Text>
            {recent.map((r) => (
              <Tag key={r} className="mono" style={{ cursor: 'pointer' }} onClick={() => submit(r)}>{r}</Tag>
            ))}
          </div>
        )}
      </Card>
      <Spin spinning={loading}>
        {error ? (
          <Card><Result status="warning" title="未找到追溯记录" subTitle={error} /></Card>
        ) : data ? (
          <>
            <div style={{ textAlign: 'right', marginBottom: 8 }} className="no-print">
              <Button icon={<PrinterOutlined />} onClick={() => window.print()}>打印追溯报告</Button>
            </div>
            <SerialResult d={data} />
          </>
        ) : (
          <Card><Empty description="输入序列号开始追溯" /></Card>
        )}
      </Spin>
    </Space>
  );
}

/* ============================== 批次正向追溯 ============================== */

/** 物料编码输入（远程联想，值为编码字符串） */
function MaterialCodeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [opts, setOpts] = useState<{ value: string; label: ReactNode }[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const search = (q: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      get('/materials', { q: q || undefined, page_size: 20 }, true)
        .then((d) => setOpts((d.items as Rec[]).map((m) => ({
          value: m.code,
          label: (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <b>{m.code}</b>
              <Typography.Text type="secondary" ellipsis style={{ maxWidth: 200 }}>{m.name}</Typography.Text>
            </div>
          ),
        }))))
        .catch(() => undefined);
    }, 250);
  };
  return (
    <AutoComplete
      value={value}
      options={opts}
      onSearch={search}
      onFocus={() => !opts.length && search(value)}
      onChange={(v) => onChange(v)}
      style={{ width: 300 }}
      popupMatchSelectWidth={360}
    >
      <Input size="large" allowClear prefix={<InboxOutlined style={{ color: C.brand }} />} placeholder="物料编码，如 PSU-24V-5A" />
    </AutoComplete>
  );
}

function LotResult({ d }: { d: Rec }) {
  const [snFilter, setSnFilter] = useState<'all' | 'shipped' | 'factory'>('all');
  const m: Rec = d.material;
  const sum: Rec = d.summary;
  const receipts: Rec[] = d.receipts || [];
  const stock: Rec[] = d.stock || [];
  const wos: Rec[] = d.work_orders || [];
  const customers: Rec[] = [...(d.customers || [])].sort((a, b) => b.qty - a.qty);
  const serials: Rec[] = d.serials || [];
  const stockQty = stock.reduce((s, r) => s + (r.qty || 0), 0);
  const inFactory = sum.serials - sum.shipped;
  const empty = !receipts.length && !stock.length && !wos.length;

  const shownSerials = useMemo(
    () => serials.filter((s) => (snFilter === 'all' ? true : snFilter === 'shipped' ? !!s.shipment_no : !s.shipment_no)),
    [serials, snFilter],
  );

  if (empty) {
    return <Card><Result status="info" title="未找到该批次的任何记录" subTitle={`物料 ${m.code} 批号 ${d.lot_no} 没有入库、库存或领用记录，请核对批号。`} /></Card>;
  }

  const kpi = (title: string, value: number, icon: ReactNode, danger?: boolean, hint?: string) => (
    <Card size="small" style={{ height: '100%', borderColor: danger ? '#ffccc7' : undefined, background: danger ? '#fff7f6' : undefined }}>
      <Statistic title={<Space size={6}>{icon}{title}</Space>} value={value} valueStyle={{ fontSize: 30, fontWeight: 600, color: danger ? C.bad : undefined }} />
      {hint && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{hint}</Typography.Text>}
    </Card>
  );

  const rcColumns: TableColumnsType<Rec> = [
    { title: '入库单', dataIndex: 'receipt_no', render: (v) => <Link className="mono" to={`/wms/receipts?q=${encodeURIComponent(v)}`}>{v}</Link> },
    { title: '类型', dataIndex: 'receipt_type', render: (v) => <StatusTag dict="receipt_type" value={v} /> },
    { title: '日期', dataIndex: 'receipt_date', render: (v) => fmtDate(v) },
    { title: '供应商 / 客户', dataIndex: 'partner_name', render: (v) => v || '-' },
    { title: '数量', dataIndex: 'qty', align: 'right', render: (v) => fmtQty(v) },
    { title: '原厂批号', dataIndex: 'supplier_lot', render: (v) => (v ? <span className="mono">{v}</span> : '-') },
    {
      title: '来料检验', key: 'iqc',
      render: (_, r) => (r.iqc_no ? <Space size={4}><span className="mono">{r.iqc_no}</span><StatusTag dict="insp_status" value={r.iqc_status} /></Space> : '-'),
    },
  ];
  const woColumns: TableColumnsType<Rec> = [
    { title: '工单号', dataIndex: 'no', render: (v, r) => <Link to={`/mes/work-orders/${r.id}`}><b>{v}</b></Link> },
    { title: '产品', key: 'p', render: (_, r) => <MaterialCell code={r.product_code} name={r.product_name} /> },
    { title: '生产批号', dataIndex: 'lot_no', render: (v, r) => <LotLink code={r.product_code} lot={v} /> },
    { title: '本批用量', dataIndex: 'issued_qty', align: 'right', render: (v) => (v ? fmtQty(v) : <Typography.Text type="secondary">本批产品</Typography.Text>) },
    { title: '工单状态', dataIndex: 'status', render: (v) => <StatusTag dict="wo_status" value={v} /> },
    { title: '序列号', dataIndex: 'serial_count', align: 'right' },
    {
      title: '已发货', dataIndex: 'shipped_count', align: 'right',
      render: (v) => <span style={{ color: v ? C.bad : undefined, fontWeight: v ? 600 : undefined }}>{v}</span>,
    },
  ];
  const snColumns: TableColumnsType<Rec> = [
    { title: '序列号', dataIndex: 'sn', fixed: 'left', render: (v) => <SnLink sn={v} /> },
    { title: '工单', dataIndex: 'wo_no' },
    { title: '状态', dataIndex: 'status', render: (v) => <StatusTag dict="sn_status" value={v} /> },
    {
      title: <Tooltip title="该台设备逐台扫描绑定了本批次关键件">关键件绑定</Tooltip>, dataIndex: 'key_part_bound', align: 'center',
      render: (v) => (v ? <Tag color="green" style={{ marginInlineEnd: 0 }}>已绑定</Tag> : <Typography.Text type="secondary">-</Typography.Text>),
    },
    { title: '发货单', dataIndex: 'shipment_no', render: (v) => (v ? <Link className="mono" to={`/wms/shipments?q=${encodeURIComponent(v)}`}>{v}</Link> : '-') },
    { title: '客户', dataIndex: 'customer_name', render: (v) => (v ? <b>{v}</b> : <Typography.Text type="secondary">在厂</Typography.Text>) },
    { title: '发货日期', dataIndex: 'ship_date', render: (v) => fmtDate(v) },
  ];

  const exportSerials = () => exportCsv(
    `召回清单_${m.code}_${d.lot_no}.csv`,
    ['序列号', '工单', '状态', '关键件绑定', '发货单', '客户', '发货日期'],
    serials.map((s) => [s.sn, s.wo_no, dictLabel('sn_status', s.status), s.key_part_bound ? '是' : '', s.shipment_no, s.customer_name, s.ship_date]),
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
          <div>
            <Space align="center" wrap>
              <Typography.Title level={4} style={{ margin: 0 }}>{m.code} {m.name}</Typography.Title>
              <Tag color="purple" className="mono" style={{ fontSize: 14, padding: '2px 10px' }}>批号 {d.lot_no}</Tag>
            </Space>
            {m.spec && <div><Typography.Text type="secondary">{m.spec}</Typography.Text></div>}
          </div>
          <Space className="no-print">
            <Button icon={<DownloadOutlined />} disabled={!serials.length} onClick={exportSerials}>导出召回清单</Button>
            <Button icon={<PrinterOutlined />} onClick={() => window.print()}>打印</Button>
          </Space>
        </div>
        <Row gutter={[12, 12]}>
          <Col xs={12} md={6}>{kpi('涉及工单', sum.work_orders, <ToolOutlined />)}</Col>
          <Col xs={12} md={6}>{kpi('涉及序列号', sum.serials, <BarcodeOutlined />, false, inFactory > 0 ? `在厂 ${inFactory} 台` : undefined)}</Col>
          <Col xs={12} md={6}>{kpi('已发货台数', sum.shipped, <CarOutlined />, sum.shipped > 0)}</Col>
          <Col xs={12} md={6}>{kpi('涉及客户', sum.customers, <AimOutlined />, sum.customers > 0)}</Col>
        </Row>
        <div style={{ marginTop: 16 }}>
          {sum.shipped > 0 ? (
            <Alert
              type="error"
              showIcon
              message={<b>召回范围：{sum.shipped} 台已发往 {sum.customers} 个客户</b>}
              description={`建议立即冻结该批次剩余库存${stockQty ? `（在库 ${fmtQty(stockQty)}）` : ''}及在厂的 ${inFactory} 台产品，按下方“涉及客户 / 序列号”清单通知客户（可导出），并开具 NCR / CAPA。`}
            />
          ) : sum.serials > 0 || sum.work_orders > 0 ? (
            <Alert type="success" showIcon message={<b>该批次尚无成品出厂，影响范围限于厂内</b>} description={`涉及 ${sum.work_orders} 个工单、${sum.serials} 台在制/在库产品，可直接隔离处置。`} />
          ) : (
            <Alert type="info" showIcon message="该批次尚未投入生产使用" description={stockQty ? `当前在库 ${fmtQty(stockQty)}，如有质量问题可直接冻结 / 退货。` : undefined} />
          )}
        </div>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card size="small" title={<SectionTitle icon={<InboxOutlined />} extra={<Tag>{receipts.length}</Tag>}>来料记录</SectionTitle>} style={{ height: '100%' }}>
            <Table rowKey={(r) => `${r.receipt_no}-${r.qty}-${r.supplier_lot}`} size="small" columns={rcColumns} dataSource={receipts} pagination={false} scroll={{ x: 'max-content' }} />
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card size="small" title={<SectionTitle icon={<InboxOutlined />} extra={<Tag color={stockQty ? 'blue' : 'default'}>剩余 {fmtQty(stockQty)}</Tag>}>当前库存</SectionTitle>} style={{ height: '100%' }}>
            <Table
              rowKey={(r) => `${r.location_code}-${r.status}`}
              size="small"
              dataSource={stock}
              pagination={false}
              locale={{ emptyText: '已全部领用 / 发出' }}
              columns={[
                { title: '库位', dataIndex: 'location_code', render: (v) => <span className="mono">{v}</span> },
                { title: '质量状态', dataIndex: 'status', render: (v) => <StatusTag dict="stock_status" value={v} /> },
                { title: '数量', dataIndex: 'qty', align: 'right', render: (v) => <b>{fmtQty(v)}</b> },
              ]}
            />
            {stockQty > 0 && <Link to={`/wms/stock?q=${encodeURIComponent(d.lot_no)}`} style={{ fontSize: 12 }}>在库存查询中查看 →</Link>}
          </Card>
        </Col>
      </Row>

      <Card size="small" title={<SectionTitle icon={<ToolOutlined />} extra={<Tag>{wos.length}</Tag>}>流向工单</SectionTitle>}>
        <Table rowKey="id" size="small" columns={woColumns} dataSource={wos} pagination={false} scroll={{ x: 'max-content' }} locale={{ emptyText: '该批次尚未被任何工单领用' }} />
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={8}>
          <Card size="small" title={<SectionTitle icon={<AimOutlined />} extra={<Tag color={customers.length ? 'red' : 'default'}>{customers.length}</Tag>}>涉及客户</SectionTitle>}>
            {customers.length ? (
              <Space direction="vertical" size={14} style={{ width: '100%' }}>
                {customers.map((c) => (
                  <div key={c.customer_name}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <b>{c.customer_name}</b>
                      <span><b style={{ color: C.bad }}>{c.qty}</b> 台</span>
                    </div>
                    <Progress percent={sum.shipped ? Math.round((c.qty / sum.shipped) * 100) : 0} showInfo={false} strokeColor={C.bad} size="small" />
                  </div>
                ))}
              </Space>
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未发往任何客户" />}
          </Card>
        </Col>
        <Col xs={24} xl={16}>
          <Card
            size="small"
            title={<SectionTitle icon={<BarcodeOutlined />} extra={<Tag>{serials.length}</Tag>}>涉及序列号</SectionTitle>}
            extra={(
              <Segmented
                size="small"
                value={snFilter}
                onChange={(v) => setSnFilter(v as typeof snFilter)}
                options={[
                  { value: 'all', label: `全部 ${serials.length}` },
                  { value: 'shipped', label: `已发货 ${sum.shipped}` },
                  { value: 'factory', label: `在厂 ${inFactory}` },
                ]}
              />
            )}
          >
            <Table rowKey="sn" size="small" columns={snColumns} dataSource={shownSerials} pagination={{ pageSize: 20, size: 'small', hideOnSinglePage: true }} scroll={{ x: 'max-content' }} />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

function LotTrace({ code, lot, onSearch }: { code: string; lot: string; onSearch: (code: string, lot: string) => void }) {
  const [mc, setMc] = useState(code);
  const [ln, setLn] = useState(lot);
  const [lots, setLots] = useState<string[]>([]);
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [recent, pushRecent] = useRecent('nuon_trace_lot');
  const seq = useRef(0);

  const run = useCallback((c: string, l: string) => {
    if (!c || !l) return;
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    get('/trace/lot', { material_code: c, lot_no: l }, true)
      .then((d) => {
        if (my !== seq.current) return;
        setData(d);
        pushRecent(`${d.material.code}|${d.lot_no}`);
      })
      .catch((e) => {
        if (my !== seq.current) return;
        setData(null);
        setError(errText(e));
      })
      .finally(() => my === seq.current && setLoading(false));
  }, [pushRecent]);

  useEffect(() => {
    setMc(code);
    setLn(lot);
    run(code, lot);
  }, [code, lot, run]);

  // 该物料的历史批号（来自库存流水），便于选择
  useEffect(() => {
    const c = mc.trim();
    setLots([]);
    if (!c) return;
    const t = setTimeout(() => {
      get('/stock-moves', { q: c, page_size: 500 }, true)
        .then((d) => setLots([...new Set((d.items as Rec[]).filter((r) => r.material_code === c && r.lot_no).map((r) => r.lot_no as string))]))
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(t);
  }, [mc]);

  const submit = (c = mc, l = ln) => {
    const cc = c.trim();
    const ll = l.trim();
    if (!cc || !ll) {
      setError(null);
      setData(null);
      return;
    }
    if (cc === code && ll === lot) run(cc, ll);
    else onSearch(cc, ll);
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card style={{ background: 'linear-gradient(120deg,#fff1f0 0%,#ffffff 70%)' }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          发现某个物料批次有质量问题时，输入物料编码和批号，几秒内算出召回范围：用到了哪些工单、哪些序列号、已发给哪些客户。
        </Typography.Paragraph>
        <Space wrap size={12}>
          <MaterialCodeInput value={mc} onChange={setMc} />
          <Input
            size="large"
            allowClear
            className="mono"
            style={{ width: 240 }}
            placeholder="批号"
            value={ln}
            onChange={(e) => setLn(e.target.value)}
            onPressEnter={() => submit()}
          />
          <Button size="large" type="primary" danger icon={<AimOutlined />} loading={loading} disabled={!mc.trim() || !ln.trim()} onClick={() => submit()}>
            评估召回范围
          </Button>
        </Space>
        {lots.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>{mc.trim()} 的批号：</Typography.Text>
            {lots.slice(0, 15).map((l) => (
              <Tag key={l} className="mono" color={l === ln ? 'purple' : undefined} style={{ cursor: 'pointer' }} onClick={() => { setLn(l); submit(mc, l); }}>{l}</Tag>
            ))}
          </div>
        )}
        {recent.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>最近查询：</Typography.Text>
            {recent.map((r) => {
              const [c, l] = r.split('|');
              return <Tag key={r} style={{ cursor: 'pointer' }} onClick={() => submit(c, l)}>{c} · <span className="mono">{l}</span></Tag>;
            })}
          </div>
        )}
      </Card>
      <Spin spinning={loading}>
        {error ? (
          <Card><Result status="warning" title="查询失败" subTitle={error} /></Card>
        ) : data ? (
          <LotResult key={`${data.material.code}|${data.lot_no}`} d={data} />
        ) : (
          <Card><Empty description="输入物料编码与批号，评估召回范围" /></Card>
        )}
      </Spin>
    </Space>
  );
}

/* ============================== 页面 ============================== */

export default function Trace() {
  const [sp, setSp] = useSearchParams();
  const sn = sp.get('sn') || '';
  const code = sp.get('material_code') || '';
  const lot = sp.get('lot_no') || '';
  const [tab, setTab] = useState(!sn && (code || lot) ? 'lot' : 'sn');

  // 链接跳转（如从序列号结果点击物料批号）时自动切换到对应页签
  useEffect(() => {
    if (sn) setTab('sn');
    else if (code || lot) setTab('lot');
  }, [sn, code, lot]);

  return (
    <>
      <PageHeader
        title="质量追溯"
        sub="一码到底：序列号反查物料批次、工序、测试、放行与发货；物料批次正查工单、整机与客户，召回范围秒级评估。"
      />
      <Tabs
        activeKey={tab}
        onChange={setTab}
        size="large"
        tabBarStyle={{ marginBottom: 16 }}
        items={[
          {
            key: 'sn',
            label: <span><BarcodeOutlined /> 序列号反向追溯</span>,
            children: <SerialTrace sn={sn} onSearch={(v) => setSp({ sn: v })} />,
          },
          {
            key: 'lot',
            label: <span><AimOutlined /> 批次正向追溯（召回范围评估）</span>,
            children: <LotTrace code={code} lot={lot} onSearch={(c, l) => setSp({ material_code: c, lot_no: l })} />,
          },
        ]}
      />
    </>
  );
}
