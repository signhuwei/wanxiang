# Desktop UI ↔ 原生桥

UI 是本地静态 HTML/ESM，不直连 Server、daemon socket 或上游。edge 持有 Tauri 命令适配、HTTP、凭据存储、设备注册、发行包校验与启动。现有 onex-core 的 `status/login/shutdown` 是 daemon 私有 IPC，不能直接暴露给 WebView。

## 调用和数据

本地窗口使用专用命令 `desktop_call`，参数 `{request:{op,...}}`；返回 `{ok:true,state:Snapshot}` 或 `{ok:false,error:{code,message}}`。仅接受下表列出的 op 和字段。IPC 失败并不等于退出登录。一次只允许一个变更请求；UI 不重放变更；再次显示窗口、启动完成或每两秒可见时读取 `state`。原生桥不向网页提供任意命令、路径、可执行文件、下载 URL 或环境变量入口。

| op | 入参 | 行为 |
|---|---|---|
| `state` | 无 | 返回当前安全快照，不触发网络写操作 |
| `diagnostics` | 无 | 读取当前桌面进程及已核验设备的最近诊断事件，返回 `{ok:true,diagnostics:{desktop_version,daemon_version,entries}}` |
| `issue_list` | `cursor?` | 由 onexd 使用当前设备令牌读取本用户在当前租户的反馈记录，不向 WebView 暴露令牌 |
| `issue_submit` | `text,images,include_logs` | 提交文本、最多 3 张 PNG/JPEG/WebP 图片（每张最大 1 MiB）及可选最近 28 条白名单诊断日志；仅转发当前设备身份，服务端重新核对令牌与归属 |
| `install_update` | `version` | 用户确认标题栏当前显示的目标版本后请求更新。原生层复核发行并启动更新，保持正在运行的 Agent 纳管 |
| `send_code` | `target` | 向配置好的 Server 请求验证码；限流错误原样分类 |
| `login` | `target,code,invite_code?` | `kind:desktop`；邀请码仅用于入租。返回选租户快照，不返回令牌 |
| `password_login` | `tenant,username,password` | 接受租户 ID 或简称。以 `kind:desktop` 验证账号，沿用当前设备、恢复该账号的原设备或注册新设备，完成后注销该用户会话。快照只含公开显示信息 |
| `select_tenant` | `tenant_id` | 只能选择返回的稳定 ID。原生层换取租户会话，再验证或恢复设备 |
| `download` | `agent_id` | 后台下载及校验当前获准的发行。onexd 自行确定版本、来源和摘要，接受后通过快照报告实际进度 |
| `launch` | `agent_id` | 原生层验证设备与授权。CLI Agent 通过系统窗口选择工作目录后交给随包 CLI，桌面 Agent 使用自己的工作区选择器。下载及校验由 onexd 完成。重复点击不另启进程 |
| `settings` | `hide_on_close:boolean` | 设置关闭窗口时是否隐藏到托盘。只改此偏好；Server 地址在 S1 UI 中只读 |
| `reconnect` | `force?:boolean` | 设置页重启本机 onexd，确认后台重新就绪后读取新状态。保留当前设备凭据和历史。后台有 Agent、请求或准备工作时返回 `reconnect_busy`。只有用户在风险提示中确认后，才发送 `force:true` |
| `logout` | 无 | 受管 Agent 退出并完成回流后，移除当前本机设备令牌并清空显示状态。系统凭据库保留归属已验证的设备密钥 |

`Snapshot` 示例（字段名使用 snake_case）：

```json
{"version":"0.1.0-demo","phase":"ready","user":{"name":"示例员工"},"tenant":{"id":"ten_demo","name":"示例租户"},"tenants":[],"connection":"connected","agents":[{"id":"claude-code","name":"Claude Code","version":"demo","status":"available","actions":["launch"]}],"settings":{"server_origin":"https://onex.example.invalid","hide_on_close":true}}
```

从 Desktop 启动 CLI Agent 时，选中的工作目录由原生层传给终端，取消选择返回 `launch_cancelled`。通过终端运行 `onex run` 时，沿用该终端的工作目录。

