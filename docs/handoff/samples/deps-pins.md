# 运行依赖的固定版本与校验值

2026-11-19 由总督从官方发布渠道查得。SHA-256 来自 GitHub Releases API 的 `digest` 字段和项目自己发布的 hash 文件，两边交叉核对时以项目发布为准。

## Bun 1.4.5

| 平台 | 资产 | SHA-256 |
| --- | --- | --- |
| macOS arm64 | `https://github.com/oven-sh/bun/releases/download/bun-v1.4.5/bun-darwin-aarch64.zip` | `b5d6bc2e13caf14e57c89661e89efd073ff16165b41bfe43882616410609cd10` |
| Linux x86_64 | `https://github.com/oven-sh/bun/releases/download/bun-v1.4.5/bun-linux-x64.zip` | `94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb` |

211 使用标准 Linux x64 制品。部署脚本也接受该版本的 `bun-linux-x64-baseline.zip`（`dcb23a18a1c2fff12d57bcef696dbbb42eb67fde29f43816ecb595459a24c463`）。Bun 资产摘要于 2026-11-23 从官方发布元数据核对。 [Bun 1.4.5 发布](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.5)

## Valkey 8.1.5

官方只发 Linux 预编译包，没有 macOS 版本。

| 平台 | 方式 | 资产 | SHA-256 |
| --- | --- | --- | --- |
| Linux x86_64（Ubuntu 22.04） | 预编译 | `https://download.valkey.io/releases/valkey-8.1.5-jammy-x86_64.tar.gz` | `9f5b1fc5c4599e71dc03de5bc4fe1c619d6881d0230f9877b3d470c36a635789` |
| macOS arm64 | 源码编译（`make`，需要 Xcode 命令行工具，本机已有） | `https://github.com/valkey-io/valkey/archive/refs/tags/8.1.5.tar.gz` | `2d47a6afaec7a5383813579c2367193053ec885bc135e810284fe94ccdd324d2`（来自 valkey-io/valkey-hashes） |

源码编译也可以在 Linux 上用，作为预编译包下载失败时的备用路径。

## RustFS 1.0.6（2026-11-15 发布）

| 平台 | 资产 | SHA-256 |
| --- | --- | --- |
| macOS arm64 | `https://github.com/rustfs/rustfs/releases/download/1.0.6/rustfs-macos-aarch64-v1.0.6.zip` | `e0bf7e8aeee45490034576fde6513377db81844d8c40e24c57269e9bb274882f` |
| Linux x86_64 | `https://github.com/rustfs/rustfs/releases/download/1.0.6/rustfs-linux-x86_64-musl-v1.0.6.zip` | `a4d109a09857c04bf5d11b2cec0fbbf0887819b9392e5d46d7d153dae6a1398f` |

Linux 选 musl 版：静态链接，不依赖 211 上的 glibc 版本。gnu 版的校验值是 `4f0bf3fecbe861467427ff506aee22c302cfd5ac8b7dcbde71714f8e5e680dea`。

## 网络

本机访问 GitHub 要经 FlClash 代理（`http://127.0.0.1:7890`），节点不稳定时会失败。211 可以直连 GitHub 和 download.valkey.io（2026-11-19 核实，无代理）。部署脚本仍要支持“本机下载、校验后上传到远端”的方式，不要求远端能访问外网。
