import { Space, Typography } from 'antd';
import type { ReactNode } from 'react';

/** 页面标题栏：左侧标题+说明，右侧操作按钮 */
export default function PageHeader({ title, sub, extra, children }: { title: ReactNode; sub?: ReactNode; extra?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-header">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>{title}</Typography.Title>
          {sub && <Typography.Text type="secondary">{sub}</Typography.Text>}
        </div>
        {extra && <Space wrap>{extra}</Space>}
      </div>
      {children}
    </div>
  );
}
