import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

/** ECharts 轻量封装：option 变化自动刷新，容器尺寸变化自动 resize */
export default function Chart({ option, height = 260 }: { option: echarts.EChartsOption; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts>();
  useEffect(() => {
    if (!el.current) return;
    inst.current = echarts.init(el.current);
    const ro = new ResizeObserver(() => inst.current?.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      inst.current?.dispose();
    };
  }, []);
  useEffect(() => {
    inst.current?.setOption(option, true);
  }, [option]);
  return <div ref={el} style={{ width: '100%', height }} />;
}
