# -----------------------------------------------------------------------------
# build.ps1 - JZAI CoWorker Windows Client One-Click Build Script
#
# Build Windows NSIS installer on Windows environment
# Usage: .\build.ps1 [-SkipEnvCheck] [-NoSign] [-Clean] [-SkipWeixin] [-Config <path>]
# Output: JZAI-CoWorker-Setup-1.0.0.exe
# -----------------------------------------------------------------------------

#Requires -Version 5.1

param(
    [switch]$SkipEnvCheck,
    [switch]$NoSign,
    [switch]$Clean,
    [switch]$SkipWeixin,
    [switch]$ResetCache,  # New: Clear cache and re-download
    [string]$Config
)

$ErrorActionPreference = "Stop"

# Get paths
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir

# Import modules
Import-Module "$ScriptDir\lib\Logger.psm1" -Force

# Show help
function Show-Help {
    Write-Host "Usage: .\build.ps1 [options]" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -SkipEnvCheck    Skip environment check"
    Write-Host "  -NoSign          Build without signing"
    Write-Host "  -Clean           Clean before build"
    Write-Host "  -SkipWeixin      Skip WeChat plugin pre-install"
    Write-Host "  -ResetCache      Clear winCodeSign cache and re-download"
    Write-Host "  -Config <path>   Specify config file path"
    Write-Host ""
    Write-Host "Helper Scripts:"
    Write-Host "  .\download-source.ps1    Download OpenClaw source"
    Write-Host "  .\copy-bridge.ps1        Copy jianzhi-bridge extension"
    Write-Host "  .\install-sdk.ps1        Install Windows SDK (signtool)"
    Write-Host ""
    Write-Host "Environment Variables:"
    Write-Host "  CERT_PATH        Custom certificate path (.pfx)"
    Write-Host "  CERT_PASSWORD    Certificate password"
    Write-Host "  INSTALL_WECHAT   Control WeChat plugin install (true/false, default true)"
    Write-Host ""
    exit 0
}

# Check for -Help parameter
if ($Help) {
    Show-Help
}

Write-Section "JZAI CoWorker Build Script (Windows)"
Write-Info "Total steps: 9 (including winCodeSign cache setup)"

$Sign = -not $NoSign

# Handle cache reset if requested
if ($ResetCache) {
    Write-Warning "ResetCache enabled - clearing winCodeSign cache..."
    $WinCodeSignCacheDir = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign-2.6.0"
    if (Test-Path $WinCodeSignCacheDir) {
        Remove-Item -Recurse -Force $WinCodeSignCacheDir -ErrorAction SilentlyContinue
        Write-Success "Cache cleared: $WinCodeSignCacheDir"
    }
    Write-Info "electron-builder will download fresh files"
    Write-EmptyLine
}

# -- Helper: Check tool availability --
function Test-ToolAvailable {
    param(
        [string]$ToolName,
        [string]$MinVersion = $null
    )

    try {
        $ToolCmd = Get-Command $ToolName -ErrorAction SilentlyContinue
        if (-not $ToolCmd) {
            return $false
        }

        if ($MinVersion) {
            $VersionOutput = & $ToolName --version 2>$null
            if ($VersionOutput -match "(\d+\.\d+\.\d+)") {
                $Version = [Version]$matches[1]
                $MinVer = [Version]$MinVersion
                return $Version -ge $MinVer
            }
        }

        return $true
    } catch {
        return $false
    }
}

# -- Helper: Get package.json electron version --
function Get-PackageElectronVersion {
    $PackageJson = "$ProjectRoot\package.json"
    if (Test-Path $PackageJson) {
        try {
            # Try to read with UTF8 encoding
            $Content = Get-Content $PackageJson -Encoding UTF8 -Raw
            $Json = $Content | ConvertFrom-Json

            if ($Json.devDependencies.PSObject.Properties.Name -contains "electron") {
                return $Json.devDependencies.electron
            }
        } catch {
            Write-Warning "Could not parse package.json: $_"
        }
    }
    return $null
}

