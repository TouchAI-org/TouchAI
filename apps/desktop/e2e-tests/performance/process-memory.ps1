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
$renderers = @($tree | Where-Object { $_.CommandLine -match '--type=renderer' })
if ($renderers.Count -lt 1) { throw 'The benchmark did not include a WebView2 renderer.' }
$missingCounters = @($tree | Where-Object { $null -eq $_.PrivatePageCount -or $null -eq $_.WorkingSetSize })
if ($missingCounters.Count -gt 0) { throw 'The benchmark did not include native memory counters for every owned process.' }
@{
    privateBytes = [double](($tree | Measure-Object PrivatePageCount -Sum).Sum)
    workingSetBytes = [double](($tree | Measure-Object WorkingSetSize -Sum).Sum)
    processes = $tree.Count
    renderers = $renderers.Count
} | ConvertTo-Json -Compress
