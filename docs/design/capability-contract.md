# 能力合约与条款库设计 v1

2026-11-21 起草。状态：设计提案，待用户裁决后进 `contracts/` 冻结。依据：master-plan 第 1、5 节，`contracts/edge-ws.md` v0.14，`contracts/data-model.md` v0.12，以及 2026-11-21 关于双层路由、Edge 密钥托管、速率上限、模板固定与条款库的五项裁决。

本文件回答一个问题：**万象把"商业关系"翻译成"技术执行"的中间层应该长什么样**。它不改已冻结的 Edge/Server 协议，只定义它们之上的合约体系。

## 1. 定位

能力合约是租户与平台之间权利和义务的唯一权威表达。它派生三样东西：

- Edge 与 Server 的执行行为（允许什么、拒绝什么、按什么价格计量）
- 管理端的配置界面（哪些旋钮租户管理员能拧、拧的范围多大）
- 计费系统的账单口径（单价、倍率、折扣）

合约之下，租户内部对组和个人的管理是同一套条款体系在更小 scope 上的配置，不是另一套机制。

## 2. 设计原则

| 原则 | 含义 |
| --- | --- |
| 只收窄 | 有效能力 = 平台目录 ∩ 租户合约 ∩ 组配置 ∩ 成员配置。允许列表取交集，数值上限取最小，布尔开关取 AND，整条链单调向下 |
| 条款原子 | 每个能力点是条款库里的一个原子条款，有独立的类型、边界、继承语义和执行点；不造"大杂烩"字段 |
| 计费即条款 | 一切产生费用的参数（单价、倍率、折扣、超额策略）都是条款，账单可由合约完全复算 |
| 模板固定 | 条款库和模板都由平台维护并版本化；租户只能选模板、在边界内微调，不能自建模板、不能越界 |
| 密钥不出域 | 上游密钥只在 Server 密文和 onexd 内存中存在，永不上盘、永不入 Agent 进程、永不写日志 |

## 3. 条款类型学

条款分六类。每类的**继承语义**和**计费影响**不同，这是分类的依据。

| 类 | 条款举例 | 继承语义 | 计费影响 |
| --- | --- | --- | --- |
| 计价类（unit price） | 模型单价（输入/输出/缓存读/缓存写，每百万 token 的 milli）、工具执行单价 | 平台定基价，租户只能用折扣条款调整，不许改单价本身 | 直接进账单 |
| 倍率折扣类（multiplier） | 席位数、模型倍率、用量阶梯折扣、年付折扣、承诺折扣 | 子级继承父级的倍率组合，取乘积 | 改变账单系数 |
| 功能开关类（feature gate） | 可否自配模型、可否接自有 Provider、会话可否导出/转发、桌面 Agent 开关 | AND（父关子必关） | 决定计费项是否存在 |
| 允许列表类（allow list） | 允许的模型、Agent、发行版本钉、MCP、Skill、Hook、入口协议 | 交集 | 决定计费对象范围 |
| 资源上限类（quota/limit） | 席位上限、月度橡皮、租约额度、留存时长、单模型月预算、速率上限 | 取最小 | 触发断流与拒答 |
| 治理类（governance） | 可见性范围、审计留存、网络出口策略、留存下限 | 平台设定下限，租户只能在下限之上收紧 | 无直接计费，违反即违约 |

一个原子条款的登记结构（`clause_registry` 表，每行一个）：

```json
{
  "id": "model.monthly_budget",
  "type": "quota",
  "scope": ["tenant", "group", "member"],
  "enforce": ["server"],
  "value_schema": { "kind": "money_milli", "nullable": true },
  "bounds": { "min": null, "max": "继承上级" },
  "default": null,
  "locked": false
}
```

`locked: true` 的治理条款（如合规模板的留存下限）租户不可下调，只能更严。

## 4. 模板机制（模板固定）

平台维护版本化的模板。一个模板 = 条款集合 + 每条条款的取值。模板自身不可被租户创建或修改；平台管理员改模板产生新模板版本，存量租户合约不受影响，直到租户主动升级。

初始五个模板，对齐上一轮讨论：

