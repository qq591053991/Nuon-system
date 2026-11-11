import { Tag } from 'antd';
import { DICT } from '../utils/dict';

/** 按字典渲染状态标签：<StatusTag dict="wo_status" value={row.status} /> */
export default function StatusTag({ dict, value }: { dict: string; value?: string | null }) {
  if (value === null || value === undefined || value === '') return <span>-</span>;
  const e = DICT[dict]?.[value];
  return <Tag color={e?.[1] || 'default'} style={{ marginInlineEnd: 0 }}>{e?.[0] ?? value}</Tag>;
}
