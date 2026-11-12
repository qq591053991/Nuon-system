import { Button } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { ReactNode } from 'react';
import { useAuth } from '../auth';

/**
 * 打印按钮：设置纸张方向，并在每页页脚打印“第 x 页 / 共 y 页”（Chromium 支持 @page 页边距盒）。
 * 页面中只想在打印时出现的内容用 <PrintHeader>，不想打印的加 className="no-print"。
 */
export function PrintButton({ landscape = false, text = '打印 / 导出 PDF', title }: { landscape?: boolean; text?: string; title?: string }) {
  const doPrint = () => {
    const style = document.createElement('style');
    style.id = 'nuon-print-page';
    style.textContent = `@page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 12mm 10mm 14mm;
      @bottom-right { content: "第 " counter(page) " 页 / 共 " counter(pages) " 页"; font-size: 9pt; color: #666; }
      @bottom-left { content: "Nuon 智造云 · 电子记录打印件"; font-size: 9pt; color: #666; } }`;
    document.head.appendChild(style);
    const old = document.title;
    if (title) document.title = title;
    window.print();
    document.title = old;
    style.remove();
  };
  return <Button icon={<PrinterOutlined />} onClick={doPrint} className="no-print">{text}</Button>;
}

/** 仅打印时显示的抬头：单据名称、编号、打印人与时间 */
export function PrintHeader({ title, no, extra }: { title: string; no?: string; extra?: ReactNode }) {
  const { user } = useAuth();
  return (
    <div className="print-only print-header">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: '2px solid #000', paddingBottom: 6, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{title}</div>
          {no && <div style={{ fontSize: 12 }}>编号：{no}</div>}
        </div>
        <div style={{ fontSize: 11, textAlign: 'right' }}>
          {extra}
          <div>打印人：{user?.full_name}　打印时间：{dayjs().format('YYYY-MM-DD HH:mm')}</div>
        </div>
      </div>
    </div>
  );
}

/** 打印件末尾签字栏 */
export function PrintSignatures({ roles = ['编制', '审核', '批准'] }: { roles?: string[] }) {
  return (
    <div className="print-only">
      <div style={{ display: 'flex', gap: 24, marginTop: 24, fontSize: 12 }}>
        {roles.map((r) => (
          <div key={r} style={{ flex: 1, borderTop: '1px solid #000', paddingTop: 4 }}>{r}：　　　　　　日期：</div>
        ))}
      </div>
    </div>
  );
}
