$ErrorActionPreference = 'Stop'

$mode = $env:ONEX_DESKTOP_UPDATE_MODE
$artifact = $env:ONEX_DESKTOP_UPDATE_ARTIFACT
$desktop = $env:ONEX_DESKTOP_UPDATE_EXE
$desktopId = [int]$env:ONEX_DESKTOP_UPDATE_PID
$nextCli = $env:ONEX_DESKTOP_UPDATE_CLI
$nextDaemon = $env:ONEX_DESKTOP_UPDATE_DAEMON
$version = $env:ONEX_DESKTOP_UPDATE_VERSION
Remove-Item Env:ONEX_DESKTOP_UPDATE_MODE, Env:ONEX_DESKTOP_UPDATE_ARTIFACT, Env:ONEX_DESKTOP_UPDATE_EXE,
    Env:ONEX_DESKTOP_UPDATE_PID, Env:ONEX_DESKTOP_UPDATE_CLI, Env:ONEX_DESKTOP_UPDATE_DAEMON,
    Env:ONEX_DESKTOP_UPDATE_VERSION -ErrorAction SilentlyContinue
$installDir = [IO.Path]::GetDirectoryName($desktop)
$fileSuffix = [Guid]::NewGuid().ToString('N')

function Find-Daemon($path) {
    Get-Process -Name 'onexd' -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $path }
}

function Invoke-UpdateCli($program, $arguments) {
    $start = [Diagnostics.ProcessStartInfo]::new($program, $arguments)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $process = [Diagnostics.Process]::Start($start)
    try {
        $output = $process.StandardOutput.ReadToEndAsync()
        if (-not $process.WaitForExit(6500)) {
            # Only terminate the temporary CLI executing this read or update request.
            if (-not $process.HasExited) { $process.Kill() }
            throw 'OneX command did not answer in time.'
        }
        [pscustomobject]@{ Code = $process.ExitCode; Output = $output.GetAwaiter().GetResult().Trim() }
    } finally {
        $process.Dispose()
    }
}

function Get-DaemonStatus($cli) {
    try {
        $reply = Invoke-UpdateCli $cli 'status'
        if ($reply.Code -eq 0) {
            $status = $reply.Output | ConvertFrom-Json
            if ($status.ok -eq $true) { return $status }
        }
    } catch {
        return $null
    }
}

function Start-Daemon($path) {
    Start-Process -FilePath $path -WorkingDirectory $installDir -WindowStyle Hidden -PassThru
}

function Restore-Sidecar($backup, $path) {
    if ([IO.File]::Exists($backup)) {
        if ([IO.File]::Exists($path)) {
            [IO.File]::Replace($backup, $path, [NullString]::Value)
        } else {
            [IO.File]::Move($backup, $path)
        }
    }
}

