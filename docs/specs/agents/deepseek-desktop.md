# DeepSeek Harness Desktop 受管适配规格

## 平台、版本与可信制品

SIMA 实测对象是完整 **Desktop**，不是 DeepSeek SDK。Mac ARM64 **0.2.1-rc.3** DMG（264,791,658 字节，SHA-256 `0c2217c2c9110d0b5104af8eb4df55f214239405d079d0a83e30080ce1cbd1e1`）通过完整安装、深度签名检查与 GUI 对模拟上游的会话闭环；bundle `com.deepseek.dsh`，Team `NAN929V4UM`。依据：`docs/reports/deepseek-desktop-20261027.md:9-17,28-32`。下文路径相对 SIMA `b6df0bfe`。

逐平台读取官方 nightly feed，而非把全局最新版推给所有平台；使用所选版本的精确 URL、大小、官方 SHA-512，保存完整容器及 SIMA 内容 SHA-256。Mac arm64/x64 feed 是 ZIP，已有签名合格的 arm64 DMG 是另一制品；x64 **rc.4** 只有发现记录，不能代签运行。Windows x64 **rc.3** NSIS 曾由 Server 从官方版本化 URL 下载：289,415,960 字节、SHA-256 `1e3876baaa20c3f26371dba7b6873bb70c3ef9b91403f6d3f87d2b27d4fd1e3a`。需检查容器结构及运行资格，不能以 x86 安装壳的 machine 字段否定 x64 应用，也不能只提取 Electron 主程序替代原包。依据：`docs/reports/deepseek-desktop-platform-sources-211-20261028.md:5-23,29-37`。SIMA 官方 feed 根为 `https://download.deepseek.com/dsh-desk`；旧 DMG 的 `latest` 地址不可作为版本证明，须对照已批准的整包摘要（`server/src/agent-sources.ts:102-103`）。

## 配置、启动和模型线协议

`R` 为每次启动新建的私有运行目录。两平台均设置 `DSH_HOME=R/home/dsh`；写 `$DSH_HOME/profiles/desktop/{package.json,cordis.patch.yml}`（Windows：`%DSH_HOME%\profiles\desktop\` 下同名两文件），而非用户个人 profile。Mac `HOME=R/home`，XDG 与 `TMPDIR` 都在 R；Windows 另设 `USERPROFILE`、私有 `APPDATA/LOCALAPPDATA`、`TEMP/TMP`。从已验包的 GUI 入口启动，传 `--user-data-dir=<R/electron-user-data>`，不使用全局单实例或 PTY。SIMA 对生成的两文件和固定桥资产逐字节检验，发现另一个覆盖配置则拒绝启动。依据：`edge/src/deepseek_desktop/process.rs:72-115,193-254,303`。

模型项在 `llm-pi-ai.config.providers.<id>`：`api=openai-completions`、`baseURL=http://127.0.0.1:<port>/v1`、`apiKeyEnv=DSH_SIMA_MODEL_TOKEN`、`models` 只含获准列表、`retryPolicy.maxRetries=0`。Agent 走 **OpenAI Chat Completions** `/v1/chat/completions`；SIMA 的 `x-sima-desktop-model-proof` 是本机逐会话证明而非 OpenAI 公共头，配合本机令牌绑定 launch/SID，daemon 校验、防重复，不能透传上游。原生可见工具调用及流式终态须保留；provider 真实凭据只在 daemon。依据：`edge/src/deepseek_desktop.rs:24,467-469,905`、`edge/src/deepseek_desktop/model_proof.rs:9`、`docs/reports/deepseek-desktop-20261027.md:13-17`。

OneX 只发布自有 profile：同目录独占临时写、同步、原子替换，整份策略核验完成才开 GUI；失败回滚本次准备，不改用户全局配置、应用签名或上一版历史。退出撤销本次授权；卸载区分包、临时 profile、尚未耐久回传的记录，先验证归属，个人文件无须覆盖式恢复。隔离是加载来源隔离，不等于工具具有完整文件系统沙箱。

