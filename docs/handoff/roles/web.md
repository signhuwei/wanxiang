# OneX 管理端移交 · 2026-11-19 16:26

**接手起点：**本机工作树 `/Users/HHH/Code/OneX/wt/web`，分支 `dev/web`，HEAD `f1b9e3f`，工作区干净，web 未 push。核对时 `main` 为 `4301de6`，`git log --oneline main..dev/web` 只有 **`f1b9e3f`**。它不是在途开发：已完成且在这条主线基线上验过，只待 governor 审查合入。以上是移交时快照，不是部署状态。

## 已完成并已合并

| 范围 | 可从哪里接手 | 实测边界 |
|---|---|---|
| S0 外壳与组件；W1 成员、组、邀请 | `server/web/app.js`、`ledger.js`、`drill.js`、`form.js`、`members.js`、`groups.js`；`1a75b08`、`b689c64`、`b384916` | 原生 ESM，无构建；分页、左缩钻取、验证码和租户选择。真实 Server 验过 owner/admin 的可授予角色、建组和一次性邀请码。 |
| W2 平台目录与租户合约；W3 橡皮 | `catalog.js`、`contract.js`、`billing.js`；`e37d527`、`12b7dfc`、`ea460e4` | 真实本地 Server 验过单 Provider→模型→倍率、合约跨 Tab 保存、监察可见范围、全局令牌充值与租户余额回读。 |
| W4 监察 | `observation.js`、`tests/observe-live.js`；`3157135`、`33e8697`、`be6fed9` | 已移除合成监察数据。人员→会话→阅读区走真实 API；SSE 只推摘要，正文另取并记审计。支持 gap、可折叠工具输入、月费/轮数、四类 token 和待结算笔数。 |
| W5 设备；Desktop 前端 | `devices.js`、`mock/devices.js`；`desktop-ui/IPC.md`、`desktop-ui/PACKAGING.md` | 设备诊断验的是带标记的模拟任务，不是实际日志包下载。Desktop 交付页面/mock、IPC 提案与打包边界说明；没有据此验证真实 Tauri/onexd。均不阻塞本轮 CLI MVP。 |

## 最后一项与下一步（按优先级）

1. **先合 `f1b9e3f`，不要重复实现。** 此提交让会话行和查看按钮只认对象的 `read_content`，不再把摘要动作 `read` 当作正文权限；普通台账仍用 `read`。同一 Server 基线含后端授权提交 `2e207ae`，真实 Chrome 跑过授予/未授予两路：授权管理员看到新正文且产生读取审计；仅摘要管理员看到无权限提示，点击行不发 `/events` 请求，不产生正文读取审计。单测 26/26。授予场景本地单样本：模拟 Edge WS 发出事件→页面可见 **55.5 ms**，用量发出→已打开会话费用和待结算数可见 **99.0 ms**。两者均含两次渲染帧，不是生产网络指标。
2. **在 211 上按 `docs/plan/mvp-walkthrough.md` 做人工走查。** 先核对部署版本已含上述前后端提交，关闭 mock；再验证员工从 Mac CLI 发起的会话在另一管理员账号页面可见、计费更新、小余额租户耗尽。部署/真实模型调用由 governor 统筹；web 本轮没有执行该链路，不能把本地结果当作 211 签收。
3. **MVP 后再开 Desktop、真实诊断等事项。** 范围以 `docs/plan/mvp.md` 为准。历次 web 验证细目见同目录 `web.md`；历史截图在 `s0-6-web/`、`s1-web/`，`*-observe-real.png` 是真实后端链路，早期 `*-observe.png` 不是。

## 本机运行与复验

从上述 web 工作树根目录执行。已用 Bun 1.3.5、项目内 Playwright 和已安装的本机 Chrome；不需账号密钥、真实模型或外部上游即可跑这些回归。

```sh
bun install --cwd server --frozen-lockfile
bun install --cwd server/web/tests --frozen-lockfile
bun test ./server/web/tests
bun server/web/tests/workspace-check.js
bun server/web/tests/workspace-check.js --summary-only
```

后两条各自创建临时 SQLite、启动随机 loopback 端口的真实 Server 和独立浏览器。默认验证可读正文、实时费用及审计；`--summary-only` 验证另一成员会话的摘要保留、正文入口和请求均不存在。传已有目录给默认用例可输出 1280×720 / 1440×900 截图。静态 UI 回归另见 `server/web/tests/README.md`。

人工本地启动：在新的测试数据目录先按 `server/README.md` 运行 `bun run --cwd server seed owner@example.test 10 Local --platform-admin`，再 `bun run --cwd server start`（seed 和 start 使用同一 `ONEX_DATA_DIR`，不要指向已有业务库）。浏览器访问 `http://127.0.0.1:3000/?mock=0`；登录用开发环境临时验证码，仅在受信终端查看。只看静态演示可运行 `bun server/web/tests/serve.js 8123`、打开 `http://127.0.0.1:8123/?mock=1`；该服务不能代替真实监察联调。

## 容易踩的坑

- 平台接口用全局令牌，租户接口用选租户后的令牌；owner 不等于平台管理员。角色选项取 `assign_role:*`，合约编辑取对象 `actions.update`，查看正文取**每一条会话**的 `read_content`，缺动作不授予。读正文会记审计，不能靠试读来猜权限。
- 保持 SSE 流式传输与 Bearer 认证，测试代理不要先缓冲整个 SSE 响应。月费用 `month_cost_milli` 不是全时段 `cost_milli`，轮数 `turn_count` 不是事件数；橡皮 API 金额是整数毫橡皮。
- mock 开关会被浏览器记住；比对真实 API 前显式 `?mock=0`。不要把验证码、令牌、明文邀请码、Provider 密钥、预签名链接、对话正文或含这些值的 HAR 上传或写入移交记录。
- 所有工作树共享 stash。不要用裸 stash/pop，不改别的工作树；不要用 `pkill -f` 清进程，用自己启动的任务句柄。进程间约定是 `coord/bin/mail-send` / `mail-wait`，不依赖特定 IDE。
