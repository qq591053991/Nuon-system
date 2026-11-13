/**
 * RFID 接口（仓库）。
 *   读写器/中间件（不登录，请求头 X-Reader-Key 鉴权）：POST /api/rfid/readings（批量推送读取）、POST /api/rfid/heartbeat（心跳）
 *   作业台（登录，wms）：会话开始/核对/兜底输入/误读/绑定/确认/取消、模拟读取（仅演示/测试，RFID_SIMULATE）
 *   标签管理（wms）：发卡、换标、作废、按入库单/序列号批量发卡、查询
 *   读写器管理（wms 或 admin）：新增/修改/重新生成密钥、原始读取查询
 * 原始读取（rfid_read）是电子记录：只有查询接口，没有修改/删除接口（数据库触发器同样禁止）。
 */
import { Body, Controller, Get, Headers, Ip, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { Perms, Public, User } from '../auth';
import { config } from '../config';
import { als, type CurrentUser } from '../common/context';
import { BizError, NotFound } from '../common/errors';
import { like, pageArgs, serList } from '../common/paginate';
import { inc } from '../common/presenter';
import { PrismaService } from '../common/prisma.service';
import { RfidSessionService } from './rfid-session.service';
import { RfidService } from './rfid.service';

const int = (v?: string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// ---------- DTO ----------
class ReadDto {
  @IsString() @MaxLength(80) epc: string;
  @IsOptional() @Type(() => Number) @IsInt() antenna?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() rssi?: number | null;
  /** 读写器时间（ISO 8601），未提供 = 服务器接收时间 */
  @IsOptional() @IsString() ts?: string | null;
}

class ReadingsDto {
  /** 读写器编码（可选，与密钥核对） */
  @IsOptional() @IsString() reader_code?: string | null;
  /** 指定会话（手持机上传盘点读取时可带；须是本读写器的进行中会话） */
  @IsOptional() @Type(() => Number) @IsInt() session_id?: number | null;
  @IsArray() @ArrayMaxSize(2000) @ValidateNested({ each: true }) @Type(() => ReadDto) reads: ReadDto[];
}

class HeartbeatDto {
  @IsOptional() @IsString() reader_code?: string | null;
}

class SimulateDto {
  @Type(() => Number) @IsInt() reader_id: number;
  @IsOptional() @Type(() => Number) @IsInt() session_id?: number | null;
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => ReadDto) reads: ReadDto[];
}

class ReaderDto {
  @IsOptional() @IsString() @MaxLength(32) code?: string;
  @IsOptional() @IsString() @MaxLength(64) name?: string;
  @IsOptional() @IsIn(['DESKTOP', 'GATE', 'HANDHELD']) reader_type?: string;
  @IsOptional() @IsIn(['RECEIVE', 'GATE', 'SHIP', 'COUNT']) purpose?: string;
  @IsOptional() @Type(() => Number) @IsInt() warehouse_id?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() location_id?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() outside_location_id?: number | null;
  @IsOptional() @IsIn(['ANTENNA', 'FIXED_IN', 'FIXED_OUT', 'NONE']) direction_mode?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) inner_antenna?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) outer_antenna?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() rssi_min?: number | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsString() remark?: string | null;
}

class TagDto {
  /** 为空 = 系统生成（用 RFID 打印机写入） */
  @IsOptional() @IsString() epc?: string | null;
  @IsIn(['PACKAGE', 'UNIT']) tag_type: string;
  @IsOptional() @Type(() => Number) @IsInt() material_id?: number | null;
  @IsOptional() @IsString() lot_no?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() qty?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() location_id?: number | null;
  @IsOptional() @IsString() sn?: string | null;
  @IsOptional() @IsString() remark?: string | null;
}

class ReplaceDto {
  @IsOptional() @IsString() new_epc?: string | null;
  @IsString() reason: string;
}

class VoidDto {
  @IsString() reason: string;
}

class PackDto {
  @Type(() => Number) @IsInt() line_id: number;
  @Type(() => Number) @IsInt() @Min(1) packages: number;
}

