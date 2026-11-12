/**
 * 系统设置（sys_setting 键值表，R1）：目前只有“公司信息”（单据打印抬头：形式发票、采购单、出入库单等）。
 *  - 键 company，值为 JSON：{ name, name_en, address, address_en, phone, tax_no, bank, swift }；
 *  - 未在系统设置中维护的项用环境变量（COMPANY_NAME 等，见 config.company）作默认值；
 *  - 保存时逐项写审计（对象“系统设置”，字段 company.xxx 旧值→新值）。设置表无数字主键，故用 db.base 写入并手工记审计。
 */
import { config } from '../config';
import type { PrismaService } from '../common/prisma.service';

export interface CompanyInfo {
  /** 公司中文名 */
  name: string;
  /** 公司英文名（外销单据） */
  name_en: string;
  address: string;
  /** 英文地址（外销单据，可空） */
  address_en: string;
  phone: string;
  /** 统一社会信用代码 / 税号 */
  tax_no: string;
  /** 开户行及账号 */
  bank: string;
  /** SWIFT 代码（外币收款） */
  swift: string;
}

export const COMPANY_KEYS: (keyof CompanyInfo)[] = ['name', 'name_en', 'address', 'address_en', 'phone', 'tax_no', 'bank', 'swift'];
export const COMPANY_LABELS: Record<keyof CompanyInfo, string> = {
  name: '公司名称', name_en: '英文名称', address: '地址', address_en: '英文地址', phone: '电话', tax_no: '税号', bank: '开户行及账号', swift: 'SWIFT',
};

const SETTING_COMPANY = 'company';

/** 环境变量中的默认公司信息 */
function envCompany(): CompanyInfo {
  const c = (config as unknown as { company?: Partial<Record<string, string>> }).company ?? {};
  const out = {} as CompanyInfo;
  for (const k of COMPANY_KEYS) out[k] = String(c[k] ?? process.env[`COMPANY_${k.toUpperCase()}`] ?? '');
  return out;
}

/** 当前公司信息：系统设置优先，空项用环境变量默认值 */
export async function getCompany(db: PrismaService): Promise<CompanyInfo & { updated_at: Date | null; updated_by: string | null }> {
  const env = envCompany();
  const row = await db.base.systemSetting.findUnique({ where: { key: SETTING_COMPANY } }).catch(() => null);
  let saved: Partial<CompanyInfo> = {};
  try {
    saved = row ? JSON.parse(row.value) : {};
  } catch {
    saved = {};
  }
  const out = {} as CompanyInfo;
  for (const k of COMPANY_KEYS) out[k] = String(saved[k] ?? '').trim() || env[k];
  return { ...out, updated_at: row?.updated_at ?? null, updated_by: row?.updated_by ?? null };
}

/** 保存公司信息（管理员）；返回保存后的值 */
export async function saveCompany(db: PrismaService, input: Partial<CompanyInfo>, user: { username: string; full_name: string }) {
  const before = await getCompany(db);
  const next = {} as CompanyInfo;
  for (const k of COMPANY_KEYS) next[k] = String(input[k] ?? '').trim().slice(0, 500);
  const changes: Record<string, [string, string]> = {};
  for (const k of COMPANY_KEYS) if ((before[k] || '') !== next[k]) changes[`company.${k}`] = [before[k] || '', next[k]];
  await db.base.$transaction(async (tx) => {
    await tx.systemSetting.upsert({
      where: { key: SETTING_COMPANY },
      create: { key: SETTING_COMPANY, value: JSON.stringify(next), updated_by: user.username },
      update: { value: JSON.stringify(next), updated_by: user.username },
    });
    if (Object.keys(changes).length) {
      await tx.auditLog.create({
        data: { username: user.username, full_name: user.full_name, entity: 'sys_setting', entity_id: null, action: 'UPDATE', changes: JSON.stringify(changes) },
      });
    }
  });
  return getCompany(db);
}
