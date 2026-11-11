import { HttpException } from '@nestjs/common';

/** 业务规则校验失败：HTTP 400 + {detail: 中文提示} */
export class BizError extends HttpException {
  constructor(message: string, status = 400) {
    super({ detail: message }, status);
  }
}

export class NotFound extends BizError {
  constructor(what = '记录') {
    super(`${what}不存在`, 404);
  }
}
