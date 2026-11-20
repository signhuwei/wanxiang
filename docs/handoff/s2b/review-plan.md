# S2 第二批独立验收计划（S2B-R1）

验收者：s2b-review。基线 `d514d95`（契约 v0.12）。只读，本文只基于静态阅读和基线测试（`bun --no-env-file test server/test tests/e2e/fake-upstream`：54 通过、1 跳过、0 失败）。

## 0. 契约 v0.12 疑点（先裁决）

按影响排序。前两条会让验收标准本身无法达成。

### C1 配额或余额 cutoff 之后，Edge 无法“下一次续租即恢复”（阻塞）

契约 `data-model.md` 配额一节写“配额调高或进入新月份后，Edge 下一次续租即可恢复”。按现有协议和代码，这条路径不存在：

1. Edge 发 `lease_renew{op_id:X}`，Server 结清旧租约，配额不够，回 `cutoff{quota}`，并把这个结果缓存在 `lease_operations`（`server/src/billing.ts:96-103`）。
2. Edge 收到 cutoff 不清续租快照（`edge/onexd/src/lease.rs:489-500`，`ws.rs:353-358` 不看 `re`），重连后原样重放 `op_id:X`（`lease.rs:649-650`）。
3. Server 对同一 `op_id` 返回缓存的 cutoff（`billing.ts:86-89`），不重新裁决。换新 `op_id` 会因旧租约已 settled 返回 `conflict`（`billing.ts:92`）。
4. `hello` 带着旧 `lease_id`，Server 不发初始租约（`server/src/edge.ts:130`）。

结论：Edge 会一直停在 cutoff，配额调高、跨月、甚至充值余额都恢复不了，只能删本地 `lease.json`。这个问题 S1 的 `balance` cutoff 就有，v0.12 的“恢复”承诺把它变成了验收项。`lease.rs:18` 的注释说“回应续租的 cutoff 说明旧租约已结算，丢弃”，和实际代码不一致。

需要契约给出恢复路径，例如：回应续租的 cutoff 让 Edge 丢弃旧租约和快照，之后以“无租约”状态申请（`hello` 不带 `lease_id`，或新增 `lease_request`）；Server 何时重新裁决（每次重连、定时、还是收到某个消息）也要写明。这同时涉及 Server 和 Edge 两条线，还没有指派给谁。

### C2 剩余配额很小时，员工收到的是 `balance_exhausted`，不是 `quota_exhausted`

签发额度取 `min(..., 本人剩余, 每级组剩余)`。剩余只有几毫橡皮时，租约额度也只有这么多。Edge 放行时如果单次预留大于租约额度，返回 `TooLarge`，错误码是 `balance_exhausted`（`router.rs:970-975`）；额度占满时返回 `Exhausted`，也是 `balance_exhausted`（`router.rs:964-969`）。员工要等下一次续租拿到 `cutoff{quota}` 才看到配额提示。按 C1，这次续租之后 Edge 就恢复不了了。

sprint-2 的验收是“配额耗尽时三者都收到 `quota_exhausted`”。需要裁决：配额的尾部阶段是否允许先报 `balance_exhausted`；如果不允许，租约里要带上额度受限的原因（例如 `lease.limited_by`），否则 Edge 区分不了。

### C3 “配额最多被超出一个租约”这句话不准确

签发时额度不超过剩余，所以配额不变的情况下，本月已用（settle + 预留）不会超过配额，一个租约的超出也没有。真正的超出只发生在调低配额之后，这时超出量是该成员**所有设备**的 active 租约之和，对组来说是全组所有设备的 active 租约之和，不是一个。建议改成准确的上界，否则验收时不知道该按哪个数断言。

### C4 成员换组后，本月用量算在哪个组

“组配额计的是该组及其全部子组成员的合计”没说按**当前**组成员还是按**结算时**的组。按当前成员算（ledger 没有 group_id，只能这样算）意味着：A 在 G1 花了 4000 后转到 G2，G1 的用量立刻少 4000，G2 立刻多 4000，可能当场把 G2 打到 cutoff。被移出租户或停用的成员，本月用量是否还计入原组，也没写。

### C5 跨月的口径

