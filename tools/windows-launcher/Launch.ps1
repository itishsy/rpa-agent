$ErrorActionPreference = 'Stop'
$env:ELECTRON_RUN_AS_NODE = $null
Set-Location -LiteralPath $PSScriptRoot

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($identity -match 'CodexSandbox') {
  $sandboxData = Join-Path $env:TEMP 'rpa-agent-sandbox-data'
  $sandboxCache = Join-Path $sandboxData 'cache'
  New-Item -ItemType Directory -Path $sandboxCache -Force | Out-Null
  $env:RPA_AGENT_DATA_DIR = $sandboxData
  $env:RPA_AGENT_CACHE_DIR = $sandboxCache
}

$core = Join-Path $PSScriptRoot 'rpa-agent-core.exe'
if (-not (Test-Path -LiteralPath $core -PathType Leaf)) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show(
    'rpa-agent-core.exe is missing. Keep the complete rpa-agent folder.',
    'rpa-agent startup failed',
    'OK',
    'Error'
  ) | Out-Null
  exit 2
}

try {
  Add-Content -LiteralPath (Join-Path $PSScriptRoot 'launcher.log') -Value "$(Get-Date -Format o) launch shortcut"
} catch {}

Start-Process -FilePath $core -WorkingDirectory $PSScriptRoot -ArgumentList @(
  '--no-sandbox',
  '--disable-features=TSFImeSupport',
  '--disable-gpu'
)
