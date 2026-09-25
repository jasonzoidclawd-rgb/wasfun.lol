param(
  [switch]$InstallMissingDependencies,
  [switch]$SkipBuildHostInstallSmoke,
  [string[]]$AppliedClaudeCommits = @()
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($PSVersionTable.PSEdition -eq "Core" -and -not $IsWindows) {
  throw "The Windows release build must run on Windows."
}

$overlayRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $overlayRoot
$sourceCommit = (& git.exe -C $repoRoot rev-parse HEAD).Trim()
$shortCommit = $sourceCommit.Substring(0, 12)
# CI checkouts are detached, where `branch --show-current` prints nothing.
$sourceBranch = "$(& git.exe -C $repoRoot branch --show-current)".Trim()
if (-not $sourceBranch) {
  $sourceBranch = @($env:GITHUB_HEAD_REF, $env:GITHUB_REF_NAME, "(detached)") |
    Where-Object { $_ } |
    Select-Object -First 1
}
$initialStatus = @(& git.exe -C $repoRoot status --porcelain=v1)
if ($initialStatus.Count -gt 0) {
  throw "The release build requires a clean worktree before output creation."
}

$forbiddenBuildVariables = @(
  "MAYHEM_OVERLAY_TIER_FIXTURE",
  "MAYHEM_OVERLAY_GEOMETRY_PREVIEW",
  "MAYHEM_OVERLAY_TRACE",
  "MAYHEM_OVERLAY_DATASET_CAPTURE",
  "MAYHEM_API_BASE"
)
foreach ($name in $forbiddenBuildVariables) {
  if ([Environment]::GetEnvironmentVariable($name)) {
    throw "Production build variable must be unset: $name"
  }
}

$deliveryRoot = Join-Path $repoRoot "out\windows-x64\$shortCommit"
$artifactRoot = Join-Path $deliveryRoot "artifacts"
$logsRoot = Join-Path $artifactRoot "logs"
$licensesRoot = Join-Path $artifactRoot "LICENSES"
New-Item -ItemType Directory -Force -Path $logsRoot | Out-Null
$driverLog = Join-Path $logsRoot "00-build-driver.log"
$verification = [System.Collections.Generic.List[string]]::new()

function Write-Driver {
  param([Parameter(Mandatory)][string]$Message)
  $line = "$([DateTimeOffset]::UtcNow.ToString('u')) $Message"
  $line | Tee-Object -FilePath $driverLog -Append
}

function Invoke-Logged {
  param(
    [Parameter(Mandatory)][string]$Command,
    [Parameter(Mandatory)][string[]]$Arguments,
    [Parameter(Mandatory)][string]$WorkingDirectory,
    [Parameter(Mandatory)][string]$LogName,
    [Parameter(Mandatory)][string]$Label
  )
  $logPath = Join-Path $logsRoot $LogName
  Write-Driver "START $Label"
  Push-Location $WorkingDirectory
  try {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = "Continue"
      & $Command @Arguments 2>&1 | Tee-Object -FilePath $logPath
    }
    finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($exitCode -ne 0) {
    throw "$Label failed with exit code $exitCode. See $LogName."
  }
  $verification.Add("${Label}: passed")
  Write-Driver "PASS $Label"
}

Write-Driver "Windows x64 release build"
Write-Driver "Source: $sourceBranch $sourceCommit"

$setupScript = Join-Path $PSScriptRoot "setup-windows-build.ps1"
$setupLog = Join-Path $logsRoot "01-toolchain-setup.log"
Write-Driver "START Windows toolchain setup"
Push-Location $repoRoot
try {
  if ($InstallMissingDependencies) {
    & $setupScript -InstallMissing 2>&1 | Tee-Object -FilePath $setupLog
  } else {
    & $setupScript 2>&1 | Tee-Object -FilePath $setupLog
  }
} finally {
  Pop-Location
}
$verification.Add("Windows toolchain setup: passed")
Write-Driver "PASS Windows toolchain setup"

Invoke-Logged -Command "powershell.exe" `
  -Arguments @(
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $PSScriptRoot "audit-windows-runtime.test.ps1")
  ) `
  -WorkingDirectory $repoRoot `
  -LogName "02-runtime-audit-helper-tests.log" `
  -Label "Windows runtime audit helper tests"

Invoke-Logged -Command "npm.cmd" -Arguments @("ci") -WorkingDirectory $repoRoot `
  -LogName "10-root-npm-ci.log" -Label "Root npm ci"
Invoke-Logged -Command "npm.cmd" -Arguments @("test") -WorkingDirectory $repoRoot `
  -LogName "11-root-tests.log" -Label "Root Vitest"
Invoke-Logged -Command "npx.cmd" -Arguments @("eslint", "src", "scripts") -WorkingDirectory $repoRoot `
  -LogName "12-root-eslint.log" -Label "Root ESLint"
Invoke-Logged -Command "npm.cmd" -Arguments @("run", "build") -WorkingDirectory $repoRoot `
  -LogName "13-root-build.log" -Label "Root production build"

Invoke-Logged -Command "npm.cmd" -Arguments @("ci") -WorkingDirectory $overlayRoot `
  -LogName "20-overlay-npm-ci.log" -Label "Overlay npm ci"
Invoke-Logged -Command "npm.cmd" -Arguments @("test") -WorkingDirectory $overlayRoot `
  -LogName "21-overlay-tests.log" -Label "Overlay Vitest"
Invoke-Logged -Command "npx.cmd" -Arguments @("eslint", "src", "scripts") -WorkingDirectory $overlayRoot `
  -LogName "22-overlay-eslint.log" -Label "Overlay ESLint"
Invoke-Logged -Command "npm.cmd" -Arguments @("run", "build") -WorkingDirectory $overlayRoot `
  -LogName "23-overlay-build.log" -Label "Overlay TypeScript and production build"
Invoke-Logged -Command "npm.cmd" -Arguments @("run", "audit:windows-artifact") -WorkingDirectory $overlayRoot `
  -LogName "24-prepackage-artifact-audit.log" -Label "Prepackage artifact audit"

$tauriRoot = Join-Path $overlayRoot "src-tauri"
. (Join-Path $PSScriptRoot "audit-windows-runtime-lib.ps1")
$rustRemapRoots = [ordered]@{
  USERPROFILE = $env:USERPROFILE
  HOME = $env:HOME
  RUNNER_WORKSPACE = $env:RUNNER_WORKSPACE
  GITHUB_WORKSPACE = $env:GITHUB_WORKSPACE
  repository = $repoRoot
  TEMP = $env:TEMP
  TMP = $env:TMP
  RUNNER_TEMP = $env:RUNNER_TEMP
  CARGO_HOME = $env:CARGO_HOME
  RUSTUP_HOME = $env:RUSTUP_HOME
  executable_output = (Join-Path $tauriRoot "target\release")
  artifact_output = $artifactRoot
}
$rustFlags = @(Get-RustPathRemapFlags -KnownRoots $rustRemapRoots)
$env:CARGO_ENCODED_RUSTFLAGS = Join-CargoEncodedRustFlags -Flags $rustFlags
$rustRemapCount = @($rustFlags | Where-Object { $_ -eq "--remap-path-prefix" }).Count
Write-Driver "Rust object path remapping enabled for $rustRemapCount concrete path variants"

$fmtLog = Join-Path $logsRoot "30-cargo-fmt.log"
Push-Location $tauriRoot
try {
  & cargo.exe fmt --all -- --check 2>&1 | Tee-Object -FilePath $fmtLog
  $fmtExit = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($fmtExit -ne 0) {
  $allowedFmtDebt = @(
    "src/foreground.rs",
    "src/lcu.rs",
    "src/lib.rs",
    "src/member.rs",
    "src/surface_probe.rs",
    "tests/member_contract.rs",
    "tests/r1_replay.rs"
  )
  $unexpected = [System.Collections.Generic.List[string]]::new()
  foreach ($line in Get-Content $fmtLog) {
    if ($line -notmatch "^Diff in (.+?):\d+:") {
      continue
    }
    $path = $Matches[1].Replace("\", "/")
    if (-not ($allowedFmtDebt | Where-Object { $path.EndsWith($_) })) {
      $unexpected.Add($path)
    }
  }
  if ($unexpected.Count -gt 0) {
    throw "cargo fmt found non-baseline formatting errors: $($unexpected -join ', ')"
  }
  Invoke-Logged -Command "rustfmt.exe" `
    -Arguments @(
      "--edition", "2021", "--check",
      "src/platform/mod.rs",
      "src/platform/windows.rs",
      "src/calibration.rs"
    ) `
    -WorkingDirectory $tauriRoot `
    -LogName "31-new-rust-files-fmt.log" `
    -Label "New Windows Rust files formatting"
  $verification.Add("Repository cargo fmt: inherited baseline failure only; see 30-cargo-fmt.log")
} else {
  $verification.Add("Repository cargo fmt: passed")
}

Invoke-Logged -Command "cargo.exe" -Arguments @("test") -WorkingDirectory $tauriRoot `
  -LogName "32-cargo-test.log" -Label "Rust tests"
Invoke-Logged -Command "cargo.exe" -Arguments @("check") -WorkingDirectory $tauriRoot `
  -LogName "33-cargo-check.log" -Label "Rust check"
Invoke-Logged -Command "cargo.exe" -Arguments @("clippy", "--all-targets") -WorkingDirectory $tauriRoot `
  -LogName "34-cargo-clippy.log" -Label "Rust Clippy"

function Get-PlainLogText {
  param([Parameter(Mandatory = $true)][string]$Path)

  $text = Get-Content $Path -Raw
  return [regex]::Replace(
    $text,
    '\x1B\[[0-?]*[ -/]*[@-~]',
    ""
  )
}

$rootTestText = Get-PlainLogText (Join-Path $logsRoot "11-root-tests.log")
$overlayTestText = Get-PlainLogText (Join-Path $logsRoot "21-overlay-tests.log")
$rootTestMatch = [regex]::Match(
  $rootTestText,
  "Test Files\s+(\d+) passed.*?Tests\s+(\d+) passed",
  [Text.RegularExpressions.RegexOptions]::Singleline
)
$overlayTestMatch = [regex]::Match(
  $overlayTestText,
  "Test Files\s+(\d+) passed.*?Tests\s+(\d+) passed",
  [Text.RegularExpressions.RegexOptions]::Singleline
)
if (-not $rootTestMatch.Success -or -not $overlayTestMatch.Success) {
  throw "Could not extract exact Vitest totals from the test logs."
}
$verification.Add(
  "Root Vitest totals: $($rootTestMatch.Groups[1].Value) files, $($rootTestMatch.Groups[2].Value) tests passed"
)
$verification.Add(
  "Overlay Vitest totals: $($overlayTestMatch.Groups[1].Value) files, $($overlayTestMatch.Groups[2].Value) tests passed"
)

$rustTestText = Get-Content (Join-Path $logsRoot "32-cargo-test.log") -Raw
$rustResults = [regex]::Matches(
  $rustTestText,
  "test result: ok\. (\d+) passed; 0 failed; (\d+) ignored;"
)
if ($rustResults.Count -eq 0) {
  throw "Could not extract exact Rust test totals from the test log."
}
$rustPassed = 0
$rustIgnored = 0
foreach ($result in $rustResults) {
  $rustPassed += [int]$result.Groups[1].Value
  $rustIgnored += [int]$result.Groups[2].Value
}
$verification.Add("Rust totals: $rustPassed tests passed, $rustIgnored ignored")

$validCertificates = @(
  Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
    Where-Object { $_.NotAfter -gt (Get-Date) -and $_.HasPrivateKey }
)
$configuredThumbprint = [Environment]::GetEnvironmentVariable("MAYHEM_WINDOWS_CERT_THUMBPRINT")
$selectedCertificate = $null
if ($configuredThumbprint) {
  $selectedCertificate = $validCertificates |
    Where-Object { $_.Thumbprint -eq $configuredThumbprint } |
    Select-Object -First 1
  if (-not $selectedCertificate) {
    throw "MAYHEM_WINDOWS_CERT_THUMBPRINT does not identify an available valid code-signing certificate."
  }
} elseif ($validCertificates.Count -eq 1) {
  $selectedCertificate = $validCertificates[0]
} elseif ($validCertificates.Count -gt 1) {
  throw "Multiple code-signing certificates are available; set MAYHEM_WINDOWS_CERT_THUMBPRINT."
}

$signingStatus = "unsigned"
$packageArguments = @("tauri", "build", "--bundles", "nsis,msi")
if ($selectedCertificate) {
  $timestampUrl = [Environment]::GetEnvironmentVariable("MAYHEM_WINDOWS_TIMESTAMP_URL")
  if (-not $timestampUrl) {
    $timestampUrl = "http://timestamp.digicert.com"
  }
  $signingConfigPath = Join-Path $deliveryRoot "tauri.signing.conf.json"
  @{
    bundle = @{
      windows = @{
        certificateThumbprint = $selectedCertificate.Thumbprint
        digestAlgorithm = "sha256"
        timestampUrl = $timestampUrl
      }
    }
  } | ConvertTo-Json -Depth 5 | Set-Content $signingConfigPath -Encoding UTF8
  $packageArguments += @("--config", $signingConfigPath)
  $signingStatus = "Authenticode signed and timestamped"
}
Invoke-Logged -Command "npx.cmd" -Arguments $packageArguments -WorkingDirectory $overlayRoot `
  -LogName "40-tauri-windows-package.log" -Label "Tauri Windows x64 NSIS and MSI package"
Invoke-Logged -Command "npm.cmd" -Arguments @("run", "audit:windows-artifact") -WorkingDirectory $overlayRoot `
  -LogName "41-packaged-artifact-audit.log" -Label "Packaged artifact audit"
Invoke-Logged -Command "npm.cmd" -Arguments @("run", "audit:windows-artifact-names") -WorkingDirectory $overlayRoot `
  -LogName "42-artifact-name-audit.log" -Label "Installer name audit"

$config = Get-Content (Join-Path $tauriRoot "tauri.conf.json") -Raw | ConvertFrom-Json
$version = $config.version
$bundleRoot = Join-Path $tauriRoot "target\release\bundle"
$rawExe = Join-Path $tauriRoot "target\release\mayhem-oracle-overlay.exe"
$nsis = Join-Path $bundleRoot "nsis\Mayhem Oracle_${version}_x64-setup.exe"
$msiCandidates = @(Get-ChildItem (Join-Path $bundleRoot "msi") -File -Filter "*.msi" -ErrorAction SilentlyContinue)
if (-not (Test-Path $rawExe)) {
  throw "Raw release executable is missing: $rawExe"
}
if (-not (Test-Path $nsis)) {
  throw "Required NSIS installer is missing: $nsis"
}
if ($msiCandidates.Count -ne 1) {
  throw "Expected exactly one MSI installer; found $($msiCandidates.Count)."
}

Copy-Item $rawExe (Join-Path $artifactRoot "mayhem-oracle-overlay.exe") -Force
Copy-Item $nsis (Join-Path $artifactRoot (Split-Path -Leaf $nsis)) -Force
Copy-Item $msiCandidates[0].FullName (Join-Path $artifactRoot $msiCandidates[0].Name) -Force

$dependencyReport = Join-Path $artifactRoot "DEPENDENCIES.txt"
& (Join-Path $PSScriptRoot "audit-windows-runtime.ps1") `
  -Executable (Join-Path $artifactRoot "mayhem-oracle-overlay.exe") `
  -DependencyReport $dependencyReport `
  -DumpbinLog (Join-Path $logsRoot "43-dumpbin.log")
if (-not $?) {
  throw "PE dependency audit failed."
}
$verification.Add("PE dependency and GUI subsystem audit: passed")

foreach ($artifact in @(
  (Join-Path $artifactRoot "mayhem-oracle-overlay.exe"),
  (Join-Path $artifactRoot (Split-Path -Leaf $nsis)),
  (Join-Path $artifactRoot $msiCandidates[0].Name)
)) {
  $signature = Get-AuthenticodeSignature $artifact
  if ($selectedCertificate -and $signature.Status -ne "Valid") {
    throw "Signature verification failed for $(Split-Path -Leaf $artifact): $($signature.Status)"
  }
  if (-not $selectedCertificate -and $signature.Status -eq "Valid") {
    $signingStatus = "signed by build environment"
  }
}
$verification.Add("Signing status: $signingStatus")

$smokeOutput = Join-Path $logsRoot "build-host-install-smoke"
if (-not $SkipBuildHostInstallSmoke) {
  & (Join-Path $PSScriptRoot "validate-windows-installer.ps1") `
    -Installer (Join-Path $artifactRoot (Split-Path -Leaf $nsis)) `
    -OutputDirectory $smokeOutput
  if (-not $?) {
    throw "Build-host installer smoke validation failed."
  }
  $verification.Add("Build-host install/launch/reinstall/uninstall smoke: passed")
} else {
  $verification.Add("Build-host installer smoke: skipped")
}
$verification.Add("Clean Windows VM validation: NOT RUN; final delivery is blocked until this passes")

& (Join-Path $PSScriptRoot "generate-windows-licenses.ps1") `
  -RepositoryRoot $repoRoot `
  -OutputDirectory $licensesRoot
if (-not $?) {
  throw "Dependency license generation failed."
}

function Get-ToolVersion {
  param(
    [Parameter(Mandatory)][string]$Command,
    [Parameter(Mandatory)][string[]]$Arguments,
    [Parameter(Mandatory)][string]$WorkingDirectory
  )
  Push-Location $WorkingDirectory
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # npm/npx may print warnings on stderr; only stdout carries the version.
    $ErrorActionPreference = "Continue"
    $output = @(& $Command @Arguments 2>$null)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Pop-Location
  }
  $first = $output | Where-Object { "$_".Trim() } | Select-Object -First 1
  if ($exitCode -ne 0 -or -not $first) {
    throw "$Command $($Arguments -join ' ') did not report a version (exit $exitCode)."
  }
  return "$first".Trim()
}