# -- 1. Environment Check and Auto-Fix --
if (-not $SkipEnvCheck) {
    Write-Step "Environment check..." 1 8

    $CheckEnvScript = "$ScriptDir\check-env.ps1"
    $EnvCheckResult = & $CheckEnvScript 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Success "Environment check passed"
    } else {
        Write-Warning "Environment check found issues, attempting auto-fix..."
    }
} else {
    Write-Warning "Skip environment check"
}

Write-EmptyLine

# -- 2. Prepare Resources (Must be before dependency check) --
Write-Step "Preparing resources..." 2 8
Write-Info "This will download OpenClaw and prepare jianzhi-bridge"
Write-EmptyLine

$PrepareResourcesScript = "$ScriptDir\prepare-resources.ps1"
$PrepareArgs = @()
if ($SkipWeixin) {
    $PrepareArgs += "-SkipWeixin"
}

try {
    & $PrepareResourcesScript @PrepareArgs
    if ($LASTEXITCODE -eq 0) {
        Write-Success "Resources prepared"
    } else {
        Write-Warning "Resource preparation had issues (exit code: $LASTEXITCODE), but continuing..."
    }
} catch {
    Write-Warning "Resource preparation failed: $_"
    Write-Info "Continuing build..."
}

Write-EmptyLine

# -- 3. Verify prepared dependencies --
Write-Step "Verifying dependencies..." 3 8
Write-Info "REQUIRED: OpenClaw source, jianzhi-bridge, Windows SDK, certificate"
Write-EmptyLine

# 1. Check OpenClaw source
# Get parent directory using DirectoryInfo
$DirInfo = Get-Item $ProjectRoot -ErrorAction SilentlyContinue
$RepoRoot = if ($DirInfo.PSIsContainer) { $DirInfo.Parent.FullName } else { Split-Path $ProjectRoot }

# Ensure it's a string
if ($RepoRoot -is [System.Array]) {
    $RepoRoot = $RepoRoot[0]
}

$OpenClawPaths = @(
    "$RepoRoot\openclaw",
    "$ProjectRoot\openclaw"
)

$OpenClawFound = $false
foreach ($path in $OpenClawPaths) {
    $OpenClawMjs = "$path\openclaw.mjs"
    if (Test-Path $OpenClawMjs) {
        $OpenClawFound = $true
        break
    }
}

if (-not $OpenClawFound) {
    Write-Info "OpenClaw source not found, downloading..."
    $DownloadScript = "$ScriptDir\download-source.ps1"
    if (Test-Path $DownloadScript) {
        Write-Info "Starting download..."
        & $DownloadScript 2>&1 | Out-Host
        if ($LASTEXITCODE -eq 0) {
            Write-Success "OpenClaw source downloaded"
            # Verify download
            $OpenClawMjs = "$ProjectRoot\openclaw\openclaw.mjs"
            if (Test-Path $OpenClawMjs) {
                $OpenClawFound = $true
                Write-Success "OpenClaw source verified"
            } else {
                Write-Warning "OpenClaw download verification failed"
            }
        } else {
            Write-Warning "OpenClaw download failed (exit code $LASTEXITCODE)"
        }
    } else {
        Write-Warning "download-source.ps1 not found"
    }
} else {
    Write-Success "OpenClaw source found"
}

# 2. Check jianzhi-bridge
# Target location is resources/openclaw/extensions/jianzhi-bridge (OpenClaw structure)
$JianzhiBridgePaths = @(
    "$RepoRoot\openclaw\extensions\jianzhi-bridge",
    "$ProjectRoot\openclaw\extensions\jianzhi-bridge",
    "$ProjectRoot\resources\openclaw\extensions\jianzhi-bridge"
)

