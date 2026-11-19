# OneX（万象）开发说明

给接手的开发者和 Agent（Codex、Claude Code 等）读。进入仓库先读这份，再读 [HANDOFF.md](HANDOFF.md)。

## 项目是什么

企业 AI Agent 的纳管与统一管控基座，SaaS 形态。员工的 Agent（第一版是 Claude Code）只能由 OneX 启动，模型流量经本机 router（onexd）直连上游，按倍率实时计费（内部积分叫“橡皮”），对话增量回流到 Server，管理员在网页上实时查看对话和费用。

目标、边界和所有用户裁决见 [立项访谈](docs/kickoff/goal-interview-20261119.md) 和 [总体计划](docs/plan/master-plan.md) 第 7 节。

## 仓库布局

| 目录 | 内容 | 技术栈 |
| --- | --- | --- |
| `contracts/` | 接口契约：Edge↔Server WebSocket、HTTP API、数据模型、错误码。**改代码前先看契约，契约和代码不一致时以契约为准，并修正其中一方** | Markdown |
| `edge/` | `onexd`（本机 daemon：router、计价、租约、回流、启动 Agent）、`onex-cli`、`onex-core`（共享消息类型） | Rust、Tokio |
| `server/` | API、WS 网关、账本、回流写入、监察 | Bun 1.3.5、TypeScript、Hono、bun:sqlite |
| `server/web/` | 管理端，原生 HTML/CSS/ESM，无构建步骤 | 浏览器直接加载 |
| `desktop-ui/` | Desktop 前端（mock，Tauri 外壳未做） | 原生 HTML/ESM |
| `deploy/` | 一致的安装、启停、部署脚本（macOS arm64、Ubuntu 22.04） | Bash |
| `tests/e2e/` | 假上游、压测、跨进程租约测试 Server | Bun |
| `docs/specs/` | Magpie 参考规格、5 个 Agent 的适配规格、SIMA 教训 | Markdown |

## 运行测试

```sh
(cd server && bun install --frozen-lockfile)
bun --no-env-file test server/test tests/e2e/fake-upstream     # Server
(cd server/web/tests && bun install --frozen-lockfile && bun test)  # 管理端
bun test ./desktop-ui/tests                                      # Desktop 前端
(cd edge && cargo test)                                          # Edge
```

合并前全部要通过。真实 Valkey 的测试默认跳过，设置 `ONEX_TEST_VALKEY_URL=redis://127.0.0.1:18701` 后运行（先用 `deploy/onex.sh start` 起本地服务）。

## 必须守住的规则

- **安全边界**：上游密钥只在 onexd 内存中解密，不写日志、不进 Agent 配置；读取对话正文必写审计；计费不超发（预留与实际消费分开，结算以 `lease_renew.used_milli` 为准）。
- **管理端 UI 规则**（来自 SIMA）：只有台账、钻取、表单三种页面；钻取时台账左缩；主表单不用弹窗和遮罩；服务端分页；按钮按 API 返回的 `actions` 显示，不在页面推导权限。
- **利旧知识，不利旧代码**：SIMA（`/Users/HHH/Code/SA/SIMA`）和 Magpie（`/Users/HHH/Code/OneX/refs/magpie`）只作参考。
- **211 上还跑着 SIMA**（`sima.service`、`~/apps/sima`），部署 OneX 不能碰它。OneX 只用 `onex-*` systemd 单元和 18700–18702 端口。
- 结束测试进程用保存的子进程句柄，或 `lsof -ti:<端口>` 查 PID 后单独结束。**不要用 `pkill -f onex`**，它曾误杀过整个开发环境。
- 提交信息用英文 Conventional Commits。