| 模板 | 席位 | 模型 | 路由 | 月配额（块） | 分发 | 留存 | 导出 | 自有上游 | 自主管理 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 试用 | 5 | sonnet/haiku | 平台默认 | 待核定 | 关 | 7 天 | 关 | 关 | 邀人 |
| 团队 | 50 | 全集 | 平台默认+1 备 | 待核定 | 组+成员 | 90 天 | 关 | 关 | 组/邀人/配额 |
| 企业 | 不限 | 全集+自定义 | 双层（可自配） | 合同 | 全量 | 1 年+ | 受控开 | 开 | 全开 |
| 合规 | 不限 | 审批清单 | 双层（可自配） | 合同 | 全量 | 1 年+（下限锁定） | 关 | 关 | 受限 |
| 开发者 | 10 | CLI Agent | 平台默认 | 低 | 成员 | 30 天 | 开 | 开 | 全开 |

模板里每个条款值必须落在 `clause_registry.bounds` 内。模板发布的校验和租户微调的校验是同一个函数，杜绝"模板给了租户给不了的东西"。

试用与团队模板原列的 `50k`、`500k` 缺少计量单位，具体块数待定。§9.5 的月度橡皮包列出套餐发放量，月配额条款另行核定。

## 5. 租户合约实例（模板 + 微调）

租户合约 = `template_id + template_version + overrides[]`。每条 override：

```json
{ "clause_id": "model.allow", "value": ["claude-sonnet-5-5", "claude-haiku-5-5"] }
```

微调规则：

- override 值必须满足条款 bounds，且是收窄方向（允许列表 ⊆ 模板值，上限 ≤ 模板值）。
- `locked` 条款不可 override（或只能更严）。
- 每次变更产生新 `revision`，写审计（谁、改了哪条、从什么改成什么），并可预览"影响面"（多少成员、多少设备的配置将变化）。
- 合约热路径字段（`seat_limit`、`lease_budget_milli`、`allowed_models_json` 等）从条款派生，派生在同一事务里重算，现有 Edge 下发协议不变。

## 6. 租户内配置管理（组与个人）

租户内对组/个人的能力管理 = 在租户合约边界内，对 `scope: [group, member]` 条款的取值配置。没有第二套机制：

- 组和成员的配置条目引用同一个 `clause_registry`，取值必须收窄于租户合约对应条款。
- 现有的 `groups.quota_milli`、`members.quota_milli` 即条款 `quota.monthly_milli` 在 group/member scope 的实例；`contract.quota_distribution` 开关决定这些 scope 是否可配。
- 有效值链在配置发布时静态求值（不是每请求递归）：`publish` 时算好每个成员的有效条款快照，随 `config` 下发。

## 7. 密钥安全：Edge 就地持有，不中继

### 问题

上游 Provider 通常只给一个 API Key。万象不做 Server 中继（流量不经过 Server），所以这个 Key 必须下发到 Edge（员工电脑）。员工电脑是不受控的，Key 一旦落盘或进入 Agent 进程，就等于泄漏。

### 现有方案（已实现，`edge-config.ts`）

```
Server                                   onexd (内存)             Agent 进程
 │ master_key (Server 内存)               │
 │                                        │
 ├─ 生成临时 X25519 keypair               │
 ├─ ECDH(临时私钥, Edge 公钥)             │
 ├─ HKDF-SHA256 → 32 字节 session key    │
 ├─ XChaCha20-Poly1305(session key)      │
 │   AAD = provider_id                   │
 ├─ 密文 + nonce + key_id ──────────────►│ 解密 → 明文 key (内存)
 │                                        │
 │  key 永不落盘、永不出 onexd 进程       │
 │                                        │
 Agent 只看到 127.0.0.1:xxxx            Agent 只持有短期本机令牌
 和短期本机令牌
```

关键约束：
- Edge 注册时提交 32 字节 X25519 公钥，私钥留在 onexd 内存（不落 Keychain，重启重新协商）。
- Server 每次 `publish` 都重新信封加密，旧密文无法复用（`key_id` = 临时公钥，每次不同）。
- `config` 只下发允许模型对应的 Provider 密钥，合约以外的 Provider 密文不下发。
- Agent 配置里 `base_url` 写 `http://127.0.0.1:<port>`，`api_key` 写 onexd 签发的本机令牌。Agent 进程没有真实 Key。

### 自定义上游（企业版）的密钥隔离

企业版合约允许租户接入自有 Provider（`commercial.custom_providers: true`）。自有 Provider 的密钥存在 `tenant-<id>.sqlite.tenant_providers.secret_ciphertext`，用**租户独立加密主键**（`tenant_master_key`，与 platform 的 `master_key` 不同）加密。好处：平台运营无法解密租户的 Provider 密钥，满足合规诉求。

