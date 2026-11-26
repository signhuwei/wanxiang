# 能力合约 v2

本契约对应已确认的操作流程。平台从租户台账默认打开充值记录，可切换签发记录。选中某次签发后查看该版条目，并可基于它编制下一版。租户级配置与签约权益分离，组及成员有各自的配置模板和具体配置。

## 1. 数据结构

### 稳定标识和所有权

| 对象 | 主键及版本 | 关系 |
| --- | --- | --- |
| 条目定义 | 平台域 `(id, version)` | 版本一经发布即固定。已发布合约继续引用其签发版本 |
| 合约模板 | 平台域 `(id, version)` | 一组 `clause_ref + value`，每个条目 ID 在同版模板中唯一。每个引用指向具体的条目定义版本 |
| 组织配置模板 | 租户域 `(id, version)` | 作用域为 `group` 或 `member`。只可引用本租户合约中对该级开放的条目及其确切版本。组、成员可分别绑定一个模板 |
| 平台签发 | 租户域 `revision` | 固定引用、基准值、调整值和最终签发值，附签发人、原因和时间。每次签发新增修订 |
| 配置修订 | 租户域 `(scope, subject_id, revision)` | `scope` 为 `tenant`、`group` 或 `member`。按现有组织关系确定归属及祖先组，绑定固定模板版本并记录本对象选择 |
| 租户策略 | 租户域 `policy_revision` | 任何改变生效策略的成功发布递增。平台签发、租户配置、作用域配置、组织迁移均参与并发校验和来源追溯 |
| 充值凭证 | 租户域 `ledger_id` | 引用账本的一笔 `topup`，保存登记时的签发修订、操作人、备注和入账前后可用余额。金额以账本为准，归档旧合约时资金仍属于同一租户 |
| 设备快照 | 设备域 `config_revision` | 与业务修订独立的下发顺序，携带当前平台、租户及个人生效的来源标识。Server 归属检查后只给设备发送其最终运行快照 |

定义、模板和已签文档写入 UTC RFC 3339 时间。标识符遵循[契约通用约定](README.md)。历史签发以自己的条目值、来源及版本展示。以历史签发起草时，提交仍校验当前生效版本。

### 条目定义和受管能力

```json
{
  "id": "lease.budget",
  "version": 1,
  "title": "单设备租约额度",
  "description": "单次租约可用橡皮上限",
  "category": "limit",
  "schema": { "kind": "money_milli", "min": 0, "max": 100000 },
  "scopes": ["tenant"],
  "merge": "min",
  "default_value": 2500,
  "binding": { "adapter": "lease.budget", "abi": 1 }
}
```

基础类型为 `boolean`、`integer`、`money_milli`、`ratio_ppm`、`enum`、`resource_set` 和仅用于说明的 `text`。金额使用安全整数毫橡皮，1000 对应 1 块。倍率使用百万分比整数，900000 对应 0.9 倍。资源集合为去重的规范 ID 数组，schema 声明授权目录。枚举值及人类可读标签随定义版本固定。

合并算子只接受与该值类型匹配的 `fixed`、`min`、`max`、`intersection`、`and`。数值下限使用 `max`，签约席位等平台专属值使用 `fixed`。说明条目可无绑定。执行条目必须绑定受信任且已登记的适配器及 ABI，适配器决定允许类型、作用域、目标参数及唯一性，运行时拒绝未知绑定或不受支持版本。API 不接受可执行表达式、脚本或动态代码。新增模型、Agent 发行、条目组合、范围、单位阈值及模板版本通过发布数据；首次引入新的执行动作需要实现并注册适配器。

能力目录与条目库分别维护。Provider、模型、Agent 和 Tools 由能力管理登记并生成目录项。条目通过 ID 授权；停用目录项会限制实际执行，签发快照不随目录变化。Agent 和 Tools 执行必须匹配受支持的适配器及兼容设备目标。

### 签发条目与配置选择

```json
{
  "clause_ref": { "id": "lease.budget", "version": 1 },
  "template_ref": { "id": "team", "version": 3 },
  "base_value": 2500,
  "adjustment": 2125,
  "signed_value": 2125
}
```

