# S1-E2 Edge 独立验收：计价、租约与断流

**结论：不可合并；已合入主线，不放行 S1-E2。** 已有测试验证基础计价、空额度拒绝和部分断流，但没有证明「真实消费才能结算」或「断线重试同一结算操作」。主线后续修订也未消除这两个阻塞。建议让 Edge 与 Server 一起复验结算窗口，不要仅以现有测试全绿放行。

## 范围与证据

- 目标 `fa0cb832f36fd1a4d40bae8f978621c88258578c`。第一次测试时 review worktree 在 `ab57d99`，`git diff --exit-code fa0cb83 HEAD -- edge` 无差异：**95 通过、0 失败**。其后 worktree 更新到主线 `299c32fd0d2f3fafcb06d8f6298b317054b96d55`（含后续实现 `3eb2705` 与 v0.8 契约）：复跑 **104 通过、0 失败**。
- 命令：`cargo test --manifest-path edge/Cargo.toml --workspace --locked --offline --target-dir /tmp/onex-magpie-s1-e2-target`。
- 独立跑目标 worktree 的 Server 对照：`bun test server/test/server.test.ts -t 'concurrent renewals stay inside tenant funds|an offline lease is settled on return'`，**2 通过、0 失败**；它们用测试端发送固定 `op_id`，不是实际 Edge↔Server 联验。
- 根据 `gateway.md` §4/§5、`sprint-1.md` 的 S1 约定、`s1-acceptance.md` #2b/#3/#4/#5，以及 `contracts/edge-ws.md:38–49,89–102` 对照。下列源文件行号默认指当前主线 `299c32f`，明确标 `fa0cb83` 的除外。未调用真实模型、未改 Edge/Server 源码。

## 放行阻塞（前三项）

### 1. 租约预留超额放行，且被当作已消费结算

- **复现证据（现有夹具，已独立运行）：** 在 `end_frame_only_upstream_reserves_max_tokens` 给 150 毫橡皮额度，首个请求尚无有效用量但预留超过 150，仍到达假上游并收到帧，第二个请求才被拒；丢掉首流后最终实际为 0。`reservation_counts_but_does_not_gate_itself` 也明确断言 100 的租约仍可放行预留 500 的首单；`budget_exhausted_mid_stream_cuts_stream` 则明确断言已记花费超过租约额度。
- **对账复核（由代码推导，非跨进程实测）：** `admit` 只查加入新请求前的总额，未将本单预留计入准入比较（`edge/onexd/src/lease.rs:358–372`）；`take_renew` 把包含在途预留的 `total()` 发成 `used_milli`（`:195–205,485–502`）。150 额度、200 预留、实际 0 时，续租可先发送 200，Server `used > budget` 拒绝（`server/src/billing.ts:89–98`）。即使未超额度，也会先扣并未发生的费用：100 额度、已完成 70、在途预留 20、实际最后只用 5 → 首次结算报告 90 而非 75；新租约的 `carried = 70 − 90`，该流结束后为 −15（`lease.rs:383–400,595–607`）。这不只是「跨租约归属不同」：负数不能作为合法续租额度上报（`server/src/management.ts:24`），若余额不足而返回 cutoff，也没有下一笔抵消已扣差额。
- **判据：** 可用租约覆盖本单预留才发上游；预留与结算快照分离，不把未发生的消费记入 `used_milli`。测试必须同时校验上游调用数、Server 流水与 Edge 剩余额度。`fa0cb83` 还漏估输入，`3eb2705` 已补输入估算，但上述阻塞仍在。

### 2. 续租已提交但回包丢失时，后续真实消费变化会使重试失去幂等性

