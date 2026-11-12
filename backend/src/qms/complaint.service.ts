/**
 * 客户投诉 / 不良事件：OPEN（已登记）→ INVESTIGATING（调查中）→ CLOSED（已结案，QA 电子签名“客诉结案”）。
 *   法规字段：投诉人/联系方式、事件日期、国家；不良事件的上报评估（reportable）、上报期限（默认按国家：中国 20 天、美国 FDA MDR 30 天、欧盟 15 天）、
 *   上报编号与日期；给客户的回复与日期。
 *   create / update            登记与修改（未关闭）；输入序列号自动带出产品与批号
 *   startInvestigation         开始调查
 *   createNcr                  由投诉开具 NCR（来源 CUSTOMER）并关联，未调查时自动转为调查中
 *   createCapa / linkCapa      发起或关联 CAPA（来源 COMPLAINT）
 *   close                      关闭：必须填写调查结论 + QA 电子签名
 *   enrich                     补充 customer_name / material_code / ncr_no / capa_no 等
 */
import { Injectable } from '@nestjs/common';
import type { Complaint } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import { addDays, fmtDate, today } from '../common/dates';
import { BizError, NotFound } from '../common/errors';
import { ser } from '../common/presenter';
import type { Tx } from '../common/prisma.service';
import { EsignService, type SignatureDto } from '../core/esign.service';
import { NumberingService } from '../core/numbering.service';
import { capaDueDate, fullNames } from './qms-rules';

export interface ComplaintInput {
  customer_id?: number;
  received_date?: Date | null;
  material_id?: number | null;
  sn?: string | null;
  lot_no?: string | null;
  description?: string;
  is_adverse_event?: boolean;
  investigation?: string | null;
  capa_id?: number | null;
  reporter_contact?: string | null;
  event_date?: Date | null;
  country?: string | null;
  reportable?: boolean | null;
  report_deadline?: Date | null;
  report_no?: string | null;
  reported_at?: Date | null;
  customer_reply?: string | null;
  replied_at?: Date | null;
}

/** 国家/地区统一为中文（兼容 US / USA / EU / CN 等代码） */
const COUNTRY_ALIAS: Record<string, string> = {
  US: '美国', USA: '美国', 'UNITED STATES': '美国', 美国: '美国', EU: '欧盟', 欧盟: '欧盟', CN: '中国', CHINA: '中国', 中国: '中国',
  DE: '德国', GERMANY: '德国', FR: '法国', FRANCE: '法国', IT: '意大利', ES: '西班牙', NL: '荷兰', GB: '英国', UK: '英国',
  JP: '日本', JAPAN: '日本', KR: '韩国', AU: '澳大利亚', CA: '加拿大',
};
export const normCountry = (v: string | null | undefined): string | null => {
  const t = String(v ?? '').trim();
  if (!t) return null;
  return COUNTRY_ALIAS[t.toUpperCase()] ?? t;
};
const EU = ['欧盟', '德国', '法国', '意大利', '西班牙', '荷兰', '比利时', '奥地利', '瑞典', '丹麦', '芬兰', '爱尔兰', '波兰', '葡萄牙', '希腊', '捷克'];

/**
 * 不良事件上报时限（天，自获知/接收日起）：中国《医疗器械不良事件监测和再评价管理办法》严重伤害 20 天；
 * 美国 FDA MDR 30 天；欧盟 MDR 严重事件 15 天；其他国家/地区默认 20 天（请按当地法规调整）。
 */
export function reportDays(country: string | null | undefined): number {
  const c = normCountry(country) ?? '';
  if (c === '美国') return 30;
  if (EU.includes(c)) return 15;
  return 20;
}
const REG_TEXT = ['reporter_contact', 'country', 'report_no', 'customer_reply'] as const;
const REG_DATE = ['event_date', 'report_deadline', 'reported_at', 'replied_at'] as const;

const text = (v: string | null | undefined) => {
  const s = (v ?? '').trim();
  return s ? s : null;
};

@Injectable()
export class ComplaintService {
  constructor(private readonly numbering: NumberingService, private readonly esign: EsignService) {}

  private async load(tx: Tx, id: number): Promise<Complaint> {
    const c = await tx.complaint.findUnique({ where: { id } });
    if (!c) throw new NotFound('客户投诉');
    return c;
  }

  private open(c: Complaint) {
    if (c.status === 'CLOSED') throw new BizError('投诉已结案，不能修改');
  }

