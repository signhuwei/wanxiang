# 已应用投影与租约

隔离联验与生产试运行共用 `route_pool.v1` 的投影和租约关联。生产试运行通过 `route_pool.exec.v1` 额外协商逐请求计费，启用范围见[正式运行入口](routing-one-chain.md#正式运行入口)。其余设备沿用 [Edge WebSocket 协议](edge-ws.md) 的原租约路径。仅协商投影且关闭租约门禁时返回 `forbidden/route_pool_lease_pending`。

## 数据与事务

- 租户库 `022` 新增不可变 `routing_lease_projections(lease_id, device_id, config_revision, projection_id)`。`lease_id` 为主键。`(lease_id,device_id)` 引用 `leases(id,device_id)`（增加唯一索引），`(device_id,config_revision,projection_id)` 引用 `routing_config_snapshots`。由快照取得签发、撤销及有效期，由冻结的租约和签发条款取得计费信息，避免另存可分歧的版本字段。
- 沿用 `lease_operations(device_id,op_id)`。增加 `mode`，值为 `legacy`、`route_pool`、`route_pool_release_only`，现有记录默认为 `legacy`。隔离续租比较 `lease_id`、`used_milli`、规范化的 `model_used_milli` 和 `mode`。结清事实与首次裁决由同一操作记录保存，回复可对后续租约重新校验。
- 认证设备、当前有效授权、已应用头校验，以及租约、预留、投影关联和操作记录按租户事务提交。缺投影关联的历史租约仍用其原条款结清，隔离连接不能拿它作为路由执行授权。

## 首领与重申

`hello` 和 `config_applied` 都不推送租约。Edge 在当前认证代次取得可信时间与合法投影，且当前视图的 `applied` 回执已获得匹配的成功 ACK 后，发送 `lease_request{id,op_id}`。拒绝回执的成功 ACK 只确认收到拒绝。重连时允许使用本地持久的成功确认，先等同投影合法重封。

Server 按本认证租户、成员及设备查 `policy_device_applications` 的精确头，要求对应本设备的持久快照和已确认的 `applied` 回执。发新租约时检查当前签发、收费方案、撤销修订和 `valid_until > now`，并验证当前有效授权仍覆盖这份投影的模型、Agent 绑定及发行、渠道和凭据。组或个人收紧权限同样生效。纯活动池版本更新可以沿用仍获授权的已应用快照，未应用的目标没有发租效力。

活跃租约可以重申时返回原租约及不可变关联。过期、无投影关联、签发或收费方案变化、或者投影失去授权的活跃租约应先结清，返回 `ack{re,ok:false,error:{code:"forbidden",detail:{reason:"lease_settlement_required",lease_id}}}`。没有活跃租约时，门禁依次使用 `projection_not_applied`、`projection_signature_stale`、`projection_plan_changed`、`projection_revoked`、`projection_expired`、`projection_authorization_changed`。设备不可用及其余余额／配额断流沿用原判定。门禁拒绝不写预留。

发租沿用 `lease{id,re,lease_id,expires_at,budget_milli,model_budgets?,commerce_plan_id?,seq}`，增加必需的 `signature_id,config_revision,projection_id`。`re` 指向本次请求的 `id`。租约有效期不得超过所关联投影的有效期。首次接受一份租约时，签发、方案、修订与投影 ID 必须和当前已确认应用视图精确匹配。已经接纳并持久化的租约可在同签发、同方案的纯换池后继续使用，仍校验原租约身份、有效期及授权边界。旧租约下的在途请求保留请求开始时的视图和冻结费率。

## 续租与结清

- `lease_renew{id,op_id,lease_id,used_milli,model_used_milli?,release_only?,usage_through_seq?}`。逐请求计费会话使用 `usage_through_seq` 引用已累计确认的同设备用量。`op_id`、旧租约、累计用量、分模型快照和游标在发送前持久化，同一操作重发沿用这些值。用量按原租约的计费和额度结清，同一操作只能结清一次。在途或用量不明的请求保留在原租约。
- 普通续租先结清，再按首领规则决定是否发后继租约。成功的后继 `lease` 同时带 `settled_lease_id`。有结清且未发可用后继时返回 `cutoff{id,re,reason,settled_lease_id,detail?:{reason,lease_id?}}`。租约门禁原因使用 `reason:"contract"`，现有余额／配额原因保留。未完成结清的回复没有 `settled_lease_id`。Edge 只按当前在途请求的 `re` 和匹配的旧租约 ID 移除结清记录，不移除后来接受的租约。
- 同 `op_id` 异内容返回 `conflict`。重放已结清的操作不得再次扣费、预留或发租。缓存的后继租约仍有效且授权允许时才重申原租约；已失效时回 `cutoff`，保留原 `settled_lease_id`，`detail.reason="successor_lease_unavailable"`，若仍有待结清后继则附 `detail.lease_id`。后继不可用不改变旧租约已经结清的事实。
- `release_only:true` 仅用于 Edge 在当前认证代次明确拒用、且持久确认从未接纳或放行过请求的租约。持久化拒用标记、`op_id`、`used_milli:0` 以及 `model_budgets` 中每个已分配型号的零用量。服务端校验旧租约属于本设备、已有隔离投影关联并验证零用量明细。结清释放预留后回 `cutoff{reason:"contract",settled_lease_id,detail:{reason:"lease_released"}}`，本操作不发后继。已经接受或使用情况不明的租约走常规结清流程。Edge 对不匹配的发租响应上报 `lease_projection_mismatch`；失败 ACK 本身不会结清。

## 联验

1. 无匹配应用、被拒绝的回执、异设备、成员授权收紧、签发／方案变更、撤销和过期均不能新增预留。合法应用不主动发租，随后首领精确绑定应用头。
2. 纯换池时既有租约的计费身份稳定；新发租约使用当时仍获授权的应用头。迟到 ACK、重启后的合法重封和失效的缓存发租回复分别验收。
3. 旧租约按原价原额度结清且可重放。后继失效时，重放仍确认旧租约已结清且不会扣第二次。拒用租约逐型号报零，只释放预留；未知用量仍留在原租约。
4. 测试开关关闭时保留 `route_pool_lease_pending`，旧连接的发租、续租与切断逐帧回归。逐请求计费会话的已确认用量、续租游标和账本分别验证。
