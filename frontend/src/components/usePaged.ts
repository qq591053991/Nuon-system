import { useCallback, useEffect, useRef, useState } from 'react';
import { get, type Page, type Rec } from '../api/http';

/**
 * 分页列表数据 hook：
 *   const { rows, total, loading, query, setQuery, reload, pagination } = usePaged('/sales-orders', { status: 'CONFIRMED' });
 *   <Table rowKey="id" dataSource={rows} loading={loading} pagination={pagination} />
 * setQuery({ q: 'xx' }) 会合并参数并回到第 1 页。
 */
export function usePaged<T = Rec>(url: string, initial: Rec = {}, pageSize = 20) {
  const [query, _setQuery] = useState<Rec>(initial);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(pageSize);
  const [data, setData] = useState<Page<T>>({ items: [], total: 0, page: 1, page_size: pageSize });
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const reload = useCallback(() => {
    const my = ++seq.current;
    setLoading(true);
    const params: Rec = { page, page_size: size };
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') params[k] = v;
    });
    get<Page<T>>(url, params)
      .then((d) => my === seq.current && setData(d))
      .finally(() => my === seq.current && setLoading(false));
  }, [url, query, page, size]);

  useEffect(() => {
    reload();
  }, [reload]);

  const setQuery = useCallback((q: Rec) => {
    _setQuery((old) => ({ ...old, ...q }));
    setPage(1);
  }, []);

  /** 接到 antd Table 的 onChange：分页 + 列排序（列需设置 sorter: true，排序字段为 dataIndex） */
  const onTableChange = useCallback((p: any, _f: any, sorter: any) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    const field = s?.order ? (Array.isArray(s.field) ? s.field.join('.') : s.field ?? s.columnKey) : undefined;
    _setQuery((old) => ({ ...old, sort: field, order: s?.order ? (s.order === 'ascend' ? 'asc' : 'desc') : undefined }));
    if (p?.current) setPage(p.current);
    if (p?.pageSize) setSize(p.pageSize);
  }, []);

  return {
    onTableChange,
    rows: data.items,
    total: data.total,
    loading,
    query,
    setQuery,
    reload,
    pagination: {
      current: page,
      pageSize: size,
      total: data.total,
      showSizeChanger: true,
      showTotal: (t: number) => `共 ${t} 条`,
      onChange: (p: number, s: number) => {
        setPage(p);
        setSize(s);
      },
    },
  };
}
