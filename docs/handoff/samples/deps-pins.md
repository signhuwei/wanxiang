# 运行依赖的固定版本与校验值

2026-11-19 由总督从官方发布渠道查得。SHA-256 来自 GitHub Releases API 的 `digest` 字段和项目自己发布的 hash 文件，两边交叉核对时以项目发布为准。

## Bun 1.3.5（与本机开发环境一致）

| 平台 | 资产 | SHA-256 |
| --- | --- | --- |
| macOS arm64 | `https://github.com/oven-sh/bun/releases/download/bun-v1.3.5/bun-darwin-aarch64.zip` | `db17588a4aea8804856825d4bead3f05e1f37276ca606f37e369b4f72f35d3fb` |
| Linux x86_64 | `https://github.com/oven-sh/bun/releases/download/bun-v1.3.5/bun-linux-x64.zip` | `7051d86a924aefea3e0b96213b5fd8f79c0793f9cae6534233e627e5c3db4669` |

211 的 CPU 支持 AVX2（2026-11-19 核实），用普通版即可。不支持 AVX2 的机器要用 `bun-linux-x64-baseline.zip`（`6bddacd6a65855698b9816f2d74871eda4dd0b7fa921140c6445248f94a742fd`）。脚本用 `grep -q avx2 /proc/cpuinfo` 判断。

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
