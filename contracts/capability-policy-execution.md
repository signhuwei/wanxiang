# 能力合约执行约定

本约定扩展 [能力合约 v2](capability-policy-v2.md)。金额的存储单位为千分之一块橡皮，人民币一元对应一块橡皮。所有版本引用都指向发布时的不可变版本。

## 数据结构

| 数据归属 | 对象与关联 | 生效语义 |
| --- | --- | --- |
| 平台 | 条目版本、模板版本、商业方案版本 | 签发时冻结条目、模板和方案引用。方案记录分段折扣、承诺用量、模型四类用价、单模型月预算、Tools 单价及月包。展示倍率由基础模型费率派生。 |
| 租户 | 签发版本、配置版本、组和成员有效投影 | 恢复基于配置历史版本生成新的配置版本；预览与发布按当前上级约束重新校验，审计保留来源版本。签发预览比较成员有效值，关联设备、目标平台及不可用原因。 |
| 设备执行策略 | 成员的有效条目投影 | 整数上限逐层取小；发行和出口授权取交集；功能开关逐层取与。未签发发行固定条目时自动选版，显式空集合禁止下载和启动。 |
| 租户上游 | 租户库中的上游记录绑定一个已授权平台模型、原生模型名、端点、协议、优先级、修订号和密文 | 开关和成员模型授权同时生效。沿用签约模型费率，端点优先级决定同一入口的候选顺序。密钥按租户隔离，管理读接口只返回是否已配置。 |
| Tools | 发布包记录类型、平台、架构、目标 Agent、入口和摘要 | Hook 只运行已授权、已校验的发行包。收费调用按实际发行及调用标识去重。 |
| 用量 | 租户内按月的模型预算、按请求预留、分期月包和租约消耗记录 | 月包及充值区分来源，优先消耗本期月包；折扣在服务端结算，按实际模型和调用归集。 |
| 会话 | 会话作者、结束时间、正文清理标记、会话分享与接收成员 | 留存条目约定天数下限，租户、组、个人可以延长。到期删除正文，保留用量和审计。导出和租户内定向分享均受作者有效条目控制。 |
| 桌面 Agent | 精确发行、设备、工作区、原生 SID、OneX 会话、采集游标 | 每个原生会话独立绑定、结算与断点续传。支持情况须由对应厂商发行的原生运行证据确定。 |

## 管理和执行协议

平台签发沿用 `POST /v1/platform/policy/contracts/:tenant_id/preview`。`impact` 返回 `member_count`、`device_count`，以及分别分页的 `members` 和 `devices`。成员明细按 `user_id` 排序，每项含 `user_id`、`name`、`changed_clauses`、`device_count`。未注册有效设备的受影响成员也会列出，设备数为 0。分页请求使用同一份签发草稿。成员页用 `member_cursor`，设备页用 `cursor`，两页共享 `limit`。每次仍校验平台身份和草稿的期望修订。源版本或时间戳本身不构成执行差异。

配置版本列表使用 `GET /v1/policy/configurations/:scope/:subject_id/history`。预览 `POST …/preview` 与发布 `PUT …/:subject_id` 均接受 `restore_revision` 或明确的模板与条目选择；两种输入互斥。请求携带当前平台和策略修订，发布带幂等键。

户主使用 `GET/POST /v1/policy/upstreams` 和 `PUT /v1/policy/upstreams/:id` 查询、新建、更新或停用自有上游。更新要求 `expected_revision`。发布后刷新设备投影。租户私有上游不进入其他租户的目录。

会话导出使用 `GET /v1/observe/sessions/:id/export`，授予和撤销分享使用 `POST /v1/observe/sessions/:id/shares`、`DELETE /v1/observe/sessions/:id/shares/:recipient`。接收人通过 `GET /v1/observe/shared` 查看分享，通过现有会话正文接口读取。每次读取重新验证当前成员、可见性和正文留存状态。

设备继续使用现有配置版本、应用回执和重连重放协议。执行规则按绑定名携带，模型候选包含实际 provider、模型名、费率和顺序。首次连接失败且请求尚未发送时可安全切换，流开始后保持同一目标。精确发行不满足设备系统或架构时返回不可用原因。

### 设备执行