function Update-Sidecars {
    $cli = Join-Path $installDir 'onex.exe'
    $daemon = Join-Path $installDir 'onexd.exe'
    $cliStage = Join-Path $installDir ('.onex-cli-update-' + $fileSuffix + '.exe')
    $daemonStage = Join-Path $installDir ('.onex-daemon-update-' + $fileSuffix + '.exe')
    $cliBackup = Join-Path $installDir ('.onex-cli-backup-' + $fileSuffix + '.exe')
    $daemonBackup = Join-Path $installDir ('.onex-daemon-backup-' + $fileSuffix + '.exe')
    $lockPath = Join-Path $installDir '.onex-engine-update.lock'
    try {
        $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch [IO.IOException] {
        return 3
    } catch {
        return 1
    }
    $updateStarted = $false
    $swapping = $false
    $newDaemon = $null
    try {
        $old = @(Find-Daemon $daemon)
        if ($old.Count -gt 1) { return 3 }
        $oldStatus = Get-DaemonStatus $cli
        if ($old.Count -eq 0 -and $oldStatus) { return 3 }
        if ($old.Count -eq 1 -and -not $oldStatus) { return 3 }

        $candidate = Invoke-UpdateCli $nextCli '--version'
        if ($candidate.Code -ne 0 -or $candidate.Output -cne "onex $version") {
            throw 'The staged CLI version does not match the update.'
        }
        $cliChanged = (Get-FileHash -LiteralPath $cli).Hash -cne (Get-FileHash -LiteralPath $nextCli).Hash
        $daemonChanged = (Get-FileHash -LiteralPath $daemon).Hash -cne (Get-FileHash -LiteralPath $nextDaemon).Hash
        if (-not $cliChanged -and -not $daemonChanged -and $oldStatus.version -ceq $version) { return 0 }
        if ($cliChanged) { [IO.File]::Copy($nextCli, $cliStage) }
        if ($daemonChanged) { [IO.File]::Copy($nextDaemon, $daemonStage) }

        $updateStarted = $true
        if ($old.Count -eq 1) {
            $reply = Invoke-UpdateCli $cli "shutdown-when-idle $($old[0].Id)"
            if ($reply.Code -eq 3) { return 3 }
            if ($reply.Code -ne 0) { throw 'The installed daemon did not authorize switching.' }
            if (-not $old[0].WaitForExit(15000)) { throw 'The installed daemon has not finished draining.' }
        }
        if (Find-Daemon $daemon) { throw 'An installed daemon is still running.' }
        $swapping = $true
        if ($cliChanged) { [IO.File]::Replace($cliStage, $cli, $cliBackup) }
        if ($daemonChanged) { [IO.File]::Replace($daemonStage, $daemon, $daemonBackup) }
        $swapping = $false

        $newDaemon = Start-Daemon $daemon
        $expires = [DateTime]::UtcNow.AddSeconds(15)
        while (-not $newDaemon.HasExited -and [DateTime]::UtcNow -lt $expires) {
            $status = Get-DaemonStatus $cli
            if ($status.version -ceq $version -and
                (-not $oldStatus.logged_in -or ($status.logged_in -and $status.device_id -ceq $oldStatus.device_id))) {
                Remove-Item -LiteralPath $cliBackup, $daemonBackup -Force -ErrorAction SilentlyContinue
                return 0
            }
            Start-Sleep -Milliseconds 250
        }
        throw 'The new daemon did not restore its version and device identity.'
    } catch {
        $failure = $_.Exception.GetBaseException()
        $retry = $swapping -and (($failure.HResult -band 0xffff) -in @(32, 33))
        if ($updateStarted) {
            try {
                if ($newDaemon -and -not $newDaemon.HasExited) {
                    $reply = Invoke-UpdateCli $cli "shutdown-when-idle $($newDaemon.Id)"
                    if ($reply.Code -ne 0 -or -not $newDaemon.WaitForExit(15000)) { return 1 }
                }
                if (-not (Find-Daemon $daemon) -and -not (Get-DaemonStatus $cli)) {
                    try {
                        Restore-Sidecar $daemonBackup $daemon
                        Restore-Sidecar $cliBackup $cli
                    } finally {
                        $null = Start-Daemon $daemon
                    }
                }
            } catch {
                # Preserve any backup that could not be restored.
                return 1
            }
        }
        if ($retry) { return 3 }
        return 1
    } finally {
        Remove-Item -LiteralPath $cliStage, $daemonStage -Force -ErrorAction SilentlyContinue
        $lock.Dispose()
    }
}

if ($mode -eq 'sidecars') { exit (Update-Sidecars) }
if ($mode -and $mode -ne 'desktop') { exit 1 }

$staged = Join-Path $installDir ('.onex-update-' + $fileSuffix + '.exe')
$backup = Join-Path $installDir ('.onex-backup-' + $fileSuffix + '.exe')

function Find-Desktop {
    Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($desktop)) -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -ieq $desktop }
}

try {
    $previous = Get-Process -Id $desktopId -ErrorAction SilentlyContinue
    if ($previous -and $previous.Path -ieq $desktop -and -not $previous.WaitForExit(15000)) {
        throw 'The previous Desktop process did not exit.'
    }
    if (Find-Desktop) { throw 'A separate Desktop process is still running.' }

    # Keep all three files in the same directory so Replace can operate atomically.
    [IO.File]::Copy($artifact, $staged)
    [IO.File]::Replace($staged, $desktop, $backup)
    $updated = Start-Process -FilePath $desktop -WorkingDirectory $installDir -PassThru
    if ($updated.WaitForExit(3000)) { throw 'The updated Desktop stopped during startup.' }
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
} catch {
    if ([IO.File]::Exists($backup) -and -not (Find-Desktop)) {
        try {
            if ([IO.File]::Exists($desktop)) {
                [IO.File]::Replace($backup, $desktop, [NullString]::Value)
            } else {
                [IO.File]::Move($backup, $desktop)
            }
        } catch {
            # The backup is retained if it cannot be restored.
        }
    }
    if ([IO.File]::Exists($desktop) -and -not (Find-Desktop)) {
        Start-Process -FilePath $desktop -WorkingDirectory $installDir -ErrorAction SilentlyContinue
    }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][Windows.Forms.MessageBox]::Show('OneX Desktop could not finish updating.', 'OneX Desktop')
    } catch {
    }
} finally {
    Remove-Item -LiteralPath $staged, $artifact -Force -ErrorAction SilentlyContinue
    $tempDir = [IO.Path]::GetDirectoryName($artifact)
    try {
        [IO.Directory]::Delete($tempDir)
    } catch {
        # Only remove empty staging directories.
    }
}
