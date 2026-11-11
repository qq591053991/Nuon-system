import dayjs from 'dayjs';

export const fmtDate = (v?: string | null) => (v ? dayjs(v).format('YYYY-MM-DD') : '-');
export const fmtDateTime = (v?: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-');
export const fmtQty = (v?: number | null, digits = 4) =>
  v === null || v === undefined ? '-' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: digits });
export const fmtMoney = (v?: number | null, currency = 'CNY') =>
  v === null || v === undefined
    ? '-'
    : `${currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '¥'}${Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtPct = (v?: number | null) => (v === null || v === undefined ? '-' : `${v}%`);
/** 日期对象 → 'YYYY-MM-DD'（提交给后端） */
export const toDate = (v: any) => (v ? dayjs(v).format('YYYY-MM-DD') : null);