Edge 在 hello 中声明 policy_runtime_v1。需要请求级约束、商业方案或 Hook 的配置使用 policy.abi=2。商业方案通过 policy.commerce_plan_id 对齐租约。请求级策略通过 policy.runtime 下发，使用绑定全名键 model.max_output_tokens、rate.member_rpm、rate.member_tpm、rate.member_concurrent、rate.key_concurrent、network.public、route.failover。整数上限为正数，缺省无限制。每台 Edge 的一分钟窗口按请求和估算输入加预留输出计数，并发占用持续到响应结束。请求未指定输出时，设备按已签输出上限或本次 TPM 剩余额度设置原生输出字段。network.public=false 只可直连回环或私网 IP，域名解析出的所有地址均须符合策略，连接使用通过检查的地址。

同一 model_id 和协议的候选按优先级数值升序下发。平台候选优先级为 100，与租户候选相同时平台优先；同优先级的租户候选按 ID 排序。每个候选持有独立的密钥信封；备用切换仅允许连接未建立的错误，沿用同一次请求的模型预留，记录实际 provider_id。access.releases、network.providers 在授权目录、分发路径和服务端候选筛选执行。Hook 发布沿用工具发行接口，kind=hook 首版支持 macOS 上 Claude Code 的 PostToolUse，入口来自不可变校验包。

成员与目标系统的预览使用 `GET /v1/policy/targets/:user_id?os=darwin&arch=arm64`，平台入口位于 `/v1/platform/policy/contracts/:tenant_id/targets`。设备详情返回相同的目标诊断及其最后一次应用回执。商业字段与结算规则见[商业计费协议](capability-commerce.md)。

## 功能与验收入口

| 项 | 功能 | 可复核的入口 |
| --- | --- | --- |
| 1 | 户主编辑配置时左侧保留当前值，右侧填写、预览和发布 | 租户 → 合约 → 合约条目 → 编辑配置 |
| 2 | 签发前列出受影响成员与设备及不可用原因，按成员和系统查看模型、费率和发行 | 平台 → 能力合约 → 平台合约 → 租户 → 签发记录 |
| 3 | 以历史配置预览并生成新版本，按当前签发边界校验 | 租户 → 合约 → 合约条目 → 配置版本 |
| 4 | 固定 Agent 发行，按系统、架构和制品身份限制下载与启动 | 条目 `access.releases`、设备下发和制品下载接口 |
| 5 | 发布、授权和运行工具 Hook | 能力管理 → Tools；macOS Claude Code 的 PostToolUse |
| 6 | 配置租户协议价、阶梯与承诺折扣，按版本结算 | 能力合约 → 商业计费；签发条目 `billing.plan` |
| 7 | 限制每次模型输出 token | 条目 `model.max_output_tokens`，Edge 实际转发请求 |
| 8 | 按优先级选择主备上游 | 租户自有上游的优先级、条目 `route.failover` |
| 9 | 限制成员 RPM、TPM、并发及单 Key 并发 | 条目 `rate.member_rpm`、`rate.member_tpm`、`rate.member_concurrent`、`rate.key_concurrent` |
| 10 | 各设备在单模型月预算内预留和结算 | 商业计费方案 → 单模型月预算；租约分配和续约 |
| 11 | 按会话作者的留存期限清理正文，保留费用与审计 | 条目 `session.retention_days`、桌面会话关闭及恢复事件、会话读取及周期清理 |
| 12 | 控制导出及租户内的定向分享和撤销 | 条目 `session.export`、`session.share`；租户 → 监察 |
| 13 | 按 Provider 和公网出口权限限制实际连接 | 条目 `network.providers`、`network.public`；Edge 路由 |
| 14 | 户主登记独立密钥、模型映射及优先级 | 租户 → 合约 → 自有上游；条目 `upstream.custom` |
| 15 | 以基准模型输出价计算五档倍率 | 能力合约 → 商业计费 → 模型档位 |
| 16 | 受管 MCP 和独立 HTTP 搜索按成功调用计费，可核对调用回执 | 能力管理 → Tools；商业计费方案 → 工具调用费；租户商业计费明细 |
| 17 | 月包按期发放、优先消费、到期与永久余额分别结算 | 商业计费方案 → 每月发放；租户 → 橡皮 |
| 18 | WorkBuddy 原厂 GUI 的多任务归属、采集和计费 | [WorkBuddy 适配规格](../docs/specs/agents/workbuddy.md)及精确发行资格 |
| 19 | DeepSeek Harness 原厂 GUI 的会话恢复、采集和计费 | [DeepSeek 适配规格](../docs/specs/agents/deepseek-desktop.md)及精确发行资格 |
