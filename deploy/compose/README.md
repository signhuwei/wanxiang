# OneX Docker 部署与发布

在受控构建机从 Git 提交构建 `linux/arm64` 镜像。Server 镜像包含 Bun、服务端、WebUI、SQL 迁移和依赖。Compose 负责 Server、Valkey、RustFS 和独立的发布执行器。Docker 命名卷保存业务数据和加密发布包。在 Mac mini 的 `colima-onex` 环境中，这些卷的虚拟磁盘位于 `/Volumes/onex_data01/colima/lima`。

## 1. 首装

构建机需要 `deploy/bun-version` 指定的 Bun、Docker Buildx、`gzip` 和 `age`。以下命令在已提交的 checkout 运行。保管现有 Ed25519 发布签名私钥，首次只向目标机提供对应公钥。

```sh
export ONEX_PUBLIC_ORIGIN=https://x.onc-ai.com
bun --no-env-file deploy/compose/pack.ts bootstrap /secure/output HEAD
```

将输出的 `bootstrap-<commit>/` 目录作为一个归档通过 SSH 传到目标机并解包。目录包含 `deployment.env`、Compose 描述、首装脚本、四个本地镜像的归档和 SHA-256。用目标 Docker context 运行以下命令。

```sh
cd /path/to/bootstrap-commit
docker context show
bash bootstrap.sh /secure/server-release.pub
```

脚本在目标机生成业务运行密钥和 `age` 身份，并输出该环境的 `age` 公钥。保存这个公钥用于后续打包。重复执行首装脚本使用已有服务容器和密钥。实验环境可以在调用前指定独立项目名与监听地址，例如 `ONEX_PROJECT_NAME=onex-drill ONEX_HOST_BIND=127.0.0.1 bash bootstrap.sh /secure/server-release.pub`。

需要在保留卷的情况下重建服务时，仍用 `bootstrap.sh`。它会核对维护卷记录的生效镜像 ID 并启动该镜像。若脚本报告发布中断，先用同一 Compose 项目启动 `valkey rustfs release-worker`，由执行器完成恢复，再运行首装脚本。

默认将容器 `18700` 映射至 macOS 宿主机 `18700`。生产入口通过 TLS 转发 HTTP 和 WebSocket 至这个端口。外部反代须实际验证到宿主机端口的连通性，并支持 Docker 加密制品的 256 MiB 上限和 10 分钟上传窗口。

| 卷 | 挂载 |
| --- | --- |
| `server-data` | Server 与发布执行器读写 `/data/server`。保存 SQLite、业务文件和安装制品。 |
| `maintenance` | 两者读写 `/data/server/maintenance`。保存发布队列、任务状态、密文、运行心跳和回退备份。 |
| `valkey-data`、`rustfs-data` | 分别挂给对应服务的 `/data`，读写。 |
| 密钥卷 | 服务运行时按需只读挂载，`age` 私钥只挂给发布执行器。 |

## 2. 后续发版

每个部署环境对同一 Git 提交使用一份固定密文。重新提交同一发布任务时复用原包。`age` 每次加密会生成不同的密文字节。

```sh
export ONEX_PUBLIC_ORIGIN=https://x.onc-ai.com
export ONEX_RELEASE_PRIVATE_KEY=/secure/server-release.key
export ONEX_RELEASE_RECIPIENT=age1...
export ONEX_RELEASE_LOGIN_TOKEN_FILE=/secure/platform-login.token
commit=$(git rev-parse HEAD)
bun --no-env-file deploy/compose/pack.ts upgrade /secure/output "$commit"
bundle="/secure/output/upgrade-$commit"
bun --no-env-file deploy/release.ts publish-server "$ONEX_PUBLIC_ORIGIN" \
  "$bundle/manifest.json" "$bundle/server.tar.gz.age"
```

现有发布 API 入库密文和签名清单。签名覆盖 Git SHA、镜像 ID、目标架构、制品格式以及密文大小和摘要。执行器独立运行，验证后加载镜像，暂时阻止业务流量，备份 SQLite 并重建 Server。它核对运行镜像和 `/v1/healthz` 的 Git SHA，失败时按任务状态回退镜像和数据库。

`publish-server` 可以通过 `ONEX_EXPECTED_COMMIT` 固定当前版本，并通过 `ONEX_RELEASE_REQUEST_ID` 固定幂等键。命令返回部署任务后，使用 `bun deploy/release.ts rollout "$ONEX_PUBLIC_ORIGIN" roll_ID` 查看结果。

## 3. Edge 和正式迁移

用同一个 `ONEX_PUBLIC_ORIGIN` 给 macOS 打包与 Windows 构建传入公网入口，两端会派生 `wss://x.onc-ai.com/v1/edge/ws`。现有签名 Edge 制品仍通过 Desktop 发布入口上传。旧版 macOS 自动更新会拒绝替换 `ONEX_SERVER`，设备身份也按公网 origin 匹配。域名切换前先用隔离设备验收，旧 origin 可临时透传到同一个 Server。

正式迁移前，先在空数据环境完成首装、API 上传、换版和回退演练。随后核对 211 实际运行版本及存储路径，用备份恢复系统和租户库、对象存储、Valkey 及对应运行密钥。检查旧 Desktop 下载记录中的绝对路径和下载摘要。历史 v1 Server 发布档案保存在原环境，迁移的发布台账可保留其历史记录。生产入口切换前停止旧环境写入。
