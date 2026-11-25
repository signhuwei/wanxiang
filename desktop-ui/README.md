# OneX Desktop · 前端设计与预览

窗口使用本地 HTML/CSS/ESM，原生层和 onexd 属于 edge。接口见 [IPC.md](IPC.md)。

- **工作台**以租户 ID 或简称、用户名、密码登录，注册设备后显示当前租户允许的 Agent。启动入口取自 `actions`。顶部始终可进入设置。
- **设置**显示服务地址和隐藏到托盘的偏好，允许退出。模拟窗口只演示状态变化，不操作系统托盘。
- **离线演示**必须显式传 `?mock=1`；使用页面列出的固定示例账号和密码，数据只在内存中。普通浏览器默认显示「未连接桌面服务」。
- **交付边界**：发包时仅包含 `index.html`、`app.css`、`app.js` 和 `logo.png`；不要打包 tests、设计文档或提供远程页面加载。托盘、凭据保护和进程执行由原生层独立验证。发布验收还包括干净 Mac 安装与真实启动。

从 worktree 根目录运行：

```sh
bun test ./desktop-ui/tests
bun install --cwd server/web/tests --frozen-lockfile
bun desktop-ui/tests/browser.js
```

浏览器用例自行创建临时 loopback 静态服务，使用项目内 Playwright 与本机 Chrome，无需运行 Server 或 onexd。
