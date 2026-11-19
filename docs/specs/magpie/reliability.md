# Magpie 稳定性做法与 OneX Edge 参考规格

基线为 Magpie `0e3d093611e8bd226e3136113aafd75f5d7f4914`，路径相对 `refs/magpie`。以下是只读走查，不是对 Magpie 的修改提案；标为 OneX 建议的内容尚未裁决。

## 自有状态：lastgood、崩溃及恢复

- `lastgood.Read` 读当前文件，交给调用方 validator；内容无效时尝试有效 `<file>.bak`，并留下 GUI/日志恢复提示。两份皆不可用为 `ErrUnreadable`，不是空值；主文件确实不存在时返回不存在，**不看旧备份**，避免用户有意删除后复活。底层读取 I/O 失败直接返回，并非所有错误都走 fallback。`JSON` 只验语法，`Into[T]` 可以按预期类型验；关键状态还需业务校验。见 `internal/lastgood/lastgood.go:34,44,63,83,130,229`。
- 写方持自己的锁先 `Keep`。当前校验通过则用它更新 `.bak`，同 bytes 不重写；当前坏则以独占创建保存 `.bad-<time>`、同步文件，不污染 `.bak`；不可读取或不可留存则中止写入。坏文件同秒有唯一后缀，同 bytes 不重复留存。`steady.WriteFile` 在目标同目录写 temp、设置权限、`Sync`、关闭、重命名；写或 flush 失败原文件不变。Magpie 没在该函数显式同步父目录；不要把它描述成完整的掉电事务。见 `internal/lastgood/lastgood.go:105,162,179`、`internal/steady/steady.go:143,159,199`。测试 `internal/lastgood/lastgood_test.go:26,59,79,107,162`。
- **OneX 建议：** 至少区分 `missing`、`valid`、`recovered`、`unreadable`，对路由做 schema、签发、版本和 freshness 校验；恢复到旧 route 也不能复活过期/撤销租约或让旧凭据重新有效。扣款、租约消耗游标和回流确认不是普通可回滚缓存：不能用 `.bak` 把已花额度或已处理事件恢复成未花；保留单调代次/持久化审计或与 Server 重新对账，疑义时停止付费流量。故障注入覆盖零文件、截断、权限拒绝、空间不足、flush/rename 失败、process kill、旧状态重现。

## 用户配置：精确编辑、原子写与所有权

- `edit` 针对 JSON/JSONC/TOML/YAML/.env 以键为单位改，不把整份用户文档反序列化再排版。写前读取实时字节（只读查询可以 memo），JSONC 兼容注释/尾逗号，保留 BOM、CRLF、排列、缩进、模式/组；内容没变就不动 mtime。损坏或不可解析文件不能当作新配置覆盖。见 `internal/edit/file.go:1,23,60,82,124,139,182`、`internal/edit/json.go:49,75`、`internal/edit/toml.go:396,402`、`internal/edit/yaml.go:121`、`internal/edit/env.go:39`。回归示例 `internal/edit/jsonc_comments_test.go:11`、`internal/edit/toml_array_test.go:89`、`internal/edit/toml_write_test.go:71`、`internal/edit/env_comment_test.go:5`。
- `WriteAtomic` 的普通路径为同目录 temp→同步→rename，符号链接写目标并保留链接。**硬链接是例外**：为了所有链接看到同一内容，会先留同步副本再就地写，因而不是原子替换；受保护时另有替换分支。`edit.Atomically` 在调用前取多文件 bytes/模式/不存在的快照，函数返回错误时逐份恢复并返回恢复错误；快照读不到的文件可被跳过。这是进程内补偿，不保证崩溃后多文件原子或和外部程序写入隔离。`agent.atomic` 应用于 field set、Sync、Follow、Unwire 等。见 `internal/edit/file.go:124,149,220,283,328`、`internal/agent/agent.go:833`。
- **OneX 建议：** 按优先级使用进程参数/隔离配置 → 受支持 App API → 有所有权记录的最小 patch。需要写多文件时记录持久的变更计划及前后指纹，并用比较后替换/重读校验检测外部修改；默认不追超出允许目录的 link，不因同步把用户选值改回 OneX 默认值。验证生成配置可被客户端读取；仅成功写入不等于接入生效。覆盖链接、BOM、CRLF、引号、App 退出回写、两次无变更同步、并发用户修改与模拟半事务。

