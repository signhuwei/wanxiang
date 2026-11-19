# S1-E6 · Desktop UI ↔ 原生桥（提审稿）

这是 UI 与 edge 之间的提案，不是已实现的 Rust API。UI 是本地静态 HTML/ESM；不直连 Server、daemon socket 或上游。edge 持有 Tauri 命令适配、HTTP、凭据存储、设备注册、发行包校验与启动。现有 onex-core 的 `status/login/shutdown` 是 daemon 私有 IPC，不能直接暴露给 WebView。

## 调用和数据

提议一个本地窗口专用命令 `desktop_call`，参数 `{request:{op,...}}`；返回 `{ok:true,state:Snapshot}` 或 `{ok:false,error:{code,message}}`。仅接受下表列出的 op 和字段。IPC 失败并不等于退出登录。一次只允许一个变更请求；UI 不重放变更；再次显示窗口、启动完成或每两秒可见时读取 `state`。原生桥不向网页提供任意命令、路径、可执行文件、下载 URL 或环境变量入口。

| op | 入参 | 行为 |
|---|---|---|
| `state` | 无 | 返回当前安全快照，不触发网络写操作 |
| `send_code` | `target` | 向配置好的 Server 请求验证码；限流错误原样分类 |
| `login` | `target,code,invite_code?` | `kind:desktop`；邀请码仅用于入租。返回选租户快照，不返回令牌 |
| `select_tenant` | `tenant_id` | 只能选择返回的稳定 ID。原生层换租户令牌并注册设备、连接 onexd |
| `launch` | `agent_id` | 仅启动当前目录授权项；原生层再次验证身份、许可和版本，处理下载及校验，迅速返回进行中状态。重复点击不另启进程 |
| `settings` | `hide_on_close:boolean` | 设置关闭窗口时是否隐藏到托盘。只改此偏好；Server 地址在 S1 UI 中只读 |
| `logout` | 无 | 作废会话，清设备关联和本地敏感态；不得被旧登录、同步、启动回调恢复 |

`Snapshot` 示例（字段名使用 snake_case）：

```json
{"phase":"ready","user":{"name":"示例员工"},"tenant":{"id":"ten_demo","name":"示例租户"},"tenants":[],"connection":"connected","agents":[{"id":"claude-code","name":"Claude Code","version":"demo","status":"available","actions":["launch"]}],"settings":{"server_origin":"https://onex.example.invalid","hide_on_close":true}}
```

`phase`：`signed_out | choose_tenant | ready`。登录前 `user/tenant` 为 null，目录为空。选择态 `tenants:[{id,name}]`、`tenant:null`；包括单租户，用户确认后再进入。`ready` 目录仅含当前身份允许查看的 Agent。`connection: idle | connecting | connected | backoff`；短时失联不是注销。`agents[].status: available | downloading | verifying | starting | running | failed`，失败可带中文 `message`。仅 `actions` 含 `launch` 才提供启动，不按连接状态猜授权。快照不含验证码、令牌、安装路径、Provider 密钥、对话内容或完整日志；`server_origin` 无用户信息/query/fragment。错误用契约码及可展示中文，桥不可将敏感原始异常转发给 UI。

## 本轮交付与验收边界

页面展示登录、选择租户、Agent 列表和设置。浏览器演示须显式选 mock，显著标记，使用固定示例输入，不写浏览器持久存储，不发送验证码、不下载或启动进程。非 mock 且无原生桥时显示不可用，不冒充在线。UI 由 web 在 `desktop-ui/` 实现；edge 审核 op、快照和偏好后实现 Rust/Tauri。真安装、IPC、Keychain、托盘、断网、进程启动及双击并发保护由集成验收，不以页面演示替代。
