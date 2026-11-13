/**
 * 仓库单据打印页（新标签页打开，屏幕上即为打印预览）：
 *   /wms/print/receipt/:id   入库单          /wms/print/issue/:id    拣料单（领料/退料单）
 *   /wms/print/shipment/:id  发货单 + 装箱单  /wms/print/count/:id    盘点表（盲盘不印账面）
 *   /wms/print/labels?receipt=ID | stock=1,2 | lot=批号 | location=1,2 | warehouse_id=ID | tags=1,2   批次标签 / 库位标签 / RFID 标签
 *   批次标签按已发卡的包装标签逐包打印（每包一张，印 EPC）；未发卡的批次印“EPC 未发卡”。库位标签印库位 EPC。
 */
import { Alert, Button, Card, Empty, Radio, Space, Spin, Typography } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import { useEffect, useState, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { get, type Rec } from '../../api/http';
import { PrintButton, PrintHeader, PrintSignatures } from '../../components/Print';
import { dictLabel } from '../../utils/dict';
import { useCompany } from '../../utils/company';
import { fmtDate, fmtDateTime, fmtQty } from '../../utils/format';
import { Barcode, LocationLabel, LotLabel, printLabels, type LabelSize } from './print';

const byRoute = (a: Rec, b: Rec) => String(a.location_code).localeCompare(String(b.location_code)) || String(a.material_code).localeCompare(String(b.material_code)) || String(a.lot_no).localeCompare(String(b.lot_no));

function Info({ items }: { items: [string, ReactNode][] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 8 }}>
      <tbody>
        {Array.from({ length: Math.ceil(items.length / 3) }).map((_, r) => (
          <tr key={r}>
            {items.slice(r * 3, r * 3 + 3).map(([k, v]) => (
              <td key={k} style={{ border: '1px solid #999', padding: '3px 6px', width: '33%' }}><span style={{ color: '#555' }}>{k}：</span>{v ?? '-'}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DocTable({ columns, rows }: { columns: { title: string; render: (r: Rec, i: number) => ReactNode; width?: number | string; align?: 'right' | 'center' }[]; rows: Rec[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr>{columns.map((c) => <th key={c.title} style={{ border: '1px solid #666', background: '#f0f0f0', padding: '4px', width: c.width, textAlign: c.align ?? 'left' }}>{c.title}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.id ?? i} style={{ breakInside: 'avoid' }}>
            {columns.map((c) => <td key={c.title} style={{ border: '1px solid #999', padding: '4px', textAlign: c.align ?? 'left', verticalAlign: 'top' }}>{c.render(r, i)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 单据标题（屏幕显示；打印时由 PrintHeader 提供抬头）+ 单号条码（屏幕与打印都显示，便于扫码枪扫单号） */
const Title = ({ text, no }: { text: string; no: string }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 8 }}>
    <div className="no-print" style={{ fontSize: 20, fontWeight: 700 }}>{text}</div>
    <div style={{ width: 200, marginLeft: 'auto' }}><Barcode value={no} height={34} /></div>
  </div>
);

/** 本公司抬头（系统设置 › 公司信息）：发货单用中文，装箱单用英文 */
function CompanyHead({ en = false }: { en?: boolean }) {
  const c = useCompany() as (Record<string, string> | null);
  if (!c?.name && !c?.name_en) return null;
  const name = en ? c.name_en || c.name : c.name;
  const sub = en ? c.name : c.name_en;
  const tel = c.phone ? `${en ? 'Tel' : '电话'}：${c.phone}` : '';
  const tax = c.tax_no && !en ? `税号：${c.tax_no}` : '';
  return (
    <div style={{ textAlign: 'center', marginBottom: 6 }}>
      <div style={{ fontSize: 16, fontWeight: 700 }}>{name}</div>
      {sub && <div style={{ fontSize: 11 }}>{sub}</div>}
      <div style={{ fontSize: 11 }}>{[en ? c.address_en || c.address : c.address, tel, tax].filter(Boolean).join('　')}</div>
    </div>
  );
}

const mat = (r: Rec) => <><b>{r.material_code}</b><div style={{ fontSize: 10, color: '#555' }}>{r.material_name}{r.material_spec ? ` | ${r.material_spec}` : ''}</div></>;

function ReceiptDoc({ d }: { d: Rec }) {
  return (
    <>
      <PrintHeader title="入库单" no={d.no} />
      <Title text={`入库单（${dictLabel('receipt_type', d.receipt_type)}）`} no={d.no} />
      <Info items={[['单号', d.no], ['收货日期', fmtDate(d.receipt_date)], ['供应商/客户', d.partner_name], ['采购订单', d.po_no], ['生产工单', d.wo_no], ['送货单号', d.delivery_note], ['经办人', d.created_by], ['备注', d.remark], ['行数', d.lines?.length]]} />
      <DocTable rows={d.lines || []} columns={[
        { title: '行', width: 30, render: (r) => r.line_no },
        { title: '物料', render: mat },
        { title: '批号', render: (r) => <span className="mono">{r.lot_no || '-'}</span> },
        { title: '原厂批号', render: (r) => r.supplier_lot || '-' },
        { title: '数量', align: 'right', render: (r) => `${fmtQty(r.qty)} ${r.uom ?? ''}` },
        { title: '库位', render: (r) => <b className="mono">{r.location_code}</b> },
        { title: '状态', render: (r) => dictLabel('stock_status', r.status) },
        { title: '生产/有效期', render: (r) => `${fmtDate(r.mfg_date)} / ${fmtDate(r.expiry_date)}` },
      ]} />
      <PrintSignatures roles={['送货人', '仓管收货', 'IQC']} />
    </>
  );
}

function IssueDoc({ d }: { d: Rec }) {
  const ret = d.issue_type === 'RETURN';
  const lines = [...(d.lines || [])].sort(byRoute);
  return (
    <>
      <PrintHeader title={ret ? '生产退料单' : '拣料单 / 生产领料单'} no={d.no} />
      <Title text={ret ? '生产退料单' : '拣料单（生产领料）'} no={d.no} />
      <Info items={[['单号', d.no], ['生产工单', d.wo_no], ['状态', dictLabel('doc_status', d.status)], ['制单', `${d.created_by ?? ''} ${fmtDateTime(d.created_at)}`], ['过账', d.confirmed_by ? `${d.confirmed_by} ${fmtDateTime(d.confirmed_at)}` : '-'], ['备注', d.remark]]} />
      <DocTable rows={lines} columns={[
        { title: '#', width: 26, render: (_, i) => i + 1 },
        { title: '库位', width: 70, render: (r) => <b className="mono" style={{ fontSize: 13 }}>{r.location_code}</b> },
        { title: '物料', render: mat },
        { title: '批号', render: (r) => <span className="mono">{r.lot_no || '-'}</span> },
        { title: '有效期', render: (r) => fmtDate(r.expiry_date) },
        { title: ret ? '退料数' : '应拣数', align: 'right', render: (r) => <b>{fmtQty(r.qty)} {r.uom ?? ''}</b> },
        { title: ret ? '实收' : '实拣', width: 70, align: 'right', render: (r) => (r.picked_qty !== null && r.picked_qty !== undefined ? fmtQty(r.picked_qty) : '') },
        { title: '核对', width: 40, render: () => '□' },
      ]} />
      <Typography.Paragraph style={{ fontSize: 11, marginTop: 6 }}>按库位顺序拣料；批号已按先到期先出（FEFO）推荐。实物不足请在“实拣”栏写实数并告知仓管在系统中录入。</Typography.Paragraph>
      <PrintSignatures roles={ret ? ['退料人', '仓管', '车间主管'] : ['拣料', '发料', '领料（车间）']} />
    </>
  );
}

function ShipmentDoc({ d }: { d: Rec }) {
  const lines: Rec[] = d.lines || [];
  const total = lines.reduce((s, l) => s + (l.qty || 0), 0);
  const head: [string, ReactNode][] = [['发货单号', d.no], ['客户', d.customer_name], ['销售订单', d.so_no], ['客户 PO', d.customer_po], ['发货日期', fmtDate(d.ship_date)], ['承运商 / 运单号', `${d.carrier ?? '-'} / ${d.tracking_no ?? '-'}`], ['收货地址', d.ship_to], ['状态', dictLabel('doc_status', d.status)], ['合计', fmtQty(total)]];
  return (
    <>
      <PrintHeader title="发货单" no={d.no} />
      <CompanyHead />
      <Title text="发货单" no={d.no} />
      <Info items={head} />
      <DocTable rows={lines} columns={[
        { title: '#', width: 26, render: (_, i) => i + 1 },
        { title: '产品', render: mat },
        { title: '批号', render: (r) => <span className="mono">{r.lot_no || '-'}</span> },
        { title: '出货库位', render: (r) => r.location_code },
        { title: '数量', align: 'right', render: (r) => `${fmtQty(r.qty)} ${r.uom ?? ''}` },
        { title: '序列号数', align: 'right', render: (r) => (r.serial_list?.length ? `${r.serial_list.length} 台` : '-') },
      ]} />
      <PrintSignatures roles={['仓库发货', '承运商签收', '客户签收']} />
      <div className="page-break" />
      <PrintHeader title="装箱单 Packing List" no={d.no} />
      <CompanyHead en />
      <Title text="装箱单 Packing List" no={d.no} />
      <Info items={head} />
      {lines.map((l) => (
        <div key={l.id} className="avoid-break" style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, margin: '4px 0' }}>{l.material_code} {l.material_name} · 批号 {l.lot_no || '-'} · {fmtQty(l.qty)} {l.uom ?? ''}</div>
          {l.serial_list?.length ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <tbody>
                {Array.from({ length: Math.ceil(l.serial_list.length / 4) }).map((_, r) => (
                  <tr key={r}>{l.serial_list.slice(r * 4, r * 4 + 4).map((sn: string, k: number) => <td key={sn} style={{ border: '1px solid #999', padding: '3px 6px', width: '25%' }} className="mono">{r * 4 + k + 1}. {sn}</td>)}</tr>
                ))}
              </tbody>
            </table>
          ) : <div style={{ fontSize: 11 }}>非序列号产品</div>}
        </div>
      ))}
      <PrintSignatures roles={['装箱', '复核']} />
    </>
  );
}

function CountDoc({ d }: { d: Rec }) {
  const lines = [...(d.lines || [])].sort(byRoute);
  const blind = !!d.blind && d.status === 'OPEN';
  return (
    <>
      <PrintHeader title="盘点表" no={d.no} />
      <Title text={`盘点表${blind ? '（盲盘）' : ''}`} no={d.no} />
      <Info items={[['单号', d.no], ['仓库', d.warehouse_name], ['范围', d.range_codes?.length ? d.range_codes.join('、') : '整仓'], ['状态', dictLabel('doc_status', d.status)], ['创建', `${d.created_by ?? ''} ${fmtDateTime(d.created_at)}`], ['行数', lines.length]]} />
      <DocTable rows={lines} columns={[
        { title: '#', width: 26, render: (_, i) => i + 1 },
        { title: '库位', width: 70, render: (r) => <b className="mono">{r.location_code}</b> },
        { title: '物料', render: mat },
        { title: '批号', render: (r) => <span className="mono">{r.lot_no || '-'}</span> },
        { title: '状态', render: (r) => dictLabel('stock_status', r.status) },
        { title: '账面', align: 'right', render: (r) => (blind ? '' : fmtQty(r.current_qty ?? r.system_qty)) },
        { title: '实盘', width: 70, align: 'right', render: (r) => (r.counted_qty !== null && r.counted_qty !== undefined ? fmtQty(r.counted_qty) : '') },
        { title: '差异', width: 60, align: 'right', render: (r) => (blind || r.diff_qty === null || r.diff_qty === undefined ? '' : fmtQty(r.diff_qty)) },
      ]} />
      <Typography.Paragraph style={{ fontSize: 11, marginTop: 6 }}>按库位顺序逐行清点；账上没有的批次写在空白处（盘盈），系统中用“新增盘盈行”录入。</Typography.Paragraph>
      <PrintSignatures roles={['盘点人', '复核人', '仓库主管']} />
    </>
  );
}

/** 批次行 → 按已发卡的包装标签展开（每包一张，数量 = 包装数量，带 EPC）；没有标签的保留一张（EPC 未发卡） */
async function withTags(rows: Rec[], receiptId?: number | null): Promise<Rec[]> {
  const lots = [...new Set(rows.map((r) => r.lot_no).filter(Boolean))];
  if (!lots.length) return rows.map((r) => ({ ...r, epc: null }));
  const tags: Rec[] = (await get('/rfid/tags', { lot_no: lots.join(','), status: 'ACTIVE', tag_type: 'PACKAGE', page_size: 1000 }, true).catch(() => ({ items: [] }))).items;
  const out: Rec[] = [];
  for (const r of rows) {
    const mine = tags.filter((t) => t.material_id === r.material_id && t.lot_no === r.lot_no && (receiptId ? t.receipt_id === receiptId : t.location_id === r.location_id));
    if (!mine.length) out.push({ ...r, epc: null });
    else for (const t of mine) out.push({ ...r, qty: t.qty, epc: t.epc, location_code: t.location_code ?? r.location_code });
  }
  return out;
}

function Labels() {
  const [sp] = useSearchParams();
  const [rows, setRows] = useState<Rec[] | null>(null);
  const [kind, setKind] = useState<'lot' | 'location'>('lot');
  const [size, setSize] = useState<LabelSize>('roll');
  useEffect(() => {
    (async () => {
      if (sp.get('receipt')) {
        const rc = await get(`/receipts/${sp.get('receipt')}`);
        setRows(await withTags((rc.lines as Rec[]).map((l) => ({ ...l, receipt_no: rc.no, received_date: rc.receipt_date })), rc.id));
      } else if (sp.get('stock') || sp.get('lot')) {
        const d = await get('/stock', { ids: sp.get('stock') || undefined, lot_no: sp.get('lot') || undefined, page_size: 500 });
        setRows(await withTags(d.items));
      } else if (sp.get('tags')) {
        const d = await get('/rfid/tags', { ids: sp.get('tags'), page_size: 500 });
        setRows((d.items as Rec[]).map((t) => ({ ...t, epc: t.epc })));
      } else if (sp.get('location') || sp.get('warehouse_id')) {
        setKind('location');
        const ids = (sp.get('location') || '').split(',').map(Number).filter(Boolean);
        const d = await get('/locations', { page_size: 500, is_active: true, warehouse_id: sp.get('warehouse_id') || undefined });
        setRows((d.items as Rec[]).filter((l) => !ids.length || ids.includes(l.id)));
      } else setRows([]);
    })();
  }, [sp]);
  if (!rows) return <Spin />;
  return (
    <>
      <Card className="no-print" style={{ marginBottom: 12 }}>
        <Space wrap>
          <b>{kind === 'lot' ? '批次 / RFID 标签' : '库位标签'}（{rows.length} 张）</b>
          <Radio.Group value={size} onChange={(e) => setSize(e.target.value)} optionType="button" options={[{ value: 'roll', label: '标签打印机 60×40mm' }, { value: 'a4', label: 'A4 不干胶（3 列）' }]} />
          <Button type="primary" icon={<PrinterOutlined />} onClick={() => printLabels(size, kind === 'lot' ? '批次标签' : '库位标签')}>打印</Button>
        </Space>
        <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>条码为 Code 128，内容 = {kind === 'lot' ? '批号（单台为序列号）' : '库位编码'}，标签读不到时扫码枪兜底。EPC 供 RFID 打印机写入芯片时核对：贴好后放上收货台读写器读一下，读出的 EPC 与标签上一致即写入正确。</Typography.Paragraph>
      </Card>
      {!rows.length ? <Empty /> : (
        <div className="wms-labels" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {rows.map((r, i) => (kind === 'lot' ? <LotLabel key={r.id ?? i} r={r} /> : <LocationLabel key={r.id ?? i} r={r} />))}
        </div>
      )}
    </>
  );
}

const KIND: Record<string, { url: string; title: string; landscape?: boolean }> = {
  receipt: { url: '/receipts', title: '入库单' },
  issue: { url: '/issues', title: '拣料单' },
  shipment: { url: '/shipments', title: '发货单 / 装箱单' },
  count: { url: '/stock-counts', title: '盘点表' },
};

export default function PrintDoc() {
  const { kind = '', id } = useParams();
  const [d, setD] = useState<Rec | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (kind === 'labels' || !KIND[kind]) return;
    get(`${KIND[kind].url}/${id}`).then(async (r) => {
      if (kind === 'shipment' && r.so_id) {
        const so = await get(`/sales-orders/${r.so_id}`, undefined, true).catch(() => null);
        r.customer_po = so?.customer_po ?? null;
      }
      setD(r);
    }).catch(() => setErr('单据不存在或无权查看'));
  }, [kind, id]);
  if (kind === 'labels') return <Labels />;
  if (!KIND[kind]) return <Alert type="error" message="未知的打印类型" />;
  if (err) return <Alert type="error" message={err} />;
  if (!d) return <Spin />;
  return (
    <div style={{ background: '#fff', padding: 16, maxWidth: 1000, margin: '0 auto' }}>
      <Space className="no-print" style={{ marginBottom: 12 }} wrap>
        <PrintButton title={`${KIND[kind].title} ${d.no}`} />
        <Typography.Text type="secondary">屏幕显示即打印效果；页脚自动打印页码。</Typography.Text>
      </Space>
      {kind === 'receipt' && <ReceiptDoc d={d} />}
      {kind === 'issue' && <IssueDoc d={d} />}
      {kind === 'shipment' && <ShipmentDoc d={d} />}
      {kind === 'count' && <CountDoc d={d} />}
    </div>
  );
}
