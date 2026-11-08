#!/usr/bin/env powershell
<#
.SYNOPSIS
  一键回滚 DSH profile 到 v4 dense 改造之前的已知良好状态。

.DESCRIPTION
  做完 v4 dense 重排实验后，如果 DSH 起不来或插件异常，运行本脚本恢复：
    - profile 配置 4 件套（package.json / cordis.patch.yml / pnpm-lock.yaml / pnpm-workspace.yaml）
    - .modules.yaml
    - 我们的插件包（27 文件）
    - 记忆库（109 条 / 28 文件）

  默认只做 DRY-RUN（打印将做什么，不写任何东西）。
  真正执行需要显式加 -Apply。

.EXAMPLE
  .\rollback-v4.ps1                       # 预览
  .\rollback-v4.ps1 -Apply                # 实际回滚
  .\rollback-v4.ps1 -Apply -IncludeMemory # 连记忆库一起回滚（谨慎）
#>
param(
  [string]$BackupDir = 'D:\AI sandbox\dsh-sandbox\_dsh-rollback-20261108-095033',
  [switch]$Apply,
  [switch]$IncludeMemory
)

$ErrorActionPreference = 'Stop'
$ProfileDir = 'D:\AI agent cache\dsh\profiles\desktop'
$PlugDir    = Join-Path $ProfileDir 'node_modules\@heixui\dsh-session-suite'
$MemDir     = 'C:\Users\Administrator\.dsh\storages\dsh-session-suite\memory'

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  OK   $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  WARN $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "  FAIL $msg" -ForegroundColor Red; exit 1 }

Write-Host "ROLLBACK PLAN" -ForegroundColor White
Write-Host "  backup : $BackupDir"
Write-Host "  target : $ProfileDir"
Write-Host "  mode   : $(if ($Apply) { 'APPLY' } else { 'DRY-RUN (no writes)' })"
Write-Host "  memory : $(if ($IncludeMemory) { 'WILL be restored' } else { 'left untouched' })"

if (-not (Test-Path -LiteralPath $BackupDir)) { Die "backup dir not found: $BackupDir" }

# ---------------------------------------------------------------- preflight
Step 'preflight: backup contents'
$expect = @(
  'package.json',
  'cordis.patch.yml',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'node_modules\.modules.yaml',
  'plugin\dsh-session-suite\lib\memory-host.js',
  'plugin\dsh-session-suite\package.json'
)
foreach ($rel in $expect) {
  $p = Join-Path $BackupDir $rel
  if (Test-Path -LiteralPath $p) { Ok $rel } else { Die "missing in backup: $rel" }
}
$plugFiles = @(Get-ChildItem -LiteralPath (Join-Path $BackupDir 'plugin\dsh-session-suite') -Recurse -File -Force).Count
if ($plugFiles -lt 27) { Die "plugin backup incomplete: $plugFiles files (expected >=27)" }
Ok "plugin backup: $plugFiles files"

# DSH must be closed, or file locks reappear (the original bug).
Step 'preflight: DSH processes'
$procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($procs.Count -gt 0) {
  Warn "DSH is running ($($procs.Count) processes)."
  Warn 'Files may be locked. Close DSH completely before running with -Apply.'
  if ($Apply) { Die 'refusing to -Apply while DSH is running' }
} else {
  Ok 'DSH is not running'
}

if (-not $Apply) {
  Step 'DRY-RUN complete'
  Write-Host '  Nothing was written. Re-run with -Apply to perform the rollback.' -ForegroundColor Yellow
  exit 0
}

# ---------------------------------------------------------------- restore
Step 'restore: profile config files'
foreach ($rel in @('package.json','cordis.patch.yml','pnpm-lock.yaml','pnpm-workspace.yaml','node_modules\.modules.yaml')) {
  $src = Join-Path $BackupDir $rel
  $dst = Join-Path $ProfileDir $rel
  Copy-Item -LiteralPath $src -Destination $dst -Force
  $same = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
  if ($same) { Ok $rel } else { Die "verify failed for $rel" }
}

Step 'restore: plugin package'
$plugBak = Join-Path $BackupDir 'plugin\dsh-session-suite'
# Mirror so stray files from the experiment cannot survive.
& robocopy "$plugBak" "$PlugDir" /MIR /NFL /NDL /NJH /NJS /NC /NS | Out-Null
if ($LASTEXITCODE -gt 7) { Die "robocopy failed with exit $LASTEXITCODE" }
$n = @(Get-ChildItem -LiteralPath $PlugDir -Recurse -File -Force).Count
Ok "plugin restored: $n files"

Step 'restore: memory store'
if ($IncludeMemory) {
  $memBak = Join-Path $BackupDir 'memory'
  if (-not (Test-Path -LiteralPath $memBak)) { Die 'memory backup missing' }
  & robocopy "$memBak" "$MemDir" /MIR /NFL /NDL /NJH /NJS /NC /NS | Out-Null
  if ($LASTEXITCODE -gt 7) { Die "robocopy failed with exit $LASTEXITCODE" }
  $n = @(Get-ChildItem -LiteralPath $MemDir -Recurse -File -Force).Count
  Ok "memory restored: $n files"
} else {
  Warn 'memory store left untouched (pass -IncludeMemory to restore it)'
}

Step 'validate: JSON + YAML readable'
try {
  Get-Content -LiteralPath (Join-Path $ProfileDir 'package.json') -Raw | ConvertFrom-Json | Out-Null
  Ok 'package.json parses'
} catch { Die "package.json invalid: $_" }
$patch = Get-Content -LiteralPath (Join-Path $ProfileDir 'cordis.patch.yml') -Raw
if ($patch.Length -lt 40000) { Die "cordis.patch.yml suspiciously small: $($patch.Length)" }
Ok "cordis.patch.yml size $($patch.Length)"

Step 'validate: plugin JS syntax'
$bad = 0
Get-ChildItem -LiteralPath (Join-Path $PlugDir 'lib') -Filter '*.js' -File | ForEach-Object {
  & node --check $_.FullName 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { $bad++; Warn "syntax error: $($_.Name)" }
}
& node --check (Join-Path $PlugDir 'index.js') 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { $bad++ }
if ($bad -gt 0) { Die "$bad file(s) failed node --check" }
Ok 'all plugin JS parses'

Write-Host "`nROLLBACK COMPLETE" -ForegroundColor Green
Write-Host '  Now start DSH. Changes apply at startup (HMR is disabled).' -ForegroundColor White
exit 0
