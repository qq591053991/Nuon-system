#!/bin/sh
# =============================================================================
# Nuon 智造云：从 pg_dump 备份恢复到指定数据库（恢复演练 / 灾难恢复）
#
# 用法：
#   restore.sh <备份文件.dump> <目标数据库名> [--yes]
#
#   恢复演练（推荐，每季度一次）：恢复到一个新库，不影响生产：
#     docker compose exec backup sh /usr/local/bin/nuon-restore.sh /backups/db/nuon_20261111_023000.dump nuon_restore_test
#   灾难恢复：先恢复到新库并核对，再停应用、改库名切换（见 docs/operations.md §4）；
#     直接覆盖生产库需输入确认短语，且 --yes 无效。
#
# 环境变量：PGHOST PGPORT PGUSER PGPASSWORD（需有建库权限的账号）；PGDATABASE = 生产库名（默认 nuon，用于防误覆盖）
# 安全措施：sha256 校验 → pg_restore --list 校验 → 目标库已存在且非空时必须输入库名确认 → 恢复后输出核对数据（填入演练记录）
# =============================================================================
set -u

FILE="${1:-}"
TARGET="${2:-}"
YES="${3:-}"
PROD="${PROD_DATABASE:-${PGDATABASE:-nuon}}"

die() { echo "错误：$*" >&2; exit 1; }
log() { echo "[$(date '+%F %T')] $*"; }
confirm() {
  # $1 = 提示, $2 = 需要输入的确认文字
  printf '%s\n请输入 %s 确认（其他任意输入取消）：' "$1" "$2"
  read -r ans || ans=""
  [ "$ans" = "$2" ] || die "已取消，未做任何修改"
}

[ -n "$FILE" ] && [ -n "$TARGET" ] || { sed -n '2,17p' "$0"; exit 2; }
[ -f "$FILE" ] || die "备份文件不存在：$FILE"
case "$TARGET" in
  postgres | template0 | template1) die "不能恢复到系统库 $TARGET" ;;
  *[!a-zA-Z0-9_]*) die "目标库名只能包含字母、数字、下划线：$TARGET" ;;
esac

# 1) 备份文件校验
if [ -f "$FILE.sha256" ]; then
  (cd "$(dirname "$FILE")" && sha256sum -c "$(basename "$FILE").sha256" > /dev/null) || die "sha256 校验失败：备份文件已损坏或被修改"
  log "sha256 校验通过"
else
  log "警告：未找到 $FILE.sha256，跳过 sha256 校验"
fi
pg_restore --list "$FILE" > /dev/null || die "备份文件无法读取（不是有效的 pg_dump 自定义格式）"
log "备份文件结构校验通过：$(pg_restore --list "$FILE" | grep -c 'TABLE DATA') 张表的数据"

# 2) 目标库安全检查
psql_admin() { psql -X -v ON_ERROR_STOP=1 -d postgres -Atc "$1"; }
exists=$(psql_admin "SELECT 1 FROM pg_database WHERE datname = '$TARGET'") || die "无法连接数据库服务器（检查 PGHOST/PGUSER/PGPASSWORD）"
if [ "$TARGET" = "$PROD" ]; then
  echo "!!! 目标是生产库【$TARGET】：现有数据将被备份内容整体替换，备份时间点之后的数据全部丢失！"
  echo "!!! 推荐做法：恢复到新库核对无误后，停应用再改库名切换（docs/operations.md §4）。"
  echo "!!! 继续前请先停止应用：docker compose stop backend"
  confirm "确认覆盖生产库？" "RESTORE $TARGET"
elif [ "$exists" = "1" ]; then
  tables=$(psql -X -d "$TARGET" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'") || tables="?"
  if [ "$tables" != "0" ]; then
    if [ "$YES" = "--yes" ]; then
      log "目标库 $TARGET 已存在（$tables 张表），--yes：将删除重建"
    else
      confirm "目标库【$TARGET】已存在且有 $tables 张表，将被删除重建。" "$TARGET"
    fi
  fi
fi

# 3) 重建目标库并恢复
if [ "$exists" = "1" ]; then
  dropdb --force "$TARGET" || die "删除目标库失败（是否仍有连接？）"
fi
createdb -E UTF8 -T template0 "$TARGET" || die "创建数据库 $TARGET 失败"
log "开始恢复 $FILE → $TARGET"
pg_restore --no-owner --no-privileges --exit-on-error -d "$TARGET" "$FILE" || die "恢复失败（目标库 $TARGET 可能不完整，请删除后重试）"
log "恢复完成"

# 4) 核对（结果请填入恢复演练记录）
q() { psql -X -d "$TARGET" -Atc "$1" 2>/dev/null || echo "-"; }
echo "------------------------------------------------------------"
echo "恢复核对：$TARGET（来自 $(basename "$FILE")）"
echo "  数据库迁移版本     ：$(q "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1")"
echo "  用户数             ：$(q 'SELECT count(*) FROM sys_user')"
echo "  销售订单 / 工单    ：$(q 'SELECT count(*) FROM erp_sales_order') / $(q 'SELECT count(*) FROM mes_work_order')"
echo "  库存行 / 库存流水  ：$(q 'SELECT count(*) FROM wms_stock') / $(q 'SELECT count(*) FROM wms_stock_move')"
echo "  电子签名           ：$(q 'SELECT count(*) FROM sys_esignature')"
echo "  附件记录           ：$(q 'SELECT count(*) FROM sys_attachment')"
echo "  审计追踪条数       ：$(q 'SELECT count(*) FROM sys_audit_log')（最新 $(q "SELECT to_char(max(ts), 'YYYY-MM-DD HH24:MI:SS') FROM sys_audit_log")）"
echo "  审计哈希链校验     ：$(q 'SELECT count(*) FROM audit_verify()') 处异常（0 = 完整）"
echo "------------------------------------------------------------"
[ "$TARGET" = "$PROD" ] && echo "生产库已恢复，请核对后启动应用：docker compose start backend"
exit 0
