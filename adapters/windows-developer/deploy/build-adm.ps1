# Builds the Visma Administration back end (Source\BFS\BFS.sln, DebugAdm|x64 -> Source\Administration\x64\Debug\Adm.exe) in the current checkout.
# Run from the repository root. The private NuGet packages come from a read-only copy of the build station's package folder
# (C:\somework\nuget-cache\packages): this machine holds no package-feed credential, so nothing the model's shell can read opens that feed.
# Refresh the copy from the build station when the repository moves to other private package versions. Windows PowerShell 5.1, ASCII only.
[CmdletBinding()]
param([string]$Configuration = 'DebugAdm', [string]$Platform = 'x64')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = (Get-Location).Path
$cache = 'C:\somework\nuget-cache\packages'
if (-not (Test-Path "$repo\Source\BFS\BFS.sln")) { throw "run this from the repository root (no Source\BFS\BFS.sln in $repo)" }
if (-not (Test-Path $cache)) { throw "the package copy $cache is missing" }

$packages = "$repo\Source\BFS\packages"
if (-not (Test-Path $packages)) {
    Write-Output "seeding $packages from $cache"
    & "$env:SystemRoot\System32\robocopy.exe" $cache $packages /E /NFL /NDL /NJH /NJS /NP /MT:8 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit $LASTEXITCODE" }
}

$config = Join-Path $env:TEMP ('adm-nuget-' + [guid]::NewGuid().ToString('N') + '.config')
@"
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="local-cache" value="$cache" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3" />
  </packageSources>
</configuration>
"@ | Set-Content -LiteralPath $config -Encoding UTF8

try {
    $dotnet = 'C:\Program Files\dotnet'
    $env:DOTNET_ROOT = $dotnet
    $env:DOTNET_HOST_PATH = Join-Path $dotnet 'dotnet.exe'
    $sdk = Get-ChildItem (Join-Path $dotnet 'sdk') -Directory | Where-Object { $_.Name -like '6.0.*' } | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $sdk) { throw 'no .NET 6 SDK found' }
    $env:MSBuildSDKsPath = Join-Path $sdk.FullName 'Sdks'
    $env:Path = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0;C:\Program Files\Git\cmd;C:\AgentTools;$dotnet;$env:Path"
    & C:\AgentTools\nuget.exe restore "$repo\Source\BFS\BFS.sln" -ConfigFile $config -MSBuildPath 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin' -NonInteractive
    if ($LASTEXITCODE -ne 0) { throw "NuGet restore failed with exit $LASTEXITCODE" }
} finally {
    Remove-Item -LiteralPath $config -ErrorAction SilentlyContinue
}

& "$repo\Source\build.ps1" -Configuration $Configuration -Platform $Platform -NoRestore -LogPath "$repo\adm-build.log"
if ($LASTEXITCODE -ne 0) { throw "the build failed with exit $LASTEXITCODE (log: $repo\adm-build.log)" }
$exe = "$repo\Source\Administration\$Platform\Debug\Adm.exe"
if (-not (Test-Path $exe)) { throw "the build reported success but $exe does not exist" }
Write-Output ("built {0} ({1:N1} MB)" -f $exe, ((Get-Item $exe).Length / 1MB))
