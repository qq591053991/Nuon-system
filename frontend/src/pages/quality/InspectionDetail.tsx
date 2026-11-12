import {
  Alert, Button, Card, Checkbox, Col, Descriptions, Input, InputNumber, Radio, Result, Row, Space, Spin, Table, Tag, Tooltip, Typography, message,
} from 'antd';
import type { InputRef } from 'antd';
import {
  ArrowLeftOutlined, ArrowRightOutlined, CheckOutlined, DeleteOutlined, PlusOutlined, SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import Attachments from '../../components/Attachments';
import { isCancel, useESign } from '../../components/ESign';
import PageHeader from '../../components/PageHeader';
import { useNarrow } from '../../components/ResponsiveTable';
import StatusTag from '../../components/StatusTag';
import { dictLabel } from '../../utils/dict';
import { fmtDateTime, fmtQty } from '../../utils/format';
import { QPrintButton, QPrintSignatures, g, limitText } from './qshared';
import { PrintHeader } from '../../components/Print';

/** 定量项至少录入件数（与后端一致：min(样本量, 5)） */
const QUANT_MIN = 5;

interface ItemRow {
  key: string;
  id?: number;
  name: string;
  standard?: string;
  method?: string | null;
  item_type: 'QUAL' | 'QUANT';
  lower: number | null;
  upper: number | null;
  unit: string | null;
  /** 定量项逐件值（文本，便于录入） */
  values: string[];
  /** 定性项判定（未确认为 null） */
  result: 'PASS' | 'FAIL' | null;
  defects: number;
  value: string;
  checked: boolean;
}

const isOut = (x: number, r: Pick<ItemRow, 'lower' | 'upper'>) => (r.lower !== null && x < r.lower) || (r.upper !== null && x > r.upper);
const numsOf = (r: ItemRow) => r.values.map((v) => v.trim()).filter((v) => v !== '').map(Number);

function toRows(items: Rec[] = [], need: number, editable: boolean): ItemRow[] {
  return items.map((i) => {
    const quant = i.item_type === 'QUANT';
    const samples: number[] = i.samples ?? [];
    const values = quant ? (samples.length ? samples.map(String) : editable ? Array(need).fill('') : []) : [];
    return {
      key: `i${i.id}`, id: i.id, name: i.name, standard: i.standard ?? '', method: i.method ?? null,
      item_type: quant ? 'QUANT' : 'QUAL', lower: i.lower ?? null, upper: i.upper ?? null, unit: i.unit ?? null,
      values, result: editable ? (i.checked ? i.result : null) : i.result, defects: i.item_defects ?? 0, value: i.value ?? '', checked: !!i.checked,
    };
  });
}

/** 某项的判定与不良数（定量项按上下限自动判定） */
function judge(r: ItemRow, need: number): { done: boolean; result: 'PASS' | 'FAIL' | null; defects: number; missing?: string } {
  if (r.item_type === 'QUANT') {
    const raw = r.values.map((v) => v.trim()).filter((v) => v !== '');
    if (raw.some((v) => !Number.isFinite(Number(v)))) return { done: false, result: null, defects: 0, missing: '实测值须为数字' };
    const bad = raw.map(Number).filter((x) => isOut(x, r)).length;
    if (raw.length < need) return { done: false, result: bad ? 'FAIL' : null, defects: bad, missing: `还需录入 ${need - raw.length} 件` };
    return { done: true, result: bad ? 'FAIL' : 'PASS', defects: bad };
  }
  if (!r.result) return { done: false, result: null, defects: 0, missing: '未确认' };
  return { done: true, result: r.result, defects: r.result === 'FAIL' ? r.defects : 0 };
}

/** 抽样方案卡片 */
function SamplingCard({ insp }: { insp: Rec }) {
  const full = insp.sample_size != null && insp.sample_size >= insp.lot_qty;
  return (
    <Card size="small" title="抽样方案" extra={<Typography.Text type="secondary">系统自动计算</Typography.Text>}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>GB/T 2828.1-2012 正常检验一次抽样 · 一般检验水平 II</Typography.Paragraph>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
        {([
          ['批量 N', fmtQty(insp.lot_qty), undefined], ['AQL', insp.aql ?? '-', undefined], ['字码', insp.code_letter ?? '-', undefined],
          ['样本量 n', insp.sample_size ?? '-', '#262626'], ['接收 Ac', insp.accept_num ?? '-', '#389e0d'], ['拒收 Re', insp.reject_num ?? '-', '#cf1322'],
        ] as [string, any, string | undefined][]).map(([label, v, color]) => (
          <div key={label} style={{ background: '#fafafa', borderRadius: 6, padding: '6px 10px' }}>
            <div style={{ fontSize: 12, color: '#8c8c8c', whiteSpace: 'nowrap' }}>{label}</div>
            <div style={{ fontSize: color ? 20 : 15, fontWeight: color ? 700 : 500, color, whiteSpace: 'nowrap' }}>{v}</div>
          </div>
        ))}
      </div>
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

/** 提交后的结果说明 + 直接进入下一张待检单 */
function SubmitResult({ insp, next, pending }: { insp: Rec; next: Rec | null; pending: number }) {
  const nav = useNavigate();
  const ncr = insp.ncrs?.[0];
  const goNext = next
    ? <Button key="next" type="primary" size="large" autoFocus icon={<ArrowRightOutlined />} onClick={() => nav(`/quality/inspections/${next.id}`)}>
      检验下一张：{next.no} {next.material_name}（回车）
    </Button>
    : <Button key="list" type="primary" autoFocus onClick={() => nav('/quality/inspections')}>待检单已全部完成，返回列表</Button>;
  const ncrLink = <Button key="ncr" onClick={() => nav(ncr ? `/quality/ncrs?id=${ncr.id}` : `/quality/ncrs?q=${encodeURIComponent(insp.lot_no)}`)}>查看 NCR{ncr ? ` ${ncr.no}` : ''}</Button>;
  const stock = <Button key="stock" onClick={() => nav(`/wms/stock?q=${encodeURIComponent(insp.material_code)}`)}>查看库存</Button>;
  const left = next ? `还有 ${pending} 张待检单。` : '';
  if (insp.status === 'PASSED') {
    return <Result status="success" title="检验合格，批次已接收"
      subTitle={`${insp.material_code} ${insp.material_name} 批号 ${insp.lot_no}：库存已由“待检”自动转为“合格”，可被生产领用。${left}`} extra={[goNext, stock]} />;
  }
  if (insp.status === 'CONCESSION') {
    return <Result status="warning" title="已让步接收"
      subTitle={`批号 ${insp.lot_no} 库存已转为“合格”，同时生成“已处置（让步接收）”的 NCR 记录备查。请关注使用风险。${left}`} extra={[goNext, ncrLink, stock]} />;
  }
  return <Result status="error" title="检验不合格，批次已隔离"
    subTitle={`批号 ${insp.lot_no} 库存已自动转为“不合格”（不能被领用），已自动开具 ${ncr?.no ?? 'NCR'}，等待 QA 评审处置（退货 / 报废 / 挑选后重检 / 让步接收）。本单照片已关联到 NCR。${left}`}
    extra={[goNext, ncrLink, stock]} />;
}

/** 定量项逐件录入：回车跳到下一格，超限标红 */
function ValuesInput({ r, onChange, register, onEnter }: {
  r: ItemRow; onChange: (vals: string[]) => void; register: (i: number, el: InputRef | null) => void; onEnter: (i: number) => void;
}) {
  return (
    <Space size={[4, 4]} wrap style={{ maxWidth: 360 }}>
      {r.values.map((v, i) => {
        const n = v.trim() === '' ? null : Number(v);
        const bad = n !== null && (!Number.isFinite(n) || isOut(n, r));
        return (
          <Input
            key={i}
            ref={(el) => register(i, el)}
            value={v}
            inputMode="decimal"
            placeholder={`#${i + 1}`}
            status={bad ? 'error' : undefined}
            style={{ width: 64, padding: '4px 6px', fontWeight: bad ? 700 : undefined, color: bad ? '#cf1322' : undefined }}
            onChange={(e) => {
              const t = e.target.value.replace(/[^\d.\-]/g, '').replace(/(\..*)\./g, '$1');
              onChange(r.values.map((x, j) => (j === i ? t : x)));
            }}
            onPressEnter={() => onEnter(i)}
          />
        );
      })}
    </Space>
  );
}

export default function InspectionDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { can } = useAuth();
  const narrow = useNarrow(1200);
  const [sign, signHolder] = useESign();
  const [insp, setInsp] = useState<Rec | null>(null);
  const [failed, setFailed] = useState(false);
  const [rows, setRows] = useState<ItemRow[]>([]);
  const [defectOverride, setDefectOverride] = useState<number | null>(null);
  const [concession, setConcession] = useState(false);
  const [remark, setRemark] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ next: Rec | null; pending: number } | null>(null);
  const inputs = useRef<Map<string, InputRef | null>>(new Map());
  const submitBtn = useRef<HTMLButtonElement>(null);

  const load = useCallback(() => {
    setInsp(null);
    setDone(null);
    setDefectOverride(null);
    setConcession(false);
    setRemark('');
    get(`/inspections/${id}`)
      .then((d) => {
        setInsp(d);
        const need = Math.max(1, Math.min(d.sample_size || 1, QUANT_MIN));
        setRows(toRows(d.items, need, d.status === 'PENDING'));
      })
      .catch(() => setFailed(true));
  }, [id]);
  useEffect(load, [load]);
  // 打开待检单后焦点直接在第一个定量实测格（无定量项时不抢焦点）
  const loadedId = insp?.id;
  useEffect(() => {
    if (!loadedId || insp?.status !== 'PENDING') return;
    const t = setTimeout(() => {
      const first = [...inputs.current.entries()].find(([, el]) => el)?.[1];
      first?.focus();
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedId]);

  const need = insp ? Math.max(1, Math.min(insp.sample_size || 1, QUANT_MIN)) : QUANT_MIN;
  const judged = useMemo(() => rows.map((r) => ({ r, j: judge(r, need) })), [rows, need]);

  if (failed) return <Result status="404" title="检验单不存在" extra={<Button onClick={() => nav('/quality/inspections')}>返回列表</Button>} />;
  if (!insp) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>;

  const editable = insp.status === 'PENDING' && can('qc') && !done;
  const ac = insp.accept_num ?? 0;
  const incomplete = judged.filter((x) => !x.j.done);
  const failItems = judged.filter((x) => x.j.result === 'FAIL');
  // AQL 抽样不良数只计定性项；定量项是对子样逐件测量，任一件超限即判退（Ac=0），单独显示
  const qualFails = failItems.filter((x) => x.r.item_type !== 'QUANT');
  const quantFails = failItems.filter((x) => x.r.item_type === 'QUANT');
  const autoDefects = qualFails.reduce((s, x) => s + x.j.defects, 0);
  const maxItem = Math.max(0, ...qualFails.map((x) => x.j.defects));
  const defectQty = defectOverride ?? autoDefects;
  const overAc = defectQty > ac;
  const accept = !overAc && failItems.length === 0;
  /** 判退原因（与 NCR 描述一致） */
  const reasons = [
    quantFails.length ? `定量项超限（逐件判定，Ac=0）：${quantFails.map((x) => `${x.r.name} ${x.j.defects}/${numsOf(x.r).length} 件超限`).join('、')}` : '',
    qualFails.length ? `定性项不合格：${qualFails.map((x) => `${x.r.name}${x.j.defects ? `（不良 ${x.j.defects} 件）` : ''}`).join('、')}` : '',
    overAc ? `AQL 抽样不良 ${defectQty} 件 ≥ Re ${insp.reject_num}` : '',
  ].filter(Boolean);
  const preview = accept ? 'PASSED' : concession && can('qa') ? 'CONCESSION' : 'REJECTED';
  const defectErr = defectQty < maxItem ? `不能少于定性项最大不良数 ${maxItem}` : defectQty > 0 && !failItems.length ? '不良数须关联到判不合格的检验项目' : null;
  const quals = rows.filter((r) => r.item_type === 'QUAL');

  const update = (key: string, patch: Partial<ItemRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const order = rows.flatMap((r) => (r.item_type === 'QUANT' ? r.values.map((_, i) => `${r.key}:${i}`) : []));
  const focusAfter = (k: string) => {
    const i = order.indexOf(k);
    const nextKey = order.slice(i + 1).find((x) => inputs.current.get(x));
    if (nextKey) inputs.current.get(nextKey)?.focus();
    else submitBtn.current?.focus();
  };
  const allQualPass = () => setRows((rs) => rs.map((r) => (r.item_type === 'QUAL' && !r.result ? { ...r, result: 'PASS', checked: true } : r)));

  const submit = async () => {
    if (rows.some((r) => !r.name.trim())) {
      message.warning('请填写自定义检验项目的名称');
      return;
    }
    if (incomplete.length) {
      message.warning(`还有 ${incomplete.length} 项未完成：${incomplete.map((x) => `${x.r.name}（${x.j.missing}）`).join('、')}`);
      return;
    }
    if (defectErr) {
      message.warning(`样本不良数${defectErr}`);
      return;
    }
    const label = dictLabel('insp_status', preview);
    const consequence = preview === 'REJECTED' ? '库存将转为“不合格”并自动开具 NCR。' : '库存将转为“合格”（接收），可被生产领用。';
    const body = {
      defect_qty: defectQty,
      items: rows.map((r) => ({
        id: r.id, name: r.name.trim(), standard: r.standard || null, value: r.value || null,
        ...(r.item_type === 'QUANT'
          ? { sample_values: numsOf(r), item_type: 'QUANT', lower: r.lower, upper: r.upper, unit: r.unit }
          : { checked: true, result: r.result, defect_qty: r.result === 'FAIL' ? r.defects : 0, item_type: 'QUAL' }),
      })),
      concession: preview === 'CONCESSION',
      remark: remark || undefined,
    };
    try {
      setSubmitting(true);
      const r = await sign({
        meaning: preview === 'CONCESSION' ? 'IQC让步接收批准' : `IQC检验判定：${label}`,
        description: `${insp.no} 判定：${label}（AQL 抽样 n=${insp.sample_size}，不良 ${defectQty} 件，Ac=${ac}）。${reasons.length ? `判退原因：${reasons.join('；')}。` : ''}${consequence}`,
        defaultReason: remark || undefined,
        submit: (signature) => post(`/inspections/${id}/submit`, { ...body, signature }, true),
      });
      const next = await get('/inspections/next', { after: insp.id, type: insp.insp_type }, true).catch(() => ({ next: null, pending: 0 }));
      const full = await get(`/inspections/${id}`).catch(() => r);
      setInsp(full);
      setRows(toRows(full.items, need, false));
      setDone({ next: next.next, pending: next.pending });
      message.success('检验结果已提交');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      if (!isCancel(e)) throw e;
    } finally {
      setSubmitting(false);
    }
  };

  /** 某项的结果标签（编辑中按录入自动判定） */
  const resultTag = (r: ItemRow) => {
    const j = editable ? judge(r, need) : { done: true, result: r.result, defects: r.defects, missing: undefined };
    if (!j.result) return <Tag style={{ marginInlineEnd: 0 }}>{j.missing || '未完成'}</Tag>;
    return (
      <Space size={4} wrap>
        <StatusTag dict="result" value={j.result} />
        {j.result === 'FAIL' && <Typography.Text type="danger" style={{ fontSize: 12 }}>不良 {j.defects} 件</Typography.Text>}
        {editable && !j.done && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{j.missing}</Typography.Text>}
      </Space>
    );
  };

  const itemColumns: any[] = [
    {
      title: '检验项目', dataIndex: 'name', width: 150,
      render: (v: string, r: ItemRow, i: number) => (
        <Space direction="vertical" size={4}>
          {editable && !r.id ? <Input value={v} placeholder="项目名称" onChange={(e) => update(r.key, { name: e.target.value })} /> : <b>{i + 1}. {v}</b>}
          <Space size={4} wrap><Tag color={r.item_type === 'QUANT' ? 'blue' : 'default'} style={{ marginInlineEnd: 0 }}>{r.item_type === 'QUANT' ? '定量' : '定性'}</Tag>{resultTag(r)}</Space>
        </Space>
      ),
    },
    {
      title: '标准 / 要求', dataIndex: 'standard', width: 180,
      render: (v: string, r: ItemRow) => (
        <div style={{ maxWidth: 200 }}>
          {editable && !r.id && r.item_type === 'QUAL' ? <Input value={v} placeholder="判定标准" onChange={(e) => update(r.key, { standard: e.target.value })} /> : <span>{v || '-'}</span>}
          {r.item_type === 'QUANT' && <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>规格 {limitText(r.lower, r.upper, r.unit)}</Typography.Text></div>}
          {r.method && <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>方法：{r.method}</Typography.Text></div>}
        </div>
      ),
    },
    {
      title: '实测 / 判定', key: 'entry',
      render: (_: any, r: ItemRow) => {
        const j = judge(r, need);
        if (r.item_type === 'QUANT') {
          if (!editable) {
            const nums = numsOf(r);
            return (
              <Space direction="vertical" size={2}>
                <Space size={[4, 4]} wrap>
                  {nums.length ? nums.map((x, i) => <Tag key={i} color={isOut(x, r) ? 'red' : undefined} style={{ marginInlineEnd: 0 }}>{g(x)}</Tag>) : <Typography.Text type="secondary">{r.value || '未逐件记录'}</Typography.Text>}
                </Space>
                {nums.length > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{nums.length} 件，最小 {g(Math.min(...nums))} / 最大 {g(Math.max(...nums))}{r.unit ? ` ${r.unit}` : ''}</Typography.Text>}
              </Space>
            );
          }
          return (
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <ValuesInput
                r={r}
                onChange={(values) => update(r.key, { values })}
                register={(i, el) => inputs.current.set(`${r.key}:${i}`, el)}
                onEnter={(i) => focusAfter(`${r.key}:${i}`)}
              />
              <Space size={8} wrap>
                <Button size="small" type="link" style={{ padding: 0 }} icon={<PlusOutlined />} disabled={r.values.length >= (insp.sample_size || 1)}
                  onClick={() => update(r.key, { values: [...r.values, ''] })}>加 1 件</Button>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>至少 {need} 件，回车跳下一格</Typography.Text>
              </Space>
            </Space>
          );
        }
        if (!editable) {
          return <Space direction="vertical" size={2}>{r.value ? <span>{r.value}</span> : null}{!r.checked && <Typography.Text type="secondary" style={{ fontSize: 12 }}>（未逐项记录）</Typography.Text>}</Space>;
        }
        return (
          <Space direction="vertical" size={4}>
            <Radio.Group value={r.result} optionType="button" buttonStyle="solid"
              onChange={(e) => update(r.key, { result: e.target.value, checked: true, defects: e.target.value === 'FAIL' ? Math.max(1, r.defects) : 0 })}
              options={[{ value: 'PASS', label: '合格' }, { value: 'FAIL', label: '不合格' }]} />
            {j.result === 'FAIL' && (
              <Space size={4} wrap>
                <InputNumber size="small" min={0} max={insp.sample_size || undefined} precision={0} value={r.defects} prefix="不良" suffix="件" style={{ width: 120 }}
                  onChange={(v) => update(r.key, { defects: Number(v) || 0 })} />
                <Input size="small" value={r.value} placeholder="不良现象（如：引脚氧化）" style={{ width: 180 }} onChange={(e) => update(r.key, { value: e.target.value })} />
              </Space>
            )}
          </Space>
        );
      },
    },
  ];
  if (editable) {
    itemColumns.push({
      title: '', key: 'del', width: 40,
      render: (_: any, r: ItemRow) => (!r.id ? <Button type="text" danger icon={<DeleteOutlined />} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} /> : null),
    });
  }

  const judgePanel = editable && (
    <Card size="small" title="判定">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div>
          <div style={{ marginBottom: 4 }}>AQL 抽样不良数 <Typography.Text type="secondary" style={{ fontSize: 12 }}>（n={insp.sample_size}，按定性项自动汇总，可修改；定量抽测超限单独判定）</Typography.Text></div>
          <InputNumber min={0} max={insp.sample_size || undefined} precision={0} size="large" style={{ width: '100%' }} status={defectErr ? 'error' : undefined}
            value={defectQty} onChange={(v) => setDefectOverride(v === null ? null : Number(v))} suffix={`/ ${insp.sample_size ?? '-'} 件`} />
          {defectErr && <Typography.Text type="danger" style={{ fontSize: 12 }}>{defectErr}</Typography.Text>}
        </div>
        <Alert
          type={incomplete.length ? 'warning' : accept ? 'success' : 'error'}
          showIcon
          message={<b style={{ fontSize: 16 }}>{incomplete.length ? `已完成 ${rows.length - incomplete.length}/${rows.length} 项` : `预判：${accept ? '合格（接收）' : '不合格（拒收）'}`}</b>}
          description={
            incomplete.length
              ? `未完成：${incomplete.map((x) => `${x.r.name}（${x.j.missing}）`).join('、')}`
              : accept
                ? `AQL 抽样不良 ${defectQty} 件 ≤ Ac ${ac}，且所有检验项目合格。`
                : <span>判退原因：{reasons.map((t, i) => <div key={i}>{i + 1}. {t}</div>)}</span>
          }
        />
        {!accept && !incomplete.length && can('qa') && (
          <Checkbox checked={concession} onChange={(e) => setConcession(e.target.checked)}>
            申请<b>让步接收</b>（QA 批准：库存转合格，并留存已处置 NCR）
          </Checkbox>
        )}
        {!accept && !incomplete.length && !can('qa') && <Typography.Text type="secondary">如需让步接收，请由 QA 在 NCR 中评审处置。</Typography.Text>}
        <Input.TextArea rows={2} value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="检验结论备注（可选）" />
        <Tooltip title={incomplete.length ? '请先完成全部检验项目' : ''}>
          <Button ref={submitBtn} type="primary" size="large" block icon={<SafetyCertificateOutlined />} loading={submitting} disabled={incomplete.length > 0 || !!defectErr}
            danger={preview === 'REJECTED'} onClick={submit}>
            签名提交：判定{dictLabel('insp_status', preview)}
          </Button>
        </Tooltip>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          提交需电子签名（输入密码回车即可）。合格 → 库存自动转为“合格”；不合格 → 自动转入“不合格”并开具 NCR，本单照片随 NCR 一同查看。
        </Typography.Text>
      </Space>
    </Card>
  );

  return (
    <>
      {signHolder}
      <PrintHeader title="来料检验记录（IQC）" no={insp.no} extra={<div>{insp.material_code} {insp.material_name} · 批号 {insp.lot_no || '-'} · {dictLabel('insp_status', insp.status)}</div>} />
      <div className="no-print">
      <PageHeader
        title={<Space wrap>检验单 {insp.no}<StatusTag dict="insp_type" value={insp.insp_type} /><StatusTag dict="insp_status" value={insp.status} /></Space>}
        sub={`${insp.material_code} ${insp.material_name}${insp.material_spec ? ` | ${insp.material_spec}` : ''}`}
        extra={<Space><QPrintButton title={`来料检验单 ${insp.no}`} /><Button icon={<ArrowLeftOutlined />} className="no-print" onClick={() => nav('/quality/inspections')}>返回列表</Button></Space>}
      />
      </div>
      {done && <Card style={{ marginBottom: 16 }}><SubmitResult insp={insp} next={done.next} pending={done.pending} /></Card>}
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
                { key: 'plan', label: '抽样', children: <span style={{ whiteSpace: 'nowrap' }}><b>n={insp.sample_size}</b> · Ac {ac} / Re {insp.reject_num}</span> },
                { key: 'at', label: '到货时间', children: fmtDateTime(insp.created_at) },
                { key: 'by', label: '收货人', children: insp.created_by || '-' },
                ...(insp.status !== 'PENDING'
                  ? [
                    { key: 'ins', label: '检验员', children: insp.inspector || '-' },
                    { key: 'iat', label: '检验时间', children: fmtDateTime(insp.inspected_at) },
                    { key: 'dq', label: '不良数', children: <b style={{ color: insp.defect_qty > ac ? '#cf1322' : undefined }}>{insp.defect_qty}</b> },
                    { key: 'rm', label: '检验结论备注', children: insp.result_remark || '-' },
                    ...(insp.ncrs?.length ? [{ key: 'ncr', label: 'NCR', children: <Space>{insp.ncrs.map((n: Rec) => <Link key={n.id} to={`/quality/ncrs?id=${n.id}`}>{n.no}</Link>)}</Space> }] : []),
                  ]
                  : []),
              ]} />
            </Card>
            <Card
              size="small"
              title={<Space wrap>检验项目
                {editable && <Tag color={incomplete.length ? 'gold' : 'green'}>已完成 {rows.length - incomplete.length}/{rows.length}</Tag>}
                {!editable && <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>建单时保存的检验项目（规范日后修改不影响本单）</Typography.Text>}
              </Space>}
              extra={editable && (
                <Space wrap>
                  {quals.length > 0 && (
                    <Button size="small" type="primary" ghost icon={<CheckOutlined />} disabled={!quals.some((r) => !r.result)} onClick={allQualPass}>
                      其余定性项全部合格
                    </Button>
                  )}
                  <Button size="small" icon={<PlusOutlined />}
                    onClick={() => setRows((rs) => [...rs, { key: `n${Date.now()}`, name: '', standard: '', item_type: 'QUAL', lower: null, upper: null, unit: null, values: [], result: null, defects: 0, value: '', checked: false }])}>
                    添加检验项目
                  </Button>
                </Space>
              )}
            >
              {editable && <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>定量项逐件录入实测值，系统按上下限自动判定（超限标红）；定性项须逐项点选“合格/不合格”，判不合格时填写不良件数。全部完成后才能提交。</Typography.Paragraph>}
              <Table<ItemRow>
                rowKey="key"
                size="middle"
                pagination={false}
                dataSource={rows}
                columns={itemColumns}
                scroll={{ x: 'max-content' }}
                onRow={(r) => {
                  const j = judge(r, need);
                  return { style: j.result === 'FAIL' ? { background: '#fff1f0' } : undefined };
                }}
              />
            </Card>
            <Attachments entity="qms_inspection" entityId={insp.id} title="附件（COA、检验记录、照片）" hint="供应商出厂检验报告（COA）、缺陷照片、测试数据截图等检验证据。平板可直接拍照；不合格时照片会在 NCR 中一并显示。" canUpload={can('qc', 'qa', 'wms')} />
          </Space>
        </Col>
        <Col xs={24} xl={8}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {!narrow && judgePanel}
            <SamplingCard insp={insp} />
            {!editable && insp.status === 'PENDING' && !done && (
              <Alert type="warning" showIcon message="该批待检验" description="只有质量检验员（QC）账号可以录入并提交检验结果。待检物料不能被领用。" />
            )}
            {insp.status !== 'PENDING' && (
              <Card size="small" title="检验结论">
                <Space direction="vertical">
                  <StatusTag dict="insp_status" value={insp.status} />
                  <Typography.Text>不良数 {insp.defect_qty}（Ac {ac} / Re {insp.reject_num}）</Typography.Text>
                  <Typography.Text type="secondary">{insp.inspector} · {fmtDateTime(insp.inspected_at)}</Typography.Text>
                  {insp.ncrs?.map((n: Rec) => <Link key={n.id} to={`/quality/ncrs?id=${n.id}`}>查看 {n.no}</Link>)}
                </Space>
              </Card>
            )}
          </Space>
        </Col>
      </Row>
      {narrow && editable && <div style={{ marginTop: 16 }}>{judgePanel}</div>}
      <QPrintSignatures roles={['检验员', 'QA 审核']} />
      {narrow && editable && (
        <div className="no-print" style={{
          position: 'sticky', bottom: 0, zIndex: 10, marginTop: 12, padding: '10px 12px', background: '#fff', borderTop: '1px solid #f0f0f0',
          boxShadow: '0 -2px 8px rgba(0,0,0,0.06)', display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap',
        }}>
          <span>
            {incomplete.length
              ? <Tag color="gold">已完成 {rows.length - incomplete.length}/{rows.length} 项</Tag>
              : <Tag color={accept ? 'green' : 'red'} style={{ fontSize: 14, padding: '2px 8px' }}>预判：{accept ? '合格' : '不合格'}</Tag>}
            <Typography.Text type="secondary">
              {!incomplete.length && !accept ? `判退：${reasons.map((t) => t.split('：')[0]).join('、')}` : `AQL 不良 ${defectQty} / Ac ${ac}`}
              {quantFails.length > 0 && ` · 定量超限 ${quantFails.reduce((s2, x) => s2 + x.j.defects, 0)} 件`}
            </Typography.Text>
          </span>
          <Button type="primary" size="large" icon={<SafetyCertificateOutlined />} loading={submitting} disabled={incomplete.length > 0 || !!defectErr} danger={preview === 'REJECTED'} onClick={submit}>
            签名提交：{dictLabel('insp_status', preview)}
          </Button>
        </div>
      )}
    </>
  );
}
