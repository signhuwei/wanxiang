# Claude Code 2.1.311 会话文件结构（只有字段名，不含正文）

来源：本机 Claude Code 2.1.311 的会话文件，2026-11-19 由总督提取。只记录行类型和字段名，没有复制任何对话内容。OneX 固定的版本以 S1-E4 下载的版本为准，这份只作参考。

## 文件位置

- 主会话：`<CLAUDE_CONFIG_DIR>/projects/<项目目录>/<sessionId>.jsonl`
- 子 Agent：`<CLAUDE_CONFIG_DIR>/projects/<项目目录>/<sessionId>/subagents/agent-<agentId>.jsonl`，旁边还有 `.forked-skill.json`、`.marker.json` 等非 jsonl 文件，忽略。子 Agent 写在单独的文件里，不在主文件中。

## 行类型（type 字段）

对话行，带 `uuid`、`parentUuid`、`sessionId`、`timestamp`、`isSidechain`、`message`：
- `user`：可能有 `isMeta: true`（系统注入，不是用户输入）、`promptId`、`origin`、`promptSource`
- `assistant`：带 `requestRef`、`requestedModel`、`apiBlockIndex`
- `attachment`：带 `attachment`、`rendered`、`renderedRole`
- `system`：带 `subtype`，见到的有 `stop_hook_summary`、`turn_duration`、`informational`、`away_summary`、`local_command`、`scheduled_task_fire`

子 Agent 文件里的对话行另带 `agentId`，`isSidechain: true`。

非对话行，没有 `uuid`（多数只有 `sessionId` 和 `type`）：
`custom-title`、`ai-title`、`agent-name`、`mode`、`permission-mode`、`atis-latch`、`last-prompt`、`tools-used`、`queue-operation`、`file-history-snapshot`、`file-history-delta`、`api-request-shape`、`api-request-blob`、`api-request`

注意：`api-request-blob` 和 `api-request` 里有完整的模型请求，不能回流。

部分行同时带 `sessionId` 和 `session_id` 两个字段。

## 本机样本里没有见到的

`isCompactSummary`、`compact_boundary`、`type: summary`。压缩相关的形状仍需真实样本核对。
