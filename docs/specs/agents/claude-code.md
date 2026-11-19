# Claude Code 受管适配规格（第一轮）

## 交付边界与验收目标

只管理由 OneX 下载并启动的 CLI；员工自行安装、启动的 Claude Code 不接管。模型请求经本机 Edge router 直达获配的上游，不经过 OneX Server 中继；渠道密钥只由 daemon 使用。会话以增量回流，短时断网先落盘，租约过期则停止新的模型消费。首轮验收是新员工在干净 Mac 上 5 分钟内完成安装登录，连续工作 2 小时不掉线或要求重新登录；管理员能实时核对完整对话和费用，故障可经 API 取诊断日志。这些是目标，不是本次实测结果。

依据：OneX `docs/kickoff/goal-interview-20261119.md:38-46,79-85,95-102`。以下把 SIMA 实现、OneX 要求和待验项分开；SIMA `docs/CURRENT.md:14-26` 中的 0.3.x 是 Edge/Desktop 版本，不是 Claude Code 版本。下文 SIMA 路径相对于 `codex/edge-uninstall-20261118` 工作树（HEAD `b6df0bfe`）。

## 1. 钉住哪个版本，怎样取得制品

| 平台、版本 | SIMA 证据 | 不能据此宣称 |
| --- | --- | --- |
| Apple Silicon，2.1.161 | 固定二进制有完整 SHA-256；首轮 TUI 400 修复后，用户报告人工测试通过。见 `docs/reports/poc-01/T04/claude-compat.md:3-13,57-65`。 | 不是 OneX 两小时验收；当时工具轨迹与 launch 的关联仍待核。 |
| Darwin arm64，2.1.304 | 经代理从官方源拉取 271,161,296 字节并入候选库。见 `docs/reports/poc-01/agent-source-20261020/README.md:22-33`。 | 拉取成功不等于 TUI、流式或恢复通过。 |
| Windows，2.1.308 | 原生版本读取、两个回环假上游的预算测试通过，零真实模型调用、零自动真实 PTY。见 `docs/reports/all-agent-model-output-windows-20261029.md:40-50`。 | 不能代签 Windows 真人测试，更不能代签 Mac。 |

发行流程：从 `https://registry.npmjs.org/@anthropic-ai/claude-code` 的 dist-tag 发现版本，冻结确切版本后取 `https://downloads.claude.ai/claude-code-releases/{ver}/manifest.json`，按平台键（如 `darwin-arm64`、`win32-x64`）取同源 `{ver}/{platform}/{binary}`；下载的是原生可执行文件，不是在员工机器上运行 npm 安装脚本。按清单 SHA-256 验证，不符拒绝入库；CDN 超时应报告下载失败，人工导入仍须匹配可信清单，不能把文件自身的摘要当作来源证明。经批准的候选才分发，Edge 按授权记录的 SHA 和字节数复核，包括复用旧缓存时。依据：`contracts/poc-01/agent-sources.md:7-13,23-30`；`docs/reports/poc-01/agent-source-20261020/README.md:80-86`；`docs/CURRENT.md:22-25`。OneX 应把平台、版本、大小、完整摘要写入发行记录，不随 `latest` 自动漂移。

**首轮建议先复验 Darwin arm64 2.1.308。** 它比仅有拉取记录的 2.1.304 更适合作基线：SIMA 冻结 SHA-256 为 `ca923c86ac84b30574a82331a05b6e066c27477a926ceaffe46a845a33e4dd37`，真实二进制 print 模式经生产适配器对回环假上游通过，最终覆盖 6 条路径、88 个断言；不含真人 PTY 或真实上游。见 `docs/reports/c-si-bus-poc-20261025/claude-workspace-resources-20261027.md:31,39-45`。此摘要不可套用到 Windows。

## 2. 配置写在哪里，怎样撤销

按安装身份和账户命名空间分配持久私有目录 `N`，按本次 launch 分配私有目录 `R`。两者是解析结果，不是写死在代码里的用户目录（`edge/src/managed_paths.rs:95-102,120-158`）。下表是子进程所见路径：

