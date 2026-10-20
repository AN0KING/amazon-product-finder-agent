#requires -Version 5.1
<#
.SYNOPSIS
One-shot local Scout HTTP client for WorkBuddy or another local tool host.
.DESCRIPTION
No timers, external URLs, task creation, automatic resume, provider connection,
health probes, or CAPTCHA handling. Output is JSON; failures exit with code 1.
Control operations require an explicit user instruction, -Confirmed, and the
current saved RunId. -Confirmed is a caller acknowledgement, not authentication.
#>
[CmdletBinding()]
param(
    [ValidateSet('Status', 'Version', 'Monitor', 'Amazon', 'Supplier1688', 'SellerSprite', 'Runs', 'Run', 'PauseAmazon', 'ResumeAmazon', 'Pause1688', 'Resume1688')]
    [string]$Operation = 'Status',
    [string]$RunId,
    [switch]$Confirmed
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scoutOrigin = 'http://127.0.0.1:4173'

function Stop-ScoutRequest {
    param([string]$Code, [string]$Message)
    $exception = New-Object System.InvalidOperationException($Message)
    $exception.Data['ScoutCode'] = $Code
    throw $exception
}

function Invoke-ScoutRequest {
    param([string]$Path, [ValidateSet('GET', 'POST')][string]$Method = 'GET', [hashtable]$Payload)
    $requestParameters = @{
        Uri = $scoutOrigin + $Path
        Method = $Method
        Headers = @{ Origin = $scoutOrigin }
        TimeoutSec = 15
        MaximumRedirection = 0
        ErrorAction = 'Stop'
    }
    if ($Method -eq 'POST') {
        $requestParameters['ContentType'] = 'application/json; charset=utf-8'
        $requestParameters['Body'] = [System.Text.Encoding]::UTF8.GetBytes(($Payload | ConvertTo-Json -Compress))
    }
    try {
        $reply = Invoke-RestMethod @requestParameters
    } catch {
        $responseCode = 'LOCAL_API_REQUEST_FAILED'
        # Preserve a safe server error code without echoing arbitrary HTTP bodies.
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            try {
                $body = $_.ErrorDetails.Message | ConvertFrom-Json
                if ($body.error.code -cmatch '^[A-Z0-9_]{1,80}$') { $responseCode = $body.error.code }
            } catch { }
        }
        Stop-ScoutRequest $responseCode 'Read local service status or logs. The request was not retried.'
    }
    if (-not $reply -or -not ($reply.PSObject.Properties.Name -contains 'ok') -or $reply.ok -ne $true) {
        Stop-ScoutRequest 'INVALID_LOCAL_RESPONSE' 'Expected a successful Scout JSON response.'
    }
    return $reply
}

try {
    $control = $Operation -in @('PauseAmazon', 'ResumeAmazon', 'Pause1688', 'Resume1688')
    if (($control -or $Operation -eq 'Run') -and $RunId -cnotmatch '^[A-Za-z0-9._:-]{1,128}$') {
        Stop-ScoutRequest 'RUN_ID_REQUIRED' 'Supply the exact saved RunId from the current task status.'
    }
    if ($control -and -not $Confirmed) {
        Stop-ScoutRequest 'USER_CONFIRMATION_REQUIRED' 'Only an explicit user instruction permits control. Pass -Confirmed after that instruction.'
    }
    if ($RunId -and -not ($control -or $Operation -eq 'Run')) {
        Stop-ScoutRequest 'UNEXPECTED_RUN_ID' 'RunId is accepted only for Run or explicit control operations.'
    }
    if ($Confirmed -and -not $control) {
        Stop-ScoutRequest 'UNEXPECTED_CONFIRMATION' 'Read-only requests do not use -Confirmed.'
    }

    $readPaths = @{
        Version = '/api/version'
        Monitor = '/api/monitor'
        Amazon = '/api/amazon/collection'
        Supplier1688 = '/api/1688/pipeline'
        SellerSprite = '/api/sellsprite/status'
        Runs = '/api/state'
    }
    if ($Operation -eq 'Status') {
        $status = [ordered]@{}
        foreach ($name in @('Version', 'Amazon', 'Supplier1688', 'Monitor', 'SellerSprite')) {
            $status[$name] = (Invoke-ScoutRequest -Path $readPaths[$name]).data
        }
        $result = @{ ok = $true; data = $status }
    } elseif ($Operation -eq 'Run') {
        $result = Invoke-ScoutRequest -Path ('/api/runs/' + [Uri]::EscapeDataString($RunId))
    } elseif ($control) {
        $sourcePath = if ($Operation -match 'Amazon$') { '/api/amazon/collection' } else { '/api/1688/pipeline' }
        $current = (Invoke-ScoutRequest -Path $sourcePath).data
        if (-not $current -or -not ($current.PSObject.Properties.Name -contains 'runId') -or $current.runId -cne $RunId) {
            Stop-ScoutRequest 'CURRENT_RUN_MISMATCH' 'The requested RunId is not the current task. No control request was sent.'
        }
        $action = if ($Operation.StartsWith('Pause')) { 'pause' } else { 'resume' }
        $result = Invoke-ScoutRequest -Path ($sourcePath + '/control') -Method POST -Payload @{ runId = $RunId; action = $action }
    } else {
        $result = Invoke-ScoutRequest -Path $readPaths[$Operation]
    }
    $result | ConvertTo-Json -Depth 100 -Compress
    exit 0
} catch {
    $code = if ($_.Exception.Data.Contains('ScoutCode')) { $_.Exception.Data['ScoutCode'] } else { 'SCOUT_CLIENT_FAILED' }
    $message = if ($_.Exception.Data.Contains('ScoutCode')) { $_.Exception.Message } else { 'Unable to read the local response. No automatic retry was performed.' }
    @{ ok = $false; error = @{ code = $code; message = $message } } | ConvertTo-Json -Compress
    exit 1
}
