/**
 * Resource Scan page — independent resource discovery with service coverage
 * overview, expandable resource details, scan triggering, and scan history.
 */
"use client";

import { useEffect, useState, useCallback, Fragment } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Radar, Loader2, CheckCircle2, XCircle, AlertTriangle,
  ChevronDown, ChevronRight, Clock, Server, Database,
  HardDrive, Globe, Network, Cloudy,
} from "lucide-react";

// ── Types ───────────────────────────────────────────────────────────────────

interface ScanProgress {
  completed: number;
  total: number;
}

interface CurrentScan {
  id: number;
  status: string;
  startedAt: string;
  progress: ScanProgress;
}

interface ScanRecord {
  id: number;
  provider: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  services_scanned: number;
  resources_found: number;
  details: string | null;
}

interface DiscovererDetail {
  serviceKey: string;
  status: string;
  resourcesFound: number;
  durationMs: number;
  error?: string;
}

interface ServiceInfo {
  service: string;
  hasDiscoverer: boolean;
  discovererKey?: string;
  reason?: string;
  lastBillAmount: number;
}

/** Resource record returned by /api/v1/resources */
interface ResourceRecord {
  id: number;
  provider: string;
  resourceId: string;
  resourceName: string | null;
  resourceType: string | null;
  region: string | null;
  spec: string | null;
  status: string | null;
  usageCategory: string | null;
  monthlyBaseCost: number | null;
  bandwidthAllowanceTib: number | null;
  publicIp: string | null;
  privateIp: string | null;
}

/** Usage category → display label + badge color */
const CATEGORY_BADGE: Record<string, { label: string; className: string }> = {
  dpn: { label: "DPN", className: "bg-indigo-100 text-indigo-700 hover:bg-indigo-100" },
  mainnet: { label: "主网", className: "bg-emerald-100 text-emerald-700 hover:bg-emerald-100" },
  devops: { label: "DevOps", className: "bg-amber-100 text-amber-700 hover:bg-amber-100" },
  dbg: { label: "调试", className: "bg-red-100 text-red-700 hover:bg-red-100" },
  gc: { label: "GC", className: "bg-purple-100 text-purple-700 hover:bg-purple-100" },
  customer: { label: "客户", className: "bg-cyan-100 text-cyan-700 hover:bg-cyan-100" },
  other: { label: "其他", className: "bg-slate-100 text-slate-500 hover:bg-slate-100" },
};

/** Bandwidth report record from DO CSV import */
interface BandwidthReport {
  resourceId: string;
  region: string | null;
  product: string | null;
  bandwidthGib: number;
  resourceName: string | null;
  resourceType: string | null;
  spec: string | null;
  status: string | null;
}

/**
 * Maps discovererKey to the resourceType values it produces.
 * Used to filter the resources table when expanding a service card.
 */
const DISCOVERER_RESOURCE_TYPES: Record<string, string[]> = {
  ec2: ["ec2"],
  rds: ["rds"],
  elb: ["elb"],
  s3: ["s3"],
  nat_gateway: ["nat_gateway"],
  eip: ["eip"],
  do_existing: ["droplet", "load_balancer"],
  managed_db: ["managed_db"],
  volume: ["volume"],
  alibaba_compute: ["ecs", "swas"],
};

