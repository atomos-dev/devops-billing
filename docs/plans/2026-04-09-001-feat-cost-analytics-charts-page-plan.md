---
title: "feat: Add Cost Analytics Charts Page"
type: feat
status: active
date: 2026-04-09
origin: docs/brainstorms/2026-04-09-cost-analytics-charts-requirements.md
---

# feat: Add Cost Analytics Charts Page

## Overview

新建独立的"成本分析"页面，通过 4 种图表从多维度可视化 AWS、DigitalOcean、阿里云的账单数据。后端 service 层已具备所有查询能力，主要工作是新建 API routes 和前端图表页面。

## Problem Statement / Motivation

系统已收集三家 provider 的账单数据，但前端仅有一个饼图和数字卡片。用户无法直观理解成本结构、发现趋势异常或定位费用大户。后端 `getMonthlyTrend`、`getCostBreakdown`、`getTopResources` 等函数已就绪但未暴露给前端。（see origin: docs/brainstorms/2026-04-09-cost-analytics-charts-requirements.md）

## Proposed Solution

### 页面布局

新建 `/cost-analytics` 页面，顶部为筛选栏（月份 + provider），下方 2×2 网格布局展示四个图表卡片：

```
┌─────────────────────────────────────────────────┐
│  [月份选择器 ▾]  [Provider 筛选 ▾]              │
├────────────────────────┬────────────────────────┤
│  R1. 月度费用趋势       │  R2. 服务费用分布       │
│  (堆叠面积图)           │  (环形图)              │
│  6 个月 · 按 provider   │  当月 · 按 service     │
├────────────────────────┬────────────────────────┤
│  R3. Top 10 资源费用    │  R4. 区域/分类对比      │
│  (水平条形图)           │  (条形图 + 维度切换)    │
│  当月 · 按资源          │  当月 · region/category │
└────────────────────────┴────────────────────────┘
```

- Desktop: 2 列网格（`grid-cols-2`）
- Tablet/Mobile: 单列堆叠

### 筛选联动

- 月份选择器：基于数据库已有 billing period 列表（复用 resource-scan 页面的 period 查询模式）
- Provider 筛选：All / AWS / DigitalOcean / Alibaba Cloud
- 切换后所有图表联动刷新
- 不做 URL query param 同步（与现有页面保持一致）

### 数据决策

- **手动费用排除**：成本分析仅展示自动采集的 provider 数据，不含 manual costs（see origin）
- **Provider 筛选行为**：选择单个 provider 时，所有图表只展示该 provider 数据，包括趋势图（see origin）
- **Null 处理**：`resourceId` 为 null 的 bill items 在 Top N 中按 service 聚合，显示为 "{service} (未归属)"；`region`/`category` 为 null 时显示为 "未分类"

## Technical Considerations

### 复用现有能力

| 需求 | 后端函数 | 状态 |
|------|---------|------|
| R1 月度趋势 | `getMonthlyTrend(months)` → `MonthlySummary[]` | ✅ 已有，需过滤 manual costs |
| R2 服务分布 | `getCostBreakdown(period, 'service', provider?)` | ✅ 已有 |
| R3 Top N 资源 | `getTopResources(period, limit)` | ⚠️ 需增加 `provider?` 参数 |
| R4 区域/分类 | `getCostBreakdown(period, 'region'|'category', provider?)` | ✅ 已有 |

### 需要新建

1. **API Routes** — 3 个新 endpoint（或 1 个聚合 endpoint）
2. **前端页面** — `src/app/(dashboard)/cost-analytics/page.tsx`
3. **侧边栏导航** — 在 `sidebar.tsx` 的 `navItems` 数组中添加入口
4. **`getTopResources` 增加 provider 过滤** — 小改动

### 性能

- 4 个图表数据可并行请求（`Promise.all`）
- ECharts 已有 lazy loading，不影响首屏
- 数据量小（6 个月 × 3 providers，最多几十条记录），无需分页或虚拟化

## Acceptance Criteria

### Phase 1: API Layer

- [ ] `getTopResources` 新增可选 `provider` 参数，按 provider 过滤（`src/services/billing.ts`）
- [ ] `getMonthlyTrend` 返回结果中过滤掉 `isManual: true` 的 providers（或新建 wrapper）
- [ ] 新建 `GET /api/v1/analytics/trend` — 返回 `getMonthlyTrend()` 结果（排除 manual），支持 `?months=N` 参数
- [ ] 新建 `GET /api/v1/analytics/breakdown` — 调用 `getCostBreakdown`，支持 `?period=YYYY-MM&dimension=service|region|category&provider=xxx` 参数
- [ ] 新建 `GET /api/v1/analytics/top-resources` — 调用 `getTopResources`，支持 `?period=YYYY-MM&limit=N&provider=xxx` 参数
- [ ] 新建 `GET /api/v1/analytics/periods` — 返回可用的 billing period 列表（复用 bills 表查询）

### Phase 2: 前端页面

