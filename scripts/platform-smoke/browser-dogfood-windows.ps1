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

function Get-AgentBrowserCommandPath() {
  foreach ($Name in @("agent-browser.cmd", "agent-browser.exe", "agent-browser")) {
    $Command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($Command) { return $Command.Source }
  }
  return ""
}

function Get-AgentBrowserVersion($AgentBrowserPath) {
  if (-not $AgentBrowserPath) { return "" }
  return (& $AgentBrowserPath --version 2>$null)
}

function Test-AgentBrowser($Version, $AgentBrowserPath) {
  $Expected = "agent-browser $Version"
  $Current = Get-AgentBrowserVersion $AgentBrowserPath
  Write-Output "PLATFORM_AGENT_BROWSER_PATH=$AgentBrowserPath"
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

function Invoke-AgentBrowserWithTimeout($AgentBrowserPath, [string[]]$Arguments, [int]$TimeoutSeconds) {
  $script:LastAgentBrowserCommandExit = 1
  if (-not $script:AgentBrowserCommandCounter) { $script:AgentBrowserCommandCounter = 0 }
  $script:AgentBrowserCommandCounter += 1
  $OutPath = Join-Path $DogfoodDir ("agent-browser-{0}.stdout.txt" -f $script:AgentBrowserCommandCounter)
  $ErrPath = Join-Path $DogfoodDir ("agent-browser-{0}.stderr.txt" -f $script:AgentBrowserCommandCounter)
  $Process = Start-Process -FilePath $AgentBrowserPath -ArgumentList $Arguments -RedirectStandardOutput $OutPath -RedirectStandardError $ErrPath -PassThru -WindowStyle Hidden

  $TimedOut = -not $Process.WaitForExit($TimeoutSeconds * 1000)
  if ($TimedOut) {
    & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
    Write-Output "PLATFORM_AGENT_BROWSER_COMMAND_TIMEOUT=${TimeoutSeconds}s args=$($Arguments -join ' ')"
    $script:LastAgentBrowserCommandExit = 124
  }

  $StdoutText = if (Test-Path $OutPath) { Get-Content -Raw $OutPath } else { "" }
  $StderrText = if (Test-Path $ErrPath) { Get-Content -Raw $ErrPath } else { "" }
  if (-not $TimedOut) {
    if ($null -ne $Process.ExitCode) { $script:LastAgentBrowserCommandExit = $Process.ExitCode }
    elseif ($StdoutText -match '"success"\s*:\s*true') { $script:LastAgentBrowserCommandExit = 0 }
    else { $script:LastAgentBrowserCommandExit = 1 }
  }

  if ($StdoutText) { Write-Output $StdoutText }
  if ($StderrText) { Write-Output $StderrText }
  Write-Output "PLATFORM_AGENT_BROWSER_COMMAND_EXIT=$($script:LastAgentBrowserCommandExit)"
}

Write-Output "Starting browser-dogfood-smoke in $SourceRoot at $((Get-Date).ToUniversalTime().ToString('o'))"
Write-Output "PLATFORM_RUN_ROOT=$RunRoot"
Write-Output "PLATFORM_DOGFOOD_ARTIFACT_DIR=$DogfoodArtifactDir"

$NodeVersion = (& node --version 2>$null)
Write-Output "PLATFORM_NODE_VERSION=$NodeVersion"

& npm ci 2>&1
$NpmCiExit = $LASTEXITCODE
Write-Output "PLATFORM_NPM_CI_EXIT=$NpmCiExit"

$AgentBrowserPath = Get-AgentBrowserCommandPath
$script:AgentBrowserReadyExit = 1
Test-AgentBrowser $AgentBrowserVersion $AgentBrowserPath
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
    $PrewarmSession = "platform-smoke-prewarm-$Attempt"
    Invoke-AgentBrowserWithTimeout $AgentBrowserPath @("open", "--json", "--session", $PrewarmSession, $PrewarmUrl) 45
    $BrowserPrewarmExit = $script:LastAgentBrowserCommandExit
    if ($BrowserPrewarmExit -eq 0) {
      Invoke-AgentBrowserWithTimeout $AgentBrowserPath @("close", "--json", "--session", $PrewarmSession) 15
      $CloseExit = $script:LastAgentBrowserCommandExit
      Write-Output "PLATFORM_AGENT_BROWSER_PREWARM_CLOSE_EXIT=$CloseExit"
      break
    }
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
  $DogfoodExit = 1
  for ($Attempt = 1; $Attempt -le 2; $Attempt++) {
    Write-Output "PLATFORM_DOGFOOD_ATTEMPT=$Attempt"
    if ($Attempt -gt 1) { Start-Sleep -Seconds 2 }
    & $TsxCli "scripts/verify-agent-browser-dogfood.ts" --artifact-dir $DogfoodArtifactDir --json >$DogfoodStdout 2>$DogfoodStderr
    $DogfoodExit = $LASTEXITCODE
    if ($DogfoodExit -eq 0) { break }
  }
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