  /** 序列号 → 产品与批号（本系统生产的产品） */
  private async bySn(tx: Tx, sn: string | null) {
    if (!sn) return null;
    return tx.serialNumber.findUnique({ where: { sn } });
  }

  async create(tx: Tx, user: CurrentUser, a: ComplaintInput): Promise<Complaint> {
    const description = text(a.description);
    const sn = text(a.sn);
    const serial = await this.bySn(tx, sn);
    // 未选客户时按序列号带出（发货客户）；国家未填时按客户主数据带出
    const customerId = a.customer_id || serial?.customer_id || null;
    const cust = customerId ? await tx.customer.findUnique({ where: { id: customerId } }) : null;
    if (!cust) throw new BizError(sn && serial ? `序列号 ${sn} 尚未发货给客户，请选择投诉客户` : '请选择投诉客户');
    a = { ...a, customer_id: cust.id, country: a.country !== undefined && a.country !== null && a.country !== '' ? a.country : cust.country };
    if (!description) throw new BizError('请填写投诉内容');
    if (a.material_id && !(await tx.material.findUnique({ where: { id: a.material_id } }))) throw new NotFound('物料');
    if (serial && a.material_id && serial.material_id !== a.material_id) throw new BizError(`序列号 ${sn} 不是所选产品`);
    const material_id = a.material_id ?? serial?.material_id ?? null;
    return tx.complaint.create({
      data: {
        no: await this.numbering.nextNo(tx, 'KS'), customer_id: cust.id, received_date: a.received_date ?? today(),
        material_id, sn, lot_no: text(a.lot_no) ?? serial?.lot_no ?? null, description, is_adverse_event: !!a.is_adverse_event,
        status: 'OPEN', created_by: user.username, ...this.regData(a, null),
      },
    });
  }

  /** 法规字段（只取出现的字段）；评估为需上报且未定期限时按国家默认期限 */
  private regData(a: ComplaintInput, cur: Complaint | null): Record<string, any> {
    const data: Record<string, any> = {};
    for (const k of REG_TEXT) if (a[k] !== undefined) data[k] = text(a[k]);
    if (data.country !== undefined) data.country = normCountry(data.country);
    for (const k of REG_DATE) if (a[k] !== undefined) data[k] = a[k] ?? null;
    if (a.reportable !== undefined) data.reportable = a.reportable;
    const reportable = data.reportable !== undefined ? data.reportable : cur?.reportable;
    let deadline = data.report_deadline !== undefined ? data.report_deadline : cur?.report_deadline;
    // 国家变更且尚未上报、本次未手工指定期限 → 按新国家重算上报期限
    const countryChanged = cur && data.country !== undefined && normCountry(cur.country) !== data.country;
    if (countryChanged && a.report_deadline === undefined && !(data.report_no ?? cur?.report_no)) deadline = null;
    if (reportable && !deadline) {
      const base = a.received_date ?? cur?.received_date ?? today();
      data.report_deadline = addDays(base, reportDays(data.country !== undefined ? data.country : cur?.country));
    }
    if (data.customer_reply && !(data.replied_at ?? cur?.replied_at)) data.replied_at = today();
    return data;
  }

  /** 修改（只改请求中出现的字段；已关闭不能修改） */
  async update(tx: Tx, id: number, a: ComplaintInput): Promise<Complaint> {
    const c = await this.load(tx, id);
    this.open(c);
    const data: Record<string, any> = {};
    if (a.customer_id !== undefined) {
      if (!a.customer_id || !(await tx.customer.findUnique({ where: { id: a.customer_id } }))) throw new NotFound('客户');
      data.customer_id = a.customer_id;
    }
    if (a.received_date !== undefined && a.received_date !== null) data.received_date = a.received_date;
    if (a.material_id !== undefined) {
      if (a.material_id && !(await tx.material.findUnique({ where: { id: a.material_id } }))) throw new NotFound('物料');
      data.material_id = a.material_id ?? null;
    }
    if (a.sn !== undefined) data.sn = text(a.sn);
    if (a.lot_no !== undefined) data.lot_no = text(a.lot_no);
    if (a.description !== undefined) {
      const d = text(a.description);
      if (!d) throw new BizError('投诉内容不能为空');
      data.description = d;
    }
    if (a.is_adverse_event !== undefined) data.is_adverse_event = !!a.is_adverse_event;
    if (a.investigation !== undefined) data.investigation = text(a.investigation);
    if (a.capa_id !== undefined) {
      if (a.capa_id && !(await tx.capa.findUnique({ where: { id: a.capa_id } }))) throw new NotFound('CAPA');
      data.capa_id = a.capa_id ?? null;
    }
    Object.assign(data, this.regData(a, c));
    if (data.sn && data.material_id === undefined && !c.material_id) {
      const serial = await this.bySn(tx, data.sn);
      if (serial) Object.assign(data, { material_id: serial.material_id, lot_no: data.lot_no ?? c.lot_no ?? serial.lot_no });
    }
    // 填写了调查内容 → 自动进入调查中
    if (c.status === 'OPEN' && data.investigation) data.status = 'INVESTIGATING';
    return tx.complaint.update({ where: { id }, data });
  }