## 原生记录、恢复和生命周期

持久历史独立于 R：SIMA 历史布局为 `native/<namespace>/deepseek/history/sessions/.../session.v4.jsonl`，依安装、账户、工作域和原生 header 解析，不硬编码物理盘符。只处理已采用的受管目录；以真实 SID、cwd 和 owner 分别登记实际 GUI 恢复/新建的会话。增量读完整行，解析原生 v4 公开输入、输出及可见工具记录，隐藏 reasoning、运行时注入和重复片段不作人类输入；未知形状给出 gap。游标、加密事件和 outbox 同事务，按稳定事件 ID 补传、耐久 ACK 去重；router 另记计量，不通过拦截请求拼装历史。捕获 secondary 并不获得输入控制权。依据：`docs/reports/deepseek-desktop-20261027.md:13-17`、`docs/reports/deepseek-desktop-persistent-history-20261029.md:7-16`、`docs/reports/deepseek-gui-session-capture-windows-20261030.md:3-12,20-25`。

启动先检查现有进程、workspace 和原生写锁，分别展示进程已起、模型可用、原生会话就绪。正常重开只复用同账户/安装/目录下有内容、未归档的原生 SID；无记录时建内存草稿，首次真实输入才落盘。换 launch 时更新认证/配置，排空旧 reader，事务性交接游标；准备失败恢复旧 reader。GUI 显示退出或桥断开均不证明所有后代已结束，Mac 清理未知时不得夺锁，Windows 核 Job。归档隐藏会话而非删除正文，崩溃后不重放输入。依据：`docs/reports/deepseek-native-history-policy-20261103.md:5-20`；`docs/reports/deepseek-desktop-persistent-history-20261029.md:9-16`。

## SIMA 的失败与 OneX 待验

- 早期整份历史随 launch 轮换，重开后列表空；修复是持久化 history，而非共用旧 Electron profile、认证或控制令牌。`docs/reports/deepseek-desktop-persistent-history-20261029.md:7-16`。
- Windows 登记主 SID 只有头，真人实际用的是 GUI 恢复的另一个 SID。只看启动成功或有首文件会漏收完整对话。后续官方 Windows GUI 对回环上游测试验证跨目录新会话、重新扫描不重复；未代签真人业务。`docs/reports/deepseek-gui-session-capture-windows-20261030.md:3-12,16-26`。
- `storage-domain` 缺 `backend`、历史模块与桥包身份冲突可导致 Host 启动失败；窗口异常不能径直归为登录失败。精确 profile 与包身份应在 spawn 前验证。`docs/reports/deepseek-native-history-policy-20261103.md:22-24`。
- 待实测：两平台的官方包当前可得性与资格；新建/归档/多窗口冷恢复；控制面断开后有效租约内继续对话；流中断、过期、崩溃、睡眠后写锁与 ACK 恢复；关 GUI 后无未确认即标成功的清理。开发、工具子进程和个人 profile 不得泄露渠道凭据。本文只核对静态证据，未运行 Desktop、服务或模型。




## OneX macOS ARM64 原厂验收

既有 S3 冲刺已用同一发行和内网上游 Qwen3.8-27B 联调，重开窗口以及重启 onexd 后均恢复原任务。5 次用户输入、5 次回复和 5 笔完整用量落在同一会话，真实上游共结算 0.050 块橡皮。该次测试使用本地独立 OneX Server 和租户，记录见 `b9fcf08` 的 `HANDOFF.md`。

2026-11-21 在只读挂载的官方 0.2.1-rc.3 DMG 核对整包 SHA-256、Apple 深度签名、Team ID 和 CDHash。Edge 通过厂商 Cordis `llm/stream`、`sessionPersistence` 和公开的 `LocalCredentialProvider` 接入。每次原生调用取得单次本地凭据，厂商连接身份和其他凭据仍由原生隔离 profile 保存。

