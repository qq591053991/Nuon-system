/**
 * 放行结论（DHR 审核顶部“放行结论卡”）：按序列号逐项检查，只读、无副作用。
 *   工序合格     全部工序已完成且每道工序的最后结果为合格
 *   无未关 NCR   该台没有待处置 NCR（已处置未关闭给提示）
 *   返工已复测   返工处置后已在不合格工序复测合格
 *   用料已 IQC   本工单所用物料批次均已检验合格/让步（免检物料、期初库存注明）
 *   设备在校准期 该台过站使用的计量设备在使用当日处于校准有效期内
 *   人员资质     该台每道工序的操作员在报工当日持有该工序（或全部工序）的有效上岗资质
 * 批量（非序列号）产品按整张工单检查。另返回本工单 NCR 的处置/关闭签名，供 DHR 签名区汇总。
 */
import { Injectable } from '@nestjs/common';
import { dateOnly, fmtDate, localDateStr } from '../common/dates';
import { NotFound } from '../common/errors';
import { EPS, g, round } from '../common/num';
import type { Tx } from '../common/prisma.service';

type Level = 'ok' | 'warn' | 'fail';
interface Check { ok: boolean; level: Level; text: string }
const ok = (text: string): Check => ({ ok: true, level: 'ok', text });
const warn = (text: string): Check => ({ ok: true, level: 'warn', text });
const fail = (text: string): Check => ({ ok: false, level: 'fail', text });

export const RELEASE_CHECKS = [
  { key: 'ops', label: '工序合格' },
  { key: 'ncr', label: '无未关 NCR' },
  { key: 'rework', label: '返工已复测' },
  { key: 'iqc', label: '用料已 IQC' },
  { key: 'equipment', label: '设备在校准期' },
  { key: 'qualification', label: '人员资质' },
] as const;

const dayOf = (d: Date) => dateOnly(localDateStr(d))!.getTime();