- **最小回归场景（静态复核）：** 以 100 额度、已用 80 触发续租；Server 先提交并签出新租约，在 Edge 收到新租约前关闭控制连接。当前有效租约内再产生 5，回连后核对续租帧。`fa0cb83` 每次发送新消息 `id` 又没有 `op_id`（`edge/onex-core/src/ws.rs:234–238`、`edge/onexd/src/ws.rs:338–342`，均指该目标版本），即使用量不变也会更换幂等键。
- **主线仍失败：** 新版用 `{lease_id}:{used}` 作键，用量相同的重试能命中；但断线清掉 `pending`，重连重新计算金额，`L:80` 变为 `L:85`（`edge/onexd/src/lease.rs:469–502`）。Server 只按原操作键重放，新的操作命中已结旧租约返回 `conflict`（`server/src/edge.ts:129–135`、`server/src/billing.ts:79–100`）。因此不是「Server 会重复扣款」，而是设备拿不到已签的新租约，后续可能在旧租约上耗尽/过期停工。现有 Edge 测试断线后不增加用量，也没有让真实 Server 先提交后丢回包。
- **判据：** 首次发出后应持久保留稳定的 `op_id`、金额和对应快照；在明确得到该操作结果前原样重试，将快照之后的实际新增消费归入下一租约。再次验收加上「Server 提交→回包丢失→继续消费→回连/重启」的跨进程用例。

### 3. 缺失或不完整的 usage 仍可能直接进入结算

- **最小回归场景（静态复核）：** 让假上游对一个有正费率、正 `max_tokens` 的非流式请求返回成功消息但不带 `usage`。或流式只发零占位、正文、`message_stop`，不发真实尾用量。用 usage 事件、Edge 账和随后真实 Server 的续租结算对照。
- **实际代码路径：** `complete` 可为 `false`，但「正常结束且无最终 usage」在 `Req::finish` 使用 `meter.live()`，它可取预留；该金额通过 `ticket.finish` 计入本地已用，再由续租驱动真实扣款（`edge/onexd/src/router.rs:138–146,403–415,467–478`；`edge/onexd/src/lease.rs:495,595–607`）。`message_delta` 中只要存在 `usage` 键，哪怕对象空或没有有效最终输出数字，也会设 `usage_final=true`（`router.rs:606–611`）。这和「只按已见部分、标待结算、不把未知冒充已结」不符；现有正常尾用量测试通过不能覆盖。
- **判据：** 分开标记协议结束和最终计量，按有效字段和路由声明判断用量完整性；缺失时不得把预留当已发生消费。断在头后但没有 `message_stop` 的情形也应单列其终态和计量证据。

## 逐项结果

| 清单 / 能力 | 结论 | 独立证据或缺口 |
| --- | --- | --- |
| #4 边端四类计价、倍率生效、正常尾帧 | 通过 | `cost_sums_categories_then_rounds_up`、`picks_latest_effective_rate`、`streaming_cost_is_priced_and_charged_to_lease`、`end_frame_usage_settles_reservation`；算例 100/50/20/10 × 1/2/3/4 得 300 毫橡皮；逐请求合计后向上取整。 |
| #4 待结算；管理端五秒整链 | 不通过 / 无法验证 | 待结算路径见阻塞 3；未做管理端端到端计时，#4 整链不签。 |
| #5 租约用完后下一请求本机拒绝 | 通过（假上游、协议层） | `budget_used_up_rejects_next_request` 观察 402/`balance_exhausted`，实现带中文处理建议。未用受管 Claude Code PTY 核实显示。 |
| #5 并发预留、花费与余额一致 | 不通过 | 阻塞 1、3；已有测试显式接受预留大于额度。非流式完成路径也绕过仅在 `pump` 中执行的预算检查（`router.rs:386–422,528–536`）；应将正好可用和刚超过额度的场景在 JSON/SSE 皆验证。 |
| #5 到期或 WS cutoff 唤醒流与拒绝新请求 | 通过（现有本地夹具）；慢读满队列终止错误无法验证 | `lease_expiry_interrupts_inflight_stream` 和 `cutoff_interrupts_inflight_stream` 通过，后者观察到上游取消和 Anthropic 错误；没有把客户端不读、发送队列打满再触发 cutoff 的完整证据。实现仅给错误入队 1 秒（`router.rs:572–575`）；应确认网络恢复读取时不会误认成功。 |
| #3 续租与控制链路隔离 | 部分通过 / 不通过 | 80% 触发、临期触发和现有租约内离线放行通过；主线新增两种链路故障隔离测试通过。续租已提交且回包丢失不通过（阻塞 2）；两小时 PTY、两类两分钟断网、原生会话补传与不重扣整链无法验证，留 S1-E3/T1/T2。 |
| #2b 上游尝试与断流 | 目标不通过；后续部分通过 | `fa0cb83` 无响应头的候选错误不重试、直接标真实零（目标 `router.rs:341–357`）；`3eb2705` 的 `retries_once_when_no_response_headers_and_records_each_attempt`、`no_retry_after_response_headers` 已通过。两版还以 `message_stop` 标志等待 EOF，若上游发完终态仍保持 HTTP 流开放，之后租约 cutoff 可追加错误（主线 `router.rs:519–569,580–614`）；需补终态后连接不关的夹具。Anthropic→Chat、`count_tokens` 与真实模型不在本次 E2 签收内。 |

