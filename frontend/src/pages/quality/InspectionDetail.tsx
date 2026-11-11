import {
  Alert, Button, Card, Checkbox, Col, Descriptions, Input, InputNumber, Radio, Result, Row, Space, Spin, Table, Tag, Typography, message,
} from 'antd';
import { ArrowLeftOutlined, DeleteOutlined, PlusOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import { isCancel, useESign } from '../../components/ESign';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import { dictLabel } from '../../utils/dict';
import { fmtDateTime, fmtQty } from '../../utils/format';

interface ItemRow {
  key: string;
  id?: number;
  name: string;
  standard?: string;
  value?: string;
  result: 'PASS' | 'FAIL';
}

const toRows = (items: Rec[] = []): ItemRow[] =>
  items.map((i) => ({ key: `i${i.id}`, id: i.id, name: i.name, standard: i.standard ?? '', value: i.value ?? '', result: i.result === 'FAIL' ? 'FAIL' : 'PASS' }));

/** 抽样方案卡片 */
function SamplingCard({ insp }: { insp: Rec }) {
  const full = insp.sample_size != null && insp.sample_size >= insp.lot_qty;
  return (
    <Card size="small" title="抽样方案" extra={<Typography.Text type="secondary">系统自动计算</Typography.Text>}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>GB/T 2828.1-2012 正常检验一次抽样 · 一般检验水平 II</Typography.Paragraph>
      <Descriptions size="small" bordered column={2} items={[
        { key: 'aql', label: 'AQL', children: insp.aql ?? '-' },
        { key: 'l', label: '样本量字码', children: <b>{insp.code_letter ?? '-'}</b> },
        { key: 'n', label: '样本量 n', children: <b style={{ fontSize: 16 }}>{insp.sample_size ?? '-'}</b> },
        { key: 'lot', label: '批量 N', children: fmtQty(insp.lot_qty) },
        { key: 'ac', label: '接收数 Ac', children: <b style={{ color: '#389e0d', fontSize: 16 }}>{insp.accept_num ?? '-'}</b> },
        { key: 're', label: '拒收数 Re', children: <b style={{ color: '#cf1322', fontSize: 16 }}>{insp.reject_num ?? '-'}</b> },
      ]} />
      <Alert
        style={{ marginTop: 12 }}
        type="info"
        message={full
          ? `样本量 ≥ 批量：需全数检验 ${fmtQty(insp.lot_qty)} 件。`
          : `从本批 ${fmtQty(insp.lot_qty)} 件中随机抽取 ${insp.sample_size} 件：不良数 ≤ ${insp.accept_num} 接收，≥ ${insp.reject_num} 拒收。`}
      />
    </Card>
  );
}

/** 提交后的结果说明 */
function SubmitResult({ insp }: { insp: Rec }) {
  const nav = useNavigate();
  const ncrLink = <Button key="ncr" onClick={() => nav(`/quality/ncrs?q=${encodeURIComponent(insp.lot_no)}`)}>查看 NCR</Button>;
  const back = <Button key="list" type="primary" onClick={() => nav('/quality/inspections')}>继续检验下一单</Button>;
  const stock = <Button key="stock" onClick={() => nav(`/wms/stock?q=${encodeURIComponent(insp.material_code)}`)}>查看库存</Button>;
  if (insp.status === 'PASSED') {
    return <Result status="success" title="检验合格，批次已放行"
      subTitle={`${insp.material_code} ${insp.material_name} 批号 ${insp.lot_no}：库存已由“待检”自动转为“合格”，可被生产领用。`} extra={[back, stock]} />;
  }
  if (insp.status === 'CONCESSION') {
    return <Result status="warning" title="已让步接收"
      subTitle={`批号 ${insp.lot_no} 库存已转为“合格”，同时生成“已处置（让步接收）”的 NCR 记录备查。请关注使用风险。`} extra={[back, ncrLink, stock]} />;
  }
  return <Result status="error" title="检验不合格，批次已隔离"
    subTitle={`批号 ${insp.lot_no} 库存已自动转为“不合格”状态（不能被领用），系统已自动开具 NCR，等待 QA 评审处置（退货 / 报废 / 挑选后重检 / 让步接收）。`}
    extra={[back, ncrLink, stock]} />;
}

export default function InspectionDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { can } = useAuth();
  const [sign, signHolder] = useESign();
  const [insp, setInsp] = useState<Rec | null>(null);
  const [failed, setFailed] = useState(false);
  const [rows, setRows] = useState<ItemRow[]>([]);
  const [defectQty, setDefectQty] = useState<number>(0);
  const [concession, setConcession] = useState(false);
  const [remark, setRemark] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    get(`/inspections/${id}`)
      .then((d) => {
        setInsp(d);
        setRows(toRows(d.items));
      })
      .catch(() => setFailed(true));
  }, [id]);

  if (failed) return <Result status="404" title="检验单不存在" extra={<Button onClick={() => nav('/quality/inspections')}>返回列表</Button>} />;
  if (!insp) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>;

  const editable = insp.status === 'PENDING' && can('qc');
  const ac = insp.accept_num ?? 0;
  const failItems = rows.filter((r) => r.result === 'FAIL');
  const overAc = defectQty > ac;
  const accept = !overAc && failItems.length === 0;
  const preview = accept ? 'PASSED' : concession && can('qa') ? 'CONCESSION' : 'REJECTED';

  const update = (key: string, patch: Partial<ItemRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const submit = async () => {
    if (rows.some((r) => !r.name.trim())) {
      message.warning('请填写自定义检验项目的名称');
      return;
    }
    const label = dictLabel('insp_status', preview);
    const consequence = preview === 'REJECTED' ? '库存将转为“不合格”并自动开具 NCR。' : '库存将转为“合格”，可被生产领用。';
    try {
      const signature = await sign({
        meaning: 'IQC检验判定',
        description: `判定结果：${label}（抽样 ${insp.sample_size}，不良 ${defectQty}，Ac=${ac}）。${consequence}`,
        defaultReason: remark || undefined,
      });
      setSubmitting(true);
      const r = await post(`/inspections/${id}/submit`, {
        defect_qty: defectQty,
        items: rows.map(({ id: itemId, name, standard, value, result }) => ({ id: itemId, name: name.trim(), standard, value, result })),
        concession: preview === 'CONCESSION',
        remark: remark || undefined,
        signature,
      });
      setInsp(r);
      setRows(toRows(r.items));
      setSubmitted(true);
      message.success('检验结果已提交');
    } catch (e) {
      if (!isCancel(e)) throw e;
    } finally {
      setSubmitting(false);
    }
  };

  const itemColumns: any[] = [
    { title: '#', key: 'idx', width: 40, render: (_: any, __: ItemRow, i: number) => i + 1 },
    {
      title: '检验项目', dataIndex: 'name', width: 160,
      render: (v: string, r: ItemRow) => (editable && !r.id ? <Input value={v} placeholder="项目名称" onChange={(e) => update(r.key, { name: e.target.value })} /> : <b>{v}</b>),
    },
    {
      title: '标准 / 要求', dataIndex: 'standard',
      render: (v: string, r: ItemRow) => (editable && !r.id ? <Input value={v} placeholder="判定标准" onChange={(e) => update(r.key, { standard: e.target.value })} /> : v || '-'),
    },
    {
      title: '实测 / 记录', dataIndex: 'value', width: 200,
      render: (v: string, r: ItemRow) => (editable ? <Input value={v} placeholder="如：抽测 5 件 658~662nm" onChange={(e) => update(r.key, { value: e.target.value })} /> : v || '-'),
    },
    {
      title: '判定', dataIndex: 'result', width: 170,
      render: (v: 'PASS' | 'FAIL', r: ItemRow) =>
        editable ? (
          <Radio.Group value={v} optionType="button" buttonStyle="solid" onChange={(e) => update(r.key, { result: e.target.value })}
            options={[{ value: 'PASS', label: '合格' }, { value: 'FAIL', label: '不合格' }]} />
        ) : <StatusTag dict="result" value={v} />,
    },
  ];
  if (editable) {
    itemColumns.push({
      title: '', key: 'del', width: 48,
      render: (_: any, r: ItemRow) => (!r.id ? <Button type="text" danger icon={<DeleteOutlined />} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} /> : null),
    });
  }

  return (
    <>
      {signHolder}
      <PageHeader
        title={<Space wrap>检验单 {insp.no}<StatusTag dict="insp_type" value={insp.insp_type} /><StatusTag dict="insp_status" value={insp.status} /></Space>}
        sub={`${insp.material_code} ${insp.material_name}${insp.material_spec ? ` | ${insp.material_spec}` : ''}`}
        extra={<Button icon={<ArrowLeftOutlined />} onClick={() => nav('/quality/inspections')}>返回列表</Button>}
      />
      {submitted && <Card style={{ marginBottom: 16 }}><SubmitResult insp={insp} /></Card>}
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card size="small" title="来料信息">
              <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }} items={[
                { key: 'm', label: '物料', children: `${insp.material_code} ${insp.material_name}` },
                { key: 's', label: '规格', children: insp.material_spec || '-' },
                {
                  key: 'lot', label: '批号',
                  children: <Link className="mono" to={`/trace?material_code=${encodeURIComponent(insp.material_code)}&lot_no=${encodeURIComponent(insp.lot_no)}`}>{insp.lot_no || '-'}</Link>,
                },
                { key: 'sup', label: '供应商', children: insp.supplier_name || (insp.owner_customer_id ? <Tag color="purple">客供料</Tag> : '-') },
                { key: 'q', label: '批量', children: `${fmtQty(insp.lot_qty)} ${insp.uom ?? ''}` },
                { key: 'cs', label: '物料归属', children: insp.owner_customer_id ? <Tag color="purple">客供料</Tag> : '自购' },
                { key: 'at', label: '到货时间', children: fmtDateTime(insp.created_at) },
                { key: 'by', label: '收货人', children: insp.created_by || '-' },
                ...(insp.status !== 'PENDING'
                  ? [
                    { key: 'ins', label: '检验员', children: insp.inspector || '-' },
                    { key: 'iat', label: '检验时间', children: fmtDateTime(insp.inspected_at) },
                    { key: 'dq', label: '不良数', children: <b style={{ color: insp.defect_qty > ac ? '#cf1322' : undefined }}>{insp.defect_qty}</b> },
                    { key: 'rm', label: '检验结论备注', children: insp.result_remark || '-' },
                  ]
                  : []),
              ]} />
            </Card>
            <Card
              size="small"
              title="检验项目"
              extra={editable && (
                <Button size="small" icon={<PlusOutlined />}
                  onClick={() => setRows((rs) => [...rs, { key: `n${Date.now()}`, name: '', standard: '', value: '', result: 'PASS' }])}>
                  添加检验项目
                </Button>
              )}
            >
              <Table<ItemRow>
                rowKey="key"
                size="middle"
                pagination={false}
                dataSource={rows}
                columns={itemColumns}
                onRow={(r) => ({ style: r.result === 'FAIL' ? { background: '#fff1f0' } : undefined })}
              />
            </Card>
          </Space>
        </Col>
        <Col xs={24} xl={8}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <SamplingCard insp={insp} />
            {editable ? (
              <Card size="small" title="判定">
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <div>
                    <div style={{ marginBottom: 4 }}>样本中不良品数量</div>
                    <InputNumber min={0} max={insp.sample_size || undefined} precision={0} size="large" style={{ width: '100%' }}
                      value={defectQty} onChange={(v) => setDefectQty(Number(v) || 0)} suffix={`/ ${insp.sample_size ?? '-'} 件`} />
                  </div>
                  <Alert
                    type={accept ? 'success' : 'error'}
                    showIcon
                    message={<b style={{ fontSize: 16 }}>预判：{accept ? '合格（接收）' : '不合格（拒收）'}</b>}
                    description={
                      accept
                        ? `不良数 ${defectQty} ≤ Ac ${ac}，且所有检验项目合格。`
                        : [
                          overAc ? `不良数 ${defectQty} ≥ Re ${insp.reject_num}` : '',
                          failItems.length ? `不合格项目：${failItems.map((r) => r.name || '未命名').join('、')}` : '',
                        ].filter(Boolean).join('；')
                    }
                  />
                  {!accept && can('qa') && (
                    <Checkbox checked={concession} onChange={(e) => setConcession(e.target.checked)}>
                      申请<b>让步接收</b>（QA 批准：库存转合格，并留存已处置 NCR）
                    </Checkbox>
                  )}
                  {!accept && !can('qa') && <Typography.Text type="secondary">如需让步接收，请由 QA 账号提交或在 NCR 中评审处置。</Typography.Text>}
                  <Input.TextArea rows={2} value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="检验结论备注（如：抽检 5 件波长均在规格内）" />
                  <Button type="primary" size="large" block icon={<SafetyCertificateOutlined />} loading={submitting} danger={preview === 'REJECTED'} onClick={submit}>
                    签名提交：判定{dictLabel('insp_status', preview)}
                  </Button>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    提交需电子签名。合格 → 库存自动转为“合格”；不合格 → 自动转入“不合格”并开具 NCR。
                  </Typography.Text>
                </Space>
              </Card>
            ) : insp.status === 'PENDING' ? (
              <Alert type="warning" showIcon message="该批待检验" description="只有质量检验员（QC）账号可以录入并提交检验结果。待检物料不能被领用。" />
            ) : (
              <Card size="small" title="检验结论">
                <Space direction="vertical">
                  <StatusTag dict="insp_status" value={insp.status} />
                  <Typography.Text>不良数 {insp.defect_qty}（Ac {ac} / Re {insp.reject_num}）</Typography.Text>
                  <Typography.Text type="secondary">{insp.inspector} · {fmtDateTime(insp.inspected_at)}</Typography.Text>
                  {insp.status !== 'PASSED' && <Link to={`/quality/ncrs?q=${encodeURIComponent(insp.lot_no)}`}>查看相关 NCR</Link>}
                </Space>
              </Card>
            )}
          </Space>
        </Col>
      </Row>
    </>
  );
}
