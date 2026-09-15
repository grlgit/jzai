# -----------------------------------------------------------------------------
# sign.ps1 - Windows Code Signing Script
#
# Sign exe files using signtool
# Usage: .\sign.ps1 <exeFilePath> [outputPath]
# -----------------------------------------------------------------------------

#Requires -Version 5.1

param(
    [Parameter(Position = 0, Mandatory = $true)]
    [string]$ExePath,

    [Parameter(Position = 1)]
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"

# Get paths
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir

# Import modules
Import-Module (Join-Path $ScriptDir "lib\Logger.psm1") -Force
Import-Module (Join-Path $ScriptDir "lib\CertManager.psm1") -Force

Write-Section "Signing Windows Installer"

# Check input file
if (-not (Test-Path $ExePath)) {
    Write-Error "File not found: $ExePath"
    exit 1
}

# Set output path (if not specified)
if (-not $OutputPath) {
    $OutputPath = $ExePath
}

Write-Info "Input: $ExePath"
Write-Info "Output: $OutputPath"
Write-EmptyLine

# If input and output differ, copy first
if ($ExePath -ne $OutputPath) {
    Write-Info "Copying file..."
    Copy-Item -Path $ExePath -Destination $OutputPath -Force
}

# Get certificate path
$CertPath = Get-CertificatePath -ProjectRoot $ProjectRoot
if (-not (Test-Path $CertPath)) {
    Write-Error "Certificate file not found: $CertPath"
    Write-Info "Please run: .\generate-cert.ps1"
    exit 1
}

Write-Success "Certificate file found"

# Get certificate password
$CertPassword = Get-CertificatePassword

# Get timestamp server list
$TimestampServers = Get-TimestampServers

# Perform signing
Write-EmptyLine
Write-Step "Signing with signtool..."

try {
    $SignSuccess = Invoke-CodeSign `
        -FilePath $OutputPath `
        -CertPath $CertPath `
        -Password $CertPassword `
        -TimestampServers $TimestampServers `
        -AppName "JZAI CoWorker" `
        -AppUrl "https://jzai.ai"

    if ($SignSuccess) {
        Write-Success "Signing completed"
    } else {
        Write-Error "Signing failed"
        exit 1
    }
} catch {
    Write-Error "Signing failed: $_"
    exit 1
}

# Verify signature
Write-EmptyLine
Write-Step "Verifying signature..."

$VerifyResult = Verify-CodeSign -FilePath $OutputPath
if ($VerifyResult) {
    if ($VerifyResult.ExitCode -eq 0) {
        Write-Success "Signature verification passed"
        if ($VerifyResult.Output) {
            $VerifyResult.Output | Where-Object { $_ -match "Signer|Issuer" } | ForEach-Object {
                Write-Host "  $_" -ForegroundColor DarkGray
            }
        }
    } else {
        Write-Warning "Signature verification may have failed (expected for self-signed certs)"
    }
} else {
    Write-Warning "Cannot verify signature (signtool not available)"
}

Write-EmptyLine
Write-Section "Signing Completed"

$FileSize = (Get-Item $OutputPath).Length
$FileSizeDisplay = if ($FileSize -gt 1GB) { "{0:N1} GB" -f ($FileSize / 1GB) }
                  elseif ($FileSize -gt 1MB) { "{0:N1} MB" -f ($FileSize / 1MB) }
                  elseif ($FileSize -gt 1KB) { "{0:N0} KB" -f ($FileSize / 1KB) }
                  else { "$FileSize B" }

Write-Host "File size: $FileSizeDisplay" -ForegroundColor Cyan
Write-EmptyLine

Write-Info "NOTE: Self-signed certificates will trigger SmartScreen warnings"
Write-Info "Employees need to:"
Write-Info "  1. Install CA certificate to Trusted Root Certification Authorities"
Write-Info "  2. Or click 'More info' -> 'Run anyway' on first run"
Write-EmptyLine

exit 0
