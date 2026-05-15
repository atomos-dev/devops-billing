# 资源发现完整性设计

> 日期：2026-04-02
> 状态：已确认
> 范围：扩展 AWS 和 DigitalOcean 的资源发现能力，实现独立的资源扫描功能和页面

## 背景

当前系统仅同步 AWS EC2 实例和 DigitalOcean Droplets + Load Balancers 的资源信息。账单中包含 RDS、S3、ELB、VPC 等多种服务的费用，但无法关联到具体资源。用户无法清晰地看到"每一笔钱花在了哪个具体资源上"。

## 目标

1. 基于账单数据反推当前使用中的云服务，用各服务的原生 API 拉取具体资源清单
2. 提供独立于 billing sync 的资源扫描功能，拥有独立的触发机制和页面
3. 覆盖 AWS 和 DO 中所有产生费用的可枚举资源类型

## 非目标

- 自定义描述/标签功能（下一轮迭代）
- Prometheus 集成 / 资源活跃度检测
- 资源定价计算（仅 EC2 保留现有定价逻辑，其他服务暂不查价）

---

## 架构设计

### 整体流程

```
┌─────────────────────────────────────────────┐
│            Resource Scan Page (/resource-scan) │
│  (服务覆盖概览、扫描触发、扫描历史)            │
└──────────────────┬──────────────────────────┘
                   │
         POST /api/v1/resource-scan
                   │
         ┌─────────▼──────────┐
         │   ScanOrchestrator  │
         │                     │
         │ 1. 查询 billItems   │
         │    → 识别活跃服务    │
         │ 2. 匹配 Discoverer  │
         │ 3. 并发执行发现      │
         │ 4. 写入 resources   │
         └─────────┬──────────┘
                   │
    ┌──────────┬───┴────┬──────────┐
    ▼          ▼        ▼          ▼
 EC2Disc   RDSDisc  S3Disc   DropletDisc ...
```

### Discoverer 接口

```typescript
/** 凭证类型，按 provider 区分 */
type ProviderCredentials =
  | { provider: 'aws'; accessKeyId: string; secretAccessKey: string; region: string; resourceRegions: string[] }
  | { provider: 'digitalocean'; apiToken: string };

interface ResourceDiscoverer {
  /** 服务标识，如 'ec2', 'rds', 's3' */
  serviceKey: string;
  /** 对应 billItems 中的 service 名称，用于账单匹配 */
  billingServiceNames: string[];
  /** 执行资源发现 */
  discover(credentials: ProviderCredentials): Promise<DiscoveredResource[]>;
}

interface DiscoveredResource {
  provider: 'aws' | 'digitalocean';
  resourceId: string;
  resourceName: string;
  resourceType: string;
  region: string;              // 全局服务使用 'global'
  spec: string | null;
  tags: Record<string, string>;
  status: string;
  monthlyBaseCost: number | null;
}
```

Discoverer 注册在按 provider 分组的注册表中。新增服务支持只需写一个 Discoverer 类并注册，不改动编排逻辑。

### 账单匹配逻辑

1. 查询 `billItems` 表中所有不同的 `(provider, service)` 组合
2. 对每个 service，在注册表中找 `billingServiceNames` 包含该值的 Discoverer
3. 未匹配到 Discoverer 的服务标记为"不支持自动发现"或"账户级服务"
4. 执行匹配到的 Discoverer，汇总结果

**回退策略**：当 `billItems` 表为空（新安装、尚未同步过账单）时，执行**所有已注册的 Discoverer**，确保即使没有账单数据也能完成资源发现。页面上额外提示"建议先同步账单数据以获得更精准的服务覆盖分析"。

---

## Discoverer 清单

### AWS Discoverers

