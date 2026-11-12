import { today } from '../common/dates';
import type { Tx } from '../common/prisma.service';

/**
 * 产品当前生效的已发布 BOM（GMP：只能使用受控版本）。
 * 生效日期在未来的版本批准后为“已批准待生效”（APPROVED），到生效日才转为已发布（见 activateDueBoms），
 * 因此这里只取“已发布且生效日期不晚于今天”的版本；同时有多个时取生效日期最晚、版本最新的。
 */
export const releasedBom = (tx: Tx, materialId: number) =>
  tx.bom.findFirst({
    where: { material_id: materialId, status: 'RELEASED', OR: [{ effective_date: null }, { effective_date: { lte: today() } }] },
    orderBy: [{ effective_date: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    include: { lines: { include: { component: true }, orderBy: { line_no: 'asc' } } },
  });

export const releasedRouting = (tx: Tx, materialId: number) =>
  tx.routing.findFirst({
    where: { material_id: materialId, status: 'RELEASED' },
    orderBy: { id: 'desc' },
    include: { operations: { orderBy: { seq: 'asc' }, include: { params: { orderBy: { id: 'asc' } } } } },
  });

/**
 * 生效日期已到的“已批准待生效”BOM 转为已发布，同产品原已发布版本作废（同一时间只有一个生效版本）。
 * 由批准、工单下达、定时任务调用（D#18：生效日期前旧版本继续用于新工单与 MRP）。
 */
export async function activateDueBoms(tx: Tx, materialId?: number): Promise<number> {
  const due = await tx.bom.findMany({
    where: { status: 'APPROVED', effective_date: { lte: today() }, ...(materialId ? { material_id: materialId } : {}) },
    orderBy: [{ effective_date: 'asc' }, { id: 'asc' }],
  });
  for (const b of due) {
    await tx.bom.updateMany({ where: { material_id: b.material_id, status: 'RELEASED', id: { not: b.id } }, data: { status: 'OBSOLETE' } });
    await tx.bom.update({ where: { id: b.id }, data: { status: 'RELEASED' } });
  }
  return due.length;
}

// ---------------------------------------------------------------------------
// 工程变更差异（F11 / D#2）：与上一版本逐项比较，新增 / 删除 / 修改，判定规格（上下限、类型）变化单独标记
// ---------------------------------------------------------------------------

export interface DiffItem {
  kind: 'added' | 'removed' | 'changed';
  scope: 'operation' | 'param' | 'line';
  /** 定位键：op:工序编码 / param:工序编码/测试项编码 / line:组件id */
  key: string;
  /** 对象：工序 30 老化测试 / 老化测试 · 测试项 AGE_H 老化时长 / 组件 PSU-24V-5A 电源适配器 */
  title: string;
  field?: string;
  label?: string;
  before?: unknown;
  after?: unknown;
  /** 判定规格变化（上下限 / 测试项类型 / 新增删除测试项）或 BOM 用量变化：界面醒目显示 */
  limit?: boolean;
  text: string;
  /** 摘要分组（工序名称；BOM 为空）与组内短句，用于生成精简的变更摘要 */
  group?: string;
  short?: string;
}

type Row = Record<string, any>;

const show = (v: unknown, field?: string): string => {
  if (v === null || v === undefined || v === '') return '空';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (field === 'param_type') return v === 'OKNG' ? 'OK/NG 判定' : '数值';
  if (field === 'scrap_rate' && typeof v === 'number') return `${Math.round(v * 10000) / 100}%`;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
};

const same = (a: unknown, b: unknown) => {
  const na = a === undefined || a === '' ? null : a;
  const nb = b === undefined || b === '' ? null : b;
  if (typeof na === 'number' && typeof nb === 'number') return Math.abs(na - nb) < 1e-9;
  return na === nb;
};

/** [比较字段, 中文名, 显示字段] */
const OP_FIELDS: [string, string, string?][] = [
  ['seq', '工序号'], ['name', '工序名称'], ['op_type', '类型', 'op_type_text'], ['work_center_id', '工作中心', 'work_center_name'], ['std_minutes', '标准工时(分)'],
  ['requires_equipment', '需设备'], ['key_part_material_id', '关键件', 'key_part_material_code'], ['sop_no', 'SOP 编号'], ['instructions', '作业指导'],
];
const OP_TYPE_TEXT: Record<string, string> = {
  SMT: 'SMT贴片', ASSEMBLY: '组装', TEST_OPTICAL: '光学性能测试', AGING: '老化', TEST_SAFETY: '安规测试', INSPECTION: '检验', PACKING: '包装', OTHER: '其他',
};
const PARAM_FIELDS: [string, string][] = [
  ['name', '名称'], ['param_type', '类型'], ['unit', '单位'], ['lower', '下限'], ['upper', '上限'], ['target', '目标值'],
  ['decimals', '小数位'], ['min_valid', '合理范围下限'], ['max_valid', '合理范围上限'],
];
const LIMIT_FIELDS = new Set(['lower', 'upper', 'param_type']);
const LINE_FIELDS: [string, string][] = [['qty_per', '单位用量'], ['scrap_rate', '损耗率'], ['designator', '位号'], ['remark', '备注']];

const opView = (o: Row): Row => ({
  ...o,
  work_center_id: o.work_center_id ?? null,
  key_part_material_id: o.key_part_material_id ?? null,
  op_type_text: OP_TYPE_TEXT[o.op_type] ?? o.op_type,
  work_center_name: o.work_center_name ?? o.work_center?.name ?? null,
  key_part_material_code: o.key_part_material_code ?? o.key_part_material?.code ?? null,
});
const opTitle = (o: Row) => `工序 ${o.seq} ${o.name}`;
/** 作业指导等长文本的变化只写“已修改（+N 行 / -M 行）”，不贴全文 */
const linesDelta = (a: unknown, b: unknown) => {
  const la = String(a ?? '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const lb = String(b ?? '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const add = lb.filter((x) => !la.includes(x)).length;
  const del = la.filter((x) => !lb.includes(x)).length;
  return [add ? `+${add} 行` : '', del ? `-${del} 行` : ''].filter(Boolean).join(' / ') || '改动';
};
const paramTitle = (o: Row, p: Row) => `${o.name} · 测试项 ${p.code} ${p.name}`;
const specOf = (p: Row) => {
  if (p.param_type === 'OKNG') return 'OK/NG 判定';
  const u = p.unit ? ` ${p.unit}` : '';
  if (p.lower != null && p.upper != null) return `${p.lower}~${p.upper}${u}`;
  if (p.lower != null) return `≥${p.lower}${u}`;
  if (p.upper != null) return `≤${p.upper}${u}`;
  return '仅记录';
};

/** 工艺路线差异：工序按工序编码对应，测试项按（工序编码, 测试项编码）对应 */
export function diffRouting(base: Row | null, cur: Row): DiffItem[] {
  if (!base) return [];
  const out: DiffItem[] = [];
  const key = (o: Row) => String(o.code ?? '').trim().toUpperCase() || `#${o.seq}`;
  const bOps = new Map<string, Row>((base.operations || []).map((o: Row) => [key(o), o]));
  const cOps = new Map<string, Row>((cur.operations || []).map((o: Row) => [key(o), o]));
  for (const [k, o] of cOps) {
    const b = bOps.get(k);
    if (!b) {
      const t = `新增${opTitle(o)}${(o.params || []).length ? `（含 ${(o.params || []).length} 个测试项）` : ''}`;
      out.push({ kind: 'added', scope: 'operation', key: `op:${k}`, title: opTitle(o), limit: (o.params || []).length > 0, text: t, group: '', short: t });
      continue;
    }
    const bv = opView(b);
    const cv = opView(o);
    for (const [f, label, disp] of OP_FIELDS) {
      if (!same(bv[f], cv[f])) {
        const d = disp ?? f;
        const before = bv[d] ?? bv[f] ?? null;
        const after = cv[d] ?? cv[f] ?? null;
        const short = f === 'instructions' ? `作业指导已修改（${linesDelta(before, after)}）` : `${label} ${show(before)} → ${show(after)}`;
        out.push({ kind: 'changed', scope: 'operation', key: `op:${k}`, title: opTitle(o), field: f, label, before, after, text: `${opTitle(o)}：${short}`, group: o.name, short });
      }
    }
    const pk = (p: Row) => String(p.code ?? '').trim().toUpperCase();
    const bPs = new Map<string, Row>((b.params || []).map((p: Row) => [pk(p), p]));
    const cPs = new Map<string, Row>((o.params || []).map((p: Row) => [pk(p), p]));
    for (const [pc, p] of cPs) {
      const bp = bPs.get(pc);
      if (!bp) {
        const short = `新增测试项 ${p.code} ${p.name}（${specOf(p)}）`;
        out.push({ kind: 'added', scope: 'param', key: `param:${k}/${pc}`, title: paramTitle(o, p), limit: true, after: specOf(p), text: `${o.name}：${short}`, group: o.name, short });
        continue;
      }
      const norm = (x: Row): Row => ({ ...x, param_type: x.param_type || 'NUMBER' });
      const nb = norm(bp);
      const nc = norm(p);
      for (const [f, label] of PARAM_FIELDS) {
        if (!same(nb[f], nc[f])) {
          out.push({
            kind: 'changed', scope: 'param', key: `param:${k}/${pc}`, title: paramTitle(o, p), field: f, label, before: nb[f] ?? null, after: nc[f] ?? null,
            limit: LIMIT_FIELDS.has(f), text: `${o.name}：${p.name} ${label} ${show(nb[f], f)} → ${show(nc[f], f)}`,
            group: o.name, short: `${p.name} ${label} ${show(nb[f], f)}→${show(nc[f], f)}`,
          });
        }
      }
    }
    for (const [pc, p] of bPs) {
      if (!cPs.has(pc)) {
        const short = `删除测试项 ${p.code} ${p.name}（原规格 ${specOf(p)}）`;
        out.push({ kind: 'removed', scope: 'param', key: `param:${k}/${pc}`, title: paramTitle(b, p), limit: true, before: specOf(p), text: `${b.name}：${short}`, group: o.name, short });
      }
    }
    // 测试项顺序（决定工位上的录入顺序，N8）
    const bOrder = (b.params || []).map(pk).filter((x: string) => cPs.has(x));
    const cOrder = (o.params || []).map(pk).filter((x: string) => bPs.has(x));
    if (bOrder.join(',') !== cOrder.join(',')) {
      const short = `测试项顺序 ${bOrder.join('→')} 改为 ${cOrder.join('→')}`;
      out.push({ kind: 'changed', scope: 'param', key: `op:${k}`, title: opTitle(o), field: 'param_order', label: '测试项顺序（工位录入顺序）', before: bOrder.join(' → '), after: cOrder.join(' → '), text: `${o.name}：${short}`, group: o.name, short });
    }
    // 作业指导附件增删（N8：附件随版本审批）
    const att = (x: Row) => new Map<string, string>(((x.attachments || []) as Row[]).map((a) => [`${a.sha256 ?? ''}/${a.filename}`, String(a.filename)]));
    const bA = att(b);
    const cA = att(o);
    for (const [ak, fn] of cA) {
      if (!bA.has(ak)) out.push({ kind: 'added', scope: 'operation', key: `op:${k}`, title: `${opTitle(o)} · 附件`, field: 'attachment', after: fn, text: `${o.name}：新增作业指导附件 ${fn}`, group: o.name, short: `新增附件 ${fn}` });
    }
    for (const [ak, fn] of bA) {
      if (!cA.has(ak)) out.push({ kind: 'removed', scope: 'operation', key: `op:${k}`, title: `${opTitle(o)} · 附件`, field: 'attachment', before: fn, text: `${o.name}：删除作业指导附件 ${fn}`, group: o.name, short: `删除附件 ${fn}` });
    }
  }
  for (const [k, b] of bOps) {
    if (!cOps.has(k)) out.push({ kind: 'removed', scope: 'operation', key: `op:${k}`, title: opTitle(b), limit: (b.params || []).length > 0, text: `删除${opTitle(b)}`, group: '', short: `删除${opTitle(b)}` });
  }
  return out;
}

/** BOM 差异：按组件对应 */
export function diffBom(base: Row | null, cur: Row): DiffItem[] {
  if (!base) return [];
  const out: DiffItem[] = [];
  const name = (l: Row) => `${l.component_code ?? l.component?.code ?? l.component_id} ${l.component_name ?? l.component?.name ?? ''}`.trim();
  const bL = new Map<number, Row>((base.lines || []).map((l: Row) => [Number(l.component_id), l]));
  const cL = new Map<number, Row>((cur.lines || []).map((l: Row) => [Number(l.component_id), l]));
  for (const [id, l] of cL) {
    const b = bL.get(id);
    if (!b) {
      out.push({ kind: 'added', scope: 'line', key: `line:${id}`, title: `组件 ${name(l)}`, after: l.qty_per, text: `新增组件 ${name(l)} × ${l.qty_per}`, group: '', short: `新增 ${name(l)} × ${l.qty_per}` });
      continue;
    }
    for (const [f, label] of LINE_FIELDS) {
      if (!same(b[f], l[f])) {
        out.push({
          kind: 'changed', scope: 'line', key: `line:${id}`, title: `组件 ${name(l)}`, field: f, label, before: b[f] ?? null, after: l[f] ?? null,
          limit: f === 'qty_per', text: `${name(l)}：${label} ${show(b[f], f)} → ${show(l[f], f)}`, group: '', short: `${name(l)} ${label} ${show(b[f], f)}→${show(l[f], f)}`,
        });
      }
    }
  }
  for (const [id, b] of bL) {
    if (!cL.has(id)) out.push({ kind: 'removed', scope: 'line', key: `line:${id}`, title: `组件 ${name(b)}`, before: b.qty_per, text: `删除组件 ${name(b)}（原用量 ${b.qty_per}）`, group: '', short: `删除 ${name(b)}（原用量 ${b.qty_per}）` });
  }
  return out;
}

/**
 * 变更摘要（提交签名、审批页显示，N10 精简）：按工序归并，同一测试项的多处修改合成一句；
 * 例：“【光学性能测试】红光峰值波长 小数位 空→1、合理范围下限 空→600；新增测试项 UNI 均匀度（≥80 %）。【老化测试】…”。最多 maxLen 字。
 */
export function diffSummary(items: DiffItem[], maxLen = 600): string {
  if (!items.length) return '与上一版本相比无内容变化';
  const groups = new Map<string, string[]>();
  let lastKey = '';
  for (const i of items) {
    const g = i.group ?? '';
    const list = groups.get(g) ?? [];
    const short = i.short ?? i.text;
    // 同一测试项连续的字段修改：“名称 字段a a→b、字段b c→d”
    if (i.kind === 'changed' && i.scope === 'param' && i.field !== 'param_order' && lastKey === `${g}|${i.key}` && list.length) {
      list[list.length - 1] += `、${short.replace(/^\S+\s/, '')}`;
    } else list.push(short);
    lastKey = `${g}|${i.key}`;
    groups.set(g, list);
  }
  const s = [...groups].map(([g, l]) => `${g ? `【${g}】` : ''}${l.join('；')}`).join('。');
  return s.length > maxLen ? `${s.slice(0, maxLen - 12)}…（共 ${items.length} 处）` : s;
}
