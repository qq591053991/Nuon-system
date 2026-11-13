/**
 * RFID 基础服务：读写器（接口密钥只存哈希、心跳、在线判断）、读取接入（去重 / RSSI 过滤 / 未登记标签）、标签（发卡、换标、作废）。
 * 作业会话的业务逻辑（收货、库门、领料、完工入库、发货、盘点、退货）见 rfid-session.service.ts。
 *
 *   readerByKey(db, key, code?)                  按请求头 X-Reader-Key 识别读写器（密钥 sha256 比对；停用/不符 → 401）
 *   ingest(tx, reader, reads, { source, username, session_id })
 *       → { session_id, session_no, accepted, duplicates, low_rssi, unknown[], location_tags[], invalid[], no_session }
 *       每条读取都写入 rfid_read（电子记录，不可改删）；同一会话同一 EPC 只计一次（rfid_session_tag 唯一键）；
 *       库门读写器无进行中会话时自动开一次“过门”会话（RFID_GATE_WINDOW_SECONDS 内的读取归为同一次）。
 *   heartbeat(db, reader, ip)                    心跳（不进审计追踪：遥测数据，原始读取已是记录）
 *   createTag / replaceTag / voidTag / issueForReceipt / issueForSerials   发卡与标签维护
 */
import { createHash, randomBytes } from 'node:crypto';
import { HttpException, Injectable } from '@nestjs/common';
import type { Prisma, RfidReader, RfidSession } from '@prisma/client';
import { config } from '../config';
import type { CurrentUser } from '../common/context';
import { BizError, NotFound } from '../common/errors';
import { EPS, g, round } from '../common/num';
import { inc, ser } from '../common/presenter';
import type { Tx } from '../common/prisma.service';
import { NumberingService } from '../core/numbering.service';
import { locationIdOfEpc, mustEpc, newEpc, normEpc } from './epc';

export const READER_TYPE: Record<string, string> = { DESKTOP: '桌面读写器', GATE: '门式读写器', HANDHELD: '手持读写器' };
export const READER_PURPOSE: Record<string, string> = { RECEIVE: '收货台', GATE: '库门', SHIP: '发货口', COUNT: '盘点' };
export const SESSION_TYPE: Record<string, string> = {
  AUTO: '识别中', RECEIVE: '收货', GATE: '过门', ISSUE: '领料核对', FG_RECEIPT: '完工入库', SHIP: '发货核对', COUNT: '盘点对账', RETURN: '客户退货',
};

export interface ReadInput { epc: string; antenna?: number | null; rssi?: number | null; ts?: string | null }
export type ReadSource = 'READER' | 'SIMULATED' | 'MANUAL';

export const hashKey = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex');
/** 新接口密钥（明文只返回一次） */
export const newReaderKey = () => `rk_${randomBytes(24).toString('base64url')}`;

const iso = (d: Date) => d.toISOString();

/** 库门方向：ANTENNA = 先外侧后内侧为进库（IN）、先内侧后外侧为出库（OUT）；只被一侧读到或折返 = 方向不明（null） */
export function gateDirection(r: Pick<RfidReader, 'direction_mode' | 'inner_antenna' | 'outer_antenna'>, antennas: string | null): 'IN' | 'OUT' | null {
  if (r.direction_mode === 'FIXED_IN') return 'IN';
  if (r.direction_mode === 'FIXED_OUT') return 'OUT';
  if (r.direction_mode !== 'ANTENNA' || !antennas) return null;
  const seq = antennas.split(',').map(Number).filter((x) => Number.isFinite(x));
  if (seq.length < 2) return null;
  const first = seq[0];
  const last = seq[seq.length - 1];
  if (first === r.outer_antenna && last === r.inner_antenna) return 'IN';
  if (first === r.inner_antenna && last === r.outer_antenna) return 'OUT';
  return null;
}

@Injectable()
export class RfidService {
  constructor(private readonly numbering: NumberingService) {}

  // ---------------- 读写器 ----------------

  isOnline(r: Pick<RfidReader, 'last_heartbeat_at' | 'is_active'>, now = Date.now()) {
    return !!r.is_active && !!r.last_heartbeat_at && now - r.last_heartbeat_at.getTime() <= config.rfid.onlineSeconds * 1000;
  }

