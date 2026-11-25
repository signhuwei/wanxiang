# S1-E6 · 将 Desktop 页面装入 Tauri 2

给 edge 的原生壳接入说明。发布包嵌入下方列出的前端资源。只有本地 `main` WebView 可以调用业务命令 `desktop_call`。 [IPC.md](IPC.md)

## 1. 静态入口：不启动 Web 服务器

`index.html` 加载本地样式、脚本和标志。下面是 `edge/desktop/tauri.conf.json` 的配置片段，资源路径以配置文件为起点。

```json
{
  "build": {
    "frontendDist": [
      "../../desktop-ui/index.html",
      "../../desktop-ui/app.css",
      "../../desktop-ui/app.js",
      "../../server/web/theme.css",
      "../../server/web/logo.png"
    ]
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [{ "label": "main", "title": "OneX Desktop", "url": "index.html" }],
    "security": {
      "capabilities": ["desktop-main"],
      "csp": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"
    }
  }
}
```

`frontendDist` 的文件数组按文件名放到资源根目录；不要改成整个源码目录或额外塞进 `bundle.resources`。不要提供远程 `url` 或发布用 `devUrl`。这样既不打包测试、设计文档和 `node_modules`，也不携带 `mock.js`。源码中的动态导入只服务普通浏览器的显式 `?mock=1`；有原生桥时即使带此参数也不走 mock。开发预览与签收分开：浏览器跑 `desktop-ui/tests/browser.js`，发布验收用真实本地资源协议和原生桥。

## 2. CSP 管资源；原生 ACL 管命令

- `withGlobalTauri: true` 是因为现有无打包页面读取 `window.__TAURI__.core.invoke`。有 JS 接口**不等于**有执行权限；隐藏 JS 属性也不是权限控制。
- 脚本、样式只来自本地包。`ipc:` 与 `http://ipc.localhost` 是 Tauri IPC 传输目标，不是允许访问任意 localhost 端口。不要加入 Server、上游、通配域、`unsafe-inline` 或 `unsafe-eval`。登录 HTTP 和 daemon 通信由原生层执行。禁止外部顶层导航与新窗口，在原生导航/新窗口回调按本地应用来源拒绝；CSP 的 `connect-src` 不限制顶层导航。
- HTML 当前还有一份 CSP `<meta>`，供浏览器预览。**两份策略同时生效，取交集**；保留 Tauri 构建时的 CSP hash/nonce 注入，不开启 `dangerousDisableAssetCspModification`。若原生框架注入受重复 meta 限制，在发布资源准备阶段生成无重复 CSP meta 的入口，以 `app.security.csp` 为发布策略，保留源文件供独立预览；不要为消除报错放宽整套 CSP。暂存时按 `frontendDist` 列表复制资源。

## 3. 只向本地 `main` 授予 `desktop_call`

以下三层须一起配置。仅仅写一个 capability 文件而仍注册别的自定义命令，不能代替完整的命令清单审查。

1. **构建时列入 app manifest。** `build.rs` 通过 `tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["desktop_call"])))` 并检查返回结果。这样生成应用命令权限 `allow-desktop-call`。最终使用锁定版本生成的 `gen/schemas` 校验配置；权限名用连字符，invoke 命令名用下划线。
2. **运行时只注册一个业务入口。** `Builder::invoke_handler(tauri::generate_handler![desktop_call])`。不要注册通用转发到 socket、shell、文件读写或打开 URL 的命令；也不向 UI 授予插件或 `core:default` 权限。托盘、隐藏窗口、启动进程由 Rust 内部代码完成。审查最终合并后的配置：只启用 `desktop-main`，移除模板默认 capability 以及可能在平台配置中叠加的授权。
3. **限定调用者和参数。** 在 `capabilities/desktop-main.json` 按下面的 WebView 标签绑定，`local:true`，不设置 `remote`。原生处理器从 Tauri 注入上下文再确认 `main` 本地调用者，不相信请求自报身份；把 `request` 反序列化为封闭 op 列表，拒绝未知字段。按当前身份校验选租户、Agent、启动权限及进行中状态。不能把 `launch` 扩成传命令行、路径、环境变量或 URL。凭据进原生安全存储；日志和错误均不含凭据，返回只用 [IPC.md](IPC.md) 的安全快照。

