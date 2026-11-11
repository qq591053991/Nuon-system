import { ArgumentsHost, CallHandler, Catch, ExceptionFilter, ExecutionContext, HttpException, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { map, type Observable } from 'rxjs';
import { DATE_FIELDS } from './dates';

/** 统一错误格式：{detail: "中文提示"}（与前端约定一致） */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Error');

  catch(exc: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let detail: unknown = '服务器内部错误';
    if (exc instanceof HttpException) {
      status = exc.getStatus();
      const body: any = exc.getResponse();
      if (body && typeof body === 'object' && 'detail' in body) detail = body.detail;
      else if (body && typeof body === 'object' && Array.isArray(body.message)) detail = body.message.join('；');
      else detail = (body && typeof body === 'object' ? body.message : body) || exc.message;
    } else if (exc instanceof Prisma.PrismaClientKnownRequestError) {
      if (exc.code === 'P2002') [status, detail] = [400, '编码/单号已存在，不能重复'];
      else if (exc.code === 'P2003') [status, detail] = [400, '关联数据不存在或已被业务单据引用（被引用的数据不能删除，可改为停用）'];
      else if (exc.code === 'P2000') [status, detail] = [400, '输入内容过长，请缩短后重试'];
      else if (exc.code === 'P2025') [status, detail] = [404, '记录不存在'];
      else this.log.error(exc.message);
    } else {
      this.log.error(exc instanceof Error ? exc.stack : String(exc));
    }
    res.status(status).json({ detail });
  }
}

function toJson(v: unknown, key = ''): unknown {
  if (v instanceof Prisma.Decimal) return v.toNumber();
  if (v instanceof Date) return DATE_FIELDS.has(key) ? v.toISOString().slice(0, 10) : v.toISOString();
  if (Array.isArray(v)) return v.map((x) => toJson(x, key));
  if (v && typeof v === 'object' && v.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = toJson(x, k);
    return out;
  }
  return v;
}

/** 响应序列化：纯日期字段输出 YYYY-MM-DD，其余时间输出 ISO 8601；成功的 POST 统一返回 200（与原接口约定一致） */
@Injectable()
export class JsonInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    if (http.getRequest()?.method === 'POST') http.getResponse()?.status(200);
    return next.handle().pipe(map((d) => toJson(d)));
  }
}
