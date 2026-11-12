# 运维手册（部署、备份恢复、记录保存、安全加固、升级）

适用于 `docker-compose.yml` 单机部署（PostgreSQL + 后端 + Nginx 前端 + 备份服务）。
本手册是计算机化系统验证（CSV）中 IQ（安装确认）与运维 SOP 的基础材料：每项检查完成后请签字留档。

---

## 1. 上线部署检查清单

| # | 检查项 | 方法 / 标准 | 结果 |
|---|---|---|---|
| 1 | 服务器 | ≥ 4 核 / 8 GB / SSD；数据盘与系统盘分开；磁盘使用率告警阈值 80% | ☐ |
| 2 | `.env` 已配置 | `DB_PASSWORD` 强密码（≥ 16 位随机）；`SECRET_KEY` ≥ 32 位随机（`openssl rand -hex 32`）；**`SEED_DEMO=0`**（正式环境不生成演示数据） | ☐ |
| 3 | 初始账号 | `SEED_DEMO=0` 时只创建 `admin`（初始密码取 `INITIAL_ADMIN_PASSWORD`，未设置则随机生成并打印在后端首次启动日志 `docker compose logs backend` 中），首次登录强制改密；登录后在“用户与角色 → 批量导入用户”用 Excel 一次建好全部员工账号（系统生成初始密码清单，员工首次登录须改密）。若曾用演示数据，用户页会提示“仍有 N 个账号使用公开演示密码”，须全部停用或重置 | ☐ |
| 4 | HTTPS | 按 §2 配置证书，HTTP 自动跳转 HTTPS；`CORS_ORIGINS` 设为实际域名（不要用 `*`） | ☐ |
| 5 | 时间同步 | 按 §7 配置 NTP，`timedatectl` 显示 `System clock synchronized: yes`，时区 Asia/Shanghai | ☐ |
| 6 | 数据库账号 | 按 §6 创建受限应用账号；应用不使用表属主/超级用户连接 | ☐ |
| 7 | 备份 | `docker compose ps backup` 运行中；`./backups/db/` 已生成当天备份；异地同步已配置（§3.3） | ☐ |
| 8 | 恢复演练 | 上线前完成第一次恢复演练并留记录（§4） | ☐ |
| 9 | 附件存储 | `attachments` 卷已纳入备份；单个附件 ≤ 20 MB（Nginx `client_max_body_size` ≥ 20m） | ☐ |
| 10 | 防火墙 | 只开放 443（及 80 跳转）；PostgreSQL 5432 不对外暴露（compose 默认未映射） | ☐ |
| 11 | 监控 | 按 §8 配置健康检查、磁盘、备份失败告警 | ☐ |
| 12 | 公司信息 | `.env` 中 `COMPANY_NAME` 等已填写（形式发票、采购单打印抬头）；`DEMO_MODE=0` | ☐ |
| 13 | 版本记录 | 记录部署的 Git 提交号、数据库迁移版本（`_prisma_migrations` 最新一条） | ☐ |

部署命令：

```bash
cp .env.example .env && vi .env          # 修改密码、密钥，SEED_DEMO=0
docker compose up -d --build
docker compose ps                         # db / backend / frontend / backup 均为 running
curl -s http://127.0.0.1:8080/api/health  # {"status":"ok",...}
```

---

## 2. HTTPS（Nginx TLS）

传输安全要求：本系统与金蝶均启用 HTTPS（金蝶账号登录时密码会经过本系统）。推荐在前端容器前再放一层宿主机 Nginx（或负载均衡）终止 TLS，
也可以把证书挂载进 `frontend` 容器、替换 `frontend/nginx.conf`。宿主机 Nginx 示例（`/etc/nginx/conf.d/nuon.conf`）：

```nginx
server {
  listen 80;
  server_name mes.example.com;
  return 301 https://$host$request_uri;          # HTTP 一律跳转 HTTPS
}

server {
  listen 443 ssl http2;
  server_name mes.example.com;

  ssl_certificate     /etc/nginx/certs/mes.example.com.fullchain.pem;
  ssl_certificate_key /etc/nginx/certs/mes.example.com.key;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers off;
  ssl_session_cache shared:SSL:10m;
  ssl_session_timeout 1d;
  add_header Strict-Transport-Security "max-age=31536000" always;

  client_max_body_size 25m;                       # 附件上限 20 MB + 表单开销

  location / {
    proxy_pass http://127.0.0.1:8080;             # docker compose 的 frontend 端口（HTTP_PORT）
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 120s;
  }
}
```

