import { Card, Empty, Pagination, Spin, Table, Typography, type TableProps } from 'antd';
import type { ColumnType } from 'antd/es/table';
import { useEffect, useState, type ReactNode } from 'react';
import type { Rec } from '../api/http';

/** 列的窄屏显示方式：title=卡片标题，subtitle=副标题，hidden=窄屏不显示，actions=放在卡片底部 */
export type MobileRole = 'title' | 'subtitle' | 'hidden' | 'actions';
export type RColumn<T = Rec> = ColumnType<T> & { mobile?: MobileRole };

export function useNarrow(breakpoint = 600) {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < breakpoint);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < breakpoint);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [breakpoint]);
  return narrow;
}

const valueOf = (rec: Rec, di: ColumnType<Rec>['dataIndex']) => {
  if (di === undefined || di === null) return undefined;
  const path = Array.isArray(di) ? di : [di];
  return path.reduce((o: any, k: any) => (o == null ? o : o[k]), rec);
};

const cell = (col: RColumn, rec: Rec, i: number): ReactNode => {
  const v = valueOf(rec, col.dataIndex);
  if (col.render) return col.render(v, rec, i) as ReactNode;
  return v === null || v === undefined || v === '' ? '-' : String(v);
};

const titleText = (t: RColumn['title']): ReactNode => (typeof t === 'function' ? null : (t as ReactNode));

/**
 * 响应式表格：用法与 antd Table 相同；屏幕宽度 < breakpoint（默认 600，即手机/PDA）时自动改为卡片列表，
 * 不再横向滚动、不再被固定列遮挡。列可加 mobile 提示（见 MobileRole）；未标注时第一列作标题、key 为 _op 的列作操作区。
 */
export default function ResponsiveTable<T extends Rec = Rec>({ breakpoint = 600, ...props }: TableProps<T> & { columns?: RColumn<T>[]; breakpoint?: number }) {
  const narrow = useNarrow(breakpoint);
  if (!narrow) return <Table<T> {...props} />;

  const cols = ((props.columns || []) as RColumn[]).filter((c) => c.mobile !== 'hidden');
  const titleCol = cols.find((c) => c.mobile === 'title') ?? cols.find((c) => c.key !== '_op' && c.mobile !== 'actions');
  const subCol = cols.find((c) => c.mobile === 'subtitle');
  const actionCols = cols.filter((c) => c.mobile === 'actions' || c.key === '_op');
  const fieldCols = cols.filter((c) => c !== titleCol && c !== subCol && !actionCols.includes(c));
  const data = (props.dataSource || []) as Rec[];
  const pg = props.pagination && typeof props.pagination === 'object' ? props.pagination : null;
  const loading = typeof props.loading === 'object' ? props.loading.spinning : !!props.loading;
  const rowKey = (r: Rec, i: number) => (typeof props.rowKey === 'function' ? (props.rowKey as any)(r) : r[(props.rowKey as string) || 'id'] ?? i);

  return (
    <Spin spinning={loading}>
      {data.length === 0 && !loading ? (
        <Empty style={{ padding: 24 }} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data.map((r, i) => {
            const onRow = props.onRow?.(r as T, i);
            return (
              <Card key={rowKey(r, i)} size="small" hoverable={!!onRow?.onClick} onClick={onRow?.onClick as any} styles={{ body: { padding: 12 } }}>
                {titleCol && <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 2, wordBreak: 'break-all' }}>{cell(titleCol, r, i)}</div>}
                {subCol && <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>{cell(subCol, r, i)}</Typography.Text>}
                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 4, fontSize: 14 }}>
                  {fieldCols.map((c, j) => (
                    <div key={j} style={{ display: 'contents' }}>
                      <Typography.Text type="secondary" style={{ whiteSpace: 'nowrap' }}>{titleText(c.title)}</Typography.Text>
                      <div style={{ wordBreak: 'break-all', minWidth: 0 }}>{cell(c, r, i)}</div>
                    </div>
                  ))}
                </div>
                {actionCols.length > 0 && (
                  <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
                    {actionCols.map((c, j) => <div key={j}>{cell(c, r, i)}</div>)}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
      {pg && (pg.total ?? 0) > (pg.pageSize ?? 20) && (
        <Pagination simple style={{ marginTop: 12, textAlign: 'center' }} current={pg.current} pageSize={pg.pageSize} total={pg.total}
          onChange={(p, s) => pg.onChange?.(p, s)} />
      )}
    </Spin>
  );
}
