<#
.SYNOPSIS
  Marks folders as Dropbox-ignored so dependency trees (.venv, node_modules) stay on this machine
  and never sync. Creates any folder that does not exist yet. Idempotent.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\dropbox-ignore.ps1
  powershell -ExecutionPolicy Bypass -File scripts\dropbox-ignore.ps1 -Paths .venv,node_modules,out
#>
param(
    [string[]]$Paths = @('.venv', 'node_modules')
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

try {
    foreach ($p in $Paths) {
        $full = Join-Path $repoRoot $p
        if (-not (Test-Path $full)) {
            New-Item -ItemType Directory -Path $full | Out-Null
        }
        Set-Content -Path $full -Stream com.dropbox.ignored -Value 1
        Write-Output "dropbox-ignored: $p"
    }
}
catch {
    Write-Error "dropbox-ignore failed: $_"
    exit 1
}