## 联验跟进

- `299c32f` 的 v0.8 已规定跨租约 usage 归放行的 lease、结算取 `lease_renew.used_milli`、Server 按设备合计对账。Edge 主线已固定 usage 的原 lease（`edge/onexd/src/lease.rs:644–648`）；当前 Server 的 `reconcileUsage` 仍按单个 lease 对比（`server/src/billing.ts:69–76`）。协调 Server 一并补跨续租汇总；不要把正常跨租约差额误判成异常。
- 另补 WS 乱序与慢流回归：新 lease 安装前后迟到的旧 lease/cutoff，以及中途已经写满队列的断流。当前 `grant` 的序号检查只在已有 lease 时生效（`lease.rs:375–401`），而 cutoff 清空 lease（`:414–428`）；持久化失败也应保留原结算快照直到新租约确实就绪。
- 已按新裁决更新共享清单 Edge #3：只断控制链路时继续对话；整机断网时模型失败是预期，恢复后无需重启/登录，断网前内容补传完整且不重扣。该更改不是运行通过的证据。

## S1-E1 补充静态审查：本机 router

**结论：基本 Anthropic Messages 代理已有实现和本地夹具，但不能签收完整 E1 / S1 #2b。** 原始 router 在 `0c188cb`，核对合入 S1-E2 后的当前实现（review `299c32f`，与 `430da9d` 的 `edge` 和 `server/src` 无差异）。依据 `gateway.md` 的入口、选路和流式边界、S1 决定与 Edge #2b。以下是静态结果；本段未重新执行产品测试、未连接真实上游，也未添加产品代码。前次 104 项结果只用作已覆盖路径的旁证。

### 已实现、仍需补证据的路径

| 判据 | 结论 | 证据 |
| --- | --- | --- |
| 本机入口、按模型选路、同协议转发 | 静态通过（限定基本路径） | `edge/onexd/src/main.rs:51–64` 监听 loopback；`router.rs:173–183,214–224,246–266,308–322,677–688` 区分本机令牌与 Provider 认证，支持精确/最长前缀/通配，模型映射只改 `model`，保留 beta 头和查询。前跑的 `streaming_passthrough_and_usage`、`non_streaming_passthrough_and_usage`、`upstream_auth_headers_are_replaced`、`bearer_upstream_and_model_rewrite_and_query` 覆盖基础路径；图片及完整/中断工具回合没有整链证据。 |
| 分帧、首段增量、常规截断和取消 | 静态通过（限定现有夹具） | `edge/onexd/src/sse.rs:24–78,86–145` 处理 CRLF、TCP 任意切分、多 `data:` 行、UTF-8 和注释，保留完整帧字节；前跑 `slow_stream_is_forwarded_incrementally`、`upstream_cut_mid_stream_sends_error_event`、`upstream_eof_without_message_stop_is_error`、`client_disconnect_during_slow_stream` 覆盖基本流式路径。慢读队列满、终态后连接仍开、无有效终态的错误帧见下。 |
| 四类用量旁路 | 部分通过 | `router.rs:580–629` 提取起始与增量累计值，不把缓存占位零覆盖已见值；缺最终用量和结算问题见 E2 阻塞 3。缓存写 TTL 与推理细分不是现有四类费用契约，不能拿参考实现直接做 S1 拒签条件。 |

