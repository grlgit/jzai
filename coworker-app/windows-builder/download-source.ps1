# -----------------------------------------------------------------------------
# download-source.ps1 - OpenClaw Source Download Script
#
# Downloads OpenClaw source from npm or backend API
# Usage: .\download-source.ps1 [-Version <version>] [-Output <path>] [-Mirror <mirror>]
# -----------------------------------------------------------------------------

#Requires -Version 5.1

param(
    [string]$Version = "latest",
    [string]$Output = "",
    [string]$Mirror = "npmmirror",  # npm, npmmirror, or custom URL
    [string]$BackendUrl = ""
)

$ErrorActionPreference = "Stop"

# Get paths
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir

# Import modules
Import-Module "$ScriptDir\lib\Logger.psm1" -Force

Write-Section "Download OpenClaw Source"

# Determine output path
if (-not $Output) {
    $Output = "$ProjectRoot\openclaw"
}

# -- 1. Determine download URL --
Write-Step "Determining download source..." 1 5

$DownloadUrl = $null

if ($BackendUrl) {
    # Download from backend API
    $DownloadUrl = "$BackendUrl/api/coworkers/openclaw/asset"
    Write-Info "Using backend API: $BackendUrl"
} else {
    # Download from npm mirror
    $EncodedVersion = [System.Web.HttpUtility]::UrlEncode($Version)
    switch ($Mirror) {
        "npm" {
            $DownloadUrl = "https://registry.npmjs.org/openclaw/-/openclaw-$EncodedVersion.tgz"
        }
        "npmmirror" {
            $DownloadUrl = "https://registry.npmmirror.com/openclaw/-/openclaw-$EncodedVersion.tgz"
        }
        default {
            # Custom URL, treat as direct download
            $DownloadUrl = $Mirror -replace '\{version\}', $EncodedVersion
        }
    }
    Write-Info "Using npm mirror: $Mirror"
}

Write-Success "Download source: $DownloadUrl"
Write-EmptyLine

# -- 2. Download package --
Write-Step "Downloading OpenClaw package..." 2 5

$TempDir = "$env:TEMP\openclaw-download-$([Guid]::NewGuid())"
$null = New-Item -ItemType Directory -Force -Path $TempDir
$TgzPath = "$TempDir\openclaw.tgz"

