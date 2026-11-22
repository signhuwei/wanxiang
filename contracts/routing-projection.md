# 多渠道路由的设备目标与应用回执

本批从[已发布待签费率与设备暂存](routing-pricing-and-staging.md)继续。沿用设计评审稿的 `routing-data-contract.md`、`routing-http-contract.md` 和 `routing-edge-contract.md`。先在隔离用例里联通持久投影、设备应用和回执查询。新能力的正常握手和请求执行仍以回流及租约联验为启用条件。

## 数据与交易边界

| 数据 | 键和约束 |
| --- | --- |
| `routing_config_snapshots` | 租户库按 `(device_id,config_revision)` 唯一，沿用现有系统配置计数器，允许序号有间隔。保存 `projection_id,user_id,platform_revision,policy_revision,revocation_revision,payload_json,digest,source_token,created_at,valid_until`。内容无信封材料，可用已冻结的凭据版本重封。引用当前已签的 `rate_version_id` 和明确的 `binding_id,binding_revision,agent_release_id`，并携带精确型号池、部署版本。相同生成依据的重复作业复用已有投影。 |
| `routing_config_deliveries` | 外键对应快照键，记录 `targeted_at,sent_at?,applied_at?,rejected_at?,last_failure?,retry_count` 与关联 `projection_id`。持久目标随后才发送。重连可重放同目标。发布任务完成不等于设备成功应用。 |
| 映射与回执记录 | 系统发布任务持久记录 `(rollout_id,tenant_id,device_id)` 名册及精确的租户目标引用，允许目标尚未生成。设备回执以租户库 `(device_id,receipt_id)` 保存内容摘要及脱敏结果。设备已应用头沿用 `policy_device_applications` 的单调更新，另关联实际投影 ID。旧协议确认的新配置将其中投影 ID 置为 null。 |

投影消费现有租户签发与有效配置、具体设备、绑定及池的固定输入。固定池只解析所签版本；跟随池取活动版中满足同身份和授权边界的候选。设备和已签费率从当前认证成员、设备权限和签发定位。预览阶段的粗影响数与当前在线清单不能代替收件人名册。停发、受限制余额、撤销以及可核验的固定候选均按既有约束。对从未开启池的租户继续用现行生效配置。本批测试以明确授权的固定与跟随绑定及推理凭据版本输入；Agent 绑定目录和签发授权读写按已审接口接续。

跨系统库与租户库重试时，先核对系统作业所依池版本，再用租户内事务复核成员、设备、签发和 `source_token` 后持久化快照与发送记录。名册和快照写入分步失败后用稳定键恢复。跟随目标已被更新池取代时记 `superseded`，不把更新池结果归给旧作业。离线重封前复核原授权、期限与撤销。缺失精确凭据版本返回失败。

## 设备协议

1. 服务端测试会话选择 `route_pool.v1`，按同一设备持久目标构造完整 `config` 和信封，生产声明与选择不变。目标状态先落库，封装和发送失败按同身份重试。
2. Edge 暂存成功后，在一次本地提交里写入设备生效索引、通知去重及待发回执，再切换可执行的单份内存视图，最后发成功回执。本地暂存或失败不产生成功回执。配置域按服务、租户、成员及设备隔离；提交和发送前检查当前登录代次。退出或认证变化立即封闭旧投影的使用和发送。重启进入待同步态，须通过本会话认证获得可信服务端时间且拿到同投影合法重封，才重发已持久成功回执。若期间先合法应用了更高投影，未恢复的旧成功回执停止发送。明文密钥不落盘。
3. `config_applied` 保持 `{type,id,config_revision,policy_revision,projection_id,result,error?}`。`result=applied` 或 `rejected`。错误有稳定 `code` 和 `detail.reason`，文字脱敏。未协商出现新版字段，或已协商收到不完整新版内容，都拒绝该报文，不能降级为旧协议确认。服务端以认证设备、配置修订、投影 ID 和策略修订核对持久目标，提交后回普通 `ack{re:id,ok:true}`。只有该回包清除对应的 Edge 待发回执。未知或异设备目标、同标识异内容报冲突。相同内容复用确认，旧拒绝不能覆盖成功。回执本身不发放新租约，隔离测试会话的旧自动发租路径也须关闭。
4. 回执成功后，Edge 的模型、型号标签、变更通知读同一已应用视图；标签和费率按同一可信时点选择。待同步时保持执行门禁，避免回落至旧路由。相同通知按作用域和 `notice.id` 去重。本批先用原生 Responses 和已注册的兼容适配器校验。

## 管理端

- `GET /v1/platform/model-pool-rollouts/:rollout_id` 返回 `rollout_id,model_id,pool_revision,total,counts,actions`，`counts` 分别列 `pending,applied,rejected,offline,needs_upgrade,superseded`。精确目标有已持久成功回执时为 applied，否则按 superseded、rejected、已观测不支持、离线、等待的顺序折叠。发布任务记录自身状态另作为 `job_status` 返回。详细状态基于已登记的名册。
- `GET /v1/platform/model-pool-rollouts/:rollout_id/targets` 接受 `state,limit,cursor`，回 `{items,total,next_cursor,actions}`。行含 `tenant_id,user_id,device_id,target_config_revision,applied_config_revision,state,reason,last_seen_at,last_receipt_at,actions`。缺值为 null，`reason` 为稳定码。回执时间仅指本目标。分页总数是过滤后总数，游标绑定 rollout、筛选与操作者。页面使用当前池版本右栏和原有台账收窄，不暴露凭据字段。
- 既有商业方案表单用 `GET /v1/platform/models` 的 `current_source_rate_key` 选择当前可签版本，精确版本详情沿用倍率回读。手填完整四项仍可用。编辑或复制旧方案保留原费率引用和显式手调值。仅有显示倍率、无版本引用的型号不能作为来源选项。
- 平台签发预览与固定签发显示 `sales_rate_snapshots` 的四项售价及签约输入倍率。租户侧增加 `GET /v1/policy/signatures/:revision` 读取同租户历史售价，沿用租户计费详情的户主权限。列表在户主行上返回 `read_rates`，详情返回 `{revision,issued_at,sales_rate_snapshots,actions:["read"]}`；已签售价项保存 `rate_version_id,model_id,input_multiplier_basis,input_multiplier_ppm,valid_from,valid_until` 及四项费率。平台费率来源和商业摘要只在平台侧。历史无价格快照时展示空态。当前目标、实际应用、在途旧租约分别显示和验证。

## 联验

1. A/B 样例的固定 v6 目标只有 A，跟随 v7 有 A/B。把实际签发的 4× 费率和精确 Agent 绑定投影后，用合成设备密钥封装。
2. 验证投影持久后能在服务重启重封重发。未先收到合法 `applied` 时平台目标可见，应用字段保持原值。错投影、跨设备、迟到拒绝、同标识异内容均不推进应用头。
3. 验证 Edge 在暂存、切换之前崩溃、成功回执丢失、重启后重复接收以及同版不同配置上的行为。已成功应用的同一通知只出现一次。旧连接仍保持其原协议和租约行为。
