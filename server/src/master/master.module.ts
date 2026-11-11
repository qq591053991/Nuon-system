import { Module } from '@nestjs/common';
import { crudController } from '../common/crud';
import { addDays } from '../common/dates';
import { BizError } from '../common/errors';
import { isValidGtin } from '../core/udi';
import { BomController } from './bom.controller';
import { CalibrationController } from './calibration.controller';
import { EngineeringService } from './engineering.service';
import { RoutingController } from './routing.controller';

/** 主数据：通用 CRUD（与原 Python 版字段、筛选、校验规则一致） */
const crud = [
  crudController({ model: 'Customer', prefix: 'customers', perm: 'master', label: '客户', search: ['code', 'name', 'short_name'], filters: ['is_active'] }),
  crudController({ model: 'Supplier', prefix: 'suppliers', perm: 'master', label: '供应商', search: ['code', 'name', 'short_name', 'category'], filters: ['status', 'is_active'] }),
  crudController({
    model: 'Material', prefix: 'materials', perm: 'master', label: '物料', search: ['code', 'name', 'spec'],
    filters: ['category', 'is_active', 'owner_customer_id', 'customer_id', 'serial_control'], orderBy: { code: 'asc' },
    validate: (_tx, m) => {
      if (m.gtin && !isValidGtin(m.gtin)) throw new BizError('UDI-DI（GTIN）校验位错误，请检查');
      if (m.category === 'FINISHED' && m.owner_customer_id) throw new BizError('成品不能设置为客供料');
      if (m.serial_control && !['FINISHED', 'SEMI'].includes(m.category ?? 'RAW')) throw new BizError('只有成品/半成品可以启用序列号管理');
    },
  }),
  crudController({ model: 'WorkCenter', prefix: 'work-centers', perm: 'master', label: '工作中心' }),
  crudController({
    model: 'Equipment', prefix: 'equipment', perm: 'master', label: '设备', search: ['code', 'name', 'model'],
    filters: ['status', 'work_center_id', 'equipment_type'], orderBy: { code: 'asc' },
    validate: (_tx, e, data) => {
      if (e.calibration_required && e.last_calibration_date && e.calibration_cycle_days && !e.next_calibration_date) {
        data.next_calibration_date = addDays(e.last_calibration_date, e.calibration_cycle_days);
      }
    },
  }),
  crudController({ model: 'Warehouse', prefix: 'warehouses', perm: 'master', label: '仓库', filters: ['warehouse_type', 'is_active'], orderBy: { code: 'asc' } }),
  crudController({ model: 'Location', prefix: 'locations', perm: 'master', label: '库位', filters: ['warehouse_id', 'location_type', 'is_active'], orderBy: { code: 'asc' } }),
];

// 设备校准、BOM、工艺路线控制器在本目录其他文件中实现，并加入下方 controllers
export const MASTER_EXTRA_CONTROLLERS: any[] = [CalibrationController, BomController, RoutingController];

@Module({ controllers: [...crud, ...MASTER_EXTRA_CONTROLLERS], providers: [EngineeringService], exports: [EngineeringService] })
export class MasterModule {}