$nodeVersion = Get-ToolVersion -Command "node.exe" -Arguments @("--version") -WorkingDirectory $repoRoot
$npmVersion = Get-ToolVersion -Command "npm.cmd" -Arguments @("--version") -WorkingDirectory $repoRoot
$rustVersion = Get-ToolVersion -Command "rustc.exe" -Arguments @("--version") -WorkingDirectory $tauriRoot
$cargoVersion = Get-ToolVersion -Command "cargo.exe" -Arguments @("--version") -WorkingDirectory $tauriRoot
# The Tauri CLI is an overlay devDependency; from the repository root npx
# would resolve the unrelated public `tauri` package instead.
$tauriVersion = Get-ToolVersion -Command "npx.cmd" -Arguments @("--no-install", "tauri", "--version") -WorkingDirectory $overlayRoot
$windowsVersion = [Environment]::OSVersion.VersionString
$sdkVersion = [string]$env:WindowsSDKVersion
$msvcVersion = [string]$env:VCToolsVersion
$applied = if ($AppliedClaudeCommits.Count -gt 0) {
  $AppliedClaudeCommits -join ", "
} else {
  "none"
}

@(
  "Mayhem Oracle Windows x64 Build Manifest"
  "Repository path: $repoRoot"
  "Source branch: $sourceBranch"
  "Source commit: $sourceCommit"
  "Applied Claude shared commits: $applied"
  "Application version: $version"
  "Rust: $rustVersion"
  "Cargo: $cargoVersion"
  "Node: $nodeVersion"
  "npm: $npmVersion"
  "Tauri CLI: $tauriVersion"
  "Windows SDK: $sdkVersion"
  "MSVC: $msvcVersion"
  "Windows build: $windowsVersion"
  "Target architecture: x86_64-pc-windows-msvc"
  "Build timestamp: $([DateTimeOffset]::UtcNow.ToString('u'))"
  "Signing status: $signingStatus"
  "WebView2 bundling mode: official Evergreen x64 offlineInstaller"
  "VC++ runtime strategy: Rust +crt-static; PE audit rejects VCRUNTIME/MSVCP/CONCRT imports"
  "OCR runtime requirement: Windows 10+ Windows.Media.Ocr and an installed OCR language pack"
  "Exact package command: npx tauri build --bundles nsis,msi"
) | Set-Content -Path (Join-Path $artifactRoot "BUILD-MANIFEST.txt") -Encoding UTF8

