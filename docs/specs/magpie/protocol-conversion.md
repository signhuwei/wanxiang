# 四协议转换：Magpie 规格与 OneX 首轮子集

基线：Magpie `0e3d093611e8bd226e3136113aafd75f5d7f4914`。路径相对 `refs/magpie`，测试为静态取证，未运行。本文件按入口协议→IR→实际出口协议描述，不要求维护 12 个独立转换器；同协议优先保留原请求/响应形状，跨协议才承担已列出的语义损失。

## 请求

`parseTranslated`、`parseRequest` 和 `buildFor` 将路由决定与消息编解码分开。共同表示是 `Request` / `Message` / `Part` / `Tool`；保留有序正文、工具 ID、函数 schema、最大生成量、流标志及可映射的推理/缓存设置。路由选出的 wire model 覆盖上游模型名；客户端模型标签可独立保持。`decoderFor`/`makeEncoder` 用实际两端协议分派，非流走 `collector` + `render`。见 `internal/gateway/gateway.go:9529,9548,9922,9979,10042,10217,10230`、`internal/gateway/ir.go:38,136,171,183,716`。

| 协议 | 读入 IR / 自 IR 构建 |
| --- | --- |
| Anthropic Messages | 顶层 `system`（字符串或块）和有序 `messages`；`content` 的文本、图片、文档、thinking、tool_use/result 各是独立语义。目标 Anthropic 再写成 system 与 user/assistant block 序列，保留可用 `cache_control`；`stop_sequences`、`max_tokens` 和 thinking 设置按目标能力处理。读写见 `internal/gateway/anthropic.go:150,158,1012`。 |
| OpenAI Chat | `messages` 按 system/developer/user/assistant/tool 读取，可含文本或多模态 parts；指令与对话分离，`tool_call_id` 连接结果。写 `messages`，目标厂商决定 `max_completion_tokens` 或 `max_tokens`，流式请求 `stream_options.include_usage=true`；原生专有字段不自动透过异协议。见 `internal/gateway/chat.go:119,438,580,629,646`。 |
| OpenAI Responses | `instructions` 与 `input`（文本或有序 items）；message 与 function_call/output、reasoning 是不同 item。Responses→Responses 特殊路径可保留原生指令角色与元数据；跨协议按 IR 能力降级。服务端历史引用 `previous_response_id` 不是可以转发给另一个 API 的文本，跨协议要先取得完整前文或明确失败。写 `input`、`max_output_tokens`、tools；function schema 传 `strict` 语义。见 `internal/gateway/responses.go:339,1376,1652`、`internal/gateway/prev_response.go:332`、`internal/gateway/prev_response_test.go:110`。 |
| Gemini | `systemInstruction`、`contents[].parts`、角色 `user/model`、`generationConfig`、`tools[].functionDeclarations`、`toolConfig`；OpenAI/Anthropic 的 assistant 对应 model。用模型路径指定公共 API/Vertex 的模型；Code Assist 存在外层 envelope，不能当公共 API 的固定出参。同一个 renderer 不应混淆 camelCase 与其它协议的字段。见 `internal/gateway/gemini.go:140,152,193,271`、`internal/gateway/gateway.go:2459,9897,9979`。 |

边界：图片/文件应携带 MIME 与来源，不能任意把 URL、inline bytes 和厂商文件 ID 当等价；PDF 的正向样例在 `internal/gateway/pdf_translation_test.go:17,41,69,90`。推理强度和采样参数没有逐值全等；应区分“没要求”“关闭”“上游不支持”，而不是用一个常量覆盖；样例 `internal/gateway/wire_effort_test.go:42,104`。隐藏或加密推理属于签发上游及上下文，不能作为普通文本或跨供应商回放；Gemini thoughtSignature 可在无原生字段协议中关联到工具 ID，送回签发方前再解开。见 `internal/gateway/gemini_signature.go:61,134,460,506`、`internal/gateway/reasoning_carry.go:101,125`；签名跨回合和签发范围测试见 `internal/gateway/gemini_signature_test.go:109,153,204`、`internal/gateway/gemini_signer_test.go:259`。

## 流式事件

