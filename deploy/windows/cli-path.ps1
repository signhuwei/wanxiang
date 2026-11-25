[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [ValidateSet('Install', 'Uninstall')] [string] $Action,
    [Parameter(Mandatory = $true)] [string] $InstallDir
)

$ErrorActionPreference = 'Stop'
$installPath = [IO.Path]::GetFullPath($InstallDir).TrimEnd([char[]]'\/')
$installing = $Action -eq 'Install'
$ownershipKey = 'Software\OneX\Edge'
$currentUser = [Microsoft.Win32.Registry]::CurrentUser
$owner = $currentUser.OpenSubKey($ownershipKey, $true)
$environment = $null

try {
    $ownedPath = if ($owner) { [string] $owner.GetValue('CliPath', '') } else { '' }
    if (-not $installing -and $ownedPath -ine $installPath) { return }
    if ($installing) {
        if ($installPath.IndexOfAny([char[]]'%;') -ge 0) { throw 'OneX CLI directory contains a PATH delimiter or expansion character.' }
        $executable = Join-Path $installPath 'onex.exe'
        if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Installed onex.exe could not be found.' }
        $existing = Get-Command onex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        $oldExecutable = if ($ownedPath) { Join-Path $ownedPath 'onex.exe' } else { '' }
        if ($existing -and $existing.Source -ine $executable -and $existing.Source -ine $oldExecutable) {
            throw ('An existing onex command takes precedence: ' + $existing.Source)
        }
    }

    $environment = if ($installing) { $currentUser.CreateSubKey('Environment') } else { $currentUser.OpenSubKey('Environment', $true) }
    if (-not $environment) { $owner.DeleteValue('CliPath', $false); return }
    $hasPath = $environment.GetValueNames() -contains 'Path'
    $kind = if ($hasPath) { $environment.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
    if ($kind -notin @([Microsoft.Win32.RegistryValueKind]::String, [Microsoft.Win32.RegistryValueKind]::ExpandString)) {
        throw 'The user PATH registry type is unsupported.'
    }
    $originalPath = [string] $environment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $entries = [Collections.Generic.List[string]]::new()
    if ($originalPath) { $entries.AddRange($originalPath.Split(';')) }
    $ownedIndex = if ($ownedPath) { $entries.LastIndexOf($ownedPath) } else { -1 }
    $ownsEntry = $ownedIndex -ge 0 -and $ownedPath -ieq $installPath
    $registeredPath = if ($ownsEntry) { $ownedPath } else { '' }

    if ($ownedIndex -ge 0 -and (-not $installing -or -not $ownsEntry)) {
        $entries.RemoveAt($ownedIndex)
    }
    if ($installing -and -not $ownsEntry) {
        $found = $false
        foreach ($entry in $entries) {
            $directory = $entry.Trim().Trim('"')
            if ($kind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) {
                $directory = [Environment]::ExpandEnvironmentVariables($directory)
            }
            if ($directory.TrimEnd([char[]]'\/') -ieq $installPath) { $found = $true; break }
        }
        if (-not $found) {
            $entries.Add($installPath)
            $registeredPath = $installPath
        }
    }

    $nextPath = $entries -join ';'
    if ($installing -and $registeredPath) {
        if ($nextPath.Length -gt 32766) { throw 'The user PATH is too long to add OneX.' }
        if (-not $owner) { $owner = $currentUser.CreateSubKey($ownershipKey) }
        $owner.SetValue('CliPath', $registeredPath, [Microsoft.Win32.RegistryValueKind]::String)
        try {
            if ($nextPath -cne $originalPath) { $environment.SetValue('Path', $nextPath, $kind) }
        } catch {
            if ($ownedPath) { $owner.SetValue('CliPath', $ownedPath, [Microsoft.Win32.RegistryValueKind]::String) }
            else { $owner.DeleteValue('CliPath', $false) }
            throw
        }
    } else {
        if ($nextPath -cne $originalPath) { $environment.SetValue('Path', $nextPath, $kind) }
        if ($owner) { $owner.DeleteValue('CliPath', $false) }
    }
} finally {
    if ($environment) { $environment.Dispose() }
    if ($owner) { $owner.Dispose() }
}