  readerOut(r: any, extra: Record<string, unknown> = {}) {
    return {
      ...ser('RfidReader', r), online: this.isOnline(r), reader_type_text: READER_TYPE[r.reader_type] ?? r.reader_type,
      purpose_text: READER_PURPOSE[r.purpose] ?? r.purpose, rssi_min_effective: r.rssi_min ?? config.rfid.rssiMin, ...extra,
    };
  }

  private async checkReader(tx: Tx, a: { reader_type?: string; purpose?: string; direction_mode?: string; warehouse_id?: number | null; location_id?: number | null; outside_location_id?: number | null; inner_antenna?: number | null; outer_antenna?: number | null }) {
    if (a.reader_type !== undefined && !READER_TYPE[a.reader_type]) throw new BizError('读写器类型只能是 桌面 / 门式 / 手持');
    if (a.purpose !== undefined && !READER_PURPOSE[a.purpose]) throw new BizError('用途只能是 收货台 / 库门 / 发货口 / 盘点');
    if (a.direction_mode !== undefined && !['ANTENNA', 'FIXED_IN', 'FIXED_OUT', 'NONE'].includes(a.direction_mode)) throw new BizError('方向规则不正确');
    if (a.direction_mode === 'ANTENNA') {
      if (!a.inner_antenna || !a.outer_antenna) throw new BizError('按天线判定方向时，须填写库内侧和库外侧的天线号');
      if (a.inner_antenna === a.outer_antenna) throw new BizError('库内侧和库外侧不能是同一个天线');
    }
    for (const [k, label] of [['location_id', '绑定库位'], ['outside_location_id', '外侧库位']] as const) {
      const id = a[k];
      if (!id) continue;
      const l = await tx.location.findUnique({ where: { id } });
      if (!l) throw new NotFound(label);
      if (k === 'location_id' && a.warehouse_id && l.warehouse_id !== a.warehouse_id) throw new BizError(`绑定库位 ${l.code} 不属于所选仓库`);
    }
  }

  async createReader(tx: Tx, user: CurrentUser, a: Prisma.RfidReaderUncheckedCreateInput) {
    const code = String(a.code ?? '').trim();
    if (!code) throw new BizError('请填写读写器编码');
    if (await tx.rfidReader.findUnique({ where: { code } })) throw new BizError(`读写器编码 ${code} 已存在`);
    await this.checkReader(tx, a as any);
    const key = newReaderKey();
    const r = await tx.rfidReader.create({
      data: { ...a, code, key_hash: hashKey(key), key_hint: key.slice(-4), created_by: user.username },
      include: inc('RfidReader'),
    });
    return { ...this.readerOut(r), key };
  }

  async updateReader(tx: Tx, id: number, a: Prisma.RfidReaderUncheckedUpdateInput) {
    const cur = await tx.rfidReader.findUnique({ where: { id } });
    if (!cur) throw new NotFound('读写器');
    const merged: any = { ...cur, ...a };
    await this.checkReader(tx, merged);
    const r = await tx.rfidReader.update({ where: { id }, data: a, include: inc('RfidReader') });
    return this.readerOut(r);
  }

  /** 重新生成接口密钥（旧密钥立即失效；明文只返回这一次） */
  async rotateKey(tx: Tx, id: number) {
    const cur = await tx.rfidReader.findUnique({ where: { id } });
    if (!cur) throw new NotFound('读写器');
    const key = newReaderKey();
    const r = await tx.rfidReader.update({ where: { id }, data: { key_hash: hashKey(key), key_hint: key.slice(-4) }, include: inc('RfidReader') });
    return { ...this.readerOut(r), key };
  }

  /** 读写器/中间件鉴权：X-Reader-Key → 读写器；可同时带 reader_code 核对 */
  async readerByKey(db: Tx, key: string | undefined, code?: string | null): Promise<RfidReader> {
    const k = String(key ?? '').trim();
    if (!k) throw new HttpException({ detail: '缺少读写器接口密钥（请求头 X-Reader-Key）' }, 401);
    const r = await db.rfidReader.findFirst({ where: { key_hash: hashKey(k) } });
    if (!r) throw new HttpException({ detail: '读写器接口密钥无效（可能已重新生成），请在“读写器管理”中查看' }, 401);
    if (code && code !== r.code) throw new HttpException({ detail: `接口密钥属于读写器 ${r.code}，与请求中的 ${code} 不符` }, 401);
    if (!r.is_active) throw new HttpException({ detail: `读写器 ${r.code} 已停用` }, 403);
    return r;
  }