IR 区分 start、正文、thinking / signature、工具头、参数片段、usage、stop、error。**结束原因、传输终态和最终用量是不同状态**；保活不属于模型事件。非流式渲染复用同一语义，不能把截断流收集成成功 JSON。见 `internal/gateway/ir.go:466,501,727,795`、`internal/gateway/continuation.go:455,668`、`internal/gateway/gateway.go:9685,9698`。

| 目标协议 | 输出顺序和终态 |
| --- | --- |
| Anthropic | `message_start`（消息 ID/model 与可用输入用量）→按连续 index 写 `content_block_start`/`delta`/`stop`，块依次关闭；结束由 `message_delta`（`stop_reason`、usage）再 `message_stop`。文本、thinking、signature、`input_json_delta.partial_json` 不可混作文本。`length→max_tokens`，`tool→tool_use`，`filter→refusal`，一般完成→`end_turn`。见 `internal/gateway/anthropic.go:1407,1649,1668,1780,1852,1984`。 |
| Chat | role 首 chunk、`choices[].delta.content`/reasoning/`tool_calls[]`，然后 `finish_reason` 与可独立到来的顶层 usage，最后 `[DONE]`；长度/工具/过滤分别映射 `length`/`tool_calls`/`content_filter`。跨译只追一条 choice，不能把别的 index 的片段合进正文。见 `internal/gateway/chat.go:1467,1681,1693,1722,1746,1794`；多 choice、JSON 字符串 index、usage 先到见 `internal/gateway/translate_stream_test.go:39,74,92,110,148`。 |
| Responses | `response.created`，以 output index、item ID、content index（及 `sequence_number`）跟踪 item 生命周期。文本 delta，函数 arguments delta/done，reasoning 是不同事件；终态 `response.completed`、`response.incomplete` 或 `response.failed`，可附 `response.usage`。见 `internal/gateway/responses.go:1882,1919,1949,1980,2032,2222,2355,2502`。 |
| Gemini | SSE 数据为 `candidates[].content.parts`；单独表示 text、thought、functionCall 等，带候选 `finishReason` 和 `usageMetadata`，没有 `[DONE]`。`MAX_TOKENS` 和安全拒绝不能按普通完成；有工具调用时也需保留 parts 的工具语义。见 `internal/gateway/gemini.go:672,684,745,784,794,834`、`internal/gateway/codeassist.go:2061`、`internal/gateway/continuation.go:134`。 |

终态/截断测试：`internal/gateway/continuation_test.go:804,926,939`；断流 vs 完整回复：`internal/gateway/translate_severed_test.go:61,75,92`。用量归一化见同目录 `gateway.md`，不额外以输出片段数计费。

## 工具调用

| 协议 | 声明、执行请求与结果 |
| --- | --- |
| Anthropic | `tools[].name/description/input_schema`；`tool_choice` 支持 auto/none/any/指定工具的等价子集；assistant `tool_use{id,name,input}`，user `tool_result{tool_use_id,content,is_error}`。流中 input 由片段拼成对象，不能每片做 JSON 解析。`internal/gateway/anthropic.go:1012,1280,1473,1922`。 |
| Chat | `tools[].function`；`tool_choice` 采用 auto/none/required 或命名函数；assistant `tool_calls[].function.arguments` 是 JSON 字符串，流中按 index 路由片段，结果是 `role:tool` 和 `tool_call_id`。`internal/gateway/chat.go:438,580,746,1252,1467`。 |
| Responses | 平铺 function tool；`function_call.call_id` 与 `function_call_output.call_id` 配对，item ID 不能替代 call ID；arguments delta 可以先到，done 事件可带最终更完整的参数，Magpie 保留最后会使 JSON 闭合的片段等待终态校正。`allowed_tools` 按可调用 allowlist 处理，required 筛完为空即拒绝。`internal/gateway/responses.go:967,1652,1693,1740,1798,1955,1970`、`internal/gateway/gateway.go:9943,9956`。 |
| Gemini | `functionDeclarations`、`functionCallingConfig.mode` 与 `allowedFunctionNames`；parts 中 `functionCall{name,args}` / `functionResponse{name,response}`，需要保留同名并行调用的配对次序和可用 ID，返回能表示的对象；目标不等价的 schema 类型要转换或拒绝。见 `internal/gateway/gemini.go:69,271,698,784`、`internal/gateway/codeassist.go:779,1812`。 |

