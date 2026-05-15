# 基于 Prometheus 的僵尸 / 低利用率资源识别设计

## 概述

当前系统已经能够同步 AWS 与 DigitalOcean 的账单数据、账单明细和资源清单，并在 Resources 页面展示资源状态与基础成本信息。下一步目标是在现有资源视图上增加“僵尸资源 / 低利用率资源”识别能力，用于辅助成本治理与人工回收决策。

本设计采用以下产品方向：

- **首期范围**：仅覆盖 AWS EC2 与 DigitalOcean Droplets
- **监控来源**：后端直接查询 Prometheus，Grafana 继续作为可视化入口
- **主判定窗口**：最近 30 天
- **结果入口**：增强现有 Resources 页面，不新增独立页面
- **判定目标**：同时识别“明显僵尸”和“长期低利用率”两类资源
- **产品语义**：给出可解释的治理建议，不做自动关机、自动删除或自动降配

---

## 目标

- 将资源清单、成本信息与监控活跃度关联起来，帮助快速定位可回收或可降配的计算实例。
- 对每个实例给出统一的活动状态：`active`、`low_utilization`、`zombie`、`unknown`。
- 提供可解释的判定依据，而不是只给一个黑盒结论。
- 在监控缺失、映射失败或时间窗口不足时，优先避免误报。
- 保持与现有资源同步与资源页模式一致，避免引入单独的重型分析子系统。

## 非目标

- 不覆盖 AWS 非 EC2 资源、DigitalOcean 非 Droplet 资源、Kubernetes 资源或 PaaS 资源。
- 不直接通过 Grafana Panel API 取数。
- 不在页面请求时实时查询 Prometheus 并即时计算结果。
- 不做自动下线、自动缩容或自动改配动作。
- 不尝试在第一版解决所有 FinOps 场景，例如预留实例优化、存储闲置分析、跨资源依赖分析等。
- 不要求第一版就支持人工豁免、审批流或通知集成。

---

## 现有基础

当前代码库已经具备以下可复用基础：

1. **资源主数据已落库**
   - `resources` 表已保存 `provider`、`resourceId`、`resourceType`、`region`、`spec`、`status`、`monthlyBaseCost`、`usageCategory` 等字段。
   - 这可以作为活跃度分析的主资源表。

2. **资源同步能力已存在**
   - `src/services/sync.ts` 已负责从 provider 拉取并 upsert 资源清单。
   - 这为后续“同步后刷新活跃度快照”提供了天然挂载点。

3. **资源页已有展示骨架**
   - `src/app/(dashboard)/resources/page.tsx` 已支持搜索、筛选、分组、内联展开和基础成本展示。
   - 首期只需增强，不必新建单独视图。

4. **系统尚未接入监控数据源**
   - 当前代码库内没有现成的 Grafana / Prometheus 客户端与配置模型。
   - 因此本次设计需要新增监控数据接入层与活动快照持久化层。

---

## 范围定义（V1）

### 覆盖资源

- AWS EC2 实例
- DigitalOcean Droplets

### 输入数据

- 资源主数据：来自现有 `resources` 表
- 成本参考：优先使用 `resources.monthlyBaseCost`，必要时可结合已有账单明细做补充展示
- 活跃度数据：来自 Prometheus，且 Prometheus 指标中可以稳定拿到实例 ID / droplet ID

### 输出结果

对每个资源生成一条最近 30 天的活动快照，包含：

- 活动状态：`active | low_utilization | zombie | unknown`
- 置信度：`high | medium | low`
- 指标摘要：CPU、网络、磁盘 IO
- 可读原因：为什么被判为 low_utilization / zombie / unknown
- 快照时间：最近一次分析时间
- 潜在节省参考：使用 `monthlyBaseCost` 作为首期节省估算基线

---

## 核心设计决策

### 决策 1：后端直接查询 Prometheus，而不是走 Grafana API

虽然用户认知上是“结合 Grafana 数据来判定”，但后端真正应接入的是 **Prometheus**：

- Grafana 是展示与查询编排层，不是最稳定的时序数据接口边界。
- 直接查询 Prometheus 更符合“系统服务对接数据源”的语义。
- 可以避免把实现耦合到某个 Grafana dashboard、panel 或 datasource proxy 细节。