  /** 心跳：更新最后心跳时间与来源 IP（遥测，不写审计追踪） */
  async heartbeat(db: Tx, r: RfidReader, ip?: string | null) {
    await db.$executeRaw`UPDATE rfid_reader SET last_heartbeat_at = (now() AT TIME ZONE 'UTC'), last_ip = ${ip ? String(ip).slice(0, 64) : null} WHERE id = ${r.id}`;
    const open = await db.rfidSession.findFirst({ where: { reader_id: r.id, status: 'OPEN' }, orderBy: { id: 'desc' } });
    return {
      ok: true, reader_code: r.code, reader_name: r.name, server_time: new Date().toISOString(), rssi_min: r.rssi_min ?? config.rfid.rssiMin,
      session: open ? { id: open.id, no: open.no, session_type: open.session_type, type_text: SESSION_TYPE[open.session_type] } : null,
    };
  }

  // ---------------- 读取接入 ----------------

  /** 读写器当前的作业会话：库门 = 时间窗内最近一次过门会话（没有则自动新开）；其他 = 操作台上开启的进行中会话 */
  private async targetSession(tx: Tx, r: RfidReader, now: Date, create: boolean): Promise<RfidSession | null> {
    if (r.purpose === 'GATE') {
      const since = new Date(now.getTime() - config.rfid.gateWindowSeconds * 1000);
      const s = await tx.rfidSession.findFirst({
        where: { reader_id: r.id, status: 'OPEN', session_type: 'GATE', OR: [{ last_read_at: { gte: since } }, { last_read_at: null, created_at: { gte: since } }] },
        orderBy: { id: 'desc' },
      });
      if (s || !create) return s;
      return tx.rfidSession.create({
        data: {
          no: await this.numbering.nextNo(tx, 'RF'), session_type: 'GATE', status: 'OPEN', reader_id: r.id, location_id: r.location_id,
          created_by: `rfid:${r.code}`, remark: `${r.name} 过门读取`,
        },
      });
    }
    const open = await tx.rfidSession.findFirst({ where: { reader_id: r.id, status: 'OPEN' }, orderBy: { id: 'desc' } });
    if (open || !create) return open;
    // 没有进行中的作业：开一个“识别中”会话，由 RfidSessionService.afterIngest 按读到的内容自动识别单据
    return tx.rfidSession.create({
      data: { no: await this.numbering.nextNo(tx, 'RF'), session_type: 'AUTO', status: 'OPEN', reader_id: r.id, location_id: r.location_id, created_by: `rfid:${r.code}`, remark: `${r.name} 自动识别` },
    });
  }

