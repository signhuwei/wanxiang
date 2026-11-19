# Magpie 本机网关：OneX Edge 参考规格

基线为 Magpie `0e3d093611e8bd226e3136113aafd75f5d7f4914`（`.git/HEAD` 一致），以下源码路径相对 `refs/magpie`。只读走查，未运行 Magpie、测试或模型。**Magpie 行为**与**OneX 建议**分开，后者不是已批准的产品决策。

## 监听、入口与鉴权

- 默认 `127.0.0.1:3425`。`ListenAndServe` 读取 TLS 配置、取得监听 socket、记录实际绑定，端口被占用时报出持有者（能识别时）。共享模式未固定 host 时扩大为 `0.0.0.0`；明确设置 `MAGPIE_ADDR` 的 host 时保留。HTTP 服务头部读取超时 30 秒、连接空闲超时 5 分钟，未设覆盖整条生成流的 `WriteTimeout`。监听成功不代表所有工具/账本状态就绪。见 `internal/gateway/gateway.go:49,819,834,905`、`internal/gateway/lan.go:31,499`。
- **客户端协议由方法和路径决定，头主要用于身份、版本、升级和会话归属，不按 User-Agent 猜请求协议。** `routes` 登记如下；兼容入口和非模型端点不需要跟进首轮。见 `internal/gateway/gateway.go:1046,1138,1199,1210,2459`。

| 协议 | 入口 |
| --- | --- |
| Anthropic Messages | `POST /v1/messages`，另有 `/messages`；`POST /v1/messages/count_tokens` 独立分流。 |
| OpenAI Chat | `POST /v1/chat/completions`，另有 `/chat/completions`。 |
| OpenAI Responses | `POST /v1/responses`，另有 `/responses`；同路径 GET 只用于 WebSocket Upgrade，普通 GET 不生成。 |
| Gemini | `POST /v1beta/models/{model}:generateContent`、`:streamGenerateContent`、`:countTokens`；最后一个冒号划分方法，流式由方法确定。`GET /v1beta/models` 独立列模型。 |

- 区分三种身份：Agent 归属、网关调用凭据、上游凭据。`agentOf` 先看路径标记，再看 `magpie-<agent>` token，再看特例及 UA（Claude Code 名下的 Codex 看 Codex turn 头）。`callerKey` 兼容 Bearer、`x-api-key`、`x-goog-api-key` 和 `?key=`；Magpie 对普通本机调用宽松，对远端、转发和浏览器另有 Host/Origin/共享/命名 key 检查。上游请求由 daemon 建造：其协议决定路径，鉴权来自选中 provider，不把客户端 token 当供应商密钥；Anthropic 上游设置 `anthropic-version` 并按适配规则处理其他头。见 `internal/gateway/gateway.go:51,62,103,6487,6494,6506,9876`、`internal/gateway/lan.go:784,901`、`internal/gateway/cors.go:50`。
- **OneX 建议：** 首轮仅监听 loopback，不照搬本机免验、LAN 共享或 query 密钥。OneX 启动的子进程携带短期本机令牌；归属从令牌绑定中取，头与 UA 只作诊断。先确认访问、租约和路由，再解密上游密钥；日志不记凭据。启动流程以 Route/Lease/监听全部就绪为准。

## 选路与重试

