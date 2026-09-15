# verify-main-server.ps1
# JianZhi main server post-upgrade verification. Confirms these P0 fixes are deployed:
#   1) onboarding route is registered: GET /api/cw/assignment/<assignmentId>/onboarding (migration 029)
#   2) cw/mcp returns JSON-RPC 2.0 envelope (the most critical fix)
#   3) tools/list returns real inputSchema.properties
#   4) notifications/* returns HTTP 202
#   5) local workspace SOUL.md carries the CoWorker persona; openclaw.json has no persona override keys
#
# Usage (Windows PowerShell 5.1 or 7+):
#   .\verify-main-server.ps1 -MainUrl http://192.168.110.144:8899 `
#       -ApiKey <assignment api key> -AssignmentId <jz_coworker_assignments.id>
#
# ApiKey and AssignmentId are auto-read from ~/.openclaw/jianzhi-token.json
# (written by the client on activation) when omitted.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$MainUrl,

    [string]$ApiKey,

    # jz_coworker_assignments.id -- required for the onboarding route probe
    [string]$AssignmentId,

    [string]$PersonaProbe
)

$ErrorActionPreference = 'Stop'
$MainUrl = $MainUrl.TrimEnd('/')

$script:Pass = 0
$script:Fail = 0
$script:Warn = 0

function Write-Result {
    param([string]$Name, [string]$Status, [string]$Detail = '')
    switch ($Status) {
        'PASS' { $color = 'Green';  $script:Pass++ }
        'FAIL' { $color = 'Red';    $script:Fail++ }
        'WARN' { $color = 'Yellow'; $script:Warn++ }
        default { $color = 'Gray' }
    }
    Write-Host ('[{0}] {1}' -f $Status.PadRight(4), $Name) -ForegroundColor $color
    if ($Detail) {
        foreach ($line in ($Detail -split "`n")) {
            Write-Host "       $line" -ForegroundColor DarkGray
        }
    }
}

