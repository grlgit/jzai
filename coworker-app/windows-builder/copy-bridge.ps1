# -----------------------------------------------------------------------------
# copy-bridge.ps1 - Copy jianzhi-bridge to Build Directory
#
# Copies jianzhi-bridge extension to the build resources directory
# Usage: .\copy-bridge.ps1 [-Source <path>] [-Target <path>]
# -----------------------------------------------------------------------------

#Requires -Version 5.1

param(
    [string]$Source = "",
    [string]$Target = ""
)

$ErrorActionPreference = "Stop"

# Get paths
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir

# Get RepoRoot using DirectoryInfo
$DirInfo = Get-Item $ProjectRoot -ErrorAction SilentlyContinue
$RepoRoot = if ($DirInfo.PSIsContainer) { $DirInfo.Parent.FullName } else { Split-Path $ProjectRoot }

# Ensure strings
if ($ProjectRoot -is [System.Array]) { $ProjectRoot = $ProjectRoot[0] }
if ($RepoRoot -is [System.Array]) { $RepoRoot = $RepoRoot[0] }

# Import modules
Import-Module "$ScriptDir\lib\Logger.psm1" -Force

Write-Section "Copy jianzhi-bridge Extension"

# -- 1. Determine source path --
Write-Step "Determining source path..." 1 4

if (-not $Source) {
    # Try default locations - more comprehensive list
    $DefaultSources = @(
        "$RepoRoot\openclaw\extensions\jianzhi-bridge",
        "$ProjectRoot\openclaw\extensions\jianzhi-bridge",
        "$ProjectRoot\resources\openclaw\extensions\jianzhi-bridge",
        "$ProjectRoot\resources\extensions\jianzhi-bridge",
        "$ProjectRoot\openclaw",
        "D:\openclaw\extensions\jianzhi-bridge",
        "D:\menhu.ai\openclaw\extensions\jianzhi-bridge"
    )

    foreach ($path in $DefaultSources) {
        if (Test-Path $path) {
            # Check if it's the jianzhi-bridge directory itself
            if (Test-Path "$path\plugin.js") {
                $Source = $path
                break
            }
            # Check if it's a parent directory containing jianzhi-bridge
            $subPath = "$path\jianzhi-bridge"
            if (Test-Path $subPath) {
                if (Test-Path "$subPath\plugin.js") {
                    $Source = $subPath
                    break
                }
            }
        }
    }

    if (-not $Source) {
        Write-Error "jianzhi-bridge source not found (REQUIRED for build)"
        Write-EmptyLine
        Write-Info "Searched locations:"
        foreach ($path in $DefaultSources) {
            Write-Host "  - $path" -ForegroundColor DarkGray
        }
        Write-EmptyLine
        Write-Host "REQUIRED: jianzhi-bridge must be present for build" -ForegroundColor Red
        Write-EmptyLine
        Write-Info "Solutions:"
        Write-Info "  1. Initialize git submodule:" -ForegroundColor Yellow
        Write-Info "     cd ..\.. && git submodule update --init --recursive" -ForegroundColor Yellow
        Write-Info "  2. Copy from existing location:" -ForegroundColor Yellow
        Write-Info "     .\copy-bridge.ps1 -Source '<path>'" -ForegroundColor Yellow
        Write-EmptyLine
        exit 1
    }
}

if (-not (Test-Path $Source)) {
    Write-Error "Source path not found: $Source"
    exit 1
}

Write-Success "Source found: $Source"
Write-EmptyLine

# -- 2. Determine target path --
Write-Step "Determining target path..." 2 4

if (-not $Target) {
    $Target = "$ProjectRoot\resources\extensions\jianzhi-bridge"
}

# Create target directory if needed
$TargetParent = Split-Path $Target -Parent
if (-not (Test-Path $TargetParent)) {
    $null = New-Item -ItemType Directory -Force -Path $TargetParent
}

Write-Info "Target: $Target"
Write-EmptyLine

# -- 3. Copy extension --
Write-Step "Copying jianzhi-bridge extension..." 3 4

try {
    # Remove old copy if exists
    if (Test-Path $Target) {
        Write-Info "Removing old copy..."
        Remove-Item -Recurse -Force $Target
    }

    # Copy extension
    Write-Info "Copying files..."
    Copy-Item -Path $Source -Destination $Target -Recurse -Force

    Write-Success "Extension copied"
} catch {
    Write-Error "Copy failed: $_"
    exit 1
}

Write-EmptyLine

# -- 4. Verify copy --
Write-Step "Verifying copy..." 4 4

$RequiredFiles = @(
    "plugin.js",
    "openclaw.plugin.json",
    "package.json"
)

$AllFilesPresent = $true
foreach ($file in $RequiredFiles) {
    $filePath = "$Target\$file"
    if (Test-Path $filePath) {
        Write-Host "  $file - OK" -ForegroundColor Green
    } else {
        Write-Host "  $file - MISSING" -ForegroundColor Red
        $AllFilesPresent = $false
    }
}

Write-EmptyLine

if ($AllFilesPresent) {
    Write-Section "Copy Completed Successfully"
    Write-Info "jianzhi-bridge is ready for build"
    Write-EmptyLine
    Write-Info "Next steps:"
    Write-Info "  .\build.ps1    # Build Windows installer"
    exit 0
} else {
    Write-Error "Verification failed: some files are missing"
    Write-Info "Source may be incomplete"
    exit 1
}
