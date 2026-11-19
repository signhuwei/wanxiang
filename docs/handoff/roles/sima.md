# OneX 验收移交 · sima（Server / Web）

**接手先看：** 产品仓库 `wanxiang/docs/plan/mvp.md` 定义当前退出标准，`wanxiang/docs/plan/mvp-walkthrough.md` 是人工操作入口。**Server S1-S1～S1-S4 已签收；MVP 整链未由 sima 签收。** 2026-11-19 收尾时，`main` 为 `4301de6`，监督工作树仍在第三轮证据快照 `3b9b50f`（detached、干净）。不要把“已合并”或旧报告里的“通过”当成最新部署的运行结果。

## 已完成及证据

|范围|实际完成|去哪复核|
|---|---|---|
|规格与清单|Agent 规格、SIMA 故障教训、S1 清单的「Server 与管理端」章已入 main。完整 S1 标准保留，不是这次 MVP 的前置条件。|`wanxiang/docs/specs/agents/`、`docs/specs/sima-lessons.md`、`docs/plan/s1-acceptance.md`（后两项相对产品根目录）|
|Server 租户管理、账本租约、配置、回流监察|三轮独立验收。末轮 20 个独立 Bun 进程串行跑完整 Server 套件，每轮 18 pass / 1 Valkey skip / 0 fail。另用真实路由和 SQLite 夹具完成 442 次断言：默认/显式授权、组树、审计、SSE、乱序与重放；其他设备占用同一 session_id 时整批回滚，冲突设备 ACK 不变。跨租约结算 2+3 与 usage 5 对平，重放不重扣。|`coord/reports/review-s1-server-{1,2,3}.md`，最终结论看第 3 份；`review-s1-server-3.test.ts` 是可重跑的独立证据。|
|Web 与 Desktop 前端|角色编辑和邀请表单已按 `assign_role:*` 限制选项；可见范围 Tab 已合并并静态核对。Desktop 原型只签本地前端和 IPC 提案，未签原生集成；Tauri 不在 MVP 路径。|`b384916`、`12b7dfc`；`coord/reports/review-s1-desktop-ui.md`。|
|第三轮后的主线变化|已合并 Server MVP seed、每会话正文能力 `read_content`、Edge CLI 登录与隔离启动、主会话采集。Web 另有监察实时刷新与延迟测试提交 `3157135`、`33e8697`、`be6fed9`。这些是合入事实，不是 sima 再验结论。|总督的主线合并 `6868918`（Server）、`4301de6`（Edge）；Server 正文能力 `2e207ae`、MVP seed `535d348`。|

## 未完成与下一步（优先级顺序）

1. **P0：交接部署版本，安排一次人工 MVP 走通。** 先核实 211 上实际运行版本、seed 与 `/v1/healthz`，不要对共享环境重复充值或重置。按 walkthrough：管理端可见租户、员工、Provider、倍率、余额；Mac 端验证码登录/注册，CLI 经本机 router 启动现有 Claude Code；几轮对话后管理端出现正文和费用。最后在专用测试额度上验证耗尽后的下一请求被拒且不新增上游请求。记录版本、耗时、脱敏计数；真实模型调用由总督与人工操作者安排。**本监督员没有做完这条真机链路。**
2. **P0：在同一条链路核对监察权限与实时性，不再另开一轮大范围 Web 审查。** 默认 admin 打开别人的会话只能看到摘要；授权后可钻入正文、每次读取有审计。`main@4301de6` 的 Server 已返回 `read_content`；该快照在 `server/web` 中未检出该动作字面量，须检查提交后的实际 UI，在仅有摘要时不要提供必失败的正文入口。保持有权阅读的窗口打开，核对追加 usage 时 token、橡皮、待结算提示更新，不刷新、不重新进入；分别计时事件/费用到屏。第三轮原问题与后来提交分开看，以实测关闭，不把截图当作延迟证明。
3. **P1：MVP 之后再补完整 S1。** 干净 Mac 安装、两小时与断网、Desktop 原生桥、诊断日志、浏览器双尺寸交互等回到 `s1-acceptance.md`；不因旧清单存在就阻塞 CLI MVP。原生集成时仍要保证密钥只在原生内存、WebView 只走受限 IPC。

## 在本机运行和测试

在 Codex Desktop 选择**产品工作树根目录**（包含 `server/`、`contracts/`），先记下 `git status --short --branch` 和 `git rev-parse HEAD`。历史复验使用 Bun 1.3.5。缺依赖时在**可写开发工作树**按当前 lockfile 安装 `bun install --cwd server --frozen-lockfile`；浏览器测试的独立依赖为 `bun install --cwd server/web/tests --frozen-lockfile`。只读 review 工作树的依赖由维护者准备。

```sh
bun test ./server/test                        # 服务端实际 HTTP/WS、SQLite、权限和账本
bun test ./server/web/tests                   # JS 单测，不启动 Chrome
bun server/web/tests/workspace-check.js       # 需要获准的本机 Chrome；临时库、真实 Server、Web 交互
```

- 手工启本地开发 Server：在可写工作树根执行 `bun server/src/index.ts`，用隔离 `ONEX_DATA_DIR`、未占用本机端口，不指向 211 的数据。若只看静态布局，可用 `bun server/web/tests/serve.js 8123`，按 `server/web/tests/README.md` 操作；显式 mock 不是集成验收。生产环境部署/seed 不用这个临时启动方式，见 MVP walkthrough。
- 独立夹具：从 `wt/review-sima` 根运行 `bun test ../../coord/reports/review-s1-server-3.test.ts`；它从 `coord/reports` 按**现有兄弟目录布局**导入 `wt/review-sima/server`，需要该树的模块和依赖，不自动跟踪 main。建议移交时连同 `coord/reports/` 一并带走，它不是产品 Git 仓库的一部分。首轮的 `review-s1-server-1-ingest.test.ts` 使用 S1-S4 前的函数签名，只供历史快照复查。

## 容易误判的地方

- Server 测试默认跳过外部 Valkey；真实后端验收另配置专用 `ONEX_TEST_VALKEY_URL`。切换提交后依赖也要匹配 lockfile；过去的 `ulid` / `@noble/ciphers` 导入失败是环境问题，不是权限或计费断言失败。
- WS 可交错推送 `config`、`secret` 和心跳。等待指定帧，不假定“下一帧”；仍要检查 pong 关联、漏答次数和关闭码。关库测试要等待异步 `close()`。
- `events` 与 `usage` 共用**每设备**一条连续 seq。收到 WS 帧不等于已落库；逐步查 ACK、库行、重复数和余额。不能以全部测试一次通过，替代关闭竞态的多次串行实跑。
- 报告只保留假数据、匿名 ID、时间、状态码和金额；不抄验证码、令牌、Provider 密钥、签名 URL、日志包或对话原文。不要用 `pkill -f onex` 清环境，按自己启动的子进程句柄停止；不要动其他角色工作树或共享 stash。

**收尾状态：** 无进行中的产品改动、无 sima 待提交的代码。最后一项是等待人工 MVP 走通；因移交通知停止待命。后续从 P0 接续，而不是重新做前三轮验收。