function Invoke-Rpc {
    param([string]$Method, [object]$RpcId = 1, [hashtable]$RpcParams = $null)
    $body = @{ jsonrpc = '2.0'; method = $Method }
    if ($null -ne $RpcId) { $body['id'] = $RpcId }
    if ($RpcParams) { $body['params'] = $RpcParams }
    $headers = @{ 'Content-Type' = 'application/json' }
    if ($ApiKey) { $headers['Authorization'] = "Bearer $ApiKey" }
    return Invoke-WebRequest -Uri "$MainUrl/api/cw/mcp" `
        -Method POST -Headers $headers `
        -Body (ConvertTo-Json $body -Depth 6 -Compress) `
        -UseBasicParsing -ErrorAction Stop
}

# ---------- Auto-fill ApiKey / AssignmentId ----------
# The client persists activation data in ~/.openclaw/jianzhi-token.json
# (see savePersistentToken in coworker-app/main.js), NOT inside openclaw.json.
$openclawDir  = Join-Path $env:USERPROFILE '.openclaw'
$openclawJson = Join-Path $openclawDir 'openclaw.json'
$tokenJson    = Join-Path $openclawDir 'jianzhi-token.json'

$localConfig = $null
if (Test-Path $openclawJson) {
    try { $localConfig = Get-Content $openclawJson -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $localConfig = $null }
}

$tokenConfig = $null
if (Test-Path $tokenJson) {
    try { $tokenConfig = Get-Content $tokenJson -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $tokenConfig = $null }
} else {
    Write-Host "[info] $tokenJson not found -- agent was never activated on this machine" -ForegroundColor DarkCyan
}

if (-not $ApiKey -and $tokenConfig -and $tokenConfig.token) {
    $ApiKey = $tokenConfig.token
    Write-Host "[info] ApiKey loaded from jianzhi-token.json" -ForegroundColor DarkCyan
}
if (-not $AssignmentId -and $tokenConfig -and $tokenConfig.assignmentId) {
    $AssignmentId = $tokenConfig.assignmentId
    Write-Host "[info] AssignmentId loaded from jianzhi-token.json: $AssignmentId" -ForegroundColor DarkCyan
}
if ($tokenConfig -and $tokenConfig.mainUrl) {
    Write-Host "[info] jianzhi-token.json mainUrl: $($tokenConfig.mainUrl)" -ForegroundColor DarkCyan
}

Write-Host ""
Write-Host "=== JianZhi main server verification ($MainUrl) ===" -ForegroundColor Cyan
Write-Host ""

# ---------- 1. onboarding endpoint (migration 029) ----------
if (-not $AssignmentId) {
    Write-Result 'onboarding endpoint registered' 'WARN' 'No -AssignmentId and none in jianzhi-token.json; cannot probe GET /api/cw/assignment/<id>/onboarding'
} else {
    try {
        $probeUrl = "$MainUrl/api/cw/assignment/$([uri]::EscapeDataString($AssignmentId))/onboarding"
        $resp = Invoke-WebRequest -Uri $probeUrl -Method GET -UseBasicParsing -ErrorAction Stop
        Write-Result 'onboarding endpoint registered' 'PASS' "HTTP $($resp.StatusCode)"
    } catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -eq 404) {
            Write-Result 'onboarding endpoint registered' 'FAIL' 'HTTP 404: either the route is missing (old build) or the AssignmentId does not exist -- verify the id against jz_coworker_assignments'
        } elseif ($code) {
            Write-Result 'onboarding endpoint registered' 'PASS' "HTTP $code (route exists)"
        } else {
            Write-Result 'onboarding endpoint registered' 'FAIL' "Network error: $($_.Exception.Message)"
        }
    }
}

if (-not $ApiKey) {
    Write-Host ""
    Write-Host "[warn] No -ApiKey provided and no token in jianzhi-token.json; skipping cw/mcp checks" -ForegroundColor Yellow
    Write-Host "       Pass an assignment api_key from jz_coworker_assignments via -ApiKey" -ForegroundColor Yellow
} else {
    # ---------- 2. cw/mcp JSON-RPC 2.0 envelope (most critical) ----------
    try {
        $resp = Invoke-Rpc -Method 'initialize' -RpcId 1
        $json = $resp.Content | ConvertFrom-Json
        $names = $json.PSObject.Properties.Name
        $hasEnvelope = ($names -contains 'jsonrpc') -and ($names -contains 'id') -and `
                       (($names -contains 'result') -or ($names -contains 'error'))
        if ($hasEnvelope -and $json.jsonrpc -eq '2.0') {
            $serverName = $json.result.serverInfo.name
            $proto = $json.result.protocolVersion
            Write-Result 'cw/mcp JSON-RPC 2.0 envelope' 'PASS' "server=$serverName protocol=$proto"
        } else {
            $preview = $resp.Content
            if ($preview.Length -gt 200) { $preview = $preview.Substring(0, 200) }
            Write-Result 'cw/mcp JSON-RPC 2.0 envelope' 'FAIL' "Old server: bare payload, missing jsonrpc/id/result`nActual: $preview"
        }
    } catch {
        Write-Result 'cw/mcp JSON-RPC 2.0 envelope' 'FAIL' "Call failed: $($_.Exception.Message)"
    }

    # ---------- 3. tools/list has real inputSchema ----------
    try {
        $resp = Invoke-Rpc -Method 'tools/list' -RpcId 2
        $json = $resp.Content | ConvertFrom-Json
        $tools = $json.result.tools
        if ($tools -and $tools.Count -gt 0) {
            $withSchema = 0
            $emptySchema = 0
            foreach ($t in $tools) {
                $schema = $t.inputSchema
                if ($schema -and $schema.properties -and ($schema.properties.PSObject.Properties.Count -gt 0)) {
                    $withSchema++
                } else {
                    $emptySchema++
                }
            }
            if ($withSchema -gt 0) {
                Write-Result 'tools/list has real inputSchema' 'PASS' "Total $($tools.Count), $withSchema with properties ($emptySchema no-arg is normal)"
            } else {
                Write-Result 'tools/list has real inputSchema' 'FAIL' "All $($tools.Count) tools have empty inputSchema -- old server"
            }
        } else {
            Write-Result 'tools/list has real inputSchema' 'WARN' 'Empty tool list (assignment may have no tools authorized in the admin UI)'
        }
    } catch {
        Write-Result 'tools/list has real inputSchema' 'FAIL' "Call failed: $($_.Exception.Message)"
    }

    # ---------- 4. notifications/initialized returns HTTP 202 ----------
    try {
        $headers = @{ 'Content-Type' = 'application/json'; 'Authorization' = "Bearer $ApiKey" }
        $resp = Invoke-WebRequest -Uri "$MainUrl/api/cw/mcp" -Method POST -Headers $headers `
            -Body '{"jsonrpc":"2.0","method":"notifications/initialized"}' `
            -UseBasicParsing -ErrorAction Stop
        if ($resp.StatusCode -eq 202) {
            Write-Result 'notifications/* returns HTTP 202' 'PASS' 'HTTP 202'
        } else {
            Write-Result 'notifications/* returns HTTP 202' 'FAIL' "HTTP $($resp.StatusCode) (expected 202) -- old server"
        }
    } catch {
        Write-Result 'notifications/* returns HTTP 202' 'FAIL' "Call failed: $($_.Exception.Message)"
    }
}

