# Codex 线验收（一）：受管启动与 config.toml（dev/s2b-codex 0b488a9）

只读静态审查。worktree 不能切到这个分支，所以没跑它的测试。对照 `docs/specs/agents/codex.md`、契约 v0.13（`61f66ac`）、SIMA `edge/src/lifecycle/adapter.rs:640-745`（SIMA 的 Codex 启动实现，规格的依据）。

## Codex rollout 样本

SIMA **没有** Codex rollout 的合成样本文件。`contracts/poc-01/fixtures/` 下只有 `kimi-wire/`，`codex-transcript.md` 也没有提到样本文件。真实形状的依据只有两处：

- 解析器 `edge/src/journal/codex.rs:95-245`：顶层类型 `session_meta`（`payload.id` 必须等于 thread）、`response_item`、`event_msg`、`compacted`（`payload.message`）、`turn_context`、`world_state`、`token_usage_record`。`response_item.payload.type` 包括 `message`（`role`、`content[].type` 为 `input_text`、`output_text`、`text`）、`function_call`（`call_id`、`name`、`arguments` 是 JSON 字符串）、`custom_tool_call`（`input`）、`function_call_output`、`custom_tool_call_output`（`call_id`、`output`、`is_error?`）、`reasoning`。`event_msg` 的 18 种已知子类型列在 `:207-225`。
- 测试 `edge/src/journal/codex_tests.rs`：内联合成行，含 developer 消息、加密 reasoning、`event_msg` 镜像、`input_image`、子 agent 的 `session_meta.source.subagent`、半行和坏行。

建议 codex 线据此自己写一份覆盖上述全部类型的合成 rollout，放进 `edge/onexd/tests/fixtures/codex-rollout/`，并在 README 里写明来源和预期计数。采集器交付后我按这份清单复验。

## 结论：config.toml 能生成，但路由可以被绕过，令牌会泄露给工具子进程

### X-H1（高）没有用 `-c` 固定路由，项目配置可以绕过 OneX 计费

规格明确要求：“分别用 `-c key=value` 固定同值……基线不启用项目发现。”SIMA 在启动参数里用 `-c` 固定了 `model`、`model_provider`、`model_providers.<id>.base_url/env_key/wire_api`，加上 `project_doc_max_bytes=0`，还检查 cwd 所属 git 根目录里有没有 `.codex`、`.agents/skills`，有就拒绝启动（`adapter.rs:403-430`）。

0b488a9 的 `args` 是空的，也不检查项目目录。Codex 会递归合并受信项目的 `.codex/config.toml`。员工在项目里放一份：

```toml
model_provider = "mine"
[model_providers.mine]
base_url = "https://api.example.com/v1"
http_headers = { Authorization = "Bearer sk-..." }
wire_api = "responses"
```

模型流量就直接走员工自己的上游，不经过 router，不计费，不受配额和 cutoff 约束。rollout 仍然会被采集，所以管理端看起来一切正常。这破坏了 AGENTS.md 里“模型流量经本机 router”这条基本边界。

要求：用 `-c` 固定路由的全部字段；按 SIMA 的做法拒绝含 `.codex` 的项目（或至少 `-c projects.<cwd>.trust_level="untrusted"`）；加 `-c project_doc_max_bytes=0`。另外，规格要求 macOS 上有非受管的 `/etc/codex` 时拒绝启动（SIMA `check_codex_system_config`），这一项也没做。

### X-H2（高）本机令牌通过环境变量传给 Codex，会被工具子进程继承

令牌放在 `ONEX_CODEX_TOKEN_<id>` 环境变量里。Codex 执行 shell 工具时，默认把自己的环境传给子进程。员工或模型执行一句 `env`，就能拿到本机令牌，进而在 Codex 之外直接调用 router（费用照常记在员工名下，但绕过了 Agent 本身，没有对话回流）。规格的待测项：“沙箱和工具子进程不继承令牌”。

Codex 有 `shell_environment_policy`。较新的版本默认排除名字里含 `KEY`、`SECRET`、`TOKEN` 的变量，`ONEX_CODEX_TOKEN_*` 可能恰好被排除，但这不能靠巧合。要求：显式写 `-c shell_environment_policy.exclude=["ONEX_CODEX_TOKEN_*"]`（或者 `inherit="core"`），并加一个测试：子进程里执行 `env`，输出中不含令牌。这条要在 0.164.0 实物上验证。

