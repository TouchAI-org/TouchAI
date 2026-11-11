$ErrorActionPreference = 'Stop'
$appPath = [IO.Path]::GetFullPath($env:TOUCHAI_PERF_APP)
$processes = @(Get-CimInstance Win32_Process)
$sampledAt = ([DateTimeOffset](Get-Date)).ToUniversalTime()
$roots = @($processes | Where-Object { $_.ExecutablePath -eq $appPath })
if ($roots.Count -ne 1) { throw "Expected one benchmark app at $appPath; found $($roots.Count)." }
function Get-ProcessCreationTime {
    param($Process)
    if ($null -eq $Process.CreationDate) { throw "The benchmark did not include a creation time for process $($Process.ProcessId)." }
    ([DateTimeOffset]$Process.CreationDate).ToUniversalTime()
}

$owned = [Collections.Generic.Dictionary[int,DateTimeOffset]]::new()
$owned.Add([int]$roots[0].ProcessId, (Get-ProcessCreationTime $roots[0]))
$rejected = [Collections.Generic.Dictionary[int,object]]::new()
do {
    $previousCount = $owned.Count
    foreach ($process in $processes) {
        $processId = [int]$process.ProcessId
        $parentId = [int]$process.ParentProcessId
        if ($owned.ContainsKey($processId) -or $rejected.ContainsKey($processId)) { continue }
        if ($owned.ContainsKey($parentId)) {
            $createdAt = Get-ProcessCreationTime $process
            if ($createdAt -lt $owned[$parentId]) {
                $rejected.Add($processId, @{
                    id = $processId
                    parentId = $parentId
                    name = $process.Name
                    createdAt = $createdAt.UtcDateTime.ToString('o')
                    parentCreatedAt = $owned[$parentId].UtcDateTime.ToString('o')
                })
            } else {
                $owned.Add($processId, $createdAt)
            }
        }
    }
} while ($owned.Count -ne $previousCount)
$tree = @($processes | Where-Object { $owned.ContainsKey([int]$_.ProcessId) } | Sort-Object ProcessId)
$renderers = @($tree | Where-Object { $_.CommandLine -match '--type=renderer' })
if ($renderers.Count -lt 1) { throw 'The benchmark did not include a WebView2 renderer.' }
$missingCounters = @($tree | Where-Object { $null -eq $_.PrivatePageCount -or $null -eq $_.WorkingSetSize })
if ($missingCounters.Count -gt 0) { throw 'The benchmark did not include native memory counters for every owned process.' }
$diagnosticArgumentAlternatives = @(
    '--type=(?:renderer|gpu-process|utility|crashpad-handler|broker)',
    '--disable-gpu(?:-sandbox)?',
    '--use-gl=disabled',
    '--no-delay-for-dx12-vulkan-info-collection',
    '--collect-dawn-info-eagerly',
    '--in-process-gpu',
    '--single-process',
    '--no-sandbox',
    '--gpu-recent-crash-count=\d{1,5}',
    '/prefetch:\d{1,2}'
)
$diagnosticArgumentPattern = '(?:^|\s)(?<quote>"?)(?<argument>' + ($diagnosticArgumentAlternatives -join '|') + ')\k<quote>(?=\s|$)'
$details = @(foreach ($process in $tree) {
    $processId = [int]$process.ProcessId
    $role = if ($processId -eq [int]$roots[0].ProcessId) { 'app' }
        elseif ($process.CommandLine -match '(?:^|\s)--type=(renderer|gpu-process|utility|crashpad-handler)(?:\s|$)') { $Matches[1] }
        else { 'other' }
    @{
        id = $processId
        parentId = [int]$process.ParentProcessId
        name = $process.Name
        createdAt = $owned[$processId].UtcDateTime.ToString('o')
        role = $role
        commandLineAvailable = ![string]::IsNullOrWhiteSpace($process.CommandLine)
        diagnosticArguments = @(
            [regex]::Matches([string]$process.CommandLine, $diagnosticArgumentPattern) |
                ForEach-Object { $_.Groups['argument'].Value }
        )
        privateBytes = [double]$process.PrivatePageCount
        workingSetBytes = [double]$process.WorkingSetSize
    }
})
@{
    sampledAt = $sampledAt.UtcDateTime.ToString('o')
    privateBytes = [double](($tree | Measure-Object PrivatePageCount -Sum).Sum)
    workingSetBytes = [double](($tree | Measure-Object WorkingSetSize -Sum).Sum)
    processes = $tree.Count
    renderers = $renderers.Count
    processDetails = $details
    rejectedParentReuses = @($rejected.Values | Sort-Object id)
} | ConvertTo-Json -Depth 4 -Compress