`phase`：`signed_out | choose_tenant | ready`。登录前 `user/tenant` 为 null，目录为空。选择态 `tenants:[{id,name}]`、`tenant:null`；包括单租户，用户确认后再进入。`ready` 目录仅含当前身份允许查看的 Agent。`connection: idle | connecting | connected | backoff`；短时失联不是注销。顶层 `version` 是 Desktop 的完整打包版本，所有阶段均返回，设置页展示。原生窗口启动时也会提供同一版本，Logo 下方无需等待 daemon 即可显示。`agents[].status: available | update_available | not_downloaded | downloading | verifying | starting | running | download_failed | policy_pending | failed`；`update_available` 在 S1 仅作提示，`actions:[]`，页面不提供启动或更新。失败可带中文 `message`。快照不含验证码、令牌、安装路径、Provider 密钥、对话内容或完整日志；`server_origin` 无用户信息/query/fragment。错误用契约码及可展示中文，桥不可将敏感原始异常转发给 UI。

`agents[].launch_blocked` 可为 `daemon_update_pending` 或 `launch_in_progress`，只在具备启动条件的 Agent 暂需等待时返回。页面显示禁用的「启动」和等待原因，正在运行的 Agent 仍显示运行状态及实例数。`actions` 含 `launch` 时启动操作才可执行。

点击启动立即显示等待状态。`agents[].workspace_pending` 表示原生工作目录选择正在进行。目录选择和启动请求期间，页面继续读取后台状态及已展开的诊断日志。选好目录后，等待状态跟随后台的准备进度。用户取消选择时恢复启动操作，已有的运行实例计数持续更新。

反馈使用已配置的 OneX 控制面地址直连。提交或读取失败时，Desktop 诊断日志记录固定错误代码、执行阶段及已有的 HTTP 状态。提交失败保留草稿。诊断记录不含反馈正文、图片、设备令牌或服务原始错误。

底部「诊断日志」展开时读取最多 150 条事件，可按级别、来源和关键词筛选。列表显示到秒，逐项展开「详细」可查看 UTC 毫秒时间戳、事件标识、代码模块及确有的版本、Agent、错误代码、执行阶段、HTTP 状态、配置修订号和退出码。模型请求诊断区分本机租约拦截、模型渠道返回的 HTTP 错误，以及按租约调低输出上限。可查看相应模型、预留费用和租约上限（块），或请求的与实际采用的输出 Token 上限。刷新保留已展开记录。桌面桥按当前设备隔离诊断范围，只从受信目录读取最近的固定格式日志并提取白名单字段。凭据、会话内容、文件路径和原始错误消息均不进入 WebView。

能力策略状态仅在登录的设备与租户匹配时返回。`policy` 包含已应用的设备配置修订、策略修订、平台签发修订、租户配置修订与脱敏展示条目。`policy_pending` 表示设备未接受最近一次应执行的快照，等待同步时不提供受管启动。`notices` 是随已应用策略收到的最近消息，按消息 ID 去重。工作台按本机设备展示通知，消息列表不包含其他租户的数据。

若 onexd 已由命令行登录，Desktop 在认证后用租户会话核对该设备的归属账号和有效状态。确认属于同一租户及账号后，保留设备 ID 和现有连接，只保存 Desktop 的显示资料。归属不同或设备不可验证时返回 `device_already_logged_in` 并保留当前会话。切换账号前可运行 `onex logout`。Windows 默认安装位置可在 PowerShell 中执行 `& "$env:LOCALAPPDATA\OneX Desktop\onex.exe" logout`，再从托盘退出并重新打开 Desktop。

系统凭据库按服务地址、租户 ID 和用户 ID 保存已验证的设备归属。同一账号重新登录时由 onexd 用旧设备私钥换发令牌，重启后打开原设备的对话、回流游标及待同步队列。新账号独立注册设备。旧 Edge 首次升级后离线退出时，系统凭据库仅保留原设备密钥。之后通过服务端验证再将它关联到原账号。受管终端重启后仍运行时，须等它退出后切换账号。