因此，本次设计将 Grafana 视为运维侧查看和验证结果的现有工具，而本系统后端直接调用 Prometheus Query API / Range Query API。

### 决策 2：采用“定时快照 + 规则分类”，不做页面实时查询

本次不在用户打开 Resources 页时实时请求 Prometheus，而是采用：

1. 定时或手动同步资源
2. 同步后批量刷新资源活动快照
3. 页面读取落库后的活动结果

原因：

- 与现有 billing / resources 的采集落库模式一致
- 页面性能稳定，不依赖 Prometheus 的瞬时响应
- 支持排序、筛选、导出与历史演进
- 更容易解释“这个状态基于哪个时间窗口、哪次分析得出”

### 决策 3：首期仅对计算实例做判定

首期范围仅覆盖 EC2 与 Droplets，不扩展到负载均衡、存储卷、数据库等资源。

原因：

- 计算实例最容易通过 CPU / 网络 / 磁盘 IO 形成稳定判定
- `resources` 表中已能较稳定识别 `ec2` 与 `droplet`
- 可以用最小范围建立准确、可解释的判定基线

### 决策 4：分类结果必须包含“状态 + 置信度 + 原因”

单独输出 `zombie` 或 `low_utilization` 不足以支撑治理决策，因此每条结果至少包含：

- **活动状态**：业务上怎么理解这个实例
- **置信度**：系统对这个结论有多确定
- **原因**：哪些指标触发了该结论

这会直接影响 UI 展示、筛选与人工复核体验。

### 决策 5：监控缺失时优先输出 `unknown`，不强行判僵尸

以下情况不应直接标记为 `zombie`：

- 找不到该资源在 Prometheus 中的稳定映射
- 时间窗口覆盖不足
- 关键指标长期缺失
- Prometheus 查询失败

此时统一输出 `unknown`，并带原因，例如：

- `metrics_missing`
- `coverage_insufficient`
- `mapping_not_found`
- `query_failed`

### 决策 6：活动分析挂载在现有资源同步链路上

首期不引入独立的大型分析调度系统，而是在现有资源同步链路上增加“活动快照刷新”步骤：

- 定时 sync 结束后，刷新对应 provider 的活动快照
- 手动 sync 时，也可以触发对应刷新
- 活动分析失败不应破坏账单与资源同步主流程，但应记录失败信息

这样既复用现有调度，也能保持边界清晰。

---

## 目标架构

### 逻辑组件

1. **Prometheus Client**
   - 负责认证、超时控制、PromQL 调用与错误归一化

2. **Resource Metric Mapper**
   - 按 provider 将 `resources` 表中的实例映射到 Prometheus label
   - Canonical Key：`(provider, externalResourceId)`

3. **Activity Summary Builder**
   - 将 Prometheus 原始指标归一成统一的资源活动摘要
   - 输出 CPU、网络、磁盘 IO、覆盖率、最近活跃时间等统一字段

4. **Idle Classifier**
   - 基于规则把摘要分类为 `active` / `low_utilization` / `zombie` / `unknown`
   - 生成原因数组与置信度

5. **Snapshot Store**
   - 保存每个资源最新 30 天活动快照
   - 为 UI/API 提供快速读取能力

6. **Resources API / UI Enhancer**
   - 将快照与资源主数据拼接返回
   - 支持状态筛选、风险排序与原因展示

### 数据流

#### 定时流程

1. 现有 cron 触发 provider sync
2. provider 资源同步完成，更新 `resources` 表
3. 系统筛出该 provider 下本次支持分析的计算实例
4. 调用 Prometheus，拉取 30 天窗口内的指标摘要
5. 生成/更新资源活动快照
6. 页面通过 Resources API 读取资源 + 活动快照

#### 手动流程

1. 用户触发某 provider 的手动 sync
2. 同步资源后，刷新该 provider 的活动快照
3. 页面刷新即可看到最新状态

#### 失败流程

- 若 Prometheus 查询失败：
  - 不回滚已完成的资源同步
  - 不清空上一版活动快照
  - 仅保留旧快照，并把该快照视为 stale 或无法刷新
- 若某单个资源映射失败：
  - 该资源输出 `unknown`
  - 不影响其他资源分析结果