class IssueReceiptDto {
  @Type(() => Number) @IsInt() receipt_id: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PackDto) packages?: PackDto[];
}

class IssueSerialsDto {
  @IsOptional() @Type(() => Number) @IsInt() wo_id?: number | null;
  @IsOptional() @IsArray() @IsString({ each: true }) serials?: string[] | null;
}

class SessionDto {
  @IsIn(['RECEIVE', 'ISSUE', 'FG_RECEIPT', 'SHIP', 'COUNT', 'RETURN']) session_type: string;
  @Type(() => Number) @IsInt() reader_id: number;
  @IsOptional() @Type(() => Number) @IsInt() po_id?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() issue_id?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() wo_id?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() shipment_id?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() location_id?: number | null;
  @IsOptional() @IsString() remark?: string | null;
}

class ManualDto {
  @IsString() code: string;
}

class EpcsDto {
  @IsOptional() @IsArray() @IsString({ each: true }) epcs?: string[] | null;
  @IsOptional() @IsBoolean() all_errors?: boolean;
  @IsOptional() @IsString() note?: string | null;
}

class BindDto {
  /** 为空 = 所有未绑定的新标签 */
  @IsOptional() @IsArray() @IsString({ each: true }) epcs?: string[] | null;
  @Type(() => Number) @IsInt() po_line_id: number;
  /** 每包（每张标签）数量 */
  @Type(() => Number) @IsNumber() qty: number;
  @IsOptional() @IsString() lot_no?: string | null;
  @IsOptional() @IsString() supplier_lot?: string | null;
  @IsOptional() @IsString() mfg_date?: string | null;
  @IsOptional() @IsString() expiry_date?: string | null;
  @Type(() => Number) @IsInt() location_id: number;
}

class GateItemDto {
  @IsString() epc: string;
  @IsOptional() @IsIn(['IN', 'OUT']) direction?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() to_location_id?: number | null;
}

class ConfirmDto {
  /** 收货/库门：已确认放置警告（湿敏物料放非防潮柜） */
  @IsOptional() @IsBoolean() confirm_placement?: boolean;
  @IsOptional() @IsString() delivery_note?: string | null;
  /** 库门：勾选确认的标签（可改方向、目标库位） */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => GateItemDto) items?: GateItemDto[] | null;
  /** 领料：部分过账（少读的行转入新领料单） */
  @IsOptional() @IsBoolean() partial?: boolean;
  /** 盘点：写入盘点单后直接过账；未盘行（无标签库存）按当前账面 */
  @IsOptional() @IsBoolean() post?: boolean;
  @IsOptional() @IsBoolean() uncounted_as_book?: boolean;
  /** 客户退货：原因、入库库位 */
  @IsOptional() @IsString() reason?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() location_id?: number | null;
}

class CancelDto {
  @IsOptional() @IsString() reason?: string | null;
}

@Controller('rfid')
export class RfidController {
  constructor(private readonly db: PrismaService, private readonly rfid: RfidService, private readonly sessions: RfidSessionService) {}

  // ---------- 读写器 / 中间件接入（不登录，X-Reader-Key） ----------

  /** 批量推送读取：去重（同一会话同一 EPC 只算一次）、RSSI 过滤、未登记标签单独列出；每条读取都留原始记录 */
  @Public()
  @Post('readings')
  async readings(@Headers('x-reader-key') key: string, @Body() b: ReadingsDto, @Ip() ip: string) {
    const r = await this.rfid.readerByKey(this.db.client, key, b.reader_code);
    if (b.session_id) {
      const s = await this.db.client.rfidSession.findUnique({ where: { id: b.session_id } });
      if (!s || s.reader_id !== r.id) throw new BizError(`会话 ${b.session_id} 不属于读写器 ${r.code}`);
    }
    const as = { id: 0, username: `rfid:${r.code}`, full_name: r.name, roles: '', password_hash: '', is_active: true } as CurrentUser;
    return als.run({ ...(als.getStore() ?? {}), user: as }, () =>
      this.db.tx(async (tx) => {
        const out = await this.rfid.ingest(tx, r, b.reads, { source: 'READER', session_id: b.session_id ?? null });
        await tx.$executeRaw`UPDATE rfid_reader SET last_ip = ${String(ip ?? '').slice(0, 64) || null} WHERE id = ${r.id}`;
        return out;
      }),
    );
  }

