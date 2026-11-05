// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

//! Windows host frame for the main search surface.
//!
//! The renderer owns the logical SearchPanel geometry, while the native window
//! owns the transparent safety envelope around that panel.  Keeping the host
//! bounded is important on Windows: a monitor-sized transparent webview makes
//! the search surface appear to be a full-screen window and also lets layout
//! measurements accidentally observe the monitor viewport instead of content.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime};

#[cfg(target_os = "windows")]
const HOST_RECONCILE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(750);

/// Logical room kept around the panel for its browser shadow and transition
/// overshoot. This mirrors the renderer's `SEARCH_WINDOW_VISUAL_OUTSET`.
pub const SEARCH_HOST_VISUAL_OUTSET_LOGICAL: f64 = 48.0;

/// Physical room above the compact surface inside the host, matching the
/// renderer `SEARCH_WINDOW_TOP_INSET`. This is a shadow/transition envelope,
/// not the on-screen parking position of the window.
pub const SEARCH_HOST_TOP_INSET_PHYSICAL: i32 = 96;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhysicalWorkArea {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalHostFrame {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
pub struct PhysicalHostOrigin {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PreparedSearchHost {
    pub changed: bool,
    pub frame: PhysicalHostFrame,
    pub target_frame: PhysicalHostFrame,
    pub scale_factor: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SearchHostPlacement {
    #[default]
    PreserveOrigin,
    PreserveCenter,
    Idle,
    WorkArea,
    Restore,
}

pub fn resolve_search_host_target_frame(
    current: PhysicalHostFrame,
    idle_frame: PhysicalHostFrame,
    work_area: PhysicalWorkArea,
    placement: SearchHostPlacement,
    restore_frame: Option<PhysicalHostFrame>,
) -> Result<PhysicalHostFrame, String> {
    match placement {
        SearchHostPlacement::PreserveOrigin => Ok(preserve_host_origin_within_work_area(
            current, idle_frame, work_area,
        )),
        SearchHostPlacement::PreserveCenter => Ok(preserve_host_center_within_work_area(
            current, idle_frame, work_area,
        )),
        SearchHostPlacement::Idle => Ok(idle_frame),
        SearchHostPlacement::WorkArea => host_frame_from_work_area(work_area),
        SearchHostPlacement::Restore => Ok(preserve_host_origin_within_work_area(
            restore_frame.unwrap_or(idle_frame),
            idle_frame,
            work_area,
        )),
    }
}

pub fn resolve_search_host_target_frame_with_origin(
    current: PhysicalHostFrame,
    idle_frame: PhysicalHostFrame,
    work_area: PhysicalWorkArea,
    placement: SearchHostPlacement,
    restore_frame: Option<PhysicalHostFrame>,
    physical_origin: Option<PhysicalHostOrigin>,
) -> Result<PhysicalHostFrame, String> {
    if placement == SearchHostPlacement::PreserveOrigin {
        if let Some(origin) = physical_origin {
            return Ok(preserve_host_origin_within_work_area(
                PhysicalHostFrame {
                    x: origin.x,
                    y: origin.y,
                    ..current
                },
                idle_frame,
                work_area,
            ));
        }
    }
    resolve_search_host_target_frame(current, idle_frame, work_area, placement, restore_frame)
}

pub struct SearchHostRefreshRuntime {
    scheduled: AtomicBool,
    native_enabled: bool,
    restore_frame: Mutex<Option<PhysicalHostFrame>>,
}

impl SearchHostRefreshRuntime {
    pub fn new() -> Self {
        Self::with_native_enabled(true)
    }

    pub fn for_tests() -> Self {
        Self::with_native_enabled(false)
    }

    fn with_native_enabled(native_enabled: bool) -> Self {
        Self {
            scheduled: AtomicBool::new(false),
            native_enabled,
            restore_frame: Mutex::new(None),
        }
    }

    pub fn try_schedule(&self) -> bool {
        self.scheduled
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub fn complete(&self) {
        self.scheduled.store(false, Ordering::Release);
    }

    pub fn native_enabled(&self) -> bool {
        self.native_enabled
    }

    fn apply_placement<T>(
        &self,
        current: PhysicalHostFrame,
        placement: SearchHostPlacement,
        apply: impl FnOnce(Option<PhysicalHostFrame>) -> Result<T, String>,
    ) -> Result<T, String> {
        let previous = *self
            .restore_frame
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let result = apply(previous)?;
        let mut slot = self
            .restore_frame
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *slot == previous {
            match placement {
                SearchHostPlacement::WorkArea => {
                    *slot = previous.or(Some(current));
                }
                SearchHostPlacement::Idle | SearchHostPlacement::Restore => {
                    *slot = None;
                }
                _ => {}
            }
        }
        Ok(result)
    }

    pub fn is_work_area_host(&self) -> bool {
        self.restore_frame
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_some()
    }
}

impl Default for SearchHostRefreshRuntime {
    fn default() -> Self {
        Self::new()
    }
}

pub fn host_frame_changed(current: PhysicalHostFrame, target: PhysicalHostFrame) -> bool {
    current != target
}

pub(crate) fn preserve_host_origin(
    current: PhysicalHostFrame,
    target: PhysicalHostFrame,
) -> PhysicalHostFrame {
    PhysicalHostFrame {
        x: current.x,
        y: current.y,
        ..target
    }
}

pub(crate) fn preserve_host_origin_within_work_area(
    current: PhysicalHostFrame,
    target: PhysicalHostFrame,
    work_area: PhysicalWorkArea,
) -> PhysicalHostFrame {
    let minimum_x = i64::from(work_area.left);
    let minimum_y = i64::from(work_area.top);
    let maximum_x = (i64::from(work_area.right) - i64::from(target.width)).max(minimum_x);
    let maximum_y = (i64::from(work_area.bottom) - i64::from(target.height)).max(minimum_y);

    PhysicalHostFrame {
        x: i32::try_from(i64::from(current.x).clamp(minimum_x, maximum_x))
            .unwrap_or(work_area.left),
        y: i32::try_from(i64::from(current.y).clamp(minimum_y, maximum_y)).unwrap_or(work_area.top),
        ..target
    }
}

pub(crate) fn preserve_host_center_within_work_area(
    current: PhysicalHostFrame,
    target: PhysicalHostFrame,
    work_area: PhysicalWorkArea,
) -> PhysicalHostFrame {
    let centered_y =
        i64::from(current.y) + (i64::from(current.height) - i64::from(target.height)) / 2;
    let minimum_y = i64::from(work_area.top);
    let maximum_y = (i64::from(work_area.bottom) - i64::from(target.height)).max(minimum_y);
    let minimum_x = i64::from(work_area.left);
    let maximum_x = (i64::from(work_area.right) - i64::from(target.width)).max(minimum_x);

    PhysicalHostFrame {
        x: i32::try_from(i64::from(current.x).clamp(minimum_x, maximum_x))
            .unwrap_or(work_area.left),
        y: i32::try_from(centered_y.clamp(minimum_y, maximum_y)).unwrap_or(work_area.top),
        ..target
    }
}

fn reconcile_host_frame<Apply, Read>(
    current: PhysicalHostFrame,
    target: PhysicalHostFrame,
    apply: Apply,
    read_actual: Read,
) -> Result<PhysicalHostFrame, String>
where
    Apply: FnOnce(PhysicalHostFrame) -> Result<(), String>,
    Read: FnOnce() -> Result<PhysicalHostFrame, String>,
{
    if !host_frame_changed(current, target) {
        return Ok(current);
    }

    apply(target)?;
    read_actual()
}

pub fn host_frame_from_work_area(area: PhysicalWorkArea) -> Result<PhysicalHostFrame, String> {
    let width = area
        .right
        .checked_sub(area.left)
        .ok_or_else(|| "Monitor work-area width overflowed".to_string())?;
    let height = area
        .bottom
        .checked_sub(area.top)
        .ok_or_else(|| "Monitor work-area height overflowed".to_string())?;
    if width <= 0 || height <= 0 {
        return Err("Monitor work area is empty".to_string());
    }
    Ok(PhysicalHostFrame {
        x: area.left,
        y: area.top,
        width,
        height,
    })
}

/// Compute a bounded native host for a logical SearchPanel.
///
/// The host is centered in the work area, matching the original search window
/// `center()` reset. 96 physical px above the panel stay reserved as a
/// transparent envelope for the browser shadow and transitions. The renderer
/// continues to use its viewport dimensions to position the panel inside this
/// frame.
#[cfg(test)]
fn bounded_host_frame_for_panel(
    area: PhysicalWorkArea,
    panel_width: f64,
    panel_height: f64,
    scale_factor: f64,
) -> Result<PhysicalHostFrame, String> {
    bounded_host_frame_for_panel_with_content_height(
        area,
        panel_width,
        panel_height,
        None,
        scale_factor,
    )
}

/// Compute a bounded host while reserving additional client-space height for
/// fixed overlays rendered outside the logical panel.
fn search_panel_work_area_limits(
    area: PhysicalWorkArea,
    scale_factor: f64,
) -> Result<(f64, f64, f64), String> {
    let frame = host_frame_from_work_area(area)?;
    let outset = logical_to_physical_i64(
        SEARCH_HOST_VISUAL_OUTSET_LOGICAL,
        scale_factor,
        "Search host visual outset",
    )?;
    let width = ((f64::from(frame.width) - 2.0 * outset as f64) / scale_factor).floor();
    let content_height = (f64::from(frame.height) - outset as f64) / scale_factor;
    let height =
        (content_height - f64::from(SEARCH_HOST_TOP_INSET_PHYSICAL) / scale_factor).floor();
    if width < 1.0 || height < 1.0 {
        return Err("Monitor work area cannot contain the search surface envelope".to_string());
    }
    Ok((width, height, content_height))
}

pub fn bounded_host_frame_for_panel_with_content_height(
    area: PhysicalWorkArea,
    panel_width: f64,
    panel_height: f64,
    host_content_height: Option<f64>,
    scale_factor: f64,
) -> Result<PhysicalHostFrame, String> {
    if !panel_width.is_finite()
        || !panel_height.is_finite()
        || panel_width <= 0.0
        || panel_height <= 0.0
        || !scale_factor.is_finite()
        || scale_factor <= 0.0
    {
        return Err(
            "Search panel size and scale factor must be positive finite values".to_string(),
        );
    }
    if host_content_height.is_some_and(|height| !height.is_finite() || height <= 0.0) {
        return Err("Search host content height must be positive and finite".to_string());
    }
    let work_area = host_frame_from_work_area(area)?;
    let (max_width, max_height, max_content_height) =
        search_panel_work_area_limits(area, scale_factor)?;
    let outset = logical_to_physical_i64(
        SEARCH_HOST_VISUAL_OUTSET_LOGICAL,
        scale_factor,
        "Search host visual outset",
    )?;
    let panel_width = logical_to_physical_i64(
        panel_width.min(max_width),
        scale_factor,
        "Search panel width",
    )?;
    let panel_height = logical_to_physical_i64(
        panel_height.min(max_height),
        scale_factor,
        "Search panel height",
    )?;
    let base_content_height = i64::from(SEARCH_HOST_TOP_INSET_PHYSICAL)
        .checked_add(panel_height)
        .ok_or_else(|| "Search host content height overflowed".to_string())?;
    let requested_content_height = host_content_height
        .map(|height| {
            logical_to_physical_i64(
                height.min(max_content_height),
                scale_factor,
                "Search host content height",
            )
        })
        .transpose()?;
    let content_height = requested_content_height
        .unwrap_or(base_content_height)
        .max(base_content_height);
    let host_width = panel_width
        .checked_add(
            outset
                .checked_mul(2)
                .ok_or_else(|| "Search host width overflowed".to_string())?,
        )
        .ok_or_else(|| "Search host width overflowed".to_string())?;
    let host_height = content_height
        .checked_add(outset)
        .ok_or_else(|| "Search host height overflowed".to_string())?;
    let host_width = i32::try_from(host_width)
        .map_err(|_| "Search host width exceeds the physical coordinate range".to_string())?;
    let host_height = i32::try_from(host_height)
        .map_err(|_| "Search host height exceeds the physical coordinate range".to_string())?;
    let x_offset = (i64::from(work_area.width) - i64::from(host_width)) / 2;
    let x = i64::from(work_area.x)
        .checked_add(x_offset)
        .ok_or_else(|| "Search host x coordinate overflowed".to_string())?;
    let max_x = i64::from(work_area.x) + i64::from(work_area.width) - i64::from(host_width);
    let x = x.clamp(i64::from(work_area.x), max_x.max(i64::from(work_area.x)));
    let max_y = i64::from(work_area.y) + i64::from(work_area.height) - i64::from(host_height);
    let y_offset = (i64::from(work_area.height) - i64::from(host_height)) / 2;
    let y = i64::from(work_area.y)
        .checked_add(y_offset)
        .ok_or_else(|| "Search host y coordinate overflowed".to_string())?;
    let y = y.clamp(i64::from(work_area.y), max_y.max(i64::from(work_area.y)));
    let x = i32::try_from(x).map_err(|_| {
        "Search host x coordinate exceeds the physical coordinate range".to_string()
    })?;
    let y = i32::try_from(y).map_err(|_| {
        "Search host y coordinate exceeds the physical coordinate range".to_string()
    })?;
    Ok(PhysicalHostFrame {
        x,
        y,
        width: host_width,
        height: host_height,
    })
}

fn logical_to_physical_i64(value: f64, scale_factor: f64, label: &str) -> Result<i64, String> {
    let physical = (value * scale_factor).ceil();
    if !physical.is_finite() || physical <= 0.0 || physical > i64::MAX as f64 {
        return Err(format!("{label} exceeds the physical coordinate range"));
    }
    Ok(physical as i64)
}

#[cfg(target_os = "windows")]
fn monitor_work_area_for_window(
    hwnd: windows::Win32::Foundation::HWND,
) -> Result<PhysicalWorkArea, String> {
    use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTONEAREST};

    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    monitor_work_area(monitor)
}

fn scale_factor_from_dpi(dpi: u32) -> Result<f64, String> {
    if dpi == 0 {
        return Err("Search host DPI is unavailable".to_string());
    }
    Ok(f64::from(dpi) / 96.0)
}

#[cfg(target_os = "windows")]
fn win32_bool_result(result: windows::core::BOOL, action: &str) -> Result<(), String> {
    if result.as_bool() {
        return Ok(());
    }

    Err(format!("{action}: {}", windows::core::Error::from_thread()))
}

#[cfg(target_os = "windows")]
fn search_host_hwnd<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<windows::Win32::Foundation::HWND, String> {
    use raw_window_handle::HasWindowHandle;
    let handle = window
        .window_handle()
        .map_err(|error| format!("Failed to get search host handle: {error}"))?;
    match handle.as_ref() {
        raw_window_handle::RawWindowHandle::Win32(handle) => {
            Ok(windows::Win32::Foundation::HWND(handle.hwnd.get() as _))
        }
        _ => return Err("Search host is not a Win32 window".to_string()),
    }
}

#[cfg(target_os = "windows")]
fn search_host_scale_factor(hwnd: windows::Win32::Foundation::HWND) -> Result<f64, String> {
    use windows::Win32::UI::HiDpi::GetDpiForWindow;

    scale_factor_from_dpi(unsafe { GetDpiForWindow(hwnd) })
}

#[cfg(target_os = "windows")]
fn monitor_work_area(
    monitor: windows::Win32::Graphics::Gdi::HMONITOR,
) -> Result<PhysicalWorkArea, String> {
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITORINFO};

    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    win32_bool_result(
        unsafe { GetMonitorInfoW(monitor, &mut info) },
        "Failed to read active monitor work area",
    )?;
    Ok(PhysicalWorkArea {
        left: info.rcWork.left,
        top: info.rcWork.top,
        right: info.rcWork.right,
        bottom: info.rcWork.bottom,
    })
}

#[cfg(target_os = "windows")]
fn current_host_frame(hwnd: windows::Win32::Foundation::HWND) -> Result<PhysicalHostFrame, String> {
    use windows::Win32::{Foundation::RECT, UI::WindowsAndMessaging::GetWindowRect};

    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }
        .map_err(|error| format!("Failed to read search host frame: {error}"))?;
    host_frame_from_work_area(PhysicalWorkArea {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    })
}

#[cfg(target_os = "windows")]
fn apply_host_frame<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    frame: PhysicalHostFrame,
) -> Result<PhysicalHostFrame, String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
    };

    let hwnd = search_host_hwnd(window)?;
    let current = current_host_frame(hwnd)?;
    reconcile_host_frame(
        current,
        frame,
        |target| {
            unsafe {
                SetWindowPos(
                    hwnd,
                    None,
                    target.x,
                    target.y,
                    target.width,
                    target.height,
                    SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_NOACTIVATE,
                )
            }
            .map_err(|error| format!("Failed to resize search host frame: {error}"))
        },
        || current_host_frame(hwnd),
    )
}