```json
{
  "identifier": "desktop-main",
  "description": "OneX 本地员工窗口的业务桥",
  "local": true,
  "webviews": ["main"],
  "permissions": ["allow-desktop-call"]
}
```

单窗口单 WebView 使用同一 `main` 标签；如壳采用独立 WebView 标签，应绑定实际唯一标签。不要同时再匹配全部窗口、全部 WebView 或 URL；不要允许远程页面获得本地桥。

### 原生出站边界（所有 phase 和错误分支）

使用独立的出站 DTO 逐字段构造快照：仅给 `version, phase, user{name}, tenant{id,name}, tenants[]{id,name}, connection, agents[]{id,name,version,status,actions,message?}, settings{server_origin,hide_on_close}`。服务地址仅为规范化 origin，不含身份、路径、query 或 fragment；错误只给白名单 `code` 和固定的脱敏文案。禁止直接序列化 daemon 对象、下游响应、异常链/栈、请求体或调试 detail；这同样适用于 Tauri 的 reject 和日志。Agent `message` 可省略，不能包含原始错误。UI 依 [IPC 中文文案表](IPC.md) 按码选择文字，但不能撤销已经跨过桥的数据。

在原生测试夹具的额外嵌套字段、错误链和地址 query 中放入合成标记，覆盖登录成功/失败、启动失败、断线、注销。逐个检查**完整 IPC 回包及 reject**、界面和日志均无标记；不使用真实密钥作探针。

## 4. edge 的发布验收（待真实壳执行）

| 检查 | 通过判据 |
|---|---|
| 包内资源与离线冷启动 | 核对最终资源清单仅含上述三个 UI 文件；断开外网仍能绘出窗口和调用本地 `state`，无开发服务器依赖。`mock.js`、测试和 Markdown 不可加载。 |
| CSP 实效 | 在签收构建中检查最终文档策略与 WebView 控制台：本地 CSS/ESM 和 `desktop_call(state)` 正常，无 CSP 错误；受控测试的非允许源请求被拒绝。不可用放开 localhost 或整个脚本策略来修复。 |
| 最小权限 | 检查生成的 capability 和注册表。用原生集成测试验证：本地 `main` 的 `state` 成功；未知命令、其他 WebView 的调用、未知 op/字段、非目录 Agent 均被拒，且无网络写入或进程启动。导航到外部页面/弹出窗口被取消。 |
| WebView 零外部请求 | 用打包配置的验收构建，在 WebView Network 面板保留跨导航记录（macOS 用 Web Inspector），覆盖冷启动、发码、登录、选租户、启动、设置和登出。按发起方与 origin 核对：只应看到打包资源及本机 Tauri IPC，**外部请求数为 0**，包括 Server/上游、远程字体/图片、遥测、WS；即使被 CORS 拒绝的外发尝试也不算通过。分别记录原生层网络，不将原生登录流量计到 WebView。留脱敏的目标分类/计数和最终生效 CSP（含 Tauri 注入项，与 §1 比较），不留含请求体或令牌的 HAR。 |
| 业务与边界 | 登录→选租户→启动→设置→注销；Desktop 版本可见，`update_available` 无操作；重开窗口不复活旧身份。只记录状态、版本、错误码，不记录验证码、令牌或请求体。浏览器 mock 通过不代替此项。 |

配置依据：Tauri 2 [Configuration](https://v2.tauri.app/reference/config/)、[Capabilities](https://v2.tauri.app/security/capabilities/)、[CSP](https://v2.tauri.app/security/csp/)。本次对照了本机 `tauri-utils 2.9.3`（`FrontendDist`、capability、权限生成）和 `tauri-build / tauri-codegen 2.6.3`（`AppManifest`、文件路径解析）；edge 锁定不同版本时以其 schema 和实际打包结果为准。