- Streaming 转换要按调用 index/ID 隔离并行片段；Anthropic 的块要封口，不能把相邻 tool call 的 JSON 拼到一起。重复/空 ID 只能在兼容规则下归一化，需保证下一轮 result 回指的一致性。测试 `internal/gateway/translate_stream_test.go:260,409,474`、`internal/gateway/chat_call_ids_test.go:142`。
- Agent 中断会话可能留下未配对 `tool_use`，供应商拒绝后续所有同一历史请求。Magpie 的 `pairToolMessages`/`pairToolBlocks`/`pairToolItems` 调整次序或构造明确的“未执行/未得到结果”占位，也处理孤儿结果；绝不把占位记录成真实工具完成。测试 `internal/gateway/tool_blocks_paired_test.go:68,108,132,156`、`internal/gateway/pair_tool_items_test.go:117,162`、`internal/gateway/join_tool_runs_test.go:292`。
- Server tools（web search、advisor）、远端 MCP、Responses custom tools、被签名的 reasoning 不与普通函数透明等价，应按 capability 决定原生通过、显式拒绝或单独实现。测试线索 `internal/gateway/custom_tool_test.go:71`、`internal/gateway/tools_need_responses_test.go:110`、`internal/gateway/advisor_test.go:131`、`internal/gateway/gemini_schema_test.go:102`。

## 错误

- 未提交 HTTP 头：保留/归类上游状态；Anthropic 包为 `type:error` + `error.type/message`，Chat/Responses 为 `error.message/type/code/param`，Gemini 为 `error.code/message/status`（如 429→`RESOURCE_EXHAUSTED`）。解析上游错误体应有长度上限。上游 context overflow 归一成客户端可理解的超上下文错误，和网关字节上限 413 区分。见 `internal/gateway/gateway.go:9634,11376,11394,11416,11442`。
- 已提交头：使用本协议错误事件，例如 Anthropic `event:error`、Responses `response.failed`，Chat/Gemini 写自身错误对象；不追加正常完成标志假装成功。还有上游 HTTP 200 的裸 JSON 错误、普通 SSE 中的 `error`、Responses 的 `response.failed` 和安全 stop；EOF 前无终态一般判为截断（只为已验证厂商启用例外）。见 `internal/gateway/gateway.go:8252,11227,11245`、`internal/gateway/sniff.go:116,128,280`、`internal/gateway/sse.go:19`。测试 `internal/gateway/sse_bare_test.go:48`、`internal/gateway/translate_severed_test.go:75`。
- **OneX 建议：** 日志记录结构化分类与关联 ID，不回显上游凭据或未经裁剪的错误正文。租约/橡皮耗尽不是虚构的上游 429；对 Agent 给可识别的本地拒绝，在管理端看到真实原因，并避免触发重放风暴。

## 第一轮最小子集（建议，待确认）

1. 只接 Claude Code 的 Anthropic Messages。Anthropic 兼容上游同协议转发（不去掉签名、tool blocks 或合法 cache 标志），用量旁路提取。支持真实版本实际发出的 `messages/count_tokens` 和发现请求，计数不作为付费；先用干净 Mac 确认这些请求。跨译首选 **Anthropic→OpenAI Chat→Anthropic**；Responses、Gemini、WebSocket、推理历史移植、服务端搜索与所有厂商容错不是首轮前置。
2. Anthropic→Chat 必有 system、文本对话、模型名与最大生成量、普通函数 schema、工具选择、并行调用/参数片段、后续 `tool_result`、正常/长度/工具/拒绝 stop、非流 JSON、SSE 和错误壳；上游模型支持图片且首轮验收需要时才加显式图像转换。支持厂商若要求推理回播、非标准工具或没有流式 usage，不应宣称与一般 Chat 兼容，先以 fixture 确认或禁用该能力。
3. 不使用“看起来能聊天”代替测试：两端都测一次有实际工具回合的闭环，测试 interleaved 参数与空尾、取消后再提交历史、缓存首尾帧、无 usage、响应中途断开/租约取消、上下文超限及首包后的错误。OneX 生产厂商验收另作授权，不属于本次只读分析。

待裁决：首轮 OpenAI 兼容是否包含 Responses-only 上游；Claude Code 首轮必须支持哪些多模态或 beta 能力；对断开的工具轮次选择明确占位修正还是先拒绝并提示重开。