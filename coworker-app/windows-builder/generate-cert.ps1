# -----------------------------------------------------------------------------
# generate-cert.ps1 - Generate Self-Signed Code Signing Certificate
#
# For JZAI CoWorker internal distribution
# Usage: .\generate-cert.ps1
# -----------------------------------------------------------------------------

#Requires -Version 5.1

$ErrorActionPreference = "Stop"

# Get paths
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir
$CertDir = Join-Path $ProjectRoot "certificates"

# Import modules
Import-Module (Join-Path $ScriptDir "lib\Logger.psm1") -Force

Write-Section "Generate Self-Signed Code Signing Certificate"

# Create certificate directory
if (-not (Test-Path $CertDir)) {
    $null = New-Item -ItemType Directory -Force -Path $CertDir
}

# Certificate file paths
$CAKeyPath = Join-Path $CertDir "jzai-ca.key"
$CACertPath = Join-Path $CertDir "jzai-ca.crt"
$CertKeyPath = Join-Path $CertDir "jzai-code-signing.key"
$CertCsrPath = Join-Path $CertDir "jzai-code-signing.csr"
$CertCrtPath = Join-Path $CertDir "jzai-code-signing.crt"
$CertPfxPath = Join-Path $CertDir "jzai-code-signing.pfx"

# Certificate configuration
$Subject = "/C=CN/ST=Beijing/L=Beijing/O=JZAI/OU=AI/CN=JZAI AI CoWorker"
$ValidDays = 3650  # 10 years validity
$CertPassword = "jzai-coworker-2026"  # PFX export password

# Check if openssl is available
$OpenSSL = Get-Command openssl -ErrorAction SilentlyContinue
if (-not $OpenSSL) {
    Write-Error "OpenSSL not found, please install OpenSSL first"
    Write-Info "Download: https://slproweb.com/products/Win32OpenSSL.html"
    Write-Info "Or use chocolatey: choco install openssl"
    exit 1
}

Write-Success "Found openssl: $($OpenSSL.Source)"
Write-EmptyLine

# -- 1. Generate CA private key --
Write-Step "Generating CA private key..."

if (Test-Path $CAKeyPath) {
    Write-Success "CA private key exists: jzai-ca.key"
} else {
    Write-Info "Generating..."
    & openssl genrsa -out $CAKeyPath 4096 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Success "CA private key generated"
    } else {
        Write-Error "CA private key generation failed"
        exit 1
    }
}

# -- 2. Generate CA certificate --
Write-EmptyLine
Write-Step "Generating CA certificate..."

if (Test-Path $CACertPath) {
    Write-Success "CA certificate exists: jzai-ca.crt"
} else {
    Write-Info "Generating..."

    # Create config file
    $ConfigContent = @"
distinguished_name = req_distinguished_name
x509_extensions = v3_ca
prompt = no

[req_distinguished_name]
C = CN
ST = Beijing
L = Beijing
O = JZAI
OU = AI
CN = JZAI AI CoWorker

[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,keyCertSign
"@

    $ConfigPath = Join-Path $CertDir "openssl-ca.cnf"
    $ConfigContent | Set-Content -Path $ConfigPath

    & openssl req -new -x509 -days $ValidDays -key $CAKeyPath -out $CACertPath -config $ConfigPath 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Success "CA certificate generated"
    } else {
        Write-Error "CA certificate generation failed"
        Remove-Item $ConfigPath -ErrorAction SilentlyContinue
        exit 1
    }

    Remove-Item $ConfigPath -ErrorAction SilentlyContinue
}

# -- 3. Generate code signing certificate private key --
Write-EmptyLine
Write-Step "Generating code signing certificate private key..."

if (Test-Path $CertKeyPath) {
    Write-Success "Certificate private key exists: jzai-code-signing.key"
} else {
    Write-Info "Generating..."
    & openssl genrsa -out $CertKeyPath 2048 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Success "Certificate private key generated"
    } else {
        Write-Error "Certificate private key generation failed"
        exit 1
    }
}

