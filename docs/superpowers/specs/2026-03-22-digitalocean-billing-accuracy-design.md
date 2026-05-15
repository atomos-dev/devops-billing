# DigitalOcean 账单精度修复 — 设计文档

## 概述

修复 DigitalOcean 账单同步在本地 SQLite 中的两类精度问题：

1. **历史账单明细不准确**：同一账单月内，部分 invoice items 在落库时被覆盖，导致 `bill_items.amount` 汇总小于 `bills.total_amount`。
2. **当前月只有总额没有明细**：当 DigitalOcean 还未生成正式 invoice 时，系统当前会用 `month_to_date_usage` 生成 bill header，但拿不到 line items。

本设计的目标是：**优先保证真实账单数据的准确性，不生成估算明细，不为兼容旧实现引入额外抽象。**

---

## 目标

- 历史月份的 DigitalOcean `bill_items` 在同步后应能与 `bills.total_amount` 对账。
- 当前月在尚无正式 invoice 时，允许保留 bill total，但不伪造明细。
- 下一次正常的 DigitalOcean sync 应自动修复回填窗口内的历史错误数据。
- 尽量避免数据库 schema 迁移，优先使用 provider 归一化 + provider-specific sync 策略完成修复。

## 非目标

- 不为当前月生成“估算 bill_items”。
- 不重构 AWS 同步逻辑。
- 不新增复杂的账单版本管理、快照历史或审计表。
- 不要求修改 Bills UI 才能完成本次精度修复。

---

## 现状与根因

### 1. 当前月总额与明细来源不同步

`src/providers/digitalocean.ts` 中：
- `fetchBills()` 会使用 `/customers/my/balance` 的 `month_to_date_usage` 生成当前月 bill。
- `fetchBillItems(billingPeriod)` 则必须先找到 matching invoice，找不到时直接返回空数组。

这意味着“**当前月有总额、没有明细**”在未出账前是一个合法状态，而不是实现错误。

### 2. 历史月份明细被覆盖

`src/services/sync.ts` 当前对所有 provider 共用 bill item upsert 逻辑，identity 只看：
- `billId`
- `service`
- `region`
- `resourceId`
- `usageUnit`

DigitalOcean 的 invoice items 可能在同一个账单月内出现多条共享上述维度的 line（例如不同时间窗口、同类重复计费片段）。当前同步会把后来的 line update 到前一条记录上，导致：
- 明细条数减少
- 明细金额被覆盖而不是累计
- 最终 `sum(bill_items.amount) < bills.total_amount`

---

## 核心设计决策

## 决策 1：DigitalOcean 明细在 provider 层先归一化，再落库

不修改现有 `bill_items` schema，也不扩大全局唯一键。

在 `DigitalOceanProvider.fetchBillItems()` 返回结果前，先按当前持久化身份维度聚合重复 line：
- `service`
- `region`
- `resourceId`
- `usageUnit`

归一化规则：
- `amount`：求和
- `usageQuantity`：对可累加值求和；若都为空则保持 `undefined`
- `resourceName`：优先保留第一个非空描述
- `startDate`：取最早值
- `endDate`：取最晚值

这样可以让“同身份但多时间片”的多个 invoice line 在进入 sync 前就变成一个准确的聚合结果，兼容现有表结构与大部分查询逻辑。

### 为什么不用 schema 迁移扩大唯一键

因为当前产品展示与服务层并不消费 `startDate/endDate` 作为细粒度分析维度，真正要求的是：
- 总额准确
- 服务/区域/资源聚合准确

既然消费层不需要逐时间片展示，就没必要为了保留原始 line 粒度去引入更高风险的 SQLite 表结构迁移。

---

## 决策 2：DigitalOcean bill items 改为“按账单月全量重建”

在 `src/services/sync.ts` 中为 DigitalOcean 增加 provider-specific 逻辑：

- 找到某个月对应的 bill 后
- 先删除该 `billId` 下已有的全部 `bill_items`
- 再插入 `fetchBillItems()` 返回的归一化结果

AWS 继续沿用现有 upsert 逻辑，不做行为变更。

### 这样做的好处

- 历史错误数据可以在下一次 sync 时自然修复。
- 避免 DigitalOcean 继续受“旧错误 identity 匹配”影响。
- 行为简单，易测，且与 DigitalOcean invoice 的“按月整单 authoritative snapshot”语义匹配。

---

## 决策 3：当前月无 invoice 时，保留总额，接受空明细

当 DigitalOcean 当前月尚无 invoice：
- `fetchBills()` 仍可生成 bill header（来自 `month_to_date_usage`）
- `fetchBillItems()` 返回空数组
- sync 会删除并重建该 bill 的 items；因为 authoritative items 为 0，所以 bill_items 为空是正确结果

### 语义约定

这类账单表示：
- **bill total 是实时余额快照**
- **line items 待正式 invoice 出账后补齐**

这不是“不准确”，而是“明细尚未可用”。