  async startInvestigation(tx: Tx, id: number, investigation?: string | null): Promise<Complaint> {
    const c = await this.load(tx, id);
    if (c.status !== 'OPEN') throw new BizError('只有“已登记”的投诉可以开始调查');
    return tx.complaint.update({ where: { id }, data: { status: 'INVESTIGATING', ...(text(investigation) ? { investigation: text(investigation) } : {}) } });
  }

  /** 由投诉开具 NCR（来源 CUSTOMER），关联到投诉 */
  async createNcr(tx: Tx, user: CurrentUser, id: number, o: { severity?: string | null; qty?: number | null } = {}): Promise<Complaint> {
    const c = await this.load(tx, id);
    this.open(c);
    if (c.ncr_id) throw new BizError('该投诉已关联 NCR');
    const severity = o.severity || (c.is_adverse_event ? 'CRITICAL' : 'MAJOR');
    if (!['MINOR', 'MAJOR', 'CRITICAL'].includes(severity)) throw new BizError('严重程度无效');
    const ncr = await tx.ncr.create({
      data: {
        no: await this.numbering.nextNo(tx, 'NCR'), source: 'CUSTOMER', severity, status: 'OPEN', customer_id: c.customer_id,
        material_id: c.material_id, lot_no: c.lot_no, sn: c.sn, qty: o.qty && o.qty > 0 ? o.qty : 1,
        description: `客户投诉 ${c.no}${c.is_adverse_event ? '【不良事件】' : ''}：${c.description}`, created_by: user.username,
      },
    });
    return tx.complaint.update({ where: { id }, data: { ncr_id: ncr.id, ...(c.status === 'OPEN' ? { status: 'INVESTIGATING' } : {}) } });
  }

  /** 由投诉发起 CAPA（来源 COMPLAINT），关联到投诉（及其 NCR） */
  async createCapa(tx: Tx, user: CurrentUser, id: number, o: { title?: string | null } = {}): Promise<Complaint> {
    const c = await this.load(tx, id);
    this.open(c);
    if (c.capa_id) throw new BizError('该投诉已关联 CAPA');
    const cust = await tx.customer.findUnique({ where: { id: c.customer_id } });
    const capa = await tx.capa.create({
      data: {
        no: await this.numbering.nextNo(tx, 'CAPA'), status: 'OPEN', source: 'COMPLAINT', created_by: user.username,
        title: (text(o.title) ?? `客户投诉 ${c.no} 纠正预防`).slice(0, 128),
        description: `来源：客户投诉 ${c.no}（${cust?.name ?? ''}）${c.is_adverse_event ? '【不良事件】' : ''}\n${c.description}`,
        due_date: capaDueDate('COMPLAINT'),
      },
    });
    if (c.ncr_id) {
      const ncr = await tx.ncr.findUnique({ where: { id: c.ncr_id } });
      if (ncr && !ncr.capa_id) await tx.ncr.update({ where: { id: ncr.id }, data: { capa_id: capa.id } });
    }
    return tx.complaint.update({ where: { id }, data: { capa_id: capa.id, ...(c.status === 'OPEN' ? { status: 'INVESTIGATING' } : {}) } });
  }

