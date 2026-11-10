param(
    [Parameter(Mandatory = $true)][string]$BaselineRef,
    [Parameter(Mandatory = $true)][string]$HeadRef,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repoRoot = (git -C $PSScriptRoot rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0) { throw 'The performance runner requires a Git checkout.' }
$baseline = (git -C $repoRoot rev-parse --verify "$BaselineRef^{commit}").Trim()
if ($LASTEXITCODE -ne 0) { throw 'The baseline commit is unavailable.' }
$head = (git -C $repoRoot rev-parse --verify "$HeadRef^{commit}").Trim()
if ($LASTEXITCODE -ne 0) { throw 'The head commit is unavailable.' }
$selected = @(git -C $repoRoot diff --name-only $baseline $head -- docs/implicit-state-machines.md apps/desktop/e2e-tests/performance)
if ($LASTEXITCODE -ne 0) { throw 'Cannot classify lifecycle acceptance changes.' }
if (!$Force -and $selected.Count -eq 0) {
    Write-Output 'No lifecycle-audit or benchmark changes; existing E2E acceptance applies.'
    exit 0
}

$temporaryRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
$scratch = [IO.Path]::GetFullPath((Join-Path $temporaryRoot ('touchai-lifecycle-' + [guid]::NewGuid())))
if (!$scratch.StartsWith($temporaryRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetPathRoot($scratch).TrimEnd('\') -eq $env:SystemDrive -or
    $scratch.StartsWith([IO.Path]::GetFullPath($repoRoot).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Native release acceptance requires a non-system scratch directory outside the checkout.'
}
$reports = Join-Path $scratch 'reports'
$env:TEMP = Join-Path $scratch 'tmp'
$env:TMP = $env:TEMP
$env:TOUCHAI_TEST_TEMP = $env:TEMP
$env:CARGO_TARGET_DIR = Join-Path $scratch 'cargo'
New-Item -ItemType Directory -Path $reports, $env:TEMP | Out-Null
"TOUCHAI_LIFECYCLE_REPORTS=$reports" | Out-File -LiteralPath $env:GITHUB_ENV -Encoding utf8 -Append
@{
    baseline = $baseline
    head = $head
    profile = 'release'
    operatingSystem = (Get-CimInstance Win32_OperatingSystem).Caption
    processor = (Get-CimInstance Win32_Processor).Name
    webviewArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $reports 'environment.json') -Encoding utf8

function Invoke-Native {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable failed with exit code $LASTEXITCODE." }
}

$revisions = @{ baseline = $baseline; head = $head }
$executables = @{}
foreach ($variant in @('baseline', 'head')) {
    $tree = Join-Path $scratch "source-$variant"
    $archive = Join-Path $scratch "source-$variant.zip"
    $dist = Join-Path $scratch "frontend-$variant"
    $configPath = Join-Path $scratch "tauri-$variant.json"
    Invoke-Native -Executable git -Arguments @('-C', $repoRoot, 'archive', '--format=zip', '-o', $archive, $revisions[$variant])
    Expand-Archive -LiteralPath $archive -DestinationPath $tree
    Invoke-Native -Executable pnpm.cmd -Arguments @('--dir', $tree, 'install', '--frozen-lockfile')
    Invoke-Native -Executable pnpm.cmd -Arguments @('--dir', $tree, '--filter', '@touchai/desktop', 'exec', 'vite', 'build', '--configLoader', 'runner', '--outDir', $dist, '--emptyOutDir')
    @{ build = @{ beforeBuildCommand = ''; frontendDist = $dist } } |
        ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
    Invoke-Native -Executable pnpm.cmd -Arguments @('--dir', $tree, 'tauri', 'build', '--no-bundle', '--config', $configPath)
    $product = Get-Content -LiteralPath (Join-Path $tree 'apps/desktop/product.json') -Raw | ConvertFrom-Json
    $binaryDirectory = Join-Path $scratch "binary-$variant/release"
    New-Item -ItemType Directory -Path $binaryDirectory | Out-Null
    $executable = Join-Path $binaryDirectory $product.packaging.mainExe
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR "release/$($product.packaging.mainExe)") -Destination $executable
    $executables[$variant] = $executable
}

$env:TOUCHAI_E2E_SKIP_BUILD = '1'
$env:TOUCHAI_E2E_CARGO_PROFILE = 'release'
$env:TOUCHAI_E2E_OUTPUT_ROOT = Join-Path $scratch 'runtime'
$sequence = @('baseline', 'head', 'head', 'baseline', 'baseline', 'head', 'head', 'baseline', 'baseline', 'head', 'head', 'baseline')
for ($block = 0; $block -lt $sequence.Count; $block += 1) {
    $variant = $sequence[$block]
    $env:TOUCHAI_PERF_VARIANT = $variant
    $env:TOUCHAI_PERF_COMMIT = $revisions[$variant]
    $env:TOUCHAI_PERF_BLOCK = [string]$block
    $env:TOUCHAI_PERF_APP = [IO.Path]::GetFullPath($executables[$variant])
    $env:TOUCHAI_CARGO_TARGET_DIR = Join-Path $scratch "binary-$variant"
    $env:TOUCHAI_PERF_REPORT = Join-Path $reports "sample-$block-$variant.json"
    try {
        Invoke-Native -Executable pnpm.cmd -Arguments @('--dir', $repoRoot, '--filter', '@touchai/desktop', 'exec', 'wdio', 'run', (Join-Path $PSScriptRoot 'wdio.conf.js'))
    } finally {
        $ownedProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:TOUCHAI_PERF_APP })
        foreach ($ownedProcess in $ownedProcesses) {
            & taskkill.exe /PID $ownedProcess.ProcessId /T /F
            if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $ownedProcess.ProcessId -ErrorAction SilentlyContinue)) {
                throw 'Could not release the isolated benchmark process tree.'
            }
        }
    }
}
& node (Join-Path $PSScriptRoot 'compare.mjs') $reports
$result = $LASTEXITCODE
Get-Content -LiteralPath (Join-Path $reports 'summary.md') -Raw |
    Out-File -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
if ($result -ne 0) { throw 'Native lifecycle performance acceptance failed.' }
