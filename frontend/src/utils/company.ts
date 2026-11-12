import { useEffect, useState } from 'react';
import { get } from '../api/http';

/**
 * 本公司信息（单据打印抬头）：管理员在“系统与合规 → 系统设置”维护（存 sys_setting），未维护的项用后端环境变量
 * COMPANY_NAME / COMPANY_NAME_EN / COMPANY_ADDRESS / COMPANY_PHONE / COMPANY_TAX_NO / COMPANY_BANK / COMPANY_SWIFT 作默认值。
 */
export interface Company {
  name: string;
  name_en: string;
  address: string;
  /** 英文地址（外销单据，可能为空） */
  address_en?: string;
  phone: string;
  /** 统一社会信用代码 / 税号 */
  tax_no: string;
  /** 开户行及账号 */
  bank: string;
  /** SWIFT 代码 */
  swift: string;
}

let cache: Promise<Company | null> | null = null;
const load = () => (cache ??= get('/auth/options', undefined, true).then((o: any) => o?.company ?? null).catch(() => null));

/** 系统设置保存后调用，下次读取最新值 */
export const invalidateCompany = () => {
  cache = null;
};

/** 单据打印抬头用的本公司信息；未配置时 name 为空 */
export function useCompany(): Company | null {
  const [c, setC] = useState<Company | null>(null);
  useEffect(() => { load().then(setC); }, []);
  return c;
}
