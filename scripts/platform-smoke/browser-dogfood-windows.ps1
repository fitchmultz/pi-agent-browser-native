param(
  [Parameter(Mandatory=$true)][string]$AgentBrowserVersion
)

$ErrorActionPreference = "Continue"
$SourceRoot = (Get-Location).Path
$RunRoot = Join-Path ".platform-smoke-runs" ("browser-dogfood-{0}-{1}" -f ((Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")), $PID)
$DogfoodDir = Join-Path $SourceRoot (Join-Path $RunRoot "dogfood")
$DogfoodArtifactDir = Join-Path $env:TEMP ("pi-agent-browser-dogfood-artifacts-{0}" -f $PID)
New-Item -ItemType Directory -Force -Path $DogfoodDir | Out-Null
New-Item -ItemType Directory -Force -Path $DogfoodArtifactDir | Out-Null

function Write-Section($Name, $Path) {
  Write-Output "--- $Name START ---"
  if (Test-Path $Path) { Get-Content -Raw $Path }
  Write-Output "--- $Name END ---"
}

function Get-AgentBrowserVersion() {
  if (-not (Get-Command agent-browser -ErrorAction SilentlyContinue)) { return "" }
  return (& agent-browser --version 2>$null)
}

function Test-AgentBrowser($Version) {
  $Expected = "agent-browser $Version"
  $Current = Get-AgentBrowserVersion
  Write-Output "PLATFORM_AGENT_BROWSER_VERSION=$Current"
  $script:AgentBrowserReadyExit = if ($Current -eq $Expected) { 0 } else { 1 }
}

function Test-AgentBrowserBrowserCache() {
  $Candidates = @(
    (Join-Path $env:USERPROFILE ".agent-browser\browsers"),
    "C:\WINDOWS\system32\config\systemprofile\.agent-browser\browsers"
  )
  foreach ($Candidate in $Candidates) {
    if (-not $Candidate -or -not (Test-Path $Candidate)) { continue }
    $Chrome = Get-ChildItem -Path $Candidate -Recurse -Filter chrome.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($Chrome) {
      Write-Output "PLATFORM_AGENT_BROWSER_BROWSER_PATH=$($Chrome.FullName)"
      $script:BrowserCacheExit = 0
      return
    }
  }
  Write-Output "PLATFORM_AGENT_BROWSER_BROWSER_PATH="
  $script:BrowserCacheExit = 1
}

Write-Output "Starting browser-dogfood-smoke in $SourceRoot at $((Get-Date).ToUniversalTime().ToString('o'))"
Write-Output "PLATFORM_RUN_ROOT=$RunRoot"
Write-Output "PLATFORM_DOGFOOD_ARTIFACT_DIR=$DogfoodArtifactDir"

$NodeVersion = (& node --version 2>$null)
Write-Output "PLATFORM_NODE_VERSION=$NodeVersion"

& npm ci 2>&1
$NpmCiExit = $LASTEXITCODE
Write-Output "PLATFORM_NPM_CI_EXIT=$NpmCiExit"

$script:AgentBrowserReadyExit = 1
Test-AgentBrowser $AgentBrowserVersion
$AgentBrowserExit = $script:AgentBrowserReadyExit
Write-Output "PLATFORM_AGENT_BROWSER_READY_EXIT=$AgentBrowserExit"
$script:BrowserCacheExit = 1
if ($AgentBrowserExit -eq 0) { Test-AgentBrowserBrowserCache }
$BrowserCacheExit = $script:BrowserCacheExit
Write-Output "PLATFORM_AGENT_BROWSER_BROWSER_CACHE_EXIT=$BrowserCacheExit"
$BrowserPrewarmExit = 1
if ($BrowserCacheExit -eq 0) {
  $PrewarmPath = Join-Path $DogfoodArtifactDir "prewarm.html"
  "<h1>Example Domain</h1>" | Set-Content $PrewarmPath
  $PrewarmUrl = "file:///" + ($PrewarmPath -replace "\\", "/")
  for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
    Write-Output "PLATFORM_AGENT_BROWSER_PREWARM_ATTEMPT=$Attempt"
    & agent-browser open --json --session "platform-smoke-prewarm-$Attempt" $PrewarmUrl 2>&1
    $BrowserPrewarmExit = $LASTEXITCODE
    & agent-browser close --json --session "platform-smoke-prewarm-$Attempt" 2>&1
    if ($BrowserPrewarmExit -eq 0) { break }
    Start-Sleep -Seconds 2
  }
}
Write-Output "PLATFORM_AGENT_BROWSER_PREWARM_EXIT=$BrowserPrewarmExit"

$env:PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS = "55000"
Write-Output "PLATFORM_PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS=$env:PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS"

$TsxCli = Join-Path $SourceRoot "node_modules/.bin/tsx.cmd"
if (-not (Test-Path $TsxCli)) { $TsxCli = Join-Path $SourceRoot "node_modules/.bin/tsx" }
if (-not (Test-Path $TsxCli)) { $TsxCli = "tsx" }
Write-Output "PLATFORM_TSX_CLI=$TsxCli"

$DogfoodStdout = Join-Path $DogfoodDir "dogfood.stdout.txt"
$DogfoodStderr = Join-Path $DogfoodDir "dogfood.stderr.txt"
if ($NpmCiExit -eq 0 -and $AgentBrowserExit -eq 0 -and $BrowserCacheExit -eq 0 -and $BrowserPrewarmExit -eq 0) {
  & $TsxCli "scripts/verify-agent-browser-dogfood.ts" --artifact-dir $DogfoodArtifactDir --json >$DogfoodStdout 2>$DogfoodStderr
  $DogfoodExit = $LASTEXITCODE
} else {
  "npm ci or agent-browser setup failed" | Set-Content $DogfoodStderr
  $DogfoodExit = 1
}
Write-Output "PLATFORM_DOGFOOD_EXIT=$DogfoodExit"
Write-Section "DOGFOOD_STDOUT" $DogfoodStdout
Write-Section "DOGFOOD_STDERR" $DogfoodStderr

if ($NpmCiExit -ne 0 -or $AgentBrowserExit -ne 0 -or $BrowserCacheExit -ne 0 -or $BrowserPrewarmExit -ne 0 -or $DogfoodExit -ne 0) {
  Write-Output "PLATFORM_BROWSER_DOGFOOD_FAILED"
  exit 1
}

Write-Output "PLATFORM_BROWSER_DOGFOOD_OK"
