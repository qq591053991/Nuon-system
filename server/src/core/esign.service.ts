import { Injectable } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { AuthService } from '../auth/auth.service';
import type { CurrentUser } from '../common/context';
import { BizError } from '../common/errors';
import type { Tx } from '../common/prisma.service';

/** 电子签名：再次输入本人密码 + 理由 */
export class SignatureDto {
  @IsString() password: string;
  @IsOptional() @IsString() reason?: string | null;
}

/** 电子签名（21 CFR Part 11 §11.50/§11.200）：校验本人密码，记录签名人、时间、含义与对象 */
@Injectable()
export class EsignService {
  constructor(private readonly auth: AuthService) {}

  async sign(tx: Tx, user: CurrentUser, sig: SignatureDto | null | undefined, meaning: string, entity: string, entityId: number, docNo?: string | null) {
    if (!sig || !sig.password) throw new BizError(`此操作需要电子签名（${meaning}），请输入密码确认`);
    const v = await this.auth.verifyUserPassword(user, sig.password);
    if (!v.ok) throw new BizError(v.message || '电子签名失败：密码错误');
    return tx.eSignature.create({
      data: { username: user.username, full_name: user.full_name, meaning, entity, entity_id: entityId, doc_no: docNo ?? null, reason: sig.reason ?? null },
    });
  }
}
