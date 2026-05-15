/**
 * Dashboard page — billing overview with cost cards and sync status.
 */
"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Chart } from "@/components/charts/chart";
import type { EChartsOption } from "echarts";

interface ProviderCost {
  provider: string;
  amount: number;
  isManual: boolean;
}

interface MonthlySummary {
  month: string;
  providers: ProviderCost[];
  totalAuto: number;
  totalManual: number;
  total: number;
}

interface SyncStatus {
  lastSync: string;
  status: string;
  isStale: boolean;
}

export default function DashboardPage() {
  const [summary, setSummary] = useState<MonthlySummary | null>(null);
  const [syncStatus, setSyncStatus] = useState<Record<string, SyncStatus>>({});
  const [syncing, setSyncing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [sumRes, statusRes] = await Promise.all([
        fetch("/api/v1/summary"),
        fetch("/api/v1/sync"),
      ]);
      if (sumRes.ok) setSummary(await sumRes.json());
      if (statusRes.ok) {
        const data = await statusRes.json();
        setSyncStatus(data.status || {});
      }
    } catch (error) {
      console.error("Failed to fetch dashboard data:", error);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await fetch("/api/v1/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      await fetchData();
    } finally {
      setSyncing(false);
    }
  };

  const pieOption: EChartsOption = summary
    ? {
        tooltip: { trigger: "item" },
        series: [
          {
            type: "pie",
            radius: ["40%", "70%"],
            data: summary.providers.map((p) => ({
              name: p.provider,
              value: Math.round(p.amount * 100) / 100,
            })),
            label: { formatter: "{b}: ${c}" },
          },
        ],
      }
    : {};

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">
          Dashboard {summary?.month && `— ${summary.month}`}
        </h1>
        <Button onClick={handleSync} disabled={syncing} size="sm">
          {syncing ? "Syncing..." : "Sync Now"}
        </Button>
      </div>

      {/* Cost cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="card-shadow">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Cost
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">
              ${summary?.total.toFixed(2) || "—"}
            </div>
          </CardContent>
        </Card>

        {summary?.providers
          .filter((p) => !p.isManual)
          .map((p) => (
            <Card key={p.provider}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    {p.provider === "aws"
                      ? "AWS"
                      : p.provider === "digitalocean"
                        ? "DigitalOcean"
                        : p.provider}
                  </CardTitle>
                  {syncStatus[p.provider]?.isStale && (
                    <Badge variant="destructive" className="text-xs">
                      Stale
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold font-mono">${p.amount.toFixed(2)}</div>
                {syncStatus[p.provider] && (
                  <p className="text-xs text-muted-foreground">
                    Last sync:{" "}
                    {new Date(
                      syncStatus[p.provider].lastSync
                    ).toLocaleString()}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}

        {(summary?.totalManual || 0) > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Other (Manual)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">
                ${summary?.totalManual.toFixed(2)}
              </div>
              <p className="text-xs text-muted-foreground">Manually entered</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Cost Distribution Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cost Distribution</CardTitle>
        </CardHeader>
        <CardContent>
          {summary && summary.providers.length > 0 ? (
            <Chart option={pieOption} height="280px" />
          ) : (
            <p className="py-10 text-center text-muted-foreground">
              No data yet. Click &quot;Sync Now&quot; to fetch billing data.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