租户主键的生命周期：
- 开通时在 Server 内存生成，由 KMS（早期可用 `master_key` 二次派生，密钥树）保护后落盘。
- 租户注销时销毁；Server 重启从 KMS 恢复。
- 密钥树结构：`platform_master_key → (HKDF, tenant_id) → tenant_master_key → (信封加密) → provider secret`。

## 8. 速率上限：企业场景下的策略

### 决策

面向企业、按量计费的 SaaS，核心诉求是**用越多赚越多**，主动限速违反商业利益。速率上限不作为强制功能，作为**可选治理工具**，放在合约的 `governance` 节而非 `commercial` 节。

实际需要速率限制的两个场景：

| 场景 | 需求 | 实现 |
| --- | --- | --- |
| 防突发刷量（个人行为）| 单个成员 RPM/TPM 上限，防止一个人耗尽租约 | Edge 本地计数，租约层已有预留保护，补充令牌桶 |
| 保护上游账号稳定 | 单 Provider Key 的并发数上限，防 429 | Edge 本地并发信号量，已有重试逻辑（Magpie 参照） |

**不实现的场景**：租户级 TPM 汇总（需要 Valkey 跨设备聚合），S1~S3 不做，因为月度橡皮配额已经起到总量控制作用。

### 条款定义

```json
"rate_caps": {
  "per_member": {
    "rpm": null,
    "tpm": null,
    "concurrent": 4
  },
  "per_provider_key": {
    "concurrent": 8
  }
}
```

默认 null（不限）。模板里试用版建议填 rpm=60，企业版保持 null。超额时 Edge 返回 429（`rate_limited`），不影响租约和橡皮扣减。

## 9. 橡皮计量体系

### 9.1 代币价格与计量单位

**橡皮是 OneX 用于交易的代币，当前 1 块橡皮对应人民币 1 元。** 租户用人民币购买橡皮，平台按服务用量扣除相应块数。采用代币是为了让交易统一按块结算，也给后续调价留出空间。购买价格用“人民币元/块”表示，服务费率用“块/百万 token”或“块/次”表示。

橡皮按“块”计数，数量可以是小数。例如按当前价格支付 2.50 元可购得 2.5 块橡皮，消费 0.125 块后剩余 2.375 块。余额、充值、配额、租约和费用均以块输入或展示，表头或字段名可写作“余额（块）”。

账本和协议的 `*_milli` 字段按整数毫橡皮记账，**1 块橡皮 = 1,000 毫橡皮**。数量可精确到 0.001 块，页面按实际精度显示，例如 1 毫橡皮显示为 0.001 块。已有记录显示时除以 1,000，输入以块表示的数量时精确换算为整数毫橡皮。[通用单位约定](../../contracts/README.md)

所有复杂性都藏在平台内部：模型倍率、存储成本、基础设施分摊——全部由运营策略和兜底机制消化，不出现在用户的日常认知里。

| 运营策略 | 含义 |
|------|------|
| 存储不计费 | 存储是背景运营成本，每年重估一次，由廉价模型的平台利润覆盖，账单上永不出现这一行 |
| 低余额降档，不断流 | 余额低时强制切到廉价兜底模型继续工作，不直接拒绝请求。廉价模型上游成本接近零，平台实际亏损极小，用户体验大幅优于硬切断 |

### 9.2 橡皮倍率表

#### 倍率的本质

倍率是**输出 token 相对于兜底模型的价格比**，是用户理解"用贵模型消耗更快"的刻度，不是账本的原始数据。

账本底层永远是四个独立的 `milli_per_mtok` 分量（输入/输出/缓存读/缓存写），用于精确计量和对账。倍率从输出分量派生，只在展示层和谈判场景使用：

```
display_multiplier = model.output_milli_per_mtok / floor_model.output_milli_per_mtok
```

#### 五档倍率（初始参考值）

