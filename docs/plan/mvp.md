# MVP：最短路径到可人工操作

2026-11-19 用户要求：在最短时间先达成一个可人工操作的 MVP，不要再深入。本文件覆盖 sprint-1.md 中尚未完成部分的优先级；S1 的完整验收标准保留，MVP 之后再补。

## MVP 的定义

一个人在本机 Mac 上能完成下面这条链路，管理员在 211 的网页上看得到：

1. 管理员在 211 的管理端登录，看到租户、成员、Provider（local qwen）、倍率、橡皮余额。
2. 员工在本机用 `onex-cli login` 完成验证码登录和设备注册（**先不做 Tauri Desktop**），onexd 连上 211，收到配置、密钥和租约。
3. 员工运行 `onex-cli run claude-code`：onexd 用本机已安装的 Claude Code 二进制（**先不做下载和校验**），按 claude-code.md 的隔离方式启动，模型流量经本机 router 转成 OpenAI Chat 发到 local qwen。
4. 员工和 Claude Code 对话几轮。
5. 管理员在监察页实时看到对话正文和橡皮费用；余额用完时下一次请求被拒绝。

## 必须做（按负责方）

| 负责 | 任务 | 说明 |
| --- | --- | --- |
| edge | secret 解密 | 契约 v0.7“密钥下发”，没有它连不上 qwen |
| edge | S1-E3 会话采集，最小版 | 只读主会话 jsonl，user/assistant/tool_call/tool_result/gap 五类；子 Agent、压缩、图片先跳过（遇到就记 gap） |
| edge | S1-E4 启动 Claude Code，最小版 | 用 `PATH` 里的 `claude`，记录版本；隔离 `CLAUDE_CONFIG_DIR` 和 `HOME`，`--settings` 写本机 router 地址和令牌；不做下载、校验、resume |
| edge | `onex-cli login` 和 `onex-cli run claude-code` | 登录调用 Server HTTP API，设备注册后把 device_token 交给 onexd |
| server | 部署到 211 | 安装脚本已写好，总督执行第一次部署 |
| server | seed 出 MVP 数据 | 一个租户、一个 owner、一个员工、local qwen 的 Provider 和模型（`openai_chat`，`http://192.168.3.212:11516/v1`，模型 `Qwen3.8-27B`，无密钥时下发占位密钥）、倍率、1000 橡皮 |
| web | `read_content` 接入 | 已在契约中，server 交付后接入；其余不新增 |

## 推迟到 MVP 之后

Tauri Desktop（S1-E6）、Mac 安装包（S1-E7）、Claude Code 下载与校验、诊断与日志拉取（S1-E5、S1-S5）、审计查询页（S1-S6）、router 的三项小修（200 业务错误、禁用重定向、SSE 字节上限）、跨进程续租用例、AC-17、子 Agent 与压缩采集、其他四个 Agent。

监督员的复验暂停，MVP 跑通后再做一次整体验收。

## 原则

- 能用现有代码就不新写。每个任务以“能人工跑通”为完成标准，不追求覆盖所有边界。
- 但已经做对的安全边界不能退：密钥只在内存、正文读取写审计、计费不超发。