#[cfg(target_os = "windows")]
pub fn resize_main_search_host_for_panel_with_placement<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    panel_width: f64,
    panel_height: f64,
    host_content_height: Option<f64>,
    placement: SearchHostPlacement,
) -> Result<PreparedSearchHost, String> {
    resize_main_search_host_for_panel_with_origin(
        window,
        panel_width,
        panel_height,
        host_content_height,
        placement,
        None,
    )
}

#[cfg(target_os = "windows")]
pub fn resize_main_search_host_for_panel_with_origin<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    panel_width: f64,
    panel_height: f64,
    host_content_height: Option<f64>,
    placement: SearchHostPlacement,
    physical_origin: Option<PhysicalHostOrigin>,
) -> Result<PreparedSearchHost, String> {
    if window.label() != "main" {
        return Err("Search host resize requires the main window".to_string());
    }
    let hwnd = search_host_hwnd(window)?;
    let current = current_host_frame(hwnd)?;
    let work_area = monitor_work_area_for_window(hwnd)?;
    let scale_factor = search_host_scale_factor(hwnd)?;
    let idle_frame = bounded_host_frame_for_panel_with_content_height(
        work_area,
        panel_width,
        panel_height,
        host_content_height,
        scale_factor,
    )?;
    let host_runtime = window.app_handle().try_state::<SearchHostRefreshRuntime>();
    let apply = |restore_frame| {
        let target_frame = resolve_search_host_target_frame_with_origin(
            current,
            idle_frame,
            work_area,
            placement,
            restore_frame,
            physical_origin,
        )?;
        let frame = apply_host_frame(window, target_frame)?;
        let (max_width, max_height, max_content_height) =
            search_panel_work_area_limits(work_area, scale_factor)?;
        if let Some(runtime) = window
            .app_handle()
            .try_state::<crate::core::window::search::surface::SearchWindowRuntime>(
        ) {
            runtime.window_state().constrain_to_work_area(
                max_width,
                max_height,
                max_content_height,
            );
        }
        Ok(PreparedSearchHost {
            changed: host_frame_changed(frame, target_frame),
            frame,
            target_frame,
            scale_factor,
        })
    };
    match host_runtime {
        Some(runtime) => runtime.apply_placement(current, placement, apply),
        None => apply(None),
    }
}