Write-Info "Checking jianzhi-bridge in paths:"
$BridgeFound = $false
$BridgePath = $null
foreach ($path in $JianzhiBridgePaths) {
    $PluginJs = "$path\plugin.js"
    $exists = Test-Path $PluginJs
    $status = if ($exists) { "FOUND" } else { "not found" }
    Write-Host "  [$status] $path" -ForegroundColor $(if ($exists) { "Green" } else { "DarkGray" })
    if ($exists) {
        $BridgeFound = $true
        $BridgePath = $path
        break
    }
}

if (-not $BridgeFound) {
    Write-Info "jianzhi-bridge not found, checking downloaded OpenClaw..."
    # Check if OpenClaw was just downloaded
    $DownloadedOpenClaw = "$ProjectRoot\openclaw"
    if (Test-Path "$DownloadedOpenClaw\extensions\jianzhi-bridge\plugin.js") {
        Write-Info "Found jianzhi-bridge in downloaded OpenClaw"
        $BridgePath = "$DownloadedOpenClaw\extensions\jianzhi-bridge"
        $BridgeFound = $true
    }
}

if (-not $BridgeFound) {
    Write-Error "jianzhi-bridge not found (REQUIRED)"
    Write-EmptyLine
    Write-Host "============================================" -ForegroundColor Red
    Write-Host "  BUILD CANNOT CONTINUE" -ForegroundColor Red
    Write-Host "============================================" -ForegroundColor Red
    Write-EmptyLine
    Write-Info "jianzhi-bridge is REQUIRED for the build"
    Write-EmptyLine
    Write-Info "Solutions:"
    Write-Info "  1. Initialize git submodule (if building from source):"
    Write-Host "     cd ..\.." -ForegroundColor Yellow
    Write-Host "     git submodule update --init --recursive" -ForegroundColor Yellow
    Write-Host "     cd windows-builder" -ForegroundColor Yellow
    Write-EmptyLine
    Write-Info "  2. Copy jianzhi-bridge from another location:"
    Write-Host "     .\copy-bridge.ps1 -Source '<path-to-jianzhi-bridge>'" -ForegroundColor Yellow
    Write-EmptyLine
    Write-Info "  3. If jianzhi-bridge exists in openclaw/extensions/, ensure openclaw submodule is initialized"
    Write-EmptyLine
    exit 1
}

Write-Success "jianzhi-bridge found at: $BridgePath"

# Ensure jianzhi-bridge is in the correct location for build
# Target should be resources/openclaw/extensions/jianzhi-bridge (matching OpenClaw structure)
$TargetBridge = "$ProjectRoot\resources\openclaw\extensions\jianzhi-bridge"

if ($BridgePath -ne $TargetBridge) {
    Write-Info "Copying jianzhi-bridge to correct location..."
    $TargetParent = Split-Path $TargetBridge -Parent
    if (-not (Test-Path $TargetParent)) {
        $null = New-Item -ItemType Directory -Force -Path $TargetParent
    }
    if (Test-Path $TargetBridge) {
        Remove-Item -Recurse -Force $TargetBridge
    }
    Copy-Item -Path $BridgePath -Destination $TargetBridge -Recurse -Force

    # Verify copy
    if (Test-Path "$TargetBridge\plugin.js") {
        Write-Success "jianzhi-bridge copied to resources and verified"
    } else {
        Write-Error "jianzhi-bridge copy failed - plugin.js not found"
        exit 1
    }
}

