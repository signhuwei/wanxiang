# Codex Desktop 原厂客户端纳管规格

## 制品与策略

Codex Desktop 独立于 Codex CLI。macOS arm64 官方下载来自 `https://persistent.oaistatic.com/codex-app-prod/Codex.dmg`。该地址会更新，发布时需同时校验精确版本、制品摘要、Apple 签名、签名团队和包标识。2026-11-21 验证样本为 `26.1117.41037`（构建 `29803`），`com.openai.codex`，Team ID `2DC432GLL2`，DMG `582617625` 字节，SHA-256 `67d362df03de37ebd794a64608abf98a2b0b1be2783d33a950abdd83ed89b279`。签名原包的 `.app` 名为 `ChatGPT.app`。内置 app-server 位于 `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`，`codex-package.json` 标注 `0.171.0-alpha.13`。Mac 上原包和内置程序均通过 `codesign --verify` 严格校验。[官方下载](https://learn.chatgpt.com/docs/app)

每个受管个人身份的桌面数据与工作区必须独立。选择固定 provider ID `onex_codex_desktop`，重启和续聊沿用该 ID。`CODEX_HOME/config.toml` 仅指向 OneX 本机 `/v1` Responses 网关，使用由能力合约授权的精确模型，禁用 WebSocket，排除工具子进程中的临时路由令牌。上游密钥由 OneX 管理。厂商支持通过 `model_catalog_json` 提供允许显示的模型，通过 `requirements.toml` 锁定默认 provider 和对应表。普通 profile 可以被原厂配置菜单或更高优先级配置覆盖，不能单独作为出站模型策略的证明。组织策略需由管理员在适用机器预配，例如使用 macOS MDM 的 `com.openai.codex` 域下 `requirements_toml_base64`。OneX 不修改个人供应商配置或全机策略文件。[网关配置](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway) · [原生模型清单与策略](https://learn.chatgpt.com/docs/enterprise/roll-out-a-gateway) · [托管配置](https://learn.chatgpt.com/docs/enterprise/managed-configuration)

原包当前版本使用 `CODEX_ELECTRON_USER_DATA_PATH` 与 `CODEX_HOME` 隔离界面和会话数据。OneX 以 `CODEX_CLI_PATH` 将原厂 App Server 的 stdio 接到私有桥，使用 `CODEX_APP_SERVER_FORCE_CLI` 拒绝复用已有 daemon。私有配置固定 `desktop.conversationDetailMode = "STEPS_COMMANDS"` 进入 Codex 模式。桥拒绝厂商账号切换、能力合约外模型和会话目录，并由自身设置接管 GUI 请求携带的配置覆盖。这些原包实现细节应按发行版分别验证。[配置与环境变量](https://learn.chatgpt.com/docs/config-file/environment-variables)

## 会话与计费绑定

1. 受管启动确认制品、设备和已授权工作区后，在 OneX 控制的私有通道中启动签名 app-server。只接受此子进程为批准工作区创建、恢复或派生的原生 thread ID。应用配置、模型 catalog、原生数据、临时路由令牌和该进程的生命周期一起绑定启动。断开时撤销本地绑定。
2. `POST /v1/responses` 必须通过本次启动的本机令牌和精确模型校验。请求的 `x-codex-turn-metadata` 只读取有长度上限的 JSON，强制匹配 `thread_id` 与 `turn_id`。OneX 通过 app-server 的私有 JSONL `turn/started` 通知校验正在进行的确切 turn。若网络请求先到，只短时等待对应通知。缺少或冲突的证据一律拒绝。`session_id`、`root_turn_id` 和最近活动窗口均不用于回退。
3. 桥经 `/v1/onex/desktop/codex-turn` 上报原厂轮次，推理客户端只获得独立的本次启动模型令牌。daemon 按 `(设备, codex-desktop, 原生 thread)` 派生稳定会话 ID，按原生 turn 校验每次推理。同一 ID 归集已验证私有 rollout 的用户和助手事件及费用。rollout 的字节游标和增量回流同事务保存。

## 原生验证

使用原厂下载的镜像在 Mac 上只读挂载后，运行以下验收脚本。脚本在执行前核对 app 原包及其内置 app-server 的签名，使用临时私有目录和随机本机令牌。回环模拟网关校验唯一获准 alias、协议、令牌、独立原生 thread 与 turn 标识。它启动两条聊天，为第一条创建分支，在原生服务退出后重启并用精确 thread ID 续聊，核对原聊天历史仍随请求发送。测试仅使用合成对话和用量。

```sh
bun test ./tests/e2e/codex-desktop
bun tests/e2e/codex-desktop/qualify.ts '/path/to/mounted/ChatGPT.app' onex-qualification-model
```

2026-11-21 在 Apple Silicon 独立验收租户通过 `onex run codex-desktop --managed --model Qwen3.8-27B` 启动签名原厂窗口。界面进入 Codex 模式，模型目录仅显示能力合约授权的 `Qwen3.8-27B`。用 `gpt-5.4` 启动返回 `model_not_allowed`。先用真实 Qwen 问答，再退出 GUI 和 onexd，重开后从原厂最近会话进入原线程并继续提问。两次回复来自实际推理，续聊能回忆首轮标记。两条用户消息、两条助手消息及两笔完整用量归入会话 `d08772e0-94f0-5262-831e-ff52acfd534f`。两笔分别结算 0.013 块橡皮，账本合计 0.026 块橡皮，设备无未关联用量。

验收使用外层 macOS Seatbelt 限定私有数据和本机 OneX 推理端口。为在现有 Mac 账户隔离原厂个人配置，实验关闭了 Chromium 的嵌套渲染器沙箱，并使用临时 Keychain。实验启动参数只用于本机验收。子线程、压缩、其他 app-server 后端及 Windows 原厂发行另行核验。[App Server 协议](https://learn.chatgpt.com/docs/app-server)

同日，在 Apple Silicon Mac mini 的真实桌面上复验签名原厂发行，保留应用默认渲染器沙箱。原厂窗口由 OneX 启动，只有 `Qwen3.8-27B` 可选，合约外模型启动被拒绝。用户在独立验收工作区先询问如何挑熟梨，重启原厂 GUI 及 onexd 后在同一原厂聊天中续问，得到回答「梨」。验收脚本确认 OneX 会话 `3ca5ea93-5200-5e31-9ccb-f744a72f1747` 与设备 `dev_01M7XZGR57MZJ53SJCH2XW7D09` 均保持一致，2 条用户消息、2 条助手消息及 2 笔真实请求完整归属，实际结算 0.022 块橡皮。设备无未关联用量。

211 Server `5d6774c` 已启用已缓存的原厂发行 `rel_01M7XT1YTJ81NQ77ZGN8XX334K`。Mac Edge `0.1.0-rc7` 经员工下载页发布并通过匿名下载回读。租户能力合约仍决定哪些设备可下载此原厂包及使用哪些模型。
