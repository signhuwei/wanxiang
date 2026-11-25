$ErrorActionPreference = 'Stop'

$artifact = $env:ONEX_DESKTOP_UPDATE_ARTIFACT
$desktop = $env:ONEX_DESKTOP_UPDATE_EXE
$desktopId = [int]$env:ONEX_DESKTOP_UPDATE_PID
Remove-Item Env:ONEX_DESKTOP_UPDATE_ARTIFACT, Env:ONEX_DESKTOP_UPDATE_EXE, Env:ONEX_DESKTOP_UPDATE_PID
$installDir = [IO.Path]::GetDirectoryName($desktop)
$fileSuffix = [Guid]::NewGuid().ToString('N')
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
