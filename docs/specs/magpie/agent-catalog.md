# Magpie Agent 目录与 OneX 接入线索

基线：Magpie `0e3d093611e8bd226e3136113aafd75f5d7f4914`。目录以 `internal/agent/agents.go:321–414` 的 **91 个静态构造器**为准，包括模型选择但不经网关的两项，以及只提供导入链接的项。`README.md:86` 的展示列表少了 DS Bot、Obsidian。动态 profile、WSL 和插件不计入这 91 项。源码路径相对 `refs/magpie`；未启动 Agent、未验证厂商版本或真实流量。

**协议是 Agent 到本机网关的协议**，不是最终上游。`A` = Anthropic Messages，`C` = OpenAI Chat Completions，`R` = OpenAI Responses，`G` = Gemini；`推断` 指由 endpoint/兼容类型静态得出、尚无直接 wire 证据；`—` 表示这项适配不把模型请求接入网关。`$XDG` 表示 `$XDG_CONFIG_HOME`，默认 `~/.config`；`应用数据` 由平台及 App 自行解析。路径列是主路径而非所有版本和运行形态；已见覆盖项列在后文或所引源码。

| Agent | 主要位置 | 接入方式 | 协议 | 证据 |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/settings.json` 或 `$CLAUDE_CONFIG_DIR/settings.json`；独立 launcher 文件 | 改 `env` 或以 `--settings` 启动 | A | `internal/agent/claude.go:709`、`internal/agent/claude_launch.go:13` |
| Claude Desktop | 应用数据 `Claude/claude_desktop_config.json`、`Claude-3p/configLibrary/` | 第三方 gateway profile；重启；另有隔离启动变体 | A | `internal/agent/claudedesktop.go:6`、`docs/reference.md:96` |
| Claude Science | Magpie `claude-science.json` 状态；不改 App 文件 | 启停 daemon，给其进程注入 `ANTHROPIC_BASE_URL` | A | `internal/agent/claudescience.go:3,239` |
| Codex | `$CODEX_HOME/config.toml` 或 `~/.codex/config.toml`，模型列表旁文件；可用独立 profile | TOML provider 或 `-p` 启动；桌面 app-server 重读有独立路径 | R | `internal/agent/codex.go:265,1927`、`internal/agent/codex_profile.go:15,35` |
| Gemini CLI | `~/.gemini/settings.json`、`.env` | 改 API-key auth/model，写 `GOOGLE_GEMINI_BASE_URL` 和 key | G | `internal/agent/gemini.go:20,29,101` |
| Antigravity CLI | `~/.gemini/antigravity-cli/magpie-settings.json`（内置实现） | 启动覆盖 `--settings`、`--model`、环境变量；支持由插件接管 | G（内置） | `internal/agent/agy.go:3,18`、`internal/agent/plugged_moved.go:23,49` |
| Dim | `$DIMCODE_HOME` 或 `~/.dimcode-alpha`，Magpie `dim.json` | 自身 daemon API；失联时 shell 启动环境 | C（推断） | `internal/agent/dim.go:25,58,83` |
| Antigravity | `~/.gemini/config/config.json` 或旧 `~/.antigravity/settings.json` | 改桌面 gateway 配置；与 agy 独立 | C | `internal/agent/antigravity.go:5,91,126` |
| OpenCode | `$OPENCODE_CONFIG_DIR` 或 `$XDG/opencode/opencode.json(c)` | 改 provider/model；兼容 1.x 与 2 的配置形状 | C（默认） | `internal/agent/agents.go:741,1255,1430,1453` |
| OpenChamber | `~/.config/openchamber/preferences.json`、`settings.json`；`$OPENCHAMBER_DATA_DIR` 可改；provider 在 OpenCode 配置 | 改选择和 OpenCode provider，启动由前端负责 | C（经 OpenCode） | `internal/agent/openchamber.go:37,52,162` |
| MiMo Code | `$XDG/mimocode/mimocode.json(c)` 或 `$MIMOCODE_HOME/config/` | 改 OpenCode 型 provider/model，CLI 与桌面共读 | C | `internal/agent/agents.go:1255,1467` |
| DevEco Code | `$XDG/deveco/deveco.json(c)` 或 `$DEVECO_CONFIG_DIR` | 改 OpenCode 型 provider/model | C | `internal/agent/agents.go:1255,1480` |
| Pi | `~/.pi/agent/{settings,models}.json` 或 `$PI_CODING_AGENT_DIR` | 改 provider、模型注册表和起始模型 | C/R/A/G，视模型与版本 | `internal/agent/agents.go:938,962,1505,1520`、`internal/agent/pi_protocol.go:31` |
| StepCode | `~/.stepcode/config.toml`、`models.json`，支持 env 覆盖 | 改全局模型/provider；项目覆盖优先 | C | `internal/agent/stepcode.go:21,49,310` |
| MothX | `~/.mothx/settings.json`；`$MOTHX_DIR` 或 Windows `%APPDATA%/mothx` | 改 provider/model/thinking；项目覆盖保留 | C | `internal/agent/mothx.go:18,52,149,194` |
| PenguinHarness | `$PENGUIN_HOME/<project>/.project_config.toml`，默认 `~/.penguin/data/default_project/` | 改项目 provider/model | R | `internal/agent/penguin.go:56,125`、`docs/reference.md:194` |
| Aside | `~/.aside/u/<id>/{settings,models}.json`，账号来自 `accounts.json` | 改 Pi 型模型注册表，设置通过自身 `aside repl`；兼容离线 | C/R/A（由共用适配推断） | `internal/agent/aside_native.go:23,67,329`、`internal/agent/aside_account.go:15,66` |
| OmO | `~/.omo/agent/{settings,models}.json` 或 OmO/SenPi env 覆盖 | Pi 型配置 | C/R/A（由 Pi 共用适配推断） | `internal/agent/omo.go:3,31`、`internal/agent/agents.go:938,1623` |
| Prime Agent | `~/.prime/agent/{settings,models}.json` 或 `$PRIME_AGENT_CODING_AGENT_DIR` | Pi 型全局配置 | C/R/A（由 Pi 共用适配推断） | `internal/agent/primeagent.go:3,25`、`internal/agent/agents.go:938,1623` |
| mu | `~/.mu/agent/{settings,models}.json` 或 `~/.kyrn/agent`、各自环境变量 | Pi 型配置，CLI/桌面共用 | C/R/A（由 Pi 共用适配推断） | `internal/agent/mu.go:3,42`、`internal/agent/agents.go:938,1623` |
| Goose | `$XDG/goose/config.yaml`、`custom_providers/`；Windows 搜索应用目录 | 改自定义 provider 和模型 | C（OpenAI engine） | `internal/agent/agents.go:1817`、`internal/agent/goose.go:114,130` |
| Cursor CLI | `~/.cursor/cli-config.json` | 仅改厂商原生模型选择，没有自定义网关 | — | `internal/agent/agents.go:1907`、`internal/gateway/gateway.go:78` |
| Cursor Private Inference | Magpie `cursor-local.env`；Cursor 自己的覆盖有更高优先级 | 用户级环境或进程环境启动，避免改共用 Cursor 配置 | A/R/C，靠 `/models` 能力表 | `internal/agent/cursorlocal.go:3,224,234` |
| Zed | `$XDG/zed/settings.json`；Windows `%APPDATA%/Zed` | 改 OpenAI 兼容 provider/模型和相关凭据 | C（兼容型推断） | `internal/agent/zed.go:25,52`、`docs/reference.md:113` |
| VS Code Chat | `Code/User/{settings,chatLanguageModels}.json`，含每 profile | 写 Custom Endpoint 与默认模型 | C | `internal/agent/vscode.go:334,606,617,659`、`docs/reference.md:114` |
| VS Code Insiders | 同上，应用目录 `Code - Insiders/User/` | 同上，独立 Agent 令牌 | C | `internal/agent/vscode.go:334,617`、`docs/reference.md:115` |
| VSCodium Chat | 同上，应用目录 `VSCodium/User/` | 同上，旧扩展有 BYOK 兼容及登录前提 | C | `internal/agent/vscode.go:114,334,617`、`docs/reference.md:116` |
| Zoo Code | VS Code `User/settings.json` 及扩展 `globalStorage/.../magpie-import.json` | 写扩展启动导入路径与 provider profile | C | `internal/agent/zoocode.go:22,72,229`、`docs/reference.md:117` |
| Copilot（JetBrains） | `$XDG/github-copilot/byok.json` 或 Windows Local AppData 对应路径 | 写语言服务 BYOK 配置，需允许 BYOK 的账户 | C | `internal/agent/copilotjetbrains.go:75,203`、`docs/reference.md:118` |
| JetBrains Air | 应用数据 `JetBrains/Air/{acp,magpie-opencode}.json` | 改 ACP 启动配置，子进程为 OpenCode | C（经 OpenCode） | `internal/agent/air.go:8,139,234` |
| Air（JetBrains IDE） | `~/.jetbrains/{acp,magpie-opencode}.json` | 同类 ACP 配置，支持在 WSL 启动 OpenCode | C（经 OpenCode） | `internal/agent/air.go:154,170,234` |
| Copilot CLI | `~/.copilot/{settings,providers}.json`，`$COPILOT_HOME` 或 `$COPILOT_PROVIDERS_CONFIG` | 改多 provider BYOK 文件及模型 | C（`type:openai` 推断） | `internal/agent/agents.go:1945`、`internal/agent/copilot_byok.go:86` |
| Crush | `$XDG/crush/crush.json` 或 Windows 对应应用目录 | 改 provider 及 large/small；另保留客户端选择 | C（OpenAI 型） | `internal/agent/agents.go:775,2108`、`docs/reference.md:122` |
| DeepSeek Harness / Desktop | `$DSH_HOME` 或 `~/.dsh`，profiles patch、`.env`、`.credentials.yaml`；旧 `config.yaml` | 管理路由及凭据引用，区分 profile 与默认模型 | C/R/A | `internal/agent/dsh.go:104,1462,1500,2102` |
| DS Bot | `$DS_BOT_HOME` 或 `DS Bot` 应用数据，`profiles/ds-bot/cordis.patch.yml` | 隔离 DSH home，按同一 DSH 规则；web 版归 dsh | C/R/A（经 DSH） | `internal/agent/dsbot.go:3,40,95` |
| Reasonix Studio | `$REASONIX_HOME/{config.toml,.env}` 或 `~/.reasonix`、Windows `%APPDATA%/reasonix` | 配置 executor/planner provider 与 key 变量 | C（`openai` 型推断） | `internal/agent/reasonix.go:3,96,637` |
| Command Code | `~/.commandcode/{settings,providers}.json` | 改模型与 provider manifest | C | `internal/agent/commandcode.go:31,186` |
| fx | `~/.fx/settings.json` | 新增 keyless provider 配置 | C | `internal/agent/fx.go:100,251` |
| omp（oh-my-pi） | `~/.omp/agent/{config,models}.yml` 或 profile/变量覆盖 | 改 YAML provider 和模型角色 | C/R/A | `internal/agent/omp.go:3,109,150,677` |
| Devin | `$XDG/devin/config.json` 或 `%APPDATA%/devin/` | 只改原生 `agent.model` 与 effort 变体 | — | `internal/agent/devin.go:3,24` |
| Hermes Agent | `$HERMES_HOME/config.yaml` 或 `~/.hermes/`、Windows Local AppData；各 profile 的 yaml 与 `.env` | 改活跃 profile 的 provider/模型，保留其模式 | C/A 默认；识别 R 配置 | `internal/agent/hermes.go:55,503,782,799,1029` |
| Mister Morph | `~/.morph/config.yaml` 或 `$MISTER_MORPH_CONFIG` | 改 `llm` 到 `openai_response_compatible`，保存原值 | R | `internal/agent/morph.go:39`、`docs/reference.md:130` |
| Kimi Code | `$KIMI_CODE_HOME/config.toml` 或 `~/.kimi-code`；旧 `$KIMI_SHARE_DIR`/`~/.kimi` | 写 Kimi 型 provider、模型、默认值 | C（有模拟请求，实际版本待验） | `internal/agent/kimi.go:3,46,257`、`internal/gateway/kimi_effort_test.go:18,41` |
| Qwen Code | `~/.qwen/settings.json`，支持 `$QWEN_HOME` | `modelProviders.openai`，API-key env，切 auth 类型 | C（由 openai 模式推断） | `internal/agent/qwen.go:3,156`、`docs/reference.md:132` |
| Muse Code | `$XDG/muse/settings.json` | 改 `endpoint_transport`；独立模型发现端点 | R | `internal/agent/muse.go:3,44` |
| Empryo | `~/.empryo/config.json` | 添加 provider/defaultModel，按 provider 规则供 env | C（兼容型推断） | `internal/agent/empryo.go:3,42` |
| nanobot | `~/.nanobot/config.json` | 改 provider、默认模型和窗口 | C（兼容型推断） | `internal/agent/nanobot.go:13,61` |
| miniQ | `$MINIQ_DATA_DIR/settings.json` 或 `~/.local/share/miniq/`、Windows Local AppData | 改 provider，运行中发本机 `settings.update` | C | `internal/agent/miniq.go:5,48,85,130` |
| Paimon | `$PAIMON_CONFIG_HOME/config.json` 或 `~/.config/paimon/config.json` | 改 litellm provider、模型及窗口 | C（OpenAI-compatible） | `internal/agent/paimon.go:8,47,61` |
| Ante | `$ANTE_HOME` 或 `~/.ante/{catalog,settings}.json` | 改 catalog 与启动模型 | C | `internal/agent/ante.go:18,75,95` |
| AstrBot | `$ASTRBOT_ROOT/data/cmd_config.json` 或 `~/.astrbot/data/` | 改 provider source、默认模型；重启 | C（兼容型推断） | `internal/agent/astrbot.go:31,116,451` |
| QwenPaw | 工作目录的 `config.json` 和各 workspace 的 `agent.json`；secret 目录 `providers/custom/magpie.json` | 按 Agent 改 `active_model`，首连重启 | C | `internal/agent/qwenpaw.go:6,30,218,253,593` |
| OpenClaw | `~/.openclaw/openclaw.json`，支持配置路径、state dir、profile | 改 provider、默认模型及必要 allowlist | C | `internal/agent/openclaw.go:83,108,238` |
| jcode | `$JCODE_HOME/config.toml` 或 `~/.jcode/` | TOML provider profile 与新会话默认值 | C（兼容型推断） | `internal/agent/jcode.go:182,226`、`docs/reference.md:142` |
| Mistral Vibe | `$VIBE_HOME/config.toml` 或 `~/.vibe/` | TOML `providers`/`models`；需 header 或 env key，按版本 | C（兼容型推断） | `internal/agent/vibe.go:4,20,215`、`docs/reference.md:144` |
| MiniMax Code | `$MINIMAX_DATA_DIR/config.yaml` 或 `~/.minimax/`、桌面迁移目录 | YAML custom provider / 原生模型菜单 | A | `internal/agent/minimax.go:3,77,227` |
| Droid（Factory） | `~/.factory/settings.json`，支持 `$FACTORY_HOME_OVERRIDE` | 添加 BYOK `customModels`，保留用户改动 | A/R/C（按模型） | `internal/agent/droid.go:3,130,389`、`docs/reference.md:146` |
| Cline CLI | `$CLINE_DIR` 或 `~/.cline/data/settings/{providers,models}.json` | 写 `openai-compatible` 槽及模型 | C（兼容型） | `internal/agent/cline.go:53,62` |
| Qoder CLI | `$QODER_CONFIG_DIR/settings.json` 或 `~/.qoder/` | 写 BYOK custom provider | C（`openai` 型） | `internal/agent/qoder.go:56,72,321` |
| Qoder CN CLI | `$QODERCN_CONFIG_DIR/settings.json` 或 `~/.qoder-cn/` | 同上，独立账号 | C（`openai` 型） | `internal/agent/qoder.go:58,72,321` |
| Grok Build | `$GROK_HOME/config.toml` 或 `~/.grok/` | 按模型生成 TOML provider/backend | C/R/A | `internal/agent/grok.go:206,228` |
| Grok App | 应用数据 `agent-home/config.toml`；`$GROK_APP_HOME` 等 | 写 custom provider/列表；用户在 App 内选 route | C | `internal/agent/grokapp.go:62,170,250` |
| ZCode | `~/.zcode/v2/{provider_config,config}.json`，可移数据目录 | provider 和模型配置，随模型选协议 | A/C/R | `internal/agent/zcode.go:70,300,309`、`docs/reference.md:152` |
| WorkBuddy | `$WORKBUDDY_CONFIG_DIR/models.json` 或 `~/.workbuddy/models.json` | 写自定义模型，App 内每任务选 model | C | `internal/agent/workbuddy.go:3,50,98` |
| WorkBuddy AI | `~/.workbuddy-ai/models.json` | 同形状独立配置及令牌 | C | `internal/agent/workbuddy.go:25,61,98` |
| CodeBuddy | `$CODEBUDDY_CONFIG_DIR` 或 `~/.codebuddy/{models,settings}.json` | 写模型目录；CLI 可设起始模型，IDE 自选 | C | `internal/agent/codebuddy.go:6,16,46` |
| Pencil | `~/.pencil/models.json` | 写 Pi 型 provider；Magpie 写入路径默认 Chat | C（App 也支持 A/R） | `internal/agent/pencil.go:3,35,95`、`internal/agent/agents.go:938` |
| Paseo | `$PASEO_HOME/config.json` 或 `~/.paseo/config.json` | 补全模型菜单，实际由已接入 Claude Code 启动 | A（经 Claude Code） | `internal/agent/paseo.go:3,110` |
| OpenPencil | 平台 config 根 `openpencil/settings.json` | 改 `builtin_agents`，运行中拒改 | C | `internal/agent/openpencil.go:5,25,82,260` |
| OpenBot | 应用数据 `OpenBot/openbot-custom-providers-v1.json` | 写 keyless provider 与 Agent 路径，重启 | C | `internal/agent/openbot.go:7,63,192` |
| Craft Agents | `$CRAFT_CONFIG_DIR/config.json` 或 `~/.craft-agent/` | 写 Pi-compatible connection | C | `internal/agent/craftagents.go:14,65,205` |
| Obsidian | 各 vault `.obsidian/plugins/copilot/data.json`，以 `obsidian.json` 找 vault | 改 Copilot 插件自定义 provider | C（兼容型推断） | `internal/agent/obsidian.go:8,247,403` |
| Tuanjie Cowork | `~/.codely/settings.json` | 改 custom provider/model，App 内显式选择 | C | `internal/agent/tuanjiecowork.go:6,60`、`docs/reference.md:162` |
| NewMax | `$NEWMAX_USER_DATA_DIR/newmax.db` 或 `~/.newmax/` | 离线改 SQLite 的 settings/app provider 项 | A | `internal/agent/newmax.go:5,21,85,174` |
| LiveAgent | `$LIVEAGENT_HOME` 或 `$K_BRAIN_HOME/config.json`，默认 `~/.liveagent`，支持迁移目录 | 离线写三个 provider 及模型 | C/R/A | `internal/agent/liveagent.go:8,98,217` |
| Raycast | `~/.config/raycast/ai/providers.yaml` | 改 AI Custom Providers | C | `internal/agent/raycast.go:11,55` |
| Kiro Crew | `$KIROCREW_HOME/config.json` 或 `~/.kiro/crew/` | 配 ACP backend，由已接入的 harness 供模型 | 随 harness（如 A/R/C），无自身 wire | `internal/agent/kirocrew.go:12,22,370`、`docs/reference.md:157` |
| T3 Code | `$T3CODE_HOME/userdata/settings.json` 或 `~/.t3`；旁置模型表 | 两个 provider 实例，给子 CLI env 或 `-c` 参数 | A/R | `internal/agent/t3code.go:5,83,415`、`docs/reference.md:165` |
| OpenMausBot | `$OMB_DATA_DIR/config.json` 或 `~/.openmausbot/` | Claude 实例及专用 `CLAUDE_CONFIG_DIR` | A（经 Claude Code） | `internal/agent/openmausbot.go:7,21,138`、`docs/reference.md:166` |
| Avibe | `$AVIBE_HOME/config/config.json` 或 `~/.avibe` / 旧 `~/.vibe_remote` | 运行中通过本机 IPC 改 provider | C | `internal/agent/avibe.go:7,64,391`、`docs/reference.md:167` |
| Kun | `$KUN_DATA_DIR/model-connections.v2.json` 或 `~/.kun/data/` | 用 `runtime.json` 定位本机管理 API，带 revision 提交，不直接写 registry | C | `internal/agent/kun.go:12,55,69,536` |
| OpenHanako | `$HANA_HOME` 或 `~/.hanako/provider-catalog.json` 与 `agents/<id>/config.yaml` | 本机 API 或改 provider/Agent 设置 | C | `internal/agent/hanako.go:62,77,241,438` |
| AtomCode | `$ATOMCODE_HOME/config.toml` 或 `~/.atomcode/` | 写 provider account 和模型表 | C（兼容型推断） | `internal/agent/atomcode.go:58,306`、`docs/reference.md:170` |
| Open Code Review | `~/.opencodereview/config.json` | 写 custom provider 并设为在用 | C | `internal/agent/ocr.go:15,43` |
| Snow CLI | `$SNOW_CONFIG_DIR` 或 `~/.snow/profiles/magpie.json`、`config.json` | 写 active profile；Snow App 另手动导入 | C | `internal/agent/snow.go:16,62`、`docs/reference.md:172` |
| Alma | 本机 API `localhost:23001`；Alma 应用数据 | 运行中经 App API 加 preset/default，不直接改文件 | OpenAI 形状，具体请求 URL 待确认 | `internal/agent/alma.go:3,17,540,837`、`docs/reference.md:173` |
| Shelley | `$SHELLEY_SOCKET` 或 `$XDG/shelley/shelley.sock` | 向运行中的服务写 custom models 和 profile | C（`openai` 型推断） | `internal/agent/shelley.go:5,21,70,221` |
| Cindy | 由 Cindy 管理其应用数据（本地/账号 SQLite） | 导入 provider 链接，Magpie 不写配置 | A/R/C（按 harness） | `internal/agent/cindy.go:32,52,107,128` |
| AionUi | 应用数据 `AionUi/aionui/aionui-backend.db`（检测） | `aionui://add-provider` 由 App 确认，不直接写 DB | C（兼容型） | `internal/agent/aionui.go:9,35,48,109` |
| Cherry Studio | 应用数据，或 `~/.cherrystudio/boot-config.json` 指向目录（检测） | `cherrystudio://providers/api-keys` 交给 App，不直接改存储 | C | `internal/agent/cherrystudio.go:8,42,68` |
| Lody | 平台应用数据 `Lody/`（检测），无 Magpie 配置写入 | `lody://provider/import` 由 App 确认 | A/R/C（按 harness） | `internal/agent/lody.go:69,81,106`、`docs/reference.md:175` |

