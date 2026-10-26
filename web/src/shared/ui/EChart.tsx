import { useEffect, useRef, type JSX } from 'react';
import * as echarts from 'echarts/core';
import { CandlestickChart, LineChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

// Подключаются только используемые части: библиотека целиком весит мегабайт.
echarts.use([
  LineChart,
  CandlestickChart,
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
  MarkLineComponent,
  CanvasRenderer,
]);

export type ChartOption = EChartsCoreOption;

/**
 * График ECharts (`CLAUDE.md § 5`). Размер следует за контейнером,
 * экземпляр освобождается вместе с компонентом.
 */
export function EChart({
  option,
  height,
  label,
}: {
  option: ChartOption;
  height: number;
  /** Описание для чтения с экрана: холст сам ничего не сообщает. */
  label: string;
}): JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    const instance = echarts.init(element);
    chart.current = instance;
    const observer = new ResizeObserver(() => {
      instance.resize();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={container} role="img" aria-label={label} style={{ width: '100%', height }} />;
}