  /** 心跳（建议每 30 秒一次）：返回读写器当前的作业会话 */
  @Public()
  @Post('heartbeat')
  async heartbeat(@Headers('x-reader-key') key: string, @Body() b: HeartbeatDto, @Ip() ip: string) {
    const r = await this.rfid.readerByKey(this.db.client, key, b?.reader_code);
    return this.rfid.heartbeat(this.db.client, r, ip);
  }

  // ---------- 选项 / 概览 ----------

  @Get('options')
  options() {
    return {
      simulate: config.rfid.simulate, rssi_min: config.rfid.rssiMin, gate_window_seconds: config.rfid.gateWindowSeconds,
      online_seconds: config.rfid.onlineSeconds,
    };
  }

  /** 作业台首页：读写器在线状态、进行中的作业、库门待确认数、今日读取统计 */
  @Get('overview')
  @Perms('wms', 'admin')
  async overview() {
    const db = this.db.client;
    const readers = await db.rfidReader.findMany({ orderBy: { code: 'asc' }, include: inc('RfidReader') });
    const open = await this.sessions.list(db, { status: 'OPEN', page_size: 100 });
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [reads, lowRssi, noSession] = await Promise.all([
      db.rfidRead.count({ where: { received_at: { gte: since } } }),
      db.rfidRead.count({ where: { received_at: { gte: since }, result: 'LOW_RSSI' } }),
      db.rfidRead.count({ where: { received_at: { gte: since }, result: 'NO_SESSION' } }),
    ]);
    const gatePending = await db.rfidSessionTag.count({ where: { action: null, session: { status: 'OPEN', session_type: 'GATE' } } });
    return {
      options: this.options(),
      readers: readers.map((r) => this.rfid.readerOut(r, { open_session: open.items.find((s: any) => s.reader_id === r.id && s.session_type !== 'GATE') ?? null })),
      open_sessions: open.items,
      gate_pending: gatePending,
      stats_24h: { reads, low_rssi: lowRssi, no_session: noSession },
    };
  }

  // ---------- 读写器管理 ----------

  @Get('readers')
  @Perms('wms', 'admin')
  async readers() {
    const rows = await this.db.client.rfidReader.findMany({ orderBy: { code: 'asc' }, include: inc('RfidReader') });
    return rows.map((r) => this.rfid.readerOut(r));
  }

  /** 新增读写器：返回的 key 是接口密钥明文，只显示这一次（库里只存哈希） */
  @Post('readers')
  @Perms('wms', 'admin')
  createReader(@Body() b: ReaderDto, @User() user: CurrentUser) {
    if (!b.name || !b.reader_type || !b.purpose) throw new BizError('请填写名称、类型和用途');
    return this.db.tx((tx) => this.rfid.createReader(tx, user, b as any));
  }

  @Put('readers/:id')
  @Perms('wms', 'admin')
  updateReader(@Param('id', ParseIntPipe) id: number, @Body() b: ReaderDto) {
    const { code: _c, ...rest } = b;
    return this.db.tx((tx) => this.rfid.updateReader(tx, id, rest as any));
  }

  /** 重新生成接口密钥（旧密钥立即失效） */
  @Post('readers/:id/rotate-key')
  @Perms('wms', 'admin')
  rotateKey(@Param('id', ParseIntPipe) id: number) {
    return this.db.tx((tx) => this.rfid.rotateKey(tx, id));
  }

