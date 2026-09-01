param([Parameter(Mandatory = $true)][string]$p)

if ($p -eq 'FAIL') {
    [Console]::Error.WriteLine('mock failure')
    exit 7
}
if ($p -eq 'EMPTY') {
    exit 0
}
if ($p -eq 'SLOW') {
    Start-Sleep -Seconds 3
}

Write-Output "MOCK_RESPONSE:$p"
