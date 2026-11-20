# 配额 Server 验收（S2B-R1，main 68132c7）

验收对象：`c7544b5 feat(server): enforce monthly member and group quotas on lease issue`，合并为 `68132c7`。只读，未改产品代码。

## 跑过的测试

| 命令 | 结果 |
| --- | --- |
| `bun --no-env-file test server/test` | 55 通过、1 跳过、0 失败 |
| `bun --no-env-file test coord/reports/s2/quota-review.test.ts --rerun-each 3` | 17 条 × 3 = 51 通过、0 失败 |

`quota-review.test.ts` 是我的反例草稿，直接引用 worktree 里的 Server 源码，在临时目录起真实 Server，用多条 WS 连接模拟设备。标 `DEFECT` 的用例断言的是**实际行为**，用来固定缺陷现场。

## 结论

签发、续租时的配额裁决本身是对的：多级组、祖先组、同人多设备并发、同组多人并发、上海月份边界（精确到毫秒）、上月签发仍 active 的预留、调低配额、op_id 重放、余额与配额同时触发、overage_pending 和 release 不计入，数字都和计划一致。

阻塞问题是 **C1：配额 cutoff 之后 Edge 恢复不了**。这条不在 quota-api 的写入范围内，需要契约裁决。

## 缺陷与发现

### D1（阻塞，契约 C1）调高配额或跨月后，按 Edge 实际的重连方式恢复不了

用例：`DEFECT C1: raising the quota ...`、`DEFECT C1: a new month ...`。

A 配额 3000，续租到 `cutoff{quota}` 之后把配额调到 100,000。Edge 重连时 hello 带旧 `lease_id` 并重放同一 `op_id`（`edge/onexd/src/lease.rs:489-500,649`）：

- 重放 `op-2` → 缓存的 `cutoff{quota}`（`billing.ts` 的 `lease_operations` 缓存）。
- 换 `op-3` → `ack{ok:false, conflict}`（旧租约已 settled）。
- 整个连接上没有收到 `lease`。
- 只有不带 `lease_id` 的 hello（等于删掉本地 `lease.json`）才拿到 2000 的新租约。

跨月的结果相同。quota-api 的测试 `a new calendar month resets quota usage` 能通过，是因为它重连时 hello **不带** `lease_id`，onexd 不会这样做。契约 v0.12 写的“配额调高或进入新月份后，Edge 下一次续租即可恢复”目前做不到。`balance` cutoff 后充值也有同样的问题，S1 就存在。

### D2（中，契约 C5）`/balance.month_used_milli` 仍按 UTC 月初

用例：`DEFECT C5`。上海时间 11 月 1 日 01:00 结算 1500：`/members` 和 `/quota/usage` 计入 11 月；到 UTC 也进入 11 月之后，`/balance.month_used_milli` 是 0（这 1500 被算进 10 月）。`monthBounds` 已经移到 `credentials.ts` 共用，`balance()`（`billing.ts:19-27`）没有改用它。同一个管理端里“本月消耗”和“本月已用”会对不上，每月 1 日上海 00:00–08:00 的消费会算错月份。

### D3（契约 C4，需裁决）换组会把本月全部用量带到新组

用例：`C4 moving a member ...`。A 在 G1 花了 4000（另有 2000 预留）后改到 G2（配额 5000）：G1 的已用立刻变成 0；G2 的已用变成 settle 4000 + 预留 4000，剩余 −3000。同组的 B 下一次续租就因为 A 在 G1 花的钱拿到 `cutoff{quota}`。实现和契约字面一致（按当前成员算），但管理员调组的后果可能出乎意料，要在契约里写明，或者给 ledger 记 group_id。

### D4（契约 C6，需裁决）`/me.quota` 向普通成员暴露组合计

用例：`/me.quota shows a plain member ...`。A 自己没花钱，组配额更紧时，`/me.quota` 返回 `{quota_milli: 3000, month_used_milli: 3000, remaining_milli: 0, limited_by: "group:<G>"}`，其中 3000 是同事 B 的用量和预留。普通成员通过 `/quota/usage?scope=group` 查组会得到 403，通过 `/me` 却能看到组合计。这是用于提示的合理设计，但和 `/quota/usage` 的权限不一致，需要契约确认可以这样。

### D5（低）`/quota/usage` 先判存在再判权限

用例：`/quota/usage lets a member ... probe`。普通成员查不存在的 id 得到 404，查存在的他人得到 403，可以借此判断某个 user_id 或 group_id 是否存在。id 是 ULID，难以枚举，影响小。建议权限不足时统一返回 403 或 404。

### D6（低）调低配额后的超出不止一个租约

用例：`Q11`。两台设备各持 2000 时把配额调到 1000，两次续租都结清 2000，`remaining_milli = −3000`。http-api 的补充写的是“可为负……最多一个租约”，实际上界是该成员（对组来说是全组）所有 active 租约之和。实现没问题，契约描述要改（契约 C3）。

## 已通过的边界（数字见草稿）

