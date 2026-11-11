#!/bin/sh
# =============================================================================
# Nuon 智造云：数据库 + 附件备份（POSIX sh，可在 postgres:16-alpine 容器或任意装有 pg_dump 的主机上运行）
#
# 用法：
#   backup.sh            立即备份一次（失败时退出码非 0）
#   backup.sh --loop     守护模式（docker-compose 的 backup 服务）：每天 BACKUP_AT 备份一次；
#                        启动时若当天还没有备份，先立即备份一次
#
# 环境变量：
#   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE   数据库连接（或用 DATABASE_URL=postgresql://user:pwd@host:5432/db）
#   BACKUP_DIR        备份目录（默认 ./backups）：db/ 数据库备份，attachments/ 附件镜像，backup.log 备份日志
#   BACKUP_KEEP_DAYS  数据库备份保留天数（默认 30；附件镜像不删除）
#   BACKUP_AT         守护模式每日备份时间 HH:MM（默认 02:30，容器时区 TZ）
#   ATTACHMENT_DIR    附件目录（可选）：内容寻址、永不修改，增量复制到 BACKUP_DIR/attachments
#
# 产物：BACKUP_DIR/db/<库名>_<yyyymmdd_HHMMSS>.dump（pg_dump 自定义格式，可 pg_restore 选择性恢复）+ .sha256 校验文件
# 备份失败时写 BACKUP_DIR/LAST_FAILED（监控据此告警），成功后删除。
# =============================================================================
set -u

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP="${BACKUP_KEEP_DAYS:-30}"
AT="${BACKUP_AT:-02:30}"

if [ -n "${DATABASE_URL:-}" ]; then
  CONN="$DATABASE_URL"
  DB=$(basename "${DATABASE_URL%%\?*}")
else
  DB="${PGDATABASE:-nuon}"
  CONN="$DB"
fi

log() { echo "[$(date '+%F %T')] $*"; }

# 附件增量镜像：只复制备份中还没有的文件（附件按 sha256 存放且不可修改/删除）
sync_attachments() {
  [ -n "${ATTACHMENT_DIR:-}" ] || return 0
  if [ ! -d "$ATTACHMENT_DIR" ]; then
    log "附件目录 $ATTACHMENT_DIR 不存在，跳过"
    return 0
  fi
  dst="$BACKUP_DIR/attachments"
  mkdir -p "$dst" || return 1
  n=0
  # 读取失败（目录不可读）视为备份失败
  list=$(cd "$ATTACHMENT_DIR" && find . -type f ! -name '*.tmp-*') || return 1
  for f in $list; do
    if [ ! -e "$dst/$f" ]; then
      mkdir -p "$dst/$(dirname "$f")" && cp -p "$ATTACHMENT_DIR/$f" "$dst/$f.part" && mv "$dst/$f.part" "$dst/$f" || return 1
      n=$((n + 1))
    fi
  done
  log "附件已同步：新增 $n 个，备份中共 $(find "$dst" -type f | wc -l | tr -d ' ') 个"
}

run_backup() {
  mkdir -p "$BACKUP_DIR/db" || return 1
  ts=$(date +%Y%m%d_%H%M%S)
  name="${DB}_${ts}.dump"
  out="$BACKUP_DIR/db/$name"
  log "开始备份数据库 $DB → $out"
  pg_dump -Fc -Z 6 -d "$CONN" -f "$out.part" || { rm -f "$out.part"; log "pg_dump 失败"; return 1; }
  # 校验备份文件可读（目录完整）
  pg_restore --list "$out.part" > /dev/null || { log "备份文件校验失败：$out.part"; return 1; }
  mv "$out.part" "$out" || return 1
  (cd "$BACKUP_DIR/db" && sha256sum "$name" > "$name.sha256") || return 1
  size=$(du -h "$out" | cut -f1)
  log "数据库备份完成：$name（$size）"
  sync_attachments || { log "附件同步失败"; return 1; }
  # 保留期：删除 KEEP 天前的数据库备份（附件镜像不删除）
  find "$BACKUP_DIR/db" -type f \( -name "${DB}_*.dump" -o -name "${DB}_*.dump.sha256" \) -mtime +"$KEEP" | while read -r old; do
    rm -f "$old" && log "已超过保留期 ${KEEP} 天，删除：$(basename "$old")"
  done
  echo "$(date '+%F %T') OK $name $size" >> "$BACKUP_DIR/backup.log"
  return 0
}

safe_backup() {
  if run_backup; then
    rm -f "$BACKUP_DIR/LAST_FAILED"
  else
    log "!!! 备份失败，请检查（已写入 $BACKUP_DIR/LAST_FAILED）"
    mkdir -p "$BACKUP_DIR" && date '+%F %T' > "$BACKUP_DIR/LAST_FAILED"
    echo "$(date '+%F %T') FAILED" >> "$BACKUP_DIR/backup.log"
    return 1
  fi
}

if [ "${1:-}" = "--loop" ]; then
  case "$AT" in
    [0-2][0-9]:[0-5][0-9]) ;;
    *) log "BACKUP_AT 格式应为 HH:MM，当前：$AT"; exit 2 ;;
  esac
  log "备份守护进程启动：每天 $AT 备份数据库 $DB，保留 $KEEP 天，目录 $BACKUP_DIR"
  until pg_isready -q -d "$CONN"; do
    log "等待数据库就绪…"
    sleep 5
  done
  if ! ls "$BACKUP_DIR/db/${DB}_$(date +%Y%m%d)_"*.dump > /dev/null 2>&1; then
    safe_backup || true
  fi
  last=$(date +%F)
  while true; do
    if [ "$(date +%H:%M)" = "$AT" ] && [ "$last" != "$(date +%F)" ]; then
      safe_backup || true
      last=$(date +%F)
    fi
    sleep 20
  done
fi

safe_backup
