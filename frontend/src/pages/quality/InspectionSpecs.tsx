import { Alert, Button, Card, Col, Descriptions, Empty, Input, InputNumber, List, Row, Space, Spin, Table, Tag, Typography, message } from 'antd';
import { CopyOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined, SafetyCertificateOutlined, UndoOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, put, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import { isCancel, useESign } from '../../components/ESign';
import PageHeader from '../../components/PageHeader';
import { MaterialSelect } from '../../components/RemoteSelect';
import StatusTag from '../../components/StatusTag';
import { fmtDateTime } from '../../utils/format';

interface Row {
  key: string;
  id?: number;
  seq: number;
  name: string;
  standard: string;
  method: string;
}

const toRows = (items: Rec[] = []): Row[] =>
  items.map((i) => ({ key: `i${i.id}`, id: i.id, seq: i.seq, name: i.name ?? '', standard: i.standard ?? '', method: i.method ?? '' }));

/** 检验规范：按物料维护 IQC 检验项目（受控：保存需 QA/工程电子签名），IQC 建单时按规范生成检验项目 */
export default function InspectionSpecs() {
  const { can } = useAuth();
  const editable = can('qa', 'engineering');
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
    setRows((rs) => [...rs, { key: `n${Date.now()}`, seq: nextSeq(), name: '', standard: '', method: '' }]);
    setDirty(true);
  };
  const copyDefaults = () => {
    setRows((data?.default_items || []).map((d: Rec, i: number) => ({ key: `d${i}${Date.now()}`, seq: (i + 1) * 10, name: d.name, standard: d.standard ?? '', method: '' })));
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
    try {
      const signature = await sign({
        meaning: '检验规范批准',
        description: rows.length
          ? `${data!.material_code} ${data!.material_name}：共 ${rows.length} 个检验项目。批准后，之后新建的 IQC 检验单按本规范生成检验项目。`
          : `${data!.material_code} ${data!.material_name}：清空检验规范，之后的 IQC 检验单使用系统默认模板。`,
      });
      setSaving(true);
      const d = await put(`/materials/${data!.material_id}/inspection-items`, {
        items: [...rows].sort((a, b) => a.seq - b.seq).map((r) => ({ id: r.id ?? null, seq: r.seq, name: r.name.trim(), standard: r.standard.trim() || null, method: r.method.trim() || null })),
        signature,
      });
      apply(d);
      loadSpecs();
      message.success('检验规范已批准生效');
    } catch (e) {
      if (!isCancel(e)) throw e;
    } finally {
      setSaving(false);
    }
  };

  const columns: any[] = [
    {
      title: '序号', dataIndex: 'seq', width: 90,
      render: (v: number, r: Row) => (editable ? <InputNumber min={0} max={9999} precision={0} value={v} style={{ width: 72 }} onChange={(x) => update(r.key, { seq: Number(x) || 0 })} /> : v),
    },
    {
      title: '检验项目', dataIndex: 'name', width: 180,
      render: (v: string, r: Row) => (editable ? <Input value={v} maxLength={64} placeholder="如：外观" onChange={(e) => update(r.key, { name: e.target.value })} /> : <b>{v}</b>),
    },
    {
      title: '标准 / 要求', dataIndex: 'standard',
      render: (v: string, r: Row) => (editable ? <Input value={v} maxLength={256} placeholder="判定标准，如：峰值波长 660±5nm" onChange={(e) => update(r.key, { standard: e.target.value })} /> : v || '-'),
    },
    {
      title: '检验方法 / 工具', dataIndex: 'method', width: 220,
      render: (v: string, r: Row) => (editable ? <Input value={v} maxLength={128} placeholder="如：光谱仪抽测 5 件" onChange={(e) => update(r.key, { method: e.target.value })} /> : v || '-'),
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
      <PageHeader title="检验规范" sub="按物料维护来料检验（IQC）项目、标准与方法。IQC 检验单按规范自动生成检验项目；未维护的物料使用系统默认模板。" />
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="检验规范是受控文件：修改需 QA 或工程人员电子签名批准，变更记入审计追踪；只影响之后新建的检验单，已建检验单保留建单时的项目。"
      />
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={7}>
          <Card size="small" title="选择物料" extra={<Button size="small" icon={<ReloadOutlined />} onClick={loadSpecs} />}>
            <MaterialSelect style={{ width: '100%' }} value={materialId} onChange={(v) => pick(v as number | undefined)} placeholder="输入物料编码或名称" />
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
                    description={<span style={{ fontSize: 12 }}>{s.material_name} · {fmtDateTime(s.updated_at)}</span>}
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
                ]} />
                {!data.iqc_required && (
                  <Alert type="warning" showIcon style={{ marginTop: 12 }} message="该物料在主数据中设置为免检（收货直接合格），检验规范不会被使用。如需检验，请先在物料主数据中开启“需来料检验”。" />
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
                      columns={[{ title: '默认检验项目', dataIndex: 'name', width: 180 }, { title: '标准 / 要求', dataIndex: 'standard' }]} />
                  </>
                ) : (
                  <Table<Row> rowKey="key" size="middle" pagination={false} dataSource={editable ? rows : sorted} columns={columns} scroll={{ x: 'max-content' }} />
                )}
                {!editable && <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12 }}>只有 QA 或工程人员可以修改检验规范。</Typography.Paragraph>}
              </Card>
            </Space>
          )}
        </Col>
      </Row>
    </>
  );
}
