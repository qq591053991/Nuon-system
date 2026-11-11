#!/bin/sh
set -e
# 1) 数据库结构迁移（Prisma Migrate，可重复执行）
npx prisma migrate deploy
# 2) 初始化基础数据（已存在则跳过）；SEED_DEMO=1 时额外生成演示业务数据（生产环境请设为 0）
if [ "${SEED_ON_START:-1}" = "1" ]; then
  if [ "${SEED_DEMO:-0}" = "1" ]; then node dist/seed/seed.js --demo; else node dist/seed/seed.js; fi
fi
exec node dist/main.js