- Q2 多级组：Root 6000 > Mid null > Leaf 4000。A（Leaf）、B（Mid）交替续租，租约依次为 2000、2000、2000、1500，之后都是 `cutoff{quota}`。最终 Leaf 4000、Mid 6000、Root 6000，settle 合计 6000、release 1500，`/groups.month_used_milli` 一致，A 的 `limited_by = group:Leaf`。
- Q6/Q7 并发：组配额 3000，三台设备（A 两台、B 一台）同时握手，拿到 2000 和 1000，第三台 `cutoff{quota}`；两份租约同时续租都结清，组合计 3000。
- Q8 月切换：15:59:59.999Z 仍 `cutoff`，16:00:00.000Z 新握手得到 2000。
- Q9：上海 1 日 01:00 的 settle 计入新月份。
- Q10：上月签发、本月仍 active 的 2000 计入本月预留；结清 1500 计入本月。
- Q11 调低配额：旧租约按实报结清，租户扣 4000，`remaining_milli = −3000`。
- Q14 重放：调高配额之后重放同一 op_id，返回第一次的结果；settle 只有 1 笔；换 op_id 返回 `conflict`。
- Q16–Q19 优先级：只有配额 → `quota`；余额与配额同时 → `balance`；停用设备在 hello 阶段被关闭。
- Q20–Q22：实报 2600（租约 2000）时 overage 600 不计入；release 不计入；累计 overage 1400 后，剩余 700 签成 700 的租约，最终 used 5000。
- Q23：过期未回连的租约继续占配额。
- Q29：`quota_milli` 为 −1、1.5、`"100"`、超过安全整数都返回 422。

## 复验：C1 的 Server 一半（main 9ea17be，quota-api 83bd315）

| 命令 | 结果 |
| --- | --- |
| `bun --no-env-file test server/test` | 67 通过、1 跳过、0 失败 |
| `bun --no-env-file test coord/reports/s2/quota-review.test.ts --rerun-each 3` | 21 条 × 3 = 63 通过、0 失败 |

已通过：

- 续租回 `cutoff{quota}`、`cutoff{balance}`、`cutoff{contract}` 都带 `settled_lease_id`，值为刚结清的租约。
- 带旧 `lease_id` 回连、重放同一 `op_id`：回包与第一次完全相同（含 `settled_lease_id`），不另签租约。
- `lease_request` 的三个分支：
  - 停用 → `cutoff{disabled}`，不带 `settled_lease_id`。
  - 已有 active 租约 → 回同一份租约；同一 `op_id` 重发或换 `op_id` 都一样；只有 1 份 active，不写 `lease_operations`。
  - 按签发规则裁决：配额未变 → `cutoff{quota}`（不带 `settled_lease_id`）；调高配额 → 2000 的租约，seq 为 3；跨上海月份 → 新租约；余额耗尽后充值 → 50 的租约。
- 停用时的续租在结清前判定：回 `cutoff{disabled}`，不带 `settled_lease_id`，租约保持 active。
- 优先级：合约额度为 0 且配额为 0 → `contract`；余额与配额同时 → `balance`。
- `/balance.month_used_milli`：上海 11 月 1 日 01:00 的结算计入 11 月（D2 已修）。

### D7（中，契约遗漏）主动推送的 cutoff 之后如果没有花费，Edge 恢复不了

用例：`GAP: after a pushed contract cutoff ...`。

Server 主动推送的 `cutoff{contract}` 或 `cutoff{disabled}` 不带 `settled_lease_id`，按 v0.13，Edge 保留租约，“恢复后重放续租结清”。但：

- Edge 只在 `used_milli > 0` 时才发这次最终续租（`lease.rs` 的 `renew_due`：处于 cutoff 时要求 `inflight.is_empty() && used_milli > 0`）。
- `lease_request` 只在**没有租约**时发。
- hello 带着 `lease_id`，Server 不推初始租约（`edge.ts:130`）；合约恢复或成员重新启用时，Server 只推 config。

所以合约额度被改为 0 又改回来、或者成员被停用又重新启用，只要这台设备在 cutoff 时还没花钱，就会一直停在 cutoff。测试里只有手动发 `lease_request` 才拿回原租约。`lease.rs:1129` 的“重发同一份租约解除 cutoff”这条路径，在真实 Server 上不会被触发。

建议在契约里补一句：处于 cutoff 但仍持有租约的 Edge，如果 `used_milli = 0`，也按同样的节奏发 `lease_request`（Server 已有“已有 active 租约直接回该租约”的分支，Edge 收到同一份租约后按 `grant` 的重申分支解除 cutoff）。也可以改成 `used_milli = 0` 时发一次 `lease_renew{used_milli:0}`，但那样会结清租约，再签新的。前者改动更小。

## 没有覆盖

- Edge 侧 `quota_exhausted` 的表现（Q30、契约 C2）要等 router 和 Codex、Kimi 入口交付后再验。
- `/members` 每行查两次库（N+1，每页最多 200 行）。目前没有性能要求，不算缺陷。
