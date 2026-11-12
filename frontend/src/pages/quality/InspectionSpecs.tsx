import { Alert, Button, Card, Col, Collapse, Descriptions, Empty, Input, InputNumber, List, Row, Select, Space, Spin, Table, Tag, Typography, message } from 'antd';
import { CopyOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined, SafetyCertificateOutlined, UndoOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import { isCancel, useESign } from '../../components/ESign';
import PageHeader from '../../components/PageHeader';
import RemoteSelect from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { fmtDateTime } from '../../utils/format';
import { putSilent } from './qshared';

interface Row {
  key: string;
  id?: number;
  seq: number;
  name: string;
  standard: string;
  method: string;
  item_type: 'QUAL' | 'QUANT';
  lower: number | null;
  upper: number | null;
  unit: string;
}

const toRows = (items: Rec[] = []): Row[] =>
  items.map((i) => ({
    key: `i${i.id}`, id: i.id, seq: i.seq, name: i.name ?? '', standard: i.standard ?? '', method: i.method ?? '',
    item_type: i.item_type === 'QUANT' ? 'QUANT' : 'QUAL', lower: i.lower ?? null, upper: i.upper ?? null, unit: i.unit ?? '',
  }));

/** 检验规范：按物料维护 IQC 检验项目（受控：保存需 QA/工程电子签名），IQC 建单时按规范生成检验项目 */
export default function InspectionSpecs() {
  const { can } = useAuth();
  const canEdit = can('qa', 'engineering');
  const [sign, signHolder] = useESign();
  const [sp, setSp] = useSearchParams();
  const materialId = sp.get('material_id') ? Number(sp.get('material_id')) : undefined;
  const [specs, setSpecs] = useState<Rec[]>([]);
  const [specQ, setSpecQ] = useState('');
  const [data, setData] = useState<Rec | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editable = canEdit && !data?.exempt;

  const loadSpecs = useCallback(() => {
    get<Rec[]>('/inspection-specs', { q: specQ || undefined }).then(setSpecs).catch(() => undefined);
  }, [specQ]);
  useEffect(loadSpecs, [loadSpecs]);

  const apply = (d: Rec) => {
    setData(d);
    setRows(toRows(d.items));
    setDirty(false);
  };

  useEffect(() => {
    if (!materialId) {
      setData(null);
      setRows([]);
      return;
    }
    setLoading(true);
    get(`/materials/${materialId}/inspection-items`)
      .then(apply)
      .finally(() => setLoading(false));
  }, [materialId]);

  const pick = (id?: number) => {
    if (dirty && !window.confirm('当前修改尚未保存，确定切换物料？')) return;
    const next = new URLSearchParams(sp);
    if (id) next.set('material_id', String(id));
    else next.delete('material_id');
    setSp(next, { replace: true });
  };

  const update = (key: string, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const nextSeq = () => (rows.length ? Math.max(...rows.map((r) => r.seq || 0)) + 10 : 10);
  const addRow = () => {
    setRows((rs) => [...rs, { key: `n${Date.now()}`, seq: nextSeq(), name: '', standard: '', method: '', item_type: 'QUAL', lower: null, upper: null, unit: '' }]);
    setDirty(true);
  };
  const copyDefaults = () => {
    setRows((data?.default_items || []).map((d: Rec, i: number) => ({
      key: `d${i}${Date.now()}`, seq: (i + 1) * 10, name: d.name, standard: d.standard ?? '', method: d.method ?? '',
      item_type: d.item_type === 'QUANT' ? 'QUANT' : 'QUAL', lower: d.lower ?? null, upper: d.upper ?? null, unit: d.unit ?? '',
    })));
    setDirty(true);
  };

  const save = async () => {
    const bad = rows.find((r) => !r.name.trim());
    if (bad) {
      message.warning('请填写所有检验项目的名称');
      return;
    }
    const names = rows.map((r) => r.name.trim());
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) {
      message.warning(`检验项目“${dup}”重复`);
      return;
    }
    const q = rows.find((r) => r.item_type === 'QUANT' && r.lower === null && r.upper === null);
    if (q) {
      message.warning(`定量项“${q.name}”请填写下限或上限`);
      return;
    }
    const inv = rows.find((r) => r.item_type === 'QUANT' && r.lower !== null && r.upper !== null && r.lower > r.upper);
    if (inv) {
      message.warning(`定量项“${inv.name}”的下限大于上限`);
      return;
    }
    setSaving(true);
    try {
      const d = await sign({
        meaning: '检验规范批准',
        description: rows.length
          ? `${data!.doc_no}（${data!.material_code} ${data!.material_name}）：共 ${rows.length} 个检验项目，批准后升为 ${data!.version ? `A${Number(String(data!.version).slice(1)) + 1}` : 'A0'} 版；之后新建的 IQC 检验单按本规范生成检验项目。`
          : `${data!.material_code} ${data!.material_name}：清空检验规范，之后的 IQC 检验单使用系统默认模板。`,
        reasonRequired: true,
        reasonLabel: '修订说明',
        reasonPlaceholder: '如：增加峰值波长定量检验，上下限按规格书 660±5nm',
        submit: (signature) => putSilent(`/materials/${data!.material_id}/inspection-items`, {
          items: [...rows].sort((a, b) => a.seq - b.seq).map((r) => ({
            id: r.id ?? null, seq: r.seq, name: r.name.trim(), standard: r.standard.trim() || null, method: r.method.trim() || null,
            item_type: r.item_type, lower: r.item_type === 'QUANT' ? r.lower : null, upper: r.item_type === 'QUANT' ? r.upper : null,
            unit: r.item_type === 'QUANT' ? r.unit.trim() || null : null,
          })),
          signature,
        }),
      });
      apply(d);
      loadSpecs();
      message.success(`检验规范已批准生效（${d.doc_no} ${d.version}）`);
    } catch (e) {
      if (!isCancel(e)) throw e;
    } finally {
      setSaving(false);
    }
  };

  const num = (v: number | null, r: Row, k: 'lower' | 'upper') => (editable
    ? <InputNumber value={v} disabled={r.item_type !== 'QUANT'} style={{ width: 90 }} placeholder={r.item_type === 'QUANT' ? (k === 'lower' ? '下限' : '上限') : '-'}
      onChange={(x) => update(r.key, { [k]: x === null ? null : Number(x) } as Partial<Row>)} />
    : r.item_type === 'QUANT' ? (v ?? '-') : '-');
  const columns: any[] = [
    {
      title: '序号', dataIndex: 'seq', width: 80,
      render: (v: number, r: Row) => (editable ? <InputNumber min={0} max={9999} precision={0} value={v} style={{ width: 64 }} onChange={(x) => update(r.key, { seq: Number(x) || 0 })} /> : v),
    },
    {
      title: '检验项目', dataIndex: 'name', width: 160,
      render: (v: string, r: Row) => (editable ? <Input value={v} maxLength={64} placeholder="如：外观" onChange={(e) => update(r.key, { name: e.target.value })} /> : <b>{v}</b>),
    },
    {
      title: '类型', dataIndex: 'item_type', width: 110,
      render: (v: string, r: Row) => (editable
        ? <Select value={v} style={{ width: 96 }} onChange={(x) => update(r.key, { item_type: x as Row['item_type'] })} options={[{ value: 'QUAL', label: '定性' }, { value: 'QUANT', label: '定量' }]} />
        : <StatusTag dict="insp_item_type" value={v} />),
    },
    {
      title: '标准 / 要求', dataIndex: 'standard',
      render: (v: string, r: Row) => (editable ? <Input value={v} maxLength={256} placeholder={r.item_type === 'QUANT' ? '如：峰值波长 660±5nm' : '判定标准，如：无破损、无氧化'} onChange={(e) => update(r.key, { standard: e.target.value })} /> : v || '-'),
    },
    { title: '下限', dataIndex: 'lower', width: 100, render: (v: number | null, r: Row) => num(v, r, 'lower') },
    { title: '上限', dataIndex: 'upper', width: 100, render: (v: number | null, r: Row) => num(v, r, 'upper') },
    {
      title: '单位', dataIndex: 'unit', width: 80,
      render: (v: string, r: Row) => (editable ? <Input value={v} maxLength={16} disabled={r.item_type !== 'QUANT'} placeholder={r.item_type === 'QUANT' ? 'nm' : '-'} onChange={(e) => update(r.key, { unit: e.target.value })} /> : v || '-'),
    },
    {
      title: '检验方法 / 工具', dataIndex: 'method', width: 200,
      render: (v: string, r: Row) => (editable ? <Input value={v} maxLength={128} placeholder="如：光谱仪逐件测量" onChange={(e) => update(r.key, { method: e.target.value })} /> : v || '-'),
    },
  ];
  if (editable) {
    columns.push({
      title: '', key: 'del', width: 48,
      render: (_: any, r: Row) => (
        <Button type="text" danger icon={<DeleteOutlined />} onClick={() => { setRows((rs) => rs.filter((x) => x.key !== r.key)); setDirty(true); }} />
      ),
    });
  }

  const sorted = [...rows].sort((a, b) => a.seq - b.seq);

  return (
    <>
      {signHolder}
      <PageHeader title="检验规范" sub="按物料维护来料检验（IQC）项目、标准与方法。定量项填上下限，检验时逐件录入实测值自动判定；定性项由检验员逐项确认。未维护的物料使用系统默认模板（标准取自物料规格）。" />
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="检验规范是受控文件（编号 IQC-SPEC-物料编码，每次批准升一版）：修改需 QA 或工程人员电子签名并填写修订说明；只影响之后新建的检验单，已建检验单保留建单时的项目。免检物料、成品、半成品不做来料检验，不能维护。"
      />
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={7}>
          <Card size="small" title="选择物料" extra={<Button size="small" icon={<ReloadOutlined />} onClick={loadSpecs} />}>
            <RemoteSelect url="/inspection-specs/materials" noun="需检验物料" style={{ width: '100%' }} value={materialId} onChange={(v) => pick(v as number | undefined)}
              placeholder="输入物料编码或名称（仅列需来料检验的物料）" labelOf={(r) => `${r.code} ${r.name}`} />
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '12px 0 8px' }}>已维护检验规范的物料（{specs.length}）</Typography.Paragraph>
            <Input.Search allowClear size="small" placeholder="筛选" onSearch={setSpecQ} style={{ marginBottom: 8 }} />
            <List
              size="small"
              dataSource={specs}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无，全部使用默认模板" /> }}
              renderItem={(s) => (
                <List.Item
                  style={{ cursor: 'pointer', background: s.material_id === materialId ? '#e6f4ff' : undefined, paddingInline: 8 }}
                  onClick={() => pick(s.material_id)}
                  extra={<Tag>{s.item_count} 项</Tag>}
                >
                  <List.Item.Meta
                    title={<span className="mono">{s.material_code}</span>}
                    description={<span style={{ fontSize: 12 }}>{s.material_name} · {s.version ?? '-'} 版 · {fmtDateTime(s.updated_at)}</span>}
                  />
                </List.Item>
              )}
            />
          </Card>
        </Col>
        <Col xs={24} lg={17}>
          {!materialId ? (
            <Card><Empty description="请在左侧选择物料" /></Card>
          ) : loading || !data ? (
            <Card><div style={{ textAlign: 'center', padding: 40 }}><Spin /></div></Card>
          ) : (
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Card size="small">
                <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }} items={[
                  { key: 'm', label: '物料', children: <b>{data.material_code} {data.material_name}</b> },
                  { key: 's', label: '规格', children: data.material_spec || '-' },
                  { key: 'c', label: '类别', children: <StatusTag dict="material_category" value={data.category} /> },
                  { key: 'aql', label: 'AQL', children: data.aql ?? '-' },
                  { key: 'iqc', label: '来料检验', children: data.iqc_required ? <Tag color="blue">需检验</Tag> : <Tag>免检</Tag> },
                  { key: 'src', label: '当前依据', children: data.using_default ? <Tag color="gold">系统默认模板</Tag> : <Tag color="green">物料检验规范（{data.items.length} 项）</Tag> },
                  { key: 'doc', label: '文件编号 / 版本', children: <span className="mono">{data.doc_no} {data.version ? <Tag color="blue">{data.version}</Tag> : <Tag>未发布</Tag>}</span> },
                  { key: 'ap', label: '批准', children: data.approved_by ? `${data.approved_by} ${fmtDateTime(data.approved_at)}` : '-' },
                ]} />
                {data.history?.length > 0 && (
                  <Collapse size="small" style={{ marginTop: 12 }} items={[{
                    key: 'h', label: `修订历史（${data.history.length}）`,
                    children: <Table rowKey="version" size="small" pagination={false} dataSource={data.history} columns={[
                      { title: '版本', dataIndex: 'version', width: 70 }, { title: '批准人', dataIndex: 'full_name', width: 90 },
                      { title: '时间', dataIndex: 'ts', width: 150, render: (v: string) => fmtDateTime(v) }, { title: '修订说明', dataIndex: 'reason', render: (v: string) => v || '-' },
                    ]} />,
                  }]} />
                )}
                {data.exempt && (
                  <Alert type="warning" showIcon style={{ marginTop: 12 }} message="该物料不做来料检验（免检、成品或半成品），不能维护来料检验规范。如需检验，请先在物料主数据中开启“需来料检验”。" />
                )}
              </Card>
              <Card
                size="small"
                title={<Space>检验项目{dirty && <Tag color="orange">未保存</Tag>}</Space>}
                extra={editable && (
                  <Space wrap>
                    {data.using_default && rows.length === 0 && <Button size="small" icon={<CopyOutlined />} onClick={copyDefaults}>以默认模板为起点</Button>}
                    <Button size="small" icon={<PlusOutlined />} onClick={addRow}>添加检验项目</Button>
                    {dirty && <Button size="small" icon={<UndoOutlined />} onClick={() => { setRows(toRows(data.items)); setDirty(false); }}>撤销修改</Button>}
                    <Button size="small" type="primary" icon={<SafetyCertificateOutlined />} loading={saving} disabled={!dirty} onClick={save}>签名批准</Button>
                  </Space>
                )}
              >
                {rows.length === 0 && data.using_default ? (
                  <>
                    <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="该物料尚未维护检验规范，IQC 使用以下系统默认模板。" />
                    <Table rowKey="name" size="small" pagination={false} dataSource={data.default_items}
                      columns={[
                        { title: '默认检验项目', dataIndex: 'name', width: 160 }, { title: '类型', dataIndex: 'item_type', width: 70, render: (v: string) => <StatusTag dict="insp_item_type" value={v} /> },
                        { title: '标准 / 要求', dataIndex: 'standard' },
                        { title: '上下限', key: 'lim', render: (_: any, r: Rec) => (r.item_type === 'QUANT' ? `${r.lower ?? ''} ~ ${r.upper ?? ''} ${r.unit ?? ''}` : '-') },
                        { title: '方法', dataIndex: 'method', render: (v: string) => v || '-' },
                      ]} />
                  </>
                ) : (
                  <Table<Row> rowKey="key" size="middle" pagination={false} dataSource={editable ? rows : sorted} columns={columns} scroll={{ x: 'max-content' }} />
                )}
                {!canEdit && <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12 }}>只有 QA 或工程人员可以修改检验规范。</Typography.Paragraph>}
              </Card>
            </Space>
          )}
        </Col>
      </Row>
    </>
  );
}
