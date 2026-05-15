# Provider Settings Web UI — 设计文档

## 概述

为 DevOps Billing 系统添加 Provider Settings 页面，允许用户通过 Web UI 管理云服务商凭证，替代手动编辑 .env 文件。支持 AES-256-GCM 加密存储 + .env 回退机制。

## 目标

- 用户在 Settings 页面即可配置、启用/禁用云厂商（当前为 AWS、DigitalOcean）
- 凭证加密存储于 SQLite，首次部署可无缝 fallback 到 .env
- 新增云厂商只需写 adapter 类 + 注册到 registry，无需改 DB schema

## 范围

**包含**：
- Provider 凭证的 CRUD（加密存储）
- 连接测试功能
- 启用/禁用开关
- .env 回退兼容
- Settings 页面 UI
- 全站视觉设计系统重构（Ops Hybrid 风格）
- 登录页面布局修复（不显示侧边栏）

**不包含**：
- 运行时动态注册新 provider 类型（需代码变更）
- Sync 频率等通用设置的 UI 管理
- 多用户权限控制

**已知限制**：
- `AUTH_SECRET` 变更后，已加密的凭证将无法解密，需重新在 UI 中配置凭证
- 单用户场景，无并发编辑冲突处理

---

## 1. 数据库 Schema

新增 `provider_settings` 表。

### Drizzle ORM 定义（添加到 `src/db/schema.ts`）

```typescript
/** Cloud provider configuration and encrypted credentials */
export const providerSettings = sqliteTable("provider_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull().unique(),      // 'aws' | 'digitalocean' 等
  displayName: text("display_name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  credentials: text("credentials"),                    // AES-256-GCM 加密后的 JSON
  lastTestedAt: text("last_tested_at"),
  lastTestResult: integer("last_test_result", { mode: "boolean" }),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});
```

### 迁移执行

```bash
npx drizzle-kit generate   # 生成 SQL 迁移文件到 src/db/migrations/
npx drizzle-kit push        # 或直接推送到开发数据库
```

### 设计要点

- `provider` 字段 UNIQUE，每种厂商只存一行
- `credentials` 存储加密后的 JSON 字符串，解密后结构因 provider 而异
- `credentials` 为 NULL 表示 UI 未配置，将 fallback 到 .env
- `enabled` 使用 `{ mode: "boolean" }` 让 Drizzle 自动转换 0/1 与 boolean
- Schema 完全通用，不绑定任何特定厂商

---

## 2. Provider Registry（代码层）

在 `src/providers/registry.ts` 定义 provider 元数据和凭证字段 schema。

Registry 是 **single source of truth** for `displayName`（Provider 类的 `displayName` 将从 registry 读取，而非硬编码）。

```typescript
export interface CredentialField {
  key: string;
  label: string;
  type: "text" | "password";
  required: boolean;
  default?: string;
  hint?: string;
}

export interface ProviderMeta {
  displayName: string;
  credentialFields: CredentialField[];
  /** 将凭证 JSON 转换为 provider 构造函数所需的 config 对象 */
  toProviderConfig: (creds: Record<string, string>) => Record<string, unknown>;
}

export const PROVIDER_REGISTRY: Record<string, ProviderMeta> = {
  aws: {
    displayName: "Amazon Web Services",
    credentialFields: [
      { key: "accessKeyId", label: "Access Key ID", type: "text", required: true },
      { key: "secretAccessKey", label: "Secret Access Key", type: "password", required: true },
      { key: "region", label: "Default Region", type: "text", required: true, default: "us-east-1" },
      { key: "resourceRegions", label: "Resource Regions", type: "text", required: false,
        hint: "Comma-separated region codes, e.g. us-east-1,ap-southeast-1" },
    ],
    toProviderConfig: (creds) => ({
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      region: creds.region || "us-east-1",
      // resourceRegions: 从逗号分隔字符串转为 string[]
      resourceRegions: (creds.resourceRegions || "us-east-1").split(",").map((r) => r.trim()),
    }),
  },
  digitalocean: {
    displayName: "DigitalOcean",
    credentialFields: [
      { key: "apiToken", label: "API Token", type: "password", required: true },
    ],
    toProviderConfig: (creds) => ({
      apiToken: creds.apiToken,
    }),
  },
};
```