| 优先级 | serviceKey | 对应账单 service | AWS API | 说明 |
|--------|-----------|-----------------|---------|------|
| P0 | `ec2` | Amazon Elastic Compute Cloud - Compute | DescribeInstances | 已有逻辑，迁移到新体系 |
| P0 | `rds` | Amazon Relational Database Service | DescribeDBInstances | 数据库实例，含引擎类型/规格/状态 |
| P0 | `elb` | Amazon Elastic Load Balancing | DescribeLoadBalancers (ELBv2) | ALB/NLB/CLB |
| P0 | `s3` | Amazon Simple Storage Service | ListBuckets + GetBucketLocation | S3 存储桶 |
| P0 | `nat_gateway` | Amazon Virtual Private Cloud | DescribeNatGateways | NAT 网关，VPC 下最大花费来源 |
| P0 | `eip` | EC2 - Other | DescribeAddresses | 弹性 IP，未关联时产生费用 |
| P1 | `eks` | Amazon Elastic Container Service for Kubernetes | ListClusters + DescribeCluster | EKS 集群控制面 |
| P1 | `lambda` | AWS Lambda | ListFunctions | Lambda 函数，含运行时/内存配置 |
| P1 | `cloudfront` | Amazon CloudFront | ListDistributions | CDN 分发 |
| P1 | `ecr` | Amazon EC2 Container Registry (ECR) | DescribeRepositories | 容器镜像仓库 |
| P2 | `route53` | Amazon Route 53 | ListHostedZones | DNS 托管区 |
| P2 | `ebs` | EC2 - Other | DescribeVolumes | 所有 EBS 卷（含已挂载和未挂载） |

#### AWS Discoverer 实现细节

**Ec2Discoverer**：
- 直接调用 `AwsProvider.fetchResources()` 获取 EC2 资源列表，避免代码重复
- resourceType: `ec2`

**RdsDiscoverer**：
- 跨区域调用 `DescribeDBInstances`
- spec: `{engine} {dbInstanceClass}`（如 `postgres db.t3.medium`）
- status: 映射 DBInstanceStatus（available → running, stopped → stopped）
- resourceId: DBInstanceIdentifier
- tags: 通过 ListTagsForResource 获取
- resourceType: `rds`

**ElbDiscoverer**：
- 跨区域调用 ELBv2 `DescribeLoadBalancers`
- spec: `{type} {scheme}`（如 `application internet-facing`）
- resourceId: LoadBalancerArn 的最后一段
- status: State.Code（active → running）
- tags: 通过 DescribeTags 获取
- resourceType: `elb`

**S3Discoverer**：
- 调用 `ListBuckets`（全局，不分区域）
- 对每个 bucket 调用 `GetBucketLocation` 确定区域
- resourceId: BucketName
- region: 从 GetBucketLocation 获取（空值表示 us-east-1）
- spec: null（S3 无固定规格）
- 无定价（按用量计费）
- resourceType: `s3`

**NatGatewayDiscoverer**：
- 跨区域调用 `DescribeNatGateways`
- resourceId: NatGatewayId
- spec: ConnectivityType（public/private）
- status: State（available → running, deleted → terminated）
- tags: 从 Tags 字段直接获取
- resourceType: `nat_gateway`

**EipDiscoverer**：
- 跨区域调用 `DescribeAddresses`
- resourceId: AllocationId
- resourceName: 从 Tags 中取 Name 标签
- spec: `{domain}`（vpc/standard），附带关联实例信息
- status: 根据 AssociationId 判断（有关联 → associated, 无 → unassociated）
- resourceType: `eip`

**EksDiscoverer**：
- 跨区域调用 `ListClusters` + `DescribeCluster`
- resourceId: cluster name
- spec: `{version} {platformVersion}`
- status: cluster status（ACTIVE → running）
- tags: 从 cluster tags 获取
- resourceType: `eks`

**LambdaDiscoverer**：
- 跨区域调用 `ListFunctions`
- resourceId: FunctionName
- spec: `{runtime} {memorySize}MB`
- status: State（Active → running）
- tags: 通过 ListTags 获取
- resourceType: `lambda`

**CloudFrontDiscoverer**：
- 调用 `ListDistributions`（全局服务）
- resourceId: Distribution ID
- resourceName: 从 Aliases 或 Comment 取
- spec: PriceClass
- status: Enabled → running, Disabled → stopped
- region: `global`
- resourceType: `cloudfront`

**EcrDiscoverer**：
- 跨区域调用 `DescribeRepositories`
- resourceId: repositoryName
- spec: `{imageTagMutability}`
- status: 始终 `active`
- resourceType: `ecr`

**Route53Discoverer**：
- 调用 `ListHostedZones`（全局服务）
- resourceId: HostedZoneId
- resourceName: zone Name
- spec: `{type}`（public/private）
- region: `global`
- resourceType: `route53_zone`

**EbsDiscoverer**：
- 跨区域调用 `DescribeVolumes`，扫描所有 EBS 卷（不限于未挂载）
- resourceId: VolumeId
- spec: `{volumeType} {size}GiB`
- status: in-use → attached, available → unattached
- tags: 从 Tags 字段获取
- resourceType: `ebs`

