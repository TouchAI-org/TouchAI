$ErrorActionPreference = 'Stop'
$appPath = [IO.Path]::GetFullPath($env:TOUCHAI_PERF_APP)
$processes = @(Get-CimInstance Win32_Process)
$roots = @($processes | Where-Object { $_.ExecutablePath -eq $appPath })
if ($roots.Count -ne 1) { throw "Expected one benchmark app at $appPath; found $($roots.Count)." }
$owned = [Collections.Generic.HashSet[int]]::new()
$owned.Add([int]$roots[0].ProcessId) | Out-Null
do {
    $previousCount = $owned.Count
    foreach ($process in $processes) {
        if ($owned.Contains([int]$process.ParentProcessId)) {
            $owned.Add([int]$process.ProcessId) | Out-Null
        }
    }
} while ($owned.Count -ne $previousCount)
$tree = @($processes | Where-Object { $owned.Contains([int]$_.ProcessId) })
$live = @(Get-Process -Id @($owned))
$renderers = @($tree | Where-Object { $_.CommandLine -match '--type=renderer' })
if ($renderers.Count -lt 1) { throw 'The benchmark did not include a WebView2 renderer.' }
@{
    privateBytes = [double](($live | Measure-Object PrivateMemorySize64 -Sum).Sum)
    workingSetBytes = [double](($live | Measure-Object WorkingSet64 -Sum).Sum)
    processes = $live.Count
    renderers = $renderers.Count
} | ConvertTo-Json -Compress
