[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $ServerOrigin,

    [ValidateLength(1, 64)]
    [ValidateScript({
        $parsed = [regex]::Match($_, '\A(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\z')
        if (-not $parsed.Success -or ($parsed.Groups[1].Value -split '\.' -match '^0[0-9]+$')) {
            throw 'Version must be a semantic version such as 0.1.0-rc20.'
        }
        return $true
    })]
    [string] $Version
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'Run this script in native Windows PowerShell.'
}

[Uri] $origin = $null
if (-not [Uri]::TryCreate($ServerOrigin, [UriKind]::Absolute, [ref] $origin) -or
    $origin.Scheme -notin @('http', 'https') -or $origin.UserInfo -or
    $origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.Fragment) {
    throw 'ServerOrigin must be an HTTP or HTTPS origin with no credentials, path, or query.'
}

function Invoke-Checked {
    param([string] $Program, [string[]] $Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "${Program} exited with status $LASTEXITCODE"
    }
}

function Assert-X64 {
    param([string] $File)
    $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($File))
    try {
        if ($reader.BaseStream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5A4D) {
            throw "Invalid Windows executable: $File"
        }
        $reader.BaseStream.Position = 0x3c
        $offset = $reader.ReadUInt32()
        if ($offset -lt 64 -or $offset -gt $reader.BaseStream.Length - 6) {
            throw "Invalid PE header offset: $File"
        }
        $reader.BaseStream.Position = $offset
        if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) {
            throw "Expected an x64 Windows executable: $File"
        }
    } finally {
        $reader.Dispose()
    }
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$bunVersion = (Get-Content -Raw -LiteralPath (Join-Path $repo 'deploy\bun-version')).Trim()
$actualBun = Invoke-Checked 'bun' @('--version')
if ($actualBun -ne $bunVersion) {
    throw "Expected Bun $bunVersion, got $actualBun."
}
$edge = Join-Path $repo 'edge'
$desktop = Join-Path $edge 'desktop'
$appVersion = if ($Version) { $Version } else {
    (Get-Content -Raw -LiteralPath (Join-Path $desktop 'tauri.conf.json') | ConvertFrom-Json).version
}
$target = 'x86_64-pc-windows-msvc'
$targetDir = Join-Path $edge 'target\onex-windows'
$releaseDir = Join-Path $targetDir "$target\release"
$staging = Join-Path $targetDir 'inputs'
$icons = Join-Path $staging 'icons'
$configFile = Join-Path $staging 'windows-bundle.json'
$oldTargetDir = $env:CARGO_TARGET_DIR
$oldTauriConfig = $env:TAURI_CONFIG
$oldServer = $env:ONEX_WINDOWS_DEFAULT_SERVER
$wsScheme = if ($origin.Scheme -eq 'https') { 'wss' } else { 'ws' }

try {
    $env:CARGO_TARGET_DIR = $targetDir
    $env:TAURI_CONFIG = $null
    $env:ONEX_WINDOWS_DEFAULT_SERVER = "${wsScheme}://$($origin.Authority)/v1/edge/ws"
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    & (Join-Path $PSScriptRoot 'stage-7zip.ps1') -Staging $staging
    Invoke-Checked 'rustup' @('target', 'add', $target)
    Invoke-Checked 'cargo' @('tauri', '--version')

    Push-Location (Join-Path $repo 'server')
    try { Invoke-Checked 'bun' @('install', '--frozen-lockfile') } finally { Pop-Location }

    Invoke-Checked 'cargo' @('build', '--manifest-path', (Join-Path $edge 'Cargo.toml'),
        '--release', '--locked', '--target', $target, '-p', 'onex-cli', '-p', 'onexd')
    foreach ($binary in @('onex', 'onexd')) {
        $source = Join-Path $releaseDir "$binary.exe"
        Assert-X64 $source
        Copy-Item -LiteralPath $source -Destination (Join-Path $staging "$binary-$target.exe") -Force
    }

    Push-Location $desktop
    try {
        Invoke-Checked 'cargo' @('tauri', 'icon', (Join-Path $desktop 'icons\icon.png'), '--output', $icons)
        $icon = Join-Path $icons 'icon.ico'
        if (-not (Test-Path -LiteralPath $icon -PathType Leaf)) { throw 'Tauri did not generate icon.ico.' }

        $buildConfig = @{
            version = $appVersion
            bundle = @{
                targets = @('nsis')
                icon = @('../target/onex-windows/inputs/icons/icon.ico')
                externalBin = @('../target/onex-windows/inputs/onex', '../target/onex-windows/inputs/onexd')
                resources = @{
                    '../target/onex-windows/inputs/7zip/7z.exe' = 'onex-tools/7zip/7z.exe'
                    '../target/onex-windows/inputs/7zip/7z.dll' = 'onex-tools/7zip/7z.dll'
                    '../target/onex-windows/inputs/7zip/License.txt' = 'onex-tools/7zip/License.txt'
                    '../target/onex-windows/inputs/7zip/Source.txt' = 'onex-tools/7zip/Source.txt'
                }
                windows = @{
                    nsis = @{
                        installMode = 'currentUser'
                        installerHooks = '../../deploy/windows/hooks.nsh'
                    }
                }
            }
        } | ConvertTo-Json -Depth 8 -Compress
        [IO.File]::WriteAllText($configFile, $buildConfig, [Text.UTF8Encoding]::new($false))
        $env:TAURI_CONFIG = $buildConfig
        Invoke-Checked 'cargo' @('test', '--manifest-path', (Join-Path $edge 'Cargo.toml'),
            '--workspace', '--locked', '--target', $target)
        $env:TAURI_CONFIG = $null

        $buildStarted = [DateTime]::UtcNow
        Invoke-Checked 'cargo' @('tauri', 'build', '--config', $configFile, '--bundles', 'nsis',
            '--target', $target, '--ci', '--no-sign', '--', '--locked')
    } finally {
        Pop-Location
    }

    $desktopExecutable = Join-Path $releaseDir 'onex-desktop.exe'
    Assert-X64 $desktopExecutable
    $installers = @(Get-ChildItem -LiteralPath (Join-Path $releaseDir 'bundle\nsis') -Filter '*-setup.exe' -File |
        Where-Object { $_.LastWriteTimeUtc -ge $buildStarted })
    if ($installers.Count -ne 1) { throw "Expected exactly one fresh NSIS installer, got $($installers.Count)." }
    $installer = $installers[0]
    $sha256 = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$sha256  $($installer.Name)" | Set-Content -LiteralPath "$($installer.FullName).sha256" -Encoding Ascii

    $revision = Invoke-Checked 'git' @('-C', $repo, 'rev-parse', 'HEAD')
    [pscustomobject] @{
        revision = $revision
        version = $appVersion
        platform = 'windows/x64'
        installer = $installer.FullName
        desktop_update = $desktopExecutable
        bytes = $installer.Length
        sha256 = $sha256
    } | ConvertTo-Json
} finally {
    $env:CARGO_TARGET_DIR = $oldTargetDir
    $env:TAURI_CONFIG = $oldTauriConfig
    $env:ONEX_WINDOWS_DEFAULT_SERVER = $oldServer
}
