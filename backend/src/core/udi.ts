/** UDI（GS1）工具：GTIN 校验位、UDI-PI 组合（生产日期/失效日期/批号/序列号） */
const yymmddUtc = (d: Date) => d.toISOString().slice(2, 10).replace(/-/g, '');

export function gtinCheckDigit(body: string): number {
  if (!/^\d+$/.test(body)) throw new Error('GTIN 只能包含数字');
  let total = 0;
  [...body].reverse().forEach((ch, i) => (total += Number(ch) * (i % 2 === 0 ? 3 : 1)));
  return (10 - (total % 10)) % 10;
}

export function isValidGtin(gtin: string | null | undefined): boolean {
  if (!gtin || !/^\d+$/.test(gtin) || ![8, 12, 13, 14].includes(gtin.length)) return false;
  return gtinCheckDigit(gtin.slice(0, -1)) === Number(gtin.slice(-1));
}

export function makeGtin14(companyPrefix: string, itemRef: string, indicator = '0'): string {
  const body = (indicator + companyPrefix + itemRef).slice(0, 13).padEnd(13, '0');
  return body + gtinCheckDigit(body);
}

/** GS1 人工可读格式（HRI），如 (01)06970000000017(11)261112(10)B261112001(21)RL32611120001；日期为纯日期（UTC 零点） */
export function buildUdi(gtin: string | null | undefined, o: { mfg_date?: Date | null; expiry_date?: Date | null; lot?: string | null; serial?: string | null }): string | null {
  if (!gtin) return null;
  const parts = [`(01)${gtin.padStart(14, '0')}`];
  if (o.mfg_date) parts.push(`(11)${yymmddUtc(o.mfg_date)}`);
  if (o.expiry_date) parts.push(`(17)${yymmddUtc(o.expiry_date)}`);
  if (o.lot) parts.push(`(10)${o.lot}`);
  if (o.serial) parts.push(`(21)${o.serial}`);
  return parts.join('');
}