  /**
   * 接入一批读取。规则：
   *   - EPC 规范化（十六进制大写），格式不对的列入 invalid、不入库；
   *   - RSSI 低于阈值（读写器设置或 RFID_RSSI_MIN）→ LOW_RSSI，只记录不计入（隔壁货架、擦边读取）；
   *   - 库位标签（4E5503…）→ LOCATION，只记录；
   *   - 没有进行中的作业：库门读写器自动开“过门”会话，其他读写器自动开“识别中”会话（按读到的内容自动识别单据）；
   *   - 计入会话：同一会话同一 EPC 第一次 = ACCEPTED，之后 = DUPLICATE（累加读取次数、天线顺序、最强信号）。
   */
  async ingest(tx: Tx, r: RfidReader, reads: ReadInput[], opts: { source: ReadSource; username?: string | null; session_id?: number | null }) {
    const now = new Date();
    const rssiMin = r.rssi_min ?? config.rfid.rssiMin;
    const out = {
      reader_code: r.code, session_id: null as number | null, session_no: null as string | null, received: reads.length,
      accepted: 0, duplicates: 0, low_rssi: 0, no_session: 0, invalid: [] as string[], unknown: [] as string[], location_tags: [] as string[],
    };
    let session: RfidSession | null = null;
    let looked = false;
    if (opts.session_id) {
      looked = true;
      session = await tx.rfidSession.findUnique({ where: { id: opts.session_id } });
      if (!session) throw new NotFound('作业会话');
      if (session.status !== 'OPEN') throw new BizError(`会话 ${session.no} 已${session.status === 'CONFIRMED' ? '确认' : '取消'}，不能再读取`);
    }
    // 按读写器时间排序（中间件批量上传时可能乱序；方向判定依赖先后）
    const rows = reads
      .map((x, i) => {
        const t = x.ts ? new Date(x.ts) : null;
        return { ...x, i, at: t && !Number.isNaN(t.getTime()) ? t : now };
      })
      .sort((a, b) => a.at.getTime() - b.at.getTime() || a.i - b.i);
    const unknown = new Set<string>();
    const tagCache = new Map<string, { id: number } | null>();
    for (const x of rows) {
      const epc = normEpc(x.epc) ?? (opts.source === 'MANUAL' && /^SN:/.test(String(x.epc)) ? String(x.epc) : null);
      if (!epc) {
        out.invalid.push(String(x.epc ?? ''));
        continue;
      }
      const antenna = x.antenna === undefined || x.antenna === null || !Number.isFinite(Number(x.antenna)) ? null : Math.trunc(Number(x.antenna));
      const rssi = x.rssi === undefined || x.rssi === null || !Number.isFinite(Number(x.rssi)) ? null : Number(x.rssi);
      let result: string;
      if (rssi !== null && rssi < rssiMin) {
        result = 'LOW_RSSI';
        out.low_rssi += 1;
      } else if (locationIdOfEpc(epc)) {
        result = 'LOCATION';
        if (!out.location_tags.includes(epc)) out.location_tags.push(epc);
      } else {
        if (!looked) {
          session = await this.targetSession(tx, r, now, true);
          looked = true;
        }
        if (!session) {
          result = 'NO_SESSION';
          out.no_session += 1;
        } else {
          if (!tagCache.has(epc)) tagCache.set(epc, await tx.rfidTag.findUnique({ where: { epc }, select: { id: true } }));
          const tag = tagCache.get(epc) ?? null;
          if (!tag && !epc.startsWith('SN:')) unknown.add(epc);
          const dir = r.purpose === 'GATE' && r.direction_mode.startsWith('FIXED') ? gateDirection(r, null) : null;
          const ant = antenna === null ? null : String(antenna);
          // 原子“插入或累加”：同一会话同一 EPC 只有一行（并发上传也不会重复）；计数类字段属遥测，不写审计追踪
          const [hit] = await tx.$queryRaw<{ id: number; inserted: boolean; antennas: string | null; action: string | null }[]>`
            INSERT INTO rfid_session_tag (session_id, epc, tag_id, source, first_seen, last_seen, read_count, max_rssi, antennas, direction)
            VALUES (${session.id}, ${epc}, ${tag?.id ?? null}::int, ${opts.source}, (${iso(x.at)}::timestamptz AT TIME ZONE 'UTC'),
                    (${iso(x.at)}::timestamptz AT TIME ZONE 'UTC'), 1, ${rssi}::float8, ${ant}, ${dir})
            ON CONFLICT (session_id, epc) DO UPDATE SET
              read_count = rfid_session_tag.read_count + 1,
              last_seen = GREATEST(rfid_session_tag.last_seen, EXCLUDED.last_seen),
              max_rssi = GREATEST(rfid_session_tag.max_rssi, EXCLUDED.max_rssi),
              antennas = CASE
                WHEN EXCLUDED.antennas IS NULL THEN rfid_session_tag.antennas
                WHEN rfid_session_tag.antennas IS NULL THEN EXCLUDED.antennas
                WHEN regexp_replace(rfid_session_tag.antennas, '^.*,', '') = EXCLUDED.antennas THEN rfid_session_tag.antennas
                WHEN length(rfid_session_tag.antennas) > 56 THEN rfid_session_tag.antennas
                ELSE rfid_session_tag.antennas || ',' || EXCLUDED.antennas END
            RETURNING id, (xmax = 0) AS inserted, antennas, action`;
          if (hit.inserted) out.accepted += 1;
          else out.duplicates += 1;
          result = hit.inserted ? 'ACCEPTED' : 'DUPLICATE';
          if (r.purpose === 'GATE' && r.direction_mode === 'ANTENNA' && !hit.action) {
            await tx.$executeRaw`UPDATE rfid_session_tag SET direction = ${gateDirection(r, hit.antennas)} WHERE id = ${hit.id}`;
          }
          if (tag) {
            await tx.$executeRaw`UPDATE rfid_tag SET last_reader_id = ${r.id}, last_antenna = ${antenna}::int, last_rssi = ${rssi}::float8,
              last_seen_at = (${iso(x.at)}::timestamptz AT TIME ZONE 'UTC')
              WHERE id = ${tag.id} AND (last_seen_at IS NULL OR last_seen_at <= (${iso(x.at)}::timestamptz AT TIME ZONE 'UTC'))`;
          }
        }
      }
      await tx.rfidRead.create({
        data: {
          reader_id: r.id, session_id: result === 'NO_SESSION' || result === 'LOCATION' ? null : session?.id ?? null, antenna, epc, rssi, read_at: x.at,
          source: opts.source, result, username: opts.username ?? null,
        },
      });
    }
    if (session) {
      await tx.$executeRaw`UPDATE rfid_session SET last_read_at = (now() AT TIME ZONE 'UTC') WHERE id = ${session.id}`;
      out.session_id = session.id;
      out.session_no = session.no;
    }
    if (opts.source === 'READER') await tx.$executeRaw`UPDATE rfid_reader SET last_heartbeat_at = (now() AT TIME ZONE 'UTC') WHERE id = ${r.id}`;
    out.unknown = [...unknown];
    return out;
  }

