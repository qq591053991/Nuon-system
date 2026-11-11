export const round = (v: number, digits = 4): number => {
  const f = 10 ** digits;
  return Math.round((v + Number.EPSILON) * f) / f;
};
export const round2 = (v: number) => round(v, 2);
export const EPS = 1e-9;
/** 数字格式（与 Python 的 :g 类似，去掉多余的 0） */
export const g = (v: number | null | undefined): string => (v === null || v === undefined ? '-' : String(round(v, 4)));