动态范围：`All` 还追加已安装插件提供的声明式 Agent、WSL 实例及 `omp`、`qwenpaw`、`hermes`、Claude 隔离目录派生的 profile 行；不能将它们固定成额外几个通用 Agent。Kimi Code Desktop 共享 Kimi 引擎配置，在 `others` 中只追加流量归属名称；curl、PI-Desktop 等在该集合不代表独立写入适配。见 `internal/agent/agents.go:194,218,258,286,414`、`internal/agent/plugged.go:93`、`internal/agent/wsl.go:510`。OpenAI 兼容但本仓没有直接 wire 证据的行，不应在实现前升格为已确认端点。

## 五个优先 Agent

### Claude Code

- **两种接管不同。** 全局模式改目标 Claude home 的 `settings.json` 中 `env.ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、主模型和模型档位；会话模式在 Magpie 自有 `claude-launch/settings.json` 生成覆盖，`magpie claude run` 将 `--settings <path>` 加在所传参数前。注释记录以 Claude Code 2.1.318 验证覆盖优先级；不改用户文件，并给覆盖文件中的 `ANTHROPIC_API_KEY` 及可能绕过代理的 cloud 选择置空。不要把此结论推广到未验版本/策略配置。见 `internal/agent/claude.go:27,709,754`、`internal/agent/claude_launch.go:13,49,62`、`internal/cli/claude_launch_cli.go:75`；参数/路径测试 `internal/cli/claude_launch_cli_test.go:22`。
- **首轮 OneX 建议：** 用 Desk 启动已下载且锁版本的 CLI、独立 OneX settings、本机令牌，不碰个人 OAuth 文件；实测现有 shell/项目/managed settings 的优先级，并测试 plain `claude` 保持原路。会话记录在各 Claude home `projects/`，按 JSONL 会话/分支读取；只纳管 OneX 启动实例，不因同一目录里有历史就上传。见 `internal/sessions/sessions.go:640,649,917`。是否独立 `CLAUDE_CONFIG_DIR`（可隔离会话但会隔离用户配置）留裁决。

### Codex

- `$CODEX_HOME` 优先，默认 `~/.codex`；`config.toml` 添加 `[model_providers.magpie]` 的 `/v1`、`wire_api="responses"`、local bearer，顶层 `model_provider`、`model_catalog_json`、`model` / effort；配置默认模型不是上游密钥。Magpie 可独立 `codex -p magpie`，只写 `magpie.config.toml`/目录文件；旧 `[profiles.*]` 或顶层 `profile` 会影响此方式（注释记录 0.165.0）。见 `internal/agent/wsl.go:116`、`internal/agent/codex.go:265,1927,2369`、`internal/agent/codex_profile.go:15,35`。
- GUI app-server 在启动时吃 provider 配置，改 catalog 内容不等于路由变更，不应每次都重启；原生线程可能与 provider ID 绑定，Magpie 有迁移/还原逻辑，OneX 不应默认改写既有线程。记录目录 `sessions`/`archived_sessions`，还可能有 SQLite 线程索引；与代理 usage 关联需独立处理。见 `internal/agent/agents.go:104,118`、`internal/agent/codex.go:783,992`、`internal/sessions/sessions.go:1217,1247`、`internal/sessions/codex_catalog.go:97,125`。

### Kimi Code

- 新 TypeScript 2.x 先找 `$KIMI_CODE_HOME`/`~/.kimi-code`，老 Python 用 `$KIMI_SHARE_DIR`/`~/.kimi`；新目录存在时不会回读旧目录。添加 `[providers.magpie]` 的 `type="kimi"`、base `/v1`、本机 key，以及 `[models.*]` 与 `default_model`；保留原有表及能力/上下限覆盖。移除模型前先修剪已经引用它的副 Agent pool。旧版启动时读取，运行中 picker 可能仍显示旧内容；不能把 provider 成功写入当作切换成功。见 `internal/agent/kimi.go:3,46,67,257,271,292,574`。
- 桌面只是在同一个 Kimi home 上跑引擎（`internal/agent/agents.go:218`）。新版会话 `sessions/<workdir>/<sid>/agents/<agent>/wire.jsonl` 和 `state.json`，需区分主从；旧版文件布局另查。见 `internal/sessions/kimi.go:18,61`。OneX 需实测锁定版本的 `/chat/completions` 和模型选择，并把“接入 Kimi Agent”与“Kimi Code Plan 按人发凭证”作为两个问题。

### WorkBuddy

- 中国版 `$WORKBUDDY_CONFIG_DIR` 或 `~/.workbuddy`；国际版 `~/.workbuddy-ai` 由 Magpie 分开处理。文件可为裸数组也可为含 `models`、`availableModels` 的对象；需保旧 envelope 和用户项。每项写全 URL `/v1/chat/completions`、模型 ID、能力/上下文/effort，凭据是本机 key。App 显示 `custom-local:<id>`，实际 POST 仍是条目的 ID；模型按任务在 App 自选，不应宣称编辑文件即切所有任务。见 `internal/agent/workbuddy.go:3,50,61,137,234,420,449`。
- 5.6 的实现线索：文件启动时不存在就可能没注册 watch，原子替换也可能丢旧 inode watch；准备重启并用请求验证。当 macOS 没 App bundle，数据目录本身不是已安装。原生项目记录见 `internal/sessions/workbuddy.go:31,100`。WorkBuddy 上游订阅迁移（`AGENTS.md` 的 provider movers）不等于此桌面适配迁移。

### DeepSeek Harness Desktop

- `$DSH_HOME`（默认 `~/.dsh`）。现代 profile 走 `profiles/<name>/cordis.patch.yml`，桌面默认 `desktop`，首次运行前可生成 profile；旧式兼容 `config.yaml`。当前源码的 `dshBeforeProfiles` 以 `0.0.1-rc.1` 为已知版本分界；`docs/reference.md:123` 的「0.1.5 前」不是该分支当前的判断，不应当成 OneX 的分流条件。`llm-pi-ai` 自定义 provider 同时可发 C/R/A，两个 OpenAI base 用 `/v1`、Anthropic 用根路径（SDK 自动补 `/v1`）；用 `MAGPIE_GATEWAY_KEY` 读 `.env` 和桌面也读的 `.credentials.yaml`，不应复用或覆盖原有 DeepSeek API key。见 `internal/agent/dsh.go:104,185,398,410,427,1462,1500,2102,2190`。
- `settings.yaml`、profile 本地覆盖和已有 session 的模型选择不是一回事；装好后必须在新会话观察出站。断开时只移除自己路由/凭据标记，保留用户已选择的模型和应用创建的 profile，未首启自建空 profile 可清理。原生会话日志 `sessions/<workdir>/<sid>/session[.vN].jsonl[.zstd]`；选最新格式，fork seed 是继承内容，不重复回流当新增。见 `internal/agent/dsh.go:143,165,225,490,1590`、`internal/sessions/dsh.go:23,75`。

**待裁决：** OneX CLI 是否统一用 launcher/profile 隔离外部启动；WorkBuddy 与 DSH 必须持久化 provider 配置时，共用用户目录还是独立 profile、遇冲突提示还是拒绝启动；第一版精确的 Mac/Windows 版本矩阵及是否包含 WorkBuddy AI。插件与动态派生项不作为第一版补齐承诺。