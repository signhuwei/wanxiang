# WorkBuddy Desktop 受管适配规格

## 冻结原厂 GUI，不以 CLI 替身验收

SIMA 针对 **5.3.8** 验证了完整桌面，不是单独启动底层引擎。Mac ARM64 官方 DMG：437,358,016 字节，SHA-256 `583ee29d9f037523200eb0d6b59f199119922b9a11101e8174ae1963a4ce4974`，核对 Team ID、Bundle ID、ASAR、CLI 与入口。Windows x64 官方 NSIS：407,285,928 字节，SHA-256 `c111bc3f54a0e53fa04924313ae660125eebffafcd5ac7722da7c3c03402cb7a`，核对 Authenticode 发布者与安装内容；私有安装不执行全局注册钩子。Server 的包供给与该版本运行资格是两道门，Edge 不跟随厂商自动升级。Mac 有真人扫码后的真实 GUI 对模拟模型闭环，不能代签真实上游。依据：SIMA `docs/reports/workbuddy-desktop-product-20261101.md:3-18,31-39`、`docs/reports/workbuddy-windows-release-211-20261102.md:7-25`。以下实现路径相对 `b6df0bfe`。

取官方[下载历史](https://www.codebuddy.cn/docs/workbuddy/Download-History)中对应平台的版本化链接，制品根为 `https://download.codebuddy.cn/workbuddy/saas`。固定构建 `5.3.8.34705286-e9991e2b`；Mac x64 也有包摘要，但 SIMA 未给该平台运行描述。Mac 检查 bundle `com.workbuddy.workbuddy` 与 Team `FN2V63AD2J`。见 `server/src/workbuddy-source.ts:5-39`。

## 启动、配置和路由

SIMA 没有可安全原地改写的个人 `models.json`：原生 GUI 会重建模型快照。受管 launch 的 `R/control/policy.json` 记录 `selected_model`、`routes`、workspace、native SID、获准工具、transcript 位置；只引用本机令牌文件。桥在创建本次业务会话时把获准模型投影为本机 URL 和该 SID 的 capability。不能从请求正文自报的 SID 授权，不把上游 Key 发给 GUI。旧 PoC 已复现项目模型覆盖和 Desktop 刷新清除预置模型。依据：`edge/src/workbuddy_desktop/profile.rs:60-86`；`docs/reports/workbuddy-desktop-poc-20261101.md:14-27`；`docs/reports/workbuddy-multisession-history-fix-20261102.md:7-13`。

- `H` 是账户/安装隔离的持久根；两平台的 `WORKBUDDY_CONFIG_DIR`、`CODEBUDDY_CONFIG_DIR` 都指向 `H/config`，`WORKBUDDY_USER_DATA_DIR` 指向 `H/user-data`。Mac `HOME`、`CFFIXED_USER_HOME` 指向 `H/home`，`TMPDIR=R/tmp`；Windows 对应 `USERPROFILE=H\home`，`APPDATA/LOCALAPPDATA` 在其私有 AppData 下，`TEMP/TMP=R\tmp`。厂商扫码是独立会话，不导入个人厂商凭据，OneX 登录也不能替代它。见 `edge/src/workbuddy_desktop/profile.rs:101-124` 和正式纳管报告 `:14-18`。
- 由 Desktop 启动合格原包的 Electron/WorkBuddy.exe，不经 PTY；政策路径随本次进程传入，固定桥资产不是来自用户启动参数。OneX 只在自有目录生成配置，先独占写临时文件并同步、原子发布后再启动；退出撤销本机能力，卸载验归属并保全待传历史，原厂安装、个人 `models.json` 和登录文件无需还原。若新版没有获准的适配入口，保持不可启动，不关闭厂商签名检查。
- 模型数据面使用 **OpenAI Chat Completions**，本机 `/v1/chat/completions`；本机 bearer 选择 SID，daemon 校验会话证明后按路由重建上游认证，不转发本机证明。保留工具参数、顺序、call ID 和可见内容；后台标题和主任务必须分别标记，不能混算人类输入。依据：`edge/src/workbuddy_desktop/qualification_windows.rs:46`；正式纳管报告 `:22-29`；多会话修复报告 `:9-13`。

## 记录、退出和恢复

对话取业务桥按原生事件形成的受管 `session.v4.jsonl`，不是旁听 HTTP 或截图 OCR。旧布局 `history/sessions/sha256(cwd)/SID/session.v4.jsonl`；本证据版本以 namespace+workspace 解析私有根，再拼 `SID/session.v4.jsonl`，以已登记路径为准。每个任务 SID 独立，切换 A→B→A 必须调用原生 load 并收到回放完成，不能返回旧快照冒充已显示。按完整 JSONL 行和 seq 提取可见输入、输出、工具终态；去重依 SID 和事件身份，不重复计算晚到回执。迁旧文件先验完整前缀，保留源、游标、seen、ACK；仅补传已绑定主体。见 `edge/src/workbuddy_desktop/profile.rs:69-75`、`docs/reports/workbuddy-multisession-history-fix-20261102.md:5-19`、`docs/reports/workbuddy-desktop-product-20261101.md:24-35`。

进程在跑、桥就绪、原生 Session 已加载、当前轮完成是四种不同状态。冷启动不重发已发出的 Create；运行中取消只结束本轮。崩溃时撤销旧控制/模型能力，未知清理不标成功；正常重开须由同账户在同工作区精确恢复原 SID，再发新能力。不能因 UI 空白而删除 transcript，也不能凭同一窗口认定同一任务。Windows 已有 Job 收尾、A/B/A、冷恢复的证据，不是无条件接管外部窗口。见 `docs/reports/workbuddy-windows-release-211-20261102.md:18-25`；多会话修复报告 `:3-19,23-26`。

## 故障与待验

- Windows 真人冷开旧任务报 503，实际是 GUI 在跑但首次 Create 耗时约 65 秒，旧 60 秒截止提前撤销了本机令牌；不是上游模型故障。SIMA 后续仅对 Windows WorkBuddy 首次绑定放宽到 180 秒，仍只等一次请求。OneX 应显示启动阶段并测慢盘，而非通用地拉长所有超时。`docs/reports/workbuddy-startup-503-fix-20261103.md:3-17`。
- 原厂 SDK 向包内写日志会破坏下次完整性检查；重开空文件在首次落记录头前不等于不安全，但已观测的源后来丢失必须报缺口。见 `docs/reports/workbuddy-desktop-product-20261101.md:22-29`。
- 待实测：目标版本厂商登录、个人 profile 指纹不变、首次 GUI 冷开、审批拒绝后续聊、并行 SID 不串话、异常退出后补传、更新后重新验桥。用两平台官方包分别验证 GUI 和真上游；本文未运行服务、GUI 或模型。




## OneX 既有验收与本次合约换代

OneX 的 `feat/s3-macos-native-desktop` 已在 Apple Silicon 的 5.3.8 原厂窗口验证限定模型菜单、收起个人模型编辑、原任务冷恢复和真实内网 Qwen3.8-27B 上游。原任务两轮回答 247、240，四次模型调用合计 0.096 块。该冲刺的实现与记录见 `5b6628b`、`2f58518` 和该分支的 `HANDOFF.md`。

v2 沿用同一 OneX Router 语义。通过本机模型入口，WorkBuddy 仅能使用合约明确列出的模型名，通配路由只开放其固定上游名。余额降档可将已获准的名称路由到合约指定的低成本模型。每次转发重新查设备的生效合约及本轮获准的模型名，未授权请求在扣费前返回 403。

v2 恢复 S3 固定构建的受管模型菜单与任务创建逻辑。窗口只显示合约分配且经原厂允许的模型，设置页沿用厂商的管理员限制提示。登录窗口使用进程级直连。创建或恢复任务时，Edge 核对原生任务 ID 与私有工作区，签发只属于该任务的本机模型令牌。任务自己的模型客户端解析该环境变量。公开 Hook 提供可选的轮次佐证。[腾讯企业模型管理](https://cloud.tencent.com/document/product/1831/134418)

### v2 原厂窗口双任务验收（2026-11-21）

在 macOS ARM64 通过 `onex run workbuddy --managed --model Qwen3.8-27B` 启动 5.3.8 原厂窗口。签名、代码摘要和 DMG SHA-256 与发行清单一致。聊天模型菜单只列出 `Qwen3.8-27B`，个人自定义模型的配置入口已隐藏。在「设置 → 模型」中仍能看到原厂的「添加模型」按钮，点击仅显示「企业管理员已禁止添加个人自定义模型」，无法打开编辑表单。

在同一窗口使用「新建任务」创建两个独立任务，分别确认原厂回复「青杏」和「山桃」。内网 Qwen 上游当日连接超时，验收使用分别返回已知 token 数量的本机回环上游。签发、设备注册、转发、用量上报、续租和扣款均走隔离 v2 租户的正式接口。核对原厂 JSONL、OneX 会话和租户数据库得到以下记录。

| 任务 | 原生任务 ID | OneX 会话 ID | 请求数 | 输入 token | 输出 token | 结算橡皮 |
|---|---|---|---:|---:|---:|---:|
| A | `716da687-7c2f-4e58-80a9-c66c08d97423` | `27e58ab2-19ba-5b09-a061-112a297e5cd4` | 3 | 111 | 15 | 0.141 块 |
| B | `3b54b1d0-f255-4a5a-9178-2b33faa87e08` | `5ffed6c2-22de-5cc4-abc0-ce75099a4e23` | 3 | 159 | 33 | 0.225 块 |

六笔用量全部已结算，账本实扣 0.366 块，未归属请求为 0。运行资格只适用于表中所述的 macOS ARM64 固定构建。


## OneX 对公开接口的核验

腾讯的桌面文档列出了第三方模型的服务地址、API Key 和模型名，也列出了 Hook 插件。原厂 5.3.5 的发行说明已记录插件 Hook 支持。[桌面模型配置](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model) · [桌面插件系统](https://www.workbuddy.cn/docs/workbuddy/Plugins) · [发行说明](https://www.workbuddy.cn/docs/workbuddy/Changelog)

腾讯 CodeBuddy 的 ACP 文档公开了轮次关联机制。普通提示进入历史后，原生记录中的 `providerData.conversationRequestId` 与模型 HTTP 头 `X-Conversation-Request-ID` 可用于精确比对。Hook 文档将 `generation_id` 定义为可选字段，并说明它在有轮次 ID 时可与之对应。在共享模型凭据路径上，Edge 要求已登记的唯一轮次。使用本次任务专用凭据的原厂请求直接归入该 SID，若同时携带已登记的轮次，则两者须一致。同一轮可以产生多笔请求。[ACP 客户端轮次 ID](https://www.codebuddy.cn/docs/cli/acp) · [Hook 参考指南](https://www.workbuddy.cn/docs/cli/hooks)

企业开放平台的托管 Agent 会话 ID、ACP 元数据及本地助理消息接口各有自己的协议边界。关联桌面自定义模型请求所需的证据，应来自受测桌面发行实际发出的 HTTP 请求。[开放平台 API](https://open.workbuddy.cn/docs/openapi) · [ACP 扩展字段说明](https://cloud.tencent.com/document/product/1831/137025)

OneX 已在 Apple Silicon 复核 5.3.8 官方 DMG 的完整字节数、SHA-256、应用标识、Team ID 和 CDHash。可在 `edge` 设置 `ONEX_WORKBUDDY_QA_DMG` 为原包路径、`ONEX_WORKBUDDY_QA_BUNDLE` 为从该包只读挂载的应用路径，运行 `cargo test -p onexd --lib original_workbuddy_container_and_apple_signature_match_manifest -- --ignored`。该测试单独报告原包身份，桌面请求归属和上线资格另按上述实测结果登记。

v2 沿用 S3 的 JSONL 可见消息筛选规则。设备端回归覆盖按原生任务签发凭据、两任务交错、热撤销、部分行续读、重复采集、冷恢复及符号链接拒绝。在 `edge` 目录运行 `cargo test -p onexd --lib workbuddy` 可复验这些路径。
