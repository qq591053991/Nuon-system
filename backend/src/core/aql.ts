/**
 * GB/T 2828.1-2012 (ISO 2859-1) 正常检验一次抽样方案，一般检验水平 II。
 * 主表规律：对每个 AQL 列，Ac=0/Re=1 位于某一字码行 r0；其下一行为“↑”、再下一行为“↓”，之后依次为
 * 1/2、2/3、3/4、5/6、7/8、10/11、14/15、21/22；r0 以上为“↓”，21/22 以下为“↑”。
 * 箭头指向的方案连同其样本量一起采用；若样本量 ≥ 批量则全检。
 */
const LOT_RANGES: [number, string][] = [
  [8, 'A'], [15, 'B'], [25, 'C'], [50, 'D'], [90, 'E'], [150, 'F'], [280, 'G'], [500, 'H'],
  [1200, 'J'], [3200, 'K'], [10000, 'L'], [35000, 'M'], [150000, 'N'], [500000, 'P'], [Number.MAX_SAFE_INTEGER, 'Q'],
];
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R'];
const SAMPLE_SIZE = [2, 3, 5, 8, 13, 20, 32, 50, 80, 125, 200, 315, 500, 800, 1250, 2000];
const AQL_R0: [number, number][] = [[0.065, 10], [0.1, 9], [0.15, 8], [0.25, 7], [0.4, 6], [0.65, 5], [1.0, 4], [1.5, 3], [2.5, 2], [4.0, 1], [6.5, 0]];
const AC_SEQ = [1, 2, 3, 5, 7, 10, 14, 21];

export function codeLetter(lotQty: number): string {
  return LOT_RANGES.find(([upper]) => lotQty <= upper)?.[1] ?? 'Q';
}

function resolve(row: number, r0: number): number {
  if (row <= r0) return r0;
  if (row === r0 + 1) return r0; // ↑
  if (row === r0 + 2) return r0 + 3; // ↓
  if (row > r0 + 10) return r0 + 10; // ↑ 到 21/22
  return row;
}

export interface SamplingPlan {
  lot_qty: number; aql: number; code_letter: string; plan_letter: string; sample_size: number;
  accept_num: number; reject_num: number; full_inspection: boolean;
}

export function samplingPlan(lotQty: number, aql = 1.0): SamplingPlan {
  const lot = Math.max(Math.round(lotQty || 0), 1);
  const [aqlKey, r0] = AQL_R0.reduce((best, cur) => (Math.abs(cur[0] - aql) < Math.abs(best[0] - aql) ? cur : best));
  const letter = codeLetter(lot);
  let row = resolve(LETTERS.indexOf(letter), r0);
  if (row >= LETTERS.length) row = LETTERS.length - 1;
  const n = SAMPLE_SIZE[row];
  const ac = row === r0 ? 0 : AC_SEQ[row - r0 - 3];
  const full = n >= lot;
  return { lot_qty: lot, aql: aqlKey, code_letter: letter, plan_letter: LETTERS[row], sample_size: full ? lot : n, accept_num: ac, reject_num: ac + 1, full_inspection: full };
}
