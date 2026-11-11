import { Injectable } from '@nestjs/common';
import { yymmdd } from '../common/dates';
import type { Tx } from '../common/prisma.service';

/** 单据编号：前缀 + yyMMdd + 流水号，例如 SO261111001（并发安全：数据库原子自增） */
@Injectable()
export class NumberingService {
  async nextSeq(tx: Tx, key: string): Promise<number> {
    const rows = await tx.$queryRaw<{ value: number }[]>`
      INSERT INTO sys_sequence ("key", "value") VALUES (${key}, 1)
      ON CONFLICT ("key") DO UPDATE SET "value" = sys_sequence."value" + 1
      RETURNING "value"`;
    return Number(rows[0].value);
  }

  async nextNo(tx: Tx, prefix: string, width = 3, dated = true): Promise<string> {
    const key = `${prefix}${dated ? yymmdd() : ''}`;
    return `${key}${String(await this.nextSeq(tx, key)).padStart(width, '0')}`;
  }
}