---

## 数据流

### 历史月份（已有 invoice）

1. `DigitalOceanProvider.fetchBills()` 读取 invoice list → 生成 bill header
2. `syncProvider()` upsert bill
3. `DigitalOceanProvider.fetchBillItems(period)` 拉取 invoice items
4. provider 内部先按持久化 identity 聚合重复 line
5. sync 层删除该 bill 下旧 items
6. sync 层插入新的聚合 items
7. `sum(bill_items.amount)` 应与 `bills.total_amount` 对齐

### 当前月份（尚无 invoice）

1. `fetchBills()` 使用 `month_to_date_usage` 生成当前月 bill
2. `fetchBillItems(currentMonth)` 因无 matching invoice 返回 `[]`
3. sync 层删除该 bill 下旧 items（若有）
4. bill 保留，items 为空
5. 后续月份 invoice 出现后，再次 sync 自动补齐 items

---

## 兼容性与影响范围

### 对 AWS 的影响

无。AWS provider 与现有 upsert 逻辑保持不变。

### 对服务层 / UI 的影响

- `getBills()`、`getBillItems()`、导出、报表等无需改变接口。
- Bills 详情页在当前月 DO 尚无明细时仍会显示空表，这是符合新语义的结果。
- 本次不新增 UI 文案或 API 标志位，避免把“精度修复”扩展成额外产品改动。

### 对数据库的影响

- 不新增列
- 不改 schema
- 不做 migration
- 数据修复依赖下一次 DigitalOcean sync 的“删除并重建 items”行为完成

---

## 文件变更

### 修改

- `src/providers/digitalocean.ts`
  - 新增 DigitalOcean invoice item 归一化逻辑
  - 保持 current-month balance bill 逻辑不变

- `src/services/sync.ts`
  - 为 DigitalOcean bill item 同步增加“按 billId 删除并重建”路径
  - AWS 继续使用现有 upsert 路径

- `src/providers/__tests__/digitalocean.test.ts`
  - 新增重复 invoice line 聚合测试
  - 新增当前月无 invoice 时返回空 items 的行为测试（若已有同义测试则补强）

- `src/services/__tests__/sync.test.ts`
  - 新增 DO 同步时先删除旧 items 再重建的测试
  - 新增 DO 同步不会走旧的通用 bill item upsert 合并路径的测试

---

## 测试策略

### Provider 层

- 重复 identity 的两条 DO invoice item 应被聚合为一条
- 聚合后：
  - `amount` 为总和
  - `usageQuantity` 为总和
  - `startDate/endDate` 为最小/最大边界
- 当 period 无 matching invoice 时，返回空数组

### Sync 层

- DO 某月 sync 时，会删除该 bill 既有 items 后再插入新 items
- DO 历史错误数据可通过再次 sync 被修复
- AWS 仍保持现有 upsert 行为，避免回归

### 回归验证

修复后对本地数据库执行一轮 DO sync，预期：
- `2025-09` ~ `2026-02` 的 DO 账单头 / 明细差值显著收敛到 0
- `2026-03` 若仍无 invoice，则 bill total 保留、item total 仍可能为 0，这是允许结果

---

## 风险与缓解

### 风险 1：归一化维度仍不够细

**概率：低到中**

如果 DigitalOcean 未来出现同一 identity 下不能简单累加的 line，可能继续丢失细节。

**缓解：**
当前 app 的消费层本来就只按 service/region/resource 聚合展示；本次优先修复金额准确性。若未来要做 line-level 审计，再单独设计原始明细表。

### 风险 2：删除后重建导致中途异常时 items 暂时为空

**概率：低**

如果删除成功、插入阶段失败，该月 items 会暂时缺失。

**缓解：**
插入失败会记录 sync error；后续再次 sync 可重建。若实现成本低，优先放进事务中执行删除+重建。

### 风险 3：历史修复依赖下一次 sync

**概率：高**

代码修复本身不会自动修改当前数据库，仍需执行一次 DO sync。

**缓解：**
保持 backfill window 默认 6 个月；当前库中的问题月份已落在该窗口内，下一次正常 sync 即可修复。

---

## 回滚策略

- 若 DO provider 归一化逻辑有问题，可回滚 `src/providers/digitalocean.ts` 与 `src/services/sync.ts`。
- 因无 schema 变更，回滚不涉及数据库 migration。
- 若回滚后需要恢复数据，只能再次执行旧逻辑 sync；因此建议先靠测试覆盖 provider 聚合与 sync 重建行为。

---

## 最终结论

本次修复采用：

- **Provider 层聚合重复 DO invoice lines**
- **Sync 层对 DO 按账单月删除并重建 items**
- **当前月无 invoice 时保留总额，不生成估算明细**

这是当前代码库里修复 DigitalOcean 账单精度问题的最小闭环方案：
- 能修历史金额不准
- 不引入 schema 迁移
- 不影响 AWS
- 符合“真实账单优先”的产品语义
