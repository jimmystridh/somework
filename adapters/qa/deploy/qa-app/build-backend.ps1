# Builds the back end (Adm.exe /server) of the checkout the QA job tests, so that the application under test is the one the ticket's change belongs to,
# and makes the next start-app.ps1 run it. Runs as the QA agent's own account (no privileges) in the job's start sequence, in the foreground.
#   build-backend.ps1 -Checkout <job workspace root, a git checkout of the revision under test>
# A persistent source tree (backends\_src) is moved from revision to revision with a local fetch from the checkout (no git credential needed), so the
# compiler only rebuilds what changed; the output of each revision is kept in backends\<12 characters of the SHA> (the newest few stay). Windows PowerShell 5.1, ASCII only.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Checkout,
    [string]$Backends = 'C:\somework\qa-backends',
    [string]$Control = 'C:\somework\qa-app\control',
    [int]$Keep = 3
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$git = 'C:\Program Files\Git\cmd\git.exe'
# only database backups are in git LFS (the build needs none, and this account has no credential to download them): check out their pointer files
$env:GIT_LFS_SKIP_SMUDGE = '1'
# git reports progress on stderr, which Windows PowerShell 5.1 turns into a terminating error under 'Stop': read both streams and go by the exit code
function Git {
    param([string]$Dir)
    $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $output = & $git -c safe.directory='*' -C $Dir @args 2>&1 } finally { $ErrorActionPreference = $previous }
    $output | ForEach-Object { Write-Host "$_" }
    if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed with exit $LASTEXITCODE" }
}

$sha = (& $git -c safe.directory='*' -C $Checkout rev-parse HEAD).Trim()
if ($sha -notmatch '^[0-9a-f]{40}$') { throw "$Checkout is not a git checkout (HEAD is '$sha')" }
$short = $sha.Substring(0, 12)
$out = Join-Path $Backends $short
$src = Join-Path $Backends '_src'
$baseDir = (Get-Content 'C:\somework\qa-app\server-dir.txt' -TotalCount 1).Trim()
New-Item -ItemType Directory -Force $Backends | Out-Null

function Publish([string]$Dir) {
    Set-Content (Join-Path $Control 'backend-dir.txt') $Dir
    Set-Content (Join-Path $Control 'backend-sha.txt') "$sha (back end built from this checkout)"
    Write-Host "back end $short ready in $Dir"
}

if (Test-Path (Join-Path $out '.complete')) {
    (Get-Item $out).LastWriteTime = Get-Date
    Write-Host "back end $short was built before"
    Publish $out
    exit 0
}

$started = Get-Date
if (-not (Test-Path (Join-Path $src '.git'))) {
    Write-Host "first build: cloning the checkout into $src"
    Git $Backends clone --no-checkout $Checkout $src
    if (Test-Path (Join-Path $src '.git\objects\info\alternates')) {
        Git $src repack -a -d
        Remove-Item (Join-Path $src '.git\objects\info\alternates') -Force
    }
}
Write-Host "moving the source tree to $short"
Git $src fetch --no-tags $Checkout $sha
Git $src checkout --force --detach $sha

Push-Location $src
try { & "$PSScriptRoot\build-adm.ps1" } finally { Pop-Location }
$debug = Join-Path $src 'Source\Administration\x64\Debug'
if (-not (Test-Path (Join-Path $debug 'Adm.exe'))) { throw "the build left no Adm.exe in $debug" }

$partial = "$out.partial"
if (Test-Path $partial) { Remove-Item $partial -Recurse -Force }
& robocopy.exe $debug $partial /E /NFL /NDL /NJH /NJS /NP /MT:4 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy of the build failed with exit $LASTEXITCODE" }
# what the running back end needs and the compiler does not make (its config.json, runtime files): from the directory the stack used before, only where missing
# the newest complete build is the source (this account can read it); the directory in server-dir.txt is only for the first build, and may be unreadable for this account
$previous = Get-ChildItem $Backends -Directory | Where-Object { $_.Name -match '^[0-9a-f]{12}$' -and (Test-Path (Join-Path $_.FullName '.complete')) } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$baseFiles = if ($previous) { $previous.FullName } else { $baseDir }
& robocopy.exe $baseFiles $partial /E /XC /XN /XO /NFL /NDL /NJH /NJS /NP /MT:4 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy of the base files from $baseFiles failed with exit $LASTEXITCODE" }
if (-not (Test-Path (Join-Path $partial 'config.json'))) { throw "no config.json in $baseFiles to run the back end with" }
Set-Content (Join-Path $partial '.complete') $sha
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
Move-Item $partial $out
Write-Host ("built {0} in {1:N0} minutes" -f $short, ((Get-Date) - $started).TotalMinutes)

# the newest builds stay, the rest go (each is about 2.3 GB)
Get-ChildItem $Backends -Directory | Where-Object { $_.Name -match '^[0-9a-f]{12}$' } | Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep |
    ForEach-Object { if ($_.FullName -ne $out) { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue } }
Publish $out
exit 0