#[cfg(target_os = "windows")]
pub fn prepare_main_search_host_for_panel<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    panel_width: f64,
    panel_height: f64,
    host_content_height: Option<f64>,
) -> Result<PreparedSearchHost, String> {
    if is_work_area_host(window) {
        let hwnd = search_host_hwnd(window)?;
        let work_area = monitor_work_area_for_window(hwnd)?;
        return prepare_main_search_host_for_target_frame(
            window,
            host_frame_from_work_area(work_area)?,
        );
    }
    resize_main_search_host_for_panel_with_placement(
        window,
        panel_width,
        panel_height,
        host_content_height,
        SearchHostPlacement::PreserveCenter,
    )
}

#[cfg(target_os = "windows")]
fn is_work_area_host<R: Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    window
        .app_handle()
        .try_state::<SearchHostRefreshRuntime>()
        .is_some_and(|runtime| runtime.is_work_area_host())
}

#[cfg(target_os = "windows")]
pub fn prepare_main_search_host_for_target_frame<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    target_frame: PhysicalHostFrame,
) -> Result<PreparedSearchHost, String> {
    if window.label() != "main" {
        return Err("Search host preparation requires the main window".to_string());
    }
    let hwnd = search_host_hwnd(window)?;
    let scale_factor = search_host_scale_factor(hwnd)?;
    let work_area = monitor_work_area_for_window(hwnd)?;
    let target_frame = preserve_host_origin_within_work_area(target_frame, target_frame, work_area);
    let frame = apply_host_frame(window, target_frame)?;
    let (max_width, max_height, max_content_height) =
        search_panel_work_area_limits(work_area, scale_factor)?;
    if let Some(runtime) = window
        .app_handle()
        .try_state::<crate::core::window::search::surface::SearchWindowRuntime>()
    {
        runtime
            .window_state()
            .constrain_to_work_area(max_width, max_height, max_content_height);
    }
    Ok(PreparedSearchHost {
        changed: host_frame_changed(frame, target_frame),
        frame,
        target_frame,
        scale_factor,
    })
}

