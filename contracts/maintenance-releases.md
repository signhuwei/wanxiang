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
