[CmdletBinding()]
param([Parameter(Mandatory = $true)][string] $Staging)

$ErrorActionPreference = 'Stop'
$release = 'https://github.com/ip7z/7zip/releases/download/26.06'
$installer = Join-Path $Staging '7z2606-x64.exe'
$installerHash = '9b697f65ecc2d9b0152f5ee96d72dde522a7827690349d9307935dacf40f42ec'
$files = [ordered]@{
    '7z.exe' = 'dc0493429fe28136fcb177a0e77c9875cbb3b0bff5f2f8eeba4df302e98cef76'
    '7z.dll' = '500db9eb17f3c21b729ba41dd02ecfe1823da05028c7e4ba129084cc74cc364e'
    'License.txt' = '519ac0a4bded9c18ea02e0afb71f663d8c47373bd9facd3ac96a79f51d77765d'
}

function Assert-Digest([string] $Path, [string] $Sha256) {
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Sha256) {
        throw "Unexpected 7-Zip SHA-256 for $(Split-Path -Leaf $Path)."
    }
}

if (!(Test-Path -LiteralPath $installer -PathType Leaf)) {
    $partial = "$installer.$([guid]::NewGuid().ToString('N')).part"
    try {
        Invoke-WebRequest -Uri "$release/7z2606-x64.exe" -OutFile $partial -TimeoutSec 90 -UseBasicParsing
        Assert-Digest $partial $installerHash
        Move-Item -LiteralPath $partial -Destination $installer
    } finally {
        if (Test-Path -LiteralPath $partial -PathType Leaf) { Remove-Item -LiteralPath $partial }
    }
}
Assert-Digest $installer $installerHash

# Extract the pinned installer's embedded archive using the Windows inbox tar.
$payload = Join-Path $Staging '7zip-payload.7z'
$source = [IO.File]::OpenRead($installer)
try {
    $source.Position = 45568
    $archive = [IO.File]::Create($payload)
    try { $source.CopyTo($archive) } finally { $archive.Dispose() }
} finally { $source.Dispose() }

$tools = Join-Path $Staging '7zip'
$null = New-Item -ItemType Directory -Path $tools -Force
& (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $payload -C $tools @($files.Keys)
if ($LASTEXITCODE -ne 0) { throw "Could not extract the pinned 7-Zip files (status $LASTEXITCODE)." }
foreach ($name in $files.Keys) { Assert-Digest (Join-Path $tools $name) $files[$name] }

@('OneX uses the unmodified 7-Zip 26.06 command line and DLL.';
  '7-Zip is licensed under the GNU LGPL. See License.txt for component terms.';
  'Project and source: https://www.7-zip.org/';
  "Exact release source archive: $release/7z2606-src.7z") |
    Set-Content -LiteralPath (Join-Path $tools 'Source.txt') -Encoding Ascii

Write-Host 'Verified 7-Zip 26.06 x64 extractor and license for NSIS packaging.'
