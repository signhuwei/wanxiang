# Kimi 采集器验收（S2B-R1，dev/s2b-kimi）

验收对象：`dev/s2b-kimi`（`7e32dd6`、`eeccba1`）的 `edge/onexd/src/kimi_capture.rs`，顺带看了 `kimi_launch.rs`、`kimi_config.rs`。对照 `docs/specs/agents/kimi-code.md`、契约 v0.13（`61f66ac`）多 Agent 补充，以及 SIMA 的 `contracts/poc-01/kimi-transcript.md` 和合成文件 `contracts/poc-01/fixtures/kimi-wire/observed-1.5.synthetic.jsonl`（126 行，覆盖 Kimi Code 2.2.0 wire 1.5 的全部记录形状）。

只读静态审查。worktree 不能切到这个分支，所以没有跑它的测试。下文数字是我按代码逐行对合成文件推出来的。

更正：我在 review-plan.md 里说 SIMA 没有这个合成文件，那是错的，文件在上面的路径里。

## 结论：不能合并

采集器读的字段名是按规格文字猜出来的，和真实 wire 格式对不上（文件头注释自己也承认“依据规格文字重建的合成形状”）。用 SIMA 的合成文件跑，结果是 **0 条发言、0 条工具事件、约 126 条 gap**，规格要求的是 4 / 3 / 8 / 8。`spec_sample_counts` 测试能过，只是因为测试数据也是用同一套猜出来的字段写的。

## 阻塞

### K-B1 `agent.message.appended` 的路径错了一层

真实形状（合成文件第 7、18 行）：

```json
{"type":"agent.message.appended","message":{"message":{"role":"user","content":[...]},"meta":{...}}}
```

代码读 `v["message"]["role"]`、`v["message"]["content"]`（`message()`），应当读 `v["message"]["message"]`。结果合成文件中的 19 条 `agent.message.appended` 全部变成 `gap{unknown_role:}`，一条发言都没有。

### K-B2 工具事件的字段名全错

| 含义 | 真实字段（第 31、33、78 行） | 代码读的 |
| --- | --- | --- |
| 调用 ID | `event.toolCallId` | `event.call_id` |
| 工具名 | `event.name` | `event.tool` |
| 输入 | `event.args` | `event.input` |
| 结果 | `event.result.output` | `event.output` |
| 附注 | `event.result.note` | 不读 |
| 错误 | `event.result.isError` / `is_error` / `success` | `event.is_error` |
| 原生记录 ID | `event.uuid`（调用）、`event.parentUuid`（结果） | 不读 |

因为找不到 `call_id`，8 条 `tool.call` 和 8 条 `tool.result` 全部变成 `gap{loop_event_no_call_id:...}`。

### K-B3 已知忽略清单是编出来的，真实的已知类型全被报成 gap

代码的 `IGNORED_TYPES` 是 `agent.message.delta`、`context.replayed`、`context.compacted`，这三个类型在 wire 1.5 里都不存在。真实文件里有 26 种顶层类型（见 SIMA 合成文件的 `README.json`），除了两种要采集的，其余全部会被报成 `unknown_type` gap：`metadata`、`runtime.set_binding`、`profile.bind`、`permission.set_mode`、`permission.record_approval_result`、`turn.prompt`、`turn.steer`、`turn.ended`、`context.append_message`、`context.apply_compaction`、`full_compaction.begin`、`full_compaction.complete`、`agent.turn.started`、`agent.turn.ended`、`plugin.session_start`、`llm.request`、`llm.tools_snapshot`、`usage.record`、`token_counting.measured`、`token_counting.rebased`、`token_counting.turn_recorded`、`prompt.completed`、`prompt.steered`、`interaction.request`、`interaction.resolved`。

`context.append_loop_event` 里的 `step.begin`、`step.end`、`content.part` 也是已知类型（SIMA `edge/src/journal/kimi.rs:226`），代码同样报成 gap。

这违反契约 v0.13：“列表内的跳过且不生成 gap，列表外的未知类型生成 gap。清单要有测试。”正确的清单可以直接参考 SIMA `edge/src/journal/kimi.rs:337-361`。

### K-B4 `role: "tool"` 的副本和只有 toolCalls 的空 assistant 行

合成文件第 94–106 行是压缩后重放的 assistant `toolCalls` 行和 `role:"tool"` 行，规格明确要求“不得再次生成”（kimi-transcript.md：“Do not emit its role=tool body or toolCalls a second time”；“Empty assistant tool-only rows do not create empty replies”）。

- 修了 K-B1 之后，`role:"tool"` 会走到 `unknown_role:tool` gap。应当静默跳过。
- `content: []` 的 assistant 行会生成一条 `content: ""` 的 `assistant_message`。合成文件里有 4 条这样的行（94、97、101、104），助手发言会从 3 条变成 7 条。

### K-B5 去重方式和规格说的“多重表示”不是一回事

代码按 `(agent_id, call_id)` 去掉**重复的 `tool.call` / `tool.result`**，并说明这就是规格里“工具结果同时出现在多个表示中”的防线。真实的多重表示是：`context.append_loop_event` 的 `tool.result`、`agent.message.appended` 的 `role:"tool"` 副本，以及 assistant 的 `toolCalls`。这几种在 K-B4 里按类型跳过就够了，不需要按 ID 去重。

现有的去重还带来两个问题：

1. `seen` 集合写进游标 JSON，每次 pass 都整体重写，随会话长度无限增长。
2. 截断或替换时 `seen.clear()` 后从偏移 0 重读，已经接受的事件会再上报一遍。规格要求“截断与 ID 冲突不覆盖已收记录”，SIMA 的做法是按语义 ID（消息 ID、加了域的调用 ID 和阶段）判断是否重复，遇到冲突报诊断。

