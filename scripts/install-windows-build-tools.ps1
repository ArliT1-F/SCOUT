<#
.SYNOPSIS
  Installs the Windows build toolchain `npm run package:windows` needs.

.DESCRIPTION
  The pieces a fresh Windows machine does not have, and what they are for:

    Build Tools for Visual Studio 2022, C++ workload
      link.exe and the Windows SDK. Rust's MSVC target links with link.exe; without it the
      overlay shell (scout-shell.exe) compiles for minutes and then dies with
      "linker `link.exe` not found". VS Code does not include this - it is only an editor.
    Rust (rustup, stable MSVC toolchain)
      builds scout-shell.exe. Skipped when cargo/rustc already answer.
    Inno Setup 6
      ISCC.exe, which packs SCOUT-Setup-<version>.exe. Skipped when already installed.
    Node.js LTS
      runs the whole packaging script. Only installed when node is missing entirely;
      an existing Node is left alone.

  Safe to re-run: every piece is checked first and skipped when present. Everything is
  installed with winget, which asks for administrator approval (UAC) where it needs it -
  run this from a normal PowerShell window. The Build Tools download is several GB.

  This sets up the machine that BUILDS SCOUT. A machine that only runs SCOUT-Setup.exe
  needs none of it (the installer bundles its own Node runtime).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-windows-build-tools.ps1

  Then, in a fresh terminal:
    node scripts/build-installer.mjs --check-toolchain   # prove the machine, build nothing
    npm run package:windows                                # produce dist-installer\SCOUT-Setup-<version>.exe
#>
param([switch]$SkipVerification)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$failed = @()

function Write-Step($text)    { Write-Host "`n== $text" -ForegroundColor Cyan }
function Write-Ok($text)      { Write-Host "  [ok]      $text" -ForegroundColor Green }
function Write-Missing($text) { Write-Host "  [missing] $text" -ForegroundColor Yellow }

function Update-SessionPath {
  # winget/rustup/node update the registry PATH, not this process's copy. Pick the new
  # entries up so the re-checks below (and the verification at the end) see fresh installs.
  $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [System.Environment]::GetEnvironmentVariable('Path', 'User')
  $cargo   = Join-Path $env:USERPROFILE '.cargo\bin'
  $env:Path = (@($machine, $user, $cargo, $env:Path) | Where-Object { $_ }) -join ';'
}

function Get-VsWhere {
  foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not $base) { continue }
    $candidate = Join-Path $base 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

function Get-MsvcLinker {
  # The same probe scripts/build-installer.mjs makes: ask vswhere for an install that has
  # the VC++ tools and for the link.exe inside it. -find is relative to the install path,
  # and -products * is what includes the standalone Build Tools.
  $vswhere = Get-VsWhere
  if (-not $vswhere) { return $null }
  $found = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
             -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\link.exe' | Select-Object -First 1
  if ($found -and (Test-Path $found)) { return $found }
  return $null
}

