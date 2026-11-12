import {
  Alert, Button, Card, Col, Input, Modal, Popover, Radio, Result, Row, Space, Steps, Switch, Table, Tag, Tooltip, Typography, Upload, message, type UploadProps,
} from 'antd';
import {
  CheckCircleFilled, CloudUploadOutlined, DownloadOutlined, FileSearchOutlined, InfoCircleOutlined, LockOutlined, ReloadOutlined, RollbackOutlined, UnlockOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { download, get, http, post, type Rec } from '../../api/http';
import { useAuth } from '../../auth';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import { fmtDateTime } from '../../utils/format';

export interface ImportColumn { field: string; header: string; aliases: string[]; required: boolean; note: string | null; options: string[] | null }
export interface ImportEntity {
  key: string; title: string; desc: string; perms: { code: string; name: string }[];
  can_import: boolean; via_migration: boolean; reason: string | null; count: number; columns: ImportColumn[];
}
export interface ImportOptions { migration_mode: boolean; is_admin: boolean; entities: ImportEntity[] }

export interface ImportResult {
  ok: boolean; check?: boolean; total?: number; created: number; updated: number; unchanged?: number;
  errors: { row: number; message: string }[]; message?: string; batch_no?: string | null;
  duplicates?: { row: number; material_code: string; location_code: string; lot_no: string; current_qty: number; new_qty: number; prior_batch: string | null }[];
  passwords?: Rec[];
}

/** 列说明：必填红色 *；悬停看说明与可选值 */
export function ColumnTags({ columns }: { columns: ImportColumn[] }) {
  return (
    <div style={{ lineHeight: '26px' }}>
      {columns.map((c) => {
        const tip = [c.required ? '必填' : '选填', c.note, c.options ? `可选：${c.options.join('、')}` : null, c.aliases.length ? `也可识别：${c.aliases.join('、')}` : null]
          .filter(Boolean).join('；');
        return (
          <Tooltip key={c.field} title={tip}>
            <Tag color={c.required ? 'red' : undefined} style={{ marginBottom: 4, cursor: 'help' }}>
              {c.required && '*'}{c.header}{c.options && <span style={{ opacity: 0.6 }}> ▾</span>}
            </Tag>
          </Tooltip>
        );
      })}
    </div>
  );
}

function ErrorTable({ errors }: { errors: ImportResult['errors'] }) {
  return (
    <Table
      rowKey={(e) => `${e.row}-${e.message}`}
      size="small"
      dataSource={errors}
      pagination={errors.length > 8 ? { pageSize: 8, size: 'small' } : false}
      columns={[
        { title: 'Excel 行号', dataIndex: 'row', width: 90 },
        { title: '哪里错了 / 怎么改', dataIndex: 'message', render: (v) => <Typography.Text type="danger">{v}</Typography.Text> },
      ]}
    />
  );
}

/**
 * 导入流程（数据导入页与“批量导入用户”共用）：选择文件 → 自动预检查（不写入）→ 确认导入 → 结果。
 * 期初库存可选“已有库存时：报错 / 覆盖为导入数”。
 */
export function ImportFlow({ entity, title, disabled, disabledReason, onImported, renderSuccess }: {
  entity: string; title: string; disabled?: boolean; disabledReason?: ReactNode;
  onImported?: (r: ImportResult) => void; renderSuccess?: (r: ImportResult) => ReactNode;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<'check' | 'import' | null>(null);
  const [check, setCheck] = useState<ImportResult | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dup, setDup] = useState<'error' | 'overwrite'>('error');
  const isStock = entity === 'stock';

  const send = async (f: File, mode: 'check' | 'import', onDup = dup): Promise<ImportResult> => {
    const fd = new FormData();
    fd.append('file', f);
    fd.append('mode', mode);
    if (isStock) fd.append('on_duplicate', onDup);
    const resp = await http.post(`/import/${entity}`, fd);
    return resp.data as ImportResult;
  };

  const runCheck = async (f: File, onDup = dup) => {
    setBusy('check');
    setResult(null);
    setCheck(null);
    try {
      setCheck(await send(f, 'check', onDup));
    } finally {
      setBusy(null);
    }
  };

  const customRequest: UploadProps['customRequest'] = ({ file: f, onSuccess }) => {
    setFile(f as File);
    void runCheck(f as File).finally(() => onSuccess?.({}));
  };

  const doImport = async () => {
    if (!file) return;
    setBusy('import');
    try {
      const r = await send(file, 'import');
      setResult(r);
      setCheck(null);
      if (r.ok) {
        message.success(`${title}导入成功`);
        onImported?.(r);
      }
    } finally {
      setBusy(null);
    }
  };

  const reset = () => {
    setFile(null);
    setCheck(null);
    setResult(null);
  };

  const changeDup = (v: 'error' | 'overwrite') => {
    setDup(v);
    if (file && check) void runCheck(file, v);
  };

  if (disabled) {
    return <Typography.Text type="secondary"><LockOutlined style={{ marginRight: 6 }} />当前账号不能导入：{disabledReason}</Typography.Text>;
  }

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      {isStock && (
        <div>
          <Typography.Text type="secondary">同一物料 + 库位 + 批号已有库存时：</Typography.Text>
          <Radio.Group size="small" value={dup} onChange={(e) => changeDup(e.target.value)} style={{ marginTop: 4 }}>
            <Radio value="error">报错（防止重复导入，推荐）</Radio>
            <Radio value="overwrite">覆盖为导入数（按差额记库存调整）</Radio>
          </Radio.Group>
        </div>
      )}
      {!check && !result && (
        <Upload accept=".xlsx,.csv" showUploadList={false} customRequest={customRequest} disabled={!!busy}>
          <Button type="primary" icon={<CloudUploadOutlined />} loading={busy === 'check'}>
            {busy === 'check' ? '正在预检查…' : `选择${title}文件`}
          </Button>
          <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>选择后先自动预检查，不会写入</Typography.Text>
        </Upload>
      )}
      {check && (
        <>
          <Alert
            type={check.ok ? 'success' : 'error'}
            showIcon
            icon={check.ok ? undefined : <FileSearchOutlined />}
            message={check.message}
            description={<Typography.Text type="secondary" style={{ fontSize: 12 }}>文件：{file?.name}{check.ok && check.unchanged ? `；${check.unchanged} 行数量与现有库存相同，不调整` : ''}</Typography.Text>}
          />
          {!check.ok && <ErrorTable errors={check.errors} />}
          {isStock && !check.ok && dup === 'error' && (check.duplicates?.length ?? 0) > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`有 ${check.duplicates!.length} 行在系统中已有库存，这通常是同一文件重复上传。`}
              description="如果确实要以本文件数量为准（例如盘点后的期初数），选择“覆盖为导入数”：系统按“导入数 − 当前库存”记库存调整流水，不会翻倍。"
              action={<Button size="small" onClick={() => changeDup('overwrite')}>改为覆盖为导入数</Button>}
            />
          )}
          <Space>
            {check.ok && (
              <Button type="primary" icon={<CloudUploadOutlined />} loading={busy === 'import'} onClick={doImport}>
                确认导入{check.created ? ` ${check.created} 条` : ''}{check.updated ? `${check.created ? '、' : ' '}更新 ${check.updated} 条` : ''}
              </Button>
            )}
            <Upload accept=".xlsx,.csv" showUploadList={false} customRequest={customRequest} disabled={!!busy}>
              <Button icon={<ReloadOutlined />} loading={busy === 'check'}>{check.ok ? '换一个文件' : '修改后重新选择文件'}</Button>
            </Upload>
          </Space>
        </>
      )}
      {result && (
        <>
          {result.ok ? (
            <Alert
              type="success"
              showIcon
              message={`导入成功：新增 ${result.created} 条${result.updated ? `，${isStock ? '调整' : '更新'} ${result.updated} 条` : ''}${result.unchanged ? `，${result.unchanged} 条无需调整` : ''}`}
              description={(
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  文件：{file?.name}{result.batch_no ? `；导入批次 ${result.batch_no}（如传错可在下方“期初导入批次”整批撤销）` : ''}
                </Typography.Text>
              )}
            />
          ) : (
            <>
              <Alert type="error" showIcon message={result.message || `发现 ${result.errors.length} 行错误，已全部回滚`} />
              <ErrorTable errors={result.errors} />
            </>
          )}
          {result.ok && renderSuccess?.(result)}
          <Button onClick={reset}>继续导入其他文件</Button>
        </>
      )}
    </Space>
  );
}

