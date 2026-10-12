param(
    [string]$OutputPath = (Join-Path $PSScriptRoot '..\Premiere-Hard-Subtitle-Remover-0.1.0.zip')
)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$destination = [System.IO.Path]::GetFullPath($OutputPath)
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ('hard-subtitle-package-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    $excludedNames = @('.env', 'node_modules', 'output', 'outputs', 'renders', 'temp', 'logs', '.git')
    Get-ChildItem -LiteralPath $source -Force -Recurse | ForEach-Object {
        if ([System.IO.Path]::GetFullPath($_.FullName) -eq $destination) { return }
        $relative = $_.FullName.Substring($source.Length).TrimStart('\', '/')
        $parts = $relative -split '[\\/]'
        $excluded = $false
        foreach ($part in $parts) { if ($excludedNames -contains $part -or $part -match '\.(key|dpapi|log|tmp)$') { $excluded = $true; break } }
        if ($excluded) { return }
        $target = Join-Path $stage $relative
        if ($_.PSIsContainer) { New-Item -ItemType Directory -Force -Path $target | Out-Null }
        else {
            $parent = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
            Copy-Item -LiteralPath $_.FullName -Destination $target -Force
        }
    }
    $zipDirectory = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $zipDirectory)) { New-Item -ItemType Directory -Force -Path $zipDirectory | Out-Null }
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $destination -Force
    Write-Output "Package created: $destination"
}
finally {
    $resolvedStage = [System.IO.Path]::GetFullPath($stage)
    $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolvedStage.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedStage)) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
