/** 质量服务（接口契约：收货时由 WmsService 调用 createIqc） */
import { Injectable } from '@nestjs/common';
import type { Inspection, Material, Receipt, ReceiptLine } from '@prisma/client';
import type { Tx } from '../common/prisma.service';

@Injectable()
export class QualityService {
  /** 为待检收货行创建 IQC 检验单（AQL 抽样方案 + 默认检验项目），并回写 receipt_line.inspection_id */
  async createIqc(_tx: Tx, _a: { receipt: Receipt; line: ReceiptLine; material: Material; username: string }): Promise<Inspection> {
    throw new Error('QualityService.createIqc 未实现');
  }
}