  // ---------------- 标签 ----------------

  tagOut(t: any) {
    return { ...ser('RfidTag', t), tag_type_text: t.tag_type === 'UNIT' ? '单台' : '包装', status_text: t.status === 'VOID' ? '作废' : '启用', in_stock: !!t.location_id };
  }

  async getTag(db: Tx, id: number) {
    const t = await db.rfidTag.findUnique({ where: { id }, include: inc('RfidTag') });
    if (!t) throw new NotFound('标签');
    return this.tagOut(t);
  }

  /** 按 EPC / 序列号 / 批号查标签（兜底输入、标签管理查询共用） */
  async lookup(db: Tx, code: string) {
    const c = String(code ?? '').trim();
    if (!c) throw new BizError('请输入 EPC、序列号或批号');
    const epc = normEpc(c);
    const byEpc = epc ? await db.rfidTag.findUnique({ where: { epc }, include: inc('RfidTag') }) : null;
    if (byEpc) return { kind: 'EPC', tags: [this.tagOut(byEpc)] };
    const sn = await db.serialNumber.findUnique({ where: { sn: c } });
    if (sn) {
      const tags = await db.rfidTag.findMany({ where: { serial_id: sn.id }, include: inc('RfidTag'), orderBy: { id: 'desc' } });
      return { kind: 'SN', sn: sn.sn, tags: tags.map((t) => this.tagOut(t)) };
    }
    const tags = await db.rfidTag.findMany({ where: { lot_no: c }, include: inc('RfidTag'), orderBy: { id: 'asc' }, take: 200 });
    if (tags.length) return { kind: 'LOT', tags: tags.map((t) => this.tagOut(t)) };
    const locId = epc ? locationIdOfEpc(epc) : null;
    if (locId) {
      const loc = await db.location.findUnique({ where: { id: locId } });
      return { kind: 'LOCATION', location: loc ? { id: loc.id, code: loc.code, name: loc.name } : null, tags: [] };
    }
    return { kind: 'UNKNOWN', tags: [] as any[] };
  }

  /** 单台标签是否已有启用标签 */
  private async activeUnitTag(tx: Tx, serialId: number) {
    return tx.rfidTag.findFirst({ where: { serial_id: serialId, status: 'ACTIVE' } });
  }