- 结算按 `ledger.at`（续租时刻）算月份。10 月 31 日签发、离线到 11 月 3 日才结清的租约，全部计入 11 月。
- 上月签发、仍 active 的租约预留计入本月已用（“仍在 active 的租约”没有月份限制）。
- “与 `month_cost_milli` 同口径”有歧义：`month_cost_milli` 用 `usage.cost_milli`、按 `usage.at`（`observe.ts:72-73`），配额用 `settle`、按 `ledger.at`。两者来源不同，数字不会相等。建议改成“月份边界同 `month_cost_milli`（Asia/Shanghai）”。
- 现有 `/balance.month_used_milli` 按 **UTC** 月初算（`billing.ts:20-21`），和 `observe.ts:10-16` 的上海月份不一致。如果配额实现复用了 `balance()`，会在上海时间每月 1 日 00:00–08:00 出错。这是现有缺陷，契约没要求顺带修。

### C6 `/quota/usage` 和 `/me.quota` 的字段含义

- `/quota/usage` 把 `used_milli` 和 `reserved_milli` 分开返回，但 data-model 里的“本月已用”包含预留。需要明确 `used_milli` 是否只含 settle、`remaining = quota − used − reserved`。
- 调低配额后剩余为负：返回负数还是截到 0？
- `/me.quota` 的 `quota_milli`、`month_used_milli`、`remaining_milli` 取哪一级：`limited_by` 指向的那一级（组合计）还是本人？`limited_by` 按“剩余最小”选，平手怎么定？租户余额是更紧的限制时，`limited_by` 是 null 还是另给一个值？
- `/me.quota` 是否向普通成员暴露所在组（及祖先组）的合计用量？如果是，这和 group_admin 只能查本组及子组的权限不一致。

### C7 cutoff 原因的优先级不完整

契约只写了 `balance` 优先于 `quota`。现有代码的顺序是 `disabled`（`billing.ts:65,83`）> `contract`（`billing.ts:48`）> `balance`。建议写全：`disabled > contract > balance > quota`。

### C8 Responses 入口的预留没有依据

Edge 按 `max_tokens × 输出单价 + 估算输入 × 输入单价` 预留（`router.rs:126-128,260`）。Responses 的字段是 `max_output_tokens`，Codex 通常不填，规格又要求“上游为 Chat 且未配置生成预算，保持省略”。照搬现有逻辑，预留的输出部分就是 0，放行几乎不受额度约束，流中靠实时花费断流，超租约差额会变大。契约要给出 Responses 的预留口径（例如缺省时按模型上下文或合约上限估）。

### C9 Responses 错误形态不完整

- `{"error":{"type","code","message"}}` 的 `type` 取什么值没写，HTTP 状态码是否沿用 `errors.md`（402/403）也没写。
- `response.failed` 事件的结构没写。OpenAI 的形状是 `{"type":"response.failed","response":{"id","status":"failed","error":{"code","message"}}}`，Codex 是否认 OneX 自己的 `code`（如 `quota_exhausted`）需要实测。
- 已发头之后，`response.failed` 之后是否还要发 `[DONE]` 或直接关流，没写。

### C10 Responses 的状态型字段

契约没说 `previous_response_id`、`store:true`、输入里的 `reasoning` 项（含 `encrypted_content`）、`include` 在转 Chat 时怎么处理。转 Chat 时这些无法等价表达，应明确是拒绝（哪个错误码）还是丢弃。同协议转发时 `store` 是否强制为 false 也影响数据外泄面。

### C11 Codex 和 Kimi 的 OneX `session_id` 与 `uuid`/`parentUuid`

- 契约说原生 thread id、原生 session id“只作来源标识”，但没说 OneX 的 `session_id` 用什么生成。router 按启动令牌关联 `session_id`（`router.rs:187-197`），采集侧必须产生同一个值，否则 usage 和事件对不上。
- 一个 Kimi 受管启动里出现多个原生 session（规格承认“合法多 session”），或 Codex 用 `/new` 另建 thread，分别映射成一个还是多个 OneX 会话，没写。
- 所有事件 payload 要带 `uuid`、`parentUuid`、`sidechain`、`agent_id`。Codex 和 Kimi 没有这些字段，填什么（确定性来源 ID、null）要写明，否则两条线各填各的。

