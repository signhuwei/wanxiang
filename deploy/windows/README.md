# Windows x64 内测安装器

在 Windows 的 PowerShell 中执行。构建端使用 Git、Rust MSVC、Bun 和 Tauri CLI 2.10.0。按 Tauri 指南准备 Microsoft C++ Build Tools 的「使用 C++ 的桌面开发」工作负载及 WebView2。 [Tauri Windows 前置条件](https://v2.tauri.app/start/prerequisites/#windows)

在已拉取的候选提交根目录运行以下命令。内测 Server 地址可以按环境调整。

```powershell
.\deploy\windows\build.ps1 -ServerOrigin 'http://192.168.3.211:18700'
```

脚本编译 x64 原生 onex 与 onexd，执行锁定依赖的 Rust 工作区测试，并用 Tauri 打包当前用户模式的 NSIS 安装器。输出中包含 Git 提交、安装器路径、文件字节数和 SHA-256。安装器默认写入 Cargo 目标目录下的 `x86_64-pc-windows-msvc\release\bundle\nsis`。

Windows 验收记录编译与测试退出状态、安装器及摘要，并在指定的测试用户下验证安装、自启、登录、受管终端、重开后的设备身份和卸载清理。测试只使用内测账号与合成对话。正式签名和外部发布按后续计划处理。 [Tauri NSIS 安装器](https://v2.tauri.app/distribute/windows-installer/)
