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


