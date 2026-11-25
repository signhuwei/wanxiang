# Windows x64 内测安装器

在 Windows PowerShell 中执行。构建端使用 Git、Rust MSVC、Bun 1.4.5 和 Tauri CLI 2.10.0。构建脚本按 [deploy/bun-version](../bun-version) 检查 Bun，使用 mise 时在仓库根目录运行 `mise install`。按 Tauri 指南准备 Microsoft C++ Build Tools 的「使用 C++ 的桌面开发」工作负载及 WebView2。 [Tauri Windows 前置条件](https://v2.tauri.app/start/prerequisites/#windows)

在已拉取的候选提交根目录运行以下命令。内测 Server 地址和发行版本号按本次发布填写。

```powershell
.\deploy\windows\build.ps1 -ServerOrigin 'http://192.168.3.211:18700' -Version '0.1.0-rc20'
```

脚本编译 x64 原生 onex 与 onexd，执行锁定依赖的 Rust 工作区测试，并用 Tauri 打包当前用户模式的 NSIS 安装器。输出中包含 Git 提交、应用版本、安装器路径、文件字节数和 SHA-256。安装器默认写入 `edge\target\onex-windows\x86_64-pc-windows-msvc\release\bundle\nsis`。

`-Version` 写入安装器和 Desktop 应用。安装后，在首页 Logo 下核对完整版本号，再把构建输出的同一 `version` 传给 [发布命令](../README.md#平台维护与发布) `publish-edge <Server 地址> windows <版本> <安装包路径>`。本机构建省略 `-Version` 时使用仓库的 Tauri 默认版本。

安装器一起安装 OneX Desktop、`onex.exe` 和 `onexd.exe`，并为当前用户注册 Edge daemon 登录自启和终端命令。安装完成后完全退出并重新打开 Windows Terminal 或 PowerShell，可运行 `(Get-Command onex).Source` 查看命令路径，运行 `onex status` 查看设备状态。CLI 和 Desktop 使用同一 daemon 与设备身份。

Edge 安装器写入应用前会执行 `git --version`，并检查 Git for Windows 的注册表安装路径。缺失时优先用当前用户的 WinGet 安装官方 `Git.Git`。没有 WinGet 的设备从 Git for Windows 官方发行下载固定的 x64 安装器，按微软清单核对 SHA-256 后执行。Git 仍不可用时，安装器显示错误并退出。Edge 会从注册表找到新装的 Git，安装器启动的首个 Agent 也可直接使用。 [Git for Windows 安装](https://git-scm.com/install/windows) · [WinGet 安装命令](https://learn.microsoft.com/en-us/windows/package-manager/winget/install)

在 Windows x64 测试快照里验收两种情况。在已有 Git 的快照上，记录安装前后的 `git --version`，确认原版本继续可用。在没有 Git 的快照上，以普通用户运行 NSIS 安装器，确认安装器安装了 Git，再直接从完成页启动 OneX Desktop。登录内测租户后，从 OneX 启动 Agent 并执行 `git --version`。用没有 WinGet 的快照走一遍官方安装器下载路径。恢复一个已有 Edge、无 Git 的快照并暂时断网，执行原地重装，确认报告失败，原 Edge 和自启项保留。

Windows 验收记录编译与测试退出状态、安装器及摘要，并在指定的测试用户下验证安装、自启、登录、受管终端、重开后的设备身份和卸载清理。测试只使用内测账号与合成对话。正式签名和外部发布按后续计划处理。 [Tauri NSIS 安装器](https://v2.tauri.app/distribute/windows-installer/)

验收 CLI 时，在重开的 PowerShell 执行 `(Get-Command onex).Source`，确认它指向本次安装的 `onex.exe`，用 `onex status` 核对 Desktop 登录后的设备。原地重装后，本安装新增的 PATH 项应只有一条。卸载后确认仅清除了安装器新增的项，卸载前已有的 PATH 项均保留。

Windows x64 的 DeepSeek Harness Desktop 由 OneX 下载并校验原厂制品，随后从 OneX 私有缓存启动原厂 GUI。测试租户的有效合约须授予 DeepSeek 和模型，服务端须缓存并启用符合精确资格的 Windows 发行。验收时记录首次下载进度、原生会话冷恢复、两轮模型回复、回流、租约结算和退出后 `dsh://` 关联恢复。

NSIS 内附原样的 7-Zip 26.06 命令行程序和 DLL，用于解包固定的原厂制品。7-Zip 采用 GNU LGPL 许可。安装目录内的 `onex-tools/7zip/License.txt` 和 `Source.txt` 记录组件许可和源码位置。 [7-Zip 项目](https://www.7-zip.org/) · [7-Zip 26.06 源码](https://github.com/ip7z/7zip/releases/tag/26.06)