直接从条目库引入的条目 `template_ref` 为 `null`，基准值由 Server 读取该定义版的默认值。归属于某模板的条目须存在于该模板版。引用、基准及签发值由 Server 核对或生成。草稿只传来源和选择值。无调整时省略 `adjustment`，不使用空值替代。数值 0、布尔 false、空白允许列表分别是明确值。

配置修订保留绑定模板的精确版本与本对象的显式选择。每条选择引用签约条目版本。本对象覆盖自己的配置模板值，最后仍须收窄于上级。删除选择恢复本对象模板或上级继承。聚合结果按平台签发、租户、根组至叶组、成员计算，记录每条值及当前限制来源。角色范围与组成员归属均由 Server 校验。与模板不匹配或超出上级的显式选择整体拒绝，不部分发布。上级主动收紧时保留历史修订，失效选择从运行快照剔除且不会在再次授权时自行恢复。没有签发的租户只可管理开通和签发，无受管运行授权。

### 发布与账本一致性

Server 在同一租户事务中复核权限、期望业务版本、目录与边界，写入签发或配置修订、审计记录、有效投影以及待下发标识。同步管理查询、租约和快照构建读取这一有效策略。组织成员的共享配额和活跃预留仍在账本及租约事务内核算。重复请求复用首次结果，失败不能产生半个签发或重复充值。

充值凭证以账本 `topup` 为本金流水，同时保存到账前后余额。平台手工登记，获准的租户角色可读取本租户同一张凭证。分页与权限由 Server 控制。代币价格与服务费率保持独立。充值不是模板变更，不新建签发修订。

### 余额路由与月度结算

`balance.warn` 与 `balance.restrict` 是租户级可下调的毫橡皮阈值，0 关闭对应阈值。`balance.fallback_models` 是可下调的模型集合。可用余额扣除活跃租约预留，达到阈值时触发提醒或进入限制。限制路由取该集合、当前成员授权和可运行目录的交集。已取得的预留仍可结算。已入账余额耗尽时停止服务，可用余额为零时禁止再发租约。充值、结算及预留变化可使租户跨档，产生设备可读通知与新配置序号，原签发及策略修订号保持原值。

`billing.discount` 是平台签发的固定结算比例，1000000 表示按全价结算，900000 表示按 0.9 倍结算。新租约在签发时冻结平台签发版本和比例。实时使用、租约和配额仍核算全额。按 Asia/Shanghai 月份归集已结算、实际扣减的租约金额，每个签发版本与比例组合分别将净应付额向上取整到毫橡皮。过量待核对、预留和释放流水不参与折扣。Server 在启动及每小时扫描待关账的已结束月份。每个租户每月只关账一次，正差额通过单笔 `adjust` 退回。平台和租户户主可查看月结明细。户主可从橡皮流水中带有 `read_discount` 动作的返还流水钻取查看。重试复用同一结果，原始扣费账目保留。

### 运行同步

Server 持有生效策略与发包目标，Edge 持有最后成功应用的运行快照。投影后只发设备所需的路由、发行、价格、限额、变更摘要和授权密钥信封。Edge 原子更新后才报告已应用，失序或重放不能回滚配置。显示层只读运行快照和变更摘要，不能据此授权。流量、旧租约结算及密钥处理继续遵守独立安全边界。

## 2. HTTP 协议

当前服务地址下的 `/v1/platform/policy` 使用平台全局会话。下文的 `P` 指这个前缀。`/v1/policy` 使用租户会话，下文记作 `T`。租户 ID 从会话确定，不接受客户端指定其他租户。列表遵循现有 `q,cursor,limit` 和 `{items,total,next_cursor,actions}`。记录和详情另有独立的 `actions`。Web UI 以这些动作为唯一按钮权限来源。

