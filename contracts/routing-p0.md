# 同一签约型号的多渠道路由

本约定供首批实现和跨端联验。完整版需求见工作区设计稿 `routing-requirements.md`、`routing-data-contract.md`、`routing-http-contract.md`、`routing-edge-contract.md`。[三端共用样例](../tests/fixtures/routing/p0-ab.json)

## 编号与数据归属

- 签约型号以 `model_id` 标识。部署固定 Provider、账号和端点，版本记录原始型号和核验依据。首次实现将现有型号 ID 用作模型池外键。已有型号、合同和账本可追溯。
- 系统库保存 Provider、账号、端点、部署版本、证据、归纳审核、型号池版本、活动池指针和发布任务。租户库保存签发、组织策略、设备目标、回执、用量和结算。
- 池发布锁定 `(model_id,pool_revision)`、`(deployment_id,deployment_revision)`、得到确认的 `approved_match_id` 和证据。展示名称改动不改变签约型号身份。改变已签的实际型号身份须使用新型号 ID。
- 本地集成以系统 schema 15、租户 schema 19 为起点，迁移连续编号，凭据和人员数据使用合成样例。待其它开发线合并时，在第一次发布之前统一确定迁移顺序。

## HTTP 首批范围

平台会话使用现有全局 Bearer。所有路径以 `/v1/platform` 开头。新端点的分页采用 `{items,total,next_cursor,actions}`，先过滤可见范围，游标绑定当前调用者、资源、筛选和排序。按钮由同一对象的 `actions` 决定。

| 方法和路径 | 接口 |
| --- | --- |
| GET `/models` | 复用现有签约型号台账的 `id,display_name,status,revision,actions`，扩展 `current_pool_revision,channel_count`。无活动池用 0 表示。旧费率及编辑入口按原契约工作。 |
| GET `/providers/:provider_id/deployments` | 返回渠道卡片。每行包含 `id,revision,display_name,raw_model,account_id,endpoint_id,capabilities,status,archive_blockers,actions`。 |
| GET `/deployments?target_model_id=…` | 返回归纳候选。每行包含 `candidate_id,discovery_id,catalog_item_id,deployment_id,deployment_revision,provider_id,account_id,endpoint_id,raw_model,match,capabilities,health,quote_ref,actions`。未登记部署的候选允许 `deployment_id/deployment_revision=null`。未获准候选必须返回原因。可入池的候选额外返回 `approved_match_id,evidence_ids` 和 `select` 动作，供客户端原样组装预览请求。 |
| POST `/models/:model_id/pool/preview` | 请求 `expected_pool_revision,members,routing,reason`。返回 `model_id,expected_pool_revision,preview_basis,publishable,blocking,warnings,diff,impact,actions`。此调用只读。 |
| POST `/models/:model_id/pool/revisions` | 提交同一草稿、`preview_basis` 以及 `Idempotency-Key`。成功为 201，返回 `model_id,pool_revision,rollout_id,actions`。 |
| GET `/models/:model_id/pool/revisions[/:pool_revision]` | 读模型池版本历史与固定详情。版本详情含 `model_id,pool_revision,current,members,routing,reason,actions`。列表在具备起草权限时返回 `preview_pool`。 |

`members[]` 为 `{deployment_id,deployment_revision,priority,approved_match_id,evidence_ids}`。草稿 `routing` 为 `{strategy:"ordered",max_attempts,attempt_timeout_ms,total_timeout_ms}`。同一部署在单池中只允许一次，优先级数值小的先尝试。服务端存储并回读规范化的草稿。样例的 `preview_basis`、`rollout_id` 由真实服务生成，客户端按不透明值保留。

首批签约型号台账可复用现有不带 `provider_id` 筛选的 `GET /models`，活动池通过版本历史中的 `current` 判断。现存单渠道的执行路由及账务保留为测试基线。新池的目录、审核、渲染和发布先在隔离库验收，签发后的投影、供应商探测和外部配置不由首批活动池指针隐式触发。