在 `edge` 下设置 `ONEX_DEEPSEEK_QA_BUNDLE` 为该应用的完整路径后，运行 `cargo test -p onexd --lib original_gui_restores_native_session_and_settles_each_turn -- --ignored`。该显式真机用例分两次打开签名的原厂进程，通过其公开的 SessionController 提交输入，并恢复同一原生 SID。实测两轮合计 6 个输入 token 和 4 个输出 token。OneX Router 为每轮计入 0.007 块橡皮，归到同一测试租约。持久 outbox 中仅一个会话开始事件、两次原生输入和两次原生回复。上游为本机流式 Chat 测试服务。通过的精确发行在 `server/src/desktop-qualifications.json` 中登记。

## Windows x64 原厂 Host 测试

设置 `ONEX_DEEPSEEK_QA_INSTALLER` 为精确 NSIS 原包路径，`ONEX_DEEPSEEK_QA_BUNDLE` 为从该原包提取的完整应用目录。运行 `cargo test -p onexd --lib original_windows_host_restores_native_session_and_settles_each_turn -- --ignored --nocapture`。测试核对原包、主程序和 ASAR 的 SHA-256，使用原厂 Desktop Host、OneX 私有 profile 和回环上游，核对同一原生会话恢复、两轮对话、outbox 和本机测试租约。

原厂打包 GUI 会注册当前 Windows 用户的 `dsh://` 处理程序。优先在干净的普通用户会话运行 `original_windows_gui_restores_native_session_and_settles_each_turn`。已有处理程序时，先备份完整注册项，再用同一个测试包装进程设置 `ONEX_DEEPSEEK_QA_PROTOCOL_BACKED_UP=1`、运行测试、清理测试进程和恢复注册项。恢复后复核原注册项。Host 测试使用厂商的 Node 模式，Windows 发行资格以原厂 GUI 以及 OneX 工作台的完整链路验证为准。

Windows x64 调试版可以用独立的 `ONEX_HOME` 和回环 QA Server 验证 OneX 的工作台下载接口及受管启动。设置 `ONEX_WINDOWS_DEEPSEEK_QA_7ZIP` 为经校验的 7-Zip 26.06 x64 提取程序绝对路径，在上述注册项备份及清理包装内运行 `cargo test -p onex-desktop --test windows_deepseek_qa -- --ignored --nocapture`。测试环境使用 `ONEX_WINDOWS_DEEPSEEK_QA_CREDENTIALS` 指定本机临时员工凭据。该路径限精确的 Windows RC3 原包、签名的回环合约和调试构建。

## OneX 受管附件

受管 `llm-pi-ai` 在签约型号的实际 Chat 渠道有有效图片审核证据时声明 `input: [text, image]`。原厂附件服务将图片规范化并存入当前受管会话，从同一 `openai-completions` 入口送出图片。Edge 在请求时重新检查实际渠道的能力及有效期，备选也要满足图片能力。输入预留按图片类型和尺寸估算，最终仍按上游报告的用量结算。

同一原厂附件服务处理可读文本和带文本层的 PDF。OneX 从原生会话内已验过长度及摘要的文件引用读取，PDF 由本机 PDFKit 提取。抽取结果与本次一次性模型令牌一起登记，Edge 把原厂文件提示对应的文本送入同一签约上下文。回流记录保留附件提示和文件名。PDF 支持 16 MiB 及 64 页内的未加密文本文件，单份抽取结果及 UTF-8 文本文件限 64 KiB，合计限 128 KiB。扫描件、加密文件和超限内容会明确报错。其他文件沿用原厂可供 Agent 文件工具读取的本地引用。

附件联验需先构建 `onexd`，以 `ONEX_DEEPSEEK_QA_DAEMON` 指定该可执行文件，再运行 `cargo test -p onexd --lib original_gui_preserves_image_and_document_prompts -- --ignored`。实际签名 GUI 按原生附件协议提交 PNG、PDF 和 TXT，重开同一原生会话后再次核对模拟上游收到的图片和文字。两次成功请求各按实际用量结算一次，持久 outbox 回流附件提示及可见文本。