- `serve` 保留客户端请求名，取有效模型/别名，读取一次 upstream wire name 表，路由追踪分别记录请求名、计划名和实际上游返回名。候选不是一个 URL：包括 provider、账号/key、模型和可用协议。单模型走 `planPaused`（主路由加配置的 fallback）；组走 `planGroup`（对成员及账号排序），会话亲和按 provider/model 或组隔离，避免副任务更换主会话账号。过滤还要考虑禁用、能力、暂停和账号配额等；面向相同模型的 Chat/Responses/Anthropic 等端点不是同一个协议。见 `internal/gateway/gateway.go:2548,2562,2594,3187,3475,5897`、`internal/gateway/fallback.go:535`、`internal/gateway/routing.go:2495,2617,2654`。
- 优先同协议转发，不可同协议时由 `translate` 解析为 IR、选 provider 协议构建上游请求，再译回入口协议。并非等价于裸 TCP 隧道，同协议也可能修 model、工具片段和兼容字段。路径拼接因 provider 而异，例如 Gemini 公共 API/Vertex 路径带模型，Anthropic `/v1/messages`，OpenAI 路径接到配置好的 base 上。见 `internal/gateway/gateway.go:6861,7705,9548,9876,9922,9979`。
- 失败先分类（HTTP 状态、业务体、`Retry-After`、流中错误）：模型限额、账号额度、网络失败、内容拒绝不是同一个休眠范围；状态 200 也可能封装失败。尝试输出经 `holdWriter`，在**尚未提交真实回答**时可换候选；只有保持连接的注释可以先发，不等于已有模型输出。鉴别为瞬时失败时最后一个候选可再试，代码分别定义一般失败 2 次、限流 3 次的上限，不是所有 429/5xx 都盲试；等待可取消。上游连接在未能完整上传时的重放与业务重试分层。见 `internal/gateway/fallback.go:2048,2327,2343,2629,2806,3322`、`internal/gateway/routing.go:556,570,1490,2456`、`internal/gateway/gateway.go:3983,4789,5716`、`internal/gateway/upstream_stall.go:43`。
- 已经发出可见回答不能用另一份回答覆盖。Magpie 的窄例外是已知支持 prefill 的同路流续接，带已发前缀并消重，不是通用重放；不满足时以客户端协议报告截断/失败。见 `internal/gateway/continuation.go:298,356,364,384,433,455`、`internal/gateway/gateway.go:8252,11227,11245`。**OneX 建议：** 首轮不做自动续写。只在未产生语义输出、重放安全性可判定且租约/重试预算允许时重试；即使未对 Agent 输出，已送达上游的尝试也可能收费。服务端下发的已授权路由快照应固定到请求，紧急撤销用独立取消信号，不重新选择未授权 provider。

## 流读取、写回、背压与取消

- 同协议主路径边读上游、边嗅探用量、边写并 flush；一部分非流式 JSON 要整包检查。异协议流在 `streamTranslated` 中读取 SSE，按帧解码成事件并编码回客户端；非流式客户端可以由 collector 收拢上游流，若上游无视 `stream:true` 返回非流，通用转换路径会报错。`eventStream` 处理类型标头与实际流形状不一致的兼容情况。见 `internal/gateway/gateway.go:7693,7705,7978,8307,9655,9685`、`internal/gateway/continuation.go:455,668`。
- `readSSEAlive` 按行读，空行提交事件，拼接多条 `data:`（以 LF 相隔），`event:` 提供事件名，注释只刷新活动信号；EOF 提交最后一帧；适配被裸写成 JSON 行的错误。Scanner 的 32 MiB 上限是**单行**，并非事件总尺寸。发送按事件 flush，设 `text/event-stream` / `no-cache` / `X-Accel-Buffering: no`；Magpie 保活注释只带一个换行，避开有的客户端把空行误识成空事件。典型保活间隔 5 秒，保活不是进度，也不能延长租约。见 `internal/gateway/sse.go:15,24,28,80,112,124`、`internal/gateway/fallback.go:3322`。
- 主代理同步写/flush 自然向上游施加背压（从读写循环推断，不是对所有插件/包装器的内存保证）。上游请求使用客户端派生的 Context；写失败退出，等待检查 Context；取消不作为上游账号被限流或不健康的证据。传输独立控制上游响应头（普通请求 10 分钟）、上传无进展（90 秒；大上传另分传输策略）、HTTP/2 连接健康，不用一个固定短超时盖住整条生成流。见 `internal/gateway/gateway.go:4789,6487,7978`、`internal/gateway/upstream_transport.go:38,49,79,90`、`internal/gateway/upstream_stall.go:16,52,127`、`internal/gateway/retry_test.go:429`。
- **OneX 建议：** 帧/行/累计事件按字节设上限，转换和回流队列有界，慢客户端不能无限积压；慢 Server 不应阻塞 SSE，使用另一路持久化回流并明确磁盘满策略。握手、上传、首字节、帧间静默、下游写阻塞分别计时；保活只代表链路。客户端断开、截止时间、余额归零、租约过期或撤销都应唤醒阻塞读写、终止上游并结算已见用量。没发头用 HTTP 错误，已发头用该客户端协议的终止错误（下游已走则只落账）；不能假装正常完结。保活之后即使尚可换候选，也已不能改 HTTP 状态。

## 从响应提取用量

`usageSniffer` 在线窥读同协议 SSE，分块拼行、支持 CRLF、多行 data、无空行但 JSON 完整的兼容帧；非流 JSON 检查上限 8 MiB，SSE 侦听事件约 1 MiB，超过嗅探上限不是零用量。跨协议走 decoder/use 事件。`Usage.add` 合并累计快照的非零字段而非相加，避免 `message_start` + `message_delta` 双算或用占位零抹掉已有缓存统计；特定重启与缓存明细有例外。模型结束、错误及收到用量是独立信号。见 `internal/gateway/sniff.go:51,79,116,280,321`、`internal/gateway/ir.go:650,657`。

