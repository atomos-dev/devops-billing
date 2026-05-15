# DigitalOcean 带宽计费机制详解

> 最后更新：2026-04-06
> 数据来源：DO 官方文档 + 实际账单数据验证

## 核心规则

### 1. 只有公网出站（Outbound）计费

- **入站流量**：免费
- **VPC 内网流量**：免费
- **出站流量**：超出免费额度后按 **$0.01/GiB** 计费

### 2. 团队级共享池（Team-Level Pool）

所有 Droplet 的免费带宽额度汇总成一个**团队级共享池**，而不是每台 Droplet 独立计算。

例如：你有 2 台 Droplet，各 1 TiB 额度，池子 = 2 TiB。
- Droplet A 用了 1.5 TiB（超出自身额度）
- Droplet B 用了 0.1 TiB
- 总用量 1.6 TiB < 2 TiB → **不超额**

### 3. 额度按秒累积，28 天封顶

**这是最关键也最容易误解的规则。**

每台 Droplet 每秒向池子贡献：

```
每秒贡献 = 该 Droplet 的月额度 / 2,419,200
```

其中 **2,419,200 = 28 天 × 24 小时 × 3600 秒**。

这意味着：
- 一台 Droplet 最快也要 **28 天** 才能贡献完它的全部额度
- 即使一个月有 30 或 31 天，**每台 Droplet 最多只贡献 28 天的额度**
- 一台只运行了 14 天的 Droplet，只贡献 50% 的额度

### 4. 月中超额 vs 月末结算

- **月中**：如果当前累计用量超过当前累计池子，账单会**临时显示超额费用**
- **月末**：最终结算时，如果池子追上来了，之前显示的超额会被**取消**
- **只有月末的最终数字才是实际计费的**

> 引用 DO 文档：*"A spike in outbound transfer early in the month might display overage charges. However, if your Droplets accrue enough free data transfer by end of the billing period, there will not be overage charges."*

---

## 计算示例

### 示例 1：简单场景

一台 `s-1vcpu-2gb` Droplet，月额度 2 TiB (2,048 GiB)。

```
每秒累积 = 2048 GiB / 2,419,200 秒 ≈ 0.000847 GiB/秒
每天累积 = 0.000847 × 86,400 ≈ 73.1 GiB/天
28 天累积 = 2048 GiB（满额）
```

| 时间点 | 累积池子 | 如果均匀使用 100 GiB/天 | 超额？ |
|-------|---------|----------------------|-------|
| 第 1 天 | 73 GiB | 100 GiB | 是（临时） |
| 第 7 天 | 512 GiB | 700 GiB | 是（临时） |
| 第 14 天 | 1,024 GiB | 1,400 GiB | 是（临时） |
| 第 21 天 | 1,536 GiB | 2,100 GiB | 是 |
| 第 28 天 | 2,048 GiB | 2,800 GiB | **是，超额 752 GiB** |
| 第 30 天 | 2,048 GiB（封顶） | 3,000 GiB | **是，超额 952 GiB** |

注意第 28 天后池子不再增长，但流量还在累积——所以 **30 或 31 天的月份比 28 天的月份更容易超额**。

### 示例 2：中途删除 Droplet

两台 Droplet，各 2 TiB 额度。
- Droplet A：运行整月（28+ 天），贡献 2 TiB
- Droplet B：只运行了 14 天就被删除，贡献 1 TiB

实际池子 = 2 + 1 = **3 TiB**（不是 4 TiB）

---

## 我们的实际情况

### 当前资源

| 规格 | 数量 | 单台额度 | 小计 |
|------|------|---------|------|
| s-1vcpu-1gb | 66 | 1 TiB | 66 TiB |
| s-1vcpu-2gb | 48 | 2 TiB | 96 TiB |
| s-1vcpu-512mb | 12 | 0.5 TiB | 6 TiB |
| s-2vcpu-4gb | 9 | 4 TiB | 36 TiB |
| s-2vcpu-2gb | 3 | 3 TiB | 9 TiB |
| s-4vcpu-8gb | 2 | 5 TiB | 10 TiB |
| 其他 | 4 | — | 13 TiB |
| **合计** | **144** | | **236 TiB** |

### 3 月实际数据（来自 DO Bandwidth Detail CSV）

```
总出站流量：296,399 GiB = 289.5 TiB
实际可用池子：~235 TiB（部分 Droplet 中途删除，池子按比例缩减）
超额：55,374 GiB ≈ 54 TiB
超额费用：$553.74
```

