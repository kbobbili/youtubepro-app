# Hourly SportsCenter run. Registered with Windows Task Scheduler by scripts/register-task.ps1.
# Overlap is prevented by the engine's lock file.
#
# Failure isolation is per collection, not all-or-nothing:
# - Each sport's discovery runs independently; a failed or incomplete run is logged and the chain continues.
#   The catalog marks that sport's collections incomplete, and the publisher keeps their last-known-good
#   playlists while still updating healthy collections.
# - Snapshot and catalog read stored state, so they always run.
# - Steps marked `gate` must succeed for later steps to run: a catalog that fails to build blocks publishing.
# - The NFL all-teams diagnostic is measurement only and always runs last.
# The script exits with the first non-zero code (diagnostic excluded) so Task Scheduler records the failure.
#
# Scripted dry check (no engine calls):
#   ./scripts/run-hourly.ps1 -Simulate -SimulateFail discover-nfl -LogDir $env:TEMP\sc-check
param(
  [switch]$Simulate,
  [string[]]$SimulateFail = @(),
  [string]$LogDir
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $LogDir) { $LogDir = Join-Path $root 'data\logs' }
New-Item -ItemType Directory -Force $LogDir | Out-Null
$log = Join-Path $LogDir ((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd') + '.log')
$tsx = Join-Path $root 'node_modules\tsx\dist\cli.mjs'
$cli = Join-Path $root 'engine\src\cli.ts'
# Node writes UTF-8; decode it as UTF-8 so symbols such as "·" and "→" are not garbled in the log.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Log([string]$text) { Add-Content -Path $log -Value $text -Encoding utf8 }

function Invoke-Step([string]$name, [string[]]$engineArgs) {
  Write-Log "`n=== $((Get-Date).ToUniversalTime().ToString('o')) :: [$name] $($engineArgs -join ' ')"
  if ($Simulate) {
    $code = if ($SimulateFail -contains $name) { 3 } else { 0 }
    Write-Log "(simulated)"
  } else {
    $ErrorActionPreference = 'Continue' # stderr from node is captured, not fatal
    $output = & node $tsx $cli @engineArgs 2>&1 | Out-String
    $code = $LASTEXITCODE
    Write-Log $output
  }
  Write-Log "exit=$code"
  return $code
}

# Personal chain, in order. One discover step per sport.
$personal = @(
  @{ name = 'discover-nfl'; args = @('discover', 'nfl', '--days', '7', '--kind', 'prospective') },
  @{ name = 'discover-f1'; args = @('discover', 'f1', '--days', '7', '--kind', 'prospective') },
  @{ name = 'discover-soccer'; args = @('discover', 'soccer', '--days', '7', '--kind', 'prospective') },
  @{ name = 'discover-tennis'; args = @('discover', 'tennis', '--days', '7', '--kind', 'prospective') },
  @{ name = 'discover-cricket'; args = @('discover', 'cricket', '--days', '7', '--kind', 'prospective') },
  @{ name = 'snapshot'; args = @('snapshot') },
  # Catalog revalidates retained videos (YouTube API key); incomplete collections are recorded inside it.
  @{ name = 'catalog'; args = @('catalog'); gate = $true }
  # sync-playlists --apply is added after the catalog only after an inspected dry run, manual apply, the Onn
  # device gate, and a zero-change second apply (docs/08-validation-plan.md).
)
$diagnostic = @{ name = 'diagnostic'; args = @('discover', 'nfl', '--days', '7', '--kind', 'prospective', '--all-teams') }

Set-Location $root
$exitCode = 0
$failed = @()
foreach ($step in $personal) {
  $code = Invoke-Step $step.name $step.args
  if ($code -eq 0) { continue }
  $failed += "$($step.name)=$code"
  if ($exitCode -eq 0) { $exitCode = $code }
  if ($step.gate) {
    $skipped = @($personal | Select-Object -Skip ([array]::IndexOf($personal, $step) + 1) | ForEach-Object { $_.name })
    Write-Log "GATE FAILED: [$($step.name)] exit=$code; skipped: $(if ($skipped.Count) { $skipped -join ', ' } else { 'none' }). Published output is left as last-known-good."
    break
  }
}

$code = Invoke-Step $diagnostic.name $diagnostic.args
if ($code -ne 0) { Write-Log "Diagnostic run exit=$code (measurement only; does not affect the exit code)." }
if ($failed.Count) { Write-Log "CHAIN DONE WITH FAILURES: $($failed -join ', ')" } else { Write-Log "CHAIN OK" }
exit $exitCode
