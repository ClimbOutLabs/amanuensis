<#
.SYNOPSIS
    Wires LKOS (LocalKnowledgeOS) into TF Aman as a read-only, retrieval-only
    remote MCP server, per ops/memory/DESIGN.md and ops/memory/RUNBOOK.md.

.DESCRIPTION
    A deliverable for the owner to read, adjust, and run by hand — this script is
    NOT executed as part of building or testing this change. Every gate below
    aborts loudly on failure, in order, and no gate is skipped:

      1. -ExpectedExeHash (mandatory) must match Get-FileHash of -LkosExePath.
         The dossier's recorded hash (741DA544...) matches none of the binaries
         on this machine as of this writing, so this gate WILL fail until the
         owner either locates the binary that hash came from, or rebuilds from
         pinned source and records the fresh hash here. That failure is the
         point: this script must never start an unverified LKOS binary.
      2. -Port (mandatory) must not be 43112 — LKOS's default MCP port, which is
         occupied on this machine by Docker port-forwarding to an Amanuensis
         container. There is no default; the owner must pick a free port.
      3. Starts `lkos mcp-http` on -Port and health-probes it before proceeding.
      4. Registers a READ-ONLY LKOS client via the LKOS web API
         (register_mcp_client_with_scopes, scopes `read` + `source_read` only)
         and verifies the returned scope set is exactly that — nothing broader.
      5. Writes the returned token into the TF container's volume at
         /data/secrets/lkos-token (mode 0600) via `docker exec`, piped over
         stdin so the token never appears in a process command line, and never
         written to this script's own output. The in-memory copy is wiped
         immediately after.
      6. Registers `lkos` with TF via PUT /api/v1/settings/mcp-servers, with
         `url: http://host.docker.internal:<port>/mcp` and
         `Authorization: ${file:/data/secrets/lkos-token}` — a reference, never
         the token itself.
      7. Verifies the round trip: GETs the stored manifest back and asserts the
         header value is still the reference string (not a token, not
         redacted-looking), then calls TF's tools-listing endpoint for `lkos`
         to prove the resolved bearer token actually authenticates against the
         live LKOS server end to end.

    Three decisions belong to the owner, not this script (see
    ops/memory/RUNBOOK.md for the full writeup):
      - Which LKOS binary / hash to trust (-ExpectedExeHash, -LkosExePath).
      - Which port to run LKOS's MCP endpoint on (-Port; not 43112).
      - Whether LKOS needs a `--allow-host` flag to accept the container's
        `Host: host.docker.internal:<port>` header (-LkosAllowHost).

    This script assumes the reference-syntax resolver (`${env:...}` /
    `${file:...}` header values, ops/memory/DESIGN.md) has already landed in
    TF. Until it has, step 6 will register successfully (the manifest layer
    accepts any non-empty string) but step 7's live tools-listing call will
    fail with an upstream 401 from LKOS, because TF will send the literal
    reference string as the header value instead of resolving it. That failure
    is expected and diagnostic, not a bug in this script.

.PARAMETER LkosExePath
    Path to the LKOS executable to run as `mcp-http`.

.PARAMETER ExpectedExeHash
    SHA-256 hash (hex, case-insensitive) the owner has verified corresponds to
    a trusted LKOS build. Mandatory — there is no bypass.

.PARAMETER Port
    TCP port for LKOS's Streamable HTTP MCP endpoint. Mandatory. Must not be
    43112.

.PARAMETER TrueForgeContainerName
    Name (or ID) of the running TF Aman container that will read the token
    file. Passed to `docker exec`.

.PARAMETER TrueForgeBaseUrl
    Base URL of TF's own HTTP API, reachable from this host (default:
    http://localhost:8000).

.PARAMETER TrueForgeApiKey
    Optional bearer token for TF's admin/settings API, if TF has OIDC admin
    auth enabled. Sent as `Authorization: Bearer <value>` on TF-side calls
    only — never confused with the LKOS token.

.PARAMETER LkosAllowHost
    Value passed to LKOS's `--allow-host` startup flag, so it accepts requests
    whose Host/Origin header is `host.docker.internal:<port>` (the container's
    view of the host) rather than only a bare loopback name. Default:
    `host.docker.internal`. Leave empty to omit the flag if the owner's LKOS
    build does not support it yet (see ops/memory/RUNBOOK.md, owner decision 3)
    — step 3's health probe will then fail loudly if LKOS rejects the Host
    header, which is the diagnostic this script wants in that case.

