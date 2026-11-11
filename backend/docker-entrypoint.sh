#!/bin/sh
set -e
# 首次启动初始化基础数据；SEED_DEMO=1 时额外生成演示业务数据（生产环境请设为 0）
if [ "${SEED_ON_START:-1}" = "1" ]; then
  if [ "${SEED_DEMO:-0}" = "1" ]; then
    python -m app.seed --demo
  else
    python -m app.seed
  fi
fi
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers "${WORKERS:-2}" --proxy-headers
