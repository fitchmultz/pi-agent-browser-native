param(
  [Parameter(Mandatory=$true)][string]$PackageName,
  [Parameter(Mandatory=$true)][int]$NodeValidationMajor
)

$ErrorActionPreference = "Continue"
$SourceRoot = (Get-Location).Path
$RunRoot = Join-Path ".platform-smoke-runs" ("platform-build-{0}-{1}" -f ((Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")), $PID)
$PackDir = Join-Path $SourceRoot (Join-Path $RunRoot "pack")
$PiProject = Join-Path $SourceRoot (Join-Path $RunRoot "pi-project")
New-Item -ItemType Directory -Force -Path $PackDir, $PiProject | Out-Null

function Write-Section($Name, $Path) {
  Write-Output "--- $Name START ---"
  if (Test-Path $Path) { Get-Content -Raw $Path }
  Write-Output "--- $Name END ---"
}

Write-Output "Starting platform-build in $SourceRoot at $((Get-Date).ToUniversalTime().ToString('o'))"
Write-Output "PLATFORM_RUN_ROOT=$RunRoot"

$NodeVersion = (& node --version 2>$null)
$NodeMajor = 0
if ($NodeVersion -match '^v?(\d+)\.') { $NodeMajor = [int]$Matches[1] }
Write-Output "PLATFORM_NODE_VERSION=$NodeVersion"
$NodeVersionExit = if ($NodeMajor -ge $NodeValidationMajor) { 0 } else { 1 }
Write-Output "PLATFORM_NODE_VERSION_EXIT=$NodeVersionExit"

& npm ci 2>&1
$NpmCiExit = $LASTEXITCODE
Write-Output "PLATFORM_NPM_CI_EXIT=$NpmCiExit"

& npm run verify -- platform-target 2>&1
$VerifyExit = $LASTEXITCODE
Write-Output "PLATFORM_VERIFY_EXIT=$VerifyExit"

$PackStderr = Join-Path $PackDir "npm-pack.stderr.txt"
$PackOutput = (& npm pack --silent --pack-destination $PackDir 2>$PackStderr)
$PackExit = $LASTEXITCODE
$PackTarball = ($PackOutput | Select-Object -Last 1)
$PackFile = if ($PackTarball) { Join-Path $PackDir $PackTarball } else { "" }
if (Test-Path $PackStderr) { Get-Content -Raw $PackStderr }
Write-Output "PLATFORM_NPM_PACK_EXIT=$PackExit"
Write-Output "PLATFORM_PACKED_TARBALL=$PackFile"

$PiCli = Join-Path $SourceRoot "node_modules/.bin/pi.cmd"
if (-not (Test-Path $PiCli)) { $PiCli = Join-Path $SourceRoot "node_modules/.bin/pi" }
if (-not (Test-Path $PiCli)) { $PiCli = "pi" }
Write-Output "PLATFORM_PI_CLI=$PiCli"

$PackedNodeInstallStdout = Join-Path $PackDir "packed-node-install.stdout.txt"
$PackedNodeInstallStderr = Join-Path $PackDir "packed-node-install.stderr.txt"
if ($PackFile -and (Test-Path $PackFile)) {
  Push-Location $PiProject
  & npm init -y >$PackedNodeInstallStdout 2>$PackedNodeInstallStderr
  if ($LASTEXITCODE -eq 0) {
    & npm install --no-save $PackFile >>$PackedNodeInstallStdout 2>>$PackedNodeInstallStderr
  }
  $PackedNodeInstallExit = $LASTEXITCODE
  Pop-Location
} else {
  "missing tarball" | Set-Content $PackedNodeInstallStderr
  $PackedNodeInstallExit = 1
}
Write-Output "PLATFORM_PACKED_NODE_INSTALL_EXIT=$PackedNodeInstallExit"
Write-Section "PACKED_NODE_INSTALL_STDOUT" $PackedNodeInstallStdout
Write-Section "PACKED_NODE_INSTALL_STDERR" $PackedNodeInstallStderr

$PiInstallStdout = Join-Path $PackDir "pi-install.stdout.txt"
$PiInstallStderr = Join-Path $PackDir "pi-install.stderr.txt"
if ($PackedNodeInstallExit -eq 0) {
  Push-Location $PiProject
  $env:PI_OFFLINE = "1"
  & $PiCli install -l ".\node_modules\$PackageName" >$PiInstallStdout 2>$PiInstallStderr
  $PiInstallExit = $LASTEXITCODE
  Remove-Item Env:\PI_OFFLINE -ErrorAction SilentlyContinue
  Pop-Location
} else {
  "packed npm install failed" | Set-Content $PiInstallStderr
  $PiInstallExit = 1
}
Write-Output "PLATFORM_PI_INSTALL_EXIT=$PiInstallExit"
Write-Section "PI_INSTALL_STDOUT" $PiInstallStdout
Write-Section "PI_INSTALL_STDERR" $PiInstallStderr

$PiListStdout = Join-Path $PackDir "pi-list.stdout.txt"
$PiListStderr = Join-Path $PackDir "pi-list.stderr.txt"
Push-Location $PiProject
$env:PI_OFFLINE = "1"
& $PiCli list >$PiListStdout 2>$PiListStderr
$PiListExit = $LASTEXITCODE
Remove-Item Env:\PI_OFFLINE -ErrorAction SilentlyContinue
Pop-Location
Write-Output "PLATFORM_PI_LIST_EXIT=$PiListExit"
Write-Section "PI_LIST_STDOUT" $PiListStdout
Write-Section "PI_LIST_STDERR" $PiListStderr

if ($NodeVersionExit -ne 0 -or $NpmCiExit -ne 0 -or $VerifyExit -ne 0 -or $PackExit -ne 0 -or $PackedNodeInstallExit -ne 0 -or $PiInstallExit -ne 0 -or $PiListExit -ne 0) {
  Write-Output "PLATFORM_BUILD_FAILED"
  exit 1
}

Write-Output "PLATFORM_BUILD_OK"
