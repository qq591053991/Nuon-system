/** 数值型环境变量：未设置或为空时取默认值（允许显式设为 0） */
const numEnv = (name: string, def: number) => (process.env[name]?.trim() ? Number(process.env[name]) : def);

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
  /** 登录安全：连续失败 N 次锁定 M 分钟 */
  loginMaxFailures: Number(process.env.LOGIN_MAX_FAILURES || 5),
  loginLockMinutes: Number(process.env.LOGIN_LOCK_MINUTES || 15),
  /** 密码策略：最小长度；是否须同时包含字母与数字；有效期天数（0 = 不过期，过期后须先改密码才能继续使用） */
  passwordMinLength: Number(process.env.PASSWORD_MIN_LENGTH || 8),
  passwordRequireLetterDigit: process.env.PASSWORD_REQUIRE_LETTER_DIGIT !== '0',
  passwordMaxAgeDays: numEnv('PASSWORD_MAX_AGE_DAYS', 90),
  /** 办公端空闲超时（分钟，0 = 不启用）：前端无操作超时自动退出登录 */
  idleTimeoutMinutes: numEnv('IDLE_TIMEOUT_MINUTES', 30),
  /** 审计追踪哈希链封存间隔（秒，0 = 不自动封存；测试环境 NODE_ENV=test 时不启动） */
  auditSealIntervalSeconds: numEnv('AUDIT_SEAL_INTERVAL_SECONDS', 60),
  /** 金蝶云星空（K/3 Cloud）账号登录集成 */
  kingdee: {
    enabled: process.env.KINGDEE_ENABLED === '1',
    /** K/3 Cloud 站点地址，如 http://192.168.1.10/k3cloud/ 或 https://xxx.ik3cloud.com/k3cloud/ */
    url: process.env.KINGDEE_URL || '',
    /** 数据中心 ID（账套 ID），在金蝶“管理中心 → 数据中心列表”中查看 */
    acctId: process.env.KINGDEE_ACCT_ID || '',
    /** 语言：2052 = 简体中文 */
    lcid: Number(process.env.KINGDEE_LCID || 2052),
    timeoutMs: Number(process.env.KINGDEE_TIMEOUT_MS || 8000),
    /** 金蝶账号首次登录时是否自动开通本系统账号 */
    autoCreate: process.env.KINGDEE_AUTO_CREATE !== '0',
    /** 自动开通账号的默认角色（逗号分隔，如 operator）；默认为空 = 需管理员分配角色后才能访问业务数据 */
    defaultRoles: process.env.KINGDEE_DEFAULT_ROLES || '',
  },
  /** 仅测试环境：开放 POST /api/test/reset 用于重置数据库 */
  enableTestReset: process.env.ENABLE_TEST_RESET === '1',
  /** 本位币：报表/驾驶舱金额统一折算为该币别（汇率表 md_exchange_rate：1 外币 = rate 本位币） */
  baseCurrency: (process.env.BASE_CURRENCY || 'CNY').trim().toUpperCase(),
  /** 人员上岗资质：报工时校验操作员持有该工序（或 *）的有效资质（REQUIRE_QUALIFICATION=0 关闭） */
  requireQualification: !['0', 'false'].includes((process.env.REQUIRE_QUALIFICATION || '').trim().toLowerCase()),
  /** 附件存储目录（按 sha256 内容寻址存放，生产环境挂载持久卷并纳入备份）；运行时读取，便于测试覆盖 */
  get attachmentDir(): string {
    return process.env.ATTACHMENT_DIR || './data/attachments';
  },
  /** 单个附件大小上限（MB） */
  attachmentMaxMb: numEnv('ATTACHMENT_MAX_MB', 20),
};