### C12 “未知形状一律 gap”缺少已知忽略清单

Codex 的 `reasoning`、`session_meta`、`turn_context`、`event_msg`，Kimi 的 `turn.prompt`、`turn.steer`、`context.append_message`、`content.part`、角色为 tool 的副本、压缩快照，都是已知但不生成发言的记录。契约没有列出来，开发者可能把它们报成 gap（会话一直显示不完整），也可能把真正未知的形状当已知丢掉。需要列出每个 Agent 已知忽略的类型。

### C13 Codex 注入内容会抬高轮数

Codex 把 `<environment_context>`、`<user_instructions>`（AGENTS.md）、developer 指令写成 `response_item` 的 user 或 developer 消息。契约只说“user/assistant 可见文本”。`turn_count` 按 `system_injected` 排除（`observe.ts:101`），契约没要求 Codex 采集打这个标记。需要明确：developer 角色不回流；user 角色里的注入块要么不回流，要么标 `system_injected`。

### C14 Kimi 子 agent 与压缩

- 主 agent 目录名是什么，主会话事件的 `agent_id` 是否为 null（`turn_count` 依赖 `agent_id IS NULL`），子 agent 是否同时标 `sidechain:true`，契约没写。
- Codex 的压缩生成 `compact`，Kimi 的压缩快照只说“忽略”。Kimi 压缩是否也生成 `compact`，需要统一。

### C15 `model_not_allowed` 用于协议不支持

`anthropic` 上游的模型对 Codex 返回 `model_not_allowed`（403）。合约允许这个模型，员工却被告知“不允许”。建议在消息里说明原因；也要说明 Desktop 或 `/me` 是否提前标出 Codex 不能用哪些模型。

## 1. 配额账务边界用例

公共设置（除非另注）：租户充值 1,000,000 毫橡皮，使 5% 规则为 50,000，不起约束；合约 `lease_budget_milli = 2000`、`lease_minutes = 10`；时间固定在 2026-11-15T04:00:00Z（上海 12:00）。以下数字都是毫橡皮。

“已用”指 data-model 口径：本月 settle + active 租约 budget。