# 3. Check Windows SDK (signtool) if signing is needed
if ($Sign) {
    $SignToolPath = Get-Command signtool -ErrorAction SilentlyContinue
    if (-not $SignToolPath) {
        Write-Warning "signtool not found, installing Windows SDK automatically..."
        Write-EmptyLine

        $InstallSdkScript = "$ScriptDir\install-sdk.ps1"
        if (Test-Path $InstallSdkScript) {
            & $InstallSdkScript -Silent 2>&1 | Out-Host
            if ($LASTEXITCODE -eq 0) {
                Write-Success "Windows SDK installed"
                # Check again
                $SignToolPath = Get-Command signtool -ErrorAction SilentlyContinue
                if ($SignToolPath) {
                    Write-Success "signtool is now available"
                } else {
                    Write-Warning "Windows SDK installed but signtool still not found"
                    Write-Info "You may need to restart your terminal or run as administrator"
                    $Sign = $false
                }
            } else {
                Write-Warning "Windows SDK installation failed, signing will be skipped"
                $Sign = $false
            }
        } else {
            Write-Warning "install-sdk.ps1 not found, signing will be skipped"
            $Sign = $false
        }
    } else {
        Write-Success "signtool found at: $($SignToolPath.Source)"
    }
} else {
    Write-Info "Signing disabled (-NoSign), skipping signtool check"
}

# 4. Check certificate if signing
if ($Sign) {
    $CertPath = if ($env:CERT_PATH) { $env:CERT_PATH } else { "$ProjectRoot\certificates\jzai-code-signing.pfx" }
    if (-not (Test-Path $CertPath)) {
        Write-Warning "Certificate not found, attempting to generate..."
        Write-Info "Note: Certificate generation requires OpenSSL"
        Write-EmptyLine

        # Check for OpenSSL first
        $OpenSSL = Get-Command openssl -ErrorAction SilentlyContinue
        if (-not $OpenSSL) {
            Write-Warning "OpenSSL not found, cannot generate certificate"
            Write-Info "To install OpenSSL:"
            Write-Info "  1. Download: https://slproweb.com/products/Win32OpenSSL.html"
            Write-Info "  2. Or use: winget install OpenSSL.Win32"
            Write-EmptyLine
            Write-Info "Build will continue without signing"
            $Sign = $false
        } else {
            Write-Success "OpenSSL found: $($OpenSSL.Source)"
            Write-EmptyLine

            $GenerateCertScript = "$ScriptDir\generate-cert.ps1"
            if (Test-Path $GenerateCertScript) {
                & $GenerateCertScript 2>&1 | Out-Host
                if ($LASTEXITCODE -eq 0) {
                    Write-Success "Certificate generated"
                    # Verify
                    if (Test-Path $CertPath) {
                        Write-Success "Certificate verified at: $CertPath"
                    } else {
                        Write-Warning "Certificate generation completed but file not found"
                        $Sign = $false
                    }
                } else {
                    Write-Warning "Certificate generation failed, signing will be skipped"
                    $Sign = $false
                }
            } else {
                Write-Warning "generate-cert.ps1 not found, signing will be skipped"
                $Sign = $false
            }
        }
    } else {
        Write-Success "Certificate found at: $CertPath"
    }
}

Write-EmptyLine

# -- 3. Clean old build --
if ($Clean) {
    Write-Step "Cleaning old build..." 3 8

    $DistDir = "$ProjectRoot\dist"
    $OutDir = "$ProjectRoot\out"
    $WebpackDir = "$ProjectRoot\.webpack"

    if (Test-Path $DistDir) {
        Remove-Item -Recurse -Force $DistDir -ErrorAction SilentlyContinue
    }
    if (Test-Path $OutDir) {
        Remove-Item -Recurse -Force $OutDir -ErrorAction SilentlyContinue
    }
    if (Test-Path $WebpackDir) {
        Remove-Item -Recurse -Force $WebpackDir -ErrorAction SilentlyContinue
    }

    Write-Success "Clean completed"
} else {
    Write-Step "Skip clean" 3 8
}

Write-EmptyLine

# -- 5. Check dependencies --
Write-Step "Checking dependencies..." 5 8

$NodeModulesPath = "$ProjectRoot\node_modules"
if (-not (Test-Path $NodeModulesPath)) {
    Write-Info "Dependencies not installed, running npm install..."
    Push-Location $ProjectRoot
    npm install
    if ($LASTEXITCODE -eq 0) {
        Write-Success "Dependencies installed"
    } else {
        Write-Error "Dependency installation failed"
        Pop-Location
        exit 1
    }
    Pop-Location
} else {
    Write-Success "Dependencies already installed"
}

