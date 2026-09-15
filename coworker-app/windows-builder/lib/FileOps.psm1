# -----------------------------------------------------------------------------
# FileOps.psm1 - File Operations Module
#
# Provides file and directory operations with verification and error handling
# -----------------------------------------------------------------------------

function Copy-DirectoryWithVerification {
    param(
        [string]$Source,
        [string]$Destination,
        [switch]$Force
    )

    if (-not (Test-Path $Source)) {
        throw "Source directory not found: $Source"
    }

    # Create destination directory
    $null = New-Item -ItemType Directory -Force -Path $Destination

    # Copy contents
    if ($Force) {
        Copy-Item -Path "$Source\*" -Destination $Destination -Recurse -Force
    } else {
        Copy-Item -Path "$Source\*" -Destination $Destination -Recurse
    }
}

function Test-ResourceIntegrity {
    param(
        [string]$ResourcePath,
        [string[]]$RequiredFiles = @()
    )

    if (-not (Test-Path $ResourcePath)) {
        return $false
    }

    foreach ($file in $RequiredFiles) {
        $filePath = Join-Path $ResourcePath $file
        if (-not (Test-Path $filePath)) {
            return $false
        }
    }

    return $true
}

function Get-OpenClawPath {
    param(
        [string]$ProjectRoot,
        [string]$ConfigPath = "../openclaw"
    )

    # Support relative or absolute paths
    if ([System.IO.Path]::IsPathRooted($ConfigPath)) {
        return $ConfigPath
    }

    return Join-Path $ProjectRoot $ConfigPath
}

function Initialize-ResourceDirectory {
    param(
        [string]$ResourcesPath,
        [string[]]$SubDirectories = @()
    )

    # Create main directory
    if (-not (Test-Path $ResourcesPath)) {
        $null = New-Item -ItemType Directory -Force -Path $ResourcesPath
    }

    # Create subdirectories
    foreach ($subDir in $SubDirectories) {
        $path = Join-Path $ResourcesPath $subDir
        $null = New-Item -ItemType Directory -Force -Path $path
    }
}

function Get-ProjectRoot {
    param(
        [string]$CurrentPath = $PSScriptRoot
    )

    # Search upward from current script directory to find directory containing package.json
    $path = $CurrentPath
    while ($path -ne [System.IO.Path]::GetPathRoot($path)) {
        $packageJson = Join-Path $path "package.json"
        if (Test-Path $packageJson) {
            return $path
        }
        $path = Split-Path $path -Parent
    }

    throw "Cannot find project root (package.json not found)"
}

function Get-ConfigPath {
    param(
        [string]$ConfigName = "build.config.json",
        [string]$ScriptRoot = $PSScriptRoot
    )

    $configPath = Join-Path (Split-Path $ScriptRoot -Parent) "config\$ConfigName"
    if (Test-Path $configPath) {
        return $configPath
    }

    # Fallback to config in script directory
    $fallbackConfig = Join-Path $ScriptRoot "config\$ConfigName"
    if (Test-Path $fallbackConfig) {
        return $fallbackConfig
    }

    return $null
}

function Get-DirectorySize {
    param([string]$Path)

    $size = (Get-ChildItem -Path $Path -Recurse -File -ErrorAction SilentlyContinue |
             Measure-Object -Property Length -Sum).Sum

    if ($size -gt 1GB) { return "{0:N1} GB" -f ($size / 1GB) }
    if ($size -gt 1MB) { return "{0:N1} MB" -f ($size / 1MB) }
    if ($size -gt 1KB) { return "{0:N0} KB" -f ($size / 1KB) }
    return "$size B"
}

# Export functions
Export-ModuleMember -Function Copy-DirectoryWithVerification, Test-ResourceIntegrity, Get-OpenClawPath, Initialize-ResourceDirectory, Get-ProjectRoot, Get-ConfigPath, Get-DirectorySize
