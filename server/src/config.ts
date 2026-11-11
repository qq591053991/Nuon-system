/** 全局配置：全部可通过环境变量覆盖 */
export const config = {
  appName: process.env.APP_NAME || 'Nuon 智造云 · 光疗器械代工一体化平台',
  port: Number(process.env.PORT || 8000),
  secretKey: process.env.SECRET_KEY || 'nuon-dev-secret-key-change-me-in-production-0123456789',
  tokenExpireMinutes: Number(process.env.TOKEN_EXPIRE_MINUTES || 720),
  timezone: process.env.TZ_NAME || 'Asia/Shanghai',
  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').filter(Boolean),
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 12),
  gs1CompanyPrefix: process.env.GS1_COMPANY_PREFIX || '697000000',
  /** 仅测试环境：开放 POST /api/test/reset 用于重置数据库 */
  enableTestReset: process.env.ENABLE_TEST_RESET === '1',
};