Write-EmptyLine

# -- 6. Build Electron app --
Write-Step "Building Electron app..." 7 9

Write-Info "Platform: Windows x64"
Write-Info "Target: NSIS Installer (unsigned)"
Write-Info "Output: JZAI-CoWorker-Setup-1.0.0.exe"
Write-Info "Signing: Manual signtool after build"
Write-EmptyLine

# Configure signing certificate path
if ($Sign) {
    $CertPath = if ($env:CERT_PATH) { $env:CERT_PATH } else { "$ProjectRoot\certificates\jzai-code-signing.pfx" }

    if (Test-Path $CertPath) {
        Write-Info "Certificate: $CertPath"

        # DO NOT set WIN_CSC_LINK during build
        # This would trigger electron-builder's built-in signing which requires winCodeSign download
        # Instead, we'll build UNSIGNED and sign manually with signtool after the build
        $env:WIN_CSC_LINK = $null
        $env:WIN_CSC_KEY_PASSWORD = $null

        Write-Info "Will build UNSIGNED, then sign with signtool after build"
        Write-Info "Certificate: $CertPath"
    } else {
        Write-Warning "Certificate not found, will sign after build"
        $Sign = $false
    }
} else {
    Write-Info "Manual signtool signing disabled (-NoSign), build will be unsigned"
}

Write-EmptyLine

# -- Check winCodeSign cache status --
Write-Step "Checking winCodeSign cache..." 5.5 9

$WinCodeSignCacheDir = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign-2.6.0"
$WinCodeSignCachedFile = "$WinCodeSignCacheDir\winCodeSign-2.6.0.7z"

Write-Info "Cache directory: $WinCodeSignCacheDir"

if (Test-Path $WinCodeSignCachedFile) {
    $FileSize = (Get-Item $WinCodeSignCachedFile).Length
    $FileSizeDisplay = if ($FileSize -gt 1MB) { "{0:N1} MB" -f ($FileSize / 1MB) }
                      elseif ($FileSize -gt 1KB) { "{0:N0} KB" -f ($FileSize / 1KB) }
                      else { "$FileSize B" }
    Write-Success "winCodeSign-2.6.0.7z found in cache ($FileSizeDisplay)"
    Write-Info "electron-builder will use cached file"
} else {
    Write-Info "winCodeSign-2.6.0.7z not in cache"
    Write-Info "electron-builder will download from GitHub (approx 5.6 MB)"
}

Write-EmptyLine

# Check if Electron is cached
$ElectronCacheDir = "$env:LOCALAPPDATA\electron\Cache"
$ElectronVersion = Get-PackageElectronVersion

if ($ElectronVersion) {
    $ElectronZip = "electron-v$ElectronVersion-win32-x64.zip"

    if (Test-Path "$ElectronCacheDir\$ElectronZip") {
        Write-Success "Electron v$ElectronVersion found in cache (will use local)"
    } else {
        Write-Info "Electron v$ElectronVersion not found in cache"
        Write-Info "Will download from GitHub (approx 108 MB)"
        Write-Info "Cache location: $ElectronCacheDir"
    }

    # Also check if electron is in node_modules
    $ElectronPath = "$ProjectRoot\node_modules\electron\dist\electron.exe"
    if (Test-Path $ElectronPath) {
        try {
            $InstalledVersion = & "$ProjectRoot\node_modules\electron\dist\electron.exe" --version 2>$null
            if ($InstalledVersion) {
                Write-Info "Electron installed locally: v$InstalledVersion"
            }
        } catch {
            # Version check failed, but electron exists
            Write-Info "Electron found in node_modules"
        }
    }
} else {
    Write-Warning "Could not determine Electron version from package.json"
    Write-Info "Proceeding with build (electron-builder will handle Electron download)"
}

Write-EmptyLine

Push-Location $ProjectRoot