@Injectable()
export class ReleaseCheckService {
  async check(tx: Tx, woId: number) {
    const wo = await tx.workOrder.findUnique({ where: { id: woId }, include: { material: true } });
    if (!wo) throw new NotFound('生产工单');
    const ops = await tx.workOrderOperation.findMany({ where: { wo_id: wo.id }, orderBy: { seq: 'asc' } });
    const lastSeq = ops.length ? ops[ops.length - 1].seq : 0;
    const records = await tx.operationRecord.findMany({ where: { wo_id: wo.id }, orderBy: { id: 'asc' }, include: { equipment: true } });
    const ncrs = await tx.ncr.findMany({ where: { wo_id: wo.id }, orderBy: { id: 'asc' } });

    // ---------- 用料 IQC（工单级） ----------
    const lots = await this.lotChecks(tx, wo.id, ncrs.map((n) => n.id));
    const lotFail = lots.filter((l) => l.level === 'fail');
    const lotWarn = lots.filter((l) => l.level === 'warn');
    const iqc: Check = lotFail.length
      ? fail(lotFail.map((l) => `${l.material_code} ${l.lot_no}：${l.text}`).join('；'))
      : lotWarn.length
        ? warn(`${lots.length - lotWarn.length}/${lots.length} 个批次已检验；${lotWarn.map((l) => `${l.material_code} ${l.lot_no} ${l.text}`).join('；')}`)
        : lots.length ? ok(`${lots.length} 个物料批次均已检验合格或免检`) : warn('尚无已过账的领料记录');

    // ---------- 人员资质（按操作员 + 工序代码 + 日期） ----------
    const usernames = [...new Set(records.map((r) => r.operator))];
    const users = usernames.length ? await tx.user.findMany({ where: { username: { in: usernames } }, include: { qualifications: true } }) : [];
    const quals = new Map(users.map((u) => [u.username, u.qualifications]));
    const qualified = (r: (typeof records)[number]) => {
      const day = dayOf(r.ts);
      return (quals.get(r.operator) ?? []).some(
        (q) => q.is_active && q.level !== 'TRAINEE' && (q.op_code === '*' || q.op_code === r.op_code) &&
          q.certified_at.getTime() <= day && (!q.expires_at || q.expires_at.getTime() >= day),
      );
    };
    // ---------- 设备校准（使用当日在有效期内） ----------
    const calOk = (r: (typeof records)[number]) => {
      const e = r.equipment;
      if (!e || !e.calibration_required) return true;
      return !!e.next_calibration_date && e.next_calibration_date.getTime() >= dayOf(r.ts);
    };

    const recordChecks = (recs: typeof records) => {
      const badQual = recs.filter((r) => !qualified(r));
      const badCal = recs.filter((r) => !calOk(r));
      const eqCodes = [...new Set(recs.filter((r) => r.equipment?.calibration_required).map((r) => r.equipment!.code))];
      return {
        equipment: badCal.length
          ? fail(badCal.map((r) => `工序 ${r.seq} 使用 ${r.equipment?.code}（校准有效期至 ${fmtDate(r.equipment?.next_calibration_date) ?? '未校准'}）`).join('；'))
          : ok(eqCodes.length ? `${eqCodes.join('、')} 使用时均在校准有效期内` : '未使用需校准的设备'),
        qualification: badQual.length
          ? fail([...new Set(badQual.map((r) => `${r.operator_name || r.operator} 无工序 ${r.op_code}（${r.op_name}）有效资质`))].join('；'))
          : recs.length ? ok(`${[...new Set(recs.map((r) => r.operator_name || r.operator))].join('、')} 资质有效`) : warn('尚无报工记录'),
      };
    };

    // 返工复测：处置为返工的 NCR 在处置后于该工序复测合格
    const retested = (n: (typeof ncrs)[number], recs: typeof records) => {
      const after = (n.disposition_at ?? n.created_at).getTime();
      const pass = recs.filter((r) => r.seq === n.op_seq && r.result === 'PASS' && r.ts.getTime() > after);
      if (n.sn) return pass.length > 0;
      return pass.reduce((s, r) => s + r.qty, 0) + EPS >= n.qty;
    };
    const ncrCheck = (list: typeof ncrs): Check => {
      const open = list.filter((n) => n.status === 'OPEN');
      const disp = list.filter((n) => n.status === 'DISPOSITIONED');
      if (open.length) return fail(`待处置：${open.map((n) => n.no).join('、')}`);
      if (disp.length) return warn(`已处置未关闭：${disp.map((n) => n.no).join('、')}`);
      return ok(list.length ? `${list.length} 条 NCR 均已关闭` : '无不合格记录');
    };
    const reworkCheck = (list: typeof ncrs, recs: typeof records): Check => {
      const rw = list.filter((n) => n.disposition === 'REWORK');
      if (!rw.length) return ok('无返工');
      const bad = rw.filter((n) => !retested(n, recs));
      return bad.length ? fail(bad.map((n) => `${n.no} 返工后未在工序 ${n.op_seq} 复测合格`).join('；')) : ok(`${rw.length} 次返工均已复测合格`);
    };

    const units: Record<string, any>[] = [];
    let woLevel: Record<string, Check> | null = null;
    if (wo.material.serial_control) {
      const sns = await tx.serialNumber.findMany({ where: { wo_id: wo.id }, orderBy: { sn: 'asc' }, include: { release: true } });
      const bySn = new Map<number, typeof records>();
      for (const r of records) if (r.sn_id) (bySn.get(r.sn_id) ?? bySn.set(r.sn_id, []).get(r.sn_id)!).push(r);
      for (const s of sns) {
        if (s.status === 'SCRAPPED') continue;
        const recs = bySn.get(s.id) ?? [];
        const lastBySeq = new Map<number, (typeof records)[number]>();
        for (const r of recs) lastBySeq.set(r.seq, r);
        const failed = [...lastBySeq.values()].filter((r) => r.result !== 'PASS');
        const missing = ops.filter((o) => !lastBySeq.has(o.seq));
        const opsCheck = failed.length
          ? fail(failed.map((r) => `工序 ${r.seq} ${r.op_name} 最后结果不合格`).join('；'))
          : missing.length || (s.last_seq || 0) < lastSeq
            ? fail(`未完成：${missing.map((o) => `${o.seq} ${o.name}`).join('、') || `停在工序 ${s.last_seq}`}`)
            : ok(`全部 ${ops.length} 道工序合格`);
        const mine = ncrs.filter((n) => n.sn === s.sn);
        const checks: Record<string, Check> = {
          ops: opsCheck, ncr: ncrCheck(mine), rework: reworkCheck(mine, recs), iqc, ...recordChecks(recs),
        };
        const released = s.release?.status === 'RELEASED';
        const eligible = s.status === 'IN_STOCK' && !s.release_id;
        units.push({
          sn: s.sn, status: s.status, release_no: s.release?.no ?? null, release_status: s.release?.status ?? null,
          eligible, released, ok: Object.values(checks).every((c) => c.ok), checks,
        });
      }
    } else {
      const recs = records;
      const lastPass = ops.every((o) => recs.some((r) => r.seq === o.seq && r.result === 'PASS'));
      woLevel = {
        ops: lastPass ? ok(`全部 ${ops.length} 道工序有合格报工`) : fail('尚有工序无合格报工'),
        ncr: ncrCheck(ncrs), rework: reworkCheck(ncrs, recs), iqc, ...recordChecks(recs),
      };
    }

    // 物料足额领用（按“已放行 + 本次可放行”累计数量）
    const mats = await tx.workOrderMaterial.findMany({ where: { wo_id: wo.id }, include: { material: true }, orderBy: { id: 'asc' } });
    const candidates = wo.material.serial_control ? units.filter((u) => u.eligible).length : Math.max(0, round((wo.received_qty || 0) - (wo.released_qty || 0)));
    const after = round((wo.released_qty || 0) + candidates);
    const short = mats.filter((m) => (m.issued_qty || 0) + EPS < (m.qty_per || 0) * after);
    const issue: Check = short.length
      ? fail(short.map((m) => `${m.material.code} 已领 ${g(m.issued_qty)} < 应耗 ${g(round(m.qty_per * after))}`).join('；'))
      : ok(`按放行后累计 ${g(after)} ${wo.material.uom} 计，物料均已足额领用`);

    const eligibleUnits = units.filter((u) => u.eligible);
    const sigs = ncrs.length
      ? await tx.eSignature.findMany({ where: { entity: 'qms_ncr', entity_id: { in: ncrs.map((n) => n.id) } }, orderBy: { id: 'asc' } })
      : [];
    return {
      wo_id: wo.id, wo_no: wo.no, lot_no: wo.lot_no, serial_control: wo.material.serial_control, uom: wo.material.uom,
      checks_def: RELEASE_CHECKS,
      summary: {
        total: units.length,
        candidates: wo.material.serial_control ? eligibleUnits.length : candidates,
        ready: wo.material.serial_control ? eligibleUnits.filter((u) => u.ok).length : woLevel && Object.values(woLevel).every((c) => c.ok) && !short.length ? candidates : 0,
        blocked: wo.material.serial_control ? eligibleUnits.filter((u) => !u.ok).length : 0,
        released: units.filter((u) => u.released).length,
        in_process: units.filter((u) => !u.eligible && !u.release_no && u.status !== 'SHIPPED').length,
      },
      wo_checks: { issue, iqc },
      wo_level: woLevel,
      units,
      lots,
      ncr_signatures: sigs.map((s) => ({ ts: s.ts, full_name: s.full_name, meaning: s.meaning, reason: s.reason, doc_no: s.doc_no })),
    };
  }

