param([switch]$List)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class TouchAiDisplay {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public struct DEVMODE {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion;
        public short dmDriverVersion;
        public short dmSize;
        public short dmDriverExtra;
        public int dmFields;
        public int dmPositionX;
        public int dmPositionY;
        public int dmDisplayOrientation;
        public int dmDisplayFixedOutput;
        public short dmColor;
        public short dmDuplex;
        public short dmYResolution;
        public short dmTTOption;
        public short dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel;
        public int dmPelsWidth;
        public int dmPelsHeight;
        public int dmDisplayFlags;
        public int dmDisplayFrequency;
        public int dmICMMethod;
        public int dmICMIntent;
        public int dmMediaType;
        public int dmDitherType;
        public int dmReserved1;
        public int dmReserved2;
        public int dmPanningWidth;
        public int dmPanningHeight;
    }

    [DllImport("user32.dll", CharSet = CharSet.Ansi)]
    public static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);

    [DllImport("user32.dll")]
    public static extern int ChangeDisplaySettings(ref DEVMODE devMode, int flags);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, string pvParam, uint fWinIni);
}
"@

[TouchAiDisplay]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Get-DisplayModes {
    $modes = @()
    $seen = @{}
    $mode = New-Object TouchAiDisplay+DEVMODE
    $mode.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mode)

    for ($index = 0; $index -lt 1000; $index += 1) {
        if (-not [TouchAiDisplay]::EnumDisplaySettings($null, $index, [ref] $mode)) {
            break
        }

        $key = "$($mode.dmPelsWidth)x$($mode.dmPelsHeight)"

        if (
            $mode.dmPelsWidth -ge 1280 -and
            $mode.dmPelsHeight -ge 800 -and
            $mode.dmPelsWidth -le 3840 -and
            $mode.dmPelsHeight -le 2160 -and
            -not $seen.ContainsKey($key)
        ) {
            $copy = $mode
            $modes += $copy
            $seen[$key] = $true
        }

        $mode.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mode)
    }

    return $modes
}

function Get-OrderedDisplayModes {
    param([object[]] $Modes)

    $ordered = @()
    $seen = @{}

    foreach ($size in @(
        @(1920, 1080),
        @(1600, 900),
        @(1280, 800)
    )) {
        $preferred = $Modes |
            Where-Object {
                $_.dmPelsWidth -eq $size[0] -and $_.dmPelsHeight -eq $size[1]
            } |
            Select-Object -First 1

        if ($preferred -and -not $seen.ContainsKey("$($size[0])x$($size[1])")) {
            $ordered += $preferred
            $seen["$($size[0])x$($size[1])"] = $true
        }
    }

    foreach ($mode in ($Modes | Sort-Object { $_.dmPelsWidth * $_.dmPelsHeight } -Descending)) {
        $key = "$($mode.dmPelsWidth)x$($mode.dmPelsHeight)"

        if (-not $seen.ContainsKey($key)) {
            $ordered += $mode
            $seen[$key] = $true
        }
    }

    return $ordered
}

function Set-ResolutionWithWin32 {
    param([object] $Mode)

    $Mode.dmFields = 0x80000 -bor 0x100000
    $result = [TouchAiDisplay]::ChangeDisplaySettings([ref] $Mode, 0)

    if ($result -ne 0) {
        Write-Host "ChangeDisplaySettings returned $result for $($Mode.dmPelsWidth)x$($Mode.dmPelsHeight)"
        return $false
    }

    return $true
}

function Set-ResolutionWithModule {
    param([object] $Mode)

    if (-not (Get-Command Set-DisplayResolution -ErrorAction SilentlyContinue)) {
        Import-Module DisplayResolution -ErrorAction SilentlyContinue
    }

    if (-not (Get-Command Set-DisplayResolution -ErrorAction SilentlyContinue)) {
        return $false
    }

    try {
        Set-DisplayResolution -Width $Mode.dmPelsWidth -Height $Mode.dmPelsHeight -Force
        return $true
    } catch {
        Write-Host "DisplayResolution module failed: $($_.Exception.Message)"
        return $false
    }
}

function Set-BaselineResolution {
    $baseline = New-Object TouchAiDisplay+DEVMODE
    $baseline.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($baseline)
    $baseline.dmPelsWidth = 1920
    $baseline.dmPelsHeight = 1080

    if (Set-ResolutionWithModule -Mode $baseline) {
        return $true
    }

    return Set-ResolutionWithWin32 -Mode $baseline
}