| 协议 | 用量位置与归一化 |
| --- | --- |
| Anthropic | JSON `usage`；SSE `message_start.message.usage` 与后续 `message_delta.usage`。`input_tokens` 已排除缓存；分别读 `cache_read_input_tokens`、`cache_creation_input_tokens`，若有 `cache_creation.ephemeral_5m_input_tokens`/`ephemeral_1h_input_tokens` 保留 TTL 分账（缓存写总量至少为明细和）；`output_tokens` 已包含供应商计入的思考；部分兼容商给 `output_tokens_details.thinking_tokens`。`iterations` 中 advisor 单独计，不叠进 executor 原用量。终止看 `message_stop` 或 `error`。见 `internal/gateway/sniff.go:243,280`、`internal/gateway/anthropic.go:1553,1595,1604`。 |
| OpenAI Chat | JSON 和 SSE chunk 顶层 `usage`，流式常见最后一个 `choices:[]` 的专用 chunk；请求支持时要求 `stream_options.include_usage`。读 `prompt_tokens`、`completion_tokens`、`prompt_tokens_details.cached_tokens`/`cache_write_tokens`、`completion_tokens_details.reasoning_tokens`；prompt 默认含缓存，扣出 read/write，reasoning 已在 completion。兼容 DeepSeek/Moonshot/Mistral 的缓存字段别名；Anthropic 式字段的总量口径在 Magpie 有启发式，OneX 应按已验供应商明确声明，不泛化。终止通常为 `[DONE]`，厂商例外通过尾帧策略。见 `internal/gateway/sniff.go:116,187`、`internal/gateway/chat.go:1160,1201`、`internal/gateway/continuation.go:195,211`。 |
| OpenAI Responses | 整包 `usage`，SSE 常在终态 `response.usage`（兼容顶层）；`input_tokens` 含缓存，扣 `input_tokens_details.cached_tokens`/`cache_write_tokens`；`output_tokens_details.reasoning_tokens` 属于 `output_tokens` 子集。`response.completed`、`.incomplete`、`.failed` 均为终态，但不是同一结果。见 `internal/gateway/sniff.go:204,280`、`internal/gateway/responses.go:1664,1680`。 |
| Gemini | `usageMetadata` 可在多帧出现，`promptTokenCount` 扣 `cachedContentTokenCount`；`candidatesTokenCount + thoughtsTokenCount` 得归一 output，`thoughtsTokenCount` 同时记作 reasoning 明细；未在此提取 cache-write。Gemini 无 `[DONE]`，看 candidate 的 `finishReason`（也要识别拒绝/空回复）。见 `internal/gateway/sniff.go:160`、`internal/gateway/continuation.go:134`。 |

Magpie 的每请求汇总记录路由、账期 token 拆分、状态、会话、上下游 request/response ID、延迟和尝试数；重试不会把最终请求重复变成多条成功账。默认本机 XDG-aware `usage.jsonl`；消息正文不写入这个用量文件，观察者是独立接口。见 `internal/gateway/gateway.go:5895`、`internal/usage/usage.go:285,314,325,553`。

**OneX 建议：** 计量与会话回流分开，原始协议字段带来源和字段存在性保存，标记 `complete / partial / missing / pending reconciliation`；缓存未知不当未命中，reasoning 子集不重复计入输出。Agent 所见的请求 ID、每次上游尝试 ID、服务模型、路由版本/租约 ID 与幂等结算键分开。`count_tokens` 是估算或预检，不是消费凭据。余额预留、入账和释放须有并发原子性；对于只在终帧回报用量的上游，未结算期间不可能仅凭实时 SSE 精确知道已花多少钱，首轮要明确预留/保守上限策略。

## 首轮验收线索与待裁决

用本地假 upstream 固定复现：同协议 Anthropic 和 Anthropic→Chat；分块/CRLF、多 data、保活、客户端半途取消、慢读取、错误 200、EOF 无终态、首包前有限重试、首包后不重放、租约在写阻塞中撤销、缓存 TTL 跨帧保留、无尾 usage 待结算。Magpie 测试参照 `internal/gateway/keepalive_test.go:38`、`internal/gateway/held_keepalive_test.go:137`、`internal/gateway/passthrough_severed_test.go:287`、`internal/gateway/usage_cache_split_test.go:78`。待裁决：首轮“OpenAI 兼容”是否只指 Chat；usage 缺失及断流尝试的预留与最终扣账口径；哪些失败允许自动换路及 Server 失联时哪些已租约路由继续有效。