| 用途 | macOS | Windows |
| --- | --- | --- |
| 持久配置、会话 | `$CLAUDE_CONFIG_DIR` = `N/claude` | `%CLAUDE_CONFIG_DIR%` = `N\claude` |
| 用户目录 | `$HOME` = `N/home` | `HOME`、`USERPROFILE` = `N\home`；`APPDATA`、`LOCALAPPDATA` 分别为 `N\appdata`、`N\localappdata` |
| 临时目录 | `TMPDIR` = `N/tmp` | `TEMP`、`TMP` = `N\tmp` |
| 本次路由策略 | `R/settings.json` | `R\settings.json` |

- **持久状态不是路由表。** 只在受管 `CLAUDE_CONFIG_DIR` 初始化 `.claude.json`；若旧 `.config.json` 已存在则以它为准。仅合并 `installMethod: "native"` 与 `hasCompletedOnboarding: true`，不代表登录、项目受信或授予工具权限。值已正确时保留原字节；解析失败、类型冲突、其他活动写者均不覆盖。SIMA 核对原内容，同目录创建私有临时文件，写入并 `sync_all` 后原子发布，失败清自己的临时文件。见 `edge/src/lifecycle/install.rs:153-238`。
- **路由只写本次策略。** `--settings` 指向 `R/settings.json`，其中 `env.ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`（不带 `/v1`），`env.ANTHROPIC_API_KEY` 只放本次本机令牌。`model`、`availableModels`、`modelPicker` 只用获准别名；禁用 `apiKeyHelper`、`awsAuthRefresh`、`awsCredentialExport`。策略文件含本机令牌，必须限当前身份访问，纳入退出清理，不得进诊断包。依据：`edge/src/lifecycle/adapter.rs:547-613`；`edge/src/lifecycle/runtime_tools.rs:609-671`。
- **OneX 卸载契约：不改个人配置，故不需要覆盖式恢复。** 不写个人 `~/.claude/settings.json`、`%USERPROFILE%\.claude\settings.json` 或工作区文件。退出撤销令牌、删除自有临时策略；卸载前停自有进程，核对归属清单，分开处理程序和待回传记录。若未来必须改已有受管文件，则在空闲锁下记录原字节、权限与写后摘要；还原前比对当前摘要，有后续修改就报告冲突，不覆盖。个人文件在安装、退出、卸载后均应逐字节不变。

## 3. 启动契约与隔离

以已校验二进制的绝对路径和授权工作目录启动；参数作为数组传递（空字符串也是一个参数）：`--session-id <uuid> --bare --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-chrome --model <alias>`，另加上述 `--settings <path>`。这是隔离基线，不用于伪造用户批准。SIMA 有单独的项目资源授权分支，审核版本且显式允许后才改为 `project,local`；不要把该分支作为 OneX 默认值。依据：`edge/src/lifecycle/adapter.rs:614-638`；`edge/src/lifecycle/workspace_resources.rs:19-46,57-73`。

从空环境按需加入系统运行项和上表目录，不继承个人认证、代理、模型或插件路径。清空代理变量，`NO_PROXY=localhost,127.0.0.1`（Unix 同时处理小写）；清空 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_CUSTOM_HEADERS`、Claude OAuth 和其他云后端选择。绑定 `ANTHROPIC_DEFAULT_MODEL`、三族默认模型、快速模型和子 Agent 模型为同一获准别名；禁自动升级、非必要流量、自动插件安装，启用 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`。OneX 验收要用个人目录的无敏感哨兵验证未被读取，不能只检查环境变量。依据：`edge/src/lifecycle/adapter.rs:526-613`。

## 4. router 的线协议

Claude 入口是 **Anthropic Messages**：`POST /v1/messages`，可带 `?beta=true`；不是 Chat Completions 或 Responses 客户端。用 `x-api-key` 承载本机令牌，校验 launch、租约和模型后，daemon 用自己的上游认证构造新请求，不能透传本机令牌或任意自定义头。原协议上游使用 `anthropic-version: 2023-06-01`；若上游是 OpenAI Chat，才在 router 转成 `/v1/chat/completions`。端点避免双 `/v1`。依据：`contracts/poc-01/t04-model-capture.md:5-25`；`edge/src/provider/transport.rs:88-105`。

