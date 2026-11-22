# Windows x64 Edge 构建、验收与发布

Windows x64 Edge 候选发行号为 `0.1.0-rc13`，构建分支为 `release/windows-edge-rc13`，固定提交为 `3bc69a64ff53007574c14b1990e96465603046f1`，与本轮 Server/WebUI 发布同源。源码已推送并从 GitHub 重新克隆验证。Windows 安装包构建和实机验收待执行。

OneX Desktop 安装器包含 Desktop、`onex.exe` 和 `onexd.exe`。本轮可在原生 Windows x64 验收普通用户安装、员工登录，以及 Claude Code、Codex CLI 和 Kimi Code 各自从空缓存下载、启动、运行和结算。原厂桌面 Agent 的 Windows 受管运行等待适配与实机资格验证。

## 1. 从 GitHub 取得指定提交

先在 Windows 构建机安装 Git for Windows，再在 PowerShell 拉取 `release/windows-edge-rc13`，并核对提交和工作区。 [Git for Windows](https://git-scm.com/install/windows)

```powershell
$repo = 'https://github.com/signhuwei/wanxiang.git'
$branch = 'release/windows-edge-rc13'
$expected = '3bc69a64ff53007574c14b1990e96465603046f1'
git ls-remote --exit-code $repo "refs/heads/$branch"
if ($LASTEXITCODE -ne 0) { throw 'GitHub branch unavailable' }
git clone --single-branch --branch $branch $repo OneX-Windows
if ($LASTEXITCODE -ne 0) { throw 'Clone failed' }
Set-Location OneX-Windows
if ((git rev-parse HEAD) -ne $expected) { throw 'Unexpected source revision' }
if (git status --porcelain) { throw 'Source tree is dirty' }
```

Windows 构建机暂时无法访问 GitHub 时，可使用已验证可独立克隆的 `OneX-Windows-3bc69a6.bundle`。把 bundle 和同名 `.sha256` 放入当前目录。bundle 内分支名为 `dev/routing-integration`。

```powershell
$bundle = (Resolve-Path '.\OneX-Windows-3bc69a6.bundle').Path
$sha = ((Get-Content -LiteralPath "$bundle.sha256" -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash -ne $sha) { throw 'Bundle SHA-256 mismatch' }
git clone --branch dev/routing-integration $bundle OneX-Windows
if ($LASTEXITCODE -ne 0) { throw 'Bundle clone failed' }
Set-Location OneX-Windows
if ((git rev-parse HEAD) -ne '3bc69a64ff53007574c14b1990e96465603046f1') { throw 'Unexpected source revision' }
if (git status --porcelain) { throw 'Source tree is dirty' }
```

## 2. 编译并打包 NSIS 安装器

构建机安装 Git for Windows、Rust MSVC、Bun `1.3.5`、MSVC C++ Build Tools 的「使用 C++ 的桌面开发」工作负载及 Windows SDK、WebView2 Runtime。Tauri CLI 固定为 `2.10.0`。 [Tauri Windows 前置条件](https://v2.tauri.app/start/prerequisites/#windows)

```powershell
rustup default stable-x86_64-pc-windows-msvc
rustup target add x86_64-pc-windows-msvc
cargo install tauri-cli --version 2.10.0 --locked
git --version
rustc -Vv
bun --version
cargo tauri --version

$server = 'http://mapcan.xyz:18700'
Invoke-RestMethod "$server/v1/healthz"
# 在已核对提交的仓库根目录执行
.\deploy\windows\build.ps1 -ServerOrigin $server
```

脚本使用锁定依赖编译 `onex.exe`、`onexd.exe`，运行 Windows x64 Rust 工作区测试，再构建 Tauri Desktop 和当前用户模式的 NSIS 安装器。三个程序都校验 x64 PE 头。脚本返回提交、应用版本、安装器绝对路径、字节数和 SHA-256，并写出随包 `.sha256`。保存完整构建输出和最后的 JSON。

安装器目录为 `edge\target\onex-windows\x86_64-pc-windows-msvc\release\bundle\nsis`。将脚本返回的 `installer` 和 `.sha256` 交给测试人员。源码内嵌的应用版本目前为 `0.1.0`，下载台账使用预发行号 `0.1.0-rc13`。脚本使用 `--no-sign`，输出供内测。 [Tauri NSIS 安装器](https://v2.tauri.app/distribute/windows-installer/)

## 3. 准备 Agent 制品及员工权限

本次已在 OneX 生产核实下列 `win32/x64` 发行已启用，且私有缓存中已有对应文件。用当前制品直接验收。

| OneX Agent | 版本 | 字节数 |
| --- | --- | ---: |
| Claude Code (`claude-code`) | `2.1.311` | 298,870,432 |
| Codex CLI (`codex`) | `0.164.0` | 354,558,768 |
| Kimi Code (`kimi-code`) | `2.3.0` | 161,314,080 |

平台管理员在「能力管理 → Agent」核对发行和缓存。为指定的内测员工准备已生效的能力合约，包含三条 Windows x64 发行、各自可用模型、费率和测试额度。核对成员的有效配置及可用席位，逐一验证对应渠道连通。通过既有凭据渠道向测试人员提供租户简称、租户 ID、用户名和密码。Windows 测试机在内网或经已有可信隧道连接当前 HTTP 测试服务。

### 从 SIMA 复用 Windows 安装原件

SIMA 的发行记录和原始安装包可用于供给 OneX。按 SIMA 发行 ID 导出原厂完整文件，记录来源 URL、Agent、版本、平台、架构、字节数及 SHA-256。优先由有权限的管理员在同机读取或经内网取回，上传到 OneX 发行的私有制品缓存。OneX 员工端用设备凭据从 OneX Server 取包。

1. 在 OneX 的「Agent 制品」登记相同发行身份，状态保持未启用，来源填写已核对的厂商地址。遵守 OneX 的 Agent 名与平台枚举，例如 SIMA 的 Windows x64 在 Agent API 中填 `win32 / x64`。
2. 通过该发行右侧的上传表单提交原件。桌面整包超过 256 MiB 时，现有 WebUI 按发行详情的 `part_bytes` 分段上传。API 等价操作为 `PUT /v1/platform/agent-releases/{id}/artifact?part=N&revision=R`，从段号 0 开始。前段返回 202，合并校验完成返回 200。最后取详情确认 `artifact_cached=true`、字节数及 SHA-256 匹配。 [Agent 制品维护协议](../../contracts/maintenance-releases.md#agent-制品库)
3. 桌面 GUI 候选在 Windows 上核对厂商 Authenticode、安装后的实际 x64 程序和受管运行，再由 OneX 按精准发行身份取得资格、启用并纳入测试员工合约。

本次从同机 SIMA 的平台私有制品库读取原件，通过 OneX 平台 API 分段上传。已核对 OneX 缓存的实际字节数及 SHA-256。两条发行均为「待原生运行验证」，尚未启用。

| Agent | 版本 | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| DeepSeek Harness Desktop | `0.2.1-rc.3` | 289,415,960 | `1e3876baaa20c3f26371dba7b6873bb70c3ef9b91403f6d3f87d2b27d4fd1e3a` |
| WorkBuddy | `5.3.8` | 407,285,928 | `c111bc3f54a0e53fa04924313ae660125eebffafcd5ac7722da7c3c03402cb7a` |

外层 NSIS 是安装引导程序，实际架构以官方 win-x64 发行和安装后的程序为准。

当前 `3bc69a6` 的 OneX 原厂 GUI 受管启动仅支持 macOS ARM64。DeepSeek、WorkBuddy、Claude Desktop 和 Codex Desktop 的 Windows 受管流程列为待实现和验收。其中 Claude Desktop、Codex Desktop 还需补 Windows 制品格式。若本轮发布范围包含原厂 Windows GUI，须补齐 Windows 受管安装／启动、会话绑定和报账后才算通过。DeepSeek 和 WorkBuddy 的 Windows 安装与启动可分别参考 SIMA 实现 `e6ec68b`、`28cc085c` 和冷启动修复 `4a9832d6`。 [OneX 发行资格清单](../../server/src/desktop-qualifications.json) · [Edge 原厂安装器入口](../../edge/onexd/src/desktop_bundle.rs)

## 4. Windows 实机验收

准备一个干净 Windows x64 普通用户或 VM 快照。使用最终待发布的同一份 NSIS 安装器，记录 Windows 版本和测试包 SHA-256。

```powershell
$installer = (Resolve-Path 'C:\path\to\OneX-Desktop-setup.exe').Path
$expectedHash = ((Get-Content -LiteralPath "$installer.sha256" -Raw).Trim() -split '\s+')[0]
$actualHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) { throw 'Installer SHA-256 mismatch' }
Get-AuthenticodeSignature -FilePath $installer | Select-Object Status, StatusMessage
$setup = Start-Process -FilePath $installer -Wait -PassThru
if ($setup.ExitCode -ne 0) { throw "Installer exited with status $($setup.ExitCode)" }
$daemon = Get-ItemPropertyValue -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name OneXEdge
Get-Process onexd
$onex = Join-Path (Split-Path -Parent ($daemon.Trim('"'))) 'onex.exe'
& $onex status | ConvertFrom-Json
```

| 次序 | 实机操作 | 通过标准 |
| --- | --- | --- |
| 1 | 普通用户运行 NSIS，从完成页打开 OneX Desktop | 应用窗口打开，`onexd` 在当前用户下运行，`OneXEdge` 自启项指向实际安装路径 |
| 2 | Desktop 输入租户简称、用户名和密码。用租户 ID 再登录一次，并试错一次密码 | 正确凭据进入对应员工工作台，错密码停留在登录页。设置页指向目标 Server，连接状态为「已连接」 |
| 3 | 从员工工作台验证合约，并尝试使用一个未授权的 Agent 或模型 | 服务器看到 Windows x64 设备，合约已经生效。工作台显示授权 Agent、版本、模型和签约倍率，未授权项无启动入口或被拒绝 |
| 4 | 在空 Agent 缓存中，分别点 Claude Code、Codex CLI、Kimi Code 的「下载」和「启动」 | 工作台有下载进度和完成状态，下载来源是 OneX，版本与签发一致。终端内启动的是 OneX 的受管实例 |
| 5 | 每个 Agent 发送两轮合成提示，在一个 Agent 的终端中用工具执行 `git --version` | 每个 Agent 都获得真实模型答复，模型符合合约。可核对会话正文、Provider、Token、费用和余额变动，且一次请求只结算一次 |
| 6 | 同一 CLI 多开两实例，结束一个。测试管理员调一次员工配置，然后断网重连、关闭重开 Desktop 和重启 Windows | 实例数递增递减，两实例的正文和用量各自归属。配置调整出现在消息列表，设备回报已应用。重启后设备身份和缓存仍可用，继续对话可回流且重复事件无重复费用 |
| 7 | 退出 OneX 账号，在同一窗口立即重新登录。再退出并验证重启后的登录页。卸载后由同一测试用户重装 | 退出后受管能力不可用，重新登录成功。卸载停止 daemon 并清除自启项。重装可正常登录，从干净快照复验首次安装与下载 |

Git 前置在有 Git、无 Git 但可用 WinGet、无 Git 且无 WinGet 三种快照各测一次。已有 Git 检查版本保留。无 Git 检查安装器经 WinGet 或官方校验流程安装 Git，随后直接打开 OneX 并从 Agent 中执行 `git --version`。有旧 Edge 但无 Git 的快照另测断网原地重装，预期安装失败，原 Edge 和自启项仍可用。 [Git for Windows](https://git-scm.com/install/windows) · [WinGet 安装命令](https://learn.microsoft.com/en-us/windows/package-manager/winget/install)

如本轮包含原厂 GUI，使用取得 Windows 资格的最终候选按第 4、5、6 步从员工 Desktop 下载、安装及受管启动。DeepSeek 另测原生 PNG、文本层 PDF、TXT，并重启同一原生会话核对正文和费用。WorkBuddy 另测仅可使用获准模型、个人自定义模型入口受限、两个原生任务独立入账。Windows 的 PDF 取字需用该平台的实际实现验收。

测试记录保存构建 JSON、安装器 SHA-256、Windows 版本、测试租户与设备 ID、应用的配置修订及步骤截图。对每款 Agent 分别记录版本、下载、启动、实际应答、会话回流、用量和扣费结果。每个用例填写通过、失败或阻塞，并附对应会话 ID 或日志。密码和令牌通过既有凭据渠道保管。

## 5. 发布并复核员工下载

实机测试通过后，由平台管理员在「运维管理 → Edge 安装包」为 `windows / x64` 新建 `0.1.0-rc13` 草稿，上传已测的 `*-setup.exe`，核对大小及 SHA-256，再点「发布」。同平台的新发布会替换当前下载项。CLI 等价入口可以使用已配置的短期管理员会话文件执行。 [Edge 安装包发布协议](../../contracts/desktop-releases.md)

```powershell
# 管理员在自己的受信任环境执行，变量指向私有会话文件
$env:ONEX_RELEASE_TOKEN_FILE = 'C:\private\onex-platform-session.txt'
bun --no-env-file deploy/release.ts publish-edge 'http://mapcan.xyz:18700' windows 0.1.0-rc13 $installer
Remove-Item Env:ONEX_RELEASE_TOKEN_FILE
```

从员工 [下载页](http://mapcan.xyz:18700/download) 选择 Windows，再下载一次完整文件。核对版本、字节数和 SHA-256 与构建及服务器台账一致，并用下载到的文件做一次普通用户安装和 Desktop 登录。验证下载列表仍有 macOS ARM64 项。Windows 出现回归时，通过原发布记录下架受影响版本，并在另一个版本下发布已核验的恢复包。