## 不符合契约 v0.13

### K-C1 payload 公共字段缺失

所有事件都没有 `uuid`、`parentUuid`、`sidechain`。v0.13 要求：`uuid` 取原生记录 ID（消息用 `meta.userMessageId` / `meta.messageId`，工具调用用 `event.uuid`），没有就填 null；`parentUuid` 同理（`tool.result` 有 `parentUuid`）；子 agent 的 `sidechain` 为 true。目前子 agent 只写了 `agent_id`，没有 `sidechain`。

### K-C2 `session_id` 的生成方式

`kimi_launch.rs` 每次启动生成一个随机 UUID v4。v0.13（`61f66ac`）要求 `UUID v5(设备命名空间, "kimi-code:<原生会话 ID>")`，`--session` 续接时得到同一个 `session_id`，游标按原生会话文件保存，续接时不重报旧内容。这条契约是在 kimi 提交之后才定的，需要跟进修改。现在的游标键是 `kimi-code:<launch 的 session_id>`，续接时游标会从 0 开始，旧内容全部重报。

### K-C3 压缩没有生成 `compact`

v0.13：“能读到压缩摘要时生成 `compact`。”真实记录是 `context.apply_compaction`，带 `summary`（第 84 行）。代码把一个不存在的 `context.compacted` 当作忽略。

### K-C4 原生 session 校验没做

规格：“以 `state.json` 验证 native session、cwd 和目录归属。”SIMA 契约：`state.json` 的 `id` 要等于目录名 `session_<uuid>`，`profile.bind.environmentDisclosure.cwd` 要和启动时的 cwd 一致，记录里的 `agentId`、`sessionId` 要和来源目录一致，不一致就报 `SOURCE_IDENTITY_MISMATCH` 并停止采集。代码里这几项都没有。`metadata.protocol_version` 也没检查，非 1.5 的文件应报 gap，不能按 1.5 的字段去猜。

### K-C5 原生时间

事件的 `at` 用的是采集时刻 `now_ms()`。规格要求记录原生时间：用记录的 `time`（毫秒），其次是 `meta.createdAt`，都没有时留空。重启补采时，`now_ms()` 会把整段历史都标成同一时刻。

### K-C6 thinking 等私有块会被报成 gap

`message()` 遇到 `thinking`、`reasoning`、`redacted_thinking`、`signature` 这类非文本块时生成 `message_block:<type>` gap。契约规定它们“不回流”，所以它们属于已知忽略，应当静默去掉。否则开了推理的会话每一轮都会显示缺口。

## 安全与隔离

### K-S1 子 agent 目录可以是符号链接

`files()` 用 `e.path().join("wire.jsonl").is_file()`，会跟随 `agents/<agent>` 目录的符号链接。`read_file` 的 `symlink_metadata` 只检查最后一级的 `wire.jsonl`，属主检查只比较 uid。这样 `agents/x -> ~/某处` 指向员工自己的任意目录时，里面的 `wire.jsonl` 会被读取并回流。规格要求“只读受管目录内的私有普通文件，不跟随符号链接”。应当对 `agents/<agent>` 也做 `symlink_metadata`，并用 canonicalize 确认路径仍在 `KIMI_CODE_HOME/sessions` 之下。

### K-S2 含本机令牌的 `config.toml` 放在持久目录

`kimi_launch.rs` 文件头说 `config.toml` 写在本次 run 目录、随 run 目录删除；代码实际写到持久命名空间 `agents/kimi-code/kimi/config.toml`，结束时不会删除。后果：

1. 令牌明文在退出后留在磁盘上。即使令牌已撤销，这也违反规格的待测项“令牌文件残留”。
2. 两个窗口同时启动 Kimi Code 会互相覆盖同一个文件，违反“跨窗口不共写”。
3. 写法是先删除再 `create_new`，不是“同目录临时写、fsync 后原子发布”，中间有一段时间文件不存在。

### K-S3 缺少 `--skills-dir`

规格：“默认 `--skills-dir <私有目录>`。”启动参数里没有这一项，Kimi 会去默认位置加载 skills。

### K-S4 配置键是编出来的

`telemetry_enabled`、`auto_title`、`retry_attempts` 没有出处。Kimi 遇到未知键时，可能直接拒绝启动，也可能静默忽略（这样遥测实际上并没有关掉）。在拿到 2.3.0 真实制品核对之前，这三个键应当标为待验，不能算“已关闭”。`--config`、`--model` 这两个启动参数也需要核对是否存在。

## 小问题

- `tool_output` 把非文本块写成 `[image]` 这样的占位符。契约要求图片只回元数据 `{type:"image", media_type, bytes}`。
- `result.note` 丢失。SIMA 契约要求保留有意义的 note。
- `PLACEHOLDER_MAX_CONTEXT_SIZE = 32000` 对 128K 的模型会让 Kimi 提前压缩。代码已注明是占位值，需要 `Request` 带上真实的 context window。

## 建议的验收方式

1. 把 SIMA 的 `observed-1.5.synthetic.jsonl` 复制成 Edge 的测试数据（只含合成文本，可以放进仓库），断言 4 / 3 / 8 / 8、0 条 gap、没有空的 assistant 发言。
2. 已知忽略清单的测试覆盖全部 26 种顶层类型，外加 `step.begin`、`step.end`、`content.part`。
3. 再补以下测试：未知类型产生 gap；`metadata` 不是 1.5 时产生 gap；`agentId` 与目录不一致时停止采集；截断后不重报已接受的事件；子 agent 目录是符号链接时不读取。
