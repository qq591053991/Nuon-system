import { Alert, Button, Card, Col, Row, Space, Steps, Table, Tag, Typography, Upload, message, type UploadProps } from 'antd';
import { CheckCircleFilled, CloudUploadOutlined, DownloadOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { download, http, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';

type Entity = 'customers' | 'suppliers' | 'materials' | 'boms' | 'stock';

interface ImportResult { ok: boolean; created: number; updated: number; errors: { row: number; message: string }[]; message?: string; file: string }

interface EntityDef {
  key: Entity;
  step: number;
  title: string;
  desc: string;
  columns: string[];
  note?: string;
}

const ENTITIES: EntityDef[] = [
  {
    key: 'suppliers', step: 0, title: '供应商',
    desc: '按“供应商编码”新增或更新。状态列填“合格 / 待评 / 暂停”。',
    columns: ['供应商编码', '供应商名称', '简称', '供应类别', '联系人', '电话', '地址', '状态', '备注'],
  },
  {
    key: 'customers', step: 0, title: '客户',
    desc: '按“客户编码”新增或更新。代工客户可填写注册人（医疗器械注册证持有人）。',
    columns: ['客户编码', '客户名称', '简称', '国家', '联系人', '电话', '地址', '税号', '币别', '注册人', '备注'],
  },
  {
    key: 'materials', step: 1, title: '物料',
    desc: '按“物料编码”新增或更新。物料属性可填 原材料/外购、半成品/委外、成品/自制、包材、辅料。',
    columns: ['物料编码', '物料名称', '规格型号', '物料属性', '基本单位', '安全库存', '采购提前期', '标准成本', '保质期(天)', '启用批号管理', '启用序列号管理', '默认供应商', '来料检验', '波长(nm)', '湿敏等级', '备注'],
    note: '“默认供应商”填供应商编码或名称，需先导入供应商。',
  },
  {
    key: 'boms', step: 2, title: 'BOM',
    desc: '每行一个子项，按“父项编码 + 版本”分组生成 BOM。用量支持金蝶的 分子/分母 写法。',
    columns: ['父项物料编码', 'BOM版本', '子项物料编码', '用量', '用量:分母', '损耗率', '位号'],
    note: '导入后为“草稿”，需工程审核发布后才能用于生产；已存在的同版本 BOM 不会被覆盖。',
  },
  {
    key: 'stock', step: 3, title: '期初库存',
    desc: '系统上线时的现有库存，按批号记账，直接记为“合格”。',
    columns: ['物料编码', '库位编码', '批号', '数量', '生产日期', '有效期至'],
    note: '需先在“基础资料 → 仓库 / 库位”中建好库位；客供料按物料主数据的货主自动入账。',
  },
];

const STEP_ITEMS = [
  { title: '供应商 / 客户', description: '往来单位' },
  { title: '物料', description: '编码、规格、属性' },
  { title: 'BOM', description: '父项 + 子项 + 用量' },
  { title: '期初库存', description: '物料 + 库位 + 批号' },
];

function ResultView({ r }: { r: ImportResult }) {
  if (r.ok) {
    return (
      <Alert
        type="success"
        showIcon
        message={`导入成功：新增 ${r.created} 条${r.updated ? `，更新 ${r.updated} 条` : ''}`}
        description={<Typography.Text type="secondary" style={{ fontSize: 12 }}>文件：{r.file}</Typography.Text>}
      />
    );
  }
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Alert type="error" showIcon message={r.message || `发现 ${r.errors.length} 行错误，已全部回滚`} description={<Typography.Text type="secondary" style={{ fontSize: 12 }}>文件：{r.file}。请按下表修正后重新上传整个文件。</Typography.Text>} />
      <Table
        rowKey={(e) => `${e.row}-${e.message}`}
        size="small"
        dataSource={r.errors}
        pagination={r.errors.length > 10 ? { pageSize: 10, size: 'small' } : false}
        columns={[
          { title: 'Excel 行号', dataIndex: 'row', width: 90 },
          { title: '错误原因', dataIndex: 'message', render: (v) => <Typography.Text type="danger">{v}</Typography.Text> },
        ]}
      />
    </Space>
  );
}

function ImportCard({ def, canImport, onSuccess }: { def: EntityDef; canImport: boolean; onSuccess: (e: Entity) => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const customRequest: UploadProps['customRequest'] = ({ file, onSuccess: ok, onError }) => {
    const f = file as File;
    const fd = new FormData();
    fd.append('file', f);
    setBusy(true);
    setResult(null);
    http
      .post(`/import/${def.key}`, fd)
      .then((resp) => {
        const d: Rec = resp.data;
        const r: ImportResult = { ok: !!d.ok, created: d.created || 0, updated: d.updated || 0, errors: d.errors || [], message: d.message, file: f.name };
        setResult(r);
        if (r.ok) {
          message.success(`${def.title}导入成功`);
          onSuccess(def.key);
        }
        ok?.(d);
      })
      .catch((e) => onError?.(e))
      .finally(() => setBusy(false));
  };

  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={(
        <Space>
          <Tag color="purple" style={{ marginInlineEnd: 0 }}>第 {def.step + 1} 步</Tag>
          <span>{def.title}</span>
          {result?.ok && <CheckCircleFilled style={{ color: '#52c41a' }} />}
        </Space>
      )}
      extra={<Button size="small" type="link" icon={<DownloadOutlined />} onClick={() => download(`/import/templates/${def.key}`, `${def.key}_template.xlsx`)}>下载模板</Button>}
    >
      <Typography.Paragraph style={{ marginBottom: 8 }}>{def.desc}</Typography.Paragraph>
      <div style={{ marginBottom: 8 }}>
        {def.columns.map((c) => <Tag key={c} style={{ marginBottom: 4 }}>{c}</Tag>)}
      </div>
      {def.note && <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>注：{def.note}</Typography.Paragraph>}
      <Upload accept=".xlsx,.csv" showUploadList={false} customRequest={customRequest} disabled={!canImport || busy}>
        <Button type="primary" icon={<CloudUploadOutlined />} loading={busy} disabled={!canImport}>
          {busy ? '正在导入…' : `上传${def.title}文件`}
        </Button>
      </Upload>
      {!canImport && <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>需要主数据 / 工程 / 仓储权限</Typography.Text>}
      {result && <div style={{ marginTop: 12 }}><ResultView r={result} /></div>}
    </Card>
  );
}

export default function DataImport() {
  const { can } = useAuth();
  const canImport = can('master', 'engineering', 'wms');
  const [done, setDone] = useState<Set<Entity>>(new Set());

  const stepDone = (step: number) => ENTITIES.filter((e) => e.step === step).some((e) => done.has(e.key));
  const current = STEP_ITEMS.findIndex((_, i) => !stepDone(i));

  return (
    <>
      <PageHeader title="数据导入（从金蝶迁移）" sub="把金蝶中的基础资料与期初库存一次性导入，按顺序 4 步完成。" />
      <Card style={{ marginBottom: 16 }}>
        <Steps
          current={current < 0 ? STEP_ITEMS.length : current}
          items={STEP_ITEMS.map((s, i) => ({ ...s, status: stepDone(i) ? 'finish' : i === current ? 'process' : 'wait' }))}
        />
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 20 }}
          message="列名兼容金蝶 K/3 Cloud / 星空的导出格式"
          description={(
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>在金蝶中“引出”Excel 后可直接上传：系统识别 编码 / 名称 / 规格型号 / 物料属性 / 基本单位 等常见列名（也可下载模板填写）。</li>
              <li>支持 .xlsx 与 .csv（UTF-8 或 GBK）；文件顶部的标题行会被自动跳过。</li>
              <li>按编码“有则更新、无则新增”，可重复导入。</li>
              <li><b>任意一行出错，整个文件全部回滚</b>，不会产生“导入一半”的脏数据；按错误清单修正后重新上传即可。</li>
            </ul>
          )}
        />
      </Card>
      <Row gutter={[16, 16]}>
        {ENTITIES.map((def) => (
          <Col key={def.key} xs={24} lg={12} xxl={8}>
            <ImportCard def={def} canImport={canImport} onSuccess={(e) => setDone((s) => new Set(s).add(e))} />
          </Col>
        ))}
      </Row>
    </>
  );
}
