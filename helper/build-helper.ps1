# Builds the Hapbeat Helper bundled in the desktop app into helper/dist/hapbeat-helper/.
#
#   powershell -File helper/build-helper.ps1                 # PyPI version in helper-version.txt
#   powershell -File helper/build-helper.ps1 -Source <path>  # a local hapbeat-helper checkout
#
# The venv (helper/.venv) is reused between builds. Exit code is non-zero on failure.
param(
    [string]$Source = "",
    [string]$Python = "python"
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$venv = Join-Path $here '.venv'
$py = Join-Path $venv 'Scripts\python.exe'

function Invoke-Checked([string]$exe, [string[]]$argv) {
    & $exe @argv
    if ($LASTEXITCODE -ne 0) { throw "$exe $($argv -join ' ') failed ($LASTEXITCODE)" }
}

if (-not (Test-Path $py)) {
    Write-Host "creating venv: $venv"
    Invoke-Checked $Python @('-m', 'venv', $venv)
}
Invoke-Checked $py @('-m', 'pip', 'install', '--quiet', '--upgrade', 'pip', 'pyinstaller')

if ($Source) {
    $pkg = (Resolve-Path $Source).Path
    Write-Host "helper source: $pkg"
} else {
    $version = (Get-Content (Join-Path $here 'helper-version.txt') -Raw).Trim()
    $pkg = "hapbeat-helper==$version"
    Write-Host "helper source: PyPI $pkg"
}
# Non-editable install so the wheel's dist-info (the version) is what gets bundled.
Invoke-Checked $py @('-m', 'pip', 'install', '--quiet', '--upgrade', '--force-reinstall', $pkg)

Push-Location $here
try {
    Invoke-Checked $py @('-m', 'PyInstaller', '--noconfirm', '--clean',
        '--distpath', (Join-Path $here 'dist'), '--workpath', (Join-Path $here 'build'),
        (Join-Path $here 'hapbeat-helper.spec'))
} finally {
    Pop-Location
}

$exe = Join-Path $here 'dist\hapbeat-helper\hapbeat-helper.exe'
$out = & $exe version --no-update-check
if ($LASTEXITCODE -ne 0) { throw "bundled helper did not run: $out" }
Write-Host "built: $exe ($out)"