| # | 场景 | 步骤 | 预期 |
| --- | --- | --- | --- |
| Q1 | 只有本人配额 | A 配额 5000，无组。D1 握手；续租 used 2000；再续租 used 2000；再续租 used 1000 | 租约依次 2000、2000、1000；第三次续租后 settle 合计 5000，回 `cutoff{quota}`。租户余额 995,000，预留 0。`/quota/usage?scope=member&id=A` 为 `{quota 5000, used 5000, reserved 0, remaining 0}` |
| Q2 | 多级组 | Root 配额 6000 > Mid（null）> Leaf 配额 4000。A 在 Leaf、B 在 Mid，本人都不限。A、B 各握手；A 续 2000；B 续 500；A 续 2000；B 续 1500 | 租约：A 2000，B 2000，A 2000（Root 剩 2000），B 1500（Root 剩 1500，有 1500 release），A 第二次续后 Leaf 已用 4000 → `cutoff{quota}`，B 最后续后 Root 已用 6000 → `cutoff{quota}`。最终 Leaf 4000、Mid 6000（A 4000 + B 2000）、Root 6000，租户 settle 6000、release 1500 |
| Q3 | 祖先组最紧 | Root 1500 > Leaf 10000，A 在 Leaf，本人不限 | 首个租约 1500；`/me.quota.limited_by = "group:<Root>"` |
| Q4 | 合约上限最紧 | A 配额 100,000 | 租约 2000（合约），`limited_by` 按 C6 裁决 |
| Q5 | 5% 与配额同时生效 | 租户只充 40；A 配额 3 | 租约 `min(40, 2000, max(1, 2), 3) = 2` |
| Q6 | 同一人并发设备 | A 配额 3000，D1、D2、D3 依次握手 | D1 2000，D2 1000，D3 `cutoff{quota}`。D1 续 2000、D2 续 1000 并发发出：两者都 `cutoff{quota}`，settle 合计 3000，任何时刻已用 ≤ 3000 |
| Q7 | 同组两人并发 | 组 G 配额 3000，A、B 在 G；同时握手（`Promise.all`） | 两份租约之和 = 3000（2000 + 1000，顺序不定），不出现 2000 + 2000 |
| Q8 | 跨月边界（上海） | A 配额 3000。2026-11-30T15:59:00Z 续租把 settle 打到 3000 → cutoff。在 15:59:59.999Z 新握手（不带 lease_id）；再在 16:00:00Z 新握手 | 前者 `cutoff{quota}`，后者租约 2000（12 月已用 0） |
| Q9 | UTC 月初误判 | 10 月 settle 3000 发生在 2026-10-31T17:00Z（上海 11 月 1 日 01:00）。11 月 15 日查 | 这 3000 计入 11 月。若实现按 UTC 月初，会算成 10 月，结果错。`/balance.month_used_milli` 现有同样问题（C5） |
| Q10 | 跨月仍 active 的租约 | 2026-11-30T15:55Z 签发 2000，12 月 1 日 00:10（上海）查，再以 used 1500 结清 | 查询时 12 月已用 2000（预留）；结清后 12 月已用 1500，11 月不含这 1500 |
| Q11 | 调低配额 | A 配额 10,000，D1、D2 各拿 2000。管理员改为 1000。D1 续 2000；D2 续 2000 | 两个旧租约都按实报 2000 结清（配额不裁剪扣款），两次续租都 `cutoff{quota}`。本月已用 4000，超出 3000（两个租约，见 C3）。`remaining` 为 −3000 或 0（C6）。租户扣 4000 |
| Q12 | 调低到 0、改为 null | 同上之后改成 0；再改成 null | 0：任何签发都 cutoff。null：新握手拿到 2000。经续租恢复受 C1 阻塞，两种路径分开记录结果 |
| Q13 | 调高后恢复 | Q1 结束后把 A 改成 8000 | 新握手（不带 lease_id）拿 2000；带旧 lease_id 重连并重放旧 op_id 仍得缓存的 cutoff（C1） |
| Q14 | op_id 重放 | A 配额 3000。续租 op X used 2000 → 租约 1000；重放 X 两次 | 回包除 `re` 外与第一次相同；settle 只 1 笔 2000；已用仍 3000。重放之前先把配额改成 10,000，回包仍是缓存值 |
| Q15 | 换 op_id 结算已结清租约 | Q14 之后对旧租约用 op Y | `conflict`，不新增 settle |
| Q16 | 余额和配额同时触发 | B（不限）用完租户余额；A 配额 0；A 握手 | `cutoff{balance}` |
| Q17 | 只有配额触发 | 余额充足，A 配额 0 | `cutoff{quota}` |
| Q18 | 只有余额触发 | 余额 0，A 配额 5000 | `cutoff{balance}` |
| Q19 | 停用和合约优先 | A 停用且配额 0；合约 `lease_budget_milli = 0` 且配额 0 | 分别为 `disabled`、`contract`（C7） |
| Q20 | overage_pending 不计入 | A 配额 5000，租约 2000，续租 used 2600 | settle 2000、overage_pending 600；新租约 `min(2000, 5000 − 2000) = 2000`（不是 400）；`/quota/usage` used 2000、reserved 2000、remaining 1000；`/members` 的 `month_used_milli` 4000 |
| Q21 | 超额与配额同时 | A 配额 2000，租约 2000，续租 used 2600 | settle 2000、overage_pending 600、`cutoff{quota}` |
| Q22 | release 不计入 | A 配额 5000，租约 2000，续租 used 300 | settle 300、release 1700；已用 300 + 新租约 2000 = 2300 |
| Q23 | 过期未回连的租约 | A 配额 3000，D1 拿 2000 后离线过期；D2 握手 | D1 租约仍 active，计入已用；D2 只拿 1000 |
| Q24 | 归属按租约 user_id | A 名下设备结清，B 同组 | 用量计 A 和 A 的组，不计 B |
| Q25 | 无组成员 | A 的 `group_id` 为 null，配额 null | 只受租户余额和合约约束，`limited_by` 为 null |
| Q26 | 换组（C4） | A 在 G1 已用 4000，改到 G2（G2 配额 5000，已用 2000） | 按裁决结果断言；若按当前成员，G1 立刻 −4000、G2 立刻 6000 超额，A 下次续租 `cutoff{quota}` |
| Q27 | 台账聚合 | Q2 结束时查 `/groups` | Leaf 4000、Mid 6000（含 Leaf 子树 4000 与 B 2000）、Root 6000；分页、`total` 不变 |
| Q28 | `/quota/usage` 权限 | owner、admin、Leaf 的 group_admin、成员 A 分别查 Root、Leaf、A、B | owner/admin 全可查；group_admin 可查 Leaf 与 Leaf 内成员，不能查 Root 和兄弟组；A 只能查自己，查 B 和组被拒。不存在的 id 与无权限 id 的返回不能让人区分对象是否存在 |
| Q29 | 校验 | `quota_milli` 为 −1、1.5、`"100"`、超过安全整数 | 422 `invalid`，`detail.fields` 含 `quota_milli` |
| Q30 | Edge 侧提示 | 用 Q1 的 cutoff 驱动 router，分别走 `/v1/messages` 与 `/v1/responses` | 402，`code = quota_exhausted`；剩余小于单次预留时的错误码按 C2 裁决 |

