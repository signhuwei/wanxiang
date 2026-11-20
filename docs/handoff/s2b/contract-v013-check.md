# 契约 v0.13（cfeb824）核对

对照 `review-plan.md` 第 0 节的 C1–C15 和 `quota-review.md` 的 D1–D6。只读，静态核对。

## 已堵住

- C1 / D1：`cutoff.settled_lease_id` 加上 `lease_request`，覆盖了续租回 cutoff、初始握手就是 cutoff、Edge 落盘前崩溃后重放（缓存的回复里带 `settled_lease_id`）三种情况。`disabled` 不带这个字段，保留了 v0.5 的结清路径。
- C3 / D6、C4 / D3、C5 / D2、C7：都已写明。D2 现在是 quota-api 的实现缺陷（`/balance` 要改成上海月份）。
- C6：`limited_by` 的平局规则（本人优先，其次最近的组）与现有实现一致：`quotaLevels` 先放本人、再由近到远放组，`Array.sort` 是稳定排序。
- C8–C10、C11–C15：已写明。

## 仍有遗漏

### V1（中）断流时丢弃“累计用量”会漏收快照之后的花费

v0.13 写的是：收到带 `settled_lease_id` 的 cutoff 时，“删除当前租约、累计用量和续租快照”。但 Edge 的累计用量 `used` 可能大于续租快照：

1. 快照发出之后、cutoff 到达之前结束的请求，花费已经加进 `used`（`lease.rs` 的 `release`）。
2. cutoff 中断的进行中流，在 cutoff 处理**之后**才释放，花费也加进 `used`。

Server 只按快照结清旧租约。如果 Edge 把 `used` 清零，这部分钱不会计入任何租约，租户不扣款；usage 里的 `cost_milli` 仍挂在旧 `lease_id` 下，`reconcileUsage` 会一直显示 pending。v0.5 收到新租约时的规则是“`used -= 快照`，快照之后的用量记到新租约”。断流时应该一样：保留 `used − 快照` 和之后才结束的流的花费，等 `lease_request` 拿到新租约后记到新租约上。

建议改成：删除当前租约和续租快照，`used` 减去快照值（不清零）；没有租约时结束的请求继续累加到 `used`，新租约到来时整体带入。

### V2（中）同一设备上 resume 原生会话的游标

每次受管启动都生成新的 UUID 作 `session_id`。Codex `resume <thread-id>` 和 Kimi `--session <id>` 会续写**同一个**原生文件。新启动的采集器如果从偏移 0 开始读，会把旧内容以新 `session_id` 重新上报一遍。规格里有“交接游标”的要求，契约没写，需要明确二选一：resume 时沿用旧的 OneX `session_id` 和游标；或者用新的 `session_id`，但从旧游标之后开始读。

### V3（低）多个原生会话的费用全部挂在第一个会话下

usage 的 `session_id` 固定用第一个，后续原生会话（UUID v5）在 `/observe/sessions` 里的 `cost_milli` 永远是 0，第一个会话的费用包含了它们的花费。如果接受这个结果，建议写进契约，并让监察页对这种会话说明“费用计入首个会话”。

### V4（低）Responses 预留 4096 输出 token 时的报错文案

Codex 不发 `max_output_tokens`。配额尾部或余额很小时，租约额度可能小于 4096 token 的预留，router 返回 `TooLarge`，文案是“请调小 max_tokens”（`router.rs:970-975`），Codex 用户没法照做。建议 Responses 入口用另一段文案，或者在 `TooLarge` 时按剩余额度缩小预留。

### V5（低）`/me.quota` 向普通成员暴露组合计（D4）

v0.13 定了 `limited_by` 的取法，但没有说普通成员能不能看到组合计（其中包含同事的用量），而 `/quota/usage?scope=group` 对普通成员返回 403。需要一句话确认。

### V6（低）D5 的 404/403 差别

契约没有提及。属于实现层面的问题，留给 quota-api 决定。