| 方法和路径 | 行为 |
| --- | --- |
| GET `P/definitions`、`P/templates` | 定义与平台模板版本台账 |
| GET `P/adapters` | 受信任的执行适配器清单。字段为 `id,abi,kind,merge,scopes,catalog?,min?,max?` |
| GET `P/definitions/:id/:version`、`P/templates/:id/:version` | 固定版本详情 |
| POST `P/definitions`、`P/templates` | 发布新版本。请求含 `id,expected_version`，0 表示首次发布 |
| GET `{P,T}/catalog/:catalog` | 目录候选项。普通查询分页，`ids` 为有限的逗号分隔 ID，供已选值回显。列表只返回该身份可见的目录数据 |
| GET `P/contracts`、`P/contracts/:tenant_id` | 以租户为对象的台账及详情。在未签发的租户里，两个业务修订均为 0 |
| GET `P/contracts/:tenant_id/signatures`、`P/contracts/:tenant_id/signatures/:revision` | 签发历史按修订倒序分页；以修订读取不可变表单 |
| GET `T/signatures` | 户主、租户管理员分页只读签发摘要，返回签发修订及元数据 |
| POST `P/contracts/:tenant_id/preview`、`P/contracts/:tenant_id/signatures` | 预览及签发使用同一份草稿。签发预览分别分页列出受影响成员和设备，成员页使用 `member_cursor`，设备页使用 `cursor`。签发重新执行全部校验 |
| GET/POST `P/contracts/:tenant_id/recharges` | 平台查看或登记充值，详情追加 `/:ledger_id` |
| GET `T/recharges`、`T/recharges/:ledger_id` | 户主、租户管理员查询本租户相同的充值凭证。自助写入未开放 |
| GET/POST `P/contracts/:tenant_id/discounts/:month` | 查询已结算月份，或由平台手动触发该月关账。月份格式 `YYYY-MM`，写入需要 `Idempotency-Key` |
| GET `T/discounts/:month` | 租户户主查询本租户月结结果 |
| GET/POST `T/configuration-templates` | 租户内组或个人配置模板版本台账和发布，详情追加 `/:id/:version` |
| GET `T/configurations/:scope` | 分组或成员的配置对象台账。作用域限制先于查询和分页，组管仅见管理范围，成员仅见本人 |
| GET/PUT `T/configurations/:scope/:subject_id` | 读取并替换本级配置。租户层的 `subject_id` 是当前 `tenant_id` |
| POST `T/configurations/:scope/:subject_id/preview` | 同保存请求，返回拟生效差异 |

### 写入

签发请求为 `{expected_policy_revision,expected_platform_revision,base_revision,entries,reason}`。`base_revision` 为所选历史签发或 `null`。草稿条目用 `{clause_ref,template_ref,adjustment?}`。在预览、签发及读取历史时，Server 附上精确定义、显示信息、只读的关联及适用动作。

配置请求为 `{expected_policy_revision,expected_platform_revision,template_ref,selections}`。模板绑定可为 `null`，选择项为 `{clause_ref,value}`。不传某条选择即恢复继承。组管只能管理所管组及其子组的授权范围内配置，成员仅可读自己的有效策略。户主操作租户级配置和模板。租户管理员、组管的具体写权限由服务端依据所属范围和对象角色计算。

条目库发布采用定义正文加 `expected_version`。模板发布为 `{id,expected_version,name,description,scope,entries:[{clause_ref,value}]}`，平台模板 `scope: "platform"`，组织模板 `"group"` 或 `"member"`。模板没有自定义脚本及运行入口。

充值登记请求为 `{amount_milli,note?}`。Server 在事务里确定关联签发和入账余额，返回 `{ledger_id,tenant_id,platform_revision,amount_milli,balance_before_milli,balance_after_milli,by,at,note,actions}`。平台及租户对同笔凭证的授权信息完全一致。各端金额展示使用块，且只接受精确到 0.001 块的输入。

发布和充值要求 `Idempotency-Key`。幂等键跨实体绑定操作者、路径和请求体，同键异体返回 409。普通写入遵循项目操作记录的保留期；充值的这次登记在资金记录生命周期内只记一次。预览不写入，也不作为授权凭据。409 返回当前修订，页面保留草稿，需重新预览后提交。422 的 `error.detail.fields` 提供字段路径，条目错误同时使用 `error.detail.clauses`（每项 `{clause_ref,code}`），身份越权适用现有 403/404。

### 响应公共字段

- `platform_revision`、`policy_revision` 对应当前业务版本。签发历史条目自身另有 `revision`、`reason`、`issued_by`、`issued_at` 和 `current`。
- 详情内的条目含 `definition` 及只读值和来源。组件按 `definition.schema.kind` 编辑，以 `display` 提供的资源标签或原 ID 回显固定历史。预览用相同结构返回拟生效值及差异。
- 平台租户详情含 `tenant_id,name` 和 `balance:{balance_milli,reserved_milli,month_used_milli}`。台账行含 `tenant_id,name,platform_revision,policy_revision,actions`。
- 动作通用名为 `read`、`create`、`publish`、`update`、`sign`、`topup`。平台租户详情 `sign` 对尚未签发的租户表示首次签发。历史版本上的 `sign` 表示以所读版本起草新签发。响应绝不授予对历史原件的编辑。
- 目录项至少包含 `{id,label}`。对历史中的已停用项可展示固定标签，但不会把它传为新的可选项。

