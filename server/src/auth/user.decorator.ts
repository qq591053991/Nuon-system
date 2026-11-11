import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { CurrentUser } from '../common/context';

/** 当前登录用户：handler(@User() user: CurrentUser) */
export const User = createParamDecorator((_: unknown, ctx: ExecutionContext): CurrentUser => ctx.switchToHttp().getRequest().user);
