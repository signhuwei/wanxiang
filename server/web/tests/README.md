# 管理端验收

从 worktree 根目录执行。页面是无构建原生 ESM；Playwright 仅用于验收。

### 能力合约 v2

```sh
bun --no-env-file server/web/tests/policy-workspace-check.js
```

脚本启动临时 Server 与 SQLite，在真实 Chrome 中验证条目定义、模板、签发版本、充值凭证、月结返还钻取、Tools 发行、租户及分组配置和角色隔离。下文的 `workspace-check.js` 和旧的 `quota-check.js` 使用 v1 合约表单夹具。其中的合约场景由 v2 脚本覆盖。

### 通用页面

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

### 安装包发布与员工下载页

`bun server/web/tests/releases-check.js` 用真实 Server 跑一遍管理端的草稿、上传、发布、下架，以及员工 `/download` 入口（无登录 context 下载发布的版本，下架后变为空态）。
依赖 `/v1/platform/desktop-releases`、`/v1/desktop-releases`（见 `contracts/desktop-releases.md`），这两个路由落地前脚本会在创建草稿处失败。

脚本自己合成一个结构合规（28 字节头 + zlib 压缩 TOC）但内容最小的 XAR 作为上传夹具；设置 `ONEX_TEST_PKG_FIXTURE=/path/to/real.pkg` 可换成真实安装包（例如 RC3）跑同一条断言路径。
Server 绑定在 `127.0.0.2`（仍是本机回环）而不是 `127.0.0.1`，因为 Chrome 把 `127.0.0.1`/`localhost` 当作安全上下文——用 211 这类内网 `http://` 地址时 `crypto.randomUUID()` 会抛 `NotSupportedError`，绑在 `127.0.0.1` 会掩盖这个问题，验证不到 `idempotencyKey()`（见 `idempotency.js`）这个修复点。

`/download` 当前依赖 `server/src/server.ts` 的静态路由（本脚本之外，不在 `server/web` 范围内）；该路由落地前，本脚本用 `page.route` 把 `/download` 映射到磁盘上的 `download.html`，先验证页面本身。

### 真实监察延迟

运行 `bun server/web/tests/workspace-check.js`（可追加已有截图目录）。脚本在隔离租户中授权 admin 阅读其他成员正文，模拟一个 Edge 完成 WS 握手，并通过真实 `/v1/edge/ws` 发出一条唯一的 `assistant_message`。用同一单调时钟从发送前计时，到 Chrome 阅读区出现该正文并经过两次 `requestAnimationFrame`；超过 5000 ms 测试失败。随后检查 usage 增量、待结算提示、无重复正文和读取审计。`observe-real.png` 来自这个链路；离线脚本不提供模拟监察。这个单样本不能替代真机或负载验收。

- 模拟账号：`admin@onex.dev`（两个租户）、`demo@onex.dev`（一个租户）
- 固定验证码 `246810`；邀请码 `ONEX2026` 可将模拟账号加入「示例制造」，不能代替验证码。
- 模拟数据和令牌只在当前页面内存中有效，刷新后须重新登录。
