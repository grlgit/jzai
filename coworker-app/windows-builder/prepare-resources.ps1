# -----------------------------------------------------------------------------
# prepare-resources.ps1 - Resource Preparation Script
#
# Prepare necessary extensions and plugins before build
# Usage: .\prepare-resources.ps1 [-SkipWeixin]
# -----------------------------------------------------------------------------

#Requires -Version 5.1

param(
    [switch]$SkipWeixin,
    [string]$OpenClawPath  # Allow manual specification of OpenClaw path
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

# Find OpenClaw source root
$OpenClawRoot = $null
$OpenClawSearchPaths = @(
    "$RepoRoot\openclaw",
    "$ProjectRoot\openclaw",
    "$ProjectRoot\..\openclaw",
    "D:\menhu.ai\openclaw",
    "D:\openclaw"
)

Write-Info "Project Root: $ProjectRoot"
Write-Info "Repo Root: $RepoRoot"
Write-Info "Searching for OpenClaw source directory..."

foreach ($path in $OpenClawSearchPaths) {
    $TestPath = "$path\openclaw.mjs"
    $Exists = Test-Path $TestPath
    $Status = if ($Exists) { "FOUND" } else { "NOT FOUND" }
    Write-Info "  Checking: $TestPath - $Status"
    if ($Exists) {
        $OpenClawRoot = $path
        break
    }
}

if ($OpenClawRoot) {
    Write-Success "Found OpenClaw source: $OpenClawRoot"

    # Check if dist/ directory exists
    $DistPath = "$OpenClawRoot\dist"
} elseif ($OpenClawPath) {
    # Use manually specified path
    if (Test-Path "$OpenClawPath\openclaw.mjs") {
        $OpenClawRoot = $OpenClawPath
        Write-Success "Using specified OpenClaw path: $OpenClawRoot"
        $DistPath = "$OpenClawRoot\dist"
    } else {
        Write-Error "Specified OpenClaw path is invalid: $OpenClawPath"
    }
} else {
    Write-Warning "OpenClaw source directory not found"
    Write-Info "Searched paths:"
    foreach ($path in $OpenClawSearchPaths) {
        Write-Info "  - $path"
    }
    Write-Info "To specify manually, use: .\prepare-resources.ps1 -OpenClawPath <path>"
}

# Import modules
Import-Module "$ScriptDir\lib\Logger.psm1" -Force
Import-Module "$ScriptDir\lib\FileOps.psm1" -Force

Write-Section "Windows Client Resource Preparation"

# -- 1. Create directory structure --
Write-Step "Creating directory structure..." 1 4

$ResourcesDir = "$ProjectRoot\resources"
$OpenClawTargetDir = "$ResourcesDir\openclaw"

Initialize-ResourceDirectory -ResourcesPath $ResourcesDir -SubDirectories @("openclaw")

Write-Success "Directory structure created"

# -- 2. Copy jianzhi-bridge extension --
Write-EmptyLine
Write-Step "Copying jianzhi-bridge extension..." 2 4

# Try multiple possible locations for jianzhi-bridge
$JianzhiBridgeLocations = @(
    "$RepoRoot\openclaw\extensions\jianzhi-bridge",
    "$ProjectRoot\openclaw\extensions\jianzhi-bridge",
    "$ProjectRoot\resources\openclaw\extensions\jianzhi-bridge",
    "$ProjectRoot\openclaw",  # Downloaded OpenClaw (check for extensions subfolder)
    "D:\openclaw\extensions\jianzhi-bridge",
    "D:\menhu.ai\openclaw\extensions\jianzhi-bridge"
)

$JianzhiBridgeSource = $null
foreach ($path in $JianzhiBridgeLocations) {
    if (Test-Path $path) {
        # Check if this is the actual jianzhi-bridge directory
        if (Test-Path "$path\plugin.js") {
            $JianzhiBridgeSource = $path
            break
        }
        # Check if it's a parent directory
        if (Test-Path "$path\jianzhi-bridge\plugin.js") {
            $JianzhiBridgeSource = "$path\jianzhi-bridge"
            break
        }
    }
}

# Target: OpenClaw's extensions directory (not top-level extensions/)
$JianzhiBridgeTarget = "$OpenClawTargetDir\extensions\jianzhi-bridge"

if (-not $JianzhiBridgeSource) {
    Write-Error "jianzhi-bridge not found (REQUIRED)"
    Write-EmptyLine
    Write-Host "============================================" -ForegroundColor Red
    Write-Host "  RESOURCE PREPARATION FAILED" -ForegroundColor Red
    Write-Host "============================================" -ForegroundColor Red
    Write-EmptyLine
    Write-Info "Checked locations:"
    foreach ($path in $JianzhiBridgeLocations) {
        $exists = if (Test-Path $path) { "EXISTS" } else { "not found" }
        Write-Host "  [$exists] $path" -ForegroundColor DarkGray
    }
    Write-EmptyLine
    Write-Info "Solutions:"
    Write-Info "  1. Initialize git submodule:"
    Write-Host "     cd ..\.." -ForegroundColor Yellow
    Write-Host "     git submodule update --init --recursive" -ForegroundColor Yellow
    Write-EmptyLine
    Write-Info "  2. Copy manually:"
    Write-Host "     .\copy-bridge.ps1 -Source '<path>'" -ForegroundColor Yellow
    Write-EmptyLine
    exit 1
}

Write-Info "Found jianzhi-bridge at: $JianzhiBridgeSource"

# Clean old files
if (Test-Path $JianzhiBridgeTarget) {
    Remove-Item -Recurse -Force $JianzhiBridgeTarget
}

# Copy extension
try {
    Write-Info "Copying files..."
    Copy-Item -Path $JianzhiBridgeSource -Destination $JianzhiBridgeTarget -Recurse -Force

    # Verify copy
    if (Test-Path "$JianzhiBridgeTarget\plugin.js") {
        Write-Success "jianzhi-bridge copied and verified"
    } else {
        Write-Error "Copy completed but plugin.js not found"
        exit 1
    }
} catch {
    Write-Error "jianzhi-bridge copy failed: $_"
    exit 1
}

# -- 3. Pre-install WeChat plugin (default enabled) --
Write-EmptyLine
Write-Step "Pre-installing WeChat plugin..." 3 4

# Check env var
$InstallWeixin = if ($env:INSTALL_WECHAT) { $env:INSTALL_WECHAT -eq 'true' } else { $true }

if ($SkipWeixin) {
    $InstallWeixin = $false
}

if ($InstallWeixin) {
    $WeixinTarget = "$OpenClawTargetDir\extensions\"

    # Clean old files
    if (Test-Path $WeixinTarget) {
        Remove-Item -Recurse -Force $WeixinTarget
    }
    $null = New-Item -ItemType Directory -Force -Path $WeixinTarget

    # Install WeChat plugin using npx for better compatibility
    Write-Info "Installing @tencent-weixin/openclaw-weixin@latest..."
    Write-EmptyLine

    try {
        Push-Location $WeixinTarget

        # Find npm executable (prefer .exe over .ps1 wrapper)
        $NpmCmd = Get-Command npm -ErrorAction SilentlyContinue
        if (-not $NpmCmd) {
            throw "npm not found in PATH"
        }

        # If npm.ps1, try to find npm.exe instead
        if ($NpmCmd.Source -like "*.ps1") {
            $NpmExe = Join-Path $NpmCmd.Path "..\npm.exe"
            if (Test-Path $NpmExe) {
                $NpmCmd = [PSCustomObject]@{ Source = $NpmExe }
            }
        }

        Write-Info "Using npm: $($NpmCmd.Source)"

        # Run npm install and capture all output including stderr
        $ErrorActionPreference = "Continue"
        $Output = & npm install @tencent-weixin/openclaw-weixin@latest --no-fund --no-audit --loglevel=info 2>&1
        $NpmExitCode = $LASTEXITCODE
        $ErrorActionPreference = "Stop"

        Pop-Location

        # Show relevant output and detect errors
        $HasErrors = $false
        $Output | ForEach-Object {
            # Convert to string and handle ErrorRecord objects
            $LineString = if ($_ -is [System.Management.Automation.ErrorRecord]) {
                $_.Exception.Message
            } else {
                "$_"  # Ensure it's a string
            }

            if ($LineString -match "http fetch") {
                Write-Host "  $($LineString.Trim())" -ForegroundColor DarkGray
            } elseif ($LineString -match "added (\d+) packages?") {
                Write-Success "Packages added: $($matches[1])"
            } elseif ($LineString -match "up to date") {
                Write-Success "Plugin already up to date"
            } elseif ($LineString -match "npm ERR!") {
                Write-Host "  $LineString" -ForegroundColor Red
                $HasErrors = $true
            } elseif ($LineString -match "ERR!\s+(.+)") {
                Write-Host "  ERROR: $($matches[1])" -ForegroundColor Red
                $HasErrors = $true
            }
        }

        # Check result
        if ($NpmExitCode -eq 0 -and -not $HasErrors) {
            if (Test-Path "$WeixinTarget\node_modules\@tencent-weixin") {
                Write-Success "WeChat plugin installed"
            } else {
                Write-Warning "WeChat plugin installation incomplete (npm succeeded but files not found)"
            }
        } else {
            Write-Warning "WeChat plugin installation failed (exit code: $NpmExitCode)"
            Write-Info "Client will retry on first start"
        }

    } catch {
        Pop-Location -ErrorAction SilentlyContinue
        Write-Warning "WeChat plugin installation failed: $($_.Exception.Message)"
        Write-Info "Client will retry on first start"
    }
} else {
    Write-Info "Skip WeChat plugin pre-install (-SkipWeixin specified)"
}

# -- 4. Download OpenClaw runtime from npmmirror (official source) --
Write-EmptyLine
Write-Step "Downloading OpenClaw runtime from npmmirror..." 4 4

# Query latest version from npm registry (npmmirror requires semver format)
Write-Info "Querying latest OpenClaw version from npm registry..."
try {
    $RegistryUrl = "https://registry.npmmirror.com/openclaw"
    $RegistryInfo = Invoke-RestMethod -Uri $RegistryUrl -UseBasicParsing -TimeoutSec 30
    $OpenClawVersion = $RegistryInfo."dist-tags".latest

    if (-not $OpenClawVersion) {
        throw "Failed to get latest version from registry"
    }

    Write-Success "Latest version: $OpenClawVersion"
} catch {
    Write-Error "Failed to query version from npm registry: $_"
    Write-Info "Falling back to hardcoded version..."
    $OpenClawVersion = "2026.7.1-2"  # Known good version as fallback
    Write-Info "Using fallback version: $OpenClawVersion"
}

# Download URL using semver version (npmmirror rejects 'latest')
$OpenClawDownloadUrl = "https://registry.npmmirror.com/openclaw/-/openclaw-$OpenClawVersion.tgz"

Write-Info "Download URL: $OpenClawDownloadUrl"

# Create temp directory for download and extraction
$TempDir = Join-Path $env:TEMP "openclaw-tmp-$(Get-Random)"
$TarballPath = Join-Path $env:TEMP "openclaw-$OpenClawVersion.tgz"

try {
    New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
    Write-Info "Created temp directory: $TempDir"

    # Download tarball
    Write-Info "Downloading OpenClaw tarball..."
    Invoke-WebRequest -Uri $OpenClawDownloadUrl -OutFile $TarballPath -UseBasicParsing
    Write-Success "Download completed"

    # Extract tarball
    Write-Info "Extracting tarball..."
    tar -xzf $TarballPath -C $TempDir
    Write-Success "Extraction completed"

    # Find the package directory (npm tarballs extract to 'package/' subdirectory)
    $PackageDir = Join-Path $TempDir "package"
    if (-not (Test-Path (Join-Path $PackageDir "package.json"))) {
        # Try flat structure
        if (Test-Path (Join-Path $TempDir "package.json")) {
            $PackageDir = $TempDir
        } else {
            throw "Could not find extracted package directory"
        }
    }

    Write-Info "Package directory: $PackageDir"

    # Copy to resources
    Write-Info "Copying to resources..."

    # Clean target directory first
    if (Test-Path $OpenClawTargetDir) {
        Remove-Item -Recurse -Force $OpenClawTargetDir -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force -Path $OpenClawTargetDir | Out-Null

    # Copy all files
    Copy-Item -Path "$PackageDir\*" -Destination $OpenClawTargetDir -Recurse -Force

    # Install production dependencies (npm 包不含 node_modules，需单独安装)
    Write-Info "Installing OpenClaw production dependencies..."
    Write-EmptyLine

    Push-Location $OpenClawTargetDir
    try {
        $ErrorActionPreference = "Continue"

        # 检查 package-lock.json 是否存在
        $HasLockFile = Test-Path "package-lock.json"

        if ($HasLockFile) {
            Write-Info "Using npm ci (package-lock.json found)..."
            $Output = & npm ci --omit=dev 2>&1
        } else {
            Write-Info "Using npm install --production (no lock file)..."
            $Output = & npm install --production 2>&1
        }

        $NpmExitCode = $LASTEXITCODE
        $ErrorActionPreference = "Stop"

        # Show output
        $Output | ForEach-Object {
            $LineString = if ($_ -is [System.Management.Automation.ErrorRecord]) {
                $_.Exception.Message
            } else {
                "$_"
            }

            if ($LineString -match "added (\d+) packages?") {
                Write-Success "Dependencies installed: $($matches[1]) packages"
            } elseif ($LineString -match "audited (\d+) packages") {
                Write-Success "Dependencies audited: $($matches[1]) packages"
            } elseif ($LineString -match "npm ERR!") {
                Write-Host "  $LineString" -ForegroundColor Red
            }
        }

        if ($NpmExitCode -eq 0) {
            Write-Success "OpenClaw dependencies installed successfully"
        } else {
            Write-Warning "Dependency installation had issues (exit code: $NpmExitCode)"
            Write-Info "OpenClaw may not work correctly without dependencies"
        }

    } catch {
        Write-Warning "Dependency installation failed: $($_.Exception.Message)"
        Write-Info "OpenClaw may not work without dependencies"
    } finally {
        Pop-Location
    }

    Write-EmptyLine

    # Verify critical files
    $HasMjs = Test-Path "$OpenClawTargetDir\openclaw.mjs"
    $HasEntryMjs = Test-Path "$OpenClawTargetDir\dist\entry.mjs"

    if ($HasMjs) {
        Write-Success "Verified: openclaw.mjs"
    } else {
        Write-Warning "WARNING: openclaw.mjs not found"
    }

    if ($HasEntryMjs) {
        Write-Success "Verified: dist/entry.mjs (CRITICAL for runtime)"
    } else {
        Write-Error "ERROR: dist/entry.mjs missing - OpenClaw will not work!"
    }

    $FileCount = (Get-ChildItem -Path $OpenClawTargetDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
    Write-Success "OpenClaw runtime copied ($FileCount files)"

} catch {
    Write-Error "Failed to download OpenClaw: $_"
    throw
} finally {
    # Cleanup temp files
    try {
        if (Test-Path $TempDir) {
            Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
        }
        if (Test-Path $TarballPath) {
            Remove-Item -Force $TarballPath -ErrorAction SilentlyContinue
        }
        Write-Info "Cleaned up temp files"
    } catch {
        # Ignore cleanup errors
    }
}

# -- Done --
Write-EmptyLine
Write-Success "Resource preparation completed"
Write-EmptyLine

Write-Info "Resource directory structure:"
try {
    Get-ChildItem -Path $ResourcesDir -Recurse -Depth 2 -ErrorAction SilentlyContinue | ForEach-Object {
        $prefix = if ($_.PSIsContainer) { "[DIR] " } else { "[FILE] " }
        $relativePath = $_.FullName.Substring($ResourcesDir.Length + 1)
        Write-Host "  $prefix$relativePath" -ForegroundColor DarkGray
    }
} catch {
    Write-Info "  (Cannot list detailed structure)"
}

Write-EmptyLine
Write-Info "Next steps:"
Write-Info "  .\build.ps1          # Build Windows installer"
Write-Info "  npm run build:win    # Or use npm script to build"
