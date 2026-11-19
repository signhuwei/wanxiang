# OneX Desktop 安装包发布

面向部署所在的内测网络。管理员使用现有平台管理员角色。员工在登录前可查看和下载已发布的当前版本。安装包独立于下发到 Edge 的受管 CLI 发行目录。

## 平台与状态

- `darwin/arm64` 对应 macOS `.pkg`，`windows/x64` 对应 Windows `.exe` 安装器。客户端提供手动平台选择。版本采用 SemVer，可带预发行后缀。
- 同一平台和版本只有一条发布记录。新记录为 `draft`。安装包上传完成后仍为草稿，服务端返回字节数和 SHA-256 供确认。发布需要经过校验的文件。
- 每个平台只有一个 `published` 当前版本。发布新草稿时，原当前版本在同一事务内变为 `unlisted`。手动下架也进入 `unlisted`。下架后新请求不能通过旧链接下载，列表不回退到历史版本。
- `id`、`version`、`os`、`arch`、`status`、`revision`、`size`、`sha256`、`published_at` 为管理端记录字段。未上传时 `size`、`sha256` 为 `null`。`published_at` 初始为 `null`，发布以后保留该时间。每次变更增加 `revision`。

## 管理端 API

列表的 `actions` 包含 `create_desktop_release`。管理端记录有 `read`，草稿另有 `upload_artifact`，校验完成后增加 `publish`，当前版本另有 `unpublish`。JSON 写操作沿用 `Idempotency-Key`。上传结果未知时，重新读取草稿的当前修订与摘要再继续。

路径前缀 `/v1/platform/desktop-releases`。使用现有 Bearer 会话和 API 错误结构。

| 方法和相对路径 | 请求 | 成功响应 |
| --- | --- | --- |
| GET | 可选 `q`、`limit`、`cursor` | `200 {items, total, next_cursor, actions}` |
| POST | JSON `{version, os, arch}` | `201`，新草稿记录 |
| GET `/:id` | 按 ID 读取当前修订 | `200`，管理端记录 |
| PUT `/:id/artifact?revision=N` | `application/octet-stream`，安装包原始字节 | `200`，带大小和摘要的草稿记录 |
| POST `/:id/publish` | JSON `{revision}` | `200`，已发布记录 |
| POST `/:id/unpublish` | JSON `{revision}` | `200`，已下架记录 |

上传前验证平台管理员、草稿状态、版本修订和容量上限。S2 的单包上限为 256 MiB。服务端计算 SHA-256，检查实际字节长度和相应的 XAR 或 PE 安装器格式。无效或超限返回 `422` 或 `413`，旧修订、重复版本或非法状态返回 `409`。中断或失败上传不能改变已验证的草稿或生成可下载版本。安装包原件位于私有持久存储。草稿允许在发布前重传。记录发布与下架审计。

## 员工入口

- `GET /download` 独立网页，直接查询 `GET /v1/desktop-releases`。列表响应为 `{items}`，每项包含 `id`、`version`、`os`、`arch`、`size`、`sha256`、`published_at`、`download_url`。列表只包含当前已发布版本。
- `GET /v1/desktop-releases/:id/download` 按同源附件下载。返回固定格式文件名及正确的字节数。无有效发布返回 `404`。列表和文件响应使用 `Cache-Control: no-store`。
- 员工页面在 Windows 或 macOS 上推荐对应当前版本，并提供平台切换、版本和摘要。平台识别不明确时展示可用选项。页面直接下载，绕过浏览器脚本持有安装包全量字节。

正式签名公证、外部发布、客户端升级和回退在 S4 或以后处理。
