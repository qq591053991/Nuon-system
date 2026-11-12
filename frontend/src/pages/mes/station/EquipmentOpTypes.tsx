/**
 * 设备“适用工序类型”（C-F08）：设备台账中维护，工位终端和报工接口据此校验（不适用的设备置灰 / 拦截）。
 * 未设置时按设备类型推断：检测仪器 → 光学 / 安规测试与检验；老化设备 → 老化；并要求与工序的工作中心一致。
 */
import { Alert, Button, Checkbox, Modal, Tag, Typography, message } from 'antd';
import { ApartmentOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { put, type Rec } from '../../../api/http';
import { dictLabel, dictOptions } from '../../../utils/dict';

export const opTypesOf = (v?: string | null) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

/** 列表显示：适用工序标签；未设置时说明按类型推断 */
export function OpTypesCell({ value, row }: { value?: string | null; row: Rec }) {
  const list = opTypesOf(value);
  if (!list.length) {
    const hint = row.equipment_type === 'TEST' ? '测试/检验' : row.equipment_type === 'AGING' ? '老化' : '同工作中心';
    return <Typography.Text type="secondary" style={{ fontSize: 12 }}>未设置（按类型：{hint}）</Typography.Text>;
  }
  return <>{list.map((t) => <Tag key={t} color="purple" style={{ marginBottom: 2 }}>{dictLabel('op_type', t)}</Tag>)}</>;
}

/** 行操作：设置适用工序 */
export function OpTypesButton({ row, onSaved }: { row: Rec; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  return (
    <>
      <Button size="small" icon={<ApartmentOutlined />} onClick={() => {
        setVal(opTypesOf(row.op_types));
        setOpen(true);
      }}>适用工序</Button>
      <Modal
        open={open}
        title={`适用工序：${row.code} ${row.name}`}
        okText="保存"
        confirmLoading={saving}
        onCancel={() => setOpen(false)}
        destroyOnHidden
        onOk={async () => {
          setSaving(true);
          try {
            await put(`/equipment/${row.id}`, { op_types: val.length ? val.join(',') : null });
            message.success('已保存，工位终端与报工将按此校验');
            setOpen(false);
            onSaved();
          } finally {
            setSaving(false);
          }
        }}
      >
        <Alert type="info" showIcon style={{ marginBottom: 12 }}
          message="勾选该设备可用于的工序类型。工位终端只允许选择适用本工序的设备，报工时系统同样校验（防止老化记录挂上光谱仪）。不勾选 = 按设备类型推断。" />
        <Checkbox.Group value={val} onChange={(v) => setVal(v as string[])} options={dictOptions('op_type').map((o) => ({ value: o.value, label: o.label }))} />
      </Modal>
    </>
  );
}
