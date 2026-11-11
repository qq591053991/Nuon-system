/**
 * 审计追踪封存与完整性校验（21 CFR Part 11 §11.10(e)）。
 *  - 定时封存：每隔 AUDIT_SEAL_INTERVAL_SECONDS 秒（默认 60）调用数据库函数 audit_seal()，
 *    把新产生的审计记录按顺序接入 sha256 哈希链（prev_hash / hash / seal_no）。
 *  - 校验：audit_verify() 复算整条链，返回内容被篡改、或链条断裂（记录被删除/插入）的记录。
 * 封存/校验算法都在数据库函数中（见迁移 20261111210000_review_improvements），保证多实例部署时结果一致（函数内有咨询锁）。
 * 测试环境（NODE_ENV=test）不启动定时器，测试中直接调用 seal()/verify()。
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { config } from '../config';
import { PrismaService } from '../common/prisma.service';

export interface AuditVerifyResult {
  ok: boolean;
  /** 已封存（纳入哈希链）的记录总数 */
  sealed_total: number;
  /** 本次校验前新封存的记录数 */
  sealed_now: number;
  /** 问题记录：被篡改 / 链条不连续 */
  problems: { id: number; seal_no: number; problem: string }[];
  verified_at: Date;
}

@Injectable()
export class AuditSealService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AuditSeal');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly db: PrismaService) {}

  onModuleInit() {
    const sec = config.auditSealIntervalSeconds;
    if (process.env.NODE_ENV === 'test' || !(sec > 0)) return;
    this.timer = setInterval(() => void this.tick(), sec * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.seal();
    } catch (e) {
      this.log.error(`审计追踪封存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.running = false;
    }
  }

  /** 封存所有未封存的审计记录，返回本次封存条数 */
  async seal(): Promise<number> {
    const [r] = await this.db.base.$queryRaw<{ n: number }[]>`SELECT audit_seal() AS n`;
    return Number(r?.n ?? 0);
  }

  /** 先封存，再校验整条哈希链 */
  async verify(): Promise<AuditVerifyResult> {
    const sealedNow = await this.seal();
    const problems = await this.db.base.$queryRaw<{ id: number; seal_no: number; problem: string }[]>`
      SELECT id, seal_no, problem FROM audit_verify()`;
    const [{ n }] = await this.db.base.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM "sys_audit_log" WHERE seal_no IS NOT NULL`;
    return {
      ok: problems.length === 0,
      sealed_total: Number(n),
      sealed_now: sealedNow,
      problems: problems.map((p) => ({ id: Number(p.id), seal_no: Number(p.seal_no), problem: p.problem })),
      verified_at: new Date(),
    };
  }
}
