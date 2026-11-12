import { Button, Card, Empty, Image, List, Modal, Space, Tag, Tooltip, Typography, Upload, message } from 'antd';
import { CameraOutlined, DownloadOutlined, EyeOutlined, FileImageOutlined, FileOutlined, FilePdfOutlined, PaperClipOutlined, UploadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { download, get, http, type Rec } from '../api/http';
import { fmtDateTime } from '../utils/format';

const MAX_MB = 20;

const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`);
const isImage = (r: Rec) => String(r.content_type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(r.filename || '');
const isPdf = (r: Rec) => r.content_type === 'application/pdf' || /\.pdf$/i.test(r.filename || '');

/** 关联单据的附件（只读显示，如 NCR 中显示来源检验单的照片） */
export interface LinkedAttachments {
  entity: string;
  entityId?: number | null;
  /** 显示的来源说明，如“检验单 IQC261112001” */
  label: string;
}

interface Props {
  /** 单据表名，如 qms_inspection / qms_ncr / qms_complaint / qms_capa / wms_customer_return */
  entity: string;
  entityId?: number | null;
  title?: string;
  /** 说明文字（如“供应商 COA、检验照片”） */
  hint?: string;
  /** 是否允许上传（默认允许；查看权限由后端控制） */
  canUpload?: boolean;
  /** 不包 Card（嵌入抽屉/表单时使用） */
  bare?: boolean;
  /** 同时显示关联单据的附件（只读） */
  linked?: LinkedAttachments[];
}

/** 按需取附件内容（带登录凭证）→ 本地 URL，用于缩略图与预览 */
function useBlobUrls() {
  const cache = useRef<Map<number, string>>(new Map());
  useEffect(() => () => cache.current.forEach((u) => URL.revokeObjectURL(u)), []);
  return useCallback(async (id: number) => {
    const hit = cache.current.get(id);
    if (hit) return hit;
    const r = await http.get(`/attachments/${id}/download`, { responseType: 'blob' });
    const u = URL.createObjectURL(r.data);
    cache.current.set(id, u);
    return u;
  }, []);
}

/** 图片缩略图（点击放大预览） */
function Thumb({ row, blobUrl }: { row: Rec; blobUrl: (id: number) => Promise<string> }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    blobUrl(row.id).then((u) => live && setSrc(u)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [row.id, blobUrl]);
  if (!src) return <div style={{ width: 56, height: 56, background: '#f5f5f5', borderRadius: 4, display: 'grid', placeItems: 'center' }}><FileImageOutlined style={{ color: '#bfbfbf' }} /></div>;
  return <Image src={src} width={56} height={56} style={{ objectFit: 'cover', borderRadius: 4 }} preview={{ mask: <EyeOutlined /> }} alt={row.filename} />;
}

/**
 * 附件（质量证据）：列表 + 多选上传 + 拍照 + 预览/下载。
 *   <Attachments entity="qms_ncr" entityId={ncr.id} hint="缺陷照片、检测报告" linked={[{ entity: 'qms_inspection', entityId: 3, label: '检验单 IQC…' }]} />
 * 一次可选多个文件，确认一次全部上传；平板/手机可直接调用相机拍照；图片显示缩略图，点击放大，PDF 可在新窗口预览。
 * 附件永久保存、不可删除（GMP 记录保存要求）。单个文件不超过 20 MB。
 */
export default function Attachments({ entity, entityId, title = '附件', hint, canUpload = true, bare, linked = [] }: Props) {
  const [rows, setRows] = useState<Rec[]>([]);
  const [linkedRows, setLinkedRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const blobUrl = useBlobUrls();
  const camera = useRef<HTMLInputElement>(null);
  const pending = useRef<File[]>([]);
  const timer = useRef<any>();
  const linkedKey = JSON.stringify(linked.map((l) => [l.entity, l.entityId]));

  const load = useCallback(() => {
    if (!entityId) return;
    setLoading(true);
    get<Rec[]>('/attachments', { entity, entity_id: entityId }, true)
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [entity, entityId]);

  useEffect(() => {
    setRows([]);
    load();
  }, [load]);

  useEffect(() => {
    const list = linked.filter((l) => l.entityId);
    if (!list.length) {
      setLinkedRows([]);
      return;
    }
    Promise.all(list.map((l) => get<Rec[]>('/attachments', { entity: l.entity, entity_id: l.entityId }, true).then((rs) => rs.map((r) => ({ ...r, _from: l.label }))).catch(() => [])))
      .then((all) => setLinkedRows(all.flat()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedKey]);

  /** 一次确认、依次上传全部所选文件 */
  const uploadAll = async (files: File[]) => {
    const tooBig = files.filter((f) => f.size > MAX_MB * 1024 * 1024);
    const empty = files.filter((f) => !f.size);
    if (tooBig.length) message.error(`以下文件超过 ${MAX_MB} MB，已跳过：${tooBig.map((f) => f.name).join('、')}`);
    if (empty.length) message.error(`以下文件为空，已跳过：${empty.map((f) => f.name).join('、')}`);
    const ok = files.filter((f) => f.size && f.size <= MAX_MB * 1024 * 1024);
    if (!ok.length) return;
    const confirmed = await new Promise<boolean>((resolve) =>
      Modal.confirm({
        title: `确认上传 ${ok.length} 个附件？`,
        content: (
          <div>
            <ul style={{ paddingLeft: 18, margin: '4px 0 8px', maxHeight: 200, overflow: 'auto' }}>
              {ok.map((f, i) => <li key={i}><b>{f.name}</b>（{fmtSize(f.size)}）</li>)}
            </ul>
            <Typography.Text type="secondary">附件作为质量证据永久保存，上传后不可删除，请确认文件正确。</Typography.Text>
          </div>
        ),
        okText: '全部上传',
        cancelText: '取消',
        autoFocusButton: 'ok',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      }),
    );
    if (!confirmed) return;
    setUploading(true);
    let done = 0;
    try {
      for (const file of ok) {
        const fd = new FormData();
        fd.append('entity', entity);
        fd.append('entity_id', String(entityId));
        fd.append('file', file);
        try {
          await http.post('/attachments', fd);
          done += 1;
        } catch {
          /* 错误已由 http 拦截器提示 */
        }
      }
      if (done) message.success(`已上传 ${done} 个附件`);
      load();
    } finally {
      setUploading(false);
    }
  };

  /** antd Upload 多选时逐个回调：攒齐同一批后统一确认 */
  const queue = (f: File) => {
    pending.current.push(f);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const files = pending.current;
      pending.current = [];
      uploadAll(files);
    }, 0);
  };

  const preview = async (r: Rec) => {
    try {
      const u = await blobUrl(r.id);
      window.open(u, '_blank', 'noopener');
    } catch {
      /* 错误已提示 */
    }
  };

  const uploadBtn = canUpload && entityId ? (
    <Space size={6} className="no-print">
      <Upload showUploadList={false} multiple beforeUpload={(f) => { queue(f as unknown as File); return false; }}>
        <Button size="small" icon={<UploadOutlined />} loading={uploading}>上传附件（可多选）</Button>
      </Upload>
      <Tooltip title="平板/手机直接调用相机拍照（可连拍多张后一起上传）">
        <Button size="small" icon={<CameraOutlined />} disabled={uploading} onClick={() => camera.current?.click()}>拍照</Button>
      </Tooltip>
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = '';
          if (files.length) uploadAll(files);
        }}
      />
    </Space>
  ) : null;

  const item = (r: Rec) => (
    <List.Item
      actions={[
        ...(isPdf(r) ? [<Tooltip key="pv" title="新窗口预览"><Button type="link" size="small" icon={<EyeOutlined />} onClick={() => preview(r)} /></Tooltip>] : []),
        <Tooltip key="dl" title="下载"><Button type="link" size="small" icon={<DownloadOutlined />} onClick={() => download(`/attachments/${r.id}/download`, r.filename)} /></Tooltip>,
      ]}
    >
      <List.Item.Meta
        avatar={isImage(r) ? <Thumb row={r} blobUrl={blobUrl} /> : isPdf(r) ? <FilePdfOutlined style={{ fontSize: 22, color: '#cf1322', marginTop: 4 }} /> : <FileOutlined style={{ fontSize: 18, color: '#8c8c8c', marginTop: 4 }} />}
        title={
          <Space size={6} wrap>
            <Typography.Link onClick={() => (isImage(r) || isPdf(r) ? preview(r) : download(`/attachments/${r.id}/download`, r.filename))}>{r.filename}</Typography.Link>
            {r._from && <Tag color="blue" style={{ marginInlineEnd: 0 }}>来自{r._from}</Tag>}
          </Space>
        }
        description={
          <Space size={8} wrap style={{ fontSize: 12 }}>
            <span>{fmtSize(r.size)}</span>
            <span>{r.uploaded_by_name || r.uploaded_by || '-'}</span>
            <span>{fmtDateTime(r.created_at)}</span>
            <Tooltip title={`SHA-256：${r.sha256}（下载时校验，防篡改）`}>
              <span className="mono" style={{ color: '#bfbfbf' }}>#{String(r.sha256).slice(0, 8)}</span>
            </Tooltip>
          </Space>
        }
      />
    </List.Item>
  );

  const all = [...rows, ...linkedRows];
  const body = (
    <>
      {hint && <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>{hint}</Typography.Paragraph>}
      <Image.PreviewGroup>
        <List
          size="small"
          loading={loading}
          dataSource={all}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无附件" /> }}
          renderItem={item}
        />
      </Image.PreviewGroup>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        单个文件不超过 {MAX_MB} MB，可一次选择多个文件。附件作为质量证据永久保存，不提供删除；上传错误请补充说明后重新上传正确文件。
      </Typography.Text>
    </>
  );

  const head = <span><PaperClipOutlined /> {title}（{rows.length}{linkedRows.length ? ` + 关联 ${linkedRows.length}` : ''}）</span>;
  if (bare) {
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
          <Typography.Text strong>{head}</Typography.Text>
          {uploadBtn}
        </div>
        {body}
      </div>
    );
  }
  return (
    <Card size="small" title={head} extra={uploadBtn}>
      {body}
    </Card>
  );
}
