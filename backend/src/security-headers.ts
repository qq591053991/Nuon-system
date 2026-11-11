/**
 * 安全响应头（不引入 helmet 依赖的精简实现）。
 * CSP 与前端构建产物兼容：脚本只允许同源外链（构建产物无内联脚本）；Ant Design 使用内联样式，style-src 需 'unsafe-inline'。
 * 与 frontend/nginx.conf 中的配置保持一致。
 */
import type { NextFunction, Request, Response } from 'express';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), payment=(), usb=()',
};

export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  // 仅在 HTTPS（含反向代理转发的 HTTPS）下声明 HSTS，内网 HTTP 部署不受影响
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  // 接口数据含业务/个人信息，不允许浏览器或中间代理缓存
  if (req.path.startsWith('/api/') && !req.path.startsWith('/api/docs')) res.setHeader('Cache-Control', 'no-store');
  next();
}
