import { BizError } from '../common/errors';

/** 查询参数中的整数（与 Python 版 `if customer_id:` 一致：空/0 视为未筛选） */
export function qInt(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new BizError(`参数格式错误：${v}`);
  return n || undefined;
}