  /**
   * 结案：必须填写调查结论；不良事件必须完成上报评估（是否需上报），需上报的须填写上报编号与上报日期；QA 电子签名“客诉结案”。
   * 结案时可同时提交法规字段（上报评估、上报编号、客户回复等）。
   */
  async close(
    tx: Tx, user: CurrentUser, id: number, investigation: string | null | undefined, sig: SignatureDto | null | undefined, reg: ComplaintInput = {},
  ): Promise<Complaint> {
    const c = await this.load(tx, id);
    if (c.status === 'CLOSED') throw new BizError('投诉已结案');
    if (c.status !== 'INVESTIGATING') throw new BizError('请先开始调查，调查完成后再结案');
    const inv = text(investigation) ?? c.investigation;
    if (!inv) throw new BizError('请填写调查结论（原因分析、处理措施、是否需要上报）后再结案');
    const data = this.regData(reg, c);
    const m = { ...c, ...data } as Complaint;
    if (m.is_adverse_event && (m.reportable === null || m.reportable === undefined)) {
      throw new BizError('不良事件须先完成上报评估：请选择“需要上报”或“无需上报”（并在调查结论中写明依据）');
    }
    if (m.reportable && !(m.report_no && m.reported_at)) {
      throw new BizError(`该事件评估为需要上报：请填写上报编号与上报日期（上报期限 ${fmtDate(m.report_deadline) ?? '-'}）后再结案`);
    }
    await this.esign.sign(tx, user, sig, '客诉结案', 'qms_complaint', c.id, c.no);
    return tx.complaint.update({ where: { id }, data: { ...data, status: 'CLOSED', investigation: inv, closed_by: user.full_name, closed_at: new Date() } });
  }

  /** 按序列号带出产品、批号、发货客户与客户国家（登记投诉时扫码/输入序列号） */
  async lookupSn(tx: Tx, snText: string) {
    const sn = text(snText);
    const s = sn ? await tx.serialNumber.findUnique({ where: { sn }, include: { material: true, shipment: true } }) : null;
    if (!s) return { found: false };
    const cust = s.customer_id ? await tx.customer.findUnique({ where: { id: s.customer_id } }) : null;
    return {
      found: true, sn: s.sn, material_id: s.material_id, material_code: s.material.code, material_name: s.material.name, lot_no: s.lot_no,
      customer_id: cust?.id ?? null, customer_name: cust?.name ?? null, country: normCountry(cust?.country),
      shipment_no: s.shipment?.no ?? null, shipped_at: s.shipped_at,
    };
  }

  /** 上报倒计时：需上报（或不良事件尚未评估）且未上报时给出期限与剩余天数 */
  private reportDue(r: Complaint) {
    if (r.report_no || r.reportable === false || (!r.reportable && !r.is_adverse_event)) return { report_due: fmtDate(r.report_deadline), report_days_left: null };
    const due = r.report_deadline ?? addDays(r.received_date, reportDays(r.country));
    return {
      report_due: fmtDate(due),
      report_days_left: r.status === 'CLOSED' ? null : Math.round((due.getTime() - today().getTime()) / 86400000),
    };
  }

  /** 序列化并补充关联名称 */
  async enrich(tx: Tx, rows: Complaint[]): Promise<any[]> {
    const ids = (f: (r: Complaint) => number | null | undefined) => [...new Set(rows.map(f).filter((x): x is number => !!x))];
    const names = await fullNames(tx, rows.map((r) => r.created_by));
    const [customers, materials, ncrs, capas] = await Promise.all([
      tx.customer.findMany({ where: { id: { in: ids((r) => r.customer_id) } } }),
      tx.material.findMany({ where: { id: { in: ids((r) => r.material_id) } } }),
      tx.ncr.findMany({ where: { id: { in: ids((r) => r.ncr_id) } } }),
      tx.capa.findMany({ where: { id: { in: ids((r) => r.capa_id) } } }),
    ]);
    const c = new Map(customers.map((x) => [x.id, x]));
    const m = new Map(materials.map((x) => [x.id, x]));
    const n = new Map(ncrs.map((x) => [x.id, x]));
    const k = new Map(capas.map((x) => [x.id, x]));
    return rows.map((r) => {
      const mat = r.material_id ? m.get(r.material_id) : null;
      const ncr = r.ncr_id ? n.get(r.ncr_id) : null;
      const capa = r.capa_id ? k.get(r.capa_id) : null;
      return {
        ...ser('Complaint', r),
        customer_name: c.get(r.customer_id)?.name ?? null,
        material_code: mat?.code ?? null,
        material_name: mat?.name ?? null,
        ncr_no: ncr?.no ?? null,
        ncr_status: ncr?.status ?? null,
        capa_no: capa?.no ?? null,
        capa_status: capa?.status ?? null,
        created_by_name: r.created_by ? names.get(r.created_by) ?? r.created_by : null,
        customer_country: c.get(r.customer_id)?.country ?? null,
        ...this.reportDue(r),
      };
    });
  }
}