### 未达到判据与优先复验场景

1. **缺少 `count_tokens`；Chat 是另一个仍未完成的 S1 依赖。** `edge/onexd/src/router.rs:173–175` 只注册 `/v1/messages`，按静态路由表，合法计数请求也不出站；不满足 `sprint-1.md:64` 的同协议透传且不计费/不回流。验收时对照假上游收到一次计数请求、结果原样返回、用量和 outbox 不增。按 `master-plan.md:124–129`，S1 真机必须走 Chat；当前 Edge `router.rs:260–266` 返回 501，Server `server/src/edge-config.ts:55–59` 只发布 Anthropic routes。应单独跟踪 Chat 和 Server 路由下发，不把它误写成已有同协议功能的回归；未能用 AC-01～16 或 local qwen 签整链。
2. **HTTP 200 的业务错误没被路由识别为错误终态。** 流式 `observe` 只识别四种非错误事件并无条件转发已解析批次（`edge/onexd/src/router.rs:526–556,580–614`）。合法上游 `event: error` 已传给客户端，该次若随后 EOF，router 还会追加一个通用截断事件；若上游先发 `message_stop` 但仍保持连接，router 不结束，该次还能被租约超时改成失败。另一个分支，2xx JSON 即使顶层为 `type:error`，仍记录 `Outcome::Ok`（`:403–422`）。用普通错误夹具分别断言：原始可识别错误只结束一次、HTTP 200 裸业务错误不算成功、`message_stop` 到达后不靠 TCP EOF 收尾、已收头不重试。未运行这些新增夹具。
3. **HTTP 客户端可能在 router 重试层之外继续发送，破坏不换路和尝试计量。** `edge/onexd/src/router.rs:169,186–211,343–368` 没有关闭 reqwest 默认重定向；锁定的 reqwest 0.12.28 默认跟随重定向（`async_impl/client.rs:310`、`redirect.rs:161–164`）。router 只能看到 HTTP 客户端最后返回的结果，无法将先收到的 3xx 视为「已收头不得再发」，也无法给中间出站逐次记账。建议禁用模型流量的自动重定向；增加隔离回归以断言只请求获准路由、保留正确的状态分类，默认路径和指定代理路径都覆盖。未实测。
4. **SSE 背压按块，不是字节上界。** `edge/onexd/src/sse.rs:24–52` 持续累加直到事件边界，既没有行/事件字节上限，也不限制同次解析结果；`router.rs:369–383,526–544` 的 16 槽通道限制块数而非每块大小，非流路径的 `read_limited` 不适用。按 `gateway.md:27–32` 建议设置明确字节上限并给出终止错误；验收用正常边界尺寸的合成样本确认终止、释放上游，且不把超限用量标为完整。不需要用资源耗尽来证明修复。

### 跨任务依赖与联验顺序

- **生产 Provider 密钥还未接入 Edge。** `edge/onexd/src/ws.rs:336–339` 对 `secret` 明确返回未实现，`router.rs:277–283` 无密钥即拒绝；前次 router/isolation 测试直接向内存注入测试值（`edge/onexd/tests/router.rs:257`、`tests/isolation.rs:148`）。先用实际 Server 下发的测试 secret 跑一次认证整链，再跑受管 PTY；不能把注入的测试值算作真实配置联验。
- **离线准入未绑定签发时路由快照。** `router.rs:246–250,298–305` 从当前共享配置取路由，之后独立准入；`ws.rs:314–327,376–382` 独立替换配置/租约。已有控制链路断开测试不改变配置，无法证明 `sprint-1.md:67` 指定的签发快照。用两套合法测试配置与同一既有租约验证：更新路由但不发新租约，断开控制链路，下轮须仍走原租约授权快照。
- 复验顺序建议：假上游的计数、错误/终态和重定向边界 → 实际 Server 下发测试路由/密钥并验证断线快照 → Chat 启用后再跑 AC 和总督安排的真机。此项静态复核不改变前文 S1-E2 结论。