### 渠道连接与拉取、型号身份和审核

- `GET /providers/:provider_id/channel` 返回 `provider_id,revision,accounts,latest_probe,latest_discovery,latest_catalog,actions`。Provider 配置为其默认渠道提供稳定账号和端点，切换地址、协议、认证或密钥时新增端点修订。跨源或切换认证协议需要显式保存适用的密钥，连接和目录作业会在凭据作用域不匹配时返回 `credential_scope_changed`。账号可用 `account_id,funding_id` 查阅独立的渠道账本。
- `POST /providers/:provider_id/probes` 接受 `{kind:"connectivity",revision}`，`POST /providers/:provider_id/discoveries` 接受 `{revision}`。两个操作均需幂等键，使用已登记的端点执行只读模型目录请求。返回 `202` 及已记录的 `succeeded`、`partial` 或 `failed` 结果。`GET /probe-jobs/:job_id` 回读结果，`GET /probe-jobs/:job_id/results` 按 `q,limit,cursor` 读取原始型号及目录声明。拉取处理上游分页，异常或截断显示原因，失败和部分结果保留此前的完整目录。请求和结果均保持推理密钥私密，连通测试不生成模型输出。
- `GET/POST /models/:model_id/identity` 读取或创建初始逻辑身份，提交 `revision,maker_id,model_family,model_variant,identity_mode,model_snapshot?,capability_floor`。`POST /models/:model_id/pool/candidates/review` 接受 `{expected_identity_revision,reason,decisions:[{discovery_id,catalog_item_id,decision,capabilities}]}`，按平台管理员显式确认记录 `manual_review` 证据。固定快照的目录声明必须相符，渠道声明本身不会使候选合格。有效候选进入现有预览和池发布。

同一活动端点与部署的新增能力通过候选审核证据登记。只有新池版本选择该候选及其证据并发布后，新增能力才会下发。部署修订和采购报价可以沿用，既有池版本仍对应各自的审核证据。

`blocking[]` 和 `warnings[]` 的项目为 `{code,message,deployment_id?,field?}`。`impact` 提供 `tenant_count,device_count`。展示需区分活动池与已应用设备。后续 WebUI 的充值与签发按已确认设计在右栏上下排列。`desktop-ui/` 和生效模型标签由 Edge 组维护。

`preview_basis` 绑定调用者、操作、型号、规范化草稿、活动池修订及影响资格的已审核依赖。发布在一个系统库事务中重新核验授权，查同键重放，再核验期望版本、预览根据及候选资格。成功原子保存池版本、活动头、审计和发布任务。同键同体复用原成功响应，同键异体返回 409 `idempotency_mismatch`，池修订过时返回 `revision_changed`，部署、审核或证据改变导致预览过时返回 `preview_stale`。若某类权限或写入还未提供，对应 `actions` 保持缺省。计划任务与设备应用是两项状态。

## Edge 首批范围

- 使用 `hello.capabilities` 和 `welcome.capabilities` 中的 `route_pool.v1`。选中的连接要求 `policy.abi=2` 和 `policy_runtime_v1`。首批完成结构、确定性候选过滤和测试。支持所需凭据信封、原子应用与连续回执前，客户端不声明池能力，服务端不选中。
- `config` 同帧携带费率、部署、池、绑定和推理信封。`(device_id,config_revision,projection_id)` 确定一次下发。`config_applied` 记录 `applied` 或带稳定原因的 `rejected`。不同有效内容同 revision 冲突，较低 revision 不能改变已应用状态。
- 只有精确发行和入口协议匹配的绑定参与选路。别名优先级为精确、最长前缀、全局通配。已选绑定缺合格部署时返回原因。候选先筛权限、协议、功能、撤销和有效期，再按 priority 升序、验证过的原生优先、deployment_id 字典序。参考样例 A/B，B 缺工具能力时不发工具请求。
- `credential_ref` 使用 `credential_id` 与 `credential_version`，信封的 HKDF info 与紧凑 JSON AAD 见设备设计。管理凭据、采购值和原始余额留在 Server。
- 下一批接入传输、租约及实际回流。请求只在明确未写到上游且未向 Agent 交付语义输出时试同型号备路。每次逻辑请求固定一份费率、签发和租约，尝试编号单调，启用前必须做到连续 `seq` 后确认、同身份同内容幂等、同键异内容拒绝。
- 原生 Responses 是首条联合运行路径。续租失联、崩溃和用量未知的请求仍挂原租约的可核对预留，确认有用量后按原签发结算。向 Agent 或设备提供的型号、费率、路由和回执必须来自同一应用快照。

