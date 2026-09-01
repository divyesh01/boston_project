[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$AgyPath,

    [Parameter(Mandatory = $true)]
    [string]$PromptFile,

    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $WorkingDirectory
$promptText = [System.IO.File]::ReadAllText($PromptFile)
& $AgyPath -p $promptText
exit $LASTEXITCODE