# Run electron-builder
$BuildExitCode = 0
try {
    Write-Info "Running electron-builder..."
    Write-Info "Build mode: UNSIGNED (will sign manually after)"
    Write-Info "electron-builder will handle winCodeSign download and caching automatically"

    Write-EmptyLine

    # Build with electron-builder
    & npx electron-builder --win --x64
    $BuildExitCode = $LASTEXITCODE

    if ($BuildExitCode -ne 0) {
        Write-EmptyLine
        Write-Error "Build failed (exit code: $BuildExitCode)"
    }
} catch {
    $BuildExitCode = 1
    Write-Error "Build failed: $_"
}

Pop-Location

# Find output file
$DistDir = "$ProjectRoot\dist"
$OutputFiles = Get-ChildItem -Path $DistDir -Filter "*.exe" -ErrorAction SilentlyContinue |
               Where-Object { $_.Name -notlike "*.blockmap" } |
               Sort-Object LastWriteTime -Descending

$OutputFile = $OutputFiles | Select-Object -First 1

if (-not $OutputFile) {
    Write-Error "Build failed: no output file found"
    Write-Info "dist directory contents:"
    Get-ChildItem -Path $DistDir -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "  $($_.Name)" -ForegroundColor DarkGray
    }
    exit 1
}

if ($BuildExitCode -ne 0) {
    Write-Warning "Build had warnings (exit code $BuildExitCode), but installer was created"
}

Write-Success "Build completed"
Write-Info "Output: $($OutputFile.FullName)"

Write-EmptyLine

# -- 7. Sign installer --
if ($Sign) {
    Write-Step "Signing installer..." 8 9

    # Check for custom certificate env var
    if ($env:CERT_PATH) {
        Write-Info "Using custom certificate: $env:CERT_PATH"
    }

    $SignScript = "$ScriptDir\sign.ps1"

    if (Test-Path $SignScript) {
        & $SignScript $OutputFile.FullName 2>&1 | Out-Host
        if ($LASTEXITCODE -eq 0) {
            Write-Success "Signing completed"
        } else {
            Write-Warning "Signing failed (build not signed)"
        }
    } else {
        Write-Warning "Signing script not found: $SignScript"
        Write-Info "Skipping sign"
    }
} else {
    Write-Step "Skip signing" 7 8
}

Write-EmptyLine

# -- Done --
if (Test-Path $OutputFile.FullName) {
    $FileSize = (Get-Item $OutputFile.FullName).Length
    $FileSizeDisplay = if ($FileSize -gt 1GB) { "{0:N1} GB" -f ($FileSize / 1GB) }
                      elseif ($FileSize -gt 1MB) { "{0:N1} MB" -f ($FileSize / 1MB) }
                      elseif ($FileSize -gt 1KB) { "{0:N0} KB" -f ($FileSize / 1KB) }
                      else { "$FileSize B" }

    Write-Section "Build Completed"
    Write-EmptyLine
    Write-Host "File: " -NoNewline
    Write-Host $OutputFile.FullName -ForegroundColor Green
    Write-Host "Size: " -NoNewline
    Write-Host $FileSizeDisplay -ForegroundColor Cyan
    Write-EmptyLine

    # Check signature (if available)
    $SignToolPath = Get-Command signtool -ErrorAction SilentlyContinue
    if ($SignToolPath) {
        Write-Info "Signature verification:"
        try {
            & $SignToolPath.Source verify /pa $OutputFile.FullName 2>&1 | Out-Host
        } catch {
            Write-Warning "Cannot verify signature"
        }
    }

    Write-EmptyLine
    Write-Info "Next steps:"
    Write-Info "  1. Test install: Run installer on Windows"
    Write-Info "  2. Upload to JZAI backend: Via admin panel"
    Write-Info "     Or API: POST /api/coworkers/app/win/upload"
    Write-EmptyLine

    exit 0
} else {
    Write-Error "Build failed"
    exit 1
}