.PARAMETER LkosRegisterClientEndpoint
    Path of LKOS's web-API endpoint for register_mcp_client_with_scopes,
    relative to LKOS's base URL. The dossier names the operation but not a
    fixed wire path; confirm this against the installed LKOS build's own API
    reference before running. Default: /api/v1/clients/register_with_scopes.

.PARAMETER McpServerName
    Name TF registers the connector under. Default: lkos.

.PARAMETER HealthProbeTimeoutSeconds
    How long to wait for LKOS to accept connections after starting it.
    Default: 30.

.NOTES
    Do not run this script as part of any build, test, or CI step. It mutates
    a running TF container's filesystem and a running LKOS process; it is a
    runbook for a human to execute deliberately, once, after reviewing the
    parameters above.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$LkosExePath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ExpectedExeHash,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 65535)]
    [int]$Port,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$TrueForgeContainerName,

    [string]$TrueForgeBaseUrl = 'http://localhost:8000',

    [string]$TrueForgeApiKey = '',

    [string]$LkosAllowHost = 'host.docker.internal',

    # LKOS refuses to start without a data directory: --data-dir is a required
    # argument (env fallback LKOS_DATA_DIR). Defaulted to the machine's known
    # archive; pass explicitly to target a different one. Gate 3 aborts before
    # starting LKOS if the directory or its memory.db is missing, so a typo
    # cannot make LKOS initialize a fresh empty archive somewhere surprising.
    [string]$LkosDataDir = "$env:LOCALAPPDATA\LocalKnowledgeOS",

    [string]$LkosRegisterClientEndpoint = '/api/v1/clients/register_with_scopes',

    [string]$McpServerName = 'lkos',

    [int]$HealthProbeTimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'

# The exact read-only scope set the LKOS client must be granted. Not
# configurable: a broader grant defeats the point of a dedicated read-only
# client, and TF's own gate additionally requires LKOS's tools to be
# readOnlyHint/non-open-world (ops/memory/DESIGN.md, "Trust classification").
$RequiredScopes = @('read', 'source_read')
$RefusedDefaultPort = 43112
$TokenFilePathInContainer = '/data/secrets/lkos-token'
$AuthReferenceValue = '${file:' + $TokenFilePathInContainer + '}'

$script:CompletedSteps = New-Object System.Collections.Generic.List[string]
$script:LkosProcess = $null

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Complete-Step {
    param([string]$Message)
    $script:CompletedSteps.Add($Message)
    Write-Host "    OK: $Message" -ForegroundColor Green
}

function Abort {
    param([string]$Reason)
    Write-Host ''
    Write-Host "ABORT: $Reason" -ForegroundColor Red
    if ($script:CompletedSteps.Count -gt 0) {
        Write-Host ''
        Write-Host 'Steps completed before the abort:' -ForegroundColor Yellow
        foreach ($step in $script:CompletedSteps) {
            Write-Host "  - $step" -ForegroundColor Yellow
        }
    }
    if ($null -ne $script:LkosProcess -and -not $script:LkosProcess.HasExited) {
        Write-Host ''
        Write-Host "LKOS (PID $($script:LkosProcess.Id)) is still running — stop it yourself if this abort means it should not be." -ForegroundColor Yellow
    }
    exit 1
}

function Invoke-TrueForgeApi {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [object]$Body
    )
    $uri = "$TrueForgeBaseUrl$Path"
    $headers = @{}
    if ($TrueForgeApiKey) {
        $headers['Authorization'] = "Bearer $TrueForgeApiKey"
    }
    $invokeArgs = @{
        Method  = $Method
        Uri     = $uri
        Headers = $headers
    }
    if ($null -ne $Body) {
        $invokeArgs['ContentType'] = 'application/json'
        $invokeArgs['Body'] = ($Body | ConvertTo-Json -Depth 10)
    }
    try {
        return Invoke-RestMethod @invokeArgs
    }
    catch {
        Abort "TF API call failed: $Method $Path — $($_.Exception.Message)"
    }
}

# --- Gate 1: certified binary hash --------------------------------------
Write-Step "Gate 1/7: verifying $LkosExePath against the expected hash"
$actualHash = (Get-FileHash -LiteralPath $LkosExePath -Algorithm SHA256).Hash
if ($actualHash.ToUpperInvariant() -ne $ExpectedExeHash.Trim().ToUpperInvariant()) {
    Abort @"
LKOS binary hash mismatch.
  Path:     $LkosExePath
  Expected: $($ExpectedExeHash.Trim().ToUpperInvariant())
  Actual:   $($actualHash.ToUpperInvariant())
This script refuses to start an LKOS binary that does not match a hash you
have already verified. Locate the binary the expected hash actually came
from, or rebuild from pinned source and re-run with the freshly recorded
hash. See ops/memory/RUNBOOK.md, owner decision 1.
"@
}
Complete-Step "LKOS binary hash verified ($actualHash)"

