# Proves the pinned provisioning path end to end: mirror download, digest check,
# wheel entry extraction, driver health check. Mirrors the manifest in code.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$version = "0.38.0"
$file    = "cua_driver-0.38.0-py3-none-win_amd64.whl"
$path    = "/packages/8c/1c/82b8cf495926bb49e298d3a77b03ab8948792eb7c6867af17e08078a7e32/$file"
$sha256  = "30e6fe57c70bbf5ed910268affce7e72c82a7d2469201c27432ad33d5487f258"
$size    = 32842600
$entry   = "cua_driver/bin/cua-driver.exe"
$mirrors = @(
  "https://pypi.tuna.tsinghua.edu.cn",
  "https://mirrors.aliyun.com/pypi",
  "https://pypi.org"
)

$root = Join-Path $env:TEMP "cua-provision-proof"
Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
New-Item -ItemType Directory "$root/.partial", "$root/$version" -Force | Out-Null
$partial = "$root/.partial/$version.whl.part"

$used = $null
foreach ($mirror in $mirrors) {
  $url = "$mirror$path"
  Write-Host "try $mirror"
  try {
    $offset = if (Test-Path $partial) { (Get-Item $partial).Length } else { 0 }
    $req = [System.Net.WebRequest]::Create($url)
    if ($offset -gt 0) { $req.AddRange = $offset }
    $resp = $req.GetResponse()
    $in = $resp.GetResponseStream()
    $mode = if ($offset -gt 0) { 'Append' } else { 'Create' }
    $fs = [IO.File]::Open($partial, [IO.FileMode]$mode)
    $in.CopyTo($fs)
    $fs.Dispose(); $in.Dispose(); $resp.Dispose()
    $used = $mirror
    break
  } catch {
    Write-Host "  failed: $($_.Exception.Message)"
  }
}
if (-not $used) { throw "all mirrors failed" }

$actualSize = (Get-Item $partial).Length
if ($actualSize -ne $size) { throw "size $actualSize != $size" }
$actualHash = (Get-FileHash $partial -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $sha256) { throw "digest $actualHash != $sha256" }
Write-Host ("verified {0} {1:N1} MB sha256 ok" -f $used, ($actualSize / 1MB))

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($partial)
try {
  $member = $zip.Entries | Where-Object { $_.FullName -eq $entry }
  if (-not $member) { throw "wheel has no $entry" }
  $dest = "$root/$version/cua-driver.exe"
  [IO.Compression.ZipFileExtensions]::ExtractToFile($member, $dest, $true)
} finally { $zip.Dispose() }

$binaryHash = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host ("binary sha256={0} size={1}" -f $binaryHash, (Get-Item $dest).Length)

Remove-Item $partial -Force
$kept = (Get-ChildItem $root -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("installed footprint after cleanup: {0:N1} MB" -f ($kept / 1MB))

& $dest --version
Write-Host "PROOF OK"
