# 管理端验收

从 worktree 根目录执行。页面是无构建原生 ESM；Playwright 仅用于验收。

```sh
bun test ./server/web/tests
bun install --cwd server/web/tests
bun server/web/tests/serve.js 8123
```

在另一个终端从同一目录运行（使用本机 Chrome，无需全局安装软件）：

```sh
bun server/web/tests/browser-check.js .local/web-screenshots
```

脚本分别在 1280×720、1440×900 检查登录、台账、左缩钻取、编辑布局并保存 PNG，检查外层无溢出、表格行高 32–40 px、页码可见；同时验证邀请码、租户选择、按 actions 显示按钮、查询分页、钻取返回、同级切换和会话过期。

静态测试服务 `http://127.0.0.1:8123/?mock=1` 显式开启离线 mock，正常部署默认使用真实 API。`bun server/web/tests/workspace-check.js` 从临时 SQLite 数据库启动真实 Server，用 Playwright 验证写入，API 不使用 mock。真实接口需由同源 Server 同时托管页面和 `/v1`，使用 `?mock=0`（不向静态测试服务发送真实凭据）。两个模式不共用登录存储。

### 真实监察延迟

运行 `bun server/web/tests/workspace-check.js`（可追加已有截图目录）。脚本在隔离租户中授权 admin 阅读其他成员正文，模拟一个 Edge 完成 WS 握手，并通过真实 `/v1/edge/ws` 发出一条唯一的 `assistant_message`。用同一单调时钟从发送前计时，到 Chrome 阅读区出现该正文并经过两次 `requestAnimationFrame`；超过 5000 ms 测试失败。随后检查 usage 增量、待结算提示、无重复正文和读取审计。`observe-real.png` 来自这个链路；离线脚本不提供模拟监察。这个单样本不能替代真机或负载验收。

- 模拟账号：`admin@onex.dev`（两个租户）、`demo@onex.dev`（一个租户）
- 固定验证码 `246810`；邀请码 `ONEX2026` 可将模拟账号加入「示例制造」，不能代替验证码。
- 模拟数据和令牌只在当前页面内存中有效，刷新后须重新登录。
