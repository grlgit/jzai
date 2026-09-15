# -----------------------------------------------------------------------------
# install-sdk.ps1 - Windows SDK Installer Script
#
# Automatically installs Windows SDK with signtool for code signing
# Usage: .\install-sdk.ps1 [-Version <version>] [-Components <components>]
# -----------------------------------------------------------------------------

#Requires -Version 5.1

param(
    [string]$Version = "win11",  # win10 or win11
    [string]$Components = "OptionId.WindowsDesktopSDKTools",  # SDK components to install
    [switch]$Silent  # Skip interactive prompts
)

$ErrorActionPreference = "Stop"

# Get paths
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Import modules
Import-Module (Join-Path $ScriptDir "lib\Logger.psm1") -Force

Write-Section "Install Windows SDK for Code Signing"

# -- 1. Check if signtool is already installed --
Write-Step "Checking for existing signtool..." 1 6

try {
    $SignToolPath = Get-Command signtool -ErrorAction SilentlyContinue
    if ($SignToolPath) {
        Write-Success "signtool already installed"
        Write-Info "Location: $($SignToolPath.Source)"
        Write-EmptyLine
        Write-Info "No installation needed."
        exit 0
    }
} catch {
    # Continue with installation
}

Write-Info "signtool not found, installation needed"
Write-EmptyLine

# -- 2. Check winget availability --
Write-Step "Checking winget availability..." 2 6

try {
    $WingetVersion = winget --version 2>$null
    if ($WingetVersion) {
        Write-Success "winget available: $WingetVersion"
    } else {
        throw "winget not found"
    }
} catch {
    Write-Warning "winget not available"
    Write-Info "Please install Windows SDK manually:"
    Write-Info "  1. Download from: https://developer.microsoft.com/windows/downloads/windows-sdk/"
    Write-Info "  2. Or install via Visual Studio Installer"
    exit 1
}

Write-EmptyLine

# -- 3. Determine SDK package --
Write-Step "Determining SDK package..." 3 6

$SdkPackage = switch ($Version) {
    "win10" { "Microsoft.Windows.SDK" }
    "win11" { "Microsoft.WindowsSDK.2362" }  # Latest Win11 SDK
    default { "Microsoft.WindowsSDK.2362" }
}

Write-Info "Selected package: $SdkPackage"
Write-EmptyLine

# -- 4. Check disk space --
Write-Step "Checking disk space..." 4 6

$SystemDrive = $env:SystemDrive
$FreeSpace = (Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$SystemDrive'").FreeSpace
$FreeSpaceGB = [math]::Round($FreeSpace / 1GB, 2)

Write-Info "Available space: $FreeSpaceGB GB"

if ($FreeSpaceGB -lt 5) {
    Write-Warning "Less than 5 GB free space available"
    if ($Silent) {
        Write-Info "Silent mode: continuing anyway"
    } else {
        $Confirm = Read-Host "Continue anyway? (y/N)"
        if ($Confirm -ne "y") {
            Write-Info "Installation cancelled"
            exit 0
        }
    }
}

Write-EmptyLine

# -- 5. Install SDK --
Write-Step "Installing Windows SDK..." 5 6

Write-Info "This may take several minutes..."
Write-Info "Package: $SdkPackage"
Write-EmptyLine

try {
    winget install --id $SdkPackage --accept-package-agreements --accept-source-agreements -e 2>&1 | Out-Host

    if ($LASTEXITCODE -eq 0) {
        Write-Success "SDK installed successfully"
    } else {
        Write-Warning "Installation may have issues, checking signtool..."
    }
} catch {
    Write-Error "Installation failed: $_"
    Write-Info "Please install manually:"
    Write-Info "  1. Download from: https://developer.microsoft.com/windows/downloads/windows-sdk/"
    Write-Info "  2. Or install via Visual Studio Installer"
    exit 1
}

Write-EmptyLine

# -- 6. Verify installation --
Write-Step "Verifying signtool..." 6 6

# Refresh environment variables
$env:PATH = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

# Give system time to update
Start-Sleep -Seconds 2

try {
    $SignToolPath = Get-Command signtool -ErrorAction SilentlyContinue
    if ($SignToolPath) {
        Write-Success "signtool installed!"
        Write-Info "Location: $($SignToolPath.Source)"
        Write-EmptyLine

        Write-Section "Installation Completed"
        Write-Info "You can now sign executables:"
        Write-Info "  .\sign.ps1 path\to\file.exe"
    } else {
        Write-Warning "signtool not found in PATH"
        Write-Info "You may need to restart your shell or computer"
        Write-Info "Location: C:\Program Files (x86)\Windows Kits\10\bin\<arch>\signtool.exe"
    }
} catch {
    Write-Warning "Verification inconclusive"
    Write-Info "A restart may be required for PATH changes to take effect"
}

Write-EmptyLine
exit 0
