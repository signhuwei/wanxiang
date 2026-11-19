# S2 测试用例：Anthropic Messages → OpenAI Chat → Anthropic SSE

依据 [四协议转换规格](protocol-conversion.md) 和 [冲刺计划](../../plan/sprint-1.md)的「S1 范围决定」。本表只测 `POST /v1/messages` 入口和 `POST /v1/chat/completions` 上游；S1 仍只做同协议透传。本表不把 Chat 兼容承诺外推到 Responses、Gemini、`count_tokens`、厂商 beta 或签名回放。测试出处相对 `refs/magpie`，基线 `0e3d093611e8bd226e3136113aafd75f5d7f4914`；**直接**指相同方向的整链路或编解码测试，**移植**指借用另一方向或单层断言，**新增**指 OneX 需要独立覆盖。以下是缩减后的合成夹具，未运行。

## 夹具约定

默认入口 JSON 为 `A`，表中修改项覆盖默认值。标准 Chat 假上游只配置一个路由：`local-m → wire-m`，支持普通函数、流式用量与 `max_tokens`；另列 `max_completion_tokens` 的能力变体。不调用真实模型，不执行夹具中的函数；工具结果由测试注入。

```json
{"model":"local-m","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hello"}]}
```

- `C(i,d[,r])`：一个 `data:` 事件，JSON 为 `{"id":"chatcmpl-1","model":"wire-m","choices":[{"index":i,"delta":d,"finish_reason":r}]}`；省略 `r` 时为 `null`，`i=省略` 时省去该字段。`T(i,s)` 是 `C(i,{"content":s})`，`R(r)` 是 `C(0,{},r)`。`U(p,c,…)` 是 `data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":p,"completion_tokens":c,…}}`；`D` 是 `data: [DONE]`。每个事件以空行分隔，箭头表示发送顺序，不表示 TCP 分块。
- `F(i,id,name,args)` 是 `delta.tool_calls` 的一个元素：`{"index":i,"id":id,"type":"function","function":{"name":name,"arguments":args}}`；`P(i,args[,id])` 是续片：只带 `index`、`function.arguments` 和可选的重复 `id`。表中 `F`、`P` 单独出现即包入 `C(0,{"tool_calls":[…]})`；`args` 为 JSON **字符串**中的参数片段，不是直接嵌入的对象。`tool(name,k)` 表示 Anthropic 工具定义，`input_schema` 是含字符串属性 `k` 的对象；`tool(name,∅)` 为无属性对象。
- `S` 是 `message_start`，含 `message.type=message`、`role=assistant`、非空 `msg_…` ID、空 `content`、空 `stop_reason`。`B₀(text)→X₀("Hi")→E₀` 表示 index 0 的 `content_block_start`（`{"type":"text","text":""}`）、`content_block_delta`（`{"type":"text_delta","text":"Hi"}`）和 `content_block_stop`。`Bᵢ(tool,id,name)` 的块为 `{"type":"tool_use","id":id,"name":name,"input":{}}`，`Jᵢ(s)` 为 `{"type":"input_json_delta","partial_json":s}`；其中每块拼接后的参数必须是一个 JSON 对象。`Bᵢ(thinking)` 搭配 `Kᵢ(s)`（`thinking_delta`）。`M(reason; in,out)` 是 `message_delta`，含 `delta.stop_reason`、`delta.stop_sequence=null` 和已知最终用量；`Z` 是 `message_stop`。`ERR(type,text)` 表示 `event: error` 加 `data: {"type":"error","error":{"type":type,"message":text}}`，文本匹配关键短语，允许附加归一化错误码。
- 对照解析后的 SSE JSON，不比较键顺序、可选字段或允许的保活注释。成功只有一个 `S`、一个 `M`、一个 `Z`，块索引从 0 递增且不在关闭后复用；`Z` 后不追加 Chat `[DONE]`。截断或 SSE 错误不能产生成功 `M`/`Z`。终态和计量完整性分别断言：`S` 的协议占位零不算已收到真实用量；累计快照取最终值，不把各帧相加。

