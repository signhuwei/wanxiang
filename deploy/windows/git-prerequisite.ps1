Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-GitExecutable {
    $pathGit = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($pathGit -and [IO.Path]::IsPathRooted($pathGit.Source)) { $pathGit.Source }

    # Probe both registry views even when the NSIS child uses 32-bit PowerShell.
    foreach ($hive in @('CurrentUser', 'LocalMachine')) {
        foreach ($view in @('Registry64', 'Registry32')) {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
                [Microsoft.Win32.RegistryHive]$hive, [Microsoft.Win32.RegistryView]$view
            )
            try {
                $key = $base.OpenSubKey('Software\GitForWindows')
                if ($null -eq $key) { continue }
                try {
                    $path = $key.GetValue('InstallPath')
                    if ($path -is [string] -and [IO.Path]::IsPathRooted($path)) {
                        Join-Path $path 'cmd\git.exe'
                    }
                } finally { $key.Dispose() }
            } finally { $base.Dispose() }
        }
    }
}

function Test-Git {
    foreach ($candidate in @(Get-GitExecutable | Select-Object -Unique)) {
        if (!(Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        try {
            $version = & $candidate --version 2>$null
            if ($LASTEXITCODE -eq 0 -and $version -match '^git version \d') {
                Write-Host "Git is ready ($version)."
                return $true
            }
        } catch {
            # A stale path or non-working Git executable is not a prerequisite match.
            continue
        }
    }
    return $false
}

function Install-Git {
    $winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
    if (Test-Path -LiteralPath $winget -PathType Leaf) {
        & $winget install --id Git.Git --exact --source winget --scope user --architecture x64 --silent `
            --accept-source-agreements --accept-package-agreements --disable-interactivity --no-upgrade
        if ($LASTEXITCODE -ne 0) { throw "WinGet Git.Git installation failed (exit $LASTEXITCODE)." }
        return
    }

    # Pin the official x64 binary to the Git.Git installer manifest for version 2.56.1.
    $url = 'https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/Git-2.56.1-64-bit.exe'
    $sha256 = 'C330C72E10B408CC39994BFEFDB63542B0D93D21699325C3E0BD874AF8A5A559'
    $installer = Join-Path $PSScriptRoot 'onex-git-for-windows.exe'
    try {
        Write-Host 'WinGet is unavailable. Downloading the verified Git for Windows installer.'
        Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing -TimeoutSec 300
        if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $sha256) {
            throw 'The Git for Windows installer SHA-256 did not match the WinGet manifest.'
        }
        $install = Start-Process -FilePath $installer -ArgumentList @(
            '/SP-', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/o:PathOption=Cmd'
        ) -PassThru -Wait
        if ($install.ExitCode -ne 0) { throw "Git for Windows installation failed (exit $($install.ExitCode))." }
    } finally { Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue }
}

try {
    if (Test-Git) { exit 0 }
    Write-Host 'Git is missing. Installing Git for Windows.'
    Install-Git
    if (!(Test-Git)) { throw 'Git for Windows setup finished, but git --version is unavailable.' }
    exit 0
} catch {
    Write-Host $_.Exception.Message
    exit 1
}