$verification | Set-Content -Path (Join-Path $artifactRoot "VERIFICATION.txt") -Encoding UTF8

$binaryArtifacts = @(
  Get-Item (Join-Path $artifactRoot "mayhem-oracle-overlay.exe"),
  Get-Item (Join-Path $artifactRoot (Split-Path -Leaf $nsis)),
  Get-Item (Join-Path $artifactRoot $msiCandidates[0].Name)
)
$checksumLines = foreach ($artifact in $binaryArtifacts) {
  $hash = (Get-FileHash -Algorithm SHA256 $artifact.FullName).Hash.ToLowerInvariant()
  "$hash  $($artifact.Name)"
}
$checksumLines | Set-Content -Path (Join-Path $artifactRoot "SHA256SUMS.txt") -Encoding ASCII

& git.exe -C $repoRoot diff --check
if ($LASTEXITCODE -ne 0) {
  throw "git diff --check failed"
}
$verification.Add("git diff --check: passed")
$verification | Set-Content -Path (Join-Path $artifactRoot "VERIFICATION.txt") -Encoding UTF8

$preliminaryZip = Join-Path $deliveryRoot "mayhem-windows-overlay-x64-$shortCommit-PRELIMINARY.zip"
if (Test-Path $preliminaryZip) {
  Remove-Item $preliminaryZip -Force
}
Compress-Archive -Path $artifactRoot -DestinationPath $preliminaryZip -CompressionLevel Optimal

Copy-Item (Join-Path $PSScriptRoot "validate-windows-installer.ps1") $deliveryRoot -Force
Copy-Item (Join-Path $PSScriptRoot "complete-windows-clean-validation.ps1") $deliveryRoot -Force
Write-Driver "PRELIMINARY artifact: $preliminaryZip"
Write-Warning "This bundle is not final until validate-windows-installer.ps1 passes on a clean Windows VM without WebView2 or development tools."