## 3. Edge 设备协议

Edge 在当前 `hello` 声明 `capability_policy_v2: true` 表示支持策略 ABI 1。对已签发 v2 策略的租户，Server 只向声明支持的 Edge 发放有效的运行快照和新租约。旧租约可依现有逻辑提交结算，旧版数据不被推断为新签约授权。

`config.revision` 为下发正整数序号，路由、费率、Agent 发行继续用完整的原有数组字段。对应 `config.policy` 的结构如下。

```json
{
  "abi": 1,
  "tenant_id": "ten_example",
  "user_id": "usr_example",
  "device_id": "dev_example",
  "policy_revision": 8,
  "platform_revision": 3,
  "tenant_revision": 2,
  "groups": [{ "id": "grp_example", "revision": 1 }],
  "member": null,
  "display": [{ "id": "lease.budget", "title": "单设备租约额度", "kind": "money_milli", "value": 2125 }],
  "notices": [{
    "id": "pch_example",
    "kind": "policy_changed",
    "title": "能力配置已变更",
    "at": "2026-11-21T05:44:00Z",
    "policy_revision": 8
  }],
  "secrets": []
}
```

`tenant_revision` 和 `member` 无对应配置时为 `null`。`groups` 按根到叶排列，仅随设备快照携带最近 64 个确有配置的祖先组版本。有效值和配额始终按全部祖先组计算。提交更新后的目录状态或设备费率、发行、密钥可使 `config.revision` 前进而业务版本相同。`display` 是脱敏视图，不能用于执行判断。敏感 Provider 不可写入这组展示信息。必要密钥仍用现有的加密结构，每项含 `provider_id,key_id,nonce,ciphertext`，并与对应配置一同下发。运行所需内容及密钥先校验，随后原子替换。未知必要 ABI 或身份不一致时拒绝应用，不把失败报告作成功。

成功应用后，Edge 回传 `{type:"config_applied",id,config_revision,policy_revision}`。Server 只承认当前设备连接确实下发的目标，并保持应用序号单调。发送和连接在线均不产生应用证明。三端展示“签发已生效”和“设备已应用”应读取各自的来源。

户主和租户管理员读取 `GET /v1/devices/:id` 时，已签发的租户另有 `policy:{platform_revision,policy_revision,applied}`。`applied` 为空时尚未收到应用证明，非空时含 `config_revision,policy_revision,applied_at`。

Server 重连重建最新快照，随附该设备用户有权接收的最近策略变更摘要。消息按固定 ID 去重，同策略重复发包不重复提醒。本地对可用快照和消息列表分开处理，已有用量序号及租约协议独立。Edge 仅经现有本地桥提供脱敏政策、消息和 Agent 状态。进程实例、发行进度和用量数据的来源必须明确，网页不得接触下载凭据、原始路由或密钥。

配置中的 `policy.balance` 可含 `{mode,aliases}`。档位为 `normal`、`warn`、`restricted`、`stopped`。仅 `restricted` 的 `aliases` 可含 `{model,protocol}`，记录限制前对该成员实际可用的匹配式和协议。Edge 先按当前配置查找与请求入口兼容的路由。未命中时，只有请求符合原授权匹配式及协议才可转到与入口兼容的低成本路由。显式模型的启动校验和请求路由共用该规则。服务器只下发当前可用路由、费率及密钥，计费用实际选择的模型。`balance_warning`、`balance_restricted`、`balance_stopped` 和 `balance_restored` 使用既有通知结构。

通配路由还携带匹配该前缀的固定上游模型名，作为精确别名。WorkBuddy、Codex Desktop、Claude Desktop 可选与各自协议兼容的合约精确别名和通配路由发布的固定模型。Edge 启动和每次请求均按该范围校验。在受限余额档位，只有先前发布的精确名称可以转入获准的低成本模型。