并发用例用真实 Server 进程内多条 WS 连接，断言写在事务提交后。每条用例最后都核对：`ledger` 中 settle 合计 = 各 `leases.used_milli` 合计；租户余额 = topup − settle − active 预留；配额已用不包含 overage_pending 和 release。

## 2. Codex 采集与受管启动检查项

来源：`contracts/edge-ws.md` 多 Agent 一节、`docs/specs/agents/codex.md`、SIMA `contracts/poc-01/codex-transcript.md`。每项用合成 rollout 文件在临时目录验证。

### 来源与身份

- X1 只读受管 `CODEX_HOME/sessions/**/rollout-*.jsonl`。个人 `~/.codex`、其他 launch 的目录、符号链接指向的文件都不读（放一个指向外部的 symlink，断言没有事件）。
- X2 不读运行中的 Codex SQLite（`CODEX_HOME` 里放一个 `.sqlite`，断言没有打开）。
- X3 不从网络请求重建对话：router 的 `/v1/responses` 请求体不产生会话事件。
- X4 原生 thread id 只作来源标识，不作 OneX `session_id`（见 C11）。
- X5 同一受管进程里 `/new` 新建的 thread：要么登记成新会话，要么生成 gap 或提示不支持；不能归入旧会话。
- X6 子 Agent 的独立 rollout：不支持时生成 gap，主线程采集继续。

### 记录映射

- X7 `response_item` 中 role 为 user 的 `input_text` → `user_message`；role 为 assistant 的 `output_text` → `assistant_message`。
- X8 `function_call` / `custom_tool_call` → `tool_call`，`call_id` 原样作 `tool_call_id`；对应的 `function_call_output` / `custom_tool_call_output` → `tool_result`，ID 能配对。
- X9 `event_msg`（`user_message`、`agent_message`、`token_count` 等）不生成发言。合成文件里同一句话同时出现在 `response_item` 和 `event_msg`，断言只出一条。
- X10 `compacted` 不生成 `user_message` / `assistant_message`，只生成一条 `compact`。
- X11 `reasoning` 项（含 `encrypted_content`、summary）不回流。
- X12 developer 角色和注入块（`<environment_context>`、`<user_instructions>`）不当作员工发言，或标 `system_injected`（C13）。
- X13 图片输入只回元数据 `{type:"image", media_type, bytes}`。
- X14 `tool_result` 输出超过 64 KB 截断并标 `truncated`。
- X15 工具 JSON 里出现 `reasoning`、`thinking` 等同名键时原样保留。

### 去重与增量