| 档位 | 代表模型 | 输出费率（块/百万 token） | 输入费率（块/百万 token） | 上游参考成本 | 场景 |
|------|---------|------------------|------------------|------------|------|
| **兜底（1×）** | Qwen3-Lite-128k | **1** | 0.3 | ¥0.01/M | 低余额自动降档、批处理、草稿 |
| **标准（3×）** | Haiku 5.5、GPT-4o-mini | **3** | 1 | ¥0.1–0.3/M | 轻量日常任务 |
| **专业（8×）** | Sonnet 5.5、GPT-4o | **8** | 2.5 | ¥0.5–2/M | 主力编程、分析 |
| **高级（20×）** | Opus 5.5、o3-mini | **20** | 6 | ¥2–10/M | 复杂推理、长文档 |
| **顶级（50×）** | 旗舰推理模型 | **50** | 15 | ¥10–25/M | 研究级任务 |

> 缓存读通常是输入的 10%，缓存写通常是输入的 125%，各模型略有不同，账本按实际 milli 扣，倍率表仅展示输出。

#### 倍率→milli 反算规则

每档输出费率按块/百万 token 定价。乘以 1,000 即得到同一百万 token 对应的毫橡皮，再按上游输入与输出的价格比推算输入分量。

```
output_milli_per_mtok = tier_output_eraser_per_M × 1_000
input_milli_per_mtok  = output_milli_per_mtok × (upstream_input_price / upstream_output_price)
cache_read_milli      = input_milli_per_mtok × 0.10   # 按上游实际调整
cache_write_milli     = input_milli_per_mtok × 1.25
```

例如 2.5 块/百万 token 对应 2,500 毫橡皮/百万 token。计算请求费用时再按实际 token 数占一百万的比例折算。

### 9.3 低余额兜底策略

余额告警 → 限制可用模型 → 只剩兜底模型 → 充值/月初自动恢复。全程不断线。

以下示例在余额降到 200 块时向管理员与员工告警，降到 50 块时切换兜底模型，耗尽至 0 块时停止。

```json
{
  "low_balance_policy": {
    "warn_at_milli": 200000,
    "restrict_at_milli": 50000,
    "hard_stop_at_milli": 0,
    "floor_models": ["qwen3-lite-128k"],
    "resume_trigger": "topup_or_next_cycle"
  }
}
```

**执行路径（全在已有基础设施上，无新机制）：**

```
余额变化 → Server 检查区间 → configPublisher.changed(tenant)
         → Edge 收到新 config（allowed_models 缩窄到 floor_models）
         → 原子替换，员工不断线
充值/月初 → 同路径恢复完整 allowed_models
```

`warn_at_milli` 和 `restrict_at_milli` 是合约条款，模板给默认值，管理员可在合约范围内调整。

### 9.4 计费容器（两个，仅此两个）

存储不入账。Agent 启动和本地工具不收费（成本已体现在 token 消耗里，双重收费没有意义）。

```
橡皮余额
  ├─ 量消耗（per-token）
  │    每次模型请求 → 四类 token 按每百万 token 的费率折算 → 整笔费用以毫橡皮记账
  │    租约机制限制单次预留上限（已有，不变）
  │
  └─ 次消耗（per-event，仅付费外部工具）
       付费搜索 API、计费 MCP 服务 → event_milli → 扣减余额
       本地 shell、文件读写、Agent 启动：免费（不入账）
```

### 9.5 套餐结构

```
月度套餐 = 平台接入费（固定，覆盖服务器/存储/分发）+ 月度橡皮包
```

月度橡皮包的发放量按块列示，平台接入费按人民币元/月列示。月度包当月使用，额外充值的有效期由模板约定。超出月度包时，按当前每块 1 元的价格续充。

| 套餐（示例） | 平台接入费（元/月） | 月度橡皮包（块） | 席位 | 兜底触发余额（块） |
| --- | --- | --- | --- | --- |
| 试用 | 0 | 500 | 5 | 50 |
| 团队 | 200 | 1000 | 50 | 100 |
| 企业 | 500 | 5000 | 不限 | 500 |
| 大客户 | 合同定 | 合同定 | 不限 | 合同定 |

`ledger.kind` 分 `subscription_grant`（月度包，月初清零重置）和 `topup`（手动充值，不过期）。扣减先用 `subscription_grant`，再用 `topup`。两种来源分开记录，月账单可分别核算。

### 9.6 数据结构变更（rates 表扩展）

在现有 `rates`（system.sqlite）旁增两张表：

