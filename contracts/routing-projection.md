# 多渠道路由的设备目标与应用回执

本批从[已发布待签费率与设备暂存](routing-pricing-and-staging.md)继续。沿用设计评审稿的 `routing-data-contract.md`、`routing-http-contract.md` 和 `routing-edge-contract.md`。先在隔离用例里联通持久投影、设备应用和回执查询。新能力的正常握手和请求执行仍以回流及租约联验为启用条件。

## 数据与交易边界

| 数据 | 键和约束 |
| --- | --- |
| `routing_config_snapshots` | 租户库按 `(device_id,config_revision)` 唯一，沿用现有系统配置计数器，允许序号有间隔。保存 `projection_id,user_id,platform_revision,policy_revision,revocation_revision,payload_json,digest,source_token,created_at,valid_until`。内容无信封材料，可用已冻结的凭据版本重封。引用当前已签的 `rate_version_id` 和明确的 `binding_id,binding_revision,agent_release_id`，并携带精确型号池、部署版本。相同生成依据的重复作业复用已有投影。 |
| `routing_config_deliveries` | 外键对应快照键，记录 `targeted_at,sent_at?,applied_at?,rejected_at?,last_failure?,retry_count` 与关联 `projection_id`。持久目标随后才发送。重连可重放同目标。发布任务完成不等于设备成功应用。 |
| 回执记录与应用头 | `(device_id,receipt_id)` 定位已验收回执并保存内容摘要。设备已应用头沿用 `policy_device_applications` 的单调更新，另关联实际投影 ID。较旧成功或拒绝不能覆盖新结果。旧协议已有的待下发和 ACK 行为保持原合同。 |

投影消费现有租户签发与有效配置、具体设备、绑定及池的固定输入。固定池只解析所签版本；跟随池取活动版中满足同身份和授权边界的候选。设备和已签费率不能从草稿或未应用的投影推断。停发、受限制余额、撤销以及可核验的固定候选均按既有约束。对从未开启池的租户继续用现行生效配置。在本批测试以共用样例的已授权固定与跟随绑定提供输入；Agent 绑定目录和签发授权读写按已审接口接续。

## 设备协议

1. 服务端测试会话选择 `route_pool.v1`，按同一设备持久目标构造完整 `config` 和信封，生产声明与选择不变。目标状态先落库，封装和发送失败按同身份重试。
2. Edge 暂存成功后，在一次本地提交里写入设备生效索引、通知去重及待发回执，再切换可执行的单份内存视图，最后发成功回执。本地暂存或失败不产生成功回执。未完成切换的重启进入待同步态，直到可信时间恢复且同投影合法重封，才可重发已持久的成功回执。明文密钥不落盘。
3. `config_applied` 保持 `{type,id,config_revision,policy_revision,projection_id,result,error?}`。`result=applied` 或 `rejected`。错误有稳定 `code` 和 `detail.reason`，文字脱敏。服务端以认证设备、配置修订、投影 ID 和策略修订核对已保存目标并提交后回普通 ACK。未知或异设备目标报冲突，同标识同内容可重放。较低版本不改变已应用头。回执本身不发放新租约。
4. 回执成功后，Edge 的模型、型号标签、变更通知读同一已应用视图；试算值、平台采购信息和期望目标不作为成员生效状态。相同通知按 `notice.id` 去重。本批先用原生 Responses 和已注册的兼容适配器校验。

## 管理端

- `GET /v1/platform/model-pool-rollouts/:rollout_id` 返回 `rollout_id,model_id,pool_revision,total,counts,actions`，`counts` 分别列 `pending,applied,rejected,offline,needs_upgrade`。避免把正在等待的旧设备列成已应用。发布任务记录自身状态另作为 `job_status` 返回。
- `GET /v1/platform/model-pool-rollouts/:rollout_id/targets` 接受 `state,limit,cursor`，回 `{items,total,next_cursor,actions}`。行含 `tenant_id,user_id,device_id,target_config_revision,applied_config_revision,state,reason,last_seen_at,last_receipt_at,actions`。缺值为 null。平台管理员读取，按 rollout、筛选与操作者绑定游标。页面使用当前池版本右栏和原有台账收窄，不暴露凭据字段。
- 既有商业方案表单可从签约型号的可签版本选择 `source_rate_key`，手填完整四项仍可用。签发预览与固定签发显示 `sales_rate_snapshots` 的四项售价及签约输入倍率。平台可查费率来源；租户看到本合约实际价格。当前目标、实际应用、在途旧租约分别显示和验证。

## 联验

1. A/B 样例的固定 v6 目标只有 A，跟随 v7 有 A/B。把实际签发的 4× 费率和精确 Agent 绑定投影后，用合成设备密钥封装。
2. 验证投影持久后能在服务重启重封重发。未先收到合法 `applied` 时平台目标可见，应用字段保持原值。错投影、跨设备、迟到拒绝、同标识异内容均不推进应用头。
3. 验证 Edge 在暂存、切换之前崩溃、成功回执丢失、重启后重复接收以及同版不同配置上的行为。已成功应用的同一通知只出现一次。旧连接仍保持其原协议和租约行为。