## 断开与卸载恢复

- `applied.json` 记实际应用字段，`stash.json` 记之前值。普通 `Disconnect` 先标记主动断开，防止启动 Sync 再次接管，调用各适配器 `Unwire`，比较当前值和实际写入值，只移除已知的 Magpie 项；在字段仍空且原值是用户值时还原。最终 `Restore` 做适配器清理。Native Agent 可有自己的计划/执行和显式离线恢复。**并非始终把整个文件盖回历史快照**，否则用户接入后的编辑会丢。见 `internal/agent/applied.go:34,42,923,938,947,976,1008`、`internal/agent/stash.go:31,88`。
- CLI `Run` 先撤系统自启动/服务，避免它重接，接着 Disconnect 与处理旧配置残留，最后可删自有数据。`KeepData` 不删 settings/providers/usage；App 可在自己退出后由独立执行清理，报告记录每个 Agent 和系统项成功/失败。Codex 需考虑残留 base URL、app-server 和关联会话。数据路径过滤拒绝空、相对、根和 HOME/其祖先，不能套用成任意路径的删除许可。见 `internal/uninstall/uninstall.go:115,135,156,171,196,294,310,320,352`。
- **OneX 建议：** 卸载要幂等、先禁止新受管启动/撤服务拉起，再恢复路由（只移除 OneX 所有权明确的字段），保全用户文件，撤 daemon 及凭据，收尾回流依据留存策略；任何恢复失败保留修复记录和数据，不在同一步抹掉恢复凭证或未确认事件。OneX Desktop 可单独卸载或关闭，不等同于一律丢弃 daemon 和待上传账目。

## 自启动、存活与日志

- `internal/daemon` 的真相来自 OS manager，不来自 Magpie 的设置开关。macOS 用户 LaunchAgent `~/Library/LaunchAgents/com.yetone.magpie.serve.plist` 用 `RunAtLoad`、非正常退出自动拉起、5 秒节流、`ProcessType=Standard`（互动模型链路不应被 Background 调度压低）；旧 plist 有小步修复。Linux `systemd --user` 安装 `magpie.service`，`Restart=on-failure`、`RestartSec=5`。`daemon.Install` 与打开桌面并自带网关的登录项互斥，避免争抢端口。Windows **没有 Magpie 原生 daemon 服务适配**：Windows autostart 用 HKCU Run 打开桌面网关，或另借 WSL。见 `internal/daemon/daemon.go:1,33,64,91,116,130`、`internal/daemon/launchd.go:24,38,69,151`、`internal/daemon/systemd.go:20,45,60`、`internal/autostart/autostart_windows.go:10,90`。
- 桌面 `app.log` 与 gateway 服务日志分开：macOS `~/Library/Logs/magpie/{app,serve}.log`，Windows LocalAppData `magpie/logs/app.log`，Linux 用户状态目录 `magpie/app.log`，systemd 用 journal。`applog` 写 stderr 和本机文件、记录进程版本/PID，将崩溃栈接到文件；文件按 5 MiB 轮换保留一份旧档；Windows 打开的文件无法 rename 时有截断兜底。应记录失败类型与关联请求，不记录凭据或消息；Magpie 文件 sink 有 scrub，不能视作所有 stderr 或独立正文观察器也自动脱敏。见 `internal/applog/applog.go:1,37,69,106,121,138,160`、`internal/gateway/gateway.go:711,733,741`、`docs/reference.md:2972,2985,3732`。
- **OneX 建议：** 只保一个 daemon owner（用户登录项模型或服务模型须明确），状态至少显示 OS 服务状态、就绪、路由版本、租约到期、上报积压；端口可开不等于就绪。支持受审计的只读日志拉取，经已认证 Server→Edge 控制通道、分页/时间段/总大小上限、不抓全文或 key。会话正文与计量是另设的受控数据管道，不往日志塞。部署前测试 App 退出、daemon crash、登录时网络未就绪、端口被占用和断线待补传。