## 用例表

| ID / 场景 | Anthropic 输入及 Chat 出站断言 | 假上游 Chat SSE 片段 | 期望 Anthropic SSE / 旁路断言 | Magpie 测试出处 |
| --- | --- | --- | --- | --- |
| AC-01 · 普通文本与尾用量 | `A` 加 `system:"be brief"`、`stop_sequences:["END"]`。Chat 出站到 `/v1/chat/completions`，`model=wire-m`、`messages=[system,user]`、`stop=["END"]`、`stream=true`、`stream_options.include_usage=true`；上限为 `max_tokens:64`，现代能力变体仅发 `max_completion_tokens:64`。假上游只收到 fixture Provider 的凭据，不转发客户端本机令牌。 | `C(0,{"role":"assistant"}) → T(0,"Hi ") → T(0,"there") → R("stop") → U(10,5) → D`。 | `S → B₀(text) → X₀("Hi ") → X₀("there") → E₀ → M(end_turn;10,5) → Z`。等待尾用量，不能在 `R` 发 `Z`；只有一次成功结算。用同步门验证尾帧尚未放行时能先收到文本。 | 直接：`internal/gateway/gateway_test.go:471–526` 的路径、鉴权、system、输出块与尾用量；`stop`/上限能力变体按 `internal/gateway/chat.go:631–663` 新增。 |
| AC-02 · 多 choice 隔离 | `A`。出口仅请求一个回答；模拟上游仍回多个 choice。 | 第一帧 `choices=[{"index":"1","delta":{"content":"Hel"}},{"index":0,"delta":{"content":"wrong"},"finish_reason":"tool_calls"}]`；第二帧 `C(1,{"content":"lo"},"stop") → U(7,2) → D`。 | `S → B₀(text) → X₀("Hel") → X₀("lo") → E₀ → M(end_turn;7,2) → Z`，无 `wrong`、无工具块；字符串 `"1"` 与数字 `1` 指同一 choice。 | 移植：`internal/gateway/translate_stream_test.go:39–105`（Chat 解码器 / Responses 输出）。 |
| AC-03 · 前置用量不抢占 choice | `A`。 | `U(7,0) → C(省略,{"role":"assistant"}) → T(1,"Hel") → T(0,"wrong") → C(null,{"content":"lo"}) → C(1,{},"stop") → U(7,2) → D`。 | `S(message.usage.input_tokens=7) → B₀(text) → X₀("Hel") → X₀("lo") → E₀ → M(end_turn;7,2) → Z`。首尾输入是同一累计值，不计成 14；前置用量不选 choice，null 延续已选 choice。 | 移植：`internal/gateway/translate_stream_test.go:110–164`（Responses 输出）；前置输入写入 `S` 见 `internal/gateway/chat.go:1510–1520`。 |
| AC-04 · 单工具及重复 ID | `A` 加 `tools:[tool("lookup","city")]` 和 `tool_choice:{"type":"tool","name":"lookup","disable_parallel_tool_use":true}`。出站为嵌套 `tools[].function`（`parameters` 等于 `input_schema`）、命名 `tool_choice.function.name=lookup`、`parallel_tool_calls=false`。另测 `auto/none/any → auto/none/required`。 | `F(0,"call_1","lookup","") → P(0,"{\"city\":","call_1") → P(0,"\"SZ\"}","call_1") → R("tool_calls") → U(10,5) → D`。 | `S → B₀(tool,call_1,lookup) → J₀("{\"city\":") → J₀("\"SZ\"}") → E₀ → M(tool_use;10,5) → Z`。重复 ID 不开新块；只拼该块的参数。锁住第二片前验证首片已发出，不等完整 JSON 才开始流式。 | 直接编解码：`internal/gateway/translate_stream_test.go:329–363`；请求断言参考 `internal/gateway/gateway_test.go:483–506` 和 `internal/gateway/chat.go:680–701`。 |
| AC-05 · 交错并行工具 | `A` 加 `tools:[tool("lookup","city"),tool("stock","sku")]`，允许并行。 | `F(0,"call_a","lookup","{\"ci") → F(1,"call_b","stock","{\"sk") → P(0,"ty\":\"SZ\"}") → P(1,"u\":\"p1\"}") → R("tool_calls") → U(10,8) → D`。 | `S → B₀(tool,call_a,lookup) → J₀* → E₀ → B₁(tool,call_b,stock) → J₁* → E₁ → M(tool_use;10,8) → Z`。`J₀*` 拼出 `{"city":"SZ"}`，`J₁*` 拼出 `{"sku":"p1"}`；允许缓冲后开的工具，不要求其分片与上游逐片相同。 | 直接编解码：`internal/gateway/translate_stream_test.go:390–404,474–500`。 |
| AC-06 · 工具结果回指，闭环第二轮 | 复用 AC-05 的首轮 `messages` 和 `tools`；追加 `assistant` 的两个 `tool_use`（原 ID 和解析参数），再追加 `user.content=[tool_result(call_b,"in stock"),text("summarize"),tool_result(call_a,"Shenzhen")]`。Chat 中是一条 assistant 含两个 `tool_calls`（字符串 `function.arguments`），接两条 `role:tool`（按调用次序 `call_a`、`call_b`），最后接 user 文本；按 ID 配对，不能按返回位置配对。 | `T(0,"Shenzhen: in stock") → R("stop") → U(20,4) → D`。 | `S → B₀(text) → X₀("Shenzhen: in stock") → E₀ → M(end_turn;20,4) → Z`，无新工具块，无凭空补造结果。 | 直接路径：`internal/gateway/gateway_test.go:483–506`；多工具次序移植自 `internal/gateway/chat_tool_pairing_test.go:108–127`。 |
| AC-07 · 非法字符的工具 ID 往返 | `A` 加 `tools:[tool("lookup","city")]`。第二轮照 AC-06 的回指方式发单工具，`tool_use.id` 和 `tool_result.tool_use_id` 均填客户端观测到的 `<safe>`。 | 第一轮 `F(0,"tool:1#x","lookup","{\"city\":\"SZ\"}") → R("tool_calls") → U(5,5) → D`；第二轮 `T(0,"OK") → R("stop") → U(12,2) → D`。 | 第一轮 `S → B₀(tool,<safe>,lookup) → J₀* → E₀ → M(tool_use;5,5) → Z`；`<safe>` 匹配 `^[A-Za-z0-9_-]+$`，不锁定 Magpie 的编码前缀。第二轮 Chat 出站的调用与结果均回指 `tool:1#x`；客户端 `S → B₀(text) → X₀("OK") → E₀ → M(end_turn;12,2) → Z`。合法的 `call_1` 则原样往返。 | 直接：`internal/gateway/anthropic_call_ids_test.go:110–172`；第二轮文本回复是新夹具。 |
| AC-08 · 长度截断是正常协议终态 | `A` 将 `max_tokens` 改成 8。 | `T(0,"Half an answer") → C(0,{},"length") → U(10,8) → D`。 | `S → B₀(text) → X₀("Half an answer") → E₀ → M(max_tokens;10,8) → Z`，不是 `end_turn`，不是传输 `ERR`，不重发。 | 直接：`internal/gateway/chat_length_nothing_test.go:192–217`。 |
| AC-09 · 有正文后内容过滤 | `A`。 | 先 flush `T(0,"partial")`，确认下游收到正文，再发 `C(0,{},"content_filter") → U(10,2) → D`。 | `S → B₀(text) → X₀("partial") → E₀ → M(refusal;10,2) → Z`，不将 `finish_reason` 变成成功 `end_turn`，也不改为 SSE `ERR` 或换路。本例不规定首帧即拒绝的 HTTP 策略。 | 移植：`internal/gateway/refusal_test.go:317–337,387–402`（已有正文时的拒绝和帧分类），映射见 `internal/gateway/chat.go:1681–1691`、`internal/gateway/anthropic.go:1668–1678`。 |
| AC-10 · 缓存与推理计量 | `A`。该路由声明 Chat `prompt_tokens` 含缓存读写；不依赖字段名猜口径。 | `T(0,"OK") → R("stop") → U(1000,120,"prompt_tokens_details":{"cached_tokens":700,"cache_write_tokens":100},"completion_tokens_details":{"reasoning_tokens":100}) → D`。 | `S → B₀(text) → X₀("OK") → E₀ → M(end_turn;200,120) → Z`，`M.usage` 另含 `cache_read_input_tokens:700`、`cache_creation_input_tokens:100`、`output_tokens_details.thinking_tokens:100`；输出不是 220，无 TTL 数据不虚构 TTL，无推理正文不造 thinking 块。 | 移植用量字段：`internal/gateway/prompt_cache_test.go:143–164`；直接推理计量：`internal/gateway/anthropic_thinking_tokens_test.go:73–94`。 |
| AC-11 · `[DONE]` 后上游不断开 | `A`。 | `T(0,"OK") → R("stop") → U(9,4) → D`；上游 flush `D` 后保持连接，直到收到取消。 | `S → B₀(text) → X₀("OK") → E₀ → M(end_turn;9,4) → Z` 在上游主动关连接前到达；上游读取停止并关闭。不靠固定 sleep 判定，用「已发 D、仍开放」的同步门和独立超时。 | 移植：`internal/gateway/continuation_test.go:804–872`（Responses 客户端）。 |
| AC-12 · 完成但缺尾用量 | `A`。 | `T(0,"OK") → R("stop") → D`，全程无 `usage`；变体先发 `U(7,0)` 作为前置输入快照，仍无最终用量。 | `S → B₀(text) → X₀("OK") → E₀ → M(end_turn;缺失或仅已见) → Z`。协议可用占位，不填估算的「实际」输出。计量侧 `complete=false`、按已见部分待结算，不记录为已确认的零消费。 | 直接终态参考 `internal/gateway/keepalive_test.go:51–52,63–86`；新增 OneX `complete=false` 断言，见 `wanxiang/contracts/edge-ws.md:48`。 |
| AC-13 · 响应中途掉线 / 无终态 | `A`，假上游仅收一次请求；第一段等到下游看见再断。 | `T(0,"hel") →` 字节 `data: {"id":"chatcmpl-1","cho` 后中断 HTTP body（不足宣告长度）；变体只在完整 `T` 后 clean EOF，且没有 `R`/`D`（夹具声明严格终态）。 | 已提交 HTTP 200：`S → B₀(text) → X₀("hel") → E₀ → ERR(api_error,流中断或未完整)`，不得泄漏半帧或发 `M/Z`；计量 `complete=false`。严格 clean EOF 是建议验收策略；Magpie 对部分 Chat 上游容许无终态的 clean EOF，不照抄。 | 移植：`internal/gateway/passthrough_severed_test.go:154–176`（Chat 透传）和 `internal/gateway/translate_severed_test.go:75–88`（反向转换）；clean EOF 差异 `internal/gateway/continuation.go:179–202`。 |
| AC-14 · 200 流内错误，不伪装成功 | `A`。 | 先 flush `T(0,"partial")`，下游见正文后发 `data: {"error":{"type":"upstream_error","message":"fixture upstream failure"}}`；变体改成相同 `data` 的字符串形状 `{"error":"fixture upstream failure"}` 或省去 `data:`（单行 JSON 后 EOF）。 | HTTP 已为 200：`S → B₀(text) → X₀("partial") → E₀ → ERR(api_error,fixture upstream failure)`；后续即使收到 `D` 也不得发 `M/Z`。不能把具体报错吞成 generic EOF，不重发请求。 | 移植：`internal/gateway/stream_error_shape_test.go:109–151`（Chat 读取与 Anthropic 输出分别有覆盖）；裸行解析 `internal/gateway/sse_bare_test.go:62–74`。 |
| AC-15 · 流开始前 HTTP 错误 | `A`（下游不预先提交头或保活）。 | 无 SSE：HTTP 400，JSON `{"error":{"code":"context_length_exceeded","message":"Input exceeds the context limit"}}`。 | **无 Anthropic SSE**；HTTP 400，`Content-Type: application/json`，`{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: …"}}`。不发 `S/M/Z`，区分输入超窗与网关字节限制 413。 | 移植错误编码：`internal/gateway/toolong_test.go:15–53`。 |
| AC-16 · SSE 分帧与保活 | `A`。同一 fixture 加入 LF、CRLF、拆 UTF-8 字节三种传输读法，事件语义不变。 | `T(0,"你好") → : keepalive → R("stop") → U(4,2) → D`；变体将 `T` 的合法 JSON 在 `choices` 前的字段逗号处断开，写成同一事件的两行 `data:`；在字节层切开 CRLF 和 `好`。 | 除合法注释或 `S` 后的 `ping`，为 `S → B₀(text) → X₀("你好") → E₀ → M(end_turn;4,2) → Z`；保活不能生成正文或延长业务截止时间。 | 直接保活：`internal/gateway/keepalive_test.go:38–94`；拆分移植 `internal/gateway/sse_bare_test.go:48–74`，多行与 UTF-8 组合为新增。 |