  /** 原始读取查询（电子记录，只读） */
  @Get('reads')
  @Perms('wms', 'admin', 'audit')
  async reads(@Query() q: Record<string, string>) {
    const where: any = {};
    if (int(q.reader_id)) where.reader_id = int(q.reader_id);
    if (int(q.session_id)) where.session_id = int(q.session_id);
    if (q.epc) where.epc = like(q.epc.trim());
    if (q.result) where.result = { in: q.result.split(',') };
    const { page, page_size, skip, take } = pageArgs(q, 50);
    const [total, rows] = await Promise.all([
      this.db.client.rfidRead.count({ where }),
      this.db.client.rfidRead.findMany({ where, orderBy: { id: 'desc' }, skip, take, include: inc('RfidRead') }),
    ]);
    return { items: serList('RfidRead', rows), total, page, page_size };
  }

  // ---------- 模拟读取（仅演示/测试） ----------

  private needSimulate() {
    if (!config.rfid.simulate) throw new BizError('模拟读取未开启（仅演示/测试环境，设置 RFID_SIMULATE=1）', 403);
  }

  @Post('simulate')
  @Perms('wms')
  simulate(@Body() b: SimulateDto, @User() user: CurrentUser) {
    this.needSimulate();
    return this.db.tx(async (tx) => {
      const r = await tx.rfidReader.findUnique({ where: { id: b.reader_id } });
      if (!r) throw new NotFound('读写器');
      if (!r.is_active) throw new BizError(`读写器 ${r.code} 已停用`);
      if (b.session_id) {
        const s = await tx.rfidSession.findUnique({ where: { id: b.session_id } });
        if (!s || s.reader_id !== r.id) throw new BizError('会话不属于该读写器');
      }
      return this.rfid.ingest(tx, r, b.reads, { source: 'SIMULATED', username: user.username, session_id: b.session_id ?? null });
    });
  }

  @Get('sim-candidates')
  @Perms('wms')
  simCandidates(@Query() q: Record<string, string>) {
    this.needSimulate();
    return this.sessions.simCandidates(this.db.client, { reader_id: int(q.reader_id), session_id: int(q.session_id) });
  }

  // ---------- 标签 ----------

  @Get('tags')
  async tags(@Query() q: Record<string, string>) {
    const where: any = {};
    if (q.q) {
      const kw = q.q.trim();
      where.OR = [{ epc: like(kw) }, { lot_no: like(kw) }, { material: { code: like(kw) } }, { serial: { sn: like(kw) } }];
    }
    if (q.tag_type) where.tag_type = q.tag_type;
    if (q.status) where.status = { in: q.status.split(',') };
    if (int(q.material_id)) where.material_id = int(q.material_id);
    if (int(q.location_id)) where.location_id = int(q.location_id);
    if (int(q.receipt_id)) where.receipt_id = int(q.receipt_id);
    if (q.lot_no) where.lot_no = { in: q.lot_no.split(',') };
    if (q.in_stock === '1') where.location_id = { not: null };
    if (q.ids) where.id = { in: q.ids.split(',').map(Number).filter((x) => Number.isInteger(x) && x > 0) };
    const { page, page_size, skip, take } = pageArgs(q, 50);
    const [total, rows] = await Promise.all([
      this.db.client.rfidTag.count({ where }),
      this.db.client.rfidTag.findMany({ where, orderBy: { id: 'desc' }, skip, take, include: inc('RfidTag') }),
    ]);
    return { items: rows.map((t) => this.rfid.tagOut(t)), total, page, page_size };
  }

  /** 按 EPC / 序列号 / 批号 / 库位标签 查标签 */
  @Get('tags/lookup')
  lookup(@Query('code') code: string) {
    return this.rfid.lookup(this.db.client, code);
  }

  @Get('tags/:id')
  tag(@Param('id', ParseIntPipe) id: number) {
    return this.rfid.getTag(this.db.client, id);
  }