- X16 跨轮复用相同消息 ID、相同文字的两轮发言保留为两条（去重身份含 thread、行号、类型）。
- X17 重启 onexd 后重读同一文件不重复（游标、事件、outbox 同事务）。
- X18 半行：先写半行，断言不出事件、不出 gap；补完换行后出一条事件。
- X19 文件被截短或替换（inode 变化、大小变小）→ gap，已接受事件不改写。
- X20 未知 `type`、未知 `payload.type`、坏 JSON → gap，后续行继续采集。
- X21 过大行 → gap，不 OOM。
- X22 工具调用已取消、结果迟到（结果在下一轮之后才出现）仍能配对。
- X23 同日两个 thread 各成一个会话。

### 受管启动

- X24 绝对路径启动固定版本制品，启动前核对平台和可执行摘要；不用 PATH 里的 `codex`。
- X25 `HOME`、XDG、缓存、tmp 都指向私有目录；个人 `.codex`、OAuth、供应商环境变量不继承（在测试环境里设 `OPENAI_API_KEY`，断言子进程环境里没有）。
- X26 `config.toml` 写 `model_provider` 指向本机 router，`base_url` 为 `http://127.0.0.1:<port>/v1`，`wire_api = "responses"`，`env_key` 只写变量名；令牌值不出现在参数和 TOML 里。
- X27 关闭自动更新检查、请求重试和流重试。
- X28 `config.toml` 先写临时文件、fsync、同目录原子替换；个人配置文件前后字节不变。
- X29 退出时撤销本机令牌：退出后用旧令牌访问 router 返回 401。
- X30 `session_start.agent = "codex"`，`agent_version` 为实际版本。

## 3. Kimi Code 采集与受管启动检查项

来源：`contracts/edge-ws.md` 多 Agent 一节、`docs/specs/agents/kimi-code.md`、SIMA `contracts/poc-01/kimi-transcript.md`。

### 来源与身份

- K1 只读受管 `KIMI_CODE_HOME/sessions/**/agents/<agent>/wire.jsonl`，用 `state.json` 核对 native session id 与目录名一致（`session_<uuid>`；裸 uuid 只在等于目录后缀时接受），不一致 → gap，不采集。
- K2 原生 session id 只作来源，不覆盖 launch 的身份。
- K3 一次 launch 内多个合法原生 session 分别带来源（C11 裁决映射方式）。
- K4 不同 agent 复用同一 call ID 不互相配对：工具 ID 按 native session + agent + 原始 ID 加域。

### 记录映射

- K5 `agent.message.appended` 只取 `message.message` 中 role 为 user/assistant 的非空公开文本。
- K6 只有工具调用、没有文本的 assistant 行不产生空的 `assistant_message`。
- K7 `agent.message.appended` 里 role 为 tool 的消息和 `toolCalls` 不再重复生成工具事件。
- K8 `context.append_loop_event` 的 `tool.call` → `tool_call`，`tool.result` → `tool_result`；`is_error` 只照抄显式值，不从缺省推断成功。
- K9 `turn.prompt`、`turn.steer`、`context.append_message`、`content.part`、压缩和上下文快照不生成发言（C12、C14）。
- K10 thinking、reasoning、签名不回流；普通文本里出现“reasoning”这个词不被删。
- K11 子 agent 的事件写 `agent_id`；主 agent 的 `agent_id` 为 null，`turn_count` 不含子 agent（C14）。
- K12 合成形状验收：4 条 `user_message`、3 条 `assistant_message`、8 条 `tool_call`、8 条 `tool_result`，没有空回复、没有重复。SIMA 仓库里没找到 `observed-1.5.synthetic.jsonl`，开发者需要自己构造覆盖同样形状的文件，验收时我会单独写一份核对。

### 去重与增量

- K13 半行、截断、替换、ID 冲突 → gap，已收事件不覆盖。
- K14 重启、重读、重传不重复。
- K15 未知记录类型、未知 `event` 值 → gap。

### 受管启动