#[cfg(target_os = "windows")]
pub fn inspect_main_search_host_for_panel<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    panel_width: f64,
    panel_height: f64,
    host_content_height: Option<f64>,
) -> Result<PreparedSearchHost, String> {
    use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTONEAREST};

    if window.label() != "main" {
        return Err("Search host inspection requires the main window".to_string());
    }
    let hwnd = search_host_hwnd(window)?;
    let current = current_host_frame(hwnd)?;
    let scale_factor = search_host_scale_factor(hwnd)?;
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let work_area = monitor_work_area(monitor)?;
    let idle_frame = bounded_host_frame_for_panel_with_content_height(
        work_area,
        panel_width,
        panel_height,
        host_content_height,
        scale_factor,
    )?;
    let target_frame = if is_work_area_host(window) {
        host_frame_from_work_area(work_area)?
    } else {
        idle_frame
    };
    Ok(PreparedSearchHost {
        changed: host_frame_changed(current, target_frame),
        frame: current,
        target_frame,
        scale_factor,
    })
}

#[cfg(target_os = "windows")]
pub fn schedule_main_search_host_refresh<R: Runtime>(
    app_handle: &AppHandle<R>,
) -> Result<(), String> {
    let runtime = app_handle
        .try_state::<SearchHostRefreshRuntime>()
        .ok_or_else(|| "Search host refresh runtime is not initialized".to_string())?;
    if !runtime.try_schedule() {
        return Ok(());
    }

    let app_for_refresh = app_handle.clone();
    if let Err(error) = app_handle.run_on_main_thread(move || {
        let result = (|| {
            let _ = crate::core::window::search::surface::refresh_visible_host_on_main_thread(
                &app_for_refresh,
            )?;
            Ok::<(), String>(())
        })();
        if let Err(error) = result {
            log::warn!("Failed to refresh main search host: {error}");
        }
        if let Some(runtime) = app_for_refresh.try_state::<SearchHostRefreshRuntime>() {
            runtime.complete();
        }
    }) {
        runtime.complete();
        return Err(format!("Failed to schedule search host refresh: {error}"));
    }

    Ok(())
}