### DigitalOcean Discoverers

| 优先级 | serviceKey | DO API 端点 | 说明 |
|--------|-----------|------------|------|
| P0 | `droplet` | GET /droplets | 已有逻辑，迁移到新体系 |
| P0 | `load_balancer` | GET /load_balancers | 已有逻辑，迁移到新体系 |
| P0 | `managed_db` | GET /databases | 托管数据库（PostgreSQL、MySQL、Redis、MongoDB） |
| P0 | `volume` | GET /volumes | 块存储卷 |
| P1 | `kubernetes` | GET /kubernetes/clusters | DOKS 集群 |
| P1 | `spaces` | 通过账单反推或 S3 兼容 API | 对象存储 Bucket |
| P2 | `app_platform` | GET /apps | App Platform 应用 |
| P2 | `domain` | GET /domains | DNS 域名 |

#### DO Discoverer 实现细节

**DropletDiscoverer + LoadBalancerDiscoverer**：
- 直接调用 `DigitalOceanProvider.fetchResources()` 获取 Droplet 和 Load Balancer 列表，按 resourceType 拆分返回
- resourceType: `droplet` / `load_balancer`

**ManagedDbDiscoverer**：
- 分页调用 `GET /databases`
- resourceId: database cluster UUID
- resourceName: name
- spec: `{engine} {size_slug} {num_nodes}节点`
- status: online → running
- region: region slug
- monthlyBaseCost: 从 DO 定价中无法直接获取，置 null
- resourceType: `managed_db`

**VolumeDiscoverer**：
- 分页调用 `GET /volumes`
- resourceId: volume ID
- resourceName: name
- spec: `{size_gigabytes}GiB {filesystem_type}`
- status: 根据 droplet_ids 判断（有挂载 → attached, 无 → unattached）
- resourceType: `volume`

**KubernetesDiscoverer**：
- 分页调用 `GET /kubernetes/clusters`
- resourceId: cluster UUID
- resourceName: name
- spec: `{version} {node_pools count}池`
- status: cluster status（running → running）
- resourceType: `kubernetes`

**SpacesDiscoverer**：
- DO Spaces 没有列出所有 bucket 的 REST API，且 S3 兼容 API 需要额外的 Spaces access key（当前 credentials 不包含）
- 实现策略：**仅通过账单数据反推**——从 billItems 中提取 Spaces 相关条目（service 包含 "Spaces"），将其作为资源记录写入 resources 表
- 如果未来需要更精确的 Spaces 资源发现，再扩展 ProviderCredentials 增加 Spaces key
- resourceType: `spaces`

**AppPlatformDiscoverer**：
- 分页调用 `GET /apps`
- resourceId: app ID
- resourceName: spec.name
- spec: `{tier}`
- status: active_deployment 状态
- resourceType: `app_platform`

**DomainDiscoverer**：
- 分页调用 `GET /domains`
- resourceId: domain name
- resourceName: domain name
- status: 始终 `active`
- region: `global`
- resourceType: `domain`

### 不需要 Discoverer 的服务

以下 AWS 服务是**账户级计费**，没有可枚举的独立资源，在页面上标记为"账户级服务"：

- AmazonCloudWatch — 监控指标/日志，按用量计费
- AWS Key Management Service — 密钥管理，按密钥数+请求量计费
- Amazon Simple Email Service — 邮件发送，按发送量计费
- Amazon Simple Notification Service — 消息通知，按请求量计费
- Amazon API Gateway — API 网关，按调用量计费
- AWS Glue — ETL/数据集成，按作业运行时长计费

---

## 数据库变更

### 新增 `resource_scans` 表

```typescript
export const resourceScans = sqliteTable("resource_scans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider"),         // null = 扫描全部 provider
  status: text("status").notNull().default("running"),  // running | success | failed | partial
  startedAt: text("started_at").notNull().default(sql`(datetime('now'))`),
  finishedAt: text("finished_at"),
  servicesScanned: integer("services_scanned").default(0),
  resourcesFound: integer("resources_found").default(0),
  errorMessage: text("error_message"),
  details: text("details"),           // JSON: 每个 discoverer 的执行结果摘要
});
```

### `resources` 表

无需迁移。`resourceType` 是 text 字段，直接存储新的类型值（rds、s3、nat_gateway 等）。

---

## API 设计

### POST `/api/v1/resource-scan`