### 扩展方式

添加新云厂商：
1. 在 `PROVIDER_REGISTRY` 注册字段定义和 `toProviderConfig` 转换函数
2. 编写实现 `BillingProvider` 接口的 adapter 类
3. 在 `PROVIDER_FACTORIES` 中注册构造函数（见 Section 4）

Settings 页面表单自动根据 registry 动态渲染，无需改 UI 代码。

---

## 3. 加密模块

文件：`src/lib/crypto.ts`

### 算法

- **AES-256-GCM**：对称加密 + 认证标签（防篡改）
- **密钥派生**：`scrypt(AUTH_SECRET, salt, keyLen=32)` — 参数 `{ N: 16384, r: 8, p: 1 }`
- **IV**：每次加密随机生成 12 字节
- **存储格式**：`salt:iv:authTag:ciphertext`（十六进制拼接，冒号分隔）

### 接口

```typescript
/** 加密明文。使用 process.env.AUTH_SECRET 作为密钥源 */
function encrypt(plaintext: string): string;

/** 解密密文。AUTH_SECRET 不匹配时抛出错误 */
function decrypt(ciphertext: string): string;
```

### 安全考量

- 无外部依赖，仅使用 Node.js `crypto` 模块
- 每次加密使用随机 salt + 随机 IV，同一明文产生不同密文
- `AUTH_SECRET` 泄露 = 所有凭证泄露（与现有认证风险相同，不引入新攻击面）
- 启动时校验：如果 `AUTH_SECRET` 未设置且 DB 中有加密凭证，记录警告日志

---

## 4. 配置加载流程

修改 `src/providers/index.ts`。

### `loadConfig()` 改造

`loadConfig()` **保持同步**（Drizzle + better-sqlite3 本身是同步 API），不影响现有调用方。

改造后逻辑：
```typescript
export function loadConfig(): Map<string, { enabled: boolean; config: Record<string, unknown> }> {
  const result = new Map();

  for (const [providerKey, meta] of Object.entries(PROVIDER_REGISTRY)) {
    const dbRow = getProviderSetting(providerKey); // 同步读取 DB
    const envConfig = loadEnvConfig(providerKey);   // 读取 .env

    // 优先级判断
    if (dbRow) {
      if (!dbRow.enabled) continue; // DB 明确禁用 → 跳过
      if (dbRow.credentials) {
        // DB 有凭证 → 解密并使用
        const creds = JSON.parse(decrypt(dbRow.credentials));
        result.set(providerKey, { enabled: true, config: meta.toProviderConfig(creds) });
      } else if (envConfig) {
        // DB 无凭证但 .env 有 → fallback
        result.set(providerKey, { enabled: true, config: envConfig });
      }
      // DB enabled=true 但无凭证且 .env 也无 → 不启用（缺少凭证）
    } else if (envConfig) {
      // DB 无记录，.env 有配置 → 向后兼容
      result.set(providerKey, { enabled: true, config: envConfig });
    }
  }

  return result;
}
```

### `createProviders()` 改造

引入 `PROVIDER_FACTORIES` 映射表，配合 registry 实现通用分发：

```typescript
import { AwsProvider } from "./aws";
import { DigitalOceanProvider } from "./digitalocean";

/** Provider 构造函数映射 */
const PROVIDER_FACTORIES: Record<string, (config: Record<string, unknown>) => BillingProvider> = {
  aws: (config) => new AwsProvider(config as AwsConfig),
  digitalocean: (config) => new DigitalOceanProvider(config as DoConfig),
};

export function createProviders(): Map<string, BillingProvider> {
  const configMap = loadConfig();
  const providers = new Map<string, BillingProvider>();

  for (const [key, { config }] of configMap) {
    const factory = PROVIDER_FACTORIES[key];
    if (factory) {
      providers.set(key, factory(config));
    }
  }

  return providers;
}
```

### 对现有调用方的影响

- `scripts/sync.ts`：`createProviders(config)` → `createProviders()`（无需传参）
- `src/app/api/v1/sync/route.ts`：同上
- 变更极小，两处调用改为无参即可