---

## 数据模型

新增活动快照表，用于保存每个资源最近一次活动分析结果。

### 建议表：`resource_activity_snapshots`

建议字段：

- `id`
- `resourceRecordId`：关联 `resources.id`
- `windowDays`：首期固定为 30
- `windowStart`
- `windowEnd`
- `dataStatus`：`ready | partial | missing | query_error`
- `activityStatus`：`active | low_utilization | zombie | unknown`
- `confidence`：`high | medium | low`
- `metricsCoverageDays`：该窗口中有有效数据的天数
- `cpuAvgPercent`
- `cpuP95Percent`
- `networkDailyAvgBytes`
- `diskIoDailyAvgBytes`
- `activeSignalDays`
- `lastMetricAt`
- `reasons`：JSON 数组，保存判定理由代码与可读摘要
- `updatedAt`

约束建议：

- `unique(resourceRecordId, windowDays)`
- 删除资源时，活动快照可级联删除或在同步时清理孤儿记录

### 为什么需要单独快照表

不建议把这些字段直接塞进 `resources` 表：

- 活动分析是按时间窗口生成的派生结果，不是资源固有属性
- 未来可能增加 7 天 / 30 天多窗口视图
- 监控数据失败、过期、部分缺失等状态不适合污染资源主表语义

---

## Prometheus 取数抽象

### 统一摘要输出

Prometheus 层不直接把原始时序暴露给页面，而是转换成统一摘要对象：

- `cpuAvgPercent`
- `cpuP95Percent`
- `networkDailyAvgBytes`
- `diskIoDailyAvgBytes`
- `activeSignalDays`
- `lastMetricAt`
- `metricsCoverageDays`
- `availableSignals`

### Provider 侧映射规则

首期按 provider 配置映射：

- AWS EC2：通过实例 ID label 映射
- DigitalOcean Droplets：通过 droplet ID label 映射

因为不同 exporter / relabel 规则下的 PromQL 和 label 名称可能不同，设计上应预留 **provider 级查询配置**，而不是把具体 PromQL 散落在业务逻辑里。

### Deferred to Planning

以下细节需要在计划或实现前根据真实监控环境确认：

- 实际使用的 CPU / 网络 / 磁盘指标名称
- label 名是 `instance_id`、`ec2_instance_id`、`droplet_id`，还是其他自定义标签
- 不同 provider 是否走同一套 exporter

这部分属于技术接线问题，不影响产品设计结论，但必须在计划阶段完成实测确认。

---

## 判定模型

### 主状态

系统对每个资源输出以下主状态之一：

- `active`：过去 30 天存在明确活跃迹象
- `low_utilization`：过去 30 天有使用，但整体利用率长期偏低
- `zombie`：过去 30 天持续计费或处于运行态，但资源活动几乎为零
- `unknown`：由于数据缺失、映射失败或覆盖不足，不能可信判断

### 初始规则（首期默认）

以下阈值是首期默认值，后续可通过样本校准调整，但不建议在第一版就做 UI 可配置化。

#### 1. `unknown`

满足任一条件则输出 `unknown`：

- 找不到资源与 Prometheus 的稳定映射
- `metricsCoverageDays < 21`
- CPU / 网络 / 磁盘三类信号中，只有 0-1 类可用
- 查询失败且不存在可复用的旧快照

#### 2. `zombie`

需同时满足：

- 资源处于运行态（如 `running` / `active`）
- 监控覆盖足够，且至少有 CPU、网络、磁盘三类中的两类信号可用
- `cpuP95Percent < 5`
- `networkDailyAvgBytes < 50 MB/day`
- `diskIoDailyAvgBytes < 100 MB/day`
- `activeSignalDays <= 3`

语义：

- 过去 30 天里，这台实例几乎没有产生可见业务活动
- 适合作为“优先人工复核”的僵尸候选

#### 3. `low_utilization`

需满足：

- 不满足 `zombie`
- 资源处于运行态
- 监控覆盖足够
- `cpuP95Percent < 20`
- `networkDailyAvgBytes < 1 GB/day`
- `diskIoDailyAvgBytes < 2 GB/day`
- `activeSignalDays <= 10`

语义：