- 证书：内网可用企业 CA 签发并把根证书下发到车间终端；有公网域名可用 Let's Encrypt（`certbot --nginx`，自动续期）。
- 使用宿主机 Nginx 时，把 `.env` 中 `HTTP_PORT` 绑定到本机：在 `docker-compose.override.yml` 中写 `ports: ["127.0.0.1:8080:80"]`，避免绕过 HTTPS 直接访问。
- 金蝶云星空地址 `KINGDEE_URL` 也应使用 `https://`。

---

## 3. 备份

### 3.1 自动备份（已内置）

`docker-compose.yml` 中的 `backup` 服务（`postgres:16-alpine` 运行 `scripts/backup.sh --loop`）：

| 内容 | 方式 | 位置 |
|---|---|---|
| 数据库 | 每天 `BACKUP_AT`（默认 02:30）`pg_dump -Fc` 全量；生成后用 `pg_restore --list` 校验并写 `.sha256` | `./backups/db/nuon_yyyymmdd_HHMMSS.dump` |
| 附件 | 每次备份后增量复制（附件按 sha256 内容寻址、永不修改/删除） | `./backups/attachments/` |
| 保留 | 数据库备份保留 `BACKUP_KEEP_DAYS` 天（默认 30）；附件镜像不删除 | — |
| 日志 | 每次结果追加到 `./backups/backup.log`；失败时生成 `./backups/LAST_FAILED` | — |

可在 `.env` 中设置：`BACKUP_AT=02:30`、`BACKUP_KEEP_DAYS=30`、`BACKUP_HOST_DIR=/data/nuon-backups`（备份目录，建议放独立数据盘）。

```bash
docker compose logs -f backup                                          # 查看备份日志
docker compose exec backup sh /usr/local/bin/nuon-backup.sh            # 立即备份（升级前必做）
ls -lh ./backups/db/ && tail ./backups/backup.log
```

不使用 Docker 时，在任意装有 PostgreSQL 16 客户端的主机上：
`PGHOST=… PGUSER=… PGPASSWORD=… PGDATABASE=nuon BACKUP_DIR=/data/backups ATTACHMENT_DIR=/srv/nuon/attachments scripts/backup.sh`（可放入 cron）。

### 3.2 WAL 归档与任意时间点恢复（PITR，强烈建议）

每日全量备份最多丢失 24 小时数据。生产记录（报工、检验、放行签名）丢失后无法补录，建议开启 WAL 连续归档，使数据可恢复到任意时间点（RPO ≤ 5 分钟）：

1. 推荐使用 **pgBackRest** 或 **WAL-G**（支持压缩、校验、异地对象存储、保留策略）。最简原生配置示例（在 `db` 服务的 `command` 中追加参数，归档目录挂载独立卷）：

   ```yaml
   db:
     command: >
       postgres -c wal_level=replica -c archive_mode=on -c archive_timeout=300
                -c archive_command='test ! -f /wal_archive/%f && cp %p /wal_archive/%f'
     volumes:
       - pgdata:/var/lib/postgresql/data
       - /data/nuon-wal:/wal_archive
   ```

2. 每周做一次物理基础备份：`docker compose exec db pg_basebackup -U nuon -D /wal_archive/base_$(date +%Y%m%d) -Ft -z -X fetch`。
3. 恢复到某时刻：用基础备份初始化数据目录，设置 `restore_command='cp /wal_archive/%f %p'` 与 `recovery_target_time='2026-11-11 10:30:00+08'`，创建 `recovery.signal` 后启动。
4. WAL 归档目录与基础备份同样要异地保存；归档失败会导致 `pg_wal` 堆积占满磁盘，必须监控（§8）。

### 3.3 异地 / 离线保存（3-2-1 原则）