### 完整优先级矩阵

| DB 记录 | DB enabled | DB credentials | .env 配置 | 结果 |
|---------|-----------|----------------|-----------|------|
| 存在 | true | 有值 | 任意 | 使用 DB 凭证 |
| 存在 | true | 无值 | 有值 | 使用 .env 凭证（fallback） |
| 存在 | true | 无值 | 无值 | **不启用**（缺少凭证） |
| 存在 | false | 任意 | 任意 | 不启用 |
| 不存在 | — | — | enabled + 有值 | 使用 .env（向后兼容） |
| 不存在 | — | — | disabled/无值 | 不启用 |

### .env enabled 判断规则

与现有逻辑一致：
- `AWS_ENABLED` 不存在或非 `"false"` → enabled（默认启用）
- `AWS_ENABLED=false` → disabled
- 同理适用于 `DO_ENABLED`

---

## 5. Service 层

文件：`src/services/settings.ts`

### 函数签名

```typescript
/** 获取所有 provider 的设置（含脱敏凭证信息） */
function getAllProviderSettings(): ProviderSettingView[];

/** 获取单个 provider 的 DB 记录（内部使用，含加密凭证） */
function getProviderSetting(provider: string): ProviderSettingRow | undefined;

/** 获取解密后的凭证 JSON（内部使用） */
function getDecryptedCredentials(provider: string): Record<string, string> | null;

/** 创建或更新 provider 设置 */
function upsertProviderSetting(provider: string, data: {
  enabled?: boolean;
  credentials?: Record<string, string> | null;
}): ProviderSettingRow;

/** 更新连接测试结果 */
function updateTestResult(provider: string, success: boolean): void;
```

### `configSource` 判定规则

在 `getAllProviderSettings()` 中：
- DB 有记录且 `credentials` 非空 → `"database"`
- DB 有记录但 `credentials` 为空，且 .env 有对应变量 → `"env"`
- DB 无记录，.env 有对应变量 → `"env"`
- 都无 → `"none"`

### PUT 部分更新语义

凭证字段合并逻辑：
- 请求中 `credentials` 为 `null` → 清除 DB 凭证（回退到 .env）
- 请求中 `credentials` 为对象 → 与已有凭证合并
  - 字段值为非空字符串 → 覆盖
  - 字段值为空字符串或缺失 key → 保留已有值不变

---

## 6. API 路由