同样的问题 Claude Code 也有（`ANTHROPIC_API_KEY` 在环境变量里），SIMA 用 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` 处理。OneX 的 Claude Code 启动是否设置了这个变量，需要另外核对。

### X-M1（中）config.toml 写在持久目录，多窗口共用一个文件

`config.toml` 写在 `agents/codex/codex/config.toml`（持久的 `CODEX_HOME`），每次启动都整个重写。其中的 `env_key` 每次启动都不一样。窗口 A 启动后，窗口 B 把文件里的 `env_key` 改成 B 的变量名。如果 A 里的 Codex 之后重新读取配置（新建 thread、切换模型或 resume 时可能会读），它会去找 B 的变量，而 A 的环境里没有这个变量，认证就会失败。规格要求“跨窗口不共写”。

注释说“每次 launch 用独立的 provider 名”，但代码里 `PROVIDER_ID` 固定是 `"onex"`。

`CODEX_HOME` 必须持久（rollout 和 resume 依赖它），所以建议：`config.toml` 只放与启动无关的固定内容（或者干脆不写），每次启动的值全部用 `-c` 传入。这样 X-H1 也一起解决了。

### X-M2（中）几个配置键没有出处

| 代码写的 | 依据 |
| --- | --- |
| `check_updates = false` | SIMA 用的是 `check_for_update_on_startup = false`。`check_updates` 没有出处，Codex 会忽略这个键，启动时照样检查更新 |
| `disable_response_storage = true` | 契约 v0.13 要求关闭服务端存储。这个键在旧版 Codex 里有，0.164.0 里是否还生效需要核对。Responses 请求体里 `store` 的实际值要由 router 测试断言 |
| `CODEX_DISABLE_AUTO_UPDATE=1` 环境变量 | 没有出处 |

SIMA 还写了 `model_context_window`、`model_reasoning_summary = "none"`、`web_search = "disabled"`，macOS 上加 `features.plugins = false`。其中 `web_search` 尤其要关：开启后 Codex 会在 Responses 请求里带托管工具 `web_search`，上游是 Chat 时无法转换，同协议转发时会让上游代为联网。

### X-M3（中）session_id 仍是随机 v4

和 Kimi 的 K-C2 相同。v0.13（`61f66ac`）要求 `UUID v5(设备, "codex:<thread id>")`，游标持久保存，续接时不重报旧内容。这条契约晚于 0b488a9，需要跟进。

### X-L1（低）XDG 变量没有重定向

规格要求 AppData、XDG、缓存、tmp 全部重定向。Unix 上没有设置 `XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_CACHE_HOME`。HOME 已经改成私有目录，大部分默认路径会跟着变，但员工 shell 里显式设置的 XDG 变量没有继承进来（`PASS_ENV` 不含它们），所以目前没有实际影响。建议照 SIMA 显式设置。

### X-L2（低，越界）`onex run` 只能启动 Claude Code

`edge/onex-cli/src/main.rs:112,125` 把 `claude` 和 `"claude-code"` 写死了。IPC 已经允许 codex，但 CLI 没有入口，sprint-2 验收里“Codex 受管启动”只能通过 IPC 测试完成。`onex-cli` 不在 codex 线的写入范围内，需要总督指派。

## 做对了的

- 令牌值不出现在 `config.toml` 和启动参数里，测试覆盖了这一点。
- `config.toml` 先写临时文件、fsync，再同目录 rename，权限 0600。
- 环境从空开始，只带终端相关变量和 PATH；个人认证变量和代理不继承；`NO_PROXY` 包含回环地址。
- Windows 上 USERPROFILE、APPDATA、LOCALAPPDATA、TMP、TEMP 都指向沙箱目录。
- `launch_done` 时从 `launch_tokens` 删除令牌（`ipc.rs:147`），退出后令牌失效。

# Codex 线验收（二）：router `/v1/responses`（dev/s2b-codex cda2c16）

只读静态审查，对象是 `edge/onexd/src/responses.rs`、`edge/onexd/tests/responses.rs`。对照契约 v0.13（`61f66ac`）的 Responses 入口补充和 `errors.md`。

## 结论：用量口径正确，但租约额度在 Responses 入口上基本不起作用，MVP 上游（openai_chat）的 Codex 会话可能跑不通

## 计费（高）

### R-H1 预留为 0，流式期间不估算花费，租约上限不起作用

- 预留：`max_output_tokens` 缺省时按 0 计（`responses.rs:147`）。v0.13（`61f66ac`）要求“没有时按 4096 输出 token 预留，但不超过当前租约剩余额度（最低 1 个 token）”。Codex 通常不发 `max_output_tokens`，所以预留只有估算输入那一部分。测试 `budget_exhausted_rejects_before_upstream` 的注释也说明了这一点。
- 流式实时花费：`/v1/messages` 的 `Meter` 按已收到的输出字节估算 `est_output`（`router.rs:917`），越过额度就断流。Responses 入口的 `check_budget` 只用 `rec.tokens`，而 `rec.tokens` 只在终态事件到达时才赋值：转 Chat 路径要等最后的 usage 帧，同协议路径要等 `response.completed`。同协议路径的 pump 里根本没有调用 `check_budget`。

结果：流式期间租约的实时花费一直是 0。并发请求都能放行，单条长输出也不会在额度处被中断，花费要等结束才计入，超租约差额（`overage_pending`）可能远超一个租约。这违反了“计费不超发”。

要求：按 v0.13 的规则预留；两条流式路径都按已收到的输出（文本增量和函数参数增量的字节数）估算实时花费，并在每个批次调用 `ticket.update`，复用 `router.rs` 的 `Meter`。

### R-H2 流中断时花费记为 0

客户端取消、cutoff 断流、上游中途断开时，终态事件没有到达，`rec.tokens` 仍是默认值，`cost_milli = 0`，`complete = false`。契约（usage 一行）明确要求：“`complete=false` 表示流中断、用量不全，cost 按已收到的部分计算，Server 记为待结算，不当作零”。

现在员工只要在输出快结束时取消，这次请求就是免费的。修 R-H1 的估算之后，结束时应当用 `max(上游报的用量, 估算值)`，与 `Meter::final_tokens` 相同。同协议非流式响应缺少 `usage` 时也是 0（只打了一条 warn），应当按估算值计费，并标 `complete = false`。

## 协议正确性（高，要用 0.164.0 实物验证）

### R-H3 转 Chat 时，流式 `response.output_item.done` 缺少字段

转 Chat 的流里，文本消息的 `output_item.done` 是 `{"type":"message","status":"completed"}`，没有 `role`、`content`、`id`（`responses.rs:1007-1011`）；终态事件 `response.completed.response.output` 里的文本是空字符串（`:883-884`）。

Codex 用 `response.output_item.done` 里的 item 写对话历史和 rollout。一个没有 `role` 和 `content` 的 message 无法按 `ResponseItem` 解析，很可能被丢弃。如果是这样，下一轮请求的历史里没有上一轮的助手回答，rollout 里也没有 `assistant_message`，采集和多轮对话都会出错。现有测试只检查了事件名，没有检查 item 的内容。

要求：`output_item.done` 和 `response.completed.output` 都带完整 item（`id` 与 `added` 一致，`role: "assistant"`，`content: [{type:"output_text", text: <累计文本>}]`）；补发 `response.output_text.done`、`response.content_part.added/done`；测试断言 `done` 里的 item 能按 Responses 的形状完整解析。

### R-H4 Codex 的工具和 input 类型在转 Chat 时会被整条拒绝

- 工具定义只接受 `type: "function"`，其余一律报错（`:406-408`）。Codex 根据模型族会发送 `custom` 类型的 `apply_patch`（freeform）、`local_shell`、`web_search`，`tools` 里只要有一个，整条请求就失败。
- input 只接受 `message`、`function_call`、`function_call_output`。`custom_tool_call`、`custom_tool_call_output`、`local_shell_call`、`reasoning` 都报错。v0.13 规定 `reasoning` 输入项**丢弃**，不是报错。

MVP 的上游 local qwen 是 `openai_chat`，所以 Codex 第一轮就可能失败。要求：用 0.164.0 实物抓一次请求体（工具列表和 input 类型），据此决定 `custom` 工具转成单字符串参数的 function，还是在受管配置里关闭它（同时修 X-M2，关闭 `web_search`）；`reasoning` 项改为丢弃；补测试。

### R-M1 并行工具调用转出来的消息序列不合法

每个 `function_call` item 单独变成一条 assistant 消息（`:355-361`），助手文本又是另一条。`[fc1, fc2, out1, out2]` 会变成 `assistant[tc1], assistant[tc2], tool1, tool2`。OpenAI Chat 要求带 `tool_calls` 的 assistant 消息后面紧跟每个 id 对应的 tool 消息，严格的上游会直接拒绝；vLLM 可能接受，但 Qwen 的对话模板渲染出来是错的。要求：把连续的 assistant 文本和 `function_call` 合并成一条带多个 `tool_calls` 的 assistant 消息。

### R-M2 `developer` 角色原样传给 Chat

`message` 的 `role` 原样传递（`:350-352`）。Codex 会发 `developer` 消息（权限和环境说明），很多 Chat 服务端和模型模板不认这个角色。建议转成 `system`。

## 错误形态（中）

### R-M3 `error.type` 固定为 `invalid_request_error`

v0.13：`type` 与 Anthropic 错误体用同一组取值（`billing_error`、`permission_error`、`invalid_request_error`、`api_error`）。`err_before_headers_block` 拿到了 `block_error` 的 kind，但丢弃了（`_kind`，`:290`）。`response.failed` 也固定是 `invalid_request_error`。结果是 `quota_exhausted`、`balance_exhausted` 都标成 `invalid_request_error`，Codex 可能当成请求本身有问题，不会提示员工去找管理员。

### R-M4 HTTP 状态与 `errors.md` 不一致

| 场景 | 代码 | errors.md |
| --- | --- | --- |
| `previous_response_id`、JSON 无效、缺 `model` | 400 `invalid` | 422 |
| 未知上游协议 | 501 `model_not_allowed` | 403 |
| 没有计价、没有密钥 | 503 `internal` | 500 |

### R-M5 同协议转发时也拒绝 `previous_response_id`

v0.13：“同协议转发时原样透传 `previous_response_id`、`store`、`include`、`reasoning` 等字段”，只有转 Chat 时才拒绝。代码在选路由之前就一律拒绝（`:56-64`），测试 `previous_response_id_is_rejected` 用的又正是同协议上游。受管配置关闭了服务端存储，Codex 一般不会发这个字段，但实现与契约相反。另外，转 Chat 时的提示应当说明“需要关闭服务端会话存储”（v0.13 原文）。

### R-M6 anthropic 上游的提示文案

v0.13 要求写明“该模型的上游协议暂不支持 Codex，请联系管理员调整路由”。代码写的是“OneX 暂不支持 Responses 转 Messages”，员工看不懂，也不知道该找谁。

## 其他（中、低）

- **R-M7 同协议 URL 会出现两个 `/v1`**：`format!("{}/v1/responses", base)`（`:122`）。`base_url` 以 `/v1` 结尾时（Chat 路由的配置通常就是这样）会得到 `/v1/v1/responses`。契约要求与 Chat 相同的规则，`chat::chat_url` 已经实现了，同协议路径没有用。测试的 `base_url` 不带 `/v1`，所以没有发现。
- **R-L1 同协议转发会带上客户端的所有头**：`forward_headers` 只去掉认证、hop-by-hop 和 cookie，`openai-organization`、`openai-project`，以及 Codex 配置里 `http_headers` 写的任意头都会发给上游。和 X-H1 结合，项目配置能往上游注入头。建议改成白名单（`content-type`、`accept`、`openai-beta`、`user-agent`）。
- **R-L2 非流式响应缺 `id` 时 `call_id` 是空串**：非流式转换里 `tc.get("id").cloned().unwrap_or_default()`（`:634`）会生成空字符串，流式路径会补一个 ID。建议统一补 ID。
- **R-L3 `output_item.added` 和 `done` 的 item `id` 不一致**：每次都调用 `id::new` 生成新 ID，两者对不上。

## 做对了的

- 用量口径：计费输入 = `input_tokens − cached_tokens`，`cached_tokens` 计入缓存读，reasoning 不重复计费；`cached_tokens > input_tokens` 时用 `saturating_sub`，不会出现负数；Chat 换算后与原生结果一致，测试覆盖了。
- 未发头时的错误体是 Responses 形状，不是 Anthropic 形状；已发头时写 `response.failed` 后结束流；不会重复发终态事件（`upstream_errored`）。
- anthropic 上游返回 `model_not_allowed`，不发上游请求（测试断言 `calls == 0`）。
- 转 Chat 时请求里的 `call_id` 原样保留；流式工具调用在见到工具名之前先缓冲参数片段。
- 上游密钥只放在请求头里，本机令牌不外传（测试断言上游收到的是上游 Bearer）。

## 需要补的测试（Responses）

1. 不带 `max_output_tokens`、租约剩余 100 时：预留不超过 100；一条超过额度的长流在额度处被中断；中断后 `cost_milli > 0` 且 `complete = false`。
2. 转 Chat 的流里，`output_item.done` 的 item 能按 Responses `message` 的形状完整解析，`text` 等于各段增量拼起来的结果。
3. input 为 `[assistant 文本, fc1, fc2, out1, out2]` 时，转出的 Chat 消息只有一条 assistant 消息，带两个 `tool_calls`。
4. `tools` 里有 `custom`、`local_shell` 类型；input 里有 `reasoning` 项。
5. `base_url` 以 `/v1` 结尾的同协议路由。
6. `quota_exhausted` 返回 402，`type` 为 `billing_error`。

## 需要补的测试（受管启动）

1. 启动参数里有 `-c model_provider=...`、`base_url`、`env_key`、`wire_api`、`project_doc_max_bytes=0`、`shell_environment_policy`。
2. cwd 的 git 根目录里有 `.codex/config.toml` 时，启动被拒绝（或被标为 untrusted）。
3. 连续两次启动后，第一次启动所用的 `env_key` 仍然能在它自己的配置来源里找到。
4. 用一个回显环境变量的假 `codex` 可执行文件，确认工具子进程的环境里没有令牌。这一项要在 0.164.0 实物上复核。