至少 3 份副本、2 种介质、1 份异地：每天把 `./backups` 同步到另一台服务器或对象存储（只追加、启用版本/防删除），例如：

```bash
# /etc/cron.d/nuon-offsite：每天 04:00 同步到异地备份服务器（只增不删）
0 4 * * * root rsync -a --ignore-existing /data/nuon-backups/ backup@10.0.9.20:/backup/nuon/
```

每月另做一份离线介质（移动硬盘/磁带）并加密保存。备份包含全部生产与质量记录，按受控数据管理（访问权限、加密、出入库登记）。

---

## 4. 恢复与恢复演练

### 4.1 恢复演练（每季度一次，留记录）

演练恢复到**新库**，不影响生产：

```bash
docker compose exec backup sh /usr/local/bin/nuon-restore.sh /backups/db/nuon_20261111_023000.dump nuon_restore_test
```

脚本会：校验 sha256 → 校验备份结构 → （目标库已存在时要求输入库名确认）→ 恢复 → 输出核对数据（用户数、订单/工单数、库存流水、电子签名、附件记录、审计追踪条数与哈希链校验结果）。
核对后可启动一个临时后端连接该库做抽查（如按序列号追溯、打开一份 DHR、下载一个附件），完成后删除：`docker compose exec backup dropdb nuon_restore_test`。

**恢复演练记录（模板）**

| 项目 | 记录 |
|---|---|
| 演练编号 / 日期 | DR-2026Q4-01 / 2026-__-__ |
| 执行人 / 复核人（QA） | |
| 使用的备份文件 | `nuon_yyyymmdd_HHMMSS.dump`（sha256 前 8 位：________）；备份来源：本机 / 异地 / 离线介质 |
| 恢复目标 | `nuon_restore_test`（独立库） |
| 开始 / 结束时间、耗时（RTO） | |
| 恢复后数据时间点（RPO） | 审计追踪最新时间：________ |
| 核对数据（脚本输出） | 用户数 __；工单 __；库存流水 __；电子签名 __；附件记录 __；审计追踪 __ 条，哈希链异常 __ 处 |
| 业务抽查 | ☐ 序列号反向追溯完整　☐ DHR 可打开且签名完整　☐ 附件可下载且校验通过　☐ 可正常登录 |
| 附件恢复 | ☐ `./backups/attachments` 文件数与 `sys_attachment` 记录数一致 |
| 结论 | ☐ 合格　☐ 不合格（偏差编号：____，纠正措施：____） |
| 签字 | 执行人：______　QA：______ |

### 4.2 灾难恢复（生产库）

1. 立即备份当前状态（即使已损坏，也保留现场）：`docker compose exec backup sh /usr/local/bin/nuon-backup.sh`。
2. 恢复到新库并核对：`nuon-restore.sh <最近的备份> nuon_restored`（有 WAL 归档时按 §3.2 做时间点恢复）。
3. 停应用并切换库名：
   ```bash
   docker compose stop backend
   docker compose exec db psql -U nuon -d postgres -c 'ALTER DATABASE nuon RENAME TO nuon_broken_20261111' \
                                                  -c 'ALTER DATABASE nuon_restored RENAME TO nuon'
   docker compose start backend
   ```
4. 附件：把 `./backups/attachments/` 复制回 `attachments` 卷（内容寻址，直接覆盖合并即可）。
5. 备份时间点之后的业务需按纸质/现场记录补录，补录作为偏差处理并由 QA 审核。

`nuon-restore.sh` 也可直接覆盖生产库（需先停后端，并输入 `RESTORE nuon` 确认），但不推荐。

---

## 5. 记录保存期限

医疗器械生产记录保存期限不得少于产品寿命期，且自产品放行之日起不少于 2 年（以企业质量体系文件与注册人质量协议规定为准，二者取长）。建议：