```sql
-- 现有 rates 保持不变，作为量消耗的权威价格
-- 新增：次消耗费率
CREATE TABLE event_rates (
  event_type TEXT PRIMARY KEY,        -- 'mcp_call', 'search_api', etc.
  milli_per_event INTEGER NOT NULL,
  effective_from TEXT NOT NULL
);

-- 新增：倍率展示表（从 rates 派生，不影响计费，仅供 UI 和合约文档使用）
CREATE TABLE model_tiers (
  model_id TEXT PRIMARY KEY,
  tier TEXT NOT NULL,                 -- 'floor','standard','pro','advanced','top'
  display_multiplier REAL NOT NULL,   -- 派生值，rates 变动时重算
  FOREIGN KEY (model_id) REFERENCES models(id)
);
```

`ledger` 表新增 `kind` 值：`subscription_grant`（已有 `topup` 保留）。`contract` 的 `low_balance_policy_json` 字段新增，存 9.3 节的 JSON 结构。

## 10. 条款的计费关系（原第 9 节，重编号）

三类条款对账单的作用不同，这是分类的核心理由。

### 单价条款（unit price）

账单的基础原子。每个模型每种 token 类型一个价格。存在 `rates` 表，按 `effective_from` 版本化。

```
单次请求费用（毫橡皮）= 向上取整(Σ(各分量 token 数 × 对应毫橡皮费率) / 1_000_000)
单次请求费用（块）= 单次请求费用（毫橡皮）/ 1_000
```

租户合约里 `rate_override` 条款可以覆盖某模型的单价（企业大客户谈判后的折扣价，直接写在合约里，账单按合约价计，不按平台默认价）。

### 倍率/折扣条款（multiplier）

不改单价，改系数：

| 条款 | 类型 | 举例 | 账单效果 |
| --- | --- | --- | --- |
| 席位数 | 乘数（限额，不直接影响单次计费） | 50 席 | 决定可开通人数，间接影响总量 |
| 用量阶梯折扣 | 衰减系数 | 超过 10 万块橡皮后 0.9 倍 | 单价 × 折扣系数 |
| 年付折扣 | 固定系数 | 0.85 | 月账单 × 0.85 |
| 承诺用量折扣 | 分段函数 | 每月承诺 50 万块橡皮，单价 × 0.8 | 超承诺量恢复原价 |

这类条款在 `commercial.pricing` 节，账单引擎读取它们做最终结算，不影响 Edge 的实时计量（Edge 始终按全价 milli 计，账单引擎后处理折扣）。

### 功能开关条款（feature gate）

决定一个功能是否存在，不直接产生费用，但影响可计费项的范围。比如 `applications.tools.mcp: []`（空列表）等于关闭 MCP，MCP 执行费用这一行从账单上消失。

```
账单行 = {
  model 用量行,            ← unit price × volume
  Agent 执行行（如有），   ← 未来：按 Agent 启动次数或运行时长
  MCP 调用行（如有），     ← 未来：按调用次数
  席位行,                  ← 月度固定费（如有席位订阅费）
  存储行（如有），         ← 未来：按实际留存量
}
```

## 10. 数据模型变更（最小侵入）

在已有 `data-model.md` 基础上，最小化新增：

### system.sqlite 新增

```sql
-- 条款注册表（平台管理员维护）
CREATE TABLE clause_registry (
  id TEXT PRIMARY KEY,              -- 'model.allow', 'quota.monthly_milli' 等
  type TEXT NOT NULL,               -- 'unit_price'|'multiplier'|'feature_gate'|'allow_list'|'quota'|'governance'
  scope TEXT NOT NULL,              -- JSON: ["tenant","group","member"]
  enforce TEXT NOT NULL,            -- JSON: ["edge","server","billing"]
  value_schema TEXT NOT NULL,       -- JSON schema 片段
  default_value TEXT,               -- JSON
  locked INTEGER NOT NULL DEFAULT 0 -- 1=治理类下限，租户只能收严
);

-- 合约模板（平台管理员维护）
CREATE TABLE contract_templates (
  id TEXT PRIMARY KEY,              -- 'trial', 'team', 'enterprise', 'compliance', 'developer'
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  document_json TEXT NOT NULL,      -- 完整条款取值，对应 ContractDocument v1
  status TEXT NOT NULL DEFAULT 'active',  -- 'active'|'deprecated'
  created_at TEXT NOT NULL
);
```

### tenant-<id>.sqlite 变更