#[cfg(target_os = "windows")]
pub fn start_main_search_host_reconciliation<R: Runtime>(app_handle: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(HOST_RECONCILE_INTERVAL).await;
            let Some(window) = app_handle.get_webview_window("main") else {
                break;
            };
            if !window.is_visible().unwrap_or(false) {
                continue;
            }
            if let Err(error) = schedule_main_search_host_refresh(&app_handle) {
                log::warn!("Failed to schedule periodic search host refresh: {error}");
            }
        }
    });
}

#[cfg(not(target_os = "windows"))]
pub fn prepare_main_search_host<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<PreparedSearchHost, String> {
    if window.label() != "main" {
        return Err("Search host preparation requires the main window".to_string());
    }
    let position = window
        .outer_position()
        .map_err(|error| format!("Failed to read search host position: {error}"))?;
    let size = window
        .inner_size()
        .map_err(|error| format!("Failed to read search host size: {error}"))?;
    let width = i32::try_from(size.width)
        .map_err(|_| "Search host width exceeds the physical coordinate range".to_string())?;
    let height = i32::try_from(size.height)
        .map_err(|_| "Search host height exceeds the physical coordinate range".to_string())?;
    let scale_factor = window
        .scale_factor()
        .map_err(|error| format!("Failed to read search host scale factor: {error}"))?;
    let frame = PhysicalHostFrame {
        x: position.x,
        y: position.y,
        width,
        height,
    };
    Ok(PreparedSearchHost {
        changed: false,
        frame,
        target_frame: frame,
        scale_factor,
    })
}

#[cfg(not(target_os = "windows"))]
pub fn inspect_main_search_host_for_panel<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    _panel_width: f64,
    _panel_height: f64,
    _host_content_height: Option<f64>,
) -> Result<PreparedSearchHost, String> {
    prepare_main_search_host(window)
}

#[cfg(not(target_os = "windows"))]
pub fn prepare_main_search_host_for_target_frame<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    _target_frame: PhysicalHostFrame,
) -> Result<PreparedSearchHost, String> {
    prepare_main_search_host(window)
}

#[cfg(not(target_os = "windows"))]
pub fn prepare_main_search_host_for_panel<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    _panel_width: f64,
    _panel_height: f64,
    _host_content_height: Option<f64>,
) -> Result<PreparedSearchHost, String> {
    prepare_main_search_host(window)
}

