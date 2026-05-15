/**
 * ECharts wrapper component with lazy loading for SSR compatibility.
 */
"use client";

import { useRef, useEffect, useMemo } from "react";
import type { EChartsOption } from "echarts";

// Dynamic import to avoid SSR issues with ECharts
let echartsModule: typeof import("echarts") | null = null;

interface ChartProps {
  option: EChartsOption;
  height?: string;
  className?: string;
}

export function Chart({ option, height = "300px", className }: ChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<ReturnType<typeof import("echarts")["init"]> | null>(null);

  useEffect(() => {
    let mounted = true;

    async function initChart() {
      if (!chartRef.current) return;

      if (!echartsModule) {
        echartsModule = await import("echarts");
      }

      if (!mounted || !chartRef.current) return;

      if (!instanceRef.current) {
        instanceRef.current = echartsModule.init(chartRef.current);
      }

      instanceRef.current.setOption(option, true);
    }

    initChart();

    const handleResize = () => instanceRef.current?.resize();
    window.addEventListener("resize", handleResize);

    return () => {
      mounted = false;
      window.removeEventListener("resize", handleResize);
      instanceRef.current?.dispose();
      instanceRef.current = null;
    };
  }, [option]);

  return <div ref={chartRef} style={{ height }} className={className} />;
}