```sql
-- contract 表：加 template_id, template_version, overrides_json
ALTER TABLE contract ADD COLUMN template_id TEXT;
ALTER TABLE contract ADD COLUMN template_version INTEGER;
ALTER TABLE contract ADD COLUMN overrides_json TEXT; -- [{clause_id, value}]
-- 现有热路径列（seat_limit 等）保留，从 document_json 派生后同事务写入

-- 自定义上游（企业版）
CREATE TABLE tenant_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  base_url TEXT NOT NULL,
  secret_ciphertext BLOB NOT NULL, -- 用 tenant_master_key 加密
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE tenant_models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  upstream_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  context_window INTEGER,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE tenant_rates (
  model_id TEXT NOT NULL,
  input_milli_per_mtok INTEGER NOT NULL,
  output_milli_per_mtok INTEGER NOT NULL,
  cache_read_milli_per_mtok INTEGER NOT NULL DEFAULT 0,
  cache_write_milli_per_mtok INTEGER NOT NULL DEFAULT 0,
  effective_from TEXT NOT NULL
);
```

迁移：现有 `contract` 表里的 JSON 列保持不变，新列可空，S3 前完成回填。

## 11. 执行点全图

| 条款 | 执行点 | 时机 | 冲刺 |
| --- | --- | --- | --- |
| 模型允许列表 | Server 派生 `config` + Edge 拒绝未授权 model | 配置下发 / 请求 | S0 ✅ |
| 模型参数上限（max_output_tokens 等） | Edge router 修改请求头 | 转发前 | S3 |
| 路由策略（单上游 / 主备） | Server 构建路由列表 + Edge 顺序重试 | 配置下发 / 请求 | P2 |
| 速率上限（per member / per key） | Edge 本地令牌桶 / 并发信号量 | 请求 | S3 |
| Agent 允许 + 版本钉 | Server 派生 `agents[]` + Edge 校验摘要 | 配置下发 / 启动 | S0 ✅ |
| 工具（MCP/Skill/Hook）允许 | Server 生成 Agent 配置 + Edge 注入 | 启动 | S3+ |
| 席位上限 | Server 邀请接受事务 | 邀请 | S1 ✅ |
| 月度橡皮配额 | Server 租约签发 + Edge 断流 | 续租 / 请求 | S1 ✅ |
| 单模型月预算 | Server 租约签发（模型维度的 budget_milli）| 续租 | S3 |
| 会话留存期 | Server 定时清理任务 | 夜间 | S3 |
| 会话导出/分享 | Server API 门禁（合约检查中间件）| 读取 | S3 |
| 可见性（summary/content）| Server API 门禁 | 读取 | S1 ✅ |
| 网络出口策略 | Edge 出口检查（白名单/仅内网） | 连接 | S3 |
| 自定义上游 | Server 合约校验 + 租户 Provider 路由 | 配置 | S3 |
| 折扣/费率覆盖 | Server 账单引擎（后处理，不影响实时 milli 计量）| 月结 | S4 |

执行点的设计原则：**热路径决策尽量在 Edge 本地完成**（不依赖 Server 实时查询），冷路径（开通、月结、审计）在 Server。Edge 执行依赖 `config` 下发，`config` 是权威快照，合约变更触发 `configPublisher.changed()`。

## 12. 待裁决事项

以下五点影响实现路径，需要在 S3 前对齐：

| 编号 | 问题 | 选项 A | 选项 B | 影响 |
| --- | --- | --- | --- | --- |
| D1 | 自定义上游密钥隔离级别 | 租户主键完全独立（平台不可解密） | 复用 platform master_key 派生 | A 合规性更好但 KMS 复杂度高 |
| D2 | 折扣/费率覆盖在哪层计算 | Edge milli 按折扣价实时计（影响租约预留精度）| Server 账单引擎后处理（Edge 按全价计）| B 实现简单，租约额度可能虚高但误差可控 |
| D3 | 工具（MCP/Skill）的审计粒度 | 只记"调用了什么工具" | 还记"工具执行了什么命令" | B 敏感信息处理策略需要先定 |
| D4 | 会话留存的可调性 | 模板固定下限，租户只能加严 | 租户可以在模板下限和上限之间自由调 | 合规版建议 A，其他模板建议 B |
| D5 | 多 Provider Key 的轮换/池化 | 一个 Provider 只支持一个 Key（当前） | 支持 Key 池（多个 Key 轮换或按权重分发）| 解决上游单 Key 速率瓶颈，P2 之后评估 |