`access.tools` 是可逐级缩小的 Tools 发布集合，目录标识为 `tools`。已签发且有效的发布还需匹配当前设备和获准 Agent。完整配置的 `tools` 字段为发行清单，每项为 `{id,name,version,kind,agents,os,arch,entrypoint,args,sha256,size,delivery?}`。通用 Skill 的 `os`、`arch` 与 `entrypoint` 为 `null`。包下载 `GET /v1/edge/tool-artifacts/:id` 使用设备凭据并逐次复核当前授权。Edge 先按清单校验内容，再在新启动 Agent 的独立配置范围内安装原生支持的工具。现有进程继续使用启动时的快照。

Tooth 保留发行的 `delivery` 元数据，取值为 `system`、`direct` 或 `selected`。启动使用签发及逐级收窄后的 `access.tools`，交付方式本身不授予权限。`GET /v1/platform/tool-targets` 返回每个 Agent 支持的工具种类和桌面平台，由平台页面用来约束发行表单。相同发行可以同时适用于 CLI 和 Desktop。

工具制品下载使用设备已配置的 OneX Server 原点。公网站点使用 HTTPS，受控 LAN 的 HTTP 仅接受私有 IP 字面地址并直连。下载禁止跨地址重定向，仍逐次复核设备授权及制品字节数、SHA-256 和包结构。

支持桌面 Tooth 的 Edge 在 `hello` 中声明 `tooth_v1: true` 以及 `desktop_tool_targets`，例如 `{"deepseek-desktop":["skill"]}`。Server 对每项工具分别取发行目标、生效 Agent、设备平台、已下发的受管发行及客户端声明的工具种类的交集。缺少声明的设备继续接收同一发行中匹配的 CLI 目标。空交集省略该项工具。客户端按本机工具适配清单校验，不支持的工具类型不能用于启动。

### 实现时的接口字段

服务端的适配器 ID 是 `seats.limit`、`access.agents`、`access.models`、`access.tools`、`lease.minutes`、`lease.budget`、`quota.distribution`、`quota.monthly`、`balance.warn`、`balance.restrict`、`balance.fallback_models`、`billing.discount` 与 `observation.{admin,group_admin}.{summary,content}`。每项使用 ABI 1。支持的目录名为 `agents`、`models`、`tools`。

- 定义详情返回定义正文及 `actions`。模板详情返回 `{id,version,name,description,scope,entries:[{clause_ref,value,definition}],actions}`。
- 平台签发详情和签发成功结果返回 `{tenant_id,revision,platform_revision,policy_revision,reason,issued_by,issued_at,current,entries,actions}`。`entries` 返回带 `definition` 的不可变签发条目。
- 配置详情及保存结果返回 `{scope,subject_id,revision,platform_revision,policy_revision,template_ref,selections,entries,actions}`。`entries` 展示 `{clause_ref,definition,parent_value,effective_value,source}`。这里 `source` 是 `{scope,subject_id,revision}`，平台来源的 scope 为 `platform`。
- 两种预览的 `previous_entries`、`entries` 对应当前与拟议的可展示条目，`platform_revision`、`policy_revision` 仍描述预览所基于的当前版本。配置预览额外返回其作用域和对象。
- 台账上新增按钮使用 `actions:["create"]`，点击记录使用 `read`。充值台账的新增使用 `topup`。定义和模板的已发布详情可持有 `publish`，其语义是发布下一版本。组管能编辑其管理范围内普通成员及组的开放条目。变更组/人的组织关系继续走现有组织 API。

## 4. 测试期切换

开通租户只建立身份和组织关系。数据库升级将已有的旧平铺合约标记为退役，保留旧行和账本供追溯。首次 v2 签发由平台明确核准，既有平铺值不会自动转换成授权。已退役的合约不能再为邀请、路由、发行下载或新租约授权，旧租约仍可结清。平台充值走带签发关联及持久幂等的 v2 接口。测试夹具保留独立的旧数据场景，用来验证已有账本和会话协议。

条目库初始化现有执行适配器的定义和「试用版」「团队版」模板。两份模板默认可用 Agent 和模型均为空，租约额度为 0。签发人需要核定实际授权。此初始化不写入任何租户签发或充值。

签发影响、配置恢复、商业计费、会话和设备执行协议见[能力合约执行约定](capability-policy-execution.md)。
