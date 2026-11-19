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

## 后续批次

Codex、Kimi Code、组和个人额度、组管角色、可见范围和审计查询仍属于 S2。签名公证、外部发布、升级和回退安排在 S4 或以后。
