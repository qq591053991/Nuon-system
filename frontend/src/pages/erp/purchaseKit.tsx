/** 采购页面（G4）共用：带合格状态的供应商下拉、日期工具 */
import { Tag } from 'antd';
import dayjs from 'dayjs';
import type { Rec } from '../../api/http';
import RemoteSelect from '../../components/RemoteSelect';
import { dictLabel } from '../../utils/dict';

/** 供应商是否可审批下单（合格供方且资质未过期） */
export const supplierOk = (s?: Rec | null) =>
  !!s && s.status === 'QUALIFIED' && !(s.qualification_expiry && dayjs(s.qualification_expiry).isBefore(dayjs(), 'day'));

const supplierBadge = (s: Rec) => {
  if (supplierOk(s)) return '合格供方';
  if (s.status === 'QUALIFIED') return '资质过期';
  return dictLabel('supplier_status', s.status);
};

type P = Omit<React.ComponentProps<typeof RemoteSelect>, 'url'>;

/**
 * 供应商下拉：每项显示合格状态（合格供方 / 待评审 / 资质过期…），不合格的标橙色，
 * 选择前就知道能否审批下单（扫码/回车按编码精确匹配，同 RemoteSelect）。
 */
export function QualifiedSupplierSelect(p: P) {
  return (
    <RemoteSelect
      url="/suppliers"
      noun="供应商"
      {...p}
      labelOf={(r) => `${r.code} ${r.name}（${supplierBadge(r)}）`}
      optionRender={(o: any) => {
        const text = String(o.label ?? '');
        const m = /^(.*)（([^（）]+)）$/.exec(text);
        const name = m ? m[1] : text;
        const badge = m ? m[2] : '';
        return (
          <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
            {badge && <Tag color={badge === '合格供方' ? 'green' : 'orange'} style={{ marginInlineEnd: 0 }}>{badge}</Tag>}
          </span>
        );
      }}
    />
  );
}

/** 'YYYY-MM-DD' 距今天数（正数 = 已过） */
export const daysPast = (d?: string | null) => (d ? dayjs().startOf('day').diff(dayjs(d), 'day') : null);