#[cfg(not(target_os = "windows"))]
pub fn schedule_main_search_host_refresh<R: Runtime>(
    _app_handle: &AppHandle<R>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn start_main_search_host_reconciliation<R: Runtime>(_app_handle: AppHandle<R>) {}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use super::win32_bool_result;
    use super::{
        bounded_host_frame_for_panel, bounded_host_frame_for_panel_with_content_height,
        host_frame_changed, host_frame_from_work_area, preserve_host_center_within_work_area,
        preserve_host_origin, preserve_host_origin_within_work_area, reconcile_host_frame,
        resolve_search_host_target_frame, resolve_search_host_target_frame_with_origin,
        scale_factor_from_dpi, PhysicalHostFrame, PhysicalHostOrigin, PhysicalWorkArea,
        SearchHostPlacement, SearchHostRefreshRuntime, SEARCH_HOST_TOP_INSET_PHYSICAL,
        SEARCH_HOST_VISUAL_OUTSET_LOGICAL,
    };
    #[cfg(target_os = "windows")]
    #[test]
    fn win32_bool_result_preserves_action_context() {
        use windows::core::BOOL;

        assert!(win32_bool_result(BOOL(1), "read monitor").is_ok());
        let error = win32_bool_result(BOOL(0), "read monitor").unwrap_err();
        assert!(error.starts_with("read monitor:"));
    }

    #[test]
    fn keeps_negative_virtual_screen_origin() {
        assert_eq!(
            host_frame_from_work_area(PhysicalWorkArea {
                left: -1920,
                top: -120,
                right: 0,
                bottom: 920
            }),
            Ok(PhysicalHostFrame {
                x: -1920,
                y: -120,
                width: 1920,
                height: 1040
            })
        );
    }
    #[test]
    fn uses_work_area_instead_of_full_monitor_bounds() {
        assert_eq!(
            host_frame_from_work_area(PhysicalWorkArea {
                left: 0,
                top: 0,
                right: 2560,
                bottom: 1400
            })
            .unwrap()
            .height,
            1400
        );
    }
    #[test]
    fn rejects_inverted_work_area() {
        assert!(host_frame_from_work_area(PhysicalWorkArea {
            left: 100,
            top: 0,
            right: 10,
            bottom: 100
        })
        .is_err());
    }

    #[test]
    fn bounded_default_panel_reserves_dpi_scaled_shadow_envelope() {
        let area = PhysicalWorkArea {
            left: 0,
            top: 0,
            right: 2560,
            bottom: 1400,
        };
        let frame = bounded_host_frame_for_panel(area, 750.0, 60.0, 1.5)
            .expect("bounded default host frame");

        assert_eq!(
            frame,
            PhysicalHostFrame {
                x: 645,
                y: 571,
                width: 1269,
                height: 258,
            }
        );
        assert_ne!(frame, host_frame_from_work_area(area).unwrap());
        assert_eq!(
            frame.width,
            (750.0_f64 * 1.5).ceil() as i32
                + 2 * (SEARCH_HOST_VISUAL_OUTSET_LOGICAL * 1.5).ceil() as i32
        );
        assert_eq!(
            frame.height,
            SEARCH_HOST_TOP_INSET_PHYSICAL
                + (60.0_f64 * 1.5).ceil() as i32
                + (SEARCH_HOST_VISUAL_OUTSET_LOGICAL * 1.5).ceil() as i32
        );
    }

    #[test]
    fn bounded_host_expands_for_overlay_content_without_changing_panel_position() {
        let area = PhysicalWorkArea {
            left: 0,
            top: 0,
            right: 2560,
            bottom: 1400,
        };
        let frame =
            bounded_host_frame_for_panel_with_content_height(area, 750.0, 60.0, Some(520.0), 1.5)
                .expect("bounded overlay host frame");

        assert_eq!(frame.x, 645);
        assert_eq!(frame.y, (1400 - frame.height) / 2);
        assert_eq!(frame.width, 1269);
        assert_eq!(frame.height, (520.0_f64 * 1.5).ceil() as i32 + 72);
    }

    #[test]
    fn bounded_host_ignores_overlay_extent_smaller_than_panel_extent() {
        let area = PhysicalWorkArea {
            left: 0,
            top: 0,
            right: 2560,
            bottom: 1400,
        };

        assert_eq!(
            bounded_host_frame_for_panel_with_content_height(area, 750.0, 60.0, Some(100.0), 1.5,)
                .unwrap(),
            bounded_host_frame_for_panel(area, 750.0, 60.0, 1.5).unwrap()
        );
    }

    #[test]
    fn bounded_host_clamps_oversized_panel_origin_to_work_area() {
        let frame = bounded_host_frame_for_panel(
            PhysicalWorkArea {
                left: -1920,
                top: -120,
                right: 0,
                bottom: 920,
            },
            3000.0,
            2000.0,
            1.0,
        )
        .expect("bounded oversized host frame");

        assert_eq!(frame.x, -1920);
        assert_eq!(frame.y, -120);
        assert_eq!(frame.width, 1920);
        assert_eq!(frame.height, 1040);
    }

    #[test]
    fn user_keeps_the_input_inside_a_short_high_dpi_work_area() {
        let area = PhysicalWorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1040,
        };
        let frame = bounded_host_frame_for_panel(area, 750.0, 660.0, 1.5).unwrap();
        assert!(frame.y + frame.height <= area.bottom);
    }

    #[test]
    fn bounded_host_rejects_non_finite_or_non_positive_panel_geometry() {
        let area = PhysicalWorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };

        for (width, height, scale_factor) in [
            (0.0, 60.0, 1.0),
            (-1.0, 60.0, 1.0),
            (750.0, 0.0, 1.0),
            (750.0, -1.0, 1.0),
            (750.0, 60.0, 0.0),
            (750.0, 60.0, -1.0),
            (f64::NAN, 60.0, 1.0),
            (750.0, f64::INFINITY, 1.0),
            (750.0, 60.0, f64::NAN),
        ] {
            assert!(
                bounded_host_frame_for_panel(area, width, height, scale_factor).is_err(),
                "expected rejection for panel {width}x{height} at scale {scale_factor}"
            );
        }
    }

    #[test]
    fn host_frame_change_detection_suppresses_identical_updates() {
        let current = PhysicalHostFrame {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1040,
        };

        assert!(!host_frame_changed(current, current));
        assert!(host_frame_changed(
            current,
            PhysicalHostFrame {
                height: 1000,
                ..current
            }
        ));
    }

    #[test]
    fn host_resize_preserves_the_current_dragged_origin() {
        let current = PhysicalHostFrame {
            x: -1800,
            y: 32,
            width: 1269,
            height: 258,
        };
        let centered_target = PhysicalHostFrame {
            x: -1695,
            y: 0,
            width: 1269,
            height: 900,
        };

        assert_eq!(
            preserve_host_origin(current, centered_target),
            PhysicalHostFrame {
                x: -1800,
                y: 32,
                width: 1269,
                height: 900,
            }
        );
    }

    #[test]
    fn host_resize_clamps_a_dragged_origin_when_the_expanded_frame_would_leave_work_area() {
        let current = PhysicalHostFrame {
            x: 300,
            y: 900,
            width: 1269,
            height: 258,
        };
        let centered_target = PhysicalHostFrame {
            x: 325,
            y: 0,
            width: 1269,
            height: 548,
        };
        let work_area = PhysicalWorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };

        assert_eq!(
            preserve_host_origin_within_work_area(current, centered_target, work_area),
            PhysicalHostFrame {
                x: 300,
                y: 532,
                width: 1269,
                height: 548,
            }
        );
    }

    #[test]
    fn host_resize_preserves_the_current_center_when_requested() {
        let current = PhysicalHostFrame {
            x: 300,
            y: 300,
            width: 1269,
            height: 258,
        };
        let target = PhysicalHostFrame {
            x: 325,
            y: 0,
            width: 1269,
            height: 600,
        };
        let work_area = PhysicalWorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };

        assert_eq!(
            preserve_host_center_within_work_area(current, target, work_area),
            PhysicalHostFrame {
                x: 300,
                y: 129,
                width: 1269,
                height: 600,
            }
        );
    }

    #[test]
    fn host_resize_clamps_the_centered_origin_to_the_work_area() {
        let current = PhysicalHostFrame {
            x: 300,
            y: 0,
            width: 1269,
            height: 258,
        };
        let target = PhysicalHostFrame {
            x: 325,
            y: 0,
            width: 1269,
            height: 1000,
        };
        let work_area = PhysicalWorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };

        assert_eq!(
            preserve_host_center_within_work_area(current, target, work_area),
            PhysicalHostFrame {
                x: 300,
                y: 0,
                width: 1269,
                height: 1000,
            }
        );
    }

    #[test]
    fn host_reconciliation_rereads_actual_frame_after_resize() {
        let current = PhysicalHostFrame {
            x: 20,
            y: 20,
            width: 800,
            height: 600,
        };
        let target = PhysicalHostFrame {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };
        let final_actual = PhysicalHostFrame {
            x: 0,
            y: 0,
            width: 1918,
            height: 1040,
        };
        let mut applied = None;

        let observed = reconcile_host_frame(
            current,
            target,
            |requested| {
                applied = Some(requested);
                Ok(())
            },
            || Ok(final_actual),
        )
        .expect("host reconciliation");

        assert_eq!(applied, Some(target));
        assert_eq!(observed, final_actual);
    }

    #[test]
    fn dpi_scale_factor_uses_final_hwnd_dpi_and_rejects_zero() {
        assert_eq!(scale_factor_from_dpi(96), Ok(1.0));
        assert_eq!(scale_factor_from_dpi(144), Ok(1.5));
        assert!(scale_factor_from_dpi(0).is_err());
    }

    #[test]
    fn refresh_runtime_coalesces_overlapping_requests() {
        let runtime = SearchHostRefreshRuntime::new();

        assert!(runtime.try_schedule());
        assert!(!runtime.try_schedule());
        runtime.complete();
        assert!(runtime.try_schedule());
    }

    #[test]
    fn user_keeps_the_requested_negative_origin_when_resizing_on_a_left_monitor() {
        let area = PhysicalWorkArea {
            left: -1920,
            top: -120,
            right: 0,
            bottom: 1080,
        };
        let current = PhysicalHostFrame {
            x: -1700,
            y: 100,
            width: 900,
            height: 400,
        };
        let target = bounded_host_frame_for_panel(area, 800.0, 350.0, 1.5).unwrap();

        let resized = resolve_search_host_target_frame_with_origin(
            current,
            target,
            area,
            SearchHostPlacement::PreserveOrigin,
            None,
            Some(PhysicalHostOrigin { x: -1800, y: -80 }),
        )
        .unwrap();

        assert_eq!(
            resized,
            PhysicalHostFrame {
                x: -1800,
                y: -80,
                width: 1344,
                height: 693,
            }
        );
    }

    #[test]
    fn user_keeps_the_resized_frame_inside_the_work_area_when_origin_exceeds_its_edges() {
        let area = PhysicalWorkArea {
            left: -1920,
            top: -120,
            right: 0,
            bottom: 1080,
        };
        let target = bounded_host_frame_for_panel(area, 800.0, 350.0, 1.5).unwrap();

        for (origin, expected) in [
            (PhysicalHostOrigin { x: -3000, y: -300 }, (-1920, -120)),
            (PhysicalHostOrigin { x: 100, y: 1000 }, (-1344, 387)),
        ] {
            let resized = resolve_search_host_target_frame_with_origin(
                target,
                target,
                area,
                SearchHostPlacement::PreserveOrigin,
                None,
                Some(origin),
            )
            .unwrap();

            assert_eq!((resized.x, resized.y), expected);
            assert_eq!((resized.width, resized.height), (1344, 693));
        }
    }

    #[test]
    fn user_keeps_existing_placements_when_no_explicit_origin_is_requested() {
        let area = PhysicalWorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
        let current = PhysicalHostFrame {
            x: 200,
            y: 300,
            width: 900,
            height: 400,
        };
        let target = bounded_host_frame_for_panel(area, 800.0, 350.0, 1.0).unwrap();

        for placement in [
            SearchHostPlacement::PreserveOrigin,
            SearchHostPlacement::PreserveCenter,
            SearchHostPlacement::Idle,
            SearchHostPlacement::WorkArea,
            SearchHostPlacement::Restore,
        ] {
            assert_eq!(
                resolve_search_host_target_frame_with_origin(
                    current,
                    target,
                    area,
                    placement,
                    Some(current),
                    None,
                ),
                resolve_search_host_target_frame(current, target, area, placement, Some(current)),
            );
        }
    }

    #[test]
    fn work_area_placement_uses_the_full_work_area() {
        let current = PhysicalHostFrame {
            x: 300,
            y: 40,
            width: 1269,
            height: 258,
        };
        let work_area = PhysicalWorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
        let idle = PhysicalHostFrame {
            x: 325,
            y: 0,
            width: 1269,
            height: 258,
        };
        assert_eq!(
            resolve_search_host_target_frame(
                current,
                idle,
                work_area,
                SearchHostPlacement::WorkArea,
                None
            )
            .unwrap(),
            host_frame_from_work_area(work_area).unwrap()
        );
    }

    #[test]
    fn idle_placement_uses_the_canonical_bounded_frame() {
        let current = PhysicalHostFrame {
            x: 300,
            y: 300,
            width: 1269,
            height: 900,
        };
        let work_area = PhysicalWorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
        let idle = PhysicalHostFrame {
            x: 325,
            y: 0,
            width: 1269,
            height: 258,
        };
        assert_eq!(
            resolve_search_host_target_frame(
                current,
                idle,
                work_area,
                SearchHostPlacement::Idle,
                None
            )
            .unwrap(),
            idle
        );
    }

    #[test]
    fn user_restores_saved_placement_with_current_monitor_dimensions() {
        let current = PhysicalHostFrame {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let work_area = PhysicalWorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
        let idle = PhysicalHostFrame {
            x: 325,
            y: 0,
            width: 1269,
            height: 258,
        };
        let saved = PhysicalHostFrame {
            x: 280,
            y: 48,
            width: 1269,
            height: 420,
        };
        assert_eq!(
            resolve_search_host_target_frame(
                current,
                idle,
                work_area,
                SearchHostPlacement::Restore,
                Some(saved)
            )
            .unwrap(),
            PhysicalHostFrame {
                x: saved.x,
                y: saved.y,
                ..idle
            }
        );
        assert_eq!(
            resolve_search_host_target_frame(
                current,
                idle,
                work_area,
                SearchHostPlacement::Restore,
                None
            )
            .unwrap(),
            idle
        );
    }

    #[test]
    fn user_restores_within_the_work_area_after_switching_to_a_shorter_monitor() {
        let area = PhysicalWorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1040,
        };
        let saved = PhysicalHostFrame {
            x: 1700,
            y: 78,
            width: 1269,
            height: 1443,
        };
        let idle = bounded_host_frame_for_panel(area, 750.0, 850.0, 1.5).unwrap();
        let restored = resolve_search_host_target_frame(
            host_frame_from_work_area(area).unwrap(),
            idle,
            area,
            SearchHostPlacement::Restore,
            Some(saved),
        )
        .unwrap();
        assert!(restored.x >= area.left && restored.y >= area.top);
        assert!(restored.x + restored.width <= area.right);
        assert!(restored.y + restored.height <= area.bottom);
        assert_eq!((restored.width, restored.height), (idle.width, idle.height));
    }

    #[test]
    fn user_returns_to_the_original_frame_after_repeated_maximize_requests() {
        let runtime = SearchHostRefreshRuntime::new();
        let first = PhysicalHostFrame {
            x: 10,
            y: 20,
            width: 800,
            height: 400,
        };
        let second = PhysicalHostFrame {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        runtime
            .apply_placement(first, SearchHostPlacement::WorkArea, |_| Ok(()))
            .unwrap();
        runtime
            .apply_placement(second, SearchHostPlacement::WorkArea, |_| Ok(()))
            .unwrap();
        assert!(runtime.is_work_area_host());
        assert_eq!(
            runtime
                .apply_placement(second, SearchHostPlacement::Restore, Ok)
                .unwrap(),
            Some(first)
        );
        assert!(!runtime.is_work_area_host());
        assert_eq!(
            runtime
                .apply_placement(second, SearchHostPlacement::Restore, Ok)
                .unwrap(),
            None
        );
    }

    #[test]
    fn user_can_retry_restore_or_reset_after_native_placement_fails() {
        let saved = PhysicalHostFrame {
            x: 10,
            y: 20,
            width: 800,
            height: 400,
        };
        for placement in [SearchHostPlacement::Restore, SearchHostPlacement::Idle] {
            let runtime = SearchHostRefreshRuntime::new();
            runtime
                .apply_placement(saved, SearchHostPlacement::WorkArea, |_| Ok(()))
                .unwrap();
            let result: Result<(), String> =
                runtime.apply_placement(saved, placement, |_| Err("apply failed".into()));
            assert_eq!(result, Err("apply failed".into()));
            assert!(runtime.is_work_area_host());
            let restored = runtime
                .apply_placement(saved, SearchHostPlacement::Restore, Ok)
                .unwrap();
            assert_eq!(restored, Some(saved));
            assert!(!runtime.is_work_area_host());
        }
    }

    #[test]
    fn user_keeps_bounded_mode_after_maximize_fails() {
        let runtime = SearchHostRefreshRuntime::new();
        let current = PhysicalHostFrame {
            x: 10,
            y: 20,
            width: 800,
            height: 400,
        };
        let result: Result<(), String> =
            runtime.apply_placement(current, SearchHostPlacement::WorkArea, |_| {
                Err("apply failed".into())
            });
        assert_eq!(result, Err("apply failed".into()));
        assert!(!runtime.is_work_area_host());
        runtime
            .apply_placement(current, SearchHostPlacement::WorkArea, |_| Ok(()))
            .unwrap();
        assert!(runtime.is_work_area_host());
        assert_eq!(
            runtime
                .apply_placement(current, SearchHostPlacement::Restore, Ok)
                .unwrap(),
            Some(current)
        );
    }
}