const STEP_OF: Record<string, number> = { suppliers: 0, customers: 0, materials: 1, boms: 2, stock: 3, users: 4 };
const STEP_ITEMS = [
  { title: '供应商 / 客户', description: '往来单位' },
  { title: '物料', description: '编码、规格、属性' },
  { title: 'BOM', description: '父项 + 子项 + 用量' },
  { title: '期初库存', description: '物料 + 库位 + 批号' },
  { title: '员工账号', description: '批量开户（管理员）' },
];

function ImportCard({ def, onDone }: { def: ImportEntity; onDone: () => void }) {
  const isUsers = def.key === 'users';
  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={(
        <Space>
          <Tag color="purple" style={{ marginInlineEnd: 0 }}>第 {STEP_OF[def.key] + 1} 步</Tag>
          <span>{def.title}</span>
          {def.count > 0 && <Tooltip title={`系统中已有 ${def.count} 条${def.key === 'stock' ? '期初导入批次' : ''}`}><CheckCircleFilled style={{ color: '#52c41a' }} /></Tooltip>}
          {def.via_migration && <Tooltip title="通过“上线迁移模式”导入（管理员）"><Tag color="orange" style={{ marginInlineEnd: 0 }}>迁移模式</Tag></Tooltip>}
        </Space>
      )}
      extra={<Button size="small" type="link" icon={<DownloadOutlined />} onClick={() => download(`/import/templates/${def.key}`, `${def.title}导入模板.xlsx`)}>下载模板</Button>}
    >
      <Typography.Paragraph style={{ marginBottom: 6 }}>{def.desc}</Typography.Paragraph>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        可导入：{def.perms.map((p) => p.name).join('、')}权限{def.key !== 'users' && '（管理员在迁移模式下也可）'}；
        列（<span style={{ color: '#cf1322' }}>红色 * 为必填</span>，▾ 为模板中有下拉）：
      </Typography.Text>
      <ColumnTags columns={def.columns} />
      <div style={{ marginTop: 8 }}>
        {isUsers ? (
          <Alert type="info" showIcon message={<span>批量开户请到 <Link to="/system/users?import=1">用户与角色 → 批量导入用户</Link>，导入后可直接下载初始密码清单。</span>} />
        ) : (
          <ImportFlow entity={def.key} title={def.title} disabled={!def.can_import} disabledReason={def.reason} onImported={onDone} />
        )}
      </div>
    </Card>
  );
}

