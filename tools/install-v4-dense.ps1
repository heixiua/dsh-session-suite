#!/usr/bin/env powershell
<#
.SYNOPSIS
  安装 @huggingface/transformers@4.3.2 并开启 dense 重排。
  必须在 DSH **完全退出** 的情况下运行。

.DESCRIPTION
  为什么需要这个脚本：AI 助手跑在 DSH 进程内，DSH 一退出它就没了，
  所以「退出后再装包」必须由一个不依赖 DSH 的独立脚本完成。

  脚本按顺序做：
    1. 检查 DSH 已完全退出（否则拒绝执行）
    2. 备份 profile 配置
    3. pnpm add @huggingface/transformers@4.3.2
    4. 校验包装完整
    5. 在 profile patch 里把 embedding 打开
    6. 用独立 node 进程验证 embedding 真的能跑（不依赖 DSH）
    7. 检查 allowBuilds 占位符（历史坑）
    8. 失败时自动回滚配置

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-v4-dense.ps1
  powershell -ExecutionPolicy Bypass -File install-v4-dense.ps1 -SkipEmbedding
#>
param(
  [switch]$SkipEmbedding,   # 只装包，不改配置
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ProfileDir = 'D:\AI agent cache\dsh\profiles\desktop'
$Patch      = Join-Path $ProfileDir 'cordis.patch.yml'
$ModelDir   = 'D:\AI agent cache\dsh\models\bge-base-zh-v1.5'
$Stamp      = Get-Date -Format 'yyyyMMdd-HHmmss'

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  WARN $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  FAIL $m" -ForegroundColor Red }

Step 'step 1: DSH must be fully closed'
$procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($procs.Count -gt 0) {
  Fail "DSH is still running ($($procs.Count) processes)."
  Write-Host '  Close DSH completely (not just the window), then run this again.' -ForegroundColor Yellow
  Write-Host '  Processes found:' -ForegroundColor Yellow
  $procs | Select-Object Id, ProcessName | Format-Table -AutoSize | Out-String | Write-Host
  exit 1
}
Ok 'DSH is not running'

if ($DryRun) {
  Step 'DRY RUN'
  Write-Host '  Would install @huggingface/transformers@4.3.2 and enable embedding.'
  Write-Host '  Nothing was changed.'
  exit 0
}

Step 'step 2: backup profile config'
$backup = Join-Path $ProfileDir "cordis.patch.yml.bak-v4-$Stamp"
Copy-Item -LiteralPath $Patch -Destination $backup -Force
Ok "backup: $(Split-Path -Leaf $backup)"

$rollbackNeeded = $false
try {
  Step 'step 3: remove @xenova/transformers (v2) and install v4'
  # WHY v2 MUST GO, not just be deprioritised:
  #
  # v2 depends on onnxruntime-web@1.14, which depends on onnxruntime-common@1.14.
  # With nodeLinker: hoisted, pnpm lifts that 1.14 to the TOP level. v4's
  # onnxruntime-node@1.30 requires `onnxruntime-common` at EXACTLY 1.30, and the
  # compiled binding rejects the older Tensor class — the failure is
  #   TypeError: Tensor.location must be a string
  # because 1.14's Tensor simply has no `location` field (verified on disk).
  #
  # Ordering the imports differently cannot fix this: the mismatch is in the
  # module layout, not in which package we import. Leaving v2 installed keeps the
  # bad 1.14 pinned at the top level no matter what our code prefers, so v2 is
  # removed. Nothing else in the profile depends on it (checked).
  Push-Location -LiteralPath $ProfileDir
  try {
    $rmOut = & "$env:APPDATA\npm\pnpm.cmd" remove '@xenova/transformers' 2>&1 | Out-String
    $rmCode = $LASTEXITCODE
  } finally { Pop-Location }
  ($rmOut -split "`n" | Where-Object { $_ -match 'Done|ERR|removed|dependencies' } | Select-Object -Last 4) | ForEach-Object { Write-Host ("  " + $_.Trim()) }
  if ($rmCode -ne 0) { Fail "pnpm remove failed (exit $rmCode)"; exit 1 }
  Ok 'v2 removed'

  Step 'step 3b: install @huggingface/transformers@4.3.2'
  Push-Location -LiteralPath $ProfileDir
  try {
    $out = & "$env:APPDATA\npm\pnpm.cmd" add '@huggingface/transformers@4.3.2' 2>&1 | Out-String
    $code = $LASTEXITCODE
  } finally { Pop-Location }
  ($out -split "`n" | Where-Object { $_ -match 'Done|ERR|error|added|Progress' } | Select-Object -Last 6) | ForEach-Object { Write-Host ("  " + $_.Trim()) }
  # ERR_PNPM_IGNORED_BUILDS is NOT fatal here: the win32-x64 onnxruntime binaries
  # ship inside the tarball, and the postinstall only fetches optional CUDA
  # extras. Treat it as a warning and let the inference probe below decide.
  if ($code -ne 0) {
    if ($out -match 'ERR_PNPM_IGNORED_BUILDS') {
      Warn 'pnpm reported ERR_PNPM_IGNORED_BUILDS (build scripts skipped) — continuing; the inference probe decides'
    } else {
      Fail "pnpm add failed (exit $code)"; exit 1
    }
  }
  Ok 'pnpm add completed'

  Step 'step 4: verify the package landed and the onnxruntime matrix is consistent'
  $tfPkg = Join-Path $ProfileDir 'node_modules\@huggingface\transformers\package.json'
  if (-not (Test-Path -LiteralPath $tfPkg)) { Fail 'package.json missing after install'; exit 1 }
  $ver = (Get-Content -LiteralPath $tfPkg -Raw | ConvertFrom-Json).version
  Ok "installed version: $ver"
  $tfFiles = @(Get-ChildItem -LiteralPath (Join-Path $ProfileDir 'node_modules\@huggingface\transformers') -Recurse -File -Force).Count
  Ok "package files: $tfFiles"
  if ($tfFiles -lt 100) { Fail "suspiciously few files ($tfFiles) — install may be incomplete"; exit 1 }

  # The exact bug that made the first attempt fail: 1.14 common vs 1.30 node.
  $ortVersions = @{}
  foreach ($p in @('onnxruntime-node','onnxruntime-common','onnxruntime-web')) {
    $pj = Join-Path $ProfileDir "node_modules\$p\package.json"
    if (Test-Path -LiteralPath $pj) {
      $v = (Get-Content -LiteralPath $pj -Raw | ConvertFrom-Json).version
      $ortVersions[$p] = $v
      Ok "$p $v"
    } else { Warn "$p not present at top level" }
  }
  if ($ortVersions['onnxruntime-node'] -and $ortVersions['onnxruntime-common']) {
    $nodeMajor = ($ortVersions['onnxruntime-node'] -split '\.')[0..1] -join '.'
    $commonMajor = ($ortVersions['onnxruntime-common'] -split '\.')[0..1] -join '.'
    if ($nodeMajor -ne $commonMajor) {
      Fail "onnxruntime-node ($($ortVersions['onnxruntime-node'])) and onnxruntime-common ($($ortVersions['onnxruntime-common'])) are out of sync; inference will fail with 'Tensor.location must be a string'"
      exit 1
    }
    Ok "onnxruntime node/common share major.minor $nodeMajor"
  }

  Step 'step 5: enable embedding in the profile patch'
  if ($SkipEmbedding) {
    Warn 'skipped (-SkipEmbedding)'
  } else {
    $patch = Get-Content -LiteralPath $Patch -Raw -Encoding UTF8
    # The profile must carry a config override for the session-suite row.
    if ($patch -notmatch '(?m)^- id: session-suite\s*$') {
      Fail 'profile patch has no "- id: session-suite" row to override'
      exit 1
    }
    # Replace `enabled: false` under the embedding block of that row.
    $pattern = '(?s)(- id: session-suite\s*\r?\n\s{2}config:\s*\r?\n(?:.*?\r?\n)*?\s{4}embedding:\s*\r?\n\s{6})enabled:\s*false'
    if ($patch -match $pattern) {
      $patch = [regex]::Replace($patch, $pattern, '${1}enabled: true', 1)
      [System.IO.File]::WriteAllText($Patch, $patch, [System.Text.UTF8Encoding]::new($false))
      $rollbackNeeded = $true
      Ok 'embedding.enabled -> true'
    } elseif ($patch -match '(?s)- id: session-suite\s*\r?\n\s{2}config:\s*\r?\n(?:.*?\r?\n)*?\s{4}embedding:\s*\r?\n\s{6}enabled:\s*true') {
      Ok 'embedding already enabled'
    } else {
      Fail 'could not find embedding.enabled under the session-suite row'
      exit 1
    }
    # Sanity: the file must still look like a healthy patch.
    $after = Get-Content -LiteralPath $Patch -Raw
    if ($after.Length -lt 40000) { Fail "patch shrank to $($after.Length) bytes — aborting"; exit 1 }
    Ok "patch size $($after.Length) bytes"
  }

  Step 'step 6: prove embedding works WITHOUT DSH'
  # This is the whole point of the script: verify in a bare node process that the
  # newly installed runtime can load the model and produce a vector. If this
  # fails, DSH would fail the same way later, so catch it now.
  $probe = Join-Path $env:TEMP "v4-probe-$Stamp.mjs"
  $probeCode = @"
const path = require('node:path');
"@
  $probeCode = @'
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import nodePath from 'node:path';
const profileDir = process.argv[2];
const modelDir = process.argv[3];
const require2 = createRequire(profileDir + '/');
let t;
try {
  // A bare Windows absolute path is rejected by the ESM loader (protocol 'd:'),
  // so the resolved path must be converted to a file:// URL first.
  const resolved = require2.resolve('@huggingface/transformers');
  t = await import(pathToFileURL(resolved).href);
} catch (e) {
  console.log('IMPORT_FAILED ' + String(e.message).split('\n')[0]);
  process.exit(2);
}
t.env.allowRemoteModels = false;
t.env.allowLocalModels = true;
t.env.localModelPath = nodePath.dirname(modelDir);
const id = nodePath.basename(modelDir);
let pipe;
for (const dtype of ['q8','fp32']) {
  try { pipe = await t.pipeline('feature-extraction', id, { dtype }); console.log('DTYPE ' + dtype); break; } catch (e) { console.log('DTYPE_FAIL ' + dtype + ' ' + String(e.message).split('\n')[0]); }
}
if (!pipe) { console.log('PIPELINE_FAILED'); process.exit(3); }
// ASCII-only probe text: a CJK literal inside a PowerShell here-string gets
// mangled by the console code page and turns into a SyntaxError. The model is
// multilingual, so an ASCII sentence still exercises the same code path.
const out = await pipe('the snapshot restores an earlier file state', { pooling: 'mean', normalize: true });
const dims = (out?.data ?? []).length;
console.log('DIMS ' + dims);
process.exit(dims === 768 ? 0 : 4);
'@
  [System.IO.File]::WriteAllText($probe, $probeCode, [System.Text.UTF8Encoding]::new($false))
  Push-Location -LiteralPath $ProfileDir
  try {
    $pout = & node $probe $ProfileDir $ModelDir 2>&1 | Out-String
    $pcode = $LASTEXITCODE
  } finally { Pop-Location; Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
  ($pout -split "`n" | Where-Object { $_.Trim() }) | ForEach-Object { Write-Host ("  " + $_.Trim()) }
  if ($pcode -ne 0) {
    Fail "embedding probe failed (exit $pcode) — DSH would fail the same way"
    Write-Host '  Rolling back the config change...' -ForegroundColor Yellow
    if ($rollbackNeeded) { Copy-Item -LiteralPath $backup -Destination $Patch -Force; Warn 'patch restored; package left installed (harmless)' }
    exit 1
  }
  Ok 'embedding produces a 768-dim vector without DSH'

  Step 'step 7: allowBuilds placeholder check'
  $pw = Get-Content -LiteralPath (Join-Path $ProfileDir 'pnpm-workspace.yaml') -Raw
  if ($pw -match 'set this to true or false') {
    Fail 'pnpm-workspace.yaml contains an allowBuilds placeholder — fix it or future installs break'
    exit 1
  }
  Ok 'no allowBuilds placeholder'

  Step 'DONE'
  Write-Host '  Start DSH to apply. First retrieval will load the model once (~1s).' -ForegroundColor Green
  Write-Host "  Config backup: $backup" -ForegroundColor White
  Write-Host '  To undo: run tools\rollback-v4.ps1 -Apply (DSH closed)' -ForegroundColor White
  exit 0
}
catch {
  Fail "unexpected error: $_"
  if ($rollbackNeeded) {
    Copy-Item -LiteralPath $backup -Destination $Patch -Force
    Warn 'patch restored from backup'
  }
  exit 1
}