  /**
   * 发卡/绑定（手工）：
   *   包装：epc + material_id + lot_no + qty + location_id（货主按物料主数据）；
   *   单台：epc + sn（物料、批号、库位取自序列号）。
   * epc 为空 = 系统生成（用 RFID 打印机写入）。
   */
  async createTag(tx: Tx, user: CurrentUser, a: { epc?: string | null; tag_type: string; material_id?: number | null; lot_no?: string | null; qty?: number | null; location_id?: number | null; sn?: string | null; remark?: string | null }) {
    if (!['PACKAGE', 'UNIT'].includes(a.tag_type)) throw new BizError('标签类型只能是 包装 / 单台');
    const epc = a.epc ? mustEpc(a.epc) : await newEpc(tx, this.numbering, a.tag_type as 'PACKAGE' | 'UNIT');
    if (locationIdOfEpc(epc)) throw new BizError(`${epc} 是库位标签编码，不能用作包装/单台标签`);
    const dup = await tx.rfidTag.findUnique({ where: { epc } });
    if (dup) throw new BizError(`EPC ${epc} 已登记（${dup.status === 'VOID' ? '已作废' : '启用中'}），一张标签只能发卡一次`);
    let data: Prisma.RfidTagUncheckedCreateInput;
    if (a.tag_type === 'UNIT') {
      const sn = await tx.serialNumber.findUnique({ where: { sn: String(a.sn ?? '').trim() } });
      if (!sn) throw new BizError(`序列号“${a.sn ?? ''}”不存在`);
      const cur = await this.activeUnitTag(tx, sn.id);
      if (cur) throw new BizError(`序列号 ${sn.sn} 已有启用的标签 ${cur.epc}；标签损坏请用“换标”`);
      data = { epc, tag_type: 'UNIT', material_id: sn.material_id, lot_no: sn.lot_no, qty: 1, serial_id: sn.id, location_id: sn.status === 'IN_STOCK' ? sn.location_id : null };
    } else {
      const m = a.material_id ? await tx.material.findUnique({ where: { id: a.material_id } }) : null;
      if (!m) throw new BizError('请选择物料');
      const qty = Number(a.qty ?? 0);
      if (!(qty > 0)) throw new BizError('包装数量必须大于 0');
      if (m.lot_control && !String(a.lot_no ?? '').trim()) throw new BizError(`${m.code} 为批次管理物料，请填写批号`);
      if (a.location_id && !(await tx.location.findUnique({ where: { id: a.location_id } }))) throw new NotFound('库位');
      data = { epc, tag_type: 'PACKAGE', material_id: m.id, lot_no: String(a.lot_no ?? '').trim(), qty: round(qty), owner_customer_id: m.owner_customer_id, location_id: a.location_id ?? null };
    }
    const t = await tx.rfidTag.create({ data: { ...data, remark: a.remark ?? null, created_by: user.username }, include: inc('RfidTag') });
    return this.tagOut(t);
  }

  /** 换标：旧标签作废（记录原因与新 EPC），新标签继承全部绑定信息 */
  async replaceTag(tx: Tx, user: CurrentUser, id: number, newEpcRaw: string | null | undefined, reason: string) {
    const old = await tx.rfidTag.findUnique({ where: { id } });
    if (!old) throw new NotFound('标签');
    if (old.status !== 'ACTIVE') throw new BizError(`标签 ${old.epc} 已作废，不能再换标`);
    const why = String(reason ?? '').trim();
    if (!why) throw new BizError('请填写换标原因（如：标签破损读不到）');
    const epc = newEpcRaw ? mustEpc(newEpcRaw) : await newEpc(tx, this.numbering, old.tag_type as 'PACKAGE' | 'UNIT');
    if (await tx.rfidTag.findUnique({ where: { epc } })) throw new BizError(`新 EPC ${epc} 已登记，请换一张空白标签`);
    await tx.rfidTag.update({ where: { id }, data: { status: 'VOID', void_reason: `换标：${why}`.slice(0, 256), voided_by: user.full_name, voided_at: new Date(), replaced_by_epc: epc } });
    const t = await tx.rfidTag.create({
      data: {
        epc, tag_type: old.tag_type, material_id: old.material_id, lot_no: old.lot_no, qty: old.qty, owner_customer_id: old.owner_customer_id,
        serial_id: old.serial_id, location_id: old.location_id, receipt_id: old.receipt_id, remark: `替换旧标签 ${old.epc}`, created_by: user.username,
      },
      include: inc('RfidTag'),
    });
    return this.tagOut(t);
  }

  async voidTag(tx: Tx, user: CurrentUser, id: number, reason: string) {
    const t = await tx.rfidTag.findUnique({ where: { id } });
    if (!t) throw new NotFound('标签');
    if (t.status !== 'ACTIVE') throw new BizError(`标签 ${t.epc} 已作废`);
    const why = String(reason ?? '').trim();
    if (!why) throw new BizError('请填写作废原因');
    const row = await tx.rfidTag.update({ where: { id }, data: { status: 'VOID', void_reason: why.slice(0, 256), voided_by: user.full_name, voided_at: new Date() }, include: inc('RfidTag') });
    return this.tagOut(row);
  }

