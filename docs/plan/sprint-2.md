# S2 Windows 与内测发包

2026-11-20 用户确认，RC3 由另行安排的人完成手测。S2 从 `37f5159` 并行开工，签名公证继续挂起。

## 首批交付

1. Windows x64 原生 Desktop、onex、onexd 和内测安装器，保留同一租户登录、受管 Claude Code、会话和费用回流路径。开发在现有工作区进行。Windows 上的 Codex 从 Git 拉取固定提交，原生完成编译、回归和安装器打包，提交摘要和验证结果。
2. 平台管理员上传安装包，填写版本和适用系统，查看校验结果后发布，可以下架。Mac arm64 和 Windows x64 各有一个当前版本。
3. 员工在登录前从 `/download` 下载本系统当前版本。先用实际 Mac RC3 验证上传、发布、字节核对、下架，再用 Windows 产物完成同样的链路。

## 并行分工

| tmux 窗口 | 交付 | 写入范围 |
| --- | --- | --- |
| `windows` | Windows 兼容、原生安装器、原生编译与测试指令 | `edge/`、`deploy/windows/` |
| `release-api` | 发布元数据、上传校验、私有存储、审计、员工 API | `server/src/`、`server/migrations/`、`server/test/` |
| `release-web` | 管理员发布页和登录前员工下载页 | `server/web/` |

三个 Claude Sonnet 5.5 保持 tmux 交互模式，通过 `mail-wait` 领单和 `mail-send` 交付。Codex 负责[发布契约](../../contracts/desktop-releases.md)、集成和验证。部署候选先过隔离环境；Windows 原生测试以 Windows 环境的结果为准。

## 第二批（2026-11-20 开工）

基线 `main` 已整合审计查询 `a1673cc` 和 Windows 原生候选 `1701e63`，Mac 全量回归通过。Windows 原生编译、测试、打包仍以 Windows 环境的结果为准。契约 v0.12 见 [data-model.md](../../contracts/data-model.md) 配额一节、[edge-ws.md](../../contracts/edge-ws.md) 多 Agent 一节。

| tmux 窗口 | 交付 | 写入范围 |
| --- | --- | --- |
| `quota-api` | 组和个人月配额在签发和续租时生效、`cutoff{reason:"quota"}`、`/quota/usage`、台账 `month_used_milli`、`/me.quota` | `server/src/`、`server/migrations/`、`server/test/` |
| `quota-web` | 成员和组台账显示本月用量与剩余、配额表单校验、`/me.quota` 提示、配额耗尽时的流水和人员页提示 | `server/web/` |
| `codex` | Codex 受管启动（固定版本制品、私有 `CODEX_HOME`、`config.toml` 生成）、router `/v1/responses` 入口（同协议与转 Chat）、rollout 采集 | `edge/onexd/src/{responses,codex}*.rs`、`launch.rs`、`managed_runtime.rs`、`ipc.rs`、`router.rs` 的入口注册、对应测试 |
| `kimi` | Kimi Code 受管启动（制品、私有 `KIMI_CODE_HOME`、`config.toml`）、wire.jsonl 采集 | `edge/onexd/src/kimi*.rs`、`capture.rs` 的分发、对应测试 |
| `review` | 独立验收：配额账务边界（多级组、并发租约、月切换、调低配额）与两个 Agent 采集的形状覆盖 | 只读，报告写 `coord/reports/s2/` |

Edge 已在 `6594f4c` 之后加上 `quota` 断流原因与 `quota_exhausted` 错误提示。`codex` 与 `kimi` 两条线共用 `launch.rs`、`managed_runtime.rs`、`ipc.rs`：`codex` 先改成按 Agent 分派的结构并提交，`kimi` 基于该提交接入，冲突由总督合并。

验收：同一租户下 Claude Code、Codex、Kimi Code 各完成一次受管启动、本机假上游多轮对话、正文与费用回流；配额耗尽时三者都收到 `quota_exhausted`。真实模型和 211 联验由总督在合并后安排。

## 后续批次

Codex、Kimi Code、组和个人额度、组管角色、可见范围和审计查询仍属于 S2。签名公证、外部发布、升级和回退安排在 S4 或以后。
