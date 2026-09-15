# -----------------------------------------------------------------------------
# check-env.ps1 - Environment Check Script
#
# Check if environment meets build requirements
# Usage: .\check-env.ps1
# -----------------------------------------------------------------------------

#Requires -Version 5.1

$ErrorActionPreference = "Stop"

# Get script directory
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir

# Import modules
Import-Module (Join-Path $ScriptDir "lib\Logger.psm1") -Force

Write-Section "JZAI CoWorker - Environment Check"

$ChecksPassed = 0
$ChecksFailed = 0

function Test-Pass {
    param([string]$Message)
    Write-Success $Message
    $script:ChecksPassed++
}

function Test-Fail {
    param([string]$Message)
    Write-Error $Message
    $script:ChecksFailed++
}

function Test-Warn {
    param([string]$Message)
    Write-Warning $Message
}

# -- 1. Check Node.js --
Write-Step "Checking Node.js..." 1 9

try {
    $NodeVersionOutput = node -v 2>$null
    if ($NodeVersionOutput) {
        $VersionString = $NodeVersionOutput -replace 'v', ''
        $MajorVersion = [int]($VersionString.Split('.')[0])

        if ($MajorVersion -ge 18) {
            Test-Pass "Node.js $VersionString (>=18)"
        } else {
            Test-Fail "Node.js version too low: $VersionString (need >=18)"
        }
    } else {
        Test-Fail "Node.js not found, please install Node.js 18+"
    }
} catch {
    Test-Fail "Node.js not found, please install Node.js 18+"
}

# -- 2. Check npm --
Write-EmptyLine
Write-Step "Checking npm..." 2 9

try {
    $NpmVersionOutput = npm -v 2>$null
    if ($NpmVersionOutput) {
        Test-Pass "npm $NpmVersionOutput"
    } else {
        Test-Fail "npm not found"
    }
} catch {
    Test-Fail "npm not found"
}

# -- 3. Check platform --
Write-EmptyLine
Write-Step "Checking platform..." 3 9

$IsWindows = $true
if ($PSVersionTable.PSVersion.Major -ge 6) {
    $IsWindows = -not $IsLinux -and -not $IsMacOS
}

if ($IsWindows) {
    Test-Pass "Windows platform"
} else {
    Test-Warn "Not Windows platform, consider using Linux/macOS build script (build.sh)"
}

# -- 4. Check PowerShell execution policy --
Write-EmptyLine
Write-Step "Checking PowerShell execution policy..." 4 9

$ExecutionPolicy = Get-ExecutionPolicy
if ($ExecutionPolicy -eq "Restricted" -or $ExecutionPolicy -eq "Undefined") {
    Test-Warn "Execution policy restricted: $ExecutionPolicy"
    Write-Info "  May need to set: Set-ExecutionPolicy RemoteSigned -Scope CurrentUser"
} else {
    Test-Pass "Execution policy: $ExecutionPolicy"
}

# -- 5. Check signing tools --
Write-EmptyLine
Write-Step "Checking signing tools..." 5 9

try {
    $SignToolPath = Get-Command signtool -ErrorAction SilentlyContinue
    if ($SignToolPath) {
        Test-Pass "signtool installed ($($SignToolPath.Source))"
    } else {
        Test-Warn "signtool not found (Windows SDK signing tool)"
        Write-Info "  Install Windows SDK for signing"
    }
} catch {
    Test-Warn "signtool not found (Windows SDK signing tool)"
}

# -- 6. Check certificate files --
Write-EmptyLine
Write-Step "Checking certificate files..." 6 9

$CertPfxPath = Join-Path $ProjectRoot "certificates\jzai-code-signing.pfx"
$CertCrtPath = Join-Path $ProjectRoot "certificates\jzai-code-signing.crt"
$CertKeyPath = Join-Path $ProjectRoot "certificates\jzai-code-signing.key"

if (Test-Path $CertPfxPath) {
    Test-Pass "Certificate file found: jzai-code-signing.pfx"
} elseif (Test-Path $CertCrtPath) {
    Test-Pass "Certificate file found: jzai-code-signing.crt + .key"
} else {
    Test-Warn "Certificate files not found, need to generate"
    Write-Info "  Run: .\generate-cert.ps1"
}

# -- 7. Check if dependencies installed --
Write-EmptyLine
Write-Step "Checking project dependencies..." 7 9

$NodeModulesPath = Join-Path $ProjectRoot "node_modules"
if (Test-Path $NodeModulesPath) {
    try {
        $DepsCount = (Get-ChildItem -Path $NodeModulesPath -Directory -ErrorAction SilentlyContinue | Measure-Object).Count
        Test-Pass "Dependencies installed ($DepsCount packages)"
    } catch {
        Test-Warn "Dependencies directory may be corrupted, consider running npm install"
    }
} else {
    Test-Warn "Dependencies not installed, need to run npm install first"
}

# -- 8. Check required resources --
Write-EmptyLine
Write-Step "Checking required resources..." 8 9

$IconPath = Join-Path $ProjectRoot "assets\icon.ico"
$InstallerIconPath = Join-Path $ProjectRoot "assets\installer-icon.ico"
$ResourcesOk = $true

if (-not (Test-Path $IconPath)) {
    Test-Warn "Missing icon: assets\icon.ico"
    $ResourcesOk = $false
}

if (-not (Test-Path $InstallerIconPath)) {
    Test-Warn "Missing installer icon: assets\installer-icon.ico"
    $ResourcesOk = $false
}

if ($ResourcesOk) {
    Test-Pass "Icon resources complete"
}

# -- 9. Check OpenClaw submodule --
Write-EmptyLine
Write-Step "Checking OpenClaw submodule..." 9 9

$OpenClawPath = Join-Path (Split-Path $ProjectRoot -Parent) "openclaw"
if (Test-Path $OpenClawPath) {
    $OpenClawMjs = Join-Path $OpenClawPath "openclaw.mjs"
    if (Test-Path $OpenClawMjs) {
        Test-Pass "OpenClaw submodule exists"
    } else {
        Test-Warn "OpenClaw submodule not initialized"
        Write-Info "  Run: git submodule update --init --recursive"
    }
} else {
    Test-Warn "OpenClaw submodule not found"
    Write-Info "  Run: git submodule update --init --recursive"
}

# -- Summary --
Write-EmptyLine
Write-Section "Check Results"
Write-Info "Passed: $ChecksPassed"
Write-Error "Failed: $ChecksFailed"

if ($ChecksFailed -eq 0) {
    Write-EmptyLine
    Write-Success "Environment check passed, ready to build"
    exit 0
} else {
    Write-EmptyLine
    Write-Error "Environment check failed, please fix issues above"
    exit 1
}
