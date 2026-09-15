# -----------------------------------------------------------------------------
# Logger.psm1 - Logging Module
#
# Provides colored and formatted log output
# -----------------------------------------------------------------------------

function Get-Timestamp {
    return Get-Date -Format "HH:mm:ss"
}

function Write-ColorOutput {
    param(
        [string]$Message,
        [ConsoleColor]$ForegroundColor = $Host.UI.RawUI.ForegroundColor
    )
    $timestamp = Get-Timestamp
    Write-Host "[$timestamp] $Message" -ForegroundColor $ForegroundColor
}

function Write-Info {
    param([string]$Message)
    Write-ColorOutput "INFO  $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-ColorOutput "OK    $Message" -ForegroundColor Green
}

function Write-Error {
    param([string]$Message)
    $timestamp = Get-Timestamp
    Write-Host "[$timestamp] ERROR $Message" -ForegroundColor Red
}

function Write-Warning {
    param([string]$Message)
    $timestamp = Get-Timestamp
    Write-Host "[$timestamp] WARN  $Message" -ForegroundColor Yellow
}

function Write-Step {
    param(
        [string]$Message,
        [int]$Step = 0,
        [int]$Total = 0
    )
    if ($Total -gt 0) {
        Write-ColorOutput "[$Step/$Total] $Message" -ForegroundColor White
    } else {
        Write-ColorOutput $Message -ForegroundColor White
    }
}

function Write-Section {
    param([string]$Title)
    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ""
}

function Write-EmptyLine {
    Write-Host ""
}

# Export functions
Export-ModuleMember -Function Write-ColorOutput, Write-Info, Write-Success, Write-Error, Write-Warning, Write-Step, Write-Section, Write-EmptyLine, Get-Timestamp