- K16 `KIMI_CODE_HOME` 为受管运行根下的 `kimi`；`HOME`、XDG、TEMP 指向私有目录；大小写代理变量清空。
- K17 `config.toml`：`providers.<id>.type = "anthropic"`，`base_url = "http://127.0.0.1:<port>"`（不带 `/v1`），`api_key` 是本机短期令牌，不是上游 Key；文件权限 0600。
- K18 `KIMI_CODE_NO_AUTO_UPDATE=1`、`KIMI_CLI_NO_AUTO_UPDATE=1`；`--skills-dir` 指向私有目录。
- K19 遥测、自动标题、额外尝试关闭。
- K20 退出后撤销令牌，`config.toml` 里的令牌失效（用它访问 router 返回 401）。
- K21 不继承个人 Kimi 认证，个人 `~/.kimi-code` 前后字节不变。
- K22 `session_start.agent = "kimi-code"`。

## 4. Responses 路由检查项

### 用量口径

- R1 `usage = {input_tokens: 1000, input_tokens_details:{cached_tokens: 300}, output_tokens: 200, output_tokens_details:{reasoning_tokens: 150}}` → `input_tokens = 700`、`cache_read_tokens = 300`、`output_tokens = 200`、`cache_write_tokens = 0`。费用 = 700 × 输入单价 + 300 × 缓存读单价 + 200 × 输出单价，reasoning 不再加。
- R2 没有 `input_tokens_details` → cached 按 0。
- R3 `cached_tokens > input_tokens`（异常上游）→ 不出现负数，记录告警或按 0 截断，裁决前标为待核对。
- R4 流式：用量取 `response.completed.response.usage`；流在 completed 之前断开 → `complete = false`，按已收到的部分计价，不当作 0。
- R5 缺用量不填零（规格明文）。
- R6 转 Chat：Chat 的 `prompt_tokens`、`cached_tokens` 按现有 v0.10 口径换算后，与 R1 的结果一致。

### 错误形态

- R7 未发头：租约 cutoff（quota）→ 402，body 为 `{"error":{"type":…,"code":"quota_exhausted","message":…}}`，不是 Anthropic 的 `{"type":"error","error":{…}}`。
- R8 未发头：本机令牌错 → 401；模型不在 route 内 → `model_not_allowed`；上游协议为 `anthropic` → `model_not_allowed`。
- R9 已发头：流中 cutoff → 写 `response.failed`，`code` 取 `errors.md`，然后关流；之后不再有 `response.output_text.delta`。
- R10 上游返回 HTTP 200 但 SSE 里是 `response.failed` 或 `error` 事件 → usage 状态不是 `ok`。
- R11 `/v1/messages` 的错误体保持 Anthropic 形状，不受新入口影响（回归）。

### 上游协议

- R12 `openai_responses`：同协议转发，请求体只改 `model`（`upstream_model`），本机令牌换成上游密钥，`x-api-key` 和本机 `Authorization` 不外传；URL 拼接规则与 Chat 一致（`/v1` 结尾直接接 `/responses`）。
- R13 `openai_chat`：转换 `instructions` → system、`input` 消息 → messages、`function_call` / `function_call_output` → `tool_calls` / tool 消息，`call_id` 原样保持；流式回写成 Responses 事件序列（`response.created`、`output_item.added`、`output_text.delta`、`function_call_arguments.delta`、`output_item.done`、`response.completed`）。
- R14 `openai_chat` 且请求没有 `max_output_tokens` → Chat 请求也不带 `max_tokens`（规格：保持省略）。
- R15 `anthropic`：返回 `model_not_allowed`，不发上游请求（假上游计数为 0）。
- R16 状态型字段（`previous_response_id`、`store`、`reasoning` 输入项）按 C10 裁决的行为。
- R17 预留口径按 C8 裁决；没有 `max_output_tokens` 时放行和断流仍受租约额度约束（构造一条输出很长的流，断言在额度处中断）。
- R18 同一本机令牌、同一租约：交替发 `/v1/messages` 和 `/v1/responses`，Edge 的 used 和上报的 usage 合计一致。

## 5. 验收方式

- 配额：在 `server/test` 的临时数据目录里起真实 Server，用 WS 客户端模拟多台设备，固定时钟推进到月切换。只读执行，不改产品代码；需要的临时测试脚本放在 `/tmp`，跑完删除。
- Edge：用 `cargo test` 跑开发者的测试，再用临时目录里的合成 rollout、wire 文件和回环假上游复核上面各项。
- 每项记录通过、失败或因契约未定而跳过，失败附命令和输出。
