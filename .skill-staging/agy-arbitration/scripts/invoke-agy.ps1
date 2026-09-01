[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PromptFile,

    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory,

    [string]$AgyPath = $env:AGY_PATH,

    [ValidateRange(1, 86400)]
    [int]$TimeoutSeconds = 300,

    [ValidateRange(1000, 1000000)]
    [int]$MaxPromptChars = 60000
)

$ErrorActionPreference = 'Stop'

function Complete-Result {
    param(
        [int]$Code,
        [string]$Status,
        [string]$Message,
        [string]$Response = '',
        [string]$StandardError = '',
        [Nullable[int]]$ProcessExitCode = $null,
        [bool]$TimedOut = $false,
        [long]$DurationMs = 0
    )

    [ordered]@{
        status = $Status
        message = $Message
        response = $Response
        stderr = $StandardError
        process_exit_code = $ProcessExitCode
        timed_out = $TimedOut
        duration_ms = $DurationMs
    } | ConvertTo-Json -Depth 3 -Compress
    exit $Code
}
try {
    if (-not (Test-Path -LiteralPath $PromptFile -PathType Leaf)) {
        Complete-Result -Code 11 -Status 'invalid_prompt_file' -Message 'Prompt file does not exist.'
    }
    if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) {
        Complete-Result -Code 14 -Status 'invalid_working_directory' -Message 'Working directory does not exist.'
    }

    $resolvedPrompt = (Resolve-Path -LiteralPath $PromptFile).Path
    $resolvedWorkingDirectory = (Resolve-Path -LiteralPath $WorkingDirectory).Path
    $promptText = [System.IO.File]::ReadAllText($resolvedPrompt)

    if ([string]::IsNullOrWhiteSpace($promptText)) {
        Complete-Result -Code 11 -Status 'invalid_prompt_file' -Message 'Prompt file is empty.'
    }
    if ($promptText.Length -gt $MaxPromptChars) {
        Complete-Result -Code 12 -Status 'prompt_too_large' -Message "Prompt contains $($promptText.Length) characters; limit is $MaxPromptChars."
    }

    $resolvedAgy = $null
    if (-not [string]::IsNullOrWhiteSpace($AgyPath)) {
        if (Test-Path -LiteralPath $AgyPath -PathType Leaf) {
            $resolvedAgy = (Resolve-Path -LiteralPath $AgyPath).Path
        } else {
            Complete-Result -Code 10 -Status 'agy_not_found' -Message 'The explicit agy path does not exist.'
        }
    } else {
        $agyCommand = Get-Command agy -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $agyCommand) {
            $resolvedAgy = $agyCommand.Source
        }
    }

    if ([string]::IsNullOrWhiteSpace($resolvedAgy)) {
        Complete-Result -Code 10 -Status 'agy_not_found' -Message 'agy is not available on PATH. Pass -AgyPath or set AGY_PATH.'
    }

    $childScript = Join-Path $PSScriptRoot 'invoke-agy-child.ps1'
    $pwshPath = Join-Path $PSHOME 'pwsh.exe'
    if (-not (Test-Path -LiteralPath $childScript -PathType Leaf)) {
        Complete-Result -Code 13 -Status 'wrapper_error' -Message 'Child invocation script is missing.'
    }
    if (-not (Test-Path -LiteralPath $pwshPath -PathType Leaf)) {
        Complete-Result -Code 13 -Status 'wrapper_error' -Message 'PowerShell runtime could not be located.'
    }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $pwshPath
    $startInfo.WorkingDirectory = $resolvedWorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    foreach ($argument in @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $childScript,
        '-AgyPath', $resolvedAgy,
        '-PromptFile', $resolvedPrompt,
        '-WorkingDirectory', $resolvedWorkingDirectory
    )) {
        [void]$startInfo.ArgumentList.Add($argument)
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

    if (-not $process.Start()) {
        Complete-Result -Code 13 -Status 'start_failed' -Message 'Failed to start the Antigravity wrapper process.'
    }

    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $completed = $process.WaitForExit($TimeoutSeconds * 1000)

    if (-not $completed) {
        if ($IsWindows) {
            & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
        } else {
            $process.Kill($true)
        }
        $process.WaitForExit()
        $stopwatch.Stop()
        $timedOutStdout = $stdoutTask.GetAwaiter().GetResult()
        $timedOutStderr = $stderrTask.GetAwaiter().GetResult()
        Complete-Result -Code 124 -Status 'timeout' -Message "agy exceeded the $TimeoutSeconds-second timeout; partial output is not a valid review." -Response $timedOutStdout -StandardError $timedOutStderr -TimedOut $true -DurationMs $stopwatch.ElapsedMilliseconds
    }

    $process.WaitForExit()
    $stopwatch.Stop()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode

    if ($exitCode -ne 0) {
        Complete-Result -Code 20 -Status 'agy_failed' -Message "agy exited with code $exitCode." -Response $stdout -StandardError $stderr -ProcessExitCode $exitCode -DurationMs $stopwatch.ElapsedMilliseconds
    }
    if ([string]::IsNullOrWhiteSpace($stdout)) {
        Complete-Result -Code 21 -Status 'empty_response' -Message 'agy exited successfully but returned no response.' -StandardError $stderr -ProcessExitCode $exitCode -DurationMs $stopwatch.ElapsedMilliseconds
    }

    Complete-Result -Code 0 -Status 'success' -Message 'agy completed successfully.' -Response $stdout -StandardError $stderr -ProcessExitCode $exitCode -DurationMs $stopwatch.ElapsedMilliseconds
} catch {
    Complete-Result -Code 13 -Status 'wrapper_error' -Message $_.Exception.Message
}