  /** 发卡/绑定一张标签（包装：物料+批号+数量+库位；单台：序列号）；epc 为空 = 系统生成 */
  @Post('tags')
  @Perms('wms')
  createTag(@Body() b: TagDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.rfid.createTag(tx, user, b));
  }

  /** 为一张入库单的各批次批量发卡（packages = 每行拆成几包） */
  @Post('tags/issue-receipt')
  @Perms('wms')
  issueReceipt(@Body() b: IssueReceiptDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.rfid.issueForReceipt(tx, user, b.receipt_id, b.packages ?? []));
  }

  /** 为成品序列号批量发卡（按工单或指定序列号） */
  @Post('tags/issue-serials')
  @Perms('wms')
  issueSerials(@Body() b: IssueSerialsDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.rfid.issueForSerials(tx, user, b));
  }

  /** 换标：旧标签作废，新标签继承绑定 */
  @Post('tags/:id/replace')
  @Perms('wms')
  replaceTag(@Param('id', ParseIntPipe) id: number, @Body() b: ReplaceDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.rfid.replaceTag(tx, user, id, b.new_epc, b.reason));
  }

  @Post('tags/:id/void')
  @Perms('wms')
  voidTag(@Param('id', ParseIntPipe) id: number, @Body() b: VoidDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.rfid.voidTag(tx, user, id, b.reason));
  }

  // ---------- 作业会话 ----------

  @Get('sessions')
  listSessions(@Query() q: Record<string, string>) {
    return this.sessions.list(this.db.client, { status: q.status, session_type: q.session_type, reader_id: int(q.reader_id), page: int(q.page), page_size: int(q.page_size) });
  }

  @Post('sessions')
  @Perms('wms')
  createSession(@Body() b: SessionDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.sessions.create(tx, user, b));
  }

  /** 会话详情与核对结果（作业台每 1.5 秒轮询） */
  @Get('sessions/:id')
  session(@Param('id', ParseIntPipe) id: number) {
    return this.sessions.detail(this.db.client, id);
  }

  /** 条码/手输兜底：EPC、序列号（UDI）、批号 */
  @Post('sessions/:id/manual')
  @Perms('wms')
  manual(@Param('id', ParseIntPipe) id: number, @Body() b: ManualDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const r = await this.sessions.manual(tx, user, id, b.code);
      return { ...(await this.sessions.detail(tx, id)), manual: r };
    });
  }

  /** 标记为误读（epcs，或 all_errors = 所有红色行与未登记标签） */
  @Post('sessions/:id/ignore')
  @Perms('wms')
  ignore(@Param('id', ParseIntPipe) id: number, @Body() b: EpcsDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.sessions.ignore(tx, user, id, b));
  }

  @Post('sessions/:id/restore')
  @Perms('wms')
  restore(@Param('id', ParseIntPipe) id: number, @Body() b: EpcsDto) {
    return this.db.tx((tx) => this.sessions.restore(tx, id, b.epcs ?? []));
  }

  /** 收货台：新标签绑定到订单行 */
  @Post('sessions/:id/bind')
  @Perms('wms')
  bind(@Param('id', ParseIntPipe) id: number, @Body() b: BindDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.sessions.bind(tx, user, id, b));
  }

  @Post('sessions/:id/unbind')
  @Perms('wms')
  unbind(@Param('id', ParseIntPipe) id: number, @Body() b: EpcsDto) {
    return this.db.tx((tx) => this.sessions.unbind(tx, id, b.epcs ?? []));
  }

  /** 确认：按作业类型生成业务单据（入库单 / 调拨 / 领料过账 / 完工入库 / 发货过账 / 盘点单 / 客户退货单） */
  @Post('sessions/:id/confirm')
  @Perms('wms')
  confirm(@Param('id', ParseIntPipe) id: number, @Body() b: ConfirmDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.sessions.confirm(tx, user, id, b), { timeoutMs: 120_000 });
  }

  @Post('sessions/:id/cancel')
  @Perms('wms')
  cancel(@Param('id', ParseIntPipe) id: number, @Body() b: CancelDto, @User() user: CurrentUser) {
    return this.db.tx((tx) => this.sessions.cancel(tx, user, id, b?.reason));
  }
}