触发资源扫描。

**请求体**（可选）：
```json
{ "provider": "aws" }
```
省略 `provider` 则扫描所有已启用的 provider。

**响应**：
```json
{
  "scanId": 1,
  "status": "running",
  "message": "Resource scan started"
}
```

**并发控制**：如果已有扫描正在运行，返回 409 Conflict。

### GET `/api/v1/resource-scan`

查询扫描状态和历史。

**响应**：
```json
{
  "currentScan": {
    "id": 1,
    "status": "running",
    "provider": null,
    "startedAt": "2026-04-02T10:00:00Z",
    "progress": { "completed": 3, "total": 8 }
  },
  "recentScans": [
    {
      "id": 1,
      "provider": null,
      "status": "success",
      "startedAt": "...",
      "finishedAt": "...",
      "servicesScanned": 8,
      "resourcesFound": 42,
      "details": { ... }
    }
  ]
}
```

### GET `/api/v1/resource-scan/services`

获取账单中的服务列表及 Discoverer 支持状态。

**响应**：
```json
{
  "aws": [
    {
      "service": "Amazon Relational Database Service",
      "hasDiscoverer": true,
      "discovererKey": "rds",
      "lastBillAmount": 45.20
    },
    {
      "service": "AmazonCloudWatch",
      "hasDiscoverer": false,
      "reason": "account_level",
      "lastBillAmount": 2.10
    }
  ],
  "digitalocean": [
    {
      "service": "Droplets",
      "hasDiscoverer": true,
      "discovererKey": "droplet",
      "lastBillAmount": 120.00
    }
  ]
}
```

---

## 页面设计（`/resource-scan`）

路由：`/app/(dashboard)/resource-scan/page.tsx`

页面实现时使用 `/web-design-guidelines` skill 确保 UI 质量。

### 布局

页面分为三个区域：

#### 1. 顶部操作栏

- **"扫描全部资源"** 主按钮，旁边有下拉可按 Provider 单独扫描
- 扫描进行中时按钮变为禁用状态，显示进度条（已完成/总计服务数）和当前正在扫描的服务名
- 最近一次成功扫描的时间戳

#### 2. 服务覆盖概览

按 provider 分组的卡片网格：

- **已支持服务**：显示服务名、最近月账单金额、已发现资源数量、绿色状态标记
- **账户级服务**：显示服务名、最近月账单金额、灰色标签"账户级"，无资源计数
- **待支持服务**：显示服务名、最近月账单金额、灰色标签"待支持"

卡片按账单金额降序排列，让用户优先看到花钱最多的服务。

#### 3. 扫描历史

简洁的表格：
- 列：时间、Provider（或"全部"）、状态、扫描服务数、发现资源数、耗时
- 可展开行查看每个 Discoverer 的详细结果（成功/失败、发现数量、错误信息）

---

## Scan 编排流程

```
POST /api/v1/resource-scan { provider?: string }
       │
       ▼
1. 检查是否有正在运行的扫描 → 有则返回 409
       │
       ▼
2. 创建 resource_scans 记录（status: running）
       │
       ▼
3. 查询 billItems 表，按 (provider, service) 聚合最近有数据的账单月份
   → 得到"有费用的服务列表"（取最近 3 个月内有金额 > 0 的服务，避免偶发性服务遗漏）
       │
       ▼
4. 根据请求的 provider 筛选，匹配注册表中的 Discoverer
   → 记录未匹配的服务及原因
       │
       ▼
5. 按 provider 分组执行：
   - 同一 provider 内的 Discoverer 串行执行（避免 API 限流）
   - 不同 provider 之间并行执行
   - 每个 Discoverer 跨配置的所有区域执行（AWS 需要 resourceRegions）
       │
       ▼
6. 每个 Discoverer 完成后：
   - 结果 upsert 到 resources 表（按 provider + resourceId 去重）
   - 累加更新 resource_scans.details JSON
       │
       ▼
7. 全部完成后：
   - 对本次扫描涉及的 resourceType，标记不在结果中的旧资源为 terminated
   - 更新 resource_scans：finishedAt、servicesScanned、resourcesFound、status
```

### 与现有 sync 的关系

- **完全解耦**：资源扫描不影响 billing sync，billing sync 不触发资源扫描
- **共享 resources 表**：两者都写入同一张表，按 `(provider, resourceId)` upsert
- **现有 fetchResources 复用**：EC2/Droplet/LB 的 Discoverer **直接调用**现有 `AwsProvider.fetchResources()` 和 `DigitalOceanProvider.fetchResources()` 方法，避免代码重复。其余新增 Discoverer 各自独立实现

