# 平台维护与发布

平台管理员在「维护与发布」查看 Server 当前 Git 提交、发布包及部署结果。Edge 安装包沿用 [Desktop 发布契约](desktop-releases.md)。员工继续从 `/download` 匿名下载当前发布，发布安装包不会自动重启或替换员工设备上的程序。

## Server 发布包

Server 制品为 Git 提交中 `server/` 和 `deploy/` 加上锁定的生产依赖形成的 gzip tar 包，最大 256 MiB。Ed25519 公钥由部署主机管理员配置，私钥留在受信任的打包环境。平台管理员凭据授权上传与部署。主机只接受受信任签名的可执行包。

清单 JSON 包含 `commit`（40 位小写十六进制）、`sha256`（64 位小写十六进制）、`size`（字节数）和 `signature`（无填充 Base64URL）。签名消息是 UTF-8 编码的四行，每行以 LF 结尾：

```text
onex-server-release-v1
<commit>
<sha256>
<size>
```

| API | 请求与结果 |
| --- | --- |
| `GET /v1/platform/maintenance` | 当前运行版本、执行器就绪状态、活动任务及可用操作 |
| `GET /v1/platform/server-releases` | `q`、`cursor`、`limit` 服务端分页 |
| `POST /v1/platform/server-releases` | 签名清单，首次登记 201，相同提交和摘要重试 200 |
| `GET /v1/platform/server-releases/{commit}` | 校验状态、大小、摘要、最近部署结果、可用操作 |
| `PUT /v1/platform/server-releases/{commit}/artifact` | 原始制品，服务器验证大小和 SHA-256，匹配后保存 |
| `POST /v1/platform/server-releases/{commit}/deploy` | `{expected_commit}` 与必需的 `Idempotency-Key`，返回 202 和任务 |
| `GET /v1/platform/server-rollouts/{id}` | 任务状态、发起人、起止时间、失败码和实际运行版本 |

任务依次进入 `queued`、`running` 和 `succeeded` 或 `failed`。一次只允许一个活动任务。相同操作人和幂等键返回原任务，同键异参返回 409。部署会核对正在运行的版本仍等于 `expected_commit`。同版本任务执行制品与运行状态校验。Server 重启期间轮询可能暂时失败，重连后可继续查询原任务 ID。

独立 Linux 执行器复核签名和摘要，验证归档成员后才执行固定 OneX 发布流程。发布之前备份业务 SQLite 库。只有健康接口报告目标提交才算成功。启动失败时尝试切回上一版代码，保留业务数据与备份供核对。历史制品在签名和数据兼容性满足时可重新选择部署。异地授权、系统组件策略和 Desktop 自动安装属于另外的维护场景。

## Agent 制品库

平台管理员从「维护与发布 → Agent 制品」登记发行，上传或拉取文件，确认 Server 已缓存后启用。
发行的 Agent、系统、架构、版本、大小和 SHA-256 固定。来源地址和启用状态可按修订更新。
制品按 SHA-256 保存于 Server 私有持久目录。停用会取消新下载资格并保留同摘要字节供历史发行核对。

| API | 请求与结果 |
| --- | --- |
| `GET/POST /v1/platform/agent-releases` | 服务端分页与发行登记。管理页以 `status: disabled` 新建 |
| `GET/PATCH /v1/platform/agent-releases/{id}` | 制品状态 `artifact_cached`、当前修订与可执行操作。修改来源或启用状态 |
| `PUT /v1/platform/agent-releases/{id}/artifact` | 上传原始可执行文件或桌面安装包。单请求上限 256 MiB。使用 `application/gzip` 可上传单文件压缩制品，解压后 CLI 上限 512 MiB、桌面上限 768 MiB。桌面原始包可分段上传 |
| `POST /v1/platform/agent-releases/{id}/pull` | 从登记且匹配厂商白名单的 HTTPS 地址拉取完整原始制品，拒绝重定向。缓存已就绪时重试返回原摘要 |
| `GET /v1/agent-artifacts/{sha256}` | 平台管理员核取仍启用的受管制品或暂存的桌面安装包 |
| `GET /v1/edge/agent-artifacts/{id}` | 凭设备令牌取能力合约当前允许的制品 |
| `PUT /v1/platform/agent-releases/{id}/runtime?revision=…` | 管理员上传与指定发行配套的原厂 Code 引擎。修订过期返回 409，摘要或大小不符返回 422 |
| `GET /v1/platform/agent-releases/{id}/runtime` | 管理员下载已缓存的配套引擎 |
| `GET /v1/edge/agent-artifacts/{id}/runtime` | 凭设备令牌下载成员当前合约允许的发行所需的引擎 |

上传和拉取均在私有暂存文件中校验原始字节数及 SHA-256，验证通过后原子发布，并记录审计。
厂商地址受限时，平台管理员可上传手头的已批准制品。同一发行允许在启用前上传或拉取。
支持缓存协议的 Edge 使用它当前连接的 OneX Server 作为下载服务器，跟随同一协议、主机和端口。厂商源地址供 Server 入库。旧 Edge 的兼容规则见 [Edge ↔ Server 协议](edge-ws.md)。


WorkBuddy、DeepSeek Harness Desktop、Claude Desktop 和 Codex Desktop 的原厂安装包可登记、校验并缓存。平台与 Edge 共读 `server/src/desktop-qualifications.json`，按 Agent、版本、系统、架构、字节数和 SHA-256 匹配原生验收结果。匹配合格且已有完整缓存的发行可由管理员激活。其余发行返回 `qualification_required: true` 并允许管理员下载测试。macOS ARM64 的 WorkBuddy 5.3.8 已通过原厂模型菜单和双任务独立入账验收。macOS ARM64 的 DeepSeek Harness Desktop 0.2.1-rc.3 已通过原厂进程、会话冷恢复和本机回环上游计费测试。

桌面包分段上传沿用 PUT，传 `?part=<从 0 起的段号>&revision=<当前修订>`，段大小取发行返回的 `part_bytes`（32 MiB），最后一段取余数，桌面整包最多 768 MiB。待分段齐全返回 202；合并后完成整包大小、SHA-256 和容器标记校验返回 200。同段可重传。校验完成前，文件不能下载。


Claude Desktop 6.28899.6 发行还依赖固定的 Code 引擎 2.1.330。发行详情的 `runtime` 提供引擎原包的 `size`、`sha256` 和 `artifact_cached`。WebUI 根据 `upload_runtime` 展示上传表单。Server 校验原始 `.tar.zst` 字节数、SHA-256、权限及发行修订后提交缓存，写入平台审计。DMG 与引擎均就绪后可启用。设备端的每次下载均按当前成员有效合约、操作系统和架构重新核对发行权限，签发变更后立即生效。