- 该实例不是完全闲置，但长期利用率偏低
- 更像“可降配 / 可整合”候选，而非“立即回收”候选

#### 4. `active`

满足以下任一情况即视为 `active`：

- 明确不满足 `zombie` 与 `low_utilization`
- CPU / 网络 / 磁盘任一维度表现出稳定活动
- 活跃天数明显超过低利用率门槛

### 置信度规则

- `high`
  - `metricsCoverageDays >= 27`
  - 三类信号至少两类完整可用
  - 判定条件明确

- `medium`
  - `metricsCoverageDays` 在 21-26 天之间，或部分信号缺失
  - 仍足以得出相对可信结论

- `low`
  - 仅在需要保留可疑结果但证据较弱时使用
  - 首期页面可选择隐藏 `low` 置信度结果，避免噪音

### 辅助告警：`billable_inactive`

首期主状态保持 4 类即可，但建议增加一个辅助告警位：

- 当资源不处于运行态，却仍有明确基础成本或账单归因时，附加 `billable_inactive` 原因

该告警不替代主状态，而是作为补充风险说明，例如：

- 实例已 stopped，但仍挂载卷或保留公网 IP，导致持续产生成本

这样既保持状态体系简洁，又能覆盖“已停机但仍花钱”的典型治理场景。

---

## 误报控制策略

### 1. 覆盖率保护

只有在窗口覆盖足够时才允许输出 `zombie` 或 `low_utilization`。这可以天然保护：

- 新创建资源
- 刚接入监控的资源
- 中间经历 exporter 断流的资源

### 2. 缺失保护

Prometheus 无数据不等于资源空闲，因此：

- 缺失数据 → `unknown`
- 不允许“查不到数据”直接判僵尸

### 3. 旧快照保留

若某次刷新失败，不覆盖上一版成功快照；页面只标记为“快照已过期”或“最近刷新失败”。

### 4. 首期仅对 running 实例做主判定

非运行态实例默认不参与 `zombie` / `low_utilization` 主状态判断，避免把“已停机但仍有附带成本”的对象与“运行但闲置”的对象混为一谈。

---

## API 与页面呈现

### API 设计

增强现有 `/api/v1/resources` 返回值，在每条资源记录上附加活动摘要对象，例如：

- `activityStatus`
- `activityConfidence`
- `activityUpdatedAt`
- `activityReasons`
- `activityMetrics`
  - `cpuP95Percent`
  - `networkDailyAvgBytes`
  - `diskIoDailyAvgBytes`
  - `activeSignalDays`
- `activityStale`

同时增加筛选参数：

- `activityStatus`
- `activityConfidence`
- `activityStale`
- `sort=potentialSavings | activityRisk | cost`

### Resources 页增强

在现有 Resources 页基础上增加：

1. **状态 Badge**
   - Active
   - Low utilization
   - Zombie
   - Unknown

2. **置信度 / 新鲜度标记**
   - High / Medium / Low
   - Stale（当快照过期）

3. **活动摘要**
   - 30d CPU P95
   - 30d 平均网络流量
   - 30d 平均磁盘 IO
   - 活跃天数

4. **原因说明**
   - 例如：`30d CPU P95 < 5%, network near zero, disk IO near zero`

5. **排序与筛选**
   - 只看 Zombie
   - 只看 Low utilization
   - 只看 Unknown
   - 按潜在节省金额排序

### 潜在节省估算

首期使用 `monthlyBaseCost` 作为近似节省参考值：

- 对 `zombie`：展示“潜在可回收月成本”
- 对 `low_utilization`：展示“潜在可优化月成本（参考）”

不要求第一版就把该数值做成严格账单预测。

---

## 与现有同步链路的集成方式

### 推荐集成点

在 `src/services/sync.ts` 中，provider 资源同步成功后增加“刷新该 provider 的活动快照”步骤。

推荐语义：

1. 先完成资源 upsert
2. 再对该 provider 的可分析资源批量查询 Prometheus
3. 生成 / 更新快照
4. 若活动分析失败：
   - provider sync 状态可维持 `partial` 或在 details 中记录 activity error
   - 账单与资源同步结果不回滚

### 为什么不单独新建 cron 任务

首期没必要引入独立分析调度器，原因：