| 记录 | 系统中的位置 | 建议保存期限 |
|---|---|---|
| DHR（工单、报工、测试数据、关键件、放行签名） | mes_*、sys_esignature | 产品寿命期 + 2 年（如寿命 5 年 → ≥ 7 年），且不短于质量协议要求 |
| 来料检验、NCR、CAPA、客诉、客户退货、附件 | qms_*、wms_customer_return、sys_attachment + 附件文件 | 同上 |
| 库存流水、发货（追溯召回） | wms_* | 同上 |
| 审计追踪、电子签名 | sys_audit_log、sys_esignature | 与所关联记录相同 |
| 备份文件 | ./backups、异地/离线介质 | 日备份 30 天；每月保留 1 份月末备份至少 1 年；每年保留 1 份年末备份至记录保存期满 |

- 系统内记录**不做物理删除**：电子签名、库存流水、审计追踪由数据库触发器禁止修改/删除；附件不提供删除接口。
- 保存期满需销毁时，须经 QA 批准并形成销毁记录；在线库不做删除，可将整库归档备份后离线保存。

---

## 6. 生产数据库账号加固

数据库触发器已禁止 UPDATE/DELETE `sys_esignature`、`wms_stock_move`，并禁止修改/删除 `sys_audit_log` 内容。但**表属主或超级用户**仍可 `TRUNCATE`（不触发行级触发器）、`ALTER TABLE … DISABLE TRIGGER` 或 `DROP`。因此生产环境应区分账号：

| 账号 | 用途 | 权限 |
|---|---|---|
| `postgres`（超级用户） | 仅 DBA 应急使用，密码双人保管 | 全部 |
| `nuon`（表属主） | 执行数据库迁移（升级时）、备份 | 属主（`POSTGRES_USER`） |
| `nuon_app`（应用） | 后端日常运行 | 只有增删改查，**无 TRUNCATE、无 ALTER/DROP**，关键表不可改删 |

用 `nuon` 账号执行（`docker compose exec db psql -U nuon -d nuon`）：

```sql
-- 应用账号（密码请替换）
CREATE ROLE nuon_app LOGIN PASSWORD '请替换为强密码';
GRANT CONNECT ON DATABASE nuon TO nuon_app;
GRANT USAGE ON SCHEMA public TO nuon_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nuon_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO nuon_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO nuon_app;
-- 以后迁移新建的表自动授权
ALTER DEFAULT PRIVILEGES FOR ROLE nuon IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nuon_app;
ALTER DEFAULT PRIVILEGES FOR ROLE nuon IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO nuon_app;

-- 电子记录：只增不改
REVOKE UPDATE, DELETE, TRUNCATE ON sys_esignature, wms_stock_move, sys_attachment FROM nuon_app;
-- 审计追踪：只允许插入，以及封存时写入哈希链三列
REVOKE UPDATE, DELETE, TRUNCATE ON sys_audit_log FROM nuon_app;
GRANT UPDATE (prev_hash, hash, seal_no) ON sys_audit_log TO nuon_app;
-- 应用账号不能建表/改表
REVOKE CREATE ON SCHEMA public FROM nuon_app;
```

然后在 `docker-compose.override.yml` 中让后端使用应用账号：

```yaml
services:
  backend:
    environment:
      DATABASE_URL: postgresql://nuon_app:应用账号密码@db:5432/nuon
```

- 后端启动时会执行 `prisma migrate deploy`：没有待执行的迁移时只读取迁移表，应用账号即可通过；**有新迁移时须先用 `nuon` 账号执行迁移**（见 §9）。
- 每次迁移后重新执行上面的 `REVOKE`/`GRANT` 语句（幂等），并检查：
  `SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee='nuon_app' AND table_name IN ('sys_audit_log','sys_esignature','wms_stock_move','sys_attachment');`
- 数据库端口不对外开放；DBA 直连需经跳板机并记录。

---

## 7. 时间同步（NTP）

审计追踪、电子签名的时间戳必须准确（Part 11 §11.10(e)）。所有容器使用宿主机时钟：

```bash
sudo timedatectl set-timezone Asia/Shanghai
sudo apt install -y chrony         # CentOS/麒麟：yum install chrony
# /etc/chrony/chrony.conf（内网有时间服务器时优先用内网）
#   server ntp.aliyun.com iburst
#   server ntp.tencent.com iburst
#   server cn.pool.ntp.org iburst
sudo systemctl enable --now chrony
chronyc tracking                    # System time 偏差应 < 1 秒
timedatectl                         # System clock synchronized: yes
```