  /** 工单所用物料批次（领料 − 退料 + 返工补料）的 IQC 结论 */
  private async lotChecks(tx: Tx, woId: number, ncrIds: number[]) {
    const lines = await tx.materialIssueLine.findMany({ where: { issue: { wo_id: woId, status: 'CONFIRMED' } }, include: { issue: true, material: true } });
    const moves = ncrIds.length
      ? await tx.stockMove.findMany({ where: { move_type: 'REWORK_ISSUE', ref_type: 'NCR', ref_id: { in: ncrIds } }, include: { material: true } })
      : [];
    const key = new Map<string, { material_id: number; material_code: string; material_name: string; iqc_required: boolean; lot_no: string; qty: number }>();
    const add = (mid: number, m: { code: string; name: string; iqc_required: boolean }, lot: string, q: number) => {
      const k = `${mid}\u0000${lot}`;
      const row = key.get(k) ?? { material_id: mid, material_code: m.code, material_name: m.name, iqc_required: m.iqc_required, lot_no: lot, qty: 0 };
      row.qty = round(row.qty + q);
      key.set(k, row);
    };
    for (const l of lines) add(l.material_id, l.material, l.lot_no, l.issue.issue_type === 'RETURN' ? -l.qty : l.qty);
    for (const mv of moves) add(mv.material_id, mv.material, mv.lot_no, mv.qty);
    const out = [];
    for (const r of key.values()) {
      if (r.qty <= EPS) continue;
      const insp = await tx.inspection.findFirst({ where: { material_id: r.material_id, lot_no: r.lot_no }, orderBy: { id: 'desc' } });
      let level: Level;
      let text: string;
      if (insp) {
        if (insp.status === 'PASSED') [level, text] = ['ok', `${insp.no} 合格`];
        else if (insp.status === 'CONCESSION') [level, text] = ['warn', `${insp.no} 让步接收`];
        else if (insp.status === 'PENDING') [level, text] = ['fail', `${insp.no} 待检验`];
        else [level, text] = ['fail', `${insp.no} 不合格`];
      } else if (!r.iqc_required) [level, text] = ['ok', '免检物料'];
      else {
        const rl = await tx.receiptLine.findFirst({ where: { material_id: r.material_id, lot_no: r.lot_no }, include: { receipt: true }, orderBy: { id: 'asc' } });
        if (!rl || rl.receipt.receipt_type === 'OPENING') [level, text] = ['ok', '期初库存（上线前已检验）'];
        else [level, text] = ['warn', `无检验记录（${rl.receipt.no}）`];
      }
      out.push({ ...r, iqc_no: insp?.no ?? null, iqc_status: insp?.status ?? null, level, text });
    }
    return out;
  }
}

