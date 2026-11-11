import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Perms, User } from '../auth';
import type { CurrentUser } from '../common/context';
import { addDays, dateOnly } from '../common/dates';
import { NotFound } from '../common/errors';
import { ser, serList } from '../common/presenter';
import { PrismaService } from '../common/prisma.service';
import { CalibrationDto } from './engineering.dto';

/** 设备校准记录：登记校准结果后自动更新设备的校准有效期 / 状态（不合格 → 停用） */
@Controller('equipment')
export class CalibrationController {
  constructor(private readonly db: PrismaService) {}

  @Get(':id/calibrations')
  async list(@Param('id', ParseIntPipe) id: number) {
    const rows = await this.db.client.calibrationRecord.findMany({ where: { equipment_id: id }, orderBy: [{ calibration_date: 'desc' }, { id: 'desc' }] });
    return serList('CalibrationRecord', rows);
  }

  @Post(':id/calibrations')
  @Perms('master', 'qa')
  add(@Param('id', ParseIntPipe) id: number, @Body() body: CalibrationDto, @User() user: CurrentUser) {
    return this.db.tx(async (tx) => {
      const eq = await tx.equipment.findUnique({ where: { id } });
      if (!eq) throw new NotFound('设备');
      const calDate = dateOnly(body.calibration_date)!;
      let next = dateOnly(body.next_due_date);
      if (!next && eq.calibration_cycle_days) next = addDays(calDate, eq.calibration_cycle_days);
      const result = body.result ?? 'PASS';
      const rec = await tx.calibrationRecord.create({
        data: {
          equipment_id: id, calibration_date: calDate, result, certificate_no: body.certificate_no ?? null, agency: body.agency ?? null,
          remark: body.remark ?? null, next_due_date: next, created_by: user.username,
        },
      });
      const data: Record<string, any> = { last_calibration_date: calDate };
      if (result === 'PASS') {
        data.next_calibration_date = next;
        if (eq.status === 'DISABLED') data.status = 'NORMAL';
      } else {
        data.status = 'DISABLED';
      }
      await tx.equipment.update({ where: { id }, data });
      return ser('CalibrationRecord', rec);
    });
  }
}
