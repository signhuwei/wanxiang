# Desktop UI ↔ 原生桥

UI 是本地静态 HTML/ESM，不直连 Server、daemon socket 或上游。edge 持有 Tauri 命令适配、HTTP、凭据存储、设备注册、发行包校验与启动。现有 onex-core 的 `status/login/shutdown` 是 daemon 私有 IPC，不能直接暴露给 WebView。

## 调用和数据

本地窗口使用专用命令 `desktop_call`，参数 `{request:{op,...}}`；返回 `{ok:true,state:Snapshot}` 或 `{ok:false,error:{code,message}}`。仅接受下表列出的 op 和字段。IPC 失败并不等于退出登录。一次只允许一个变更请求；UI 不重放变更；再次显示窗口、启动完成或每两秒可见时读取 `state`。原生桥不向网页提供任意命令、路径、可执行文件、下载 URL 或环境变量入口。

| op | 入参 | 行为 |
|---|---|---|
| `state` | 无 | 返回当前安全快照，不触发网络写操作 |
| `send_code` | `target` | 向配置好的 Server 请求验证码；限流错误原样分类 |
| `login` | `target,code,invite_code?` | `kind:desktop`；邀请码仅用于入租。返回选租户快照，不返回令牌 |
| `select_tenant` | `tenant_id` | 只能选择返回的稳定 ID。原生层换租户令牌并注册设备、连接 onexd |
| `download` | `agent_id` | 后台下载及校验当前获准的发行。onexd 自行确定版本、来源和摘要，接受后通过快照报告实际进度 |
| `launch` | `agent_id` | 仅启动当前目录授权的 `claude-code`、`codex` 或 `kimi-code`。原生层验证设备与授权，将所选 Agent 交给随包 CLI，下载及校验由 onexd 完成。重复点击不另启进程 |
| `settings` | `hide_on_close:boolean` | 设置关闭窗口时是否隐藏到托盘。只改此偏好；Server 地址在 S1 UI 中只读 |
| `logout` | 无 | 作废会话，清设备关联和本地敏感态；不得被旧登录、同步、启动回调恢复 |

`Snapshot` 示例（字段名使用 snake_case）：

```json
{"version":"0.1.0-demo","phase":"ready","user":{"name":"示例员工"},"tenant":{"id":"ten_demo","name":"示例租户"},"tenants":[],"connection":"connected","agents":[{"id":"claude-code","name":"Claude Code","version":"demo","status":"available","actions":["launch"]}],"settings":{"server_origin":"https://onex.example.invalid","hide_on_close":true}}
```

macOS 桌面一键启动 Codex 的默认工作目录是 `~/OneX Workspace`。通过终端在其他项目目录运行 `onex run codex` 时，保留该终端的工作目录。

`phase`：`signed_out | choose_tenant | ready`。登录前 `user/tenant` 为 null，目录为空。选择态 `tenants:[{id,name}]`、`tenant:null`；包括单租户，用户确认后再进入。`ready` 目录仅含当前身份允许查看的 Agent。`connection: idle | connecting | connected | backoff`；短时失联不是注销。顶层 `version` 是 Desktop 应用版本（不是 daemon 或 Agent 版本），所有阶段均返回，设置页展示。`agents[].status: available | update_available | not_downloaded | downloading | verifying | starting | running | download_failed | policy_pending | failed`；`update_available` 在 S1 仅作提示，`actions:[]`，页面不提供启动或更新。失败可带中文 `message`。仅 `actions` 含 `launch` 才提供启动，不按连接状态猜授权。快照不含验证码、令牌、安装路径、Provider 密钥、对话内容或完整日志；`server_origin` 无用户信息/query/fragment。错误用契约码及可展示中文，桥不可将敏感原始异常转发给 UI。

能力策略状态仅在登录的设备与租户匹配时返回。`policy` 包含已应用的设备配置修订、策略修订、平台签发修订、租户配置修订与脱敏展示条目。`policy_pending` 表示设备未接受最近一次应执行的快照，等待同步时不提供受管启动。`notices` 是随已应用策略收到的最近消息，按消息 ID 去重。工作台按本机设备展示通知，消息列表不包含其他租户的数据。

工作台的 `local_usage` 记录本次 onexd 运行期间的模型请求计量用量、模型请求累计时长、输入和输出 Token。它可能包含尚未结算的用量，重启后重新累计。`agents` 提供适配器的厂商、运行类别、实际已登记实例数，以及下载期间的已接收字节、目标大小和校验阶段。状态和按钮均由实际授权与本机准备结果驱动。

### UI 中文文案（只按枚举选取，不展示自由文本）

| error.code | 显示 | error.code | 显示 |
|---|---|---|---|
| unauthenticated | 登录凭据无效或已过期 | forbidden | 没有权限执行此操作 |
| not_found | 对象不存在 | conflict | 状态已变化，请刷新后重试 |
| invalid | 请检查输入内容 | seat_limit | 租户人数已达合约上限 |
| balance_exhausted | 橡皮余额不足 | lease_expired | 额度租约已过期 |
| agent_not_allowed | 合约不允许该 Agent | model_not_allowed | 合约不允许该模型 |
| rate_limited | 请求过快，请稍后重试 | upstream_error | 上游服务出错 |
| internal | 服务内部错误 | 未知/缺失 | 操作失败，请稍后重试 |

拒绝的 invoke 不显示异常字符串；变更请求提示「本机服务暂不可用，请稍后重试」，读取提示「无法读取本机状态，请检查 OneX 服务。」。Agent `failed` 显示「启动失败」，若桥附 `message` 仅补固定提示「请稍后重试或联系管理员」；未知 Agent 状态显示「状态未知」。UI 不展示 `message/detail` 原文。原生返回前仍须裁剪，不能靠隐藏文本来保护 WebView 内存。

## 本轮交付与验收边界

页面展示登录、选择租户、Agent 列表和设置。浏览器演示须显式选 mock，显著标记，使用固定示例输入，不写浏览器持久存储，不发送验证码、不下载或启动进程。非 mock 且无原生桥时显示不可用，不冒充在线。UI 由 web 在 `desktop-ui/` 实现；edge 审核 op、快照和偏好后实现 Rust/Tauri。真安装、IPC、Keychain、托盘、断网、进程启动及双击并发保护由集成验收，不以页面演示替代。
