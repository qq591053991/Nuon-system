/** 仓储业务服务（接口契约：采购收货、数据导入、演示数据都会调用 receive） */
import { Injectable } from '@nestjs/common';
import type { PurchaseOrder, Receipt, ReceiptLine } from '@prisma/client';
import type { CurrentUser } from '../common/context';
import type { Tx } from '../common/prisma.service';

export interface ReceiveLineInput {
  material_id: number;
  qty: number;
  location_id: number;
  po_line_id?: number | null;
  lot_no?: string | null;
  supplier_lot?: string | null;
  mfg_date?: Date | null;
  expiry_date?: Date | null;
}

export interface ReceiveArgs {
  receipt_type: 'PURCHASE' | 'CUSTOMER_SUPPLIED' | 'OPENING' | 'OTHER';
  lines: ReceiveLineInput[];
  supplier_id?: number | null;
  customer_id?: number | null;
  po?: (PurchaseOrder & { lines: { id: number; qty: number; received_qty: number; material_id: number; unit_price: number }[] }) | null;
  delivery_note?: string | null;
  remark?: string | null;
}

@Injectable()
export class WmsService {
  /** 收货：需检验物料 → 待检(QUARANTINE) 并自动生成 IQC 检验单；免检/期初 → 合格。采购收货自动更新订单状态并生成应付。 */
  async receive(_tx: Tx, _user: CurrentUser, _args: ReceiveArgs): Promise<Receipt & { lines: ReceiptLine[] }> {
    throw new Error('WmsService.receive 未实现');
  }
}