# -- 4. Generate Certificate Signing Request (CSR) --
Write-EmptyLine
Write-Step "Generating CSR..."

# Create config file
$ConfigContent = @"
distinguished_name = req_distinguished_name
prompt = no

[req_distinguished_name]
C = CN
ST = Beijing
L = Beijing
O = JZAI
OU = AI
CN = JZAI AI CoWorker
"@

$ConfigPath = Join-Path $CertDir "openssl-cert.cnf"
$ConfigContent | Set-Content -Path $ConfigPath

& openssl req -new -key $CertKeyPath -out $CertCsrPath -config $ConfigPath 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Success "CSR generated"
} else {
    Write-Error "CSR generation failed"
    Remove-Item $ConfigPath -ErrorAction SilentlyContinue
    exit 1
}

Remove-Item $ConfigPath -ErrorAction SilentlyContinue

# -- 5. Sign code signing certificate with CA --
Write-EmptyLine
Write-Step "Signing code signing certificate with CA..."

if (Test-Path $CertCrtPath) {
    Write-Success "Certificate exists: jzai-code-signing.crt"
} else {
    Write-Info "Signing..."

    # Create extension config file
    $ExtConfig = @"
basicConstraints = CA:FALSE
keyUsage = digitalSignature
extendedKeyUsage = codeSigning
subjectKeyIdentifier = hash
"@

    $ExtConfigPath = Join-Path $CertDir "openssl-ext.cnf"
    $ExtConfig | Set-Content -Path $ExtConfigPath

    & openssl x509 -req -days $ValidDays -in $CertCsrPath -CA $CACertPath -CAkey $CAKeyPath `
        -CAcreateserial -out $CertCrtPath -extfile $ExtConfigPath 2>&1 | Out-Null

    if ($LASTEXITCODE -eq 0) {
        Write-Success "Certificate signed"
    } else {
        Write-Error "Certificate signing failed"
        Remove-Item $ExtConfigPath -ErrorAction SilentlyContinue
        exit 1
    }

    Remove-Item $ExtConfigPath -ErrorAction SilentlyContinue
}

# -- 6. Convert to PFX format (Windows signing tools need this) --
Write-EmptyLine
Write-Step "Exporting to PFX format..."

if (Test-Path $CertPfxPath) {
    Write-Success "PFX exists: jzai-code-signing.pfx"
} else {
    Write-Info "Exporting..."

    & openssl pkcs12 -export -out $CertPfxPath -inkey $CertKeyPath -in $CertCrtPath `
        -certfile $CACertPath -passout pass:$CertPassword 2>&1 | Out-Null

    if ($LASTEXITCODE -eq 0) {
        Write-Success "PFX exported"
    } else {
        Write-Error "PFX export failed"
        exit 1
    }
}

# -- Done --
Write-EmptyLine
Write-Section "Certificate Generation Completed"

Write-Host "File locations:" -ForegroundColor Cyan
Write-Host "  CA certificate:       $CACertPath" -ForegroundColor White
Write-Host "  Code signing cert:    $CertCrtPath" -ForegroundColor White
Write-Host "  PFX (Windows):        $CertPfxPath" -ForegroundColor White
Write-Host "  PFX password:         $CertPassword" -ForegroundColor Yellow
Write-EmptyLine

Write-Host "=== Employee Certificate Trust Instructions ===" -ForegroundColor Cyan
Write-Host "1. Distribute $CACertPath to employees" -ForegroundColor White
Write-Host "2. Employees double-click CA cert -> Install cert -> Trusted Root Certification Authorities" -ForegroundColor White
Write-Host "3. Or run in Windows: certutil -addstore Root $CACertPath" -ForegroundColor White
Write-EmptyLine

Write-Warning "NOTE: Apps signed with self-signed certificates will trigger SmartScreen warnings on first run."
Write-Info "     Employees can click 'More info' -> 'Run anyway' to continue."
Write-EmptyLine

exit 0
