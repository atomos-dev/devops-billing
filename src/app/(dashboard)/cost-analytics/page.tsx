/**
 * Cost Analytics page — decision-driven layout with three zones:
 * 1. Health dashboard (metric cards — glanceable)
 * 2. Needs attention (idle resources — actionable)
 * 3. Trends & details (charts — drill-down when needed)
 *
 * Simplified from the previous data-dimension-driven 2×2 grid by removing
 * per-chart dimension toggles and focusing on "where is money being wasted?"
 */
"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Chart } from "@/components/charts/chart";
import type { EChartsOption } from "echarts";

// ── Types ──────────────────────────────────────────────────────────────────

interface TrendProvider {
  provider: string;
  amount: number;
  isManual: boolean;
}

interface TrendMonth {
  month: string;
  providers: TrendProvider[];
  total: number;
}

interface TopResource {
  resourceId: string | null;
  resourceName: string | null;
  service: string;
  usageCategory: string | null;
  totalAmount: number;
}

interface IdleResource {
  id: number;
  provider: string;
  resourceId: string;
  resourceName: string | null;
  resourceType: string | null;
  region: string | null;
  spec: string | null;
  status: string;
  monthlyCost: number;
  idleDays: number;
  updatedAt: string;
}

interface IdleResourcesResponse {
  resources: IdleResource[];
  count: number;
  totalMonthlyCost: number;
}

interface BreakdownItem {
  key: string | null;
  totalAmount: number;
}

// ── Display helpers ────────────────────────────────────────────────────────

const PROVIDER_COLORS: Record<string, string> = {
  aws: "#FF9900",
  digitalocean: "#0080FF",
  "alibaba-cloud": "#FF6A00",
};

/** Usage category → display label + chart color */
const CATEGORY_CONFIG: Record<string, { label: string; color: string }> = {
  dpn: { label: "DPN 节点", color: "#6366f1" },
  mainnet: { label: "主网服务", color: "#10b981" },
  devops: { label: "DevOps", color: "#f59e0b" },
  dbg: { label: "调试/测试", color: "#ef4444" },
  gc: { label: "全局控制", color: "#8b5cf6" },
  customer: { label: "客户机器", color: "#06b6d4" },
  other: { label: "其他/未分类", color: "#94a3b8" },
};

/** Status → display label + color for the idle resources list.
 *  "terminated" is excluded: terminated instances are fully deallocated
 *  and no longer billed by AWS/DO. */
const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  stopped: { label: "已停止", color: "text-amber-600 bg-amber-50" },
  unassociated: { label: "未关联", color: "text-slate-600 bg-slate-100" },
  unattached: { label: "未挂载", color: "text-slate-600 bg-slate-100" },
};

function getProviderLabel(provider: string): string {
  if (provider === "aws") return "AWS";
  if (provider === "digitalocean") return "DigitalOcean";
  if (provider === "alibaba-cloud") return "Alibaba Cloud";
  return provider;
}

/** Resource type → display-friendly icon/label */
function getResourceTypeLabel(type: string | null): string {
  const labels: Record<string, string> = {
    ec2: "EC2",
    droplet: "Droplet",
    rds: "RDS",
    eip: "EIP",
    ebs: "EBS",
    load_balancer: "LB",
    s3: "S3",
  };
  return labels[type ?? ""] ?? type ?? "—";
}