/** Icon mapping for resource types to make the list more scannable */
function resourceTypeIcon(type: string | null) {
  switch (type) {
    case "ec2": case "ecs": case "droplet": case "swas":
      return <Server className="h-3.5 w-3.5" />;
    case "rds": case "managed_db":
      return <Database className="h-3.5 w-3.5" />;
    case "s3": case "volume":
      return <HardDrive className="h-3.5 w-3.5" />;
    case "elb": case "load_balancer":
      return <Network className="h-3.5 w-3.5" />;
    case "cloudfront":
      return <Cloudy className="h-3.5 w-3.5" />;
    default:
      return <Globe className="h-3.5 w-3.5" />;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getProviderLabel(provider: string | null): string {
  if (provider === "aws") return "AWS";
  if (provider === "digitalocean") return "DigitalOcean";
  if (provider === "alibaba-cloud") return "Alibaba Cloud";
  return provider ?? "All Providers";
}

function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "—";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Whether the status represents an active/healthy resource */
function isActiveStatus(status: string | null): boolean {
  return ["running", "active", "associated", "attached", "available"].includes(status ?? "");
}

function statusIcon(status: string) {
  switch (status) {
    case "success": return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
    case "failed": return <XCircle className="h-4 w-4 text-red-500" />;
    case "partial": return <AlertTriangle className="h-4 w-4 text-amber-500" />;
    case "running": return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
    case "timeout": return <Clock className="h-4 w-4 text-amber-500" />;
    default: return null;
  }
}

// ── Component ───────────────────────────────────────────────────────────────

export default function ResourceScanPage() {
  const [currentScan, setCurrentScan] = useState<CurrentScan | null>(null);
  const [recentScans, setRecentScans] = useState<ScanRecord[]>([]);
  const [services, setServices] = useState<Record<string, ServiceInfo[]>>({});
  const [billingPeriod, setBillingPeriod] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<string>("");
  const [availablePeriods, setAvailablePeriods] = useState<Array<{ period: string; providers: string[] }>>([]);
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({});
  const [scanProvider, setScanProvider] = useState<string>("all");
  const [allResources, setAllResources] = useState<ResourceRecord[]>([]);
  /** Tracks which service cards are expanded (keyed by "provider:discovererKey") */
  const [expandedServices, setExpandedServices] = useState<Record<string, boolean>>({});
  /** Bandwidth report data from DO CSV */
  const [bandwidthData, setBandwidthData] = useState<BandwidthReport[]>([]);
  /** Bandwidth pool for the selected period (TiB), from API */
  const [bandwidthPoolTib, setBandwidthPoolTib] = useState<number>(0);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/resource-scan");
      if (res.ok) {
        const data = await res.json();
        setCurrentScan(data.currentScan);
        setRecentScans(data.recentScans ?? []);
      }
    } catch (error) {
      console.error("Failed to fetch scan status:", error);
    }
  }, []);

  const fetchPeriods = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/resource-scan/services?list=periods");
      if (res.ok) {
        const data = await res.json();
        const periods = data.periods ?? [];
        setAvailablePeriods(periods);
        // Auto-select the latest period where all providers have data
        if (!selectedPeriod && periods.length > 0) {
          const totalProviders = new Set(periods.flatMap((p: { providers: string[] }) => p.providers)).size;
          const fullPeriod = periods.find((p: { providers: string[] }) => p.providers.length >= totalProviders);
          setSelectedPeriod(fullPeriod?.period ?? periods[0].period);
        }
      }
    } catch (error) {
      console.error("Failed to fetch periods:", error);
    }
  }, [selectedPeriod]);

  const fetchServices = useCallback(async () => {
    if (!selectedPeriod) return;
    try {
      const res = await fetch(`/api/v1/resource-scan/services?period=${selectedPeriod}`);
      if (res.ok) {
        const data = await res.json();
        setServices(data.services ?? {});
        setBillingPeriod(data.billingPeriod ?? null);
      }
    } catch (error) {
      console.error("Failed to fetch services:", error);
    }
  }, [selectedPeriod]);

  const fetchBandwidthData = useCallback(async () => {
    if (!selectedPeriod) return;
    try {
      const res = await fetch(`/api/v1/bandwidth/reports?period=${selectedPeriod}`);
      if (res.ok) {
        const data = await res.json();
        setBandwidthData(data.resources ?? []);
        setBandwidthPoolTib(data.poolTib ?? 0);
      } else {
        setBandwidthData([]);
        setBandwidthPoolTib(0);
      }
    } catch {
      setBandwidthData([]);
      setBandwidthPoolTib(0);
    }
  }, [selectedPeriod]);

  const fetchResources = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/resources");
      if (res.ok) {
        const data = await res.json();
        setAllResources(data.resources ?? []);
      }
    } catch (error) {
      console.error("Failed to fetch resources:", error);
    }
  }, []);

  // Initial load: status, resources, and period list (period list triggers selectedPeriod)
  useEffect(() => {
    fetchStatus();
    fetchResources();
    fetchPeriods();
  }, [fetchStatus, fetchResources, fetchPeriods]);

  // When selectedPeriod changes, reload services and bandwidth data
  useEffect(() => {
    if (!selectedPeriod) return;
    fetchServices();
    fetchBandwidthData();
  }, [selectedPeriod, fetchServices, fetchBandwidthData]);

  // Poll every 3s while a scan is running
  useEffect(() => {
    if (!currentScan) return;
    const interval = setInterval(async () => {
      await fetchStatus();
      await fetchServices();
      await fetchResources();
    }, 3000);
    return () => clearInterval(interval);
  }, [currentScan, fetchStatus, fetchServices, fetchResources]);

  const handleStartScan = async () => {
    try {
      const body = scanProvider === "all" ? {} : { provider: scanProvider };
      const res = await fetch("/api/v1/resource-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.status === 409) {
        toast.error("A scan is already running");
        return;
      }

      if (res.ok) {
        toast.success("Resource scan started");
        await fetchStatus();
      } else {
        const data = await res.json();
        toast.error(data.error ?? "Failed to start scan");
      }
    } catch {
      toast.error("Failed to start scan");
    }
  };

  const toggleRow = (id: number) => {
    setExpandedRows((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleService = (provider: string, discovererKey: string) => {
    const key = `${provider}:${discovererKey}`;
    setExpandedServices((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  /** Get resources that belong to a specific discoverer, enriched with bandwidth data */
  const getResourcesForDiscoverer = (provider: string, discovererKey: string): (ResourceRecord & { bandwidthGib?: number })[] => {
    const types = DISCOVERER_RESOURCE_TYPES[discovererKey];
    if (!types) return [];
    const filtered = allResources.filter(
      (r) => r.provider === provider && types.includes(r.resourceType ?? "")
    );

    // Enrich with bandwidth data
    const bwMap = new Map(bandwidthData.map((b) => [b.resourceId, b.bandwidthGib]));
    const enriched = filtered.map((r) => ({
      ...r,
      bandwidthGib: bwMap.get(r.resourceId),
    }));

    // Sort by bandwidth (highest first) if bandwidth data exists, otherwise by name
    return enriched.sort((a, b) => {
      if (a.bandwidthGib != null && b.bandwidthGib != null) return b.bandwidthGib - a.bandwidthGib;
      if (a.bandwidthGib != null) return -1;
      if (b.bandwidthGib != null) return 1;
      return (a.resourceName ?? a.resourceId).localeCompare(b.resourceName ?? b.resourceId);
    });
  };

  /** Parse JSON details column into per-discoverer results */
  const parseDetails = (detailsJson: string | null): DiscovererDetail[] => {
    if (!detailsJson) return [];
    try {
      const parsed = JSON.parse(detailsJson);
      return parsed.discoverers ?? [];
    } catch { return []; }
  };

  const lastSuccessful = recentScans.find((s) => s.status === "success");

  // Compute summary stats (filtered by selected provider)
  const filteredServices = Object.entries(services)
    .filter(([p]) => scanProvider === "all" || p === scanProvider);
  const totalResources = scanProvider === "all"
    ? allResources.length
    : allResources.filter((r) => r.provider === scanProvider).length;
  const totalSupportedServices = filteredServices
    .flatMap(([, list]) => list)
    .filter((s) => s.hasDiscoverer).length;

  return (
    <div className="space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Resource Scan</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Discover and inventory cloud resources across all providers
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastSuccessful && (
            <span className="text-xs text-muted-foreground">
              Last scan: {new Date(lastSuccessful.started_at).toLocaleString()}
            </span>
          )}
          <Select value={selectedPeriod} onValueChange={(v) => v && setSelectedPeriod(v)}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Select month" />
            </SelectTrigger>
            <SelectContent>
              {availablePeriods.map((p) => (
                <SelectItem key={p.period} value={p.period}>
                  {p.period} ({p.providers.map((pr) => getProviderLabel(pr)).join(", ")})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={scanProvider} onValueChange={(v) => setScanProvider(v ?? "all")}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Providers</SelectItem>
              <SelectItem value="aws">AWS</SelectItem>
              <SelectItem value="digitalocean">DigitalOcean</SelectItem>
              <SelectItem value="alibaba-cloud">Alibaba Cloud</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={handleStartScan} disabled={!!currentScan}>
            {currentScan ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Scanning ({currentScan.progress.completed}/{currentScan.progress.total})
              </>
            ) : (
              <>
                <Radar className="mr-2 h-4 w-4" />
                Scan Resources
              </>
            )}
          </Button>
        </div>
      </div>

      {/* ── Summary Stats ──────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold font-mono">{totalResources}</div>
            <p className="text-xs text-muted-foreground mt-1">Total Resources Discovered</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold font-mono">{totalSupportedServices}</div>
            <p className="text-xs text-muted-foreground mt-1">Services with Auto-Discovery</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold font-mono">
              ${filteredServices.flatMap(([, list]) => list).reduce((sum, s) => sum + s.lastBillAmount, 0).toFixed(2)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {billingPeriod ? `${billingPeriod} Spend` : "Monthly Spend"} (per provider)
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Service Coverage with Expandable Resources ─────────────────────── */}
      {Object.entries(services).length > 0 ? (
        <div className="space-y-4">
          {Object.entries(services)
            .filter(([provider]) => scanProvider === "all" || provider === scanProvider)
            .map(([provider, serviceList]) => {
            const providerCost = serviceList.reduce((s, svc) => s + svc.lastBillAmount, 0);
            // bandwidth_reports data is DO-only; sum directly for digitalocean provider
            const providerBandwidth = provider === "digitalocean"
              ? bandwidthData.reduce((s, b) => s + b.bandwidthGib, 0)
              : 0;
            // DO bandwidth pool for the selected period (from API)
            const providerPoolTib = provider === "digitalocean" ? bandwidthPoolTib : 0;

            return (
            <Card key={provider}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{getProviderLabel(provider)}</CardTitle>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground font-mono">
                    <span>{serviceList.filter((s) => s.hasDiscoverer).length}/{serviceList.length} services</span>
                    {providerCost > 0 && (
                      <span>Cost: <span className="text-foreground">${providerCost.toFixed(2)}</span></span>
                    )}
                    {providerBandwidth > 0 && providerPoolTib > 0 && (
                      <span>Bandwidth: <span className={providerBandwidth / 1024 > providerPoolTib ? "text-red-500" : "text-foreground"}>
                        {(providerBandwidth / 1024).toFixed(1)} / {providerPoolTib} TiB
                      </span></span>
                    )}
                    {providerBandwidth > 0 && providerPoolTib === 0 && (
                      <span>Bandwidth: <span className="text-foreground">
                        {providerBandwidth >= 1024
                          ? `${(providerBandwidth / 1024).toFixed(1)} TiB`
                          : `${providerBandwidth.toFixed(1)} GiB`}
                      </span></span>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10" />
                      <TableHead>Service</TableHead>
                      <TableHead className="text-right">Monthly Spend</TableHead>
                      <TableHead className="text-right">Resources</TableHead>
                      <TableHead className="text-right w-[120px]">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {serviceList.map((svc) => {
                      const isSupported = svc.hasDiscoverer && svc.discovererKey;
                      const serviceKey = `${provider}:${svc.discovererKey}`;
                      const isServiceExpanded = isSupported && expandedServices[serviceKey];
                      const serviceResources = isSupported
                        ? getResourcesForDiscoverer(provider, svc.discovererKey!)
                        : [];

                      return (
                        <Fragment key={svc.service}>
                          <TableRow
                            className={isSupported ? "cursor-pointer hover:bg-muted/50" : ""}
                            onClick={isSupported ? () => toggleService(provider, svc.discovererKey!) : undefined}
                          >
                            <TableCell>
                              {isSupported && (
                                <button
                                  type="button"
                                  aria-label={isServiceExpanded ? `Collapse ${svc.service}` : `Expand ${svc.service}`}
                                  className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                                >
                                  {isServiceExpanded
                                    ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                    : <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                  }
                                </button>
                              )}
                            </TableCell>
                            <TableCell>
                              <span className="font-medium">{svc.service}</span>
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              ${svc.lastBillAmount.toFixed(2)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {isSupported ? serviceResources.length : "—"}
                            </TableCell>
                            <TableCell className="text-right">
                              {svc.hasDiscoverer ? (
                                <Badge variant="default" className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                                  Supported
                                </Badge>
                              ) : svc.reason === "account_level" ? (
                                <Badge variant="secondary">Account Level</Badge>
                              ) : (
                                <Badge variant="outline" className="text-muted-foreground">Pending</Badge>
                              )}
                            </TableCell>
                          </TableRow>

                          {/* ── Expanded resource list ─────────────────────── */}
                          {isServiceExpanded && (
                            <TableRow className="hover:bg-transparent">
                              <TableCell colSpan={5} className="p-0">
                                <div className="border-t border-border/60 bg-muted/20 px-4 py-3">
                                  {serviceResources.length === 0 ? (
                                    <p className="text-sm text-muted-foreground py-2 text-center">
                                      No resources discovered yet. Run a scan to discover resources for this service.
                                    </p>
                                  ) : (
                                    <>
                                      <Table>
                                        <TableHeader>
                                          <TableRow>
                                            <TableHead className="w-8" />
                                            <TableHead>Name / ID</TableHead>
                                            <TableHead>分类</TableHead>
                                            <TableHead>Region</TableHead>
                                            <TableHead>Spec</TableHead>
                                            <TableHead className="w-[140px]">IP</TableHead>
                                            <TableHead>Status</TableHead>
                                            <TableHead className="text-right">Bandwidth</TableHead>
                                            <TableHead className="text-right">Base Cost</TableHead>
                                          </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                          {serviceResources.map((r) => (
                                            <TableRow key={r.resourceId}>
                                              <TableCell className="text-muted-foreground">
                                                {resourceTypeIcon(r.resourceType)}
                                              </TableCell>
                                              <TableCell>
                                                <div className="font-medium">{r.resourceName || "—"}</div>
                                                <div className="text-xs text-muted-foreground font-mono">{r.resourceId}</div>
                                              </TableCell>
                                              <TableCell>
                                                {(() => {
                                                  const cat = r.usageCategory ?? "other";
                                                  const cfg = CATEGORY_BADGE[cat] ?? CATEGORY_BADGE.other;
                                                  return (
                                                    <Badge variant="secondary" className={`text-[11px] ${cfg.className}`}>
                                                      {cfg.label}
                                                    </Badge>
                                                  );
                                                })()}
                                              </TableCell>
                                              <TableCell className="text-sm">{r.region ?? "—"}</TableCell>
                                              <TableCell className="text-sm text-muted-foreground">{r.spec ?? "—"}</TableCell>
                                              <TableCell className="font-mono text-xs text-muted-foreground max-w-[140px]">
                                                {r.publicIp || r.privateIp ? (
                                                  <div className="space-y-0.5 truncate">
                                                    {r.publicIp && <div className="truncate" title={r.publicIp}>{r.publicIp}</div>}
                                                    {r.privateIp && <div className="truncate opacity-60" title={r.privateIp}>{r.privateIp}</div>}
                                                  </div>
                                                ) : "—"}
                                              </TableCell>
                                              <TableCell>
                                                <Badge
                                                  variant={isActiveStatus(r.status) ? "default" : "secondary"}
                                                  className={isActiveStatus(r.status) ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-100" : ""}
                                                >
                                                  {r.status ?? "unknown"}
                                                </Badge>
                                              </TableCell>
                                              <TableCell className="text-right font-mono text-sm">
                                                {r.bandwidthGib != null ? (
                                                  r.bandwidthGib >= 1024
                                                    ? `${(r.bandwidthGib / 1024).toFixed(2)} TiB`
                                                    : `${r.bandwidthGib.toFixed(1)} GiB`
                                                ) : "—"}
                                              </TableCell>
                                              <TableCell className="text-right font-mono text-sm">
                                                {r.monthlyBaseCost != null ? `$${r.monthlyBaseCost.toFixed(2)}/mo` : "—"}
                                              </TableCell>
                                            </TableRow>
                                          ))}
                                        </TableBody>
                                      </Table>
                                    </>
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <Radar className="h-8 w-8 mx-auto mb-3 opacity-40" />
            <p>No billing data found. Sync your billing data first for accurate service coverage analysis.</p>
            <p className="text-xs mt-1">You can still run a resource scan — it will check all supported services.</p>
          </CardContent>
        </Card>
      )}

      {/* ── Scan History ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Scan History</CardTitle>
        </CardHeader>
        <CardContent>
          {recentScans.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Clock className="h-8 w-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No scans yet. Click &quot;Scan Resources&quot; to start.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Time</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Services</TableHead>
                  <TableHead className="text-right">Resources</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentScans.map((scan) => {
                  const isExpanded = expandedRows[scan.id] ?? false;
                  const details = parseDetails(scan.details);
                  return (
                    <Fragment key={scan.id}>
                      <TableRow
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => toggleRow(scan.id)}
                      >
                        <TableCell>
                          {details.length > 0 && (
                            <button
                              type="button"
                              aria-label={isExpanded ? "Collapse scan details" : "Expand scan details"}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                            >
                              {isExpanded
                                ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                : <ChevronRight className="h-4 w-4 text-muted-foreground" />
                              }
                            </button>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">{new Date(scan.started_at).toLocaleString()}</TableCell>
                        <TableCell>{getProviderLabel(scan.provider)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            {statusIcon(scan.status)}
                            <span className="text-sm capitalize">{scan.status}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">{scan.services_scanned}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{scan.resources_found}</TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground">
                          {formatDuration(scan.started_at, scan.finished_at)}
                        </TableCell>
                      </TableRow>

                      {/* ── Expanded scan details ─────────────────────── */}
                      {isExpanded && details.length > 0 && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={7} className="p-0">
                            <div className="border-t border-border/60 bg-muted/20 px-4 py-3">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Service</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead className="text-right">Resources</TableHead>
                                    <TableHead className="text-right">Duration</TableHead>
                                    <TableHead>Error</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {details.map((d) => (
                                    <TableRow key={d.serviceKey}>
                                      <TableCell className="font-mono text-sm">{d.serviceKey}</TableCell>
                                      <TableCell>
                                        <div className="flex items-center gap-1.5">
                                          {statusIcon(d.status)}
                                          <span className="text-sm capitalize">{d.status}</span>
                                        </div>
                                      </TableCell>
                                      <TableCell className="text-right font-mono text-sm">{d.resourcesFound}</TableCell>
                                      <TableCell className="text-right text-sm text-muted-foreground">
                                        {d.durationMs < 1000 ? `${d.durationMs}ms` : `${(d.durationMs / 1000).toFixed(1)}s`}
                                      </TableCell>
                                      <TableCell className="text-sm text-red-500 max-w-[250px] truncate">
                                        {d.error ?? "—"}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