# ---------- 5. Local SOUL.md persona file ----------
if (-not (Test-Path $openclawJson)) {
    Write-Result 'local openclaw.json exists' 'WARN' "Not found: $openclawJson (agent not yet activated on this machine)"
} else {
    try {
        $defaults = $null
        if ($localConfig -and $localConfig.agents) { $defaults = $localConfig.agents.defaults }
        $override = $null
        $legacy = $null
        $workspace = $null
        if ($defaults) {
            $override  = $defaults.systemPromptOverride
            $legacy    = $defaults.systemPrompt
            $workspace = $defaults.workspace
        }

        if ($legacy -or $override) {
            Write-Result 'openclaw.json persona keys removed' 'FAIL' 'openclaw.json still contains agents.defaults.systemPrompt/systemPromptOverride -- newer OpenClaw rejects these keys'
        } else {
            Write-Result 'openclaw.json persona keys removed' 'PASS' 'No systemPrompt/systemPromptOverride in agents.defaults'
        }

        if (-not $workspace) {
            Write-Result 'workspace SOUL.md exists' 'WARN' 'agents.defaults.workspace missing; cannot locate SOUL.md'
        } else {
            $soulPath = Join-Path $workspace 'SOUL.md'
            if (-not (Test-Path $soulPath)) {
                Write-Result 'workspace SOUL.md exists' 'WARN' "Not found: $soulPath (CoWorker soul field may be empty, or hot reload has not applied yet)"
            } else {
                $soul = Get-Content $soulPath -Raw -Encoding UTF8
                $preview = $soul.Trim()
                if ($preview.Length -gt 60) { $preview = $preview.Substring(0, 60) + '...' }
                $probeInfo = ''
                if ($PersonaProbe) {
                    if ($soul.Contains($PersonaProbe)) {
                        $probeInfo = " (probe '$PersonaProbe' matched)"
                    } else {
                        $probeInfo = " (probe '$PersonaProbe' NOT matched -- bridge may not have hot-reloaded yet, retry in 60s)"
                    }
                }
                Write-Result 'workspace SOUL.md exists' 'PASS' "$soulPath => $preview$probeInfo"
            }
        }
    } catch {
        Write-Result 'workspace SOUL.md exists' 'FAIL' "Check failed: $($_.Exception.Message)"
    }
}

# ---------- Summary ----------
Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
Write-Host ("Pass {0}   Fail {1}   Warn {2}" -f $script:Pass, $script:Fail, $script:Warn) -ForegroundColor White

if ($script:Fail -gt 0) {
    Write-Host ""
    Write-Host "FAIL: main server is not the latest build, or deployment is missing P0 fixes." -ForegroundColor Red
    exit 1
} elseif ($script:Warn -gt 0) {
    Write-Host ""
    Write-Host "PARTIAL: API surface looks new, but some checks could not be confirmed (see WARN above)." -ForegroundColor Yellow
    exit 0
} else {
    Write-Host ""
    Write-Host "OK: main server is up to date." -ForegroundColor Green
    exit 0
}