function EmptyState({ message }: { message: string }) {
  return (
    <p className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
      {message}
    </p>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

export default function CostAnalyticsPage() {
  // Global filters
  const [periods, setPeriods] = useState<string[]>([]);
  const [selectedPeriod, setSelectedPeriod] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("all");
  const [loading, setLoading] = useState(true);

  // Data
  const [trendData, setTrendData] = useState<TrendMonth[]>([]);
  const [topResources, setTopResources] = useState<TopResource[]>([]);
  const [categoryBreakdown, setCategoryBreakdown] = useState<BreakdownItem[]>([]);
  const [idleData, setIdleData] = useState<IdleResourcesResponse | null>(null);
  const [summaryData, setSummaryData] = useState<{
    currentTotal: number;
    prevTotal: number;
    changeAmount: number;
    changePercent: number;
    providerCosts: Array<{ provider: string; amount: number }>;
  } | null>(null);

  // ── Fetch periods on mount ───────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/v1/analytics/periods");
        if (res.ok) {
          const data = await res.json();
          const list: string[] = data.periods ?? [];
          setPeriods(list);
          if (list.length > 0) setSelectedPeriod(list[0]);
        }
      } catch (error) {
        console.error("Failed to fetch periods:", error);
      }
    })();
  }, []);

  // ── Fetch all data ──────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    if (!selectedPeriod) return;
    setLoading(true);
    const pQs = selectedProvider === "all" ? "" : `&provider=${selectedProvider}`;
    const pQsOnly = selectedProvider === "all" ? "" : `?provider=${selectedProvider}`;

    try {
      const [trendRes, topRes, catRes, idleRes] = await Promise.all([
        // Fetch enough months to cover selectedPeriod + one prior month for MoM
        fetch(`/api/v1/analytics/trend?months=12&groupBy=provider${pQs}`),
        // Top 10 resources by cost
        fetch(`/api/v1/analytics/top-resources?period=${selectedPeriod}&limit=10${pQs}`),
        // Cost breakdown by usage category
        fetch(`/api/v1/analytics/breakdown?period=${selectedPeriod}&dimension=category${pQs}`),
        // Idle resources
        fetch(`/api/v1/analytics/idle-resources${pQsOnly}`),
      ]);

      // Trend chart data + summary cards derived from same response
      if (trendRes.ok) {
        const json = await trendRes.json();
        const allMonths: TrendMonth[] = json.trend ?? [];
        setTrendData(allMonths);

        // Derive summary from the selected period within the trend data
        const currentIdx = allMonths.findIndex((m) => m.month === selectedPeriod);
        if (currentIdx >= 0) {
          const current = allMonths[currentIdx];
          const prev = currentIdx > 0 ? allMonths[currentIdx - 1] : null;
          const currentTotal = current.total;
          const prevTotal = prev?.total ?? 0;
          const changeAmount = currentTotal - prevTotal;
          const changePercent = prevTotal > 0
            ? Math.round((changeAmount / prevTotal) * 10000) / 100
            : 0;

          setSummaryData({
            currentTotal,
            prevTotal,
            changeAmount,
            changePercent,
            providerCosts: current.providers.map((p) => ({
              provider: p.provider,
              amount: p.amount,
            })),
          });
        }
      }

      // Top resources
      if (topRes.ok) setTopResources((await topRes.json()).resources ?? []);

      // Category breakdown
      if (catRes.ok) setCategoryBreakdown((await catRes.json()).breakdown ?? []);

      // Idle resources
      if (idleRes.ok) setIdleData(await idleRes.json());
    } catch (error) {
      console.error("Failed to fetch chart data:", error);
    } finally {
      setLoading(false);
    }
  }, [selectedPeriod, selectedProvider]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Chart: Trend (fixed to provider dimension) ──────────────────────────

  const trendOption: EChartsOption = useMemo(() => {
    if (trendData.length === 0) return {};
    const providerSet = new Set<string>();
    trendData.forEach((m) => m.providers.forEach((p) => providerSet.add(p.provider)));
    const names = [...providerSet];

    return {
      tooltip: { trigger: "axis", valueFormatter: (v: unknown) => `$${(v as number).toFixed(2)}` },
      legend: { data: names.map(getProviderLabel) },
      grid: { left: 50, right: 20, bottom: 30, top: 40 },
      xAxis: { type: "category", data: trendData.map((m) => m.month) },
      yAxis: { type: "value", axisLabel: { formatter: "${value}" } },
      series: names.map((p) => ({
        name: getProviderLabel(p),
        type: "line" as const,
        areaStyle: { opacity: 0.3 },
        stack: "total",
        emphasis: { focus: "series" as const },
        itemStyle: { color: PROVIDER_COLORS[p] },
        data: trendData.map(
          (m) => Math.round((m.providers.find((x) => x.provider === p)?.amount ?? 0) * 100) / 100
        ),
      })),
    };
  }, [trendData]);

  // ── Chart: Top resources ────────────────────────────────────────────────

  const topResourcesOption: EChartsOption = useMemo(() => {
    if (topResources.length === 0) return {};
    const sorted = [...topResources].reverse();
    return {
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params: unknown) => {
          const list = params as Array<{ name: string; value: number; dataIndex: number }>;
          const item = list[0];
          if (!item) return "";
          const r = sorted[item.dataIndex];
          const cat = r?.usageCategory ?? "other";
          const catLabel = CATEGORY_CONFIG[cat]?.label ?? CATEGORY_CONFIG.other.label;
          return `${item.name}<br/>费用: $${item.value.toFixed(2)}<br/>分类: ${catLabel}`;
        },
      },
      grid: { left: 160, right: 30, bottom: 20, top: 10 },
      xAxis: { type: "value", axisLabel: { formatter: "${value}" } },
      yAxis: {
        type: "category",
        data: sorted.map((r) =>
          r.resourceName || (r.resourceId ? r.resourceId : `${r.service} (未归属)`)
        ),
        axisLabel: { width: 140, overflow: "truncate" },
      },
      series: [{
        type: "bar",
        data: sorted.map((r) => {
          const cat = r.usageCategory ?? "other";
          const color = CATEGORY_CONFIG[cat]?.color ?? CATEGORY_CONFIG.other.color;
          return {
            value: Math.round(r.totalAmount * 100) / 100,
            itemStyle: { color, borderRadius: [0, 4, 4, 0] },
          };
        }),
      }],
    };
  }, [topResources]);

  // ── Chart: Category breakdown (pie) ──────────────────────────────────────

  const categoryOption: EChartsOption = useMemo(() => {
    if (categoryBreakdown.length === 0) return {};
    // Sort by amount descending for better readability
    const sorted = [...categoryBreakdown].sort((a, b) => b.totalAmount - a.totalAmount);
    return {
      tooltip: {
        trigger: "item",
        formatter: (params: unknown) => {
          const p = params as { name: string; value: number; percent: number };
          return `${p.name}: $${p.value.toFixed(2)} (${p.percent.toFixed(1)}%)`;
        },
      },
      legend: { orient: "vertical" as const, right: 10, top: "center" },
      series: [{
        type: "pie",
        radius: ["40%", "70%"],
        center: ["35%", "50%"],
        label: { show: false },
        emphasis: { itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: "rgba(0,0,0,0.3)" } },
        data: sorted.map((d) => {
          const key = d.key ?? "other";
          const cfg = CATEGORY_CONFIG[key] ?? CATEGORY_CONFIG.other;
          return {
            name: cfg.label,
            value: Math.round(d.totalAmount * 100) / 100,
            itemStyle: { color: cfg.color },
          };
        }),
      }],
    };
  }, [categoryBreakdown]);

  // ── Derived: MoM alert threshold ────────────────────────────────────────
  const isCostSpiking = (summaryData?.changePercent ?? 0) > 20;

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header + Global Filters */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">成本分析</h1>
          <p className="text-sm text-muted-foreground mt-1">
            快速定位费用异常和闲置资源
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={selectedPeriod} onValueChange={(v) => v && setSelectedPeriod(v)}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="选择月份" />
            </SelectTrigger>
            <SelectContent>
              {periods.map((p) => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={selectedProvider} onValueChange={(v) => setSelectedProvider(v ?? "all")}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有供应商</SelectItem>
              <SelectItem value="aws">AWS</SelectItem>
              <SelectItem value="digitalocean">DigitalOcean</SelectItem>
              <SelectItem value="alibaba-cloud">Alibaba Cloud</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* ────────────────────────────────────────────────────────────────────
          Zone 1: Health Dashboard — metric cards (glanceable)
          ──────────────────────────────────────────────────────────────────── */}
      {summaryData && (
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          {/* Total Cost */}
          <Card className={isCostSpiking ? "border-red-200 bg-red-50/30" : ""}>
            <CardContent className="pt-5 pb-4">
              <p className="text-xs font-medium text-muted-foreground mb-1">
                {selectedPeriod} 总费用
              </p>
              <div className="text-2xl font-bold font-mono">
                ${summaryData.currentTotal.toFixed(2)}
              </div>
              {summaryData.prevTotal > 0 && (
                <div className={`flex items-center gap-1 mt-1 text-xs font-medium ${
                  summaryData.changeAmount > 0 ? "text-red-500" : summaryData.changeAmount < 0 ? "text-emerald-500" : "text-muted-foreground"
                }`}>
                  <span>{summaryData.changeAmount > 0 ? "↑" : summaryData.changeAmount < 0 ? "↓" : "→"}</span>
                  <span>${Math.abs(summaryData.changeAmount).toFixed(2)}</span>
                  <span>({summaryData.changePercent > 0 ? "+" : ""}{summaryData.changePercent}%)</span>
                  <span className="text-muted-foreground font-normal">vs 上月</span>
                  {isCostSpiking && (
                    <Badge variant="destructive" className="ml-1 text-[10px]">异常</Badge>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Per-provider costs */}
          {summaryData.providerCosts.map((pc) => (
            <Card key={pc.provider}>
              <CardContent className="pt-5 pb-4">
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  {getProviderLabel(pc.provider)}
                </p>
                <div className="text-2xl font-bold font-mono">
                  ${pc.amount.toFixed(2)}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {summaryData.currentTotal > 0
                    ? `${((pc.amount / summaryData.currentTotal) * 100).toFixed(1)}% of total`
                    : "—"}
                </div>
              </CardContent>
            </Card>
          ))}

          {/* Idle resource count */}
          <Card className={
            (idleData?.count ?? 0) > 0 ? "border-amber-200 bg-amber-50/30" : ""
          }>
            <CardContent className="pt-5 pb-4">
              <p className="text-xs font-medium text-muted-foreground mb-1">闲置资源</p>
              <div className="text-2xl font-bold font-mono">
                {idleData?.count ?? 0}
                <span className="text-sm font-normal text-muted-foreground ml-1">个</span>
              </div>
              {(idleData?.count ?? 0) > 0 && (
                <div className="text-xs text-amber-600 font-medium mt-1">
                  需要关注
                </div>
              )}
            </CardContent>
          </Card>

          {/* Estimated monthly savings */}
          <Card className={
            (idleData?.totalMonthlyCost ?? 0) > 0 ? "border-amber-200 bg-amber-50/30" : ""
          }>
            <CardContent className="pt-5 pb-4">
              <p className="text-xs font-medium text-muted-foreground mb-1">预估可节省</p>
              <div className="text-2xl font-bold font-mono text-amber-600">
                ${(idleData?.totalMonthlyCost ?? 0).toFixed(2)}
                <span className="text-sm font-normal text-muted-foreground ml-1">/月</span>
              </div>
              {(idleData?.totalMonthlyCost ?? 0) > 0 && (
                <div className="text-xs text-muted-foreground mt-1">
                  处理闲置资源后
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ────────────────────────────────────────────────────────────────────
          Zone 2: Needs Attention — idle resources (actionable list)
          ──────────────────────────────────────────────────────────────────── */}
      {idleData && idleData.resources.length > 0 && (
        <Card className="border-amber-200">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <CardTitle className="text-base">
                需要关注的资源
              </CardTitle>
              <Badge variant="secondary" className="text-xs">
                {idleData.count} 个闲置 · 每月约 ${idleData.totalMonthlyCost.toFixed(2)}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              以下资源已停止运行或未被使用，但仍在产生费用
            </p>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="py-2 px-3 text-left font-medium text-muted-foreground">资源</th>
                    <th className="py-2 px-3 text-left font-medium text-muted-foreground">供应商</th>
                    <th className="py-2 px-3 text-left font-medium text-muted-foreground">类型</th>
                    <th className="py-2 px-3 text-left font-medium text-muted-foreground">状态</th>
                    <th className="py-2 px-3 text-right font-medium text-muted-foreground">闲置天数</th>
                    <th className="py-2 px-3 text-right font-medium text-muted-foreground">月费用</th>
                  </tr>
                </thead>
                <tbody>
                  {idleData.resources.map((r) => {
                    const statusCfg = STATUS_CONFIG[r.status] ?? { label: r.status, color: "text-slate-600 bg-slate-100" };
                    return (
                      <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="py-2.5 px-3">
                          <div className="font-medium font-mono text-xs">
                            {r.resourceName || r.resourceId}
                          </div>
                          {r.resourceName && (
                            <div className="text-[11px] text-muted-foreground font-mono">
                              {r.resourceId}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-xs">
                          {getProviderLabel(r.provider)}
                        </td>
                        <td className="py-2.5 px-3 text-xs text-muted-foreground">
                          {getResourceTypeLabel(r.resourceType)}
                          {r.spec && (
                            <span className="ml-1 text-[11px]">({r.spec})</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3">
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusCfg.color}`}>
                            {statusCfg.label}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right text-xs font-mono">
                          {r.idleDays > 0 ? `${r.idleDays}天` : "<1天"}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <span className="font-mono text-xs font-medium">
                            ${r.monthlyCost.toFixed(2)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state when no idle resources — positive signal */}
      {idleData && idleData.resources.length === 0 && !loading && (
        <Card>
          <CardContent className="py-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 text-lg">
                ✓
              </div>
              <div>
                <p className="text-sm font-medium">所有资源运行正常</p>
                <p className="text-xs text-muted-foreground">未发现闲置或异常资源</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ────────────────────────────────────────────────────────────────────
          Zone 3: Trends & Details (drill-down when needed)
          ──────────────────────────────────────────────────────────────────── */}
      <div className="space-y-4">
        {/* Row 1: Trend + Category breakdown side by side */}
        <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
          {/* Monthly cost trend — fixed to provider dimension */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">月度费用趋势</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <EmptyState message="加载中..." />
              ) : trendData.length > 0 && trendData.some((m) => m.providers.length > 0) ? (
                <Chart option={trendOption} height="300px" />
              ) : (
                <EmptyState message="暂无趋势数据" />
              )}
            </CardContent>
          </Card>

          {/* Cost by usage category */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">业务分类费用</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <EmptyState message="加载中..." />
              ) : categoryBreakdown.length > 0 ? (
                <Chart option={categoryOption} height="300px" />
              ) : (
                <EmptyState message="暂无分类数据" />
              )}
            </CardContent>
          </Card>
        </div>

        {/* Row 2: Top 10 resources by cost */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Top 10 资源费用</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <EmptyState message="加载中..." />
            ) : topResources.length > 0 ? (
              <Chart option={topResourcesOption} height="300px" />
            ) : (
              <EmptyState message="暂无资源费用数据" />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