/** 期初导入批次：每次期初库存导入生成一张期初入库单，可整批撤销（反向流水） */
function StockBatches({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(false);
  const [reverting, setReverting] = useState<Rec | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setLoading(true);
    get('/import/stock/batches', undefined, true).then(setRows).catch(() => setRows([])).finally(() => setLoading(false));
  }, []);
  useEffect(load, [load, refreshKey]);
  const revert = async () => {
    if (!reverting) return;
    setBusy(true);
    try {
      const r = await post(`/import/stock/batches/${reverting.id}/revert`, { reason });
      message.success(`已撤销批次 ${r.no}：${r.reversed} 笔库存流水已反向`);
      setReverting(null);
      setReason('');
      load();
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card size="small" title="期初导入批次" extra={<Button size="small" icon={<ReloadOutlined />} onClick={load} />} style={{ marginTop: 16 }}>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '批次号（期初入库单）', dataIndex: 'no', render: (v) => <Link className="mono" to={`/wms/receipts?q=${v}`}>{v}</Link> },
          { title: '导入时间', dataIndex: 'created_at', render: (v) => fmtDateTime(v) },
          { title: '导入人', dataIndex: 'created_by' },
          { title: '新增行', dataIndex: 'line_count', align: 'right' },
          { title: '覆盖调整', dataIndex: 'adjust_count', align: 'right', render: (v) => v || '-' },
          { title: '状态', dataIndex: 'status', render: (v) => <StatusTag dict="doc_status" value={v} /> },
          { title: '说明', dataIndex: 'remark', render: (v) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{v}</Typography.Text> },
          {
            title: '操作', key: '_op', fixed: 'right',
            render: (_, r) => (r.status !== 'CANCELLED'
              ? <Button size="small" danger type="link" icon={<RollbackOutlined />} onClick={() => setReverting(r)}>整批撤销</Button>
              : <Typography.Text type="secondary">已撤销</Typography.Text>),
          },
        ]}
      />
      <Modal
        open={!!reverting}
        title={`撤销期初导入批次 ${reverting?.no ?? ''}`}
        okText="确认撤销"
        okButtonProps={{ danger: true, disabled: !reason.trim() }}
        confirmLoading={busy}
        onOk={revert}
        onCancel={() => setReverting(null)}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="按该批次的入库/调整流水逐笔记反向流水（不删除任何记录）。如果其中的库存已被领用或调拨，系统会提示库存不足并整批不撤销。"
        />
        <Input.TextArea autoFocus rows={2} placeholder="撤销原因（必填，如：传错文件、数量整体有误）" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
      </Modal>
    </Card>
  );
}

