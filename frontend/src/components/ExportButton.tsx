import { Button, message } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { get, http, type Rec } from '../api/http';

export interface ExportColumn {
  title: string;
  /** 取值字段；或用 value 自定义（返回导出单元格的值） */
  key?: string;
  value?: (row: Rec) => unknown;
  type?: 'text' | 'number' | 'money' | 'date' | 'datetime';
  width?: number;
}

interface Props {
  /** 列表接口（与 usePaged 相同的地址与筛选参数）；导出当前筛选下的全部数据 */
  url?: string;
  params?: Rec;
  /** 或直接给出要导出的行（非分页数据） */
  rows?: Rec[];
  columns: ExportColumn[];
  filename: string;
  title?: string;
  text?: string;
  size?: 'small' | 'middle' | 'large';
}

const PAGE = 1000;
const MAX_ROWS = 50000;

/** 导出 Excel：按当前筛选条件导出全部数据（不只是当前页） */
export default function ExportButton({ url, params, rows, columns, filename, title, text = '导出 Excel', size }: Props) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      let data = rows;
      if (!data && url) {
        const base: Rec = {};
        Object.entries(params || {}).forEach(([k, v]) => {
          if (v !== undefined && v !== null && v !== '' && k !== 'page' && k !== 'page_size') base[k] = v;
        });
        // 逐页拉取（后端单页上限 1000 行），最多导出 MAX_ROWS 行
        const all: Rec[] = [];
        for (let page = 1; ; page++) {
          const res = await get(url, { ...base, page, page_size: PAGE });
          if (Array.isArray(res)) { all.push(...res); break; }
          all.push(...res.items);
          if (!res.items.length || all.length >= res.total) break;
          if (all.length >= MAX_ROWS) {
            message.warning(`数据较多（共 ${res.total} 条），仅导出前 ${MAX_ROWS} 条，请缩小筛选范围`);
            break;
          }
        }
        data = all.slice(0, MAX_ROWS);
      }
      const keyed = columns.map((c, i) => ({ ...c, key: c.key ?? `c${i}` }));
      const out = (data || []).map((r) => Object.fromEntries(keyed.map((c) => [c.key, c.value ? c.value(r) : r[c.key!]])));
      const resp = await http.post('/export/xlsx', {
        filename, title, sheet: filename.slice(0, 31),
        columns: keyed.map(({ title: t, key, type, width }) => ({ title: t, key, type, width })),
        rows: out,
      }, { responseType: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(resp.data);
      a.download = `${filename}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
      message.success(`已导出 ${out.length} 条`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button icon={<DownloadOutlined />} loading={busy} onClick={run} size={size} className="no-print">
      {text}
    </Button>
  );
}
