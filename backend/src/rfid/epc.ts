/**
 * EPC 编码规则（本厂自编，96 位 = 24 位十六进制）：
 *   4E55 + 类型(2 位) + 00 + 序号(16 位十六进制)
 *     类型 01 = 包装标签（原材料料盘/箱/托盘），02 = 单台标签（成品，绑定序列号），03 = 库位标签（序号 = 库位 ID，不入标签表）
 *   例：包装 4E5501000000000000000001，库位 RAW-A01（id=1）4E5503000000000000000001。
 * 外购预编码标签（如 E280… 开头）也可直接登记：只要求 8–64 位十六进制、全局唯一。
 * 如客户要求 GS1 标准编码（SGTIN-96 / SSCC-96），可在发卡时改用 GS1 公司前缀生成，不影响其余逻辑。
 */
import { BizError } from '../common/errors';
import type { Tx } from '../common/prisma.service';
import type { NumberingService } from '../core/numbering.service';

export const EPC_PREFIX = '4E55';
export const EPC_KIND = { PACKAGE: '01', UNIT: '02', LOCATION: '03' } as const;

const hex16 = (n: number) => n.toString(16).toUpperCase().padStart(16, '0');

/** 规范化 EPC：去空格/连字符、转大写；不是 8–64 位十六进制返回 null */
export function normEpc(raw: unknown): string | null {
  const s = String(raw ?? '').replace(/[\s-]/g, '').toUpperCase();
  return /^[0-9A-F]{8,64}$/.test(s) ? s : null;
}

/** 规范化并校验（不合法时抛中文错误） */
export function mustEpc(raw: unknown): string {
  const e = normEpc(raw);
  if (!e) throw new BizError(`EPC“${String(raw ?? '')}”格式不对：应为 8–64 位十六进制（0-9、A-F），通常 24 位，印在标签上`);
  return e;
}

/** 库位标签 EPC（按库位 ID 固定生成，打印库位标签时写入） */
export const locationEpc = (locationId: number) => `${EPC_PREFIX}${EPC_KIND.LOCATION}00${hex16(locationId)}`;

/** 是否库位标签；是则返回库位 ID */
export function locationIdOfEpc(epc: string): number | null {
  if (!epc.startsWith(`${EPC_PREFIX}${EPC_KIND.LOCATION}00`) || epc.length !== 24) return null;
  const n = parseInt(epc.slice(8), 16);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 系统发卡：生成新的包装/单台 EPC（全局流水号，事务内并发安全） */
export async function newEpc(tx: Tx, numbering: NumberingService, kind: 'PACKAGE' | 'UNIT'): Promise<string> {
  const seq = await numbering.nextSeq(tx, 'EPC');
  return `${EPC_PREFIX}${EPC_KIND[kind]}00${hex16(seq)}`;
}