function Get-Iscc {
  foreach ($candidate in @(
      (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
      (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'))) {
    if (Test-Path $candidate) { return $candidate }
  }
  $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
}

function Invoke-Winget([string[]]$Arguments, [string]$What) {
  Write-Host "  $ winget $($Arguments -join ' ')"
  & winget @Arguments
  if ($LASTEXITCODE -ne 0) {
    # winget also returns non-zero for "already installed / no upgrade applies", so the
    # caller's re-check has the final word rather than this exit code.
    Write-Host "  winget exited with $LASTEXITCODE for $What - checking whether it worked anyway..."
  }
  Update-SessionPath
}

Update-SessionPath

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  $noWinget = @'

winget was not found, and this script installs everything through it.
Install "App Installer" from the Microsoft Store (it provides winget):
  https://apps.microsoft.com/detail/9nblggh4nns1
then close and re-open PowerShell and run this script again.
'@
  Write-Host $noWinget -ForegroundColor Red
  exit 1
}

Write-Host "SCOUT Windows build tools - repo: $repoRoot"

# ------------------------------------------------------------------ Visual C++ ---------------
Write-Step 'Build Tools for Visual Studio 2022 (Visual C++ linker + Windows SDK)'
$linker = Get-MsvcLinker
if ($linker) {
  Write-Ok $linker
} else {
  Write-Missing 'no link.exe under a Visual Studio / Build Tools VC\Tools\MSVC directory'
  Invoke-Winget @('install', '--id', 'Microsoft.VisualStudio.2022.BuildTools', '-e', '--silent',
                  '--accept-package-agreements', '--accept-source-agreements',
                  '--override', '--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended') `
                'Build Tools for Visual Studio'
  $linker = Get-MsvcLinker
  if ($linker) {
    Write-Ok $linker
  } else {
    $failed += 'Visual C++ build tools'
    $stillMissing = @'
  Still no link.exe. If Visual Studio was already installed without the C++ workload,
  winget cannot always add it after the fact - open the Visual Studio Installer, choose
  Modify, tick "Desktop development with C++" and Install, then re-run this script.
'@
    Write-Host $stillMissing -ForegroundColor Red
  }
}

# ------------------------------------------------------------------ Rust ---------------------
Write-Step 'Rust toolchain (stable, MSVC target)'
if ((Get-Command cargo -ErrorAction SilentlyContinue) -and (Get-Command rustc -ErrorAction SilentlyContinue)) {
  Write-Ok "$(cargo --version) / $(rustc --version)"
} else {
  Write-Missing 'cargo/rustc are not on PATH'
  Invoke-Winget @('install', '--id', 'Rustlang.Rustup', '-e', '--silent',
                  '--accept-package-agreements', '--accept-source-agreements') 'Rust (rustup)'
  if (Get-Command rustup -ErrorAction SilentlyContinue) {
    # The MSVC toolchain, matching the linker installed above (and Tauri's expectation).
    & rustup default stable-x86_64-pc-windows-msvc
  }
  Update-SessionPath
  if ((Get-Command cargo -ErrorAction SilentlyContinue) -and (Get-Command rustc -ErrorAction SilentlyContinue)) {
    Write-Ok "$(cargo --version) / $(rustc --version)"
  } else {
    $failed += 'Rust toolchain'
    Write-Host '  Rust is still not on PATH. Close and re-open PowerShell - rustup may only ' -ForegroundColor Red
    Write-Host '  have updated the PATH for new terminals - and re-run this script.' -ForegroundColor Red
  }
}

# ------------------------------------------------------------------ Inno Setup ---------------
Write-Step 'Inno Setup 6 (ISCC.exe packs SCOUT-Setup)'
$iscc = Get-Iscc
if ($iscc) {
  Write-Ok $iscc
} else {
  Write-Missing 'ISCC.exe not found'
  Invoke-Winget @('install', '--id', 'JRSoftware.InnoSetup', '-e', '--silent',
                  '--accept-package-agreements', '--accept-source-agreements') 'Inno Setup'
  $iscc = Get-Iscc
  if ($iscc) { Write-Ok $iscc } else { $failed += 'Inno Setup' }
}

# ------------------------------------------------------------------ Node.js ------------------
Write-Step 'Node.js (runs scripts/build-installer.mjs)'
if (Get-Command node -ErrorAction SilentlyContinue) {
  Write-Ok "node $(node --version) (20 or newer is needed; an installed Node is never replaced)"
} else {
  Write-Missing 'node is not on PATH'
  Invoke-Winget @('install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--silent',
                  '--accept-package-agreements', '--accept-source-agreements') 'Node.js LTS'
  if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Ok "node $(node --version)"
  } else {
    $failed += 'Node.js'
  }
}

# ------------------------------------------------------------------ verify -------------------
if ($failed.Count -gt 0) {
  Write-Host "`nStill missing: $($failed -join ', '). Fix the notes above and re-run this script." -ForegroundColor Red
  exit 1
}

if (-not $SkipVerification) {
  Write-Step 'Verifying with the packaging script itself (builds nothing)'
  & node (Join-Path $repoRoot 'scripts\build-installer.mjs') --check-toolchain
  if ($LASTEXITCODE -ne 0) {
    Write-Host "`nThe packaging script still reports missing pieces - see above." -ForegroundColor Red
    exit $LASTEXITCODE
  }
}

$done = @'

Done. Open a NEW terminal (so it picks up the updated PATH) in this repository and run:

  npm run package:windows

Output: dist-installer\SCOUT-Setup-<version>.exe
'@
Write-Host $done -ForegroundColor Green