- [ ] 新建 `src/app/(dashboard)/cost-analytics/page.tsx`，带文件头注释
- [ ] 页面顶部：标题 "成本分析" + 月份 `Select` + Provider `Select`
- [ ] R1 月度趋势：堆叠面积图，X 轴月份，Y 轴金额，每个 provider 一个区域，tooltip 显示各 provider 金额和总计
- [ ] R2 服务分布：环形图，显示当前月份各 service 费用占比，tooltip 显示金额和百分比
- [ ] R3 Top 10 资源：水平条形图，显示资源名称/ID + service + 金额，`resourceId` 为 null 的按 service 聚合
- [ ] R4 区域/分类对比：垂直条形图 + 维度切换按钮（Region / Category），null 值显示为 "未分类"
- [ ] 2×2 响应式网格：`grid-cols-1 lg:grid-cols-2`
- [ ] 每个图表包裹在 `Card` 组件中，带标题
- [ ] Loading 状态：图表区域显示骨架/占位
- [ ] 空数据状态：各图表独立显示 "暂无数据" 提示
- [ ] 错误处理：fetch 失败时 console.error + 图表显示空状态（与现有页面模式一致）

### Phase 3: 导航集成

- [ ] 在 `src/components/layout/sidebar.tsx` 的 `navItems` 添加 `{ href: "/cost-analytics", label: "成本分析", icon: BarChart3 }`
- [ ] 验证侧边栏高亮状态正确

### Quality Gates

- [ ] 所有图表在 provider 筛选和月份切换后 1 秒内刷新
- [ ] 图表 hover tooltip 显示具体数值（金额保留 2 位小数，带 $ 前缀）
- [ ] 响应式布局：桌面 2×2，移动端单列
- [ ] TypeScript 无类型错误
- [ ] 现有 Dashboard 页面不受影响

## Implementation Phases

### Phase 1: API Layer + Service 修改

**文件清单：**
- `src/services/billing.ts` — 修改 `getTopResources` 增加 `provider?` 参数
- `src/app/api/v1/analytics/trend/route.ts` — 新建
- `src/app/api/v1/analytics/breakdown/route.ts` — 新建
- `src/app/api/v1/analytics/top-resources/route.ts` — 新建
- `src/app/api/v1/analytics/periods/route.ts` — 新建

**验证：** 用 curl 或浏览器访问各 endpoint 确认返回正确 JSON

### Phase 2: 前端页面

**文件清单：**
- `src/app/(dashboard)/cost-analytics/page.tsx` — 新建（主页面，约 200-300 行）

**ECharts 配置参考：**

R1 堆叠面积图核心 option：
```typescript
{
  tooltip: { trigger: "axis" },
  legend: { data: providerNames },
  xAxis: { type: "category", data: months },
  yAxis: { type: "value", axisLabel: { formatter: "${value}" } },
  series: providers.map(p => ({
    name: p, type: "line", areaStyle: {}, stack: "total",
    data: trendData.map(m => m.providers.find(x => x.provider === p)?.amount ?? 0)
  }))
}
```

R2 环形图核心 option：
```typescript
{
  tooltip: { trigger: "item", formatter: "{b}: ${c} ({d}%)" },
  series: [{
    type: "pie", radius: ["40%", "70%"],
    data: breakdownData.map(d => ({ name: d.key ?? "未分类", value: d.totalAmount }))
  }]
}
```

R3 水平条形图核心 option：
```typescript
{
  tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
  xAxis: { type: "value", axisLabel: { formatter: "${value}" } },
  yAxis: { type: "category", data: topResources.map(r => r.resourceName || r.service + " (未归属)"), inverse: true },
  series: [{ type: "bar", data: topResources.map(r => r.totalAmount) }]
}
```

R4 垂直条形图核心 option：
```typescript
{
  tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
  xAxis: { type: "category", data: breakdownData.map(d => d.key ?? "未分类") },
  yAxis: { type: "value", axisLabel: { formatter: "${value}" } },
  series: [{ type: "bar", data: breakdownData.map(d => d.totalAmount) }]
}
```

### Phase 3: 导航集成

**文件清单：**
- `src/components/layout/sidebar.tsx` — 修改（添加 1 个 navItem）

**验证：** 浏览器访问确认侧边栏导航显示且可跳转

## Dependencies & Risks

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 某些 provider 无数据导致图表空白 | 中 | 低 | 每个图表独立处理空状态 |
| ECharts 堆叠面积图在数据量差异大时可读性差 | 低 | 低 | tooltip 补充具体数值 |
| `getTopResources` 返回全部 null resourceId | 低 | 中 | 按 service 聚合兜底 |

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/2026-04-09-cost-analytics-charts-requirements.md](docs/brainstorms/2026-04-09-cost-analytics-charts-requirements.md) — 成本分析图表需求，确定了 4 个图表维度、独立页面、基础筛选联动、聚焦成本洞察

### Internal References

- 页面结构模式: `src/app/(dashboard)/page.tsx` (dashboard 页面)
- 复杂页面参考: `src/app/(dashboard)/resource-scan/page.tsx` (筛选器、Select 组件用法)
- Chart 组件: `src/components/charts/chart.tsx` (ECharts wrapper)
- 侧边栏导航: `src/components/layout/sidebar.tsx:18-21` (navItems 数组)
- 核心 service: `src/services/billing.ts:130` (getMonthlyTrend), `src/services/billing.ts:250` (getTopResources), `src/services/billing.ts:269` (getCostBreakdown)
- API route 模式: `src/app/api/v1/summary/route.ts`
