import { Alert, Space, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { get, type Rec } from '../../api/http';
import CrudPage from '../../components/CrudPage';
import { fmtDate } from '../../utils/format';

const CURRENCIES = ['USD', 'EUR', 'HKD', 'JPY', 'GBP', 'KRW', 'AUD', 'CAD', 'SGD'].map((v) => ({ value: v, label: v }));

/** 汇率维护：1 外币 = 汇率 × 本位币；报表按“生效日期 ≤ 报表日”的最近一条汇率折算 */
export default function ExchangeRates() {
  const [info, setInfo] = useState<Rec | null>(null);
  useEffect(() => {
    get('/finance/currencies', undefined, true).then(setInfo).catch(() => undefined);
  }, []);
  const base: string = info?.base_currency || 'CNY';
  const rates: Rec[] = info?.rates || [];

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={`本位币：${base}。驾驶舱、账龄分析等报表按“生效日期 ≤ 报表日期”的最近一条汇率把外币金额折算为本位币；缺少汇率的币别不计入本位币合计，并会在驾驶舱提示。`}
        description={
          rates.length ? (
            <Space wrap size={[8, 4]}>
              <Typography.Text type="secondary">今日适用汇率：</Typography.Text>
              {rates.map((r) => (
                <Tag key={r.currency} color="blue">1 {r.currency} = {Number(r.rate).toFixed(4)} {base}（{fmtDate(r.effective_date)} 起）</Tag>
              ))}
            </Space>
          ) : undefined
        }
      />
      <CrudPage
        title="汇率"
        sub="同一币别可按生效日期维护多条汇率（如每月初中间价），历史汇率保留不覆盖。"
        url="/exchange-rates"
        perm={['finance', 'master']}
        modalWidth={640}
        fields={[
          { name: 'currency', label: '币别', type: 'select', options: CURRENCIES, required: true, width: 90, render: (v) => <Tag>{v}</Tag> },
          {
            name: 'rate', label: `汇率（1 外币 = ? ${base}）`, type: 'number', precision: 6, min: 0, required: true, width: 220,
            render: (v, r) => <span className="mono">1 {r.currency} = {Number(v).toFixed(6)} {base}</span>,
          },
          { name: 'effective_date', label: '生效日期', type: 'date', required: true, width: 120 },
          { name: 'remark', label: '备注', width: 240 },
          { name: 'created_by', label: '维护人', form: false, width: 100 },
        ]}
        filters={[{ name: 'currency', label: '币别', options: CURRENCIES }]}
      />
    </>
  );
}
