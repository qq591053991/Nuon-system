/**
 * 附件存储：检验照片、COA、校准证书、送货单、客诉图片等，可挂在任意业务单据上（entity = 表名，entity_id = 记录 ID）。
 *   - 文件按内容 sha256 寻址存放：<ATTACHMENT_DIR>/<sha[0..2]>/<sha[2..4]>/<sha>，相同内容只存一份；
 *   - 数据库 sys_attachment 记录原文件名、类型、大小、sha256、上传人、时间（新增自动进入审计追踪）；
 *   - 下载时重新计算 sha256 校验，内容被篡改/损坏时拒绝下载；
 *   - 质量证据永久保存：不提供删除接口。
 */
import { Injectable } from '@nestjs/common';
import { Prisma, type Attachment } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { CurrentUser } from '../common/context';
import { BizError, NotFound } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { config } from '../config';

export interface UploadedFileLike {
  originalname: string;
  mimetype?: string;
  size: number;
  buffer: Buffer;
}

const MODELS = Prisma.dmmf.datamodel.models;
/** 不允许挂附件的系统表 */
const DENY = new Set(['sys_attachment', 'sys_audit_log', 'sys_esignature', 'sys_sequence', 'sys_user']);

/** 表名 → Prisma 委托名（仅限有整型 id 主键的业务表） */
function delegateOf(entity: string): string | null {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(entity) || DENY.has(entity)) return null;
  const m = MODELS.find((x) => (x.dbName ?? x.name) === entity);
  if (!m || !m.fields.some((f) => f.name === 'id' && f.type === 'Int' && f.isId)) return null;
  return m.name.charAt(0).toLowerCase() + m.name.slice(1);
}

/** 原文件名清理：去掉路径、控制字符，限制长度（保留扩展名） */
export function cleanFilename(name: string): string {
  let n = basename(String(name || '').replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  if (!n || n === '.' || n === '..') n = 'file';
  if (n.length > 200) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : '';
    n = n.slice(0, 200 - ext.length) + ext;
  }
  return n;
}

@Injectable()
export class AttachmentsService {
  constructor(private readonly db: PrismaService) {}

  private root() {
    return resolve(config.attachmentDir);
  }

  private pathOf(storageKey: string) {
    const p = resolve(this.root(), storageKey);
    if (!p.startsWith(this.root())) throw new BizError('附件存储路径无效');
    return p;
  }

  /** 校验挂载对象（表 + 记录）存在 */
  private async checkEntity(entity: string, entityId: number) {
    const d = delegateOf(entity);
    if (!d) throw new BizError(`不支持在“${entity}”上挂附件`);
    if (!Number.isInteger(entityId) || entityId <= 0) throw new BizError('entity_id 无效');
    const row = await (this.db.client as any)[d].findUnique({ where: { id: entityId }, select: { id: true } });
    if (!row) throw new NotFound('附件所属单据');
  }

  async upload(file: UploadedFileLike | undefined, entity: string, entityId: number, user: CurrentUser): Promise<Attachment> {
    if (!file || !file.buffer) throw new BizError('请选择要上传的文件');
    if (!file.size) throw new BizError('不能上传空文件');
    if (file.size > config.attachmentMaxMb * 1024 * 1024) throw new BizError(`附件不能超过 ${config.attachmentMaxMb} MB`);
    await this.checkEntity(entity, entityId);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const storage_key = `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
    const path = this.pathOf(storage_key);
    if (!existsSync(path)) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
      await writeFile(tmp, file.buffer, { flag: 'wx' });
      await rename(tmp, path); // 原子落盘
    }
    return this.db.tx((tx) =>
      tx.attachment.create({
        data: {
          entity, entity_id: entityId, filename: cleanFilename(file.originalname), content_type: (file.mimetype || '').slice(0, 128) || null,
          size: file.size, sha256, storage_key, uploaded_by: user.username,
        },
      }),
    );
  }

  async list(entity: string, entityId: number) {
    if (!entity || !Number.isInteger(entityId)) throw new BizError('缺少参数 entity / entity_id');
    const rows = await this.db.client.attachment.findMany({ where: { entity, entity_id: entityId }, orderBy: { id: 'asc' } });
    const users = await this.db.client.user.findMany({
      where: { username: { in: [...new Set(rows.map((r) => r.uploaded_by).filter((x): x is string => !!x))] } },
      select: { username: true, full_name: true },
    });
    const names = new Map(users.map((u) => [u.username, u.full_name]));
    return rows.map(({ storage_key: _k, ...r }) => ({ ...r, uploaded_by_name: r.uploaded_by ? names.get(r.uploaded_by) ?? r.uploaded_by : null }));
  }

  /** 读取附件内容并校验 sha256（防篡改/损坏） */
  async read(id: number): Promise<{ row: Attachment; data: Buffer }> {
    const row = await this.db.client.attachment.findUnique({ where: { id } });
    if (!row) throw new NotFound('附件');
    const path = this.pathOf(row.storage_key);
    if (!existsSync(path)) throw new BizError('附件文件缺失，请联系系统管理员从备份恢复', 500);
    const data = await readFile(path);
    if (createHash('sha256').update(data).digest('hex') !== row.sha256) {
      throw new BizError('附件文件校验失败（内容被篡改或损坏），请联系系统管理员从备份恢复', 500);
    }
    return { row, data };
  }
}

/** Content-Disposition（中文文件名用 RFC 5987 filename*） */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

