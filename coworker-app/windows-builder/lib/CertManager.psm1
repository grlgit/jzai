# -----------------------------------------------------------------------------
# CertManager.psm1 - Certificate Management Module
#
# Provides code signing certificate related functionality
# -----------------------------------------------------------------------------

function Test-CertificateFiles {
    param(
        [string]$CertDir
    )

    $CertPfxPath = Join-Path $CertDir "jzai-code-signing.pfx"
    $CertCrtPath = Join-Path $CertDir "jzai-code-signing.crt"
    $CertKeyPath = Join-Path $CertDir "jzai-code-signing.key"

    $Result = @{
        HasPfx = Test-Path $CertPfxPath
        HasCrtKey = (Test-Path $CertCrtPath) -and (Test-Path $CertKeyPath)
        PfxPath = if (Test-Path $CertPfxPath) { $CertPfxPath } else { $null }
        CrtPath = if (Test-Path $CertCrtPath) { $CertCrtPath } else { $null }
        KeyPath = if (Test-Path $CertKeyPath) { $CertKeyPath } else { $null }
        IsValid = $false
    }

    $Result.IsValid = $Result.HasPfx -or $Result.HasCrtKey
    return $Result
}

function Get-CertificatePassword {
    param(
        [string]$DefaultPassword = "jzai-coworker-2026"
    )

    # Prefer environment variable
    if ($env:CERT_PASSWORD) {
        return $env:CERT_PASSWORD
    }

    return $DefaultPassword
}

function Get-CertificatePath {
    param(
        [string]$ProjectRoot
    )

    # Prefer environment variable
    if ($env:CERT_PATH) {
        return $env:CERT_PATH
    }

    # Default path
    return Join-Path $ProjectRoot "certificates\jzai-code-signing.pfx"
}

function Get-TimestampServers {
    return @(
        "http://timestamp.digicert.com",
        "http://timestamp.sectigo.com",
        "http://timestamp.apple.com"
    )
}

function Test-SignTool {
    try {
        $SignToolPath = Get-Command signtool -ErrorAction SilentlyContinue
        if ($SignToolPath) {
            return @{
                Available = $true
                Path = $SignToolPath.Source
            }
        }
    } catch {
        # Silent fail
    }

    return @{
        Available = $false
        Path = $null
    }
}

function Import-CertificateToStore {
    param(
        [string]$CertPath
    )

    if (-not (Test-Path $CertPath)) {
        throw "Certificate file not found: $CertPath"
    }

    try {
        # Use certutil to import certificate to Trusted Root Certification Authorities
        $Process = Start-Process -FilePath "certutil.exe" `
            -ArgumentList @("-addstore", "Root", $CertPath) `
            -PassThru -Wait -NoNewWindow

        if ($Process.ExitCode -eq 0) {
            return $true
        } else {
            return $false
        }
    } catch {
        throw "Certificate import failed: $_"
    }
}

function Invoke-CodeSign {
    param(
        [string]$FilePath,
        [string]$CertPath,
        [string]$Password,
        [string[]]$TimestampServers = (Get-TimestampServers),
        [string]$AppName = "JZAI CoWorker",
        [string]$AppUrl = "https://jzai.ai"
    )

    if (-not (Test-Path $FilePath)) {
        throw "File not found: $FilePath"
    }

    if (-not (Test-Path $CertPath)) {
        throw "Certificate file not found: $CertPath"
    }

    # Check if signtool is available
    $SignToolInfo = Test-SignTool
    if (-not $SignToolInfo.Available) {
        throw "signtool not found, please install Windows SDK"
    }

    $SignToolPath = $SignToolInfo.Path
    $SignSuccess = $false

    # Try multiple timestamp servers
    foreach ($TsServer in $TimestampServers) {
        Write-Host "  Trying timestamp server: $TsServer" -ForegroundColor DarkGray

        try {
            # Build argument list as a single string for proper parsing
            $Args = "sign /f `"$CertPath`" /p `"$Password`" /d `"$AppName`" /du `"$AppUrl`" /tr `"$TsServer`" /td sha256 /fd sha256 `"$FilePath`""

            $Process = Start-Process -FilePath $SignToolPath `
                -ArgumentList $Args `
                -PassThru -Wait -NoNewWindow

            if ($Process.ExitCode -eq 0) {
                $SignSuccess = $true
                Write-Host "  Signed successfully (using $TsServer)" -ForegroundColor Green
                break
            } else {
                Write-Host "  Failed (exit code $($Process.ExitCode)), trying next..." -ForegroundColor DarkYellow
            }
        } catch {
            Write-Host "  Failed: $_" -ForegroundColor DarkYellow
        }
    }

    # If all timestamp servers fail, try signing without timestamp
    if (-not $SignSuccess) {
        Write-Host "  All timestamp servers failed, trying without timestamp..." -ForegroundColor Yellow

        try {
            $Args = "sign /f `"$CertPath`" /p `"$Password`" /d `"$AppName`" /du `"$AppUrl`" /fd sha256 `"$FilePath`""

            $Process = Start-Process -FilePath $SignToolPath `
                -ArgumentList $Args `
                -PassThru -Wait -NoNewWindow

            if ($Process.ExitCode -eq 0) {
                $SignSuccess = $true
                Write-Host "  Signed successfully (no timestamp)" -ForegroundColor Green
            }
        } catch {
            # Silent fail
        }
    }

    return $SignSuccess
}

function Verify-CodeSign {
    param(
        [string]$FilePath
    )

    if (-not (Test-Path $FilePath)) {
        throw "File not found: $FilePath"
    }

    $SignToolInfo = Test-SignTool
    if (-not $SignToolInfo.Available) {
        return $null
    }

    try {
        $Process = Start-Process -FilePath $SignToolInfo.Path `
            -ArgumentList @("verify", "/pa", $FilePath) `
            -RedirectStandardOutput "$env:TEMP\signtool-output.txt" `
            -RedirectStandardError "$env:TEMP\signtool-error.txt" `
            -PassThru -Wait -NoNewWindow

        $Output = Get-Content "$env:TEMP\signtool-output.txt" -ErrorAction SilentlyContinue
        $ErrorOutput = Get-Content "$env:TEMP\signtool-error.txt" -ErrorAction SilentlyContinue

        Remove-Item "$env:TEMP\signtool-output.txt" -ErrorAction SilentlyContinue
        Remove-Item "$env:TEMP\signtool-error.txt" -ErrorAction SilentlyContinue

        return @{
            ExitCode = $Process.ExitCode
            Output = $Output
            Error = $ErrorOutput
        }
    } catch {
        return @{
            ExitCode = -1
            Output = $null
            Error = $_.Exception.Message
        }
    }
}

# Export functions
Export-ModuleMember -Function Test-CertificateFiles, Get-CertificatePassword, Get-CertificatePath, Get-TimestampServers, Test-SignTool, Import-CertificateToStore, Invoke-CodeSign, Verify-CodeSign