## 更新与长流

- 新版更新清单用内置公钥校验 Ed25519，签名绑定版本和 `SHA256SUMS`，资产 hash 以签名清单为准；签名范围外的包剔除，feed hash 不同则拒绝。存在历史版本/自定义调试 feed 的兼容例外，且部分版本叠加 provenance attestation。下载与 staging、实际安装分开；macOS app 还比较团队签名，二进制替换有旧版本暂留、尝试启动和恢复分支，Windows 移动/占用不同。见 `internal/update/signed.go:15,43,58`、`internal/update/attest.go:126,144,287`、`internal/update/update.go:409,452,498,697,848,858,961,1243`。
- 支持 handover 的桌面路径把监听 FD 交给后继、等 ACK、再停旧监听，旧服务允许已开始请求 drain（默认 15 分钟）；桥接回调转发到旧进程。handover 失败改在有界等待后重启；新程序起不来时保留当前服务。涉及 OS 句柄/锁差异，不等于每个平台/每次重启都零中断。见 `internal/gui/handover.go:175,202,228,268,276`、`internal/gateway/handover.go:27,52,147,166,201,384`；流不中断测试位置 `internal/gateway/handover_test.go:50`。
- **OneX 建议：** 首轮能先做到签名校验、安装掉电保护、拒绝降级、空闲更新或推迟到流结束；不用一开始就引入 FD 交接。明确积压回流和租约账的跨版本兼容，旧 daemon drain 不能超过租约；灰度按版本、健康和签名验收逐步推广，失败还能回到兼容的已知可用版本。不要让低版本因为发布完成较晚成为默认更新。

## `LESSONS.md` 可直接转成 OneX 验收规则

| 参考 | OneX 检查点 |
| --- | --- |
| `LESSONS.md:1,95,111,131,158` | 夜间复盘按“规则—原因—证据”写；匿名、脱敏后保留真实失败字节与 Agent/OS/Provider/模型版本，不用相似样例代替。将账户、模型、内容拒绝分开，厂商适配补丁需要另一个厂商保持不变的测试。 |
| `LESSONS.md:167,186,246,348,355` | 额度/租约覆盖所有入口、重试和可单独选模型的子任务；隐私豁免按协议层级，不按任意字段名；用户配置未读不能写空，测试先被用户改、再同步或卸载的分支。 |
| `LESSONS.md:385,401,431,543,619,632` | 用最大负载估算每请求/轮询的工作量；在适配器所在包和 CI 加协议/路由/Agent 矩阵 guard，从注册表派生；等待真实 ready 状态，比较 SSE 内容时忽略合法保活注释，不把每个测试都靠固定 sleep。 |
| `LESSONS.md:518,532,652,707,738,758,827` | Windows 要执行端到端测试而非只 cross-compile；日志/遥测字段 allowlist；配额检查及预留为同一步，回执对采集时点；reader 依赖的状态在启动进程之前安装。fake child/监听器随测试结束，测试隔离 HOME 也隔离残留服务；请求结束释放上下文中大对象。 |
| `LESSONS.md:255,486,868,1048,1062,1118,1264`；`docs/code-standards.md:41,106,135` | 发布基于已审查的精确版本，测试结束才写结果；找红测根因并有人负责，不把可取消的 CI 运行视作通过。不同 agent 不共享可写 checkout；不可逆迁移需真实平台验收与回滚说明（本次没有权限验证），更新源 hash 必须有独立可信出处，Latest 不允许回退。 |

待裁决：Mac 与 Windows 的 daemon 启动所有权（用户级托管或独立服务）；主动断开、卸载和回流尚未确认时的保留与清理顺序；远程日志的授权角色/上限/审计与留存；首轮更新仅空闲还是要求跨版本长流迁移。