import { useEffect, useState } from 'react';
import { get } from '../api/http';

/** 本公司信息（后端环境变量 COMPANY_NAME / COMPANY_NAME_EN / COMPANY_ADDRESS / COMPANY_PHONE / COMPANY_TAX_NO / COMPANY_BANK） */
export interface Company { name: string; name_en: string; address: string; phone: string; tax_no: string; bank: string }

let cache: Promise<Company | null> | null = null;
const load = () => (cache ??= get('/auth/options', undefined, true).then((o: any) => o?.company ?? null).catch(() => null));

/** 单据打印抬头用的本公司信息；未配置时 name 为空 */
export function useCompany(): Company | null {
  const [c, setC] = useState<Company | null>(null);
  useEffect(() => { load().then(setC); }, []);
  return c;
}
