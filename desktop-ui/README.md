# OneX Desktop · 前端设计与预览

S1-E6 窗口使用本地 HTML/CSS/ESM，无打包、无 CDN。原生层和 onexd 属于 edge；接口提案见 [IPC.md](IPC.md)。本次没有修改 Rust，也不会真实启动 Agent。

- **工作台**依身份状态只显示一步：验证码登录（邀请码可选）→按 ID 选择租户→当前租户允许的 Agent。启动入口取自 `actions`，不从名称或 WS 状态推断。顶部始终可进入设置。
- **设置**显示服务地址和隐藏到托盘的偏好，允许退出。模拟窗口只演示状态变化，不操作系统托盘。
- **离线演示**必须显式传 `?mock=1`；使用固定示例账号、验证码及邀请码，数据只在内存中。无桥也未指定 mock 时显示「未连接桌面服务」。普通浏览器不代表 Tauri 已联通。
- **交付边界**：发包时仅包含 `index.html`、`app.css`、`app.js` 和所需本地模块；不要打包 tests、设计文档或提供远程页面加载。托盘、凭据保护和进程执行由原生层独立验证。静态预览通过，不替代干净 Mac 安装与真实启动验收。

从 worktree 根目录运行：

```sh
bun test ./desktop-ui/tests
bun install --cwd server/web/tests --frozen-lockfile
bun desktop-ui/tests/browser.js
```

浏览器用例自行创建临时 loopback 静态服务，使用项目内 Playwright 与本机 Chrome，无需运行 Server 或 onexd。