### 错误处理

- 单个 Discoverer 失败不影响其他 Discoverer 的执行
- 部分成功时 scan status 标记为 `partial`
- 错误信息记录在 `details` JSON 中对应的 Discoverer 条目下
- **超时策略**：每个 Discoverer 设置 60 秒超时，超时后标记为 failed 并继续执行下一个

### 资源清理（terminated 标记）

编排流程步骤 7 的清理规则：
- **只对成功执行的 Discoverer 对应的 resourceType 做清理**——如果某个 Discoverer 执行失败，不标记该类型下的旧资源为 terminated（否则失败 = 误删所有记录）
- 清理范围限定在本次扫描涉及的 provider 内——只扫 AWS 时不影响 DO 资源

### 前端进度更新

- 前端通过**轮询** `GET /api/v1/resource-scan` 获取扫描进度
- 轮询间隔：扫描进行中 3 秒，空闲时不轮询
- 进度信息来自 `resource_scans.details` JSON 中各 Discoverer 的完成状态

---

## AWS IAM 权限需求

资源扫描需要在现有 Cost Explorer 权限基础上，额外添加以下只读权限：

| Discoverer | 所需 IAM 权限 |
|-----------|--------------|
| EC2 | `ec2:DescribeInstances`（已有） |
| RDS | `rds:DescribeDBInstances`, `rds:ListTagsForResource` |
| ELB | `elasticloadbalancing:DescribeLoadBalancers`, `elasticloadbalancing:DescribeTags` |
| S3 | `s3:ListAllMyBuckets`, `s3:GetBucketLocation` |
| NAT Gateway | `ec2:DescribeNatGateways` |
| EIP | `ec2:DescribeAddresses` |
| EKS | `eks:ListClusters`, `eks:DescribeCluster` |
| Lambda | `lambda:ListFunctions`, `lambda:ListTags` |
| CloudFront | `cloudfront:ListDistributions` |
| ECR | `ecr:DescribeRepositories` |
| Route 53 | `route53:ListHostedZones` |
| EBS | `ec2:DescribeVolumes` |

建议使用 AWS 托管策略 `ReadOnlyAccess` 或创建自定义策略仅包含上述权限。扫描页面在首次扫描失败时提示权限不足，并显示所需权限列表。

---

## 文件组织

```
src/
  discoverers/
    types.ts                    # ResourceDiscoverer 接口和 DiscoveredResource 类型
    registry.ts                 # Discoverer 注册表和账单匹配逻辑
    scan-orchestrator.ts        # 扫描编排服务
    aws/
      ec2.ts                    # EC2 Discoverer（调用 AwsProvider.fetchResources()）
      rds.ts
      elb.ts
      s3.ts
      nat-gateway.ts
      eip.ts
      eks.ts
      lambda.ts
      cloudfront.ts
      ecr.ts
      route53.ts
      ebs.ts
    digitalocean/
      existing-resources.ts     # Droplet + LB Discoverer（调用 DOProvider.fetchResources()）
      managed-db.ts
      volume.ts
      kubernetes.ts
      spaces.ts
      app-platform.ts
      domain.ts
  app/
    api/v1/resource-scan/
      route.ts                  # POST + GET 处理
      services/route.ts         # GET /services 处理
    (dashboard)/
      resource-scan/
        page.tsx                # 资源扫描页面
  db/
    schema.ts                   # 新增 resourceScans 表定义
    migrations/
      XXXX_add_resource_scans.sql
```

---

## 实现优先级

### 第一阶段（P0）— 核心框架 + 高价值服务

1. Discoverer 接口、注册表、编排器
2. 数据库迁移（resource_scans 表）
3. API 端点（POST/GET resource-scan, GET services）
4. AWS: EC2（迁移）、RDS、ELB、S3、NAT Gateway、EIP
5. DO: Droplet（迁移）、Load Balancer（迁移）、Managed DB、Volume
6. 资源扫描页面

### 第二阶段（P1）— 扩展服务覆盖

7. AWS: EKS、Lambda、CloudFront、ECR
8. DO: Kubernetes、Spaces

### 第三阶段（P2）— 长尾服务

9. AWS: Route 53、EBS
10. DO: App Platform、Domain
