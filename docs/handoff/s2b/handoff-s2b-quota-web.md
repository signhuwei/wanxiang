# S2B quota-web 交接（总督代写）

quota-web 线收尾时模型网关返回 429（额度用完），没能发出交接信。以下由总督按分支、工作树和测试结果整理。

- 已合入 `main`：S2B-W1 管理端配额（`f46b0e6`、`8ed0b4d`、`b988d60`，合入 `15e423a`），S2B-W2 真实 Server 联调脚本 `server/web/tests/quota-check.js`（`1f48483`，合入 `913909e`，总督用 `bun server/web/tests/quota-check.js` 跑通）。
- **进行中，未提交**：S2B-W3 监察页多 Agent，改动在工作树 `/Users/HHH/Code/OneX/wt/s2b-quota-web` 的 `server/web/format.js`、`server/web/observation.js`：
  - Agent 名称映射 `AGENT_LABELS`，会话台账加 Agent 列和 Agent 筛选，人员台账加最近 Agent 和配额状态列。
  - 阅读区 `compact` 显示“上下文已压缩”（summary 为 null 时），`gap` 显示“采集缺口：原因”。
  - 两处标了 `CONTRACT-PENDING`：`/observe/people` 还没有 `last_agent`、`quota_milli`、`month_used_milli`；`/observe/sessions` 还没有 `agent` 筛选参数，目前在客户端过滤当前页，分页数不准。要先给 Server 加字段和筛选参数（并写进契约 http-api.md 监察一节），再去掉客户端过滤。
  - 单测 48 通过；浏览器两档检查没跑。
- 已知问题（留给组管角色批次）：`/members` 不返回组名；`group_admin` 调 `/groups` 得 403。