# --- Gate 2: port must not be the occupied default ----------------------
Write-Step "Gate 2/7: checking -Port $Port"
if ($Port -eq $RefusedDefaultPort) {
    Abort "Port $RefusedDefaultPort is LKOS's default MCP port, but it is occupied on this machine by Docker port-forwarding to an Amanuensis container. Pick a different, free port with -Port. See ops/memory/RUNBOOK.md, owner decision 2."
}
Complete-Step "Port $Port is not the refused default ($RefusedDefaultPort)"

# --- Gate 3: start LKOS mcp-http and health-probe it --------------------
Write-Step "Gate 3/7: starting LKOS mcp-http on port $Port"
if (-not (Test-Path (Join-Path $LkosDataDir 'memory.db'))) {
    Abort "LKOS data dir '$LkosDataDir' has no memory.db. Refusing to start LKOS against a missing or empty archive: pass -LkosDataDir explicitly."
}
$lkosArgs = @('--data-dir', $LkosDataDir, 'mcp-http', '--port', "$Port")
if ($LkosAllowHost) {
    $lkosArgs += @('--allow-host', $LkosAllowHost)
}
try {
    $script:LkosProcess = Start-Process -FilePath $LkosExePath -ArgumentList $lkosArgs -PassThru -WindowStyle Hidden
}
catch {
    Abort "Failed to start LKOS: $($_.Exception.Message)"
}

$lkosBaseUrl = "http://127.0.0.1:$Port"
$healthy = $false
$deadline = (Get-Date).AddSeconds($HealthProbeTimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    if ($script:LkosProcess.HasExited) {
        Abort "LKOS exited during startup (exit code $($script:LkosProcess.ExitCode)) before it became healthy."
    }
    try {
        $null = Invoke-WebRequest -Uri "$lkosBaseUrl/mcp" -Method Options -TimeoutSec 2 -ErrorAction Stop
        $healthy = $true
        break
    }
    catch {
        # A 4xx/5xx from a live HTTP server still proves it is listening; only a
        # connection-level failure (refused, timed out) means "not up yet".
        if ($_.Exception.Response) {
            $healthy = $true
            break
        }
        Start-Sleep -Milliseconds 500
    }
}
if (-not $healthy) {
    Abort "LKOS did not become reachable on $lkosBaseUrl within $HealthProbeTimeoutSeconds seconds. If this is a Host/Origin rejection, see ops/memory/RUNBOOK.md, owner decision 3 (--allow-host)."
}
Complete-Step "LKOS is listening on $lkosBaseUrl (PID $($script:LkosProcess.Id))"