工作台的 `local_usage` 记录本次 onexd 运行期间的模型请求计量用量、模型请求累计时长、输入和输出 Token。它可能包含尚未结算的用量，重启后重新累计。`agents` 提供适配器的厂商、运行类别、实际已登记实例数，以及下载期间的已接收字节、目标大小和校验阶段。状态和按钮均由实际授权与本机准备结果驱动。

`desktop_update` 可省略。存在时包含目标 `version`，以及 `phase: available | downloading | installing | failed`。下载时可附 `downloaded_bytes` 与 `total_bytes`。标题栏只显示已通过签名验证的更新及其进度，用户明确确认后才发送目标版本。Desktop 重启时复用现有 daemon、设备身份与受管任务。Windows 更新制品包含 Desktop、CLI 和 daemon。Desktop 重启后可显示 `waiting_for_agents | updating_components | components_failed`，当前 Agent 和请求结束后才激活新 CLI 和 daemon。

macOS 覆盖安装和自动更新都会在 Desktop 启动后核对实际运行的 onexd 版本。版本不一致期间继续显示现有运行实例，暂停从工作台启动新实例，直到 onexd 切换完成。标题栏可显示 `waiting_for_agents | restarting_daemon | daemon_restart_required | components_failed`。Desktop 只向安装登记的 LaunchAgent 请求安全切换。RC22 至 RC24 停留在旧后台时，Desktop 在确认设备空闲、原厂窗口已退出、残留 Host 属于原 onexd 进程组且签名匹配后，才发送正常退出信号。若 LaunchAgent 退出后因注册配置错误无法启动，Desktop 可重新注册已验证的 OneX LaunchAgent。

### UI 中文文案（只按枚举选取，不展示自由文本）

| error.code | 显示 | error.code | 显示 |
|---|---|---|---|
| unauthenticated | 登录凭据无效或已过期 | forbidden | 没有权限执行此操作 |
| not_found | 对象不存在 | conflict | 状态已变化，请刷新后重试 |
| device_already_logged_in | 本机 OneX 已登录。请用同一租户和账号登录，或先用 OneX 命令行退出。 | | |
| agents_running | 请先关闭已启动的 OneX Agent | history_unavailable | 暂时无法恢复当前账号的本机会话 |
| invalid | 请检查输入内容 | seat_limit | 租户人数已达合约上限 |
| balance_exhausted | 橡皮余额不足 | lease_expired | 额度租约已过期 |
| agent_not_allowed | 合约不允许该 Agent | model_not_allowed | 合约不允许该模型 |
| rate_limited | 请求过快，请稍后重试 | upstream_error | 上游服务出错 |
| tool_bundle_unavailable | 无法下载或校验受管工具制品，见底部诊断日志 | | |
| update_unavailable | 当前更新已不可用，请稍后重试 | update_failed | Desktop 更新失败，请重试 |
| reconnect_busy | 显示重连确认框 | reconnect_failed | 后台服务重连失败，请重试 |
| internal | 服务内部错误 | 未知/缺失 | 操作失败，请稍后重试 |

拒绝的 invoke 不显示异常字符串；变更请求提示「本机服务暂不可用，请稍后重试」，读取提示「无法读取本机状态，请检查 OneX 服务。」。Agent `failed` 显示「启动失败」，若桥附 `message` 仅补固定提示「请稍后重试或联系管理员」；未知 Agent 状态显示「状态未知」。UI 不展示 `message/detail` 原文。原生返回前仍须裁剪，不能靠隐藏文本来保护 WebView 内存。

## 本轮交付与验收边界

页面展示登录、选择租户、Agent 列表和设置。浏览器演示须显式选 mock，显著标记，使用固定示例输入，不写浏览器持久存储，不发送验证码、不下载或启动进程。非 mock 且无原生桥时显示不可用，不冒充在线。UI 由 web 在 `desktop-ui/` 实现；edge 审核 op、快照和偏好后实现 Rust/Tauri。真安装、IPC、Keychain、托盘、断网、进程启动及双击并发保护由集成验收，不以页面演示替代。