### 端点

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/v1/settings/providers` | 获取所有 provider 设置（凭证脱敏） |
| PUT | `/api/v1/settings/providers/[provider]` | 创建或更新 provider 设置 |
| POST | `/api/v1/settings/providers/[provider]/test` | 测试 provider 连接 |

### GET `/api/v1/settings/providers` 响应

```json
{
  "providers": [
    {
      "provider": "aws",
      "displayName": "Amazon Web Services",
      "enabled": true,
      "configured": true,
      "configSource": "database",
      "lastTestedAt": "2026-03-18T10:30:00Z",
      "lastTestResult": true,
      "credentialFields": [
        { "key": "accessKeyId", "label": "Access Key ID", "type": "text",
          "required": true, "hasValue": true, "value": "AKIA..." },
        { "key": "secretAccessKey", "label": "Secret Access Key", "type": "password",
          "required": true, "hasValue": true },
        { "key": "region", "label": "Default Region", "type": "text",
          "required": true, "hasValue": true, "value": "us-east-1", "default": "us-east-1" },
        { "key": "resourceRegions", "label": "Resource Regions", "type": "text",
          "required": false, "hasValue": true, "value": "us-east-1,ap-southeast-1",
          "hint": "Comma-separated region codes" }
      ]
    }
  ]
}
```

**脱敏规则**：
- `type: "password"` 字段：只返回 `hasValue`，不返回 `value`
- `type: "text"` 字段：返回 `hasValue` + `value`（明文，如 region）

### PUT `/api/v1/settings/providers/[provider]` 请求/响应

**请求**：
```json
{
  "enabled": true,
  "credentials": {
    "accessKeyId": "AKIA...",
    "secretAccessKey": "xxx",
    "region": "us-east-1",
    "resourceRegions": "us-east-1,ap-southeast-1"
  }
}
```

**响应**（200）：
```json
{ "success": true, "provider": "aws", "enabled": true, "configSource": "database" }
```

### POST `/api/v1/settings/providers/[provider]/test` 请求/响应

**请求**（可选传入临时凭证，用于"先测试再保存"场景）：
```json
{
  "credentials": {
    "accessKeyId": "AKIA...",
    "secretAccessKey": "xxx",
    "region": "us-east-1",
    "resourceRegions": "us-east-1,ap-southeast-1"
  }
}
```

如果请求 body 为空或不含 `credentials`，则使用 DB/env 中已有的凭证测试。

**响应**（200）：
```json
{ "success": true, "message": "Connection successful" }
```

**响应**（200, 测试失败）：
```json
{ "success": false, "message": "Failed to connect: AccessDeniedException" }
```

---

## 7. Settings 页面 UI

### 页面结构

新增 `/settings` 页面（`src/app/settings/page.tsx`），Client Component。

Sidebar 导航添加 "Settings" 菜单项（齿轮图标）。

### Provider 卡片布局

```
┌──────────────────────────────────────────────┐
│  Settings                                    │
│  Manage cloud provider connections           │
├──────────────────────────────────────────────┤
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │  Amazon Web Services                 │    │
│  │  Status: ● Connected    Source: DB   │    │
│  │  Last tested: 2 hours ago            │    │
│  │                                      │    │
│  │  [Edit Credentials]  [Test]  [Toggle]│    │
│  └──────────────────────────────────────┘    │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │  DigitalOcean                        │    │
│  │  Status: ○ Not configured            │    │
│  │                                      │    │
│  │  [Configure]              [Toggle]   │    │
│  └──────────────────────────────────────┘    │
│                                              │
└──────────────────────────────────────────────┘
```

### 交互流程

1. **页面加载**：GET `/api/v1/settings/providers` 获取状态
2. **编辑凭证**：点击 "Edit Credentials" / "Configure" → 打开 Dialog
   - 表单字段根据 `credentialFields` 动态渲染
   - password 字段已有值时显示 placeholder `••••••••`，留空 = 不修改
   - text 字段预填现有 value
3. **保存**：PUT API → 加密存储 → 刷新卡片状态 → Toast 提示
4. **测试连接**：POST test API → Loading 动画 → Toast 显示结果
   - Dialog 内"Save & Test"按钮：先保存再测试（两步串行）
   - 卡片上"Test"按钮：用已保存凭证测试
5. **启用/禁用**：Toggle 按钮 → PUT API（仅更新 enabled）→ 即时反映

### .env 迁移提示

当 `configSource === "env"` 时，卡片显示信息提示：
> "Credentials loaded from environment variables. Edit to save to database."

### Toggle 组件

启用/禁用使用 Button 实现 toggle 效果（避免新增 Switch 组件）：
- enabled 状态：绿色 Badge "Enabled" + "Disable" 按钮（variant=outline）
- disabled 状态：灰色 Badge "Disabled" + "Enable" 按钮（variant=default）

---

## 8. 登录页面布局修复

### 问题

当前 `src/app/layout.tsx` 无条件渲染 `<Sidebar />` 和 `<Header />`，导致登录页面也显示侧边栏和顶部栏。

### 方案

采用 Next.js App Router 的**路由组 (Route Groups)** 解决：

```
src/app/
  (auth)/           ← 无 Sidebar/Header 的布局
    login/
      page.tsx
    layout.tsx       ← 仅渲染 children + Toaster
  (dashboard)/      ← 有 Sidebar/Header 的布局
    layout.tsx       ← Sidebar + Header + children
    page.tsx         ← Dashboard
    bills/
    resources/
    trends/
    manual-costs/
    settings/
  layout.tsx         ← Root layout（仅 html/body/Providers）