# --- Gate 4: read-only client registration ------------------------------
Write-Step 'Gate 4/7: registering a read-only LKOS client'
$registerBody = @{ scopes = $RequiredScopes } | ConvertTo-Json
try {
    $registerResponse = Invoke-RestMethod -Method Post -Uri "$lkosBaseUrl$LkosRegisterClientEndpoint" `
        -ContentType 'application/json' -Body $registerBody
}
catch {
    Abort "LKOS client registration failed: $($_.Exception.Message). Confirm -LkosRegisterClientEndpoint matches this LKOS build's actual register_mcp_client_with_scopes route."
}

$grantedScopes = @($registerResponse.scopes)
$grantedSorted = $grantedScopes | Sort-Object
$requiredSorted = $RequiredScopes | Sort-Object
$scopesMatchExactly = ($grantedSorted -join ',') -eq ($requiredSorted -join ',')
if (-not $scopesMatchExactly) {
    Abort "LKOS granted scopes [$($grantedScopes -join ', ')], not exactly the required read-only set [$($RequiredScopes -join ', ')]. Refusing to wire a client with broader-than-intended access."
}
$rawToken = $registerResponse.token
if ([string]::IsNullOrEmpty($rawToken)) {
    Abort 'LKOS registration response carried no token field.'
}
Complete-Step "Read-only LKOS client registered with exactly scopes [$($RequiredScopes -join ', ')]"

# --- Gate 5: write the token into the container, never displayed --------
Write-Step "Gate 5/7: writing the token into $TrueForgeContainerName at $TokenFilePathInContainer"
$secureToken = ConvertTo-SecureString -String $rawToken -AsPlainText -Force
Remove-Variable -Name rawToken -ErrorAction SilentlyContinue
$bstr = [IntPtr]::Zero
try {
    docker exec $TrueForgeContainerName sh -c 'mkdir -p /data/secrets' | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Abort "Failed to create /data/secrets in container $TrueForgeContainerName (exit $LASTEXITCODE)."
    }

    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    # umask first so the file is never briefly world-readable before chmod runs;
    # the token travels over stdin, never as a command-line argument (which would
    # leak into `docker inspect`/shell history/process listings).
    $plainToken | docker exec -i $TrueForgeContainerName sh -c "umask 077; cat > $TokenFilePathInContainer && chmod 0600 $TokenFilePathInContainer"
    $tokenWriteExitCode = $LASTEXITCODE
}
finally {
    if ($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    $plainToken = $null
    Remove-Variable -Name plainToken -ErrorAction SilentlyContinue
    Remove-Variable -Name secureToken -ErrorAction SilentlyContinue
    [System.GC]::Collect()
}
if ($tokenWriteExitCode -ne 0) {
    Abort "Writing the token into the container failed (docker exec exit $tokenWriteExitCode). No token value is printed above by design; re-run with -Verbose docker diagnostics separately if needed."
}
Complete-Step "Token written to $TrueForgeContainerName`:$TokenFilePathInContainer (mode 0600); in-memory copy wiped"

# --- Gate 6: register the MCP server with TF, by reference --------------
Write-Step "Gate 6/7: registering '$McpServerName' with TF as ${AuthReferenceValue}-authenticated"
$manifest = @{
    manifest = @{
        type        = 'remote'
        name        = $McpServerName
        url         = "http://host.docker.internal:$Port/mcp"
        description = 'LKOS memory (read-only, retrieval-only), registered by Register-LkosMemory.ps1.'
        auth        = @{
            type    = 'header'
            headers = @{ Authorization = $AuthReferenceValue }
        }
    }
}
$putResult = Invoke-TrueForgeApi -Method Put -Path '/api/v1/settings/mcp-servers' -Body $manifest
Complete-Step "TF accepted the '$McpServerName' registration (server id: $($putResult.data.name))"

# --- Gate 7: verify the reference persisted, and auth works live --------
Write-Step 'Gate 7/7: verifying the stored reference and end-to-end auth'
$getResult = Invoke-TrueForgeApi -Method Get -Path "/api/v1/settings/mcp-servers/$McpServerName"
$storedAuthorization = $getResult.data.manifest.auth.headers.Authorization
if ($storedAuthorization -ne $AuthReferenceValue) {
    Abort "Settings GET for '$McpServerName' returned '$storedAuthorization' for the Authorization header, not the expected reference '$AuthReferenceValue'. Either the reference resolver is not wired yet (see ops/memory/DESIGN.md) or something rewrote the stored value — do not proceed."
}
Complete-Step "Stored manifest carries the reference '$AuthReferenceValue', not a token"

try {
    $toolsResult = Invoke-TrueForgeApi -Method Get -Path "/api/v1/mcp-servers/$McpServerName/tools"
}
catch {
    Abort "Tools-listing call for '$McpServerName' failed even though the reference persisted correctly. This is the expected failure mode if TF has not yet landed header-reference resolution (ops/memory/DESIGN.md) — the literal reference string would be sent to LKOS as the bearer value instead of the resolved token, and LKOS would reject it with 401. Re-run this gate once that lands."
}
$toolCount = @($toolsResult.data).Count
if ($toolCount -eq 0) {
    Abort "Tools-listing call for '$McpServerName' succeeded but returned zero tools — LKOS accepted the connection but the read-only client may not see any retrieval tools. Investigate before trusting this registration."
}
Complete-Step "End-to-end auth verified: '$McpServerName' lists $toolCount tool(s) through TF"

Write-Host ''
Write-Host 'All gates passed:' -ForegroundColor Green
foreach ($step in $script:CompletedSteps) {
    Write-Host "  [x] $step" -ForegroundColor Green
}
Write-Host ''
Write-Host "LKOS is running as PID $($script:LkosProcess.Id) on $lkosBaseUrl — this script does not stop it or install it as a service; that is a separate, deliberate decision for the owner." -ForegroundColor Yellow
