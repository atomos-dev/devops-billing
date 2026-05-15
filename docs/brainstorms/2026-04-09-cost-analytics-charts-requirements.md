---
date: 2026-04-09
topic: cost-analytics-charts
---

# 成本分析图表可视化

## Problem Frame

系统已收集 AWS、DigitalOcean、阿里云三家 provider 的账单数据，后端已有丰富的聚合查询能力（趋势、分维度拆解、Top N 资源等），但前端仅有一个饼图和数字卡片。用户无法从多维度直观地理解成本结构和变化趋势，难以快速发现异常和优化机会。

## Requirements

- R1. **月度费用趋势图** — 堆叠面积图或折线图展示近 6 个月各 provider 的费用变化趋势，支持按月份查看总费用和各 provider 分别的金额
- R2. **服务费用分布图** — 环形图或 treemap 展示当月各 service 的费用占比，能一眼看出费用集中在哪些服务上
- R3. **Top N 资源费用排行** — 水平条形图展示当前月份费用最高的资源（默认 Top 10），显示资源名称、service 和金额
- R4. **区域/分类费用对比** — 条形图展示按 region 或 usage category 维度的费用分布，支持切换维度
- R5. **基础筛选联动** — 页面提供月份选择器和 provider 筛选器，切换后所有图表联动更新
- R6. **新建独立页面** — 图表放在独立的"成本分析"页面，通过侧边栏导航进入，Dashboard 保持现有的概览功能不变

## Success Criteria

- 用户能在成本分析页一屏内看到费用趋势、服务分布、Top 资源、区域对比四个维度的图表
- 切换月份或 provider 后所有图表在 1 秒内联动刷新
- 图表支持 hover tooltip 显示具体数值

## Scope Boundaries

- 不涉及新的后端数据采集或 schema 变更（已有 `getMonthlyTrend`、`getCostBreakdown`、`getTopResources` 等查询）
- 不做深度交互（点击钻取、时间范围拖拽等）
- 不改动现有 Dashboard 页面
- 不涉及带宽/运维类图表（聚焦成本维度）
- 不做数据导出功能

## Key Decisions

- **独立页面而非扩展 Dashboard**：Dashboard 保持简洁概览，成本分析页专注深度图表，职责分离
- **聚焦成本洞察**：不混入运维监控指标，保持页面主题一致
- **基础筛选而非深度交互**：月份 + provider 筛选已覆盖核心场景，避免过度复杂化
- **复用 ECharts**：项目已有 `<Chart />` 组件和 ECharts 依赖，无需引入新图表库

## Dependencies / Assumptions

- 后端已有 API 或 service 函数可直接提供所需数据（`getMonthlyTrend`、`getCostBreakdown`、`getTopResources`）
- 部分 API endpoint 可能需要新建（如 `/api/v1/summary/trend`、`/api/v1/summary/breakdown`），但 service 层已就绪

## Outstanding Questions

### Deferred to Planning

- [Affects R1-R4][Technical] 是否需要新建 API route，还是复用现有 `/api/v1/summary` 扩展参数
- [Affects R5][Technical] 月份选择器的可选范围如何确定（基于数据库中已有的 billing period）
- [Affects R3][Technical] Top N 资源排行中 resourceId 为 null 的 bill items 如何处理（按 service 聚合展示）

## Next Steps

→ `/ce:plan` for structured implementation planning
