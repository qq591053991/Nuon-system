import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';

export interface CurrentUser {
  id: number;
  username: string;
  full_name: string;
  roles: string;
  password_hash: string;
  is_active: boolean;
  department?: string | null;
  auth_source?: string;
}

/** 请求上下文：当前用户 + 当前事务（审计追踪钩子据此记录操作人、并在同一事务内写审计日志） */
export interface RequestContext {
  user?: CurrentUser;
  tx?: Prisma.TransactionClient;
}

export const als = new AsyncLocalStorage<RequestContext>();

export const currentUser = () => als.getStore()?.user;
