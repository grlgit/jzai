# -----------------------------------------------------------------------------
# verify-cache.ps1 - Verify winCodeSign Cache Structure
#
# Checks if the winCodeSign cache is set up correctly for electron-builder
# Usage: .\verify-cache.ps1
# -----------------------------------------------------------------------------

#Requires -Version 5.1

$ErrorActionPreference = "Stop"

$WinCodeSignCacheDir = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign-2.6.0"
$WinCodeSignCachedFile = "$WinCodeSignCacheDir\winCodeSign-2.6.0.7z"
$WinCodeSignExtractedDir = "$WinCodeSignCacheDir\winCodeSign"
$WinCodeSignExe = "$WinCodeSignExtractedDir\winCodeSign.exe"
$SigntoolExe = "$WinCodeSignExtractedDir\signtool.exe"

Write-Host "=== winCodeSign Cache Verification ===" -ForegroundColor Cyan
Write-Host ""

Write-Host "Cache Directory: $WinCodeSignCacheDir" -ForegroundColor White
$Exists = Test-Path $WinCodeSignCacheDir
Write-Host "  Exists: $Exists" -ForegroundColor $(if ($Exists) { "Green" } else { "Red" })

Write-Host ""
Write-Host "7z File: $WinCodeSignCachedFile" -ForegroundColor White
$Exists = Test-Path $WinCodeSignCachedFile
Write-Host "  Exists: $Exists" -ForegroundColor $(if ($Exists) { "Green" } else { "Red" })
if ($Exists) {
    $Size = (Get-Item $WinCodeSignCachedFile).Length
    $SizeMB = "{0:N1} MB" -f ($Size / 1MB)
    Write-Host "  Size: $SizeMB" -ForegroundColor Green
    $Hash = Get-FileHash -Path $WinCodeSignCachedFile -Algorithm SHA256 -ErrorAction SilentlyContinue
    if ($Hash) {
        Write-Host "  SHA256: $($Hash.Hash.Substring(0, 16))..." -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "Extracted Directory: $WinCodeSignExtractedDir" -ForegroundColor White
$Exists = Test-Path $WinCodeSignExtractedDir
Write-Host "  Exists: $Exists" -ForegroundColor $(if ($Exists) { "Green" } else { "Red" })

if ($Exists) {
    Write-Host ""
    Write-Host "Extracted Files:" -ForegroundColor White
    Get-ChildItem -Path $WinCodeSignExtractedDir -ErrorAction SilentlyContinue | ForEach-Object {
        $Color = if ($_.Name -eq "winCodeSign.exe" -or $_.Name -eq "signtool.exe") { "Green" } else { "DarkGray" }
        Write-Host "  $($_.Name) - $($_.Length bytes)" -ForegroundColor $Color
    }

    Write-Host ""
    Write-Host "Critical Files:" -ForegroundColor White

    $SigntoolExists = Test-Path $SigntoolExe
    Write-Host "  signtool.exe: $SigntoolExists" -ForegroundColor $(if ($SigntoolExists) { "Green" } else { "Red" })

    $WinCodeSignExists = Test-Path $WinCodeSignExe
    Write-Host "  winCodeSign.exe: $WinCodeSignExists" -ForegroundColor $(if ($WinCodeSignExists) { "Green" } else { "Red" })
}

Write-Host ""
Write-Host "Cache Metadata Files:" -ForegroundColor White
$MetadataFiles = @(
    "$WinCodeSignCacheDir\info.yaml",
    "$WinCodeSignCacheDir\version.txt",
    "$WinCodeSignCacheDir\.completed"
)
foreach ($File in $MetadataFiles) {
    $Exists = Test-Path $File
    $FileName = Split-Path $File -Leaf
    Write-Host "  $FileName`: $Exists" -ForegroundColor $(if ($Exists) { "Green" } else { "Yellow" })
}

Write-Host ""
Write-Host "=== Diagnostic Summary ===" -ForegroundColor Cyan

if ((Test-Path $WinCodeSignCachedFile) -and (Test-Path $WinCodeSignExe)) {
    Write-Host "  ✓ Cache appears to be set up correctly" -ForegroundColor Green
    Write-Host ""
    Write-Host "If electron-builder still tries to download, the issue may be:" -ForegroundColor Yellow
    Write-Host "  1. Network timeout during download attempt" -ForegroundColor Yellow
    Write-Host "  2. electron-builder cache validation bug" -ForegroundColor Yellow
    Write-Host "  3. File integrity check failure" -ForegroundColor Yellow
} else {
    Write-Host "  ✗ Cache is incomplete" -ForegroundColor Red
    Write-Host ""
    Write-Host "Run .\build.ps1 to set up the cache" -ForegroundColor Yellow
}

Write-Host ""
