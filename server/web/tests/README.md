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

静态测试服务 `http://127.0.0.1:8123/?mock=1` 默认开启 mock。真实接口需由同源 Server 同时托管页面和 `/v1`，使用 `?mock=0`（不向静态测试服务发送真实凭据）。两个模式不共用登录存储。

- 模拟账号：`admin@onex.dev`（两个租户）、`demo@onex.dev`（一个租户）
- 固定验证码 `246810`；邀请码 `ONEX2026` 可将模拟账号加入「示例制造」，不能代替验证码。
- 模拟数据和令牌只在当前页面内存中有效，刷新后须重新登录。
