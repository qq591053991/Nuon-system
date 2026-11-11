import { Button, Card, Empty, List, Modal, Space, Tooltip, Typography, Upload, message } from 'antd';
import { DownloadOutlined, FileOutlined, PaperClipOutlined, UploadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { download, get, http, type Rec } from '../api/http';
import { fmtDateTime } from '../utils/format';

const MAX_MB = 20;

const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`);

interface Props {
  /** 单据表名，如 qms_inspection / qms_ncr / qms_complaint / wms_customer_return */
  entity: string;
  entityId?: number | null;
  title?: string;
  /** 说明文字（如“供应商 COA、检验照片”） */
  hint?: string;
  /** 是否允许上传（默认允许；查看权限由后端控制） */
  canUpload?: boolean;
  /** 不包 Card（嵌入抽屉/表单时使用） */
  bare?: boolean;
}

/**
 * 附件（质量证据）：列表 + 上传 + 下载。
 *   <Attachments entity="qms_ncr" entityId={ncr.id} hint="缺陷照片、检测报告" />
 * 附件永久保存、不可删除（GMP 记录保存要求），上传前二次确认。单个文件不超过 20 MB。
 */
export default function Attachments({ entity, entityId, title = '附件', hint, canUpload = true, bare }: Props) {
  const [rows, setRows] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

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

  const upload = async (file: File) => {
    if (file.size > MAX_MB * 1024 * 1024) {
      message.error(`附件不能超过 ${MAX_MB} MB`);
      return;
    }
    if (!file.size) {
      message.error('不能上传空文件');
      return;
    }
    const ok = await new Promise<boolean>((resolve) =>
      Modal.confirm({
        title: '确认上传附件？',
        content: (
          <div>
            <div>文件：<b>{file.name}</b>（{fmtSize(file.size)}）</div>
            <Typography.Text type="secondary">附件作为质量证据永久保存，上传后不可删除，请确认文件正确。</Typography.Text>
          </div>
        ),
        okText: '上传',
        cancelText: '取消',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      }),
    );
    if (!ok) return;
    const fd = new FormData();
    fd.append('entity', entity);
    fd.append('entity_id', String(entityId));
    fd.append('file', file);
    setUploading(true);
    try {
      await http.post('/attachments', fd);
      message.success(`已上传：${file.name}`);
      load();
    } catch {
      /* 错误已由 http 拦截器提示 */
    } finally {
      setUploading(false);
    }
  };

  const uploadBtn = canUpload && entityId ? (
    <Upload
      showUploadList={false}
      multiple={false}
      beforeUpload={(f) => {
        upload(f as unknown as File);
        return false;
      }}
    >
      <Button size="small" icon={<UploadOutlined />} loading={uploading}>上传附件</Button>
    </Upload>
  ) : null;

  const body = (
    <>
      {hint && <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>{hint}</Typography.Paragraph>}
      <List
        size="small"
        loading={loading}
        dataSource={rows}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无附件" /> }}
        renderItem={(r) => (
          <List.Item
            actions={[
              <Tooltip key="dl" title="下载">
                <Button type="link" size="small" icon={<DownloadOutlined />} onClick={() => download(`/attachments/${r.id}/download`, r.filename)} />
              </Tooltip>,
            ]}
          >
            <List.Item.Meta
              avatar={<FileOutlined style={{ fontSize: 18, color: '#8c8c8c', marginTop: 4 }} />}
              title={<Typography.Link onClick={() => download(`/attachments/${r.id}/download`, r.filename)}>{r.filename}</Typography.Link>}
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
        )}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        单个文件不超过 {MAX_MB} MB。附件作为质量证据永久保存，不提供删除；上传错误请补充说明后重新上传正确文件。
      </Typography.Text>
    </>
  );

  if (bare) {
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <Typography.Text strong><PaperClipOutlined /> {title}（{rows.length}）</Typography.Text>
          {uploadBtn}
        </div>
        {body}
      </div>
    );
  }
  return (
    <Card size="small" title={<span><PaperClipOutlined /> {title}（{rows.length}）</span>} extra={uploadBtn}>
      {body}
    </Card>
  );
}