### 连接与回执的实现口径

1. 对现有合法设备先回 `welcome`。目标要求新协议但设备未协商时，再返回 `unsupported_capability` 和租约停供。已协商的连接必须接收完整 `route_pool`，缺失时拒绝该配置。旧协议保持现有握手和回执。
2. 新配置以 `config_applied` 表示应用结果。相同有效投影允许重封和重发，同 revision 异投影用 `conflict`。较低 revision 返回 `rejected`，`error.code="conflict"`、`error.detail.reason="stale_revision"`。撤销修订倒退时返回 `invalid_config` 和 `revocation_regressed`。重连身份以 Server 持久化记录和投影 ID 为准。
3. HTTP 草稿中的尝试时限同名进入 `route_pool.pools[]`。授权从 `bindings[].aliases` 解析，`routes[].model` 不扩大权限。空绑定是无授权，未被任何绑定引用的可执行路由拒绝。首批能力词为 `text`、`stream`、`function_tools`、`images`、`reasoning`、`json_schema`。调用需要的能力以入口实际请求得出。进入低余额降档只使用新绑定中的已签替代目标。
4. 所有尝试都能证明未写出时，Server 从 `not_sent` 导出零费用，设备无需添加用量行。可能已执行且完全未知的用量进入待核对。实际产生费用时，步骤、尝试终态和待补传用量必须能按原租约原子落盘或可靠恢复，Server 以历史快照核验归属。跨月或续租时保持同一冻结费率，重复结清不得动账。未完成这些约束不在实际连接启用新能力。

兼容 `openai_chat` 或 `anthropic` 的单条部署可带 [`input_capabilities`](edge-ws.md#server--edge)。它来自该部署修订的有效图片输入证据。附件请求须选用支持对应输入的合格部署。

平台管理员可在已拉取的渠道目录中，用 `POST /v1/platform/probe-jobs/:job_id/model-tests` 对精确渠道型号执行 `input_kind: "image"` 实测。服务端发送一张内置合成图，只在上游返回图中的字符并能核对实际用量时记录通过。沿用管理员限额、幂等键和对账流程。实测记录可用作渠道审核依据，模型池发布仍走预览和修订校验。

## 联验断言

1. `mdl_m` 从池第 6 版发布到第 7 版。A 为 `dep_a@3`，B 为 `dep_b@2`。发布后的活动池回读包含两者，未获批准的量化变体有原因。采用跟随池的签发允许 A/B，固定第 6 版的对照只允许 A。
2. A 普通输入 ¥2／百万 Token，B 为 US$0.40／百万 Token，USD 到 CNY 的有理汇率为 15/2。建议 3×，签发手调 4×，即 4,000 毫橡皮／百万普通输入 Token。输出费率为 12,000 毫橡皮／百万 Token。
3. 在按样例应用配置 91 后，A 建连失败且未写出，B 完成 10,000 输入和 2,000 输出 Token。产生 1 次逻辑请求、2 次尝试、1 条实际销售用量。租约扣 64 毫橡皮。B 输出采购值为 US$4／3,000,000 Token，按同一汇率实际采购 50,000 微元人民币。重放结算结果和累计 ACK。
4. 畸形候选、过期资格、提交后断流、设备回执乱序、同键异内容和分权读取均以真实入口验证。共享示例中的凭据为占位值，联验用测试设备密钥封装有效信封。