保留 `model`、`system`、`messages`、`max_tokens`、`stream`、工具 schema、`tool_choice`、`tool_use/tool_result` 的关联与顺序。流式按块转 Anthropic SSE；中途失败发送错误并关闭，不伪造正常结束；取消时停止上游读取。无法保真的语义明确拒绝，不静默删字段，不自动重放已发请求。首片、终态、请求 ID 和可得 usage 分开计，未知用量记待结算，不填零。SIMA 2.1.161 的兼容组合还包括 `CLAUDE_CODE_EFFORT_LEVEL=unset`、`CLAUDE_CODE_DISABLE_THINKING=1`、`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`、`MAX_THINKING_TOKENS=0` 及禁 adaptive thinking；这是版本/能力约束，不是所有模型的永久默认。依据：同契约 `:13-25,88-92`；`docs/reports/poc-01/T04/claude-compat.md:7-13`。

## 5. 怎样保证会话不丢、不重

**两份数据不能互相代替。** 从 `$CLAUDE_CONFIG_DIR/projects/<项目目录>/<session-id>.jsonl` 读取人可见的原生对话（Windows 在同一受管配置根之下）；不是读终端滚屏，也不是从每次模型请求重发的上下文拼接对话。router 的模型观察只负责用量、时延、错误及上游声明的模型。主键以可信启动记录绑定租户、账户、安装、launch 和原生 session，不以路径或记录自称的用户确权。依据：`contracts/poc-01/t04-model-capture.md:23-25,48-64,88-92`。

1. 只打开登记会话的普通文件；拒链接和所有者不符。按字节偏移读到换行为止，半行等后续，进程结束后再收延迟尾写。校验 `sessionId`，提取 user/assistant 可见文本、工具调用和结果、已识别的公开 system 记录；thinking、签名和凭据不入库。未知类型、坏行、截短、文件替换、工具参数部分脱敏都要标缺口并记录位置，不能显示为完整。依据：同契约 `:50-60`。
2. 游标、不可变事件、待传队列在 SQLite 一个事务中提交，失败都不推进；正文加密，单写者，不能安全落盘时挡新消费。断网时累积的是新增事件，不是上游请求。依据：同契约 `:60-64`。
3. SIMA 后续上传器按当前租户与主体选取未确认事件，按序最多 100 条且有字节上限；收到对应事件的耐久回执才记成功，永久拒绝单列。丢 ACK 重传同一事件，不重放模型调用。OneX 即使改用 WebSocket，也应保留稳定 event ID、摘要、按主体重连及持久 ACK 的语义；界面分开显示工作结果、采集缺口、待传数和归档状态。依据：`edge/src/journal/upload.rs:7-31,44-76,89-129`；`edge/src/lifecycle/upload.rs:40-83,104-120`。

## 6. 启动、退出、故障和续聊

| 转换 | OneX 应如何处理 | SIMA 依据 |
| --- | --- | --- |
| 准备 → 运行 | 核对身份、租约、获准模型、制品和 cwd；先登记 launch 与 session，确保 journal 可写、router 可用，再用本次令牌打开 PTY。失败撤销本次资源，不碰并行会话。 | `contracts/poc-01/t03-lifecycle.md:8-16,22-28`；`contracts/poc-01/t04-model-capture.md:48-52,62-64`。 |
| 运行 → 退出/停止 | Ctrl+C 交给前台 Agent，显式 stop 才收束受管树。Mac 以 PTY、守护进程及所属进程组核验；Windows 用 ConPTY、真实句柄和 Job。记录退出原因、退出码、后代是否收齐和尾写采集状态；EOF 或主进程退出都不能代替整树回收证据。 | `edge/src/macos/terminal.rs:127`；`edge/src/macos/pty.rs:1661-1677,1941`；`contracts/poc-01/t03-lifecycle.md:25-28`；`edge/src/lifecycle/daemon.rs:115-135,225`。 |
| 崩溃/daemon 失联 | 不自动重启 CLI，不重发上次模型请求。区分已退出与清理未知；重启后先核对归属、恢复持久游标和待传队列。旧令牌不能用于新 launch；不得凭陈旧 PID 清理。 | `contracts/poc-01/t03-lifecycle.md:11-16,26-28`；`contracts/poc-01/t04-model-capture.md:62-64,90`。 |
| 同一用户续聊 | 新 launch 重新鉴权；在同一受管命名空间、正确 cwd 下确认旧会话文件存在，历史锁空闲且上次安全结束，才用 `--resume <原session-id>` 替代 `--session-id <新uuid>`。另一个窗口正用或清理未知时，显式续聊应报告失败，不假装恢复；用户可另开新会话。 | `edge/src/lifecycle/session_history.rs:149-172,288-309,325-351,367-391,418-426`。 |