  /**
   * 为一张入库单的各批次批量发卡：每行按“包装数”拆分数量（余数计入最后一包）；packages 未给 = 每行 1 包。
   * 已有启用标签覆盖的行跳过（返回 skipped）。
   */
  async issueForReceipt(tx: Tx, user: CurrentUser, receiptId: number, packages: { line_id: number; packages: number }[] = []) {
    const rc = await tx.receipt.findUnique({ where: { id: receiptId }, include: { lines: { orderBy: { line_no: 'asc' }, include: { material: true } } } });
    if (!rc) throw new NotFound('入库单');
    const want = new Map(packages.map((p) => [p.line_id, Math.trunc(p.packages)]));
    const created: any[] = [];
    const skipped: string[] = [];
    for (const ln of rc.lines) {
      const n = want.get(ln.id) ?? 1;
      if (!(n >= 1)) continue;
      if (n > 500) throw new BizError(`第 ${ln.line_no} 行包装数过多（最多 500）`);
      const have = await tx.rfidTag.aggregate({ where: { receipt_id: rc.id, material_id: ln.material_id, lot_no: ln.lot_no, status: 'ACTIVE', tag_type: 'PACKAGE' }, _sum: { qty: true } });
      if ((have._sum.qty ?? 0) + EPS >= ln.qty) {
        skipped.push(`第 ${ln.line_no} 行 ${ln.material.code} 批次 ${ln.lot_no || '-'} 已发卡`);
        continue;
      }
      if (ln.material.serial_control) {
        skipped.push(`第 ${ln.line_no} 行 ${ln.material.code} 是序列号产品，请按序列号发单台标签`);
        continue;
      }
      const per = Math.floor((ln.qty / n) * 10000) / 10000;
      for (let i = 0; i < n; i++) {
        const qty = i === n - 1 ? round(ln.qty - per * (n - 1)) : per;
        const t = await tx.rfidTag.create({
          data: {
            epc: await newEpc(tx, this.numbering, 'PACKAGE'), tag_type: 'PACKAGE', material_id: ln.material_id, lot_no: ln.lot_no, qty,
            owner_customer_id: ln.material.owner_customer_id, location_id: ln.location_id, receipt_id: rc.id, created_by: user.username,
            remark: `入库单 ${rc.no} 第 ${ln.line_no} 行 第 ${i + 1}/${n} 包`,
          },
          include: inc('RfidTag'),
        });
        created.push(this.tagOut(t));
      }
    }
    if (!created.length && skipped.length) throw new BizError(`没有需要发卡的行：${skipped.join('；')}`);
    return { receipt_no: rc.no, created, skipped };
  }

  /** 为成品序列号批量发卡（单台标签）：按工单（已完工 / 在库 / 已发货的序列号）或指定序列号；已有启用标签的跳过 */
  async issueForSerials(tx: Tx, user: CurrentUser, a: { wo_id?: number | null; serials?: string[] | null }) {
    const where: Prisma.SerialNumberWhereInput = a.serials?.length
      ? { sn: { in: a.serials.map((s) => String(s).trim()).filter(Boolean) } }
      : a.wo_id ? { wo_id: a.wo_id, status: { in: ['COMPLETED', 'IN_STOCK', 'SHIPPED'] } } : { id: -1 };
    if (!a.serials?.length && !a.wo_id) throw new BizError('请选择工单或输入序列号');
    const sns = await tx.serialNumber.findMany({ where, orderBy: { sn: 'asc' } });
    if (!sns.length) throw new BizError(a.wo_id ? '该工单没有已完工的序列号（完工后再发单台标签）' : '序列号不存在');
    const created: any[] = [];
    const skipped: string[] = [];
    for (const sn of sns) {
      if (await this.activeUnitTag(tx, sn.id)) {
        skipped.push(sn.sn);
        continue;
      }
      const t = await tx.rfidTag.create({
        data: {
          epc: await newEpc(tx, this.numbering, 'UNIT'), tag_type: 'UNIT', material_id: sn.material_id, lot_no: sn.lot_no, qty: 1, serial_id: sn.id,
          location_id: sn.status === 'IN_STOCK' ? sn.location_id : null, created_by: user.username,
        },
        include: inc('RfidTag'),
      });
      created.push(this.tagOut(t));
    }
    if (!created.length) throw new BizError(`这些序列号都已有启用的单台标签（${g(skipped.length)} 台）`);
    return { created, skipped };
  }
}