## AC-01 完整 SSE 示例

Chat 上游在每一帧后 flush（例中省去可选 `object` 和 `created`）：

```text
data: {"id":"chatcmpl-1","model":"wire-m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Hi "},"finish_reason":null}]}

data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"there"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}

data: [DONE]

```

Anthropic 客户端的语义 golden 如下。此处示例把 `model` 保留为客户端请求名；计量另外记录实际服务模型。`S` 的零仅为占位。

```text
event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"local-m","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":10,"output_tokens":5}}

event: message_stop
data: {"type":"message_stop"}

```

## 扩展用例（按上游能力启用）

| ID / 场景 | Anthropic 输入及 Chat 出站断言 | 假上游 Chat SSE 片段 | 期望 Anthropic SSE / 旁路断言 | Magpie 测试出处 |
| --- | --- | --- | --- | --- |
| AC-17 · 可展示的推理摘要 | `A` 加 `thinking:{"type":"enabled","budget_tokens":2048}`；fixture 声明该模型支持可展示的推理摘要，不约定所有模型都用同一 `reasoning_effort`。 | `C(0,{"reasoning_content":"brief thought"}) → T(0,"OK") → R("stop") → U(5,12,"completion_tokens_details":{"reasoning_tokens":10}) → D`。 | 启用摘要时 `S → B₀(thinking) → K₀("brief thought") → E₀ → B₁(text) → X₁("OK") → E₁ → M(end_turn;5,12) → Z`，推理明细为 10，不伪造签名；不允许展示时只有文本块，仍保留真实计量。 | 直接：`internal/gateway/gateway_test.go:471–488,508–526`、`internal/gateway/anthropic_thinking_tokens_test.go:73–94`。 |
| AC-18 · 非流式客户端复用 SSE 解码 | `A` 改 `stream:false`。若采用聚合方案，Chat 出站仍发 `stream:true`。 | `T(0,"OK") → R("stop") → U(3,1) → D`；错误变体同 AC-13。 | **无 Anthropic SSE**；成功为单个 Anthropic `message` JSON，`content=[{"type":"text","text":"OK"}]`、`stop_reason=end_turn`、`usage` 为 3/1；掉线不返回半份成功 JSON。 | 直接非流用例：`internal/gateway/chat_length_nothing_test.go:221–225`；SSE 聚合及中断移植 `internal/gateway/stream_only_test.go:16–44`、`internal/gateway/translate_severed_test.go:61–70`。 |

实现顺序建议先跑 AC-01、04–06 打通普通聊天与工具闭环，再补终态、错误和计量。用可控 fake upstream 验证 flush 顺序与准确的出站请求次数，再用获授权的实际 Provider 样本确认能力开关。断开的工具历史如何跨译（拒绝还是有标识的占位修复）、各厂商无 `[DONE]` 的例外和多模态范围留给 S2 决定；本表不把 S1 同协议的原样转发规则当作跨译修复授权。
