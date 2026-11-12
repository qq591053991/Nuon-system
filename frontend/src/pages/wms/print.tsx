/**
 * 仓库打印用小组件：Code 128（B 字符集）条码 SVG（自实现，不依赖第三方库）、批次标签、库位标签、标签打印。
 * 条码内容只能是 ASCII（批号、编码、单号均满足）；含中文时只显示文字。
 */
import type { CSSProperties } from 'react';
import { fmtDate, fmtQty } from '../../utils/format';
import type { Rec } from '../../api/http';

// Code 128 条/空宽度表（值 0–106），每个字符 6 个元素（停止符 7 个）
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231',
  '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131',
  '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211',
  '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214',
  '211232', '2331112',
];
const START_B = 104;
const STOP = 106;

/** 文本 → Code128B 模块序列（条=1/空=0）；含非 ASCII 字符返回 null */
export function code128Modules(text: string): string | null {
  if (!text || ![...text].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126)) return null;
  const codes = [START_B, ...[...text].map((c) => c.charCodeAt(0) - 32)];
  const check = codes.reduce((s, v, i) => s + v * (i === 0 ? 1 : i), 0) % 103;
  codes.push(check, STOP);
  let bits = '';
  for (const v of codes) {
    const p = PATTERNS[v];
    for (let i = 0; i < p.length; i++) bits += (i % 2 === 0 ? '1' : '0').repeat(Number(p[i]));
  }
  return bits;
}

/** Code128 条码（SVG，按宽度缩放；打印清晰） */
export function Barcode({ value, height = 40, width, showText = true, style }: { value: string; height?: number; width?: string | number; showText?: boolean; style?: CSSProperties }) {
  const bits = code128Modules(value);
  if (!bits) return <div className="mono" style={{ fontSize: 14, ...style }}>{value}</div>;
  const quiet = 10;
  const total = bits.length + quiet * 2;
  const rects: JSX.Element[] = [];
  let i = 0;
  while (i < bits.length) {
    if (bits[i] === '1') {
      let j = i;
      while (j < bits.length && bits[j] === '1') j++;
      rects.push(<rect key={i} x={i + quiet} y={0} width={j - i} height={100} />);
      i = j;
    } else i++;
  }
  return (
    <div style={{ textAlign: 'center', ...style }}>
      <svg viewBox={`0 0 ${total} 100`} preserveAspectRatio="none" style={{ width: width ?? '100%', height, display: 'block', margin: '0 auto' }} shapeRendering="crispEdges" role="img" aria-label={value}>
        <rect x={0} y={0} width={total} height={100} fill="#fff" />
        <g fill="#000">{rects}</g>
      </svg>
      {showText && <div className="mono" style={{ fontSize: 12, letterSpacing: 1, marginTop: 1 }}>{value}</div>}
    </div>
  );
}

export type LabelSize = 'roll' | 'a4';

/** 标签打印：roll = 标签打印机 60×40mm 一张一页；a4 = A4 不干胶 3 列 */
export function printLabels(size: LabelSize, title?: string) {
  const style = document.createElement('style');
  style.textContent = size === 'roll'
    ? '@page { size: 60mm 40mm; margin: 0; } .wms-label { page-break-after: always; break-after: page; border: none !important; margin: 0 !important; }'
    : '@page { size: A4 portrait; margin: 8mm; } .wms-labels { display: grid !important; grid-template-columns: repeat(3, 60mm); gap: 4mm 6mm; }';
  document.head.appendChild(style);
  const old = document.title;
  if (title) document.title = title;
  window.print();
  document.title = old;
  style.remove();
}

const LABEL: CSSProperties = {
  width: '60mm', height: '40mm', boxSizing: 'border-box', padding: '1.5mm 2mm', border: '1px dashed #bbb', background: '#fff', color: '#000',
  overflow: 'hidden', display: 'flex', flexDirection: 'column', fontFamily: 'sans-serif', breakInside: 'avoid',
};

/** 批次标签：物料、批号条码、数量、效期、库位、质量状态 */
export function LotLabel({ r }: { r: Rec }) {
  return (
    <div className="wms-label" style={LABEL}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 4 }}>
        <b style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{r.material_code}</b>
        <span style={{ fontSize: 9, border: '1px solid #000', padding: '0 2px' }}>{r.status === 'QUARANTINE' ? '待检' : r.status === 'AVAILABLE' ? '合格' : r.status === 'HOLD' ? '冻结' : r.status === 'REJECTED' ? '不合格' : ''}</span>
      </div>
      <div style={{ fontSize: 8, lineHeight: 1.2, height: '2.4em', overflow: 'hidden' }}>{r.material_name}{r.material_spec ? ` | ${r.material_spec}` : ''}</div>
      <Barcode value={r.lot_no || r.material_code} height={34} showText={false} style={{ margin: '1mm 0 0' }} />
      <div className="mono" style={{ fontSize: 12, fontWeight: 700, textAlign: 'center' }}>{r.lot_no || '（无批号）'}</div>
      <div style={{ fontSize: 9, display: 'flex', justifyContent: 'space-between' }}>
        <span>数量 <b>{fmtQty(r.qty)}</b> {r.uom}</span>
        <span>库位 <b>{r.location_code}</b></span>
      </div>
      <div style={{ fontSize: 8, display: 'flex', justifyContent: 'space-between' }}>
        <span>{r.supplier_lot ? `原厂 ${r.supplier_lot}` : r.receipt_no ? `单号 ${r.receipt_no}` : ''}</span>
        <span>{r.expiry_date ? `效期 ${fmtDate(r.expiry_date)}` : r.received_date ? `收货 ${fmtDate(r.received_date)}` : ''}</span>
      </div>
    </div>
  );
}

/** 库位标签：大字编码 + 条码 */
export function LocationLabel({ r }: { r: Rec }) {
  return (
    <div className="wms-label" style={{ ...LABEL, justifyContent: 'center', alignItems: 'stretch' }}>
      <div className="mono" style={{ fontSize: 22, fontWeight: 800, textAlign: 'center', lineHeight: 1.1 }}>{r.code}</div>
      <Barcode value={r.code} height={42} showText={false} style={{ margin: '1.5mm 0' }} />
      <div style={{ fontSize: 9, textAlign: 'center' }}>{r.name ?? ''}{r.warehouse_name ? ` · ${r.warehouse_name}` : ''}</div>
    </div>
  );
}
