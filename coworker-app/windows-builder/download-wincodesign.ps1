# -----------------------------------------------------------------------------
# download-wincodesign.ps1 - Download and Cache winCodeSign Tool
#
# Pre-downloads winCodeSign for electron-builder to avoid download during build
# Usage: .\download-wincodesign.ps1 [-SourceFile <path>]
# -----------------------------------------------------------------------------

#Requires -Version 5.1

param(
    [string]$SourceFile  # Path to local winCodeSign-2.6.0.7z file
)

$ErrorActionPreference = "Stop"

# Get paths
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Import modules
Import-Module "$ScriptDir\lib\Logger.psm1" -Force

Write-Section "Setup winCodeSign for electron-builder"

# winCodeSign download details
$WinCodeSignVersion = "2.6.0"
$WinCodeSignUrl = "https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-${WinCodeSignVersion}/winCodeSign-${WinCodeSignVersion}.7z"
$CacheDir = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign-${WinCodeSignVersion}"
$CacheFile = "$CacheDir\winCodeSign-${WinCodeSignVersion}.7z"
$ExtractedDir = "$CacheDir\winCodeSign"

Write-Info "Version: $WinCodeSignVersion"
Write-Info "Cache: $CacheDir"

# Check if already cached
if (Test-Path "$ExtractedDir\winCodeSign.exe") {
    Write-Success "winCodeSign already cached"
    Write-Info "Location: $ExtractedDir"
    exit 0
}

# Create cache directory
if (-not (Test-Path $CacheDir)) {
    $null = New-Item -ItemType Directory -Force -Path $CacheDir
}

# Check for local source file first
$UseLocalFile = $false
if ($SourceFile) {
    if (Test-Path $SourceFile) {
        $UseLocalFile = $true
        Write-Info "Using local file: $SourceFile"
    } else {
        Write-Warning "Source file not found: $SourceFile"
        Write-Info "Will attempt download from GitHub"
    }
}

# Copy from local file or download
if ($UseLocalFile) {
    Write-Step "Copying from local file..." 1 3
    try {
        Copy-Item -Path $SourceFile -Destination $CacheFile -Force

        $FileSize = (Get-Item $CacheFile).Length
        $FileSizeDisplay = if ($FileSize -gt 1MB) { "{0:N1} MB" -f ($FileSize / 1MB) }
                          elseif ($FileSize -gt 1KB) { "{0:N0} KB" -f ($FileSize / 1KB) }
                          else { "$FileSize B" }

        Write-Success "Copied: $FileSizeDisplay"
    } catch {
        Write-Error "Copy failed: $_"
        exit 1
    }
} else {
    Write-Step "Downloading winCodeSign..." 1 3
    Write-Info "URL: $WinCodeSignUrl"

    try {
        $WebClient = New-Object System.Net.WebClient
        $WebClient.DownloadFile($WinCodeSignUrl, $CacheFile)

        $FileSize = (Get-Item $CacheFile).Length
        $FileSizeDisplay = if ($FileSize -gt 1MB) { "{0:N1} MB" -f ($FileSize / 1MB) }
                          elseif ($FileSize -gt 1KB) { "{0:N0} KB" -f ($FileSize / 1KB) }
                          else { "$FileSize B" }

        Write-Success "Downloaded: $FileSizeDisplay"
    } catch {
        Write-Error "Download failed: $_"
        Write-Info "You can provide a local file with:"
        Write-Info "  .\download-wincodesign.ps1 -SourceFile '<path-to-winCodeSign-2.6.0.7z>'"
        exit 1
    }
}

# Extract
Write-EmptyLine
Write-Step "Extracting..." 2 3

try {
    # Check if 7-Zip is available
    $SevenZip = Get-Command 7z -ErrorAction SilentlyContinue

    if ($SevenZip) {
        Write-Info "Using 7-Zip..."
        & $SevenZip.Source x "-o$CacheDir" -y $CacheFile | Out-Null
    } else {
        # Try using System.IO.Compression (PowerShell 5.1+)
        Write-Info "Using built-in extraction..."
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($CacheFile, $CacheDir)
    }

    Write-Success "Extracted"
} catch {
    Write-Error "Extraction failed: $_"
    Write-Info "Install 7-Zip or try extracting manually"
    exit 1
}

# Verify
Write-EmptyLine
Write-Step "Verifying..." 3 3

if (Test-Path "$ExtractedDir\winCodeSign.exe") {
    Write-Success "winCodeSign.exe verified"
    Write-EmptyLine

    Write-Section "Download Completed"
    Write-Host "Location: $ExtractedDir" -ForegroundColor Green
    Write-EmptyLine
    Write-Info "electron-builder will now use this cached version"
    exit 0
} else {
    Write-Error "Verification failed - winCodeSign.exe not found"
    exit 1
}
