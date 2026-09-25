param(
  [Parameter(Mandatory)][string]$RepositoryRoot,
  [Parameter(Mandatory)][string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repo = (Resolve-Path $RepositoryRoot).Path
$overlay = Join-Path $repo "overlay"
$tauri = Join-Path $overlay "src-tauri"
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

function Safe-Name {
  param([Parameter(Mandatory)][string]$Value)
  return ($Value -replace "[^A-Za-z0-9._-]", "_")
}

function Get-PropertyValue {
  param(
    [Parameter(Mandatory)]$Object,
    [Parameter(Mandatory)][string]$Name
  )
  $property = $Object.PSObject.Properties[$Name]
  if ($property) {
    return $property.Value
  }
  return $null
}

$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add("Mayhem Oracle third-party dependency licenses")
$lines.Add("Generated: $([DateTimeOffset]::UtcNow.ToString('u'))")
$lines.Add("")

$cargoMetadata = & cargo.exe metadata --format-version 1 --locked --manifest-path (Join-Path $tauri "Cargo.toml")
if ($LASTEXITCODE -ne 0) {
  throw "cargo metadata failed"
}
$cargo = $cargoMetadata | ConvertFrom-Json
$lines.Add("[Rust packages]")
foreach ($package in ($cargo.packages | Sort-Object name, version)) {
  $license = if ($package.license) { $package.license } else { "NOT DECLARED" }
  $lines.Add("$($package.name) $($package.version) | $license | $($package.repository)")
  $packageDirectory = Split-Path -Parent $package.manifest_path
  $licenseFiles = @(Get-ChildItem $packageDirectory -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "^(LICENSE|COPYING|NOTICE)" })
  if ($licenseFiles.Count -gt 0) {
    $destination = Join-Path $OutputDirectory ("rust-" + (Safe-Name "$($package.name)-$($package.version)"))
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    $licenseFiles | Copy-Item -Destination $destination -Force
  }
}

$lines.Add("")
$lines.Add("[Overlay npm packages]")
$lockPath = Join-Path $overlay "package-lock.json"
# Windows PowerShell 5.1's ConvertFrom-Json rejects lockfile v3's empty root
# key (""), so Node flattens the packages map first.
$lockProjection = & node (Join-Path $PSScriptRoot "project-npm-lock.mjs") $lockPath
if ($LASTEXITCODE -ne 0) {
  throw "package-lock.json projection failed"
}
$lockEntries = $lockProjection | ConvertFrom-Json
foreach ($entry in ($lockEntries | Sort-Object path)) {
  $packageVersion = Get-PropertyValue -Object $entry -Name "version"
  if (-not $entry.path -or -not $packageVersion) {
    continue
  }
  $packagePath = $entry.path
  $declaredName = Get-PropertyValue -Object $entry -Name "name"
  $declaredLicense = Get-PropertyValue -Object $entry -Name "license"
  $packageName = if ($declaredName) {
    $declaredName
  } else {
    Split-Path $packagePath -Leaf
  }
  $license = if ($declaredLicense) { $declaredLicense } else { "NOT DECLARED" }
  $lines.Add("$packageName $packageVersion | $license")
  $installedPath = Join-Path $overlay $packagePath
  if (Test-Path $installedPath) {
    $licenseFiles = @(Get-ChildItem $installedPath -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "^(LICENSE|COPYING|NOTICE)" })
    if ($licenseFiles.Count -gt 0) {
      $destination = Join-Path $OutputDirectory ("npm-" + (Safe-Name "$packageName-$packageVersion"))
      New-Item -ItemType Directory -Force -Path $destination | Out-Null
      $licenseFiles | Copy-Item -Destination $destination -Force
    }
  }
}

$projectLicenses = @(Get-ChildItem $repo -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match "^(LICENSE|COPYING|NOTICE)" })
if ($projectLicenses.Count -gt 0) {
  $projectDestination = Join-Path $OutputDirectory "project"
  New-Item -ItemType Directory -Force -Path $projectDestination | Out-Null
  $projectLicenses | Copy-Item -Destination $projectDestination -Force
} else {
  $lines.Add("")
  $lines.Add("NOTE: No repository-level LICENSE, COPYING, or NOTICE file is present.")
}

$lines | Set-Content -Path (Join-Path $OutputDirectory "THIRD-PARTY-LICENSES.txt") -Encoding UTF8
Write-Host "Dependency license inventory generated at $OutputDirectory"