**流量来源 Top 5（按区域）：**

| 区域 | 3 月出站 | 占比 |
|------|---------|------|
| fra1（德国） | 130.7 TiB | 45% |
| sgp1（新加坡） | 100.7 TiB | 35% |
| sfo3（旧金山） | 33.6 TiB | 12% |
| nyc1（纽约） | 20.9 TiB | 7% |
| sfo2 | 3.5 TiB | 1% |

**流量大户 Top 5（单台 Droplet）：**

| Droplet | 区域 | 规格 | 3 月出站 | 月额度 |
|---------|------|------|---------|-------|
| do-cloud-node-de-012 | fra1 | s-1vcpu-2gb | 15.7 TiB | 2 TiB |
| do-cloud-node-de-008 | fra1 | s-1vcpu-2gb | 14.8 TiB | 2 TiB |
| do-cloud-node-de-005 | fra1 | s-1vcpu-2gb | 12.0 TiB | 2 TiB |
| do-cloud-node-de-003 | fra1 | s-1vcpu-2gb | 11.1 TiB | 2 TiB |
| do-cloud-node-de-004 | fra1 | s-1vcpu-2gb | 11.0 TiB | 2 TiB |

12 台 `do-cloud-node-de-*` 合计消耗 **130.7 TiB**，占总流量 45%，但只贡献 24 TiB 额度。

### 4 月数据（截至 4 月 6 日，来自 DO Bandwidth Detail CSV）

```
总出站流量：37,820 GiB = 36.9 TiB（6 天）
当前池子总量：236 TiB
到第 6 天累积池子：236 × 6/28 ≈ 50.6 TiB
当前超额：DO 账单显示 5,481 GiB = $54.81（临时，月末可能消除）
```

**为什么月中显示超额但按计算不应该超？**

因为流量不是均匀分布的。前几天流量突发超过了当时的累积池子，DO 临时记录了超额。但到第 6 天池子已经追上来了（50.6 TiB > 36.9 TiB）。按 DO 的规则，**如果月底池子持续大于用量，这个超额会被取消**。

### 4 月月底预估

```
日均出站：37,820 / 6 ≈ 6,303 GiB/天 = 6.16 TiB/天
预计月总出站：6,303 × 30 ≈ 189,102 GiB = 184.7 TiB
有效池子：236 TiB × min(30, 28) / 28 = 236 TiB（28 天封顶）
预计超额：184.7 - 236 = 负数 → 预计不超额
```

**4 月大概率不会产生最终超额费用**（假设流量保持当前水平）。

---

## 为什么 3 月超额而之前没有？

| 月份 | Droplet 数 | 池子（估算） | 变化原因 |
|------|-----------|------------|---------|
| 2025-10 | 188 | ~367 TiB | — |
| 2025-11 | 179 | ~338 TiB | 删除 9 台 |
| 2025-12 | 179 | ~332 TiB | — |
| 2026-01 | 163 | ~312 TiB | 删除 16 台 |
| 2026-02 | 161 | ~305 TiB | 删除 2 台 |
| **2026-03** | **149** | **~235 TiB** | **删除 12 台大规格机器（-61 TiB）** |

2-3 月间删除了 12 台机器，包括 `mainnet` (c-4-8GiB, 5 TiB)、`testnet` (s-2vcpu-8gb-amd, 5 TiB) 等大规格机器，池子从 ~305 TiB 骤降到 ~235 TiB。**流量没变，池子缩了，所以超了。**

---

## 优化建议

1. **升级 cloud-node 规格**：12 台 `s-1vcpu-2gb`（2 TiB 额度）升级到 `s-2vcpu-4gb`（4 TiB 额度），额外获得 24 TiB 池子，月增成本约 $144
2. **添加"占坑"Droplet**：创建几台低成本大额度 Droplet 纯为增加池子（如 `s-8vcpu-16gb-amd` 月费 $84 但有 6 TiB 额度）——但需要和超额费用对比是否划算
3. **优化出站流量**：检查 cloud-node 节点是否有可以压缩或缓存的数据传输

---

## 参考链接

- [DigitalOcean Bandwidth Billing 官方文档](https://docs.digitalocean.com/platform/billing/bandwidth/)
- [Droplet Pricing 文档](https://docs.digitalocean.com/products/droplets/details/pricing/)
- [社区问答：Details on bandwidth billing](https://www.digitalocean.com/community/questions/details-on-bandwidth-billing-of-my-droplet)
