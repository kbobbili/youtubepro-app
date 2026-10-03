# Hourly SportsCenter run. Registered with Windows Task Scheduler by scripts/register-task.ps1.
# Overlap is prevented by the engine's lock file.
#
# Fail-closed chain: the personal pipeline runs in order and stops at the first step that exits non-zero
# (discover exits 2 = failed, 3 = incomplete). Later steps never run on incomplete input, and the script
# exits non-zero so Task Scheduler records the failure. This is all-or-nothing across personal sports:
# one incomplete sport blocks every downstream step (an accepted temporary limitation, not per-sport refresh).
# The NFL all-teams diagnostic is measurement only: it runs after the personal chain succeeds and its
# failure is logged but never changes the exit code.
#
# Scripted dry check (no engine calls):
#   ./scripts/run-hourly.ps1 -Simulate -SimulateFail discover -LogDir $env:TEMP\sc-check
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

# Personal chain, in dependency order. Downstream steps run only when every upstream step succeeded.
$personal = @(
  @{ name = 'discover'; args = @('discover', 'nfl', '--days', '7', '--kind', 'prospective') },
  @{ name = 'snapshot'; args = @('snapshot') },
  # Catalog revalidates retained videos (YouTube API key) and exits 3 if any collection is incomplete.
  @{ name = 'catalog'; args = @('catalog') }
  # sync-playlists --apply is added only after an inspected dry run, manual apply, the Onn device gate,
  # and a zero-change second apply (docs/08-validation-plan.md).
)
$diagnostic = @{ name = 'diagnostic'; args = @('discover', 'nfl', '--days', '7', '--kind', 'prospective', '--all-teams') }

Set-Location $root
foreach ($step in $personal) {
  $code = Invoke-Step $step.name $step.args
  if ($code -ne 0) {
    $skipped = @($personal | Select-Object -Skip ([array]::IndexOf($personal, $step) + 1) | ForEach-Object { $_.name }) + @('diagnostic')
    Write-Log "CHAIN STOPPED: [$($step.name)] exit=$code; skipped: $($skipped -join ', '). Published/exported output is left as last-known-good (stale)."
    exit $code
  }
}

$code = Invoke-Step $diagnostic.name $diagnostic.args
if ($code -ne 0) { Write-Log "Diagnostic run exit=$code (measurement only; does not affect the personal chain)." }
Write-Log "CHAIN OK"
exit 0