export default function DataImport() {
  const { user } = useAuth();
  const [opts, setOpts] = useState<ImportOptions | null>(null);
  const [batchKey, setBatchKey] = useState(0);
  const [modeBusy, setModeBusy] = useState(false);

  const load = useCallback(() => {
    get<ImportOptions>('/import/options').then(setOpts).catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  const toggleMode = (enabled: boolean) => {
    Modal.confirm({
      title: enabled ? '开启上线迁移模式？' : '关闭上线迁移模式？',
      content: enabled
        ? '开启后系统管理员可导入全部业务数据（往来单位、物料、BOM、期初库存），用于系统上线初始化。操作记入审计追踪。'
        : '上线完成后请关闭：关闭后管理员不能再导入业务数据，只能由对应岗位（主数据、工程、仓储）导入。操作记入审计追踪。',
      okText: enabled ? '开启' : '关闭',
      onOk: async () => {
        setModeBusy(true);
        try {
          await post('/import/migration-mode', { enabled });
          message.success(enabled ? '已开启上线迁移模式' : '已关闭上线迁移模式');
          load();
        } finally {
          setModeBusy(false);
        }
      },
    });
  };

  if (!opts) return <Card loading />;
  const entities = opts.entities.filter((e) => e.key !== 'users' || opts.is_admin);
  const allowed = entities.filter((e) => e.can_import && e.key !== 'users');
  const denied = entities.filter((e) => !e.can_import && e.key !== 'users');
  const steps = opts.is_admin ? STEP_ITEMS : STEP_ITEMS.slice(0, 4);
  const stepDone = (i: number) => entities.some((e) => STEP_OF[e.key] === i && e.count > 0);
  const current = steps.findIndex((_, i) => !stepDone(i));
  const stockDef = entities.find((e) => e.key === 'stock');

  return (
    <>
      <PageHeader title="数据导入（从金蝶迁移）" sub="按顺序导入往来单位 → 物料 → BOM → 期初库存。每个文件先自动预检查，确认无误再导入。" />
      <Card style={{ marginBottom: 16 }}>
        <Steps
          size="small"
          current={current < 0 ? steps.length : current}
          items={steps.map((s, i) => ({ ...s, status: stepDone(i) ? 'finish' : i === current ? 'process' : 'wait' }))}
        />
        <Alert
          type={allowed.length ? 'info' : 'warning'}
          showIcon
          icon={<InfoCircleOutlined />}
          style={{ marginTop: 16 }}
          message={(
            <span>
              当前账号 <b>{user?.full_name}</b>（{user?.role_names?.join('、') || '无角色'}）
              {allowed.length ? <>可导入：{allowed.map((e) => <Tag key={e.key} color="green" style={{ marginInlineEnd: 4 }}>{e.title}</Tag>)}</> : '不能导入业务数据。'}
              {denied.length > 0 && (
                <>
                  不能导入：
                  {denied.map((e) => (
                    <Popover key={e.key} content={e.reason}><Tag style={{ marginInlineEnd: 4, cursor: 'help' }}>{e.title}</Tag></Popover>
                  ))}
                </>
              )}
            </span>
          )}
          description={(
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              <li>可直接上传金蝶 K/3 Cloud / 星空“引出”的 Excel（识别 编码 / 名称 / 规格型号 / 物料属性 等常见列名），也可下载模板填写（模板含“填写说明”页和下拉选项）。</li>
              <li>支持 .xlsx 与 .csv（UTF-8 或 GBK）；文件顶部的标题行自动跳过。往来单位、物料按编码“有则更新、无则新增”；BOM 不覆盖已有版本；<b>期初库存同一物料+库位+批号已有库存时默认报错，不会重复入账</b>。</li>
              <li><b>任意一行出错，整个文件都不导入</b>，按“Excel 行号 + 原因”修正后重新选择文件即可。</li>
            </ul>
          )}
        />
        {opts.is_admin && (
          <Alert
            type={opts.migration_mode ? 'warning' : 'success'}
            showIcon
            icon={opts.migration_mode ? <UnlockOutlined /> : <LockOutlined />}
            style={{ marginTop: 12 }}
            message={opts.migration_mode
              ? '上线迁移模式：开启中 —— 系统管理员可导入全部业务数据。上线完成后请关闭，之后由各岗位导入。'
              : '上线迁移模式：已关闭 —— 系统管理员不能导入业务数据（职责分离），由主数据/工程/仓储岗位导入。'}
            action={<Space><Typography.Text type="secondary">迁移模式</Typography.Text><Switch checked={opts.migration_mode} loading={modeBusy} onChange={toggleMode} /></Space>}
          />
        )}
      </Card>
      <Row gutter={[16, 16]}>
        {entities.map((def) => (
          <Col key={def.key} xs={24} lg={12} xxl={8}>
            <ImportCard def={def} onDone={() => { load(); setBatchKey((k) => k + 1); }} />
          </Col>
        ))}
      </Row>
      {stockDef?.can_import && <StockBatches refreshKey={batchKey} onChanged={load} />}
      {!entities.length && <Result status="403" title="无可导入的数据" />}
    </>
  );
}