function Get-PrimaryDisplayBounds {
    return [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
}

function Export-DisplaySize {
    param([object] $Bounds)

    $stageTop = [Math]::Min(64, [Math]::Max(32, [Math]::Round($Bounds.Height * 0.05)))
    $lines = @(
        "UI_PREVIEW_DISPLAY_WIDTH=$($Bounds.Width)",
        "UI_PREVIEW_DISPLAY_HEIGHT=$($Bounds.Height)",
        "UI_PREVIEW_STAGE_WIDTH=$($Bounds.Width)",
        "UI_PREVIEW_STAGE_HEIGHT=$($Bounds.Height)",
        "UI_PREVIEW_STAGE_TOP=$stageTop",
        "UI_PREVIEW_SCALE_FACTOR=1"
    )

    Add-Content -Path $env:GITHUB_ENV -Value $lines -Encoding ascii
    Write-Host "display: $($Bounds.Width)x$($Bounds.Height); stage: $($Bounds.Width)x$($Bounds.Height) at 1x"
}

function Set-PreviewDesktopBackground {
    param([object] $Bounds)

    $colour = if ($env:UI_PREVIEW_DESKTOP_COLOUR) {
        $env:UI_PREVIEW_DESKTOP_COLOUR
    } else {
        '#d9d4c8'
    }
    $root = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
    $file = Join-Path $root 'touchai-ui-preview-desktop.bmp'
    $bitmap = New-Object System.Drawing.Bitmap -ArgumentList $Bounds.Width, $Bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

    try {
        $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml($colour))
        $bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Bmp)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }

    $applied = [TouchAiDisplay]::SystemParametersInfo(0x0014, 0, $file, 0x0003)
    if (-not $applied) {
        throw "Could not set the preview desktop background to $colour"
    }

    Start-Sleep -Seconds 1
    Write-Host "preview desktop: $colour"
}

if ($List) {
    $modes = @(Get-DisplayModes)

    if ($modes.Count -eq 0) {
        $bounds = Get-PrimaryDisplayBounds
        Write-Host "no enumerated modes; current display is $($bounds.Width)x$($bounds.Height)"
        exit 0
    }

    $modes |
        Sort-Object { $_.dmPelsWidth * $_.dmPelsHeight } -Descending |
        ForEach-Object {
            Write-Host "$($_.dmPelsWidth)x$($_.dmPelsHeight) @ $($_.dmDisplayFrequency)Hz, $($_.dmLogPixels)dpi"
        }
    exit 0
}

if ($env:GITHUB_ACTIONS -ne 'true') {
    throw 'Display configuration is only allowed on the disposable hosted runner'
}

if (Set-BaselineResolution) {
    Start-Sleep -Seconds 2
} else {
    Write-Host 'could not set the 1920x1080 baseline; using the current display'
}

$modes = @(Get-DisplayModes)
$candidates = @(Get-OrderedDisplayModes -Modes $modes)

if ($candidates.Count -eq 0) {
    $bounds = Get-PrimaryDisplayBounds

    if ($bounds.Width -ge 1280 -and $bounds.Height -ge 800) {
        Export-DisplaySize -Bounds $bounds
        Set-PreviewDesktopBackground -Bounds $bounds
        exit 0
    }

    throw 'No display mode at least 1280x800 is available'
}

$selected = $null
$changed = $false

foreach ($candidate in $candidates) {
    Write-Host "trying display mode: $($candidate.dmPelsWidth)x$($candidate.dmPelsHeight)"
    $changed = Set-ResolutionWithWin32 -Mode $candidate

    if (
        -not $changed -and
        $candidate.dmPelsWidth -eq 1920 -and
        $candidate.dmPelsHeight -eq 1080
    ) {
        $changed = Set-ResolutionWithModule -Mode $candidate
    }

    if ($changed) {
        $selected = $candidate
        break
    }
}

if (-not $changed) {
    throw 'Cannot switch the hosted display to any supported mode'
}

Write-Host "selected display mode: $($selected.dmPelsWidth)x$($selected.dmPelsHeight)"

Start-Sleep -Seconds 2
$bounds = Get-PrimaryDisplayBounds

if ($bounds.Width -lt 1280 -or $bounds.Height -lt 800) {
    throw "Display is $($bounds.Width)x$($bounds.Height); native capture needs at least 1280x800"
}

Export-DisplaySize -Bounds $bounds
Set-PreviewDesktopBackground -Bounds $bounds