```

**Root layout**（`src/app/layout.tsx`）：只包含 `<html>`, `<body>`, `<Providers>`, `<Toaster>`
**Dashboard layout**（`src/app/(dashboard)/layout.tsx`）：包含 `<Sidebar>` + `<Header>` + `<main>{children}</main>`
**Auth layout**（`src/app/(auth)/layout.tsx`）：只包含 `{children}`

这样登录页面完全不渲染 Sidebar 和 Header。

---

## 9. 文件变更清单

### 新增文件

| 文件 | 用途 |
|------|------|
| `src/providers/registry.ts` | Provider 元数据 + 凭证字段定义 + toProviderConfig 转换 |
| `src/lib/crypto.ts` | AES-256-GCM 加密/解密工具 |
| `src/services/settings.ts` | Provider settings CRUD 服务层 |
| `src/app/api/v1/settings/providers/route.ts` | GET 所有 provider 设置 |
| `src/app/api/v1/settings/providers/[provider]/route.ts` | PUT 单个 provider 设置 |
| `src/app/api/v1/settings/providers/[provider]/test/route.ts` | POST 测试连接 |
| `src/app/(dashboard)/settings/page.tsx` | Settings 页面 |
| `src/app/(dashboard)/layout.tsx` | Dashboard 布局（含 Sidebar + Header） |
| `src/app/(auth)/layout.tsx` | Auth 布局（无 Sidebar） |

### 修改文件（含路由组重构）

| 文件 | 变更内容 |
|------|----------|
| `src/db/schema.ts` | 新增 `providerSettings` 表定义 |
| `src/providers/index.ts` | 重构 `loadConfig()` + `createProviders()`：DB 优先 + .env fallback + PROVIDER_FACTORIES |
| `src/providers/aws.ts` | `displayName` 改为从 registry 读取 |
| `src/providers/digitalocean.ts` | `displayName` 改为从 registry 读取 |
| `src/components/layout/sidebar.tsx` | 添加 Settings 菜单项 |
| `scripts/sync.ts` | `createProviders(config)` → `createProviders()`（无参） |
| `src/app/api/v1/sync/route.ts` | 同上 |
| `src/app/layout.tsx` | 精简为仅 html/body/Providers/Toaster（移除 Sidebar/Header） |

### 迁移文件（路由组重构）

现有页面从 `src/app/` 移入 `src/app/(dashboard)/`：
- `page.tsx`, `bills/`, `resources/`, `trends/`, `manual-costs/`

登录页面从 `src/app/login/` 移入 `src/app/(auth)/login/`

---

## 9. 测试策略

| 层 | 测试内容 |
|----|----------|
| 单元测试 | `crypto.ts` 加密解密正确性、不同 AUTH_SECRET 无法解密、空输入处理 |
| 单元测试 | `loadConfig()` 优先级矩阵全部 6 种组合 |
| 单元测试 | Settings service CRUD（upsert、部分更新、凭证合并） |
| API 测试 | GET 脱敏验证（password 字段无 value） |
| API 测试 | PUT 部分更新（空字段不覆盖、null 清除凭证） |
| API 测试 | POST test（使用已保存凭证 + 临时凭证两种模式） |
| E2E 测试 | Settings 页面流程：配置 → 测试 → 启用/禁用 |

---

## 11. 视觉设计系统 — Ops Hybrid

### 设计方向

**Aesthetic**: Ops Hybrid — 暗色侧边导航 + 亮色数据内容区
**DFII**: 12 (Excellent)
**灵感来源**: Grafana 的运维气质 + Vercel 的现代工艺
**辨识锚点**: 深色导航与亮色数据区域的上下文分裂 + monospaced 金额数字

> This avoids generic UI by splitting visual context between navigation (dark, permanent) and data (light, scannable) — instead of applying one uniform theme everywhere.

### Fonts

| 用途 | 字体 | 理由 |
|------|------|------|
| 数字/金额 | **Space Mono** | 等宽对齐，金融数据扫读效率高 |
| 正文/标题 | **Plus Jakarta Sans** | 几何感现代 sans-serif，比 Inter 更具辨识度 |

通过 `next/font/google` 引入。

### 色彩系统

```css
:root {
  /* --- Sidebar (Dark Context) --- */
  --sidebar: #0F172A;                /* slate-900 */
  --sidebar-foreground: #E2E8F0;     /* slate-200 */
  --sidebar-accent: #1E293B;         /* slate-800 — hover/active */
  --sidebar-accent-foreground: #F8FAFC;
  --sidebar-muted: #94A3B8;          /* slate-400 — secondary text */
  --sidebar-border: #1E293B;

  /* --- Content Area (Light Context) --- */
  --background: #F1F5F9;             /* slate-100 — page bg */
  --foreground: #0F172A;             /* slate-900 */
  --card: #FFFFFF;
  --card-foreground: #0F172A;
  --muted: #E2E8F0;                  /* slate-200 */
  --muted-foreground: #64748B;       /* slate-500 */
  --border: #CBD5E1;                 /* slate-300 */
  --input: #E2E8F0;

  /* --- Semantic Colors --- */
  --primary: #0F172A;                /* buttons, strong text */
  --primary-foreground: #F8FAFC;
  --accent: #10B981;                 /* emerald-500 — success/healthy */
  --accent-foreground: #FFFFFF;
  --warning: #F59E0B;               /* amber-500 — cost alerts */
  --destructive: #EF4444;            /* red-500 */
  --info: #3B82F6;                   /* blue-500 */

  /* --- Chart palette --- */
  --chart-1: #10B981;                /* emerald */
  --chart-2: #3B82F6;                /* blue */
  --chart-3: #F59E0B;                /* amber */
  --chart-4: #8B5CF6;                /* violet */
  --chart-5: #EC4899;                /* pink */
}
```

**色彩叙事**: Emerald = 正常, Amber = 注意, Red = 问题 — 与运维监控红绿灯直觉一致。

### 间距韵律

- 基础单位: 4px
- 页面 padding: 32px (`p-8`)
- Card padding: 24px (`p-6`)
- Section 间距: 24px (`space-y-6`)

### 阴影

```css
--shadow-card: 0 1px 3px rgba(15, 23, 42, 0.04), 0 1px 2px rgba(15, 23, 42, 0.06);
--shadow-card-hover: 0 4px 12px rgba(15, 23, 42, 0.08);
/* Sidebar: hard edge, no shadow (intentional) */
```

### 动效

- 无装饰性动画，仅 hover 150ms ease + 按钮 press scale(0.98)
- 连接测试时 spinner 旋转（唯一动画元素）

### Sidebar 重构

- 宽度: 240px
- Active 菜单: 左侧 3px emerald 条 + slate-800 背景 + white text
- Hover: slate-800 背景渐入
- 底部: 用户名 + Sign Out（从 Header 移入）
- 导航菜单新增 "Settings" 项（齿轮图标）

### Login 页面

- 独立布局（Route Group `(auth)`），不渲染 Sidebar/Header
- 全屏背景: slate-900 (#0F172A) — 与 sidebar 同色
- 居中白色 Card + emerald Sign In 按钮
- 底部版本号 "v1.0 · Deeper Network"
- 视觉叙事：深色→白色卡片 = "即将进入亮色工作区"

### Settings Provider 卡片

- Status dot: emerald = connected, amber = stale, slate = not configured
- 凭证概览: 嵌入浅灰区域 (slate-100 on white card)
- 脱敏显示: `AKIA••••FIAPW`
- 按钮: Edit = outline, Test = outline + emerald, Enabled = emerald badge

### Dashboard 金额数字

所有金额统一使用 `font-mono` (Space Mono)，确保数字等宽对齐。

### 视觉系统涉及的文件变更

| 文件 | 变更 |
|------|------|
| `src/app/globals.css` | 替换色彩变量为 Ops Hybrid 色板 |
| `src/app/layout.tsx` | 字体替换 Plus Jakarta Sans + Space Mono，移除 Sidebar/Header |
| `src/app/(dashboard)/layout.tsx` | 新增：Sidebar + main content 布局 |
| `src/app/(auth)/layout.tsx` | 新增：无 Sidebar 的纯净布局 |
| `src/components/layout/sidebar.tsx` | 暗色主题重构 + 底部用户区 |
| `src/components/layout/header.tsx` | 精简或移除（用户信息移入 sidebar） |
| `src/app/login/page.tsx` | 深色背景 + 白色卡片 + emerald 按钮 |
| 各数据页面 | 金额数字加 `font-mono` class |
