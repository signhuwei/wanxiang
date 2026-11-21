# Claude Desktop 受管适配规格

## macOS 原厂 Code 界面

Agent 管理项使用 `claude-desktop`，原厂应用标识为 `com.anthropic.claudefordesktop`，发布 Team ID 为 `Q6L2SF6YDW`。首版目标是第三方部署（3P）下的本机 Code 界面。Anthropic 支持 Claude Desktop 2.7032.0 起使用本机 Claude Code 进程包装器，Desktop 4.16336.0 起可借 `deploymentMode: "3p"` 锁定部署模式。Claude Code 引擎需支持 `processWrapper`，最低为 2.1.210。Windows 本机和 WSL Code 不调用此包装器。 [Claude Desktop Code 管理](https://claude.com/docs/third-party/claude-desktop/code#start-code-sessions-through-a-corporate-launcher) · [Claude Desktop 配置](https://claude.com/docs/third-party/claude-desktop/configuration) · [Claude Code 企业包装器](https://code.claude.com/docs/en/corporate-launcher)

macOS 官方下载页提供 Universal DMG，企业管理可用 Universal PKG。标准制品由 Desktop 再从厂商下载原厂的 Code 引擎，离线 DMG 则自带该引擎。盘点安装包时记录固定版本、确切字节数及 SHA-256。验收须检查原厂签名及真实运行引擎摘要。一份官方下载物可以入库，只有实际通过运行验收的构建才能进入员工能力合约。 [官方安装包入口](https://claude.com/download) · [macOS 企业部署](https://support.claude.com/en/articles/12611117-deploy-claude-desktop-for-macos) · [官方更新清单](https://downloads.claude.ai/releases/darwin/universal/RELEASES.json)

2026-11-21 核验的原厂 Universal DMG 为 `6.28899.6`，大小 402,202,476 字节，SHA-256 为 `a1226d5e7072a713f7eab74d06d1745fc47aa57eae3ba202a103032d1329530f`。下载内容的 MD5 匹配厂商 CDN 对象摘要。磁盘映像校验通过，原厂应用内含 `x86_64` 与 `arm64`，两种架构均通过严格签名校验，满足 Anthropic 发布者和应用标识的固定要求。 [Anthropic 官方版本制品](https://downloads.claude.ai/releases/darwin/universal/6.28899.6/Claude-2f5fc59b2d1c672dd9dced86720c50f48cca0cf9.dmg)

211 平台管理登记的 macOS arm64 发行 ID 为 `rel_01M7XTSDW717NRAHP8CSQAZMVV`。制品完整缓存，管理员取回的全部字节及 SHA-256 与原厂包一致，匿名请求返回 `401`。初次登记时状态为 `disabled`。同一构建后续完成的原厂 GUI 验收见下文。

该 Desktop 构建内置的 macOS arm64 Code 引擎版本是 `2.1.330`。原厂引擎归档为 124,237,798 字节，SHA-256 为 `4262a1273231dc7d7ada7914750fa9b5c724548cff6b2ae4a8d49ce55ac2456f`。归档与已验签 Desktop 的内置清单一致，启动二进制通过 `com.anthropic.claude-code` 与 `Q6L2SF6YDW` 的签名校验，二进制 SHA-256 为 `85f06ea3639ee5eaa55e766712c235f11c58e1e02e2a74cd08db8ab2c8efe943`。 [Anthropic 官方引擎](https://downloads.claude.ai/claude-code-releases/2.1.330/darwin-arm64/claude.app.tar.zst)

## 授权和启动

OneX 分配每次启动的本机控制令牌并绑定账户、工作区、原厂发布版本及合约模型。Desktop 的 MDM 应锁定 3P，隐藏 Chat、Cowork、原厂登录入口，关闭 SSH、自动模式和定时会话，固定 `inferenceModels` 和工作区。Claude Code 的设备托管设置使用 `parentSettingsBehavior: "merge"`，同时设置 `processWrapper` 使 Desktop 直接调用原厂引擎的 argv。生产 MDM 及包装器由可信管理员部署，成功启动的进程记录和策略匹配须另行验证。 [部署和锁定](https://claude.com/docs/third-party/claude-desktop/mdm) · [Code 托管设置](https://code.claude.com/docs/en/settings)

包装器接受带明确 UUID 的 `--session-id` 或 `--resume`，从保存在私有目录的启动控制令牌向 onexd 请求该 UUID 的会话模型令牌。新开和续聊对相同原厂 UUID 都请求相同 OneX 会话归属。包装器保留原程序 argv、工作目录及标准输入输出，以 `exec` 交回原厂引擎。它只给引擎传目标 `ANTHROPIC_BASE_URL`、批准的模型及该会话的 `ANTHROPIC_AUTH_TOKEN`，而上游密钥仍由 onexd 持有。上游请求应使用 Anthropic Messages 协议和合约模型，费用由已鉴权绑定解析 OneX 会话。版本查询不取得会话令牌。

Anthropic 文档规定 Desktop 的连接测试与标题生成跳过包装器，由主程序自身取得凭据。验收工具的辅助凭据命令固定拒绝并返回非零。需在隔离测试设备上验证这种策略能否进入 Code，或实现只服务指定探测的单独能力。标题请求的归属和费用需根据观测的真实请求验证。 [原厂包装器凭据说明](https://claude.com/docs/third-party/claude-desktop/code#start-code-sessions-through-a-corporate-launcher) · [Gateway 配置](https://claude.com/docs/third-party/claude-desktop/gateway)

## 验收工具

在仓库内运行 `cargo build --release --manifest-path edge/Cargo.toml -p onexd --example onex-claude-desktop`。使用绝对且已解析符号链接的文件路径，在隔离测试账户为 `prepare <private-plan.json> <private-output-directory>` 提供计划。计划字段为 `gateway`（`http://127.0.0.1:<端口>`）、`model`、`workspace`、`engine`、`engine_sha256`、`code_profile`、`launch_credential`。`engine` 指经过签名和摘要核验的 Code CLI，工具校验签名 ID `com.anthropic.claude-code` 与 Team ID `Q6L2SF6YDW`。厂商文档的 macOS 3P 下载位置为 `~/Library/Application Support/Claude-3p/claude-code/<version>/<build-id>/claude.app/Contents/MacOS/claude`。输出目录与 Code profile 目录都需要当前账户独占权限。计划和控制令牌文件权限为 `0600`，令牌文件放在工作区和 Code profile 外部，按 onexd 的 64 位小写十六进制令牌原样写入。除目录路径与验证元数据，计划中不存任何密钥。 [原厂运行引擎路径与签名](https://claude.com/docs/third-party/claude-desktop/installation#endpoint-security-software)

生成 `claude-policy/claude-desktop-managed.json` 及 `claude-policy/claude-code-managed.json` 后，由测试设备管理员按两个产品的托管方式应用。工具只生成策略片段。会话鉴权需要 onexd 为 `claude-desktop` 启动登记的本机控制令牌。普通员工使用 OneX Desktop 时，版本门禁和发布资格仍通过管理端与能力合约控制。

在隔离 profile 中，真实原厂 3P 窗口可以只显示 `inferenceModels` 列出的一个 Claude 型号。Desktop 6.28899.6 在配置解析阶段移除了 `Qwen3.8-27B`，即使填写 `labelOverride` 和 `behavesAs` 也一样。应从 OneX 合约选用实际 Claude 上游。原厂窗口仍为本机配置显示修改模型、连接和提供商的入口。要锁定入口与正式启用设备包装器，需要在专用设备使用受管理的 Desktop 和 Claude Code 配置。 [原厂模型配置](https://claude.com/docs/third-party/claude-desktop/configuration#inferenceModels) · [设备策略与包装器](https://claude.com/docs/third-party/claude-desktop/code#start-code-sessions-through-a-corporate-launcher)

实验通过 `CFFIXED_USER_HOME` 将已验签应用的本地数据隔离到测试目录。测试 profile 的 `Library/Application Support/Claude-3p/claude_desktop_config.json` 记录 `deploymentMode: "3p"`，`configLibrary/_meta.json` 的 `appliedId` 指向同目录的配置 UUID。只允许测试进程访问该目录与本机探针。Chromium 子进程与外层 macOS Seatbelt 存在沙箱嵌套冲突，实验通过在保留外层隔离时禁用测试进程的 Chromium 内层沙箱验证界面。正式验收使用专用账户及设备托管，保留应用自身的沙箱。 [原厂本地配置存储](https://claude.com/docs/third-party/claude-desktop/data-storage)

## 对话和费用验收

Claude Desktop 3P 与 Claude Code 可能共用默认 transcript 位置。独立测试账户须用专用持久 `CLAUDE_CONFIG_DIR` 与签名安装包验证新建和恢复的真实写入位置。回流使用由启动登记授权的 UUID，从该 profile 读取完整 JSONL 行，复用已有增量游标、工作区和所属校验，过滤内部记录与思考内容，按原生事件去重。禁止扫描员工个人 Claude Desktop 或 Claude Code 的记录。验收工具当前完成 UUID 绑定与会话凭据交接，live transcript 采集仍待接入。 [原厂本地数据布局](https://claude.com/docs/third-party/claude-desktop/data-storage)

2.1.330 引擎对本机拒绝探针发出的 `POST /v1/messages` 实测带 Bearer，`metadata.user_id` 是一个 JSON 字符串，其 `session_id` 与启动参数的 UUID 相同。该字段可以与已可信绑定的会话核对，仍须使用已登记的本机会话令牌来授权。探针没有访问模型或产生成本。

在取得至少支持锁定 3P 的合格原厂版本、应用设备策略后，从 OneX 打开原厂 GUI，创建 A/B 两个不同会话并交替问答。在完全退出 GUI 和 onexd 后，重开并精确继续 A，记录两个原厂 UUID、OneX 会话与使用量行。确认 A 启动前后的会话一致，B 的对话与费用独立，同一问题重启后不补扣，非合约原厂渠道无入口且无法发起模型请求。实际捕获的厂商 argv 必须提供明确 UUID，通过实测才能将该版本升级为可发布运行态。


## OneX 原厂窗口接入候选

Apple Silicon Edge 校验原厂 DMG、Apple Team `Q6L2SF6YDW`、应用标识和固定 arm64 CDHash，再为当前设备及工作区准备私有 3P 配置。当前候选仅接受 Sonnet 5.5 的合约路由 `claude-sonnet-5-5` 或 `sonnet5.5`，且上游协议必须是 Anthropic Messages。厂商凭据助手只返回当前启动的 OneX 本机令牌。上游密钥仍由 onexd 持有。

原厂 Code 引擎在 Messages 的 `metadata.user_id` 中发送 JSON 字符串，`session_id` 与引擎 UUID 一致。首个真实模型请求到达时，私有 transcript 已有完整用户记录。原厂窗口自己的 `local_<UUID>.json` 会在推理请求返回后才写入 `cliSessionId`。OneX 先核对本次启动令牌、能力合约模型、工作区与完整 transcript，再将模型请求和增量记录绑定到同一设备、Agent 和引擎 UUID 派生的 OneX 会话。后续可以用原厂窗口记录补证关联。没有原生会话证据的辅助模型请求不进入计费链路。

已完成私有配置、签名识别、逐会话令牌与轮询回流、合约及发行撤销检查。自动测试覆盖本机代理、拒绝越权会话、重新绑定的用量和重复回流。

2026-11-21 在独立 QA 租户使用 211 的 `xiaolezhi` Anthropic 渠道验收原厂桌面 `6.28899.6` 与原厂引擎 `2.1.330`。Edge 启动原厂 3P 窗口，原厂模型选择器只列出合约模型 `claude-sonnet-5-5`。租户充值 2 块橡皮，输入与输出每百万 token 分别为 0.1 与 0.4 块橡皮，缓存倍率均为 0。此测试倍率使原厂请求声明的最大生成量能够在单设备租约内完成预留。

合约设备 `dev_01M7XZMSX4K12AK5J0WVQFV19V` 完成首轮真实问答。退出并重启原厂 GUI 和 onexd 后，Edge 自动恢复原设备身份与到 211 的连接。原厂聊天 `local_f92173fd-e1c2-416b-a043-9c68ada4d502` 保持引擎 UUID `7df222ce-3c7b-47ad-be5a-a0cc1f732810`，续聊准确回忆首轮的芒果。211 的 OneX 会话 `0ea263a5-9f59-59c7-a11a-2b7c35ac6ab5` 收到 2 条真实用户消息、2 条真实助手消息及 2 笔完整用量。首次用量 0.002 块橡皮，续聊 0.001 块橡皮，两笔均已结算，待核对为 0。独立的探索性会话含上游拒绝，结算 0.006 块橡皮。QA 租户总计实扣 0.009 块橡皮。

联验在隔离 Edge 中固定已验签的原厂包，使用外层 Seatbelt 与测试进程的 Chromium 内层沙箱设置。211 原厂制品仍待员工放行。员工放行前需用托管设备确认原厂沙箱和设备策略能持续锁定 3P 渠道及原厂窗口设置。
