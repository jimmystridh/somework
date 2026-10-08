# The QA machine's master database lists 238 companies but only the 29 with a shard number can be opened: the back end answers 428 "Tenant not set up" for the others,
# and an agent that picks one by the ticket's area then reports `blocked`. This hides the others from the company picker (status 0 = not active, which the back end
# filters out) and remembers their old status, so -Restore puts everything back. Idempotent. Run as SYSTEM (the SQL instance knows SYSTEM as sysadmin).
#   hide-unusable-companies.ps1            hide
#   hide-unusable-companies.ps1 -Restore   show them again
[CmdletBinding()]
param([switch]$Restore)
$ErrorActionPreference = 'Stop'
function Invoke-Sql([string]$Sql) {
    $out = & sqlcmd.exe -S 'lpc:(local)\VISMA' -E -C -d Adm_Master -b -W -h -1 -Q $Sql 2>&1
    if ($LASTEXITCODE -ne 0) { throw "sqlcmd failed: $out" }
    return $out
}
Invoke-Sql "IF OBJECT_ID('dbo.QA_TENANT_STATUS_BACKUP') IS NULL CREATE TABLE dbo.QA_TENANT_STATUS_BACKUP (Id uniqueidentifier NOT NULL PRIMARY KEY, Status smallint NOT NULL)" | Out-Null
if ($Restore) {
    Invoke-Sql "UPDATE t SET t.Status = b.Status FROM dbo.TENANT t JOIN dbo.QA_TENANT_STATUS_BACKUP b ON b.Id = t.Id; DELETE FROM dbo.QA_TENANT_STATUS_BACKUP" | Out-Null
    'restored'
} else {
    Invoke-Sql "SET NOCOUNT ON; INSERT INTO dbo.QA_TENANT_STATUS_BACKUP (Id, Status) SELECT Id, Status FROM dbo.TENANT WHERE TenantNum IS NULL AND Status > 0 AND Id NOT IN (SELECT Id FROM dbo.QA_TENANT_STATUS_BACKUP); UPDATE dbo.TENANT SET Status = 0 WHERE TenantNum IS NULL AND Status > 0" | Out-Null
}
$left = (Invoke-Sql "SET NOCOUNT ON; SELECT COUNT(*) FROM dbo.TENANT WHERE Status > 0") | Where-Object { $_ -match '^\s*\d+\s*$' } | Select-Object -First 1
"companies offered now: $($left.Trim())"