- 车间工位电脑、平板也要同步时间（域控或同一 NTP 源），避免纸质记录与系统时间不一致。
- 每月检查一次偏差并记录；偏差 > 1 分钟按偏差处理。

---

## 8. 监控与日志

| 监控项 | 方法 | 告警条件 |
|---|---|---|
| 应用存活 | `GET /api/health`（无需登录） | 连续 3 次失败 |
| 容器状态 | `docker compose ps`；`restart: unless-stopped` 自动拉起 | 任一服务非 running |
| 备份 | `./backups/LAST_FAILED` 存在，或最新备份超过 26 小时：`find ./backups/db -name '*.dump' -mmin -1560 \| grep -q .` | 失败 / 超时 |
| 磁盘 | 数据盘、备份盘、Docker 目录使用率 | > 80% |
| 数据库 | 连接数、长事务、`pg_wal` 大小（开启归档时） | 归档失败 / WAL 堆积 |
| 证书 | HTTPS 证书到期日 | < 30 天 |
| 审计哈希链 | `docker compose exec db psql -U nuon -d nuon -Atc 'SELECT count(*) FROM audit_verify()'` | 结果 > 0（记录被篡改，立即上报 QA） |

可用 Zabbix / Prometheus（node_exporter、postgres_exporter）或简单的 cron + 企业微信/钉钉机器人脚本实现。

日志：

- 容器日志已在 `docker-compose.yml` 中配置轮转（json-file，单文件 20 MB × 10 个）。查看：`docker compose logs --since 1h backend`。
- 宿主机 Nginx 日志用系统自带 logrotate（按天轮转、保留 90 天、压缩）。
- 业务操作记录以系统内**审计追踪**为准（不依赖容器日志），容器日志仅用于故障排查。

---

## 9. 升级流程

数据库结构变更由 Prisma 迁移脚本（`backend/prisma/migrations/`）管理；**后端容器每次启动都会执行 `npx prisma migrate deploy`**（`backend/docker-entrypoint.sh`），只执行尚未执行过的迁移，可重复执行。

1. **变更控制**：升级前填写变更申请（版本号、变更内容、影响评估、回退方案），QA 批准；涉及 GxP 功能的变更按验证计划在测试环境执行 OQ 用例。
2. **测试环境验证**：用最近一次生产备份恢复到测试环境（§4.1），在测试环境部署新版本并验证。
3. **升级前备份**：`docker compose exec backup sh /usr/local/bin/nuon-backup.sh`，记录备份文件名。
4. **发布**：
   ```bash
   git fetch && git checkout <版本标签>
   docker compose build backend frontend
   # 使用受限应用账号（§6）时：先用表属主执行迁移
   docker compose run --rm -e DATABASE_URL=postgresql://nuon:${DB_PASSWORD}@db:5432/nuon --entrypoint npx backend prisma migrate deploy
   docker compose up -d
   docker compose logs --tail 100 backend      # 确认迁移完成、服务启动
   ```
5. **升级后检查**：`/api/health` 正常；登录、扫码报工、IQC、追溯、DHR 抽查；`SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 3` 与发布说明一致；重新执行 §6 的授权语句。
6. **回退**：迁移一般不可逆。回退 = 停服务 → 按 §4.2 恢复升级前备份 → 部署旧版本镜像；升级期间产生的数据需补录。

---

## 10. 附件存储

- 附件（检验照片、COA、校准证书、送货单、客诉材料）保存在 `attachments` 卷（容器内 `/app/data/attachments`，环境变量 `ATTACHMENT_DIR`），按文件内容 sha256 存放，相同文件只存一份。
- 数据库 `sys_attachment` 记录原文件名、大小、sha256、上传人、时间；下载时重新校验 sha256，内容被篡改或损坏会拒绝下载并提示从备份恢复。
- 附件是质量证据，系统不提供删除；上传错误时补充说明并重新上传正确文件。
- 单个文件上限 20 MB（`ATTACHMENT_MAX_MB`）；前端 Nginx 的 `client_max_body_size` 需不小于该值。
