# S1-E3 会话事件捕获：设计说明

依据：`contracts/edge-ws.md` v0.5「会话事件」一节，`docs/specs/agents/claude-code.md` 第 5 节。对话来自 Claude Code 自己写的会话文件，不从模型请求里拼接；router 只管用量。标 **待定** 的地方需要用 2.1.308 的真实会话文件核对后再定。

## 识别会话

- 只采集 OneX 启动的会话。S1-E4 启动时传 `--session-id <uuid>`，并在本地登记 launch：`launch_id`、`session_id`、受管 `CLAUDE_CONFIG_DIR`、cwd、本机令牌。会话身份来自这条登记，不信文件里的自称。
- 文件位置：在 `$CLAUDE_CONFIG_DIR/projects/*/` 下找 `<session_id>.jsonl`，不自己推算项目目录名的转义规则。
- router 用量关联：本机令牌每个 launch 一个，router 由令牌查到 launch，再填 usage 的 `session_id`。请求头和 `metadata` 里的会话信息只记诊断日志。
- 只打开普通文件：拒绝符号链接、所有者不是当前用户的文件。记下 `(dev, inode)`。

## 只提取新增内容

- 每个会话一个游标：`(session_id, dev, inode, offset)`。每次从 offset 读到最后一个换行；没有换行的半行留到下次。
- 一行解析成零到多条事件，每条带 `source_offset`（行首偏移）和行内序号。游标推进、事件写入 outbox、分配 seq 在同一个 SQLite 事务里提交（游标表放进 `outbox.sqlite`）。崩溃后从旧游标重读，得到同样的事件，不重不漏。
- 触发方式：对登记的活跃会话每 1 秒检查一次文件大小；router 一个请求结束时也立即检查一次。不引入文件监听依赖。进程退出后再读一次，收延迟的尾写，然后发 `session_end`。
- 缺口：读到坏 JSON、`sessionId` 与登记不符、未知 `type`、文件变短（size < offset）、inode 变了，都发 `kind: "gap"`，payload `{reason, offset}`。截短和替换时从新文件开头重读，前面的缺口不补。单行超过 16 MB 记 `gap{reason:"line_too_large"}` 并跳过。

## 行到事件的映射

| 会话文件中的行 | 事件 |
| --- | --- |
| 第一行，或首次见到该会话 | `session_start`（agent、agent_version、cwd_hash、model） |
| `type:"user"`，内容是文本 | `user_message` |
| `type:"user"`，内容是 `tool_result` 块 | 每块一条 `tool_result`（`tool_call_id`、`output`，超过 64 KB 截断并标 `truncated`） |
| `type:"assistant"` 的 `text` 块 | `assistant_message`（content、model、stop_reason） |
| `type:"assistant"` 的 `tool_use` 块 | 每块一条 `tool_call`（tool、input，另带 `tool_call_id`） |
| `thinking`、`redacted_thinking`、`signature` | 丢弃，不回流 |
| 图片块 | 只回 `{type:"image", media_type, bytes}`，不回 base64（**待定**：管理员是否需要看图） |

payload 另带原始行的 `uuid` 和 `parentUuid`，Server 可以据此重建顺序和分支。

## 子 Agent 和压缩上下文

- 子 Agent（Task 工具）：带 `isSidechain: true` 的行照常转成事件，payload 加 `sidechain: true` 和所属 agent 标识，管理员界面可以折叠。**待定**：2.1.308 把子 Agent 写在同一文件，还是写到单独的文件（例如 `<session_id>/subagents/*.jsonl`）。如果是单独文件，按同样的游标规则登记为同一会话的附属文件。
- 压缩上下文（`/compact` 或自动压缩）：会话文件是追加写的，压缩不会删除旧行，所以不需要特殊处理增量。压缩产生的摘要行（**待定**：`isCompactSummary`、`type:"summary"` 或 `compact_boundary` 的具体形状）转成一条 `kind:"compact"` 事件，不当作用户输入。这需要在契约里加一个 kind，见下方问题 1。
- `--resume`：同一 session_id 继续写同一个文件时，游标照常继续。**待定**：resume 会不会改写或复制文件；如果 inode 变了，按替换处理并记 gap。

## 本地存储和顺序

- 事件和 usage 共用 outbox 的 seq，按现有的 events_ack、72 小时保留、补传逻辑回流。outbox 超过 500 MB 时停止接受新的模型请求（契约「离线」一节），router 返回中文错误。
- 正文落盘加密：**待定**，密钥放钥匙串需要 S1-E6 的 Desktop 配合，S1-E3 先明文存在 0600 的 `outbox.sqlite` 里。

## 需要总督决定

1. 契约加 `kind:"compact"`（payload：summary 文本、`source_offset`），还是把压缩摘要当成 `assistant_message` 并加 `compact: true` 标记。
2. `tool_call` 的 payload 加 `tool_call_id`（契约目前只有 tool、input），否则 Server 无法把 tool_result 配对到调用。
3. 图片只回元数据是否可以。
4. 子 Agent 和 resume 的文件形状要看 2.1.308 的真实样本。有没有可用的样本会话文件？没有的话，我先用合成样本写测试，适配器按版本保留样本，以后补真实样本。