- 资源主数据已经由现有 sync 保证新鲜度
- 30 天窗口不要求分钟级实时
- 复用现有入口更简单，排障路径更短

如后续资源规模扩大，可再拆分为独立分析任务。

---

## 可能涉及的文件范围

### 新增

- `src/lib/prometheus.ts`
  - Prometheus 客户端与查询封装

- `src/services/resource-activity.ts`
  - 资源活动摘要生成与状态分类逻辑

- `src/services/__tests__/resource-activity.test.ts`
  - 活动分类、阈值、缺失数据、过期快照测试

### 修改

- `src/db/schema.ts`
  - 新增 `resource_activity_snapshots` 表

- `src/services/sync.ts`
  - 资源同步后触发 provider 级活动快照刷新

- `src/app/api/v1/resources/route.ts`
  - 返回资源活动摘要与筛选能力

- `src/app/(dashboard)/resources/page.tsx`
  - 展示状态、原因、指标摘要、筛选与排序

- 相关测试文件
  - API 测试
  - 页面测试
  - 同步流程测试

---

## 验证策略

### 单元级验证

- 映射成功时，能为 EC2 / Droplet 生成标准活动摘要
- 数据缺失时，输出 `unknown`
- 不同阈值组合下，正确区分 `active` / `low_utilization` / `zombie`
- 刷新失败时，旧快照不被清空

### 集成级验证

- provider sync 完成后，活动快照能被正确刷新
- `/api/v1/resources` 返回资源与活动结果的组合视图
- Resources 页面能够按活动状态筛选与排序

### 人工回归验证

选取一组已知样本进行人工标注：

- 明显活跃实例
- 明显闲置实例
- 新创建或监控缺失实例
- 已停机但仍有成本实例

验证目标：

- `unknown` 不被误判为 `zombie`
- 已知闲置实例能够稳定进入 `zombie` 或 `low_utilization`
- 活跃实例不会大量落入误报结果

---

## 风险与缓解

### 风险 1：Prometheus label 与资源 ID 映射不稳定

**概率：中**

不同 exporter 或 relabel 规则可能让 AWS / DO 的实例 ID 标签名称不统一。

**缓解：**
在规划阶段先对真实指标做一次 label 普查，设计 provider 级查询配置层，不把 label 名硬编码进页面逻辑。

### 风险 2：阈值过严或过松导致误报 / 漏报

**概率：中到高**

不同业务类型的实例活跃模式差异很大，静态阈值不可能一次命中所有场景。

**缓解：**
首期输出原因与置信度，并优先让结果服务于“人工复核”，而不是自动动作。上线前先用已知样本做校准。

### 风险 3：Prometheus 故障导致结果陈旧

**概率：中**

如果刷新失败，页面可能只能看到上一版快照。

**缓解：**
保留上一版快照，并显式展示 stale 状态，而不是直接清空结果。

### 风险 4：`monthlyBaseCost` 与真实当月账单不完全一致

**概率：中**

按基础月价估算潜在节省金额，只能作为参考，不能等同于本月实际账单节省。

**缓解：**
UI 文案明确“潜在节省参考值”，避免误导为精确账单预测。

---

## 回滚策略

- 若活动分析逻辑效果不佳，可先停止在 sync 中触发活动快照刷新。
- 页面侧可以回退为不读取活动快照的原始 Resources 展示。
- 即使保留新增快照表，也不会影响账单与资源主数据。
- 因本次识别功能是附加分析层，回滚不会破坏现有 billing 功能主链路。

---

## 最终结论

第一版推荐采用以下最小闭环方案：

- 直接查询 **Prometheus**，不走 Grafana API
- 仅分析 **AWS EC2 + DigitalOcean Droplets**
- 使用 **30 天窗口**生成活动快照
- 输出 **状态 + 置信度 + 原因 + 指标摘要**
- 对监控缺失或覆盖不足资源统一输出 **`unknown`**
- 在现有 **Resources 页面**上增强展示与筛选
- 将活动分析挂载到现有 **provider sync** 链路中

这条路线与当前代码库的采集方式最一致，也最适合先把“账单 + 资源 + 监控”真正串起来，形成可解释、低误报、可持续扩展的资源治理基础。