## 7. SIMA 遇到过的故障

| 现象 | 证据与对 OneX 的要求 |
| --- | --- |
| TUI 首轮本地 400，却像是上游不支持模型 | 当时没有上游状态或请求 ID；`output_config.effort` 是由静态制品推断的触发条件，不是抓到的原始请求。应区分本地映射拒绝与上游返回，并测试受管开关。`docs/reports/poc-01/T04/claude-compat.md:3-13`。 |
| 换包后仍复现旧错误 | 用户终端 PATH 解析到旧 CLI，旧 daemon 缺新开关，新包握手拒绝是正确行为。启动用绝对路径；诊断展示实际 CLI、daemon 和 Agent 的版本/摘要，不导出整份环境。`docs/reports/poc-01/T04/claude-compat.md:50-59`。 |
| 立即重开偶发 `JOURNAL_LOCKED` | 独立回归证实 fork 子进程可在 exec 前暂持锁描述符；修复让原 owner 关库后显式解锁，不能用放宽单写约束掩盖。`docs/reports/poc-01/T04/claude-compat.md:17-23`。 |
| 原生文件可读却漏了公开内容 | 退出尾部 `system/away_summary` 是公开回顾，不是可跳过的元数据；`last-prompt` 的识别也随记录形状变化。按版本维护形状样本，保留既有缺口，不追改旧统计。`contracts/poc-01/t04-model-capture.md:54-60`。 |
| 菜单能选模型不代表能原地应用其预算 | 2.1.308 输出上限是进程级变量。预算不同（含缺省与显式）须提示重启，在发上游请求前拒绝；不能改偏好后继续用旧预算。`docs/reports/all-agent-model-output-windows-20261029.md:13-18,44-50`。 |

## 8. 待实测与通过条件

本次只做文档与源码核对：未运行 SIMA 服务、Claude 或真实模型，未执行安装、卸载或端到端测试。以下均未由 OneX 验收：

- **制品和隔离：** 先确认 2.1.308 目标平台官方清单仍可取，并固定大小、摘要。干净 Mac 上记录安装登录到首个可用交互的耗时（≤5 分钟）；另在有个人配置、代理和项目设置的机器上用合成哨兵检验优先级。并行开两个窗口，关闭一个不影响另一个；卸载后个人目录内容与权限不变。
- **协议和计费：** 用合成 Messages、Chat 上游覆盖流式文本、工具、取消、断流、缺 usage、拒绝未知字段；核对本机头与上游头隔离、重复请求不重复扣费。对候选版实际发出的 beta 头、计数端点需求、不同上游的缓存用量与计价分别核实，不能靠旧版请求形状推定。
- **连续工作和恢复：** 经授权后在干净 Mac 的真实 PTY 连续工作 2 小时，跨租约续期、控制链路短断和恢复，分别核对会话是否连续、无需重新登录，以及额度到期是否停消费。另测 Agent/daemon 异常退出、另一窗口占锁、同目录显式 resume 与跨租户拒绝。不可把 print 模式或 Windows 假上游结果算作通过。
- **回流和诊断：** 用已知轮数、工具配对及延迟尾写的合成会话，对账本地完整行、持久事件、服务端耐久 ACK 和管理员可见内容。模拟半行、截短、丢 ACK、磁盘满、睡眠唤醒；不能多轮、漏轮或把缺口当成功。管理员验证对话和费用实时可见，诊断 API 能定位失败层且不返回正文、凭据。工具配对与未齐分片的对照依据：`contracts/poc-01/history-session-reader.md:12-19`。
- **Windows 单列：** 在目标架构复核原生包、Git Bash、路径与 DACL、ConPTY resize/取消、Job 收尾、断电后的配置替换和 resume；Mac 通过不是 Windows 放行依据。留待首轮后的平台验收。