try {
    # Use Invoke-WebRequest with progress tracking
    Write-Info "Downloading from: $DownloadUrl"

    # Use WebClient for better progress display
    $WebClient = New-Object System.Net.WebClient

    # Register progress callback
    Register-ObjectEvent -InputObject $WebClient -EventName DownloadProgressChanged -SourceIdentifier WebClient.DownloadProgress -Action {
        $global:DownloadProgress = $Event.SourceEventArgs.ProgressPercentage
        Write-Progress -Activity "Downloading OpenClaw" -Status "$($Event.SourceEventArgs.ProgressPercentage)% complete" -PercentComplete $Event.SourceEventArgs.ProgressPercentage
    } -ErrorAction SilentlyContinue | Out-Null

    # Download
    $WebClient.DownloadFile($DownloadUrl, $TgzPath)

    # Unregister event
    Unregister-Event -SourceIdentifier WebClient.DownloadProgress -ErrorAction SilentlyContinue

    $FileSize = (Get-Item $TgzPath).Length
    $FileSizeDisplay = if ($FileSize -gt 1MB) { "{0:N1} MB" -f ($FileSize / 1MB) }
                      elseif ($FileSize -gt 1KB) { "{0:N0} KB" -f ($FileSize / 1KB) }
                      else { "$FileSize B" }

    Write-Progress -Activity "Downloading OpenClaw" -Completed
    Write-Success "Downloaded: $FileSizeDisplay"
} catch {
    Write-Progress -Activity "Downloading OpenClaw" -Completed
    Write-Error "Download failed: $_"
    Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-EmptyLine

# -- 3. Extract package --
Write-Step "Extracting package..." 3 5

try {
    # Check if tar is available (Git Bash or WSL)
    $TarCommand = Get-Command tar -ErrorAction SilentlyContinue

    Write-Info "Extracting package..."

    if ($TarCommand) {
        # Use tar (available in Git Bash or Windows 10+)
        Write-Progress -Activity "Extracting OpenClaw" -Status "Using tar..."
        & tar -xzf $TgzPath -C $TempDir 2>&1 | Out-Null
        Write-Progress -Activity "Extracting OpenClaw" -Completed
    } else {
        # Fallback: use Node.js to extract
        Write-Warning "tar not found, using Node.js for extraction..."

        $ExtractScript = @"
const tar = require('tar');
const fs = require('fs');
const path = require('path');

const tgzPath = process.argv[2];
const extractPath = process.argv[3];

tar.x({
    file: tgzPath,
    cwd: extractPath,
    strip: 1,  # Remove 'package/' prefix
    onentry: (entry) => {
        console.log('Extracting:', entry.path);
    }
}).then(() => {
    console.log('Extraction complete');
}).catch((err) => {
    console.error('Extraction failed:', err);
    process.exit(1);
});
"@

        $ExtractJsPath = Join-Path $TempDir "extract.js"
        $ExtractScript | Set-Content -Path $ExtractJsPath

        Write-Progress -Activity "Extracting OpenClaw" -Status "Using Node.js..."
        Push-Location $ProjectRoot
        node $ExtractJsPath $TgzPath $TempDir
        Pop-Location
        Write-Progress -Activity "Extracting OpenClaw" -Completed

        if ($LASTEXITCODE -ne 0) {
            throw "Node.js extraction failed"
        }
    }

    Write-Success "Package extracted"
} catch {
    Write-Progress -Activity "Extracting OpenClaw" -Completed
    Write-Error "Extraction failed: $_"
    Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-EmptyLine

# -- 4. Copy to output location --
Write-Step "Copying to output..." 4 5

try {
    # The extracted package is in 'package/' subdirectory
    $PackageDir = "$TempDir\package"

    if (-not (Test-Path $PackageDir)) {
        # Package might have been extracted without 'package/' prefix
        $PackageDir = $TempDir
    }

    # Clean old output if exists
    if (Test-Path $Output) {
        Write-Info "Removing old output: $Output"
        Remove-Item -Recurse -Force $Output -ErrorAction SilentlyContinue
    }

    # Create output directory
    $OutputParent = Split-Path $Output -Parent
    $null = New-Item -ItemType Directory -Force -Path $OutputParent

    # Copy package content
    Copy-Item -Path "$PackageDir\*" -Destination $Output -Recurse -Force

    Write-Success "Copied to: $Output"
} catch {
    Write-Error "Copy failed: $_"
    Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-EmptyLine

# -- 5. Verify installation --
Write-Step "Verifying installation..." 5 5

$OpenClawMjs = "$Output\openclaw.mjs"
if (Test-Path $OpenClawMjs) {
    Write-Success "OpenClaw source verified"
    Write-EmptyLine

    Write-Section "Download Completed"

    # Get version from package.json if available
    $PackageJsonPath = "$Output\package.json"
    if (Test-Path $PackageJsonPath) {
        $PackageJson = Get-Content $PackageJsonPath | ConvertFrom-Json
        Write-Host "Version: " -NoNewline
        Write-Host $PackageJson.version -ForegroundColor Green
    }

    Write-Host "Location: " -NoNewline
    Write-Host $Output -ForegroundColor White
    Write-EmptyLine

    Write-Info "Next steps:"
    Write-Info "  .\build.ps1    # Build Windows installer"

} else {
    Write-Error "Verification failed: openclaw.mjs not found"
    Write-Info "Downloaded package may be invalid"
    Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

# Cleanup
Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue

exit 0
