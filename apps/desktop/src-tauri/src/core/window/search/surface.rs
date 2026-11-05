// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 搜索窗口组原生 surface 状态。

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex, MutexGuard, TryLockError,
};
#[cfg(target_os = "windows")]
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::{
    bounds::{SearchWindowDefaults, SearchWindowState},
    protocol::{
        SearchHostPreparationRequest, SearchShortcutAction, SearchSurfaceActivation,
        SearchSurfacePhase, SearchSurfaceProtocol, SearchSurfaceSource,
    },
};
use crate::core::window::search_host::{PhysicalHostFrame, PreparedSearchHost};

pub use super::protocol::SearchSurfaceSource as SearchSurfaceShowSource;

impl SearchSurfaceShowSource {
    /// Classify the native requesting window, never a caller-provided label.
    pub(crate) fn from_requesting_window(label: &str) -> Self {
        if label == crate::core::window::tray::TRAY_MENU_WINDOW_LABEL {
            Self::Tray
        } else {
            Self::Main
        }
    }
}

/// 搜索窗口组隐藏原因。
pub enum SearchSurfaceHideReason {
    AppBlurHide,
    ManualDismiss,
    PolicyToggleHide,
}

impl SearchSurfaceHideReason {
    /// 转成前端事件载荷字符串。
    fn as_str(&self) -> &'static str {
        match self {
            Self::AppBlurHide => "app-blur-hide",
            Self::ManualDismiss => "manual-dismiss",
            Self::PolicyToggleHide => "policy-toggle-hide",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSurfacePreparationToken {
    pub renderer_epoch: u64,
    pub show_epoch: u64,
    pub host_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSurfacePreparationPayload {
    pub renderer_epoch: u64,
    pub show_epoch: u64,
    pub host_epoch: u64,
    pub source: &'static str,
    pub physical_viewport: PhysicalHostFrame,
    pub scale_factor: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSurfaceShowStatus {
    status: &'static str,
    renderer_epoch: u64,
    show_epoch: u64,
    host_epoch: u64,
    generation: u64,
}

impl SearchSurfaceShowStatus {
    fn shown(activation: SearchSurfaceActivation) -> Self {
        Self {
            status: "shown",
            renderer_epoch: activation.renderer_epoch,
            show_epoch: activation.show_epoch,
            host_epoch: activation.host_epoch,
            generation: activation.region_generation,
        }
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchSurfaceShownPayload {
    source: &'static str,
    sequence: u64,
    renderer_epoch: u64,
    show_epoch: u64,
    host_epoch: u64,
    generation: u64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchSurfaceHiddenPayload {
    reason: &'static str,
    sequence: u64,
}

/// 搜索窗口组原生运行时状态。
pub struct SearchWindowRuntime {
    hide_on_app_blur: AtomicBool,
    allow_height_override: AtomicBool,
    visibility_transaction: Mutex<()>,
    surface: Mutex<SearchSurfaceState>,
    sequence: AtomicU64,
    window_state: SearchWindowState,
    native_enabled: bool,
}

#[derive(Debug, Clone, PartialEq)]
struct SearchSurfaceState {
    protocol: SearchSurfaceProtocol,
    pending_preparation: Option<SearchSurfacePreparationState>,
    active_preparation: Option<SearchSurfacePreparationState>,
}

#[derive(Debug, Clone, PartialEq)]
struct SearchSurfacePreparationState {
    payload: SearchSurfacePreparationPayload,
    target_frame: PhysicalHostFrame,
}

impl SearchSurfacePreparationState {
    fn new(payload: SearchSurfacePreparationPayload, host: PreparedSearchHost) -> Self {
        Self {
            payload,
            target_frame: host.target_frame,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostRefreshOutcome {
    Current,
    Refreshed {
        request: SearchHostPreparationRequest,
        target_frame: PhysicalHostFrame,
    },
    NotApplicable,
}

#[derive(Debug, Clone)]
pub struct SearchSurfaceProtocolSnapshot {
    pub phase: &'static str,
    pub renderer_epoch: u64,
    pub renderer_ready: bool,
    pub desired_visible: bool,
    pub pending_preparation: Option<SearchSurfacePreparationPayload>,
    pub last_shown: Option<SearchSurfaceActivation>,
}

/// 搜索窗口组失焦隐藏决策输入。
#[derive(Debug, Clone, Copy)]
struct FocusLostDecisionInput {
    hide_on_app_blur: bool,
    main_visible: bool,
    main_maximized: bool,
    main_always_on_top: bool,
    app_focused: bool,
}

pub type SearchSurfaceRuntime = SearchWindowRuntime;

impl SearchWindowRuntime {
    /// 创建搜索窗口组运行时。
    pub fn new() -> Self {
        Self::with_native_enabled(true)
    }

    pub(crate) fn for_tests() -> Self {
        Self::with_native_enabled(false)
    }

    fn with_native_enabled(native_enabled: bool) -> Self {
        Self {
            hide_on_app_blur: AtomicBool::new(true),
            allow_height_override: AtomicBool::new(false),
            visibility_transaction: Mutex::new(()),
            surface: Mutex::new(SearchSurfaceState {
                protocol: SearchSurfaceProtocol::new(),
                pending_preparation: None,
                active_preparation: None,
            }),
            sequence: AtomicU64::new(0),
            window_state: SearchWindowState::default(),
            native_enabled,
        }
    }

    /// 生成搜索窗口组事实事件的单调序号。
    pub fn next_sequence(&self) -> u64 {
        self.sequence.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// 设置应用失焦时是否自动隐藏搜索窗口组。
    pub fn set_hide_on_app_blur(&self, should_hide: bool) {
        self.hide_on_app_blur.store(should_hide, Ordering::Relaxed);
    }

    /// 读取应用失焦自动隐藏策略。
    pub fn should_hide_on_app_blur(&self) -> bool {
        self.hide_on_app_blur.load(Ordering::Relaxed)
    }

    /// 设置当前是否允许用户通过手动 resize 覆盖窗口高度。
    pub fn set_allow_height_override(&self, allow: bool) {
        self.allow_height_override.store(allow, Ordering::Relaxed);
    }

    /// 读取当前是否允许用户通过手动 resize 覆盖窗口高度。
    pub fn should_allow_height_override(&self) -> bool {
        self.allow_height_override.load(Ordering::Relaxed)
    }

    pub(crate) fn renderer_readiness_snapshot(&self) -> (bool, Option<&'static str>) {
        let state = self
            .surface
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        (
            state.protocol.renderer_ready(),
            (!state.protocol.renderer_ready() && state.protocol.desired_visible())
                .then(|| state.protocol.source())
                .flatten()
                .map(SearchSurfaceSource::as_str),
        )
    }

    pub fn protocol_snapshot(&self) -> SearchSurfaceProtocolSnapshot {
        let state = self
            .surface
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        SearchSurfaceProtocolSnapshot {
            phase: state.protocol.phase().as_str(),
            renderer_epoch: state.protocol.renderer_epoch(),
            renderer_ready: state.protocol.renderer_ready(),
            desired_visible: state.protocol.desired_visible(),
            pending_preparation: state
                .pending_preparation
                .as_ref()
                .map(|preparation| preparation.payload.clone()),
            last_shown: state.protocol.last_shown(),
        }
    }

    fn try_begin_host_refresh(&self) -> Option<MutexGuard<'_, ()>> {
        match self.visibility_transaction.try_lock() {
            Ok(guard) => Some(guard),
            Err(TryLockError::Poisoned(error)) => Some(error.into_inner()),
            Err(TryLockError::WouldBlock) => None,
        }
    }

    /// Resize the bounded host without turning the renderer-owned resize into
    /// a new surface preparation. Windows emits a resize callback for the
    /// SetWindowPos below; keeping this transaction locked and rebasing the
    /// accepted host facts prevents that callback from calling show() again.
    pub(crate) fn resize_host_preserving_surface<F>(
        &self,
        resize: F,
    ) -> Result<PreparedSearchHost, String>
    where
        F: FnOnce() -> Result<PreparedSearchHost, String>,
    {
        let _visibility_guard = self
            .visibility_transaction
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let host = resize()?;
        let mut state = self
            .surface
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        accept_host_resize_for_current_surface(&mut state, host);
        Ok(host)
    }

    pub fn renderer_epoch(&self) -> u64 {
        self.surface
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .protocol
            .renderer_epoch()
    }

    pub fn resolve_shortcut_action(
        &self,
        is_visible: bool,
        is_app_focused: bool,
    ) -> SearchShortcutAction {
        self.surface
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .protocol
            .resolve_shortcut_action(is_visible, is_app_focused)
    }

    fn is_protocol_visible(&self) -> bool {
        self.surface
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .protocol
            .phase()
            == SearchSurfacePhase::Visible
    }

    /// 返回搜索窗口尺寸状态。
    pub fn window_state(&self) -> &SearchWindowState {
        &self.window_state
    }
}

/// 更新搜索窗口默认尺寸。
pub fn update_window_defaults<R: Runtime>(
    app_handle: &AppHandle<R>,
    defaults: SearchWindowDefaults,
) -> Result<SearchWindowDefaults, String> {
    let runtime = app_handle
        .try_state::<SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
    Ok(runtime.window_state().update_defaults(defaults))
}

/// 判断某次原生失焦是否应该隐藏完整搜索窗口组。
fn should_hide_on_focus_lost(input: FocusLostDecisionInput) -> bool {
    if !input.hide_on_app_blur || !input.main_visible || input.main_always_on_top {
        return false;
    }
    if input.app_focused {
        return false;
    }
    if input.main_maximized {
        return false;
    }

    true
}

fn foreground_belongs_to_main_hwnd_family(
    is_same_window: bool,
    is_child_window: bool,
    shares_root: bool,
    shares_root_owner: bool,
) -> bool {
    is_same_window || is_child_window || shares_root || shares_root_owner
}

#[cfg(target_os = "windows")]
fn main_hwnd_family_is_foreground<R: Runtime>(main_window: &tauri::WebviewWindow<R>) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetForegroundWindow, IsChild, GA_ROOT, GA_ROOTOWNER,
    };

    let Ok(main_hwnd) = super::get_window_hwnd(main_window) else {
        return false;
    };
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.0.is_null() {
        return false;
    }

    let main_root = unsafe { GetAncestor(main_hwnd, GA_ROOT) };
    let foreground_root = unsafe { GetAncestor(foreground, GA_ROOT) };
    let main_root_owner = unsafe { GetAncestor(main_hwnd, GA_ROOTOWNER) };
    let foreground_root_owner = unsafe { GetAncestor(foreground, GA_ROOTOWNER) };
    foreground_belongs_to_main_hwnd_family(
        foreground == main_hwnd,
        unsafe { IsChild(main_hwnd, foreground).as_bool() },
        !main_root.0.is_null() && main_root == foreground_root,
        !main_root_owner.0.is_null() && main_root_owner == foreground_root_owner,
    )
}

#[cfg(not(target_os = "windows"))]
fn main_hwnd_family_is_foreground<R: Runtime>(main_window: &tauri::WebviewWindow<R>) -> bool {
    main_window.is_focused().unwrap_or(false)
}

/// 设置搜索窗口组应用失焦隐藏策略。
pub fn set_hide_on_app_blur<R: Runtime>(
    app_handle: &AppHandle<R>,
    should_hide: bool,
) -> Result<(), String> {
    let runtime = app_handle
        .try_state::<SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
    runtime.set_hide_on_app_blur(should_hide);
    Ok(())
}

/// 设置当前搜索窗口是否允许高度手动 override。
pub fn set_allow_height_override<R: Runtime>(
    app_handle: &AppHandle<R>,
    allow: bool,
) -> Result<(), String> {
    let runtime = app_handle
        .try_state::<SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
    runtime.set_allow_height_override(allow);
    Ok(())
}

/// 显示搜索窗口组并广播原生事实。
pub fn show_surface_on_main_thread<R: Runtime>(
    app_handle: &AppHandle<R>,
    source: SearchSurfaceShowSource,
) -> Result<(), String> {
    let runtime = app_handle
        .try_state::<SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "Failed to get main window".to_string())?;
    let _visibility_guard = runtime
        .visibility_transaction
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (host_request, visible_activation) = {
        let mut state = runtime
            .surface
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let host_request = state.protocol.request_show(source);
        if host_request.is_some() {
            state.pending_preparation = None;
            state.active_preparation = None;
        }
        let visible_activation = (state.protocol.phase() == SearchSurfacePhase::Visible)
            .then(|| state.protocol.last_shown())
            .flatten();
        (host_request, visible_activation)
    };

    if let Some(request) = host_request {
        let _ = prepare_show_locked(app_handle, runtime.inner(), &window, request, None, true)?;
        return Ok(());
    }
    if let Some(activation) = visible_activation {
        activate_main_window(runtime.inner(), &window)?;
        emit_shown(app_handle, runtime.inner(), source, activation)?;
    }
    Ok(())
}

pub fn renderer_epoch<R: Runtime>(app_handle: &AppHandle<R>) -> Result<u64, String> {
    let runtime = app_handle
        .try_state::<SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
    Ok(runtime.renderer_epoch())
}

pub fn mark_renderer_ready_on_main_thread<R: Runtime>(
    app_handle: &AppHandle<R>,
    renderer_epoch: u64,
) -> Result<Option<SearchSurfacePreparationPayload>, String> {
    let runtime = app_handle
        .try_state::<SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "Failed to get main window".to_string())?;
    let _visibility_guard = runtime
        .visibility_transaction
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let host_request = {
        let mut state = runtime
            .surface
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if renderer_epoch != state.protocol.renderer_epoch() {
            return Ok(None);
        }
        let request = state.protocol.mark_renderer_ready(renderer_epoch);
        if request.is_none() {
            return Ok(state
                .pending_preparation
                .as_ref()
                .map(|preparation| preparation.payload.clone()));
        }
        request
    };
    prepare_show_locked(
        app_handle,
        runtime.inner(),
        &window,
        host_request.expect("checked host request"),
        None,
        true,
    )
}

/// 隐藏搜索窗口组并广播原生事实。
pub fn hide_surface_on_main_thread<R: Runtime>(
    app_handle: &AppHandle<R>,
    reason: SearchSurfaceHideReason,
) -> Result<(), String> {
    let runtime = app_handle
        .try_state::<SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "Failed to get main window".to_string())?;
    let _visibility_guard = runtime
        .visibility_transaction
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut state = runtime
        .surface
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    hide_surface_state_transaction(&mut state, |_| {
        super::hide_search_window_without_animation(&window)
    })?;
    drop(state);
    app_handle
        .emit(
            "search-surface-hidden",
            SearchSurfaceHiddenPayload {
                reason: reason.as_str(),
                sequence: runtime.next_sequence(),
            },
        )
        .map_err(|error| format!("Failed to emit search surface hidden event: {}", error))
}

fn hide_surface_state_transaction<E, F>(
    state: &mut SearchSurfaceState,
    hide_native: F,
) -> Result<(), E>
where
    F: FnOnce(&SearchSurfaceState) -> Result<(), E>,
{
    let previous = state.clone();
    state.protocol.hide();
    state.pending_preparation = None;
    state.active_preparation = None;

    if let Err(error) = hide_native(state) {
        *state = previous;
        return Err(error);
    }

    Ok(())
}

pub fn register_renderer_load_on_main_thread<R: Runtime>(
    app_handle: &AppHandle<R>,
) -> Result<u64, String> {
    let runtime = app_handle
        .try_state::<SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "Failed to get main window".to_string())?;
    let _visibility_guard = runtime
        .visibility_transaction
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let renderer_epoch = {
        let mut state = runtime
            .surface
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.pending_preparation = None;
        state.active_preparation = None;
        state.protocol.page_load_started()
    };
    window.hide().map_err(|error| error.to_string())?;
    Ok(renderer_epoch)
}

pub(crate) fn commit_prepared_region_on_main_thread<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    token: SearchSurfacePreparationToken,
    generation: u64,
) -> Result<Option<SearchSurfaceShowStatus>, String> {
    let app_handle = window.app_handle();
    let runtime = app_handle
        .try_state::<SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
    let _visibility_guard = runtime
        .visibility_transaction
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    {
        let state = runtime
            .surface
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(preparation) = state.protocol.preparation() else {
            return Ok(None);
        };
        if token
            != (SearchSurfacePreparationToken {
                renderer_epoch: preparation.renderer_epoch,
                show_epoch: preparation.show_epoch,
                host_epoch: preparation.host_epoch,
            })
        {
            return Ok(None);
        }
    }
    let inspected = inspect_host(runtime.inner(), window)?;
    let refresh_request = {
        let mut state = runtime
            .surface
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(preparation) = state.protocol.preparation() else {
            return Ok(None);
        };
        if token
            != (SearchSurfacePreparationToken {
                renderer_epoch: preparation.renderer_epoch,
                show_epoch: preparation.show_epoch,
                host_epoch: preparation.host_epoch,
            })
        {
            return Ok(None);
        }
        match refresh_host_if_needed(&mut state, inspected) {
            HostRefreshOutcome::Current => None,
            HostRefreshOutcome::Refreshed {
                request,
                target_frame,
            } => Some((request, target_frame)),
            HostRefreshOutcome::NotApplicable => return Ok(None),
        }
    };
    if let Some((request, target_frame)) = refresh_request {
        let _ = prepare_show_locked(
            app_handle,
            runtime.inner(),
            window,
            request,
            Some(target_frame),
            false,
        )?;
        return Ok(None);
    }
    let activation = {
        let mut state = runtime
            .surface
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(preparation) = state.protocol.preparation() else {
            return Ok(None);
        };
        if token
            != (SearchSurfacePreparationToken {
                renderer_epoch: preparation.renderer_epoch,
                show_epoch: preparation.show_epoch,
                host_epoch: preparation.host_epoch,
            })
        {
            return Ok(None);
        }
        let Some(activation) = state.protocol.region_applied(preparation, generation) else {
            return Ok(None);
        };
        activation
    };

    // A visible host can receive a new region after a bounded resize. Calling
    // show()/set_focus() in that path re-enters the window and steals focus
    // from an open overlay, which is rendered in this same WebView.
    let should_activate_native_window =
        runtime.native_enabled && !window.is_visible().unwrap_or(false);
    if should_activate_native_window {
        if let Err(error) = activate_main_window(runtime.inner(), window) {
            let mut state = runtime
                .surface
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.protocol.activation_failed(activation);
            state.pending_preparation = None;
            state.active_preparation = None;
            let _ = window.hide();
            return Err(error);
        }
    }
    // The test runtime does not own a real native host, so its mock window
    // visibility is not a reliable activation signal. Emit the same causal
    // shown fact once the protocol transitions to visible.
    if should_activate_native_window || !runtime.native_enabled {
        if let Err(error) = emit_shown(app_handle, runtime.inner(), activation.source, activation) {
            let mut state = runtime
                .surface
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.protocol.activation_failed(activation);
            state.pending_preparation = None;
            state.active_preparation = None;
            let _ = window.hide();
            return Err(error);
        }
    }
    {
        let mut state = runtime
            .surface
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.protocol.activation_succeeded(activation).is_none() {
            state.protocol.activation_failed(activation);
            state.pending_preparation = None;
            let _ = window.hide();
            return Ok(None);
        }
        state.active_preparation = state.pending_preparation.take();
    }
    // The preparation commit is successful even when another native show
    // request made the host visible while the region IPC was in flight. In
    // that case we intentionally skip show()/focus(), but the renderer still
    // needs an acknowledgement for the matching preparation token.
    Ok(Some(SearchSurfaceShowStatus::shown(activation)))
}

pub(in crate::core::window) fn refresh_visible_host_on_main_thread<R: Runtime>(
    app_handle: &AppHandle<R>,
) -> Result<bool, String> {
    let runtime = app_handle
        .try_state::<SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
    if !runtime.native_enabled {
        return Ok(false);
    }
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "Failed to get main window".to_string())?;
    let Some(_visibility_guard) = runtime.try_begin_host_refresh() else {
        return Ok(false);
    };
    let snapshot = runtime.window_state().snapshot();
    let inspected = crate::core::window::search_host::inspect_main_search_host_for_panel(
        &window,
        snapshot.current_width,
        snapshot.current_height,
        snapshot.host_content_height,
    )?;
    let (request, target_frame) = {
        let mut state = runtime
            .surface
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match refresh_host_if_needed(&mut state, inspected) {
            HostRefreshOutcome::Refreshed {
                request,
                target_frame,
            } => (request, target_frame),
            HostRefreshOutcome::Current | HostRefreshOutcome::NotApplicable => return Ok(false),
        }
    };
    Ok(prepare_show_locked(
        app_handle,
        runtime.inner(),
        &window,
        request,
        Some(target_frame),
        false,
    )?
    .is_some())
}

fn refresh_host_if_needed(
    state: &mut SearchSurfaceState,
    inspected: PreparedSearchHost,
) -> HostRefreshOutcome {
    let phase = state.protocol.phase();
    let expected = match state.protocol.phase() {
        SearchSurfacePhase::Preparing | SearchSurfacePhase::Activating => {
            state.pending_preparation.as_ref()
        }
        SearchSurfacePhase::Visible => state.active_preparation.as_ref(),
        SearchSurfacePhase::Hidden | SearchSurfacePhase::PreparingHost => None,
    };
    let Some(expected) = expected else {
        return HostRefreshOutcome::NotApplicable;
    };
    let expected_physical_viewport = expected.payload.physical_viewport;
    let expected_scale_factor = expected.payload.scale_factor;
    let expected_target_frame = expected.target_frame;

    // A native drag changes only the host position. Keep that user-owned
    // position as the new baseline instead of rebuilding the surface, which
    // would hide it briefly and move it back to the centered target frame.
    let same_scale_factor = (expected_scale_factor - inspected.scale_factor).abs() < 0.000_001;
    let same_current_size = expected_physical_viewport.width == inspected.frame.width
        && expected_physical_viewport.height == inspected.frame.height;
    let same_target_size = expected_target_frame.width == inspected.target_frame.width
        && expected_target_frame.height == inspected.target_frame.height;
    if phase == SearchSurfacePhase::Visible
        && same_scale_factor
        && same_current_size
        && same_target_size
    {
        if let Some(accepted) = state.active_preparation.as_mut() {
            accepted.payload.physical_viewport = inspected.frame;
            accepted.target_frame = inspected.frame;
            return HostRefreshOutcome::Current;
        }
    }
    if same_scale_factor && same_current_size && same_target_size {
        let accepted = match phase {
            SearchSurfacePhase::Preparing | SearchSurfacePhase::Activating => {
                state.pending_preparation.as_mut()
            }
            SearchSurfacePhase::Visible => state.active_preparation.as_mut(),
            SearchSurfacePhase::Hidden | SearchSurfacePhase::PreparingHost => None,
        };
        if let Some(accepted) = accepted {
            accepted.payload.physical_viewport = inspected.frame;
            accepted.target_frame = inspected.target_frame;
        }
        return HostRefreshOutcome::Current;
    }

    let host_facts_changed = expected_physical_viewport != inspected.frame
        || (expected_scale_factor - inspected.scale_factor).abs() >= 0.000_001
        || expected_target_frame != inspected.target_frame;
    if !host_facts_changed {
        return HostRefreshOutcome::Current;
    }

    let Some(request) = state.protocol.request_host_refresh() else {
        return HostRefreshOutcome::NotApplicable;
    };
    state.pending_preparation = None;
    state.active_preparation = None;
    HostRefreshOutcome::Refreshed {
        request,
        target_frame: crate::core::window::search_host::preserve_host_origin(
            inspected.frame,
            inspected.target_frame,
        ),
    }
}

fn accept_host_resize_for_current_surface(
    state: &mut SearchSurfaceState,
    host: PreparedSearchHost,
) -> bool {
    let accepted = match state.protocol.phase() {
        SearchSurfacePhase::Preparing | SearchSurfacePhase::Activating => {
            state.pending_preparation.as_mut()
        }
        SearchSurfacePhase::Visible => state.active_preparation.as_mut(),
        SearchSurfacePhase::Hidden | SearchSurfacePhase::PreparingHost => None,
    };
    let Some(accepted) = accepted else {
        return false;
    };

    accepted.payload.physical_viewport = host.frame;
    accepted.payload.scale_factor = host.scale_factor;
    accepted.target_frame = host.target_frame;
    true
}

fn prepare_show_locked<R: Runtime>(
    app_handle: &AppHandle<R>,
    runtime: &SearchWindowRuntime,
    window: &tauri::WebviewWindow<R>,
    request: SearchHostPreparationRequest,
    target_frame: Option<PhysicalHostFrame>,
    hide_before_prepare: bool,
) -> Result<Option<SearchSurfacePreparationPayload>, String> {
    // The first show must stay hidden until the renderer has applied the
    // matching native region. A visible host refresh is different: hiding it
    // here turns every content resize into a visible re-entry animation.
    if hide_before_prepare {
        window.hide().map_err(|error| error.to_string())?;
    }
    let host = prepare_host(runtime, window, target_frame)?;
    let payload = {
        let mut state = runtime
            .surface
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(preparation) = state.protocol.host_prepared(request) else {
            return Ok(None);
        };
        let payload = SearchSurfacePreparationPayload {
            renderer_epoch: preparation.renderer_epoch,
            show_epoch: preparation.show_epoch,
            host_epoch: preparation.host_epoch,
            source: preparation.source.as_str(),
            physical_viewport: host.frame,
            scale_factor: host.scale_factor,
        };
        state.pending_preparation = Some(SearchSurfacePreparationState::new(payload.clone(), host));
        payload
    };
    app_handle
        .emit("search-surface-prepare", payload.clone())
        .map_err(|error| format!("Failed to emit search surface preparation: {error}"))?;
    Ok(Some(payload))
}

fn prepare_host<R: Runtime>(
    runtime: &SearchWindowRuntime,
    window: &tauri::WebviewWindow<R>,
    target_frame: Option<PhysicalHostFrame>,
) -> Result<PreparedSearchHost, String> {
    if runtime.native_enabled {
        return match target_frame {
            Some(target_frame) => {
                crate::core::window::search_host::prepare_main_search_host_for_target_frame(
                    window,
                    target_frame,
                )
            }
            None => {
                let snapshot = runtime.window_state().snapshot();
                crate::core::window::search_host::prepare_main_search_host_for_panel(
                    window,
                    snapshot.current_width,
                    snapshot.current_height,
                    snapshot.host_content_height,
                )
            }
        };
    }
    let frame = PhysicalHostFrame {
        x: -1920,
        y: 0,
        width: 1920,
        height: 1040,
    };
    Ok(PreparedSearchHost {
        changed: false,
        frame,
        target_frame: frame,
        scale_factor: 1.25,
    })
}

fn inspect_host<R: Runtime>(
    runtime: &SearchWindowRuntime,
    window: &tauri::WebviewWindow<R>,
) -> Result<PreparedSearchHost, String> {
    if runtime.native_enabled {
        let snapshot = runtime.window_state().snapshot();
        return crate::core::window::search_host::inspect_main_search_host_for_panel(
            window,
            snapshot.current_width,
            snapshot.current_height,
            snapshot.host_content_height,
        );
    }
    prepare_host(runtime, window, None)
}

fn activate_main_window<R: Runtime>(
    runtime: &SearchWindowRuntime,
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    // Host preparation may be deferred; count activation at the actual foreground transition.
    if !window.is_visible().unwrap_or(false) || !window.is_focused().unwrap_or(false) {
        if let Some(analytics) = window
            .app_handle()
            .try_state::<crate::core::analytics::AnalyticsRuntime>()
        {
            analytics.begin_foreground_activation();
        }
    }
    if runtime.native_enabled {
        return super::show_and_activate_search_window(window);
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn emit_shown<R: Runtime>(
    app_handle: &AppHandle<R>,
    runtime: &SearchWindowRuntime,
    source: SearchSurfaceSource,
    activation: SearchSurfaceActivation,
) -> Result<(), String> {
    app_handle
        .emit(
            "search-surface-shown",
            SearchSurfaceShownPayload {
                source: source.as_str(),
                sequence: runtime.next_sequence(),
                renderer_epoch: activation.renderer_epoch,
                show_epoch: activation.show_epoch,
                host_epoch: activation.host_epoch,
                generation: activation.region_generation,
            },
        )
        .map_err(|error| format!("Failed to emit search surface shown event: {error}"))
}

/// 在原生窗口失焦时判断是否离开搜索窗口组，必要时隐藏完整 surface。
fn handle_focus_lost_on_main_thread<R: Runtime>(app_handle: &AppHandle<R>) -> Result<(), String> {
    let runtime = app_handle
        .try_state::<SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
    if !runtime.is_protocol_visible() {
        return Ok(());
    }

    let Some(main_window) = app_handle.get_webview_window("main") else {
        return Ok(());
    };
    let decision_input = FocusLostDecisionInput {
        hide_on_app_blur: runtime.should_hide_on_app_blur(),
        main_visible: main_window.is_visible().unwrap_or(false),
        main_maximized: main_window.is_maximized().unwrap_or(false),
        main_always_on_top: main_window.is_always_on_top().unwrap_or(false),
        app_focused: main_hwnd_family_is_foreground(&main_window),
    };
    let should_hide = should_hide_on_focus_lost(decision_input);
    if !should_hide {
        return Ok(());
    }

    hide_surface_on_main_thread(app_handle, SearchSurfaceHideReason::AppBlurHide)
}

/// 处理搜索窗口组窗口失焦事件。
pub fn handle_window_blur_on_main_thread<R: Runtime>(
    app_handle: &AppHandle<R>,
    window_label: &str,
) {
    if window_label != "main" {
        return;
    }

    #[cfg(target_os = "windows")]
    {
        // Tauri can dispatch Focused(false) before Windows publishes the next
        // foreground HWND. Recheck from the main thread after that handoff so
        // a stale main-window foreground result cannot suppress app-blur hide.
        const FOREGROUND_RECHECK_DELAY: Duration = Duration::from_millis(25);
        let app_for_recheck = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(FOREGROUND_RECHECK_DELAY).await;
            let app_for_main_thread = app_for_recheck.clone();
            if let Err(error) = app_for_recheck.run_on_main_thread(move || {
                if let Err(error) = handle_focus_lost_on_main_thread(&app_for_main_thread) {
                    log::warn!("Failed to handle delayed search surface blur: {error}");
                }
            }) {
                log::warn!("Failed to schedule delayed search surface blur: {error}");
            }
        });
        return;
    }

    #[cfg(not(target_os = "windows"))]
    if let Err(error) = handle_focus_lost_on_main_thread(app_handle) {
        log::warn!(
            "Failed to handle search surface blur for '{}': {}",
            window_label,
            error
        );
    }
}

impl Default for SearchWindowRuntime {
    /// 创建默认搜索窗口组运行时。
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::super::protocol::{
        SearchShortcutAction, SearchSurfacePhase, SearchSurfacePreparation, SearchSurfaceProtocol,
        SearchSurfaceSource,
    };
    use super::{
        accept_host_resize_for_current_surface, foreground_belongs_to_main_hwnd_family,
        hide_surface_state_transaction, refresh_host_if_needed, should_hide_on_focus_lost,
        FocusLostDecisionInput, HostRefreshOutcome, SearchSurfacePreparationPayload,
        SearchSurfacePreparationState, SearchSurfaceState, SearchWindowRuntime,
    };
    use crate::core::window::search_host::{PhysicalHostFrame, PreparedSearchHost};

    #[test]
    fn user_sees_which_entry_point_opened_the_search_window() {
        for (source, expected) in [
            (SearchSurfaceSource::Shortcut, "shortcut"),
            (SearchSurfaceSource::Notification, "notification"),
            (SearchSurfaceSource::Tray, "tray"),
            (SearchSurfaceSource::Main, "main"),
        ] {
            assert_eq!(source.as_str(), expected);
        }
    }

    #[test]
    fn user_gets_a_tray_entry_when_the_tray_menu_asks_for_the_search_window() {
        assert_eq!(
            SearchSurfaceSource::from_requesting_window(
                crate::core::window::tray::TRAY_MENU_WINDOW_LABEL
            ),
            SearchSurfaceSource::Tray
        );
        assert_eq!(
            SearchSurfaceSource::from_requesting_window("main"),
            SearchSurfaceSource::Main
        );
    }

    #[test]
    fn runtime_protocol_snapshot_starts_hidden_and_not_ready() {
        let runtime = SearchWindowRuntime::new();
        let snapshot = runtime.protocol_snapshot();

        assert_eq!(snapshot.phase, "hidden");
        assert!(!snapshot.renderer_ready);
        assert!(!snapshot.desired_visible);
        assert!(snapshot.pending_preparation.is_none());
    }

    #[test]
    fn host_refresh_skips_an_active_visibility_transaction_without_waiting() {
        let runtime = SearchWindowRuntime::for_tests();
        let active_transaction = runtime
            .visibility_transaction
            .lock()
            .unwrap_or_else(|error| error.into_inner());

        assert!(runtime.try_begin_host_refresh().is_none());

        drop(active_transaction);
        assert!(runtime.try_begin_host_refresh().is_some());
    }

    fn decision_input() -> FocusLostDecisionInput {
        FocusLostDecisionInput {
            hide_on_app_blur: true,
            main_visible: true,
            main_maximized: false,
            main_always_on_top: false,
            app_focused: false,
        }
    }

    #[test]
    fn main_blur_hides_surface_when_app_focus_is_lost() {
        let should_hide = should_hide_on_focus_lost(decision_input());

        assert!(should_hide);
    }

    #[test]
    fn blur_does_not_hide_surface_when_policy_is_disabled() {
        let should_hide = should_hide_on_focus_lost(FocusLostDecisionInput {
            hide_on_app_blur: false,
            ..decision_input()
        });

        assert!(!should_hide);
    }

    #[test]
    fn blur_does_not_hide_surface_while_app_is_still_focused() {
        let should_hide = should_hide_on_focus_lost(FocusLostDecisionInput {
            app_focused: true,
            ..decision_input()
        });

        assert!(!should_hide);
    }

    #[test]
    fn foreground_hwnd_family_accepts_only_main_relationships() {
        for relationship in [
            (true, false, false, false),
            (false, true, false, false),
            (false, false, true, false),
            (false, false, false, true),
        ] {
            assert!(foreground_belongs_to_main_hwnd_family(
                relationship.0,
                relationship.1,
                relationship.2,
                relationship.3,
            ));
        }
        assert!(!foreground_belongs_to_main_hwnd_family(
            false, false, false, false,
        ));
    }

    #[test]
    fn blur_does_not_hide_pinned_or_expanded_surfaces() {
        for input in [
            FocusLostDecisionInput {
                main_always_on_top: true,
                ..decision_input()
            },
            FocusLostDecisionInput {
                main_maximized: true,
                ..decision_input()
            },
        ] {
            assert!(!should_hide_on_focus_lost(input));
        }
    }

    #[test]
    fn protocol_ignores_an_old_host_ack_after_a_new_show_intent() {
        let mut protocol = SearchSurfaceProtocol::new();
        let renderer_epoch = protocol.renderer_epoch();
        protocol.mark_renderer_ready(renderer_epoch);
        let old_host = protocol
            .request_show(SearchSurfaceSource::Shortcut)
            .expect("ready renderer should prepare the host");
        let current_host = protocol
            .request_show(SearchSurfaceSource::Notification)
            .expect("new show intent should supersede the old host request");

        assert!(protocol.host_prepared(old_host).is_none());
        assert_eq!(protocol.phase(), SearchSurfacePhase::PreparingHost);
        assert!(protocol.host_prepared(current_host).is_some());
    }

    #[test]
    fn protocol_matching_region_token_activates_exactly_once() {
        let mut protocol = SearchSurfaceProtocol::new();
        let renderer_epoch = protocol.renderer_epoch();
        protocol.mark_renderer_ready(renderer_epoch);
        let host = protocol
            .request_show(SearchSurfaceSource::Shortcut)
            .expect("ready renderer should prepare the host");
        let preparation = protocol
            .host_prepared(host)
            .expect("current host request should produce a preparation");

        let activation = protocol
            .region_applied(preparation, 17)
            .expect("matching final region should activate");
        assert_eq!(protocol.phase(), SearchSurfacePhase::Activating);
        assert!(protocol.region_applied(preparation, 17).is_none());
        assert!(protocol.activation_succeeded(activation).is_some());
        assert_eq!(protocol.phase(), SearchSurfacePhase::Visible);
        assert!(protocol.activation_succeeded(activation).is_none());
    }

    #[test]
    fn protocol_rejects_ack_superseded_by_new_show_or_hide() {
        let mut protocol = SearchSurfaceProtocol::new();
        let renderer_epoch = protocol.renderer_epoch();
        protocol.mark_renderer_ready(renderer_epoch);
        let first_host = protocol
            .request_show(SearchSurfaceSource::Shortcut)
            .expect("ready renderer should prepare the host");
        let first_preparation = protocol
            .host_prepared(first_host)
            .expect("first host preparation should be current");

        let second_host = protocol
            .request_show(SearchSurfaceSource::Notification)
            .expect("second show should supersede the first preparation");
        assert!(protocol.region_applied(first_preparation, 1).is_none());
        let second_preparation = protocol
            .host_prepared(second_host)
            .expect("second host preparation should be current");

        protocol.hide();

        assert!(protocol.region_applied(second_preparation, 2).is_none());
        assert_eq!(protocol.phase(), SearchSurfacePhase::Hidden);
    }

    #[test]
    fn protocol_reload_invalidates_old_renderer_ready_and_region_ack() {
        let mut protocol = SearchSurfaceProtocol::new();
        let renderer_epoch_one = protocol.renderer_epoch();
        protocol.mark_renderer_ready(renderer_epoch_one);
        let first_host = protocol
            .request_show(SearchSurfaceSource::Shortcut)
            .expect("ready renderer should prepare the host");
        let first_preparation = protocol
            .host_prepared(first_host)
            .expect("first renderer should receive a preparation");

        let renderer_epoch_two = protocol.page_load_started();

        assert!(protocol.mark_renderer_ready(renderer_epoch_one).is_none());
        assert!(protocol.region_applied(first_preparation, 1).is_none());
        assert_eq!(protocol.phase(), SearchSurfacePhase::Hidden);
        assert!(protocol.mark_renderer_ready(renderer_epoch_two).is_some());
    }

    #[test]
    fn protocol_pending_second_shortcut_resolves_to_hide() {
        let mut protocol = SearchSurfaceProtocol::new();
        assert!(protocol
            .request_show(SearchSurfaceSource::Shortcut)
            .is_none());

        assert_eq!(
            protocol.resolve_shortcut_action(false, false),
            SearchShortcutAction::Hide
        );
    }

    #[test]
    fn protocol_visible_host_refresh_invalidates_old_region_and_advances_host_epoch() {
        let mut protocol = SearchSurfaceProtocol::new();
        let renderer_epoch = protocol.renderer_epoch();
        protocol.mark_renderer_ready(renderer_epoch);
        let host = protocol
            .request_show(SearchSurfaceSource::Shortcut)
            .expect("ready renderer should prepare the host");
        let first_preparation = protocol.host_prepared(host).expect("first preparation");
        let activation = protocol
            .region_applied(first_preparation, 9)
            .expect("first region commit");
        protocol
            .activation_succeeded(activation)
            .expect("first activation");

        let refreshed_host = protocol
            .request_host_refresh()
            .expect("visible desired surface should refresh its host");

        assert_eq!(protocol.phase(), SearchSurfacePhase::PreparingHost);
        assert!(protocol.region_applied(first_preparation, 10).is_none());
        let refreshed_preparation = protocol
            .host_prepared(refreshed_host)
            .expect("current refreshed host should prepare");
        assert_eq!(
            refreshed_preparation.show_epoch,
            first_preparation.show_epoch
        );
        assert!(refreshed_preparation.host_epoch > first_preparation.host_epoch);
    }

    #[test]
    fn protocol_preparing_host_refresh_invalidates_old_region_and_advances_host_epoch() {
        let mut protocol = SearchSurfaceProtocol::new();
        let renderer_epoch = protocol.renderer_epoch();
        protocol.mark_renderer_ready(renderer_epoch);
        let host = protocol
            .request_show(SearchSurfaceSource::Shortcut)
            .expect("ready renderer should prepare the host");
        let first_preparation = protocol.host_prepared(host).expect("first preparation");

        let refreshed_host = protocol
            .request_host_refresh()
            .expect("preparing desired surface should refresh its host");

        assert_eq!(protocol.phase(), SearchSurfacePhase::PreparingHost);
        assert!(protocol.region_applied(first_preparation, 10).is_none());
        let refreshed_preparation = protocol
            .host_prepared(refreshed_host)
            .expect("current refreshed host should prepare");
        assert_eq!(
            refreshed_preparation.show_epoch,
            first_preparation.show_epoch
        );
        assert!(refreshed_preparation.host_epoch > first_preparation.host_epoch);
    }

    #[test]
    fn protocol_activating_host_refresh_invalidates_old_activation() {
        let mut protocol = SearchSurfaceProtocol::new();
        let renderer_epoch = protocol.renderer_epoch();
        protocol.mark_renderer_ready(renderer_epoch);
        let host = protocol
            .request_show(SearchSurfaceSource::Shortcut)
            .expect("ready renderer should prepare the host");
        let first_preparation = protocol.host_prepared(host).expect("first preparation");
        let old_activation = protocol
            .region_applied(first_preparation, 10)
            .expect("matching region should begin activation");

        let refreshed_host = protocol
            .request_host_refresh()
            .expect("activating desired surface should refresh its host");

        assert_eq!(protocol.phase(), SearchSurfacePhase::PreparingHost);
        assert!(protocol.activation_succeeded(old_activation).is_none());
        let refreshed_preparation = protocol
            .host_prepared(refreshed_host)
            .expect("current refreshed host should prepare");
        assert_eq!(
            refreshed_preparation.show_epoch,
            first_preparation.show_epoch
        );
        assert!(refreshed_preparation.host_epoch > first_preparation.host_epoch);
    }

    fn host_frame(width: i32) -> PhysicalHostFrame {
        PhysicalHostFrame {
            x: -1920,
            y: 0,
            width,
            height: 1040,
        }
    }

    fn preparation_payload(
        preparation: SearchSurfacePreparation,
        frame: PhysicalHostFrame,
        scale_factor: f64,
    ) -> SearchSurfacePreparationPayload {
        SearchSurfacePreparationPayload {
            renderer_epoch: preparation.renderer_epoch,
            show_epoch: preparation.show_epoch,
            host_epoch: preparation.host_epoch,
            source: preparation.source.as_str(),
            physical_viewport: frame,
            scale_factor,
        }
    }

    fn prepared_host(
        actual_width: i32,
        target_width: i32,
        scale_factor: f64,
    ) -> PreparedSearchHost {
        PreparedSearchHost {
            changed: actual_width != target_width,
            frame: host_frame(actual_width),
            target_frame: host_frame(target_width),
            scale_factor,
        }
    }

    fn preparing_surface_state_from_host(
        accepted_host: PreparedSearchHost,
    ) -> (SearchSurfaceState, SearchSurfacePreparation) {
        let mut protocol = SearchSurfaceProtocol::new();
        let renderer_epoch = protocol.renderer_epoch();
        protocol.mark_renderer_ready(renderer_epoch);
        let host = protocol
            .request_show(SearchSurfaceSource::Shortcut)
            .expect("ready renderer should prepare the host");
        let preparation = protocol.host_prepared(host).expect("first preparation");
        let payload =
            preparation_payload(preparation, accepted_host.frame, accepted_host.scale_factor);
        (
            SearchSurfaceState {
                protocol,
                pending_preparation: Some(SearchSurfacePreparationState::new(
                    payload,
                    accepted_host,
                )),
                active_preparation: None,
            },
            preparation,
        )
    }

    fn preparing_surface_state() -> (SearchSurfaceState, SearchSurfacePreparation) {
        preparing_surface_state_from_host(prepared_host(1920, 1920, 1.25))
    }

    fn visible_surface_state() -> SearchSurfaceState {
        let (mut state, preparation) = preparing_surface_state();
        let activation = state
            .protocol
            .region_applied(preparation, 41)
            .expect("prepared region should activate");
        state
            .protocol
            .activation_succeeded(activation)
            .expect("activation should become visible");
        state.active_preparation = state.pending_preparation.take();
        state
    }

    #[test]
    fn hide_transaction_invalidates_surface_before_native_hide() {
        let mut state = visible_surface_state();

        hide_surface_state_transaction(&mut state, |hidden| {
            assert_eq!(hidden.protocol.phase(), SearchSurfacePhase::Hidden);
            assert!(hidden.pending_preparation.is_none());
            assert!(hidden.active_preparation.is_none());
            Ok::<(), &'static str>(())
        })
        .expect("native hide should succeed");

        assert_eq!(state.protocol.phase(), SearchSurfacePhase::Hidden);
        assert!(state.pending_preparation.is_none());
        assert!(state.active_preparation.is_none());
    }

    #[test]
    fn hide_transaction_restores_exact_state_when_native_hide_fails() {
        let mut state = visible_surface_state();
        let previous = state.clone();

        let error =
            hide_surface_state_transaction(&mut state, |_| Err::<(), _>("native hide failed"))
                .expect_err("native hide failure should propagate");

        assert_eq!(error, "native hide failed");
        assert_eq!(state, previous);
    }

    #[test]
    fn host_fact_mismatch_refreshes_preparing_transaction_and_invalidates_old_ack() {
        let (mut state, old_preparation) = preparing_surface_state();
        let inspected = PreparedSearchHost {
            changed: false,
            frame: host_frame(1918),
            target_frame: host_frame(1918),
            scale_factor: 1.25,
        };

        let request = match refresh_host_if_needed(&mut state, inspected) {
            HostRefreshOutcome::Refreshed { request, .. } => request,
            _ => panic!("mismatched pending host facts should refresh"),
        };

        assert_eq!(state.protocol.phase(), SearchSurfacePhase::PreparingHost);
        assert!(state.protocol.region_applied(old_preparation, 11).is_none());
        let refreshed = state
            .protocol
            .host_prepared(request)
            .expect("refreshed host should produce a new preparation");
        assert_eq!(refreshed.show_epoch, old_preparation.show_epoch);
        assert!(refreshed.host_epoch > old_preparation.host_epoch);
    }

    #[test]
    fn matching_pending_host_facts_do_not_refresh_before_commit() {
        let (mut state, preparation) = preparing_surface_state();
        let inspected = PreparedSearchHost {
            changed: false,
            frame: host_frame(1920),
            target_frame: host_frame(1920),
            scale_factor: 1.25,
        };

        assert!(matches!(
            refresh_host_if_needed(&mut state, inspected),
            HostRefreshOutcome::Current
        ));
        assert_eq!(state.protocol.phase(), SearchSurfacePhase::Preparing);
        assert_eq!(state.protocol.preparation(), Some(preparation));
    }

    #[test]
    fn host_position_change_rebases_preparation_without_refreshing() {
        let accepted_host = prepared_host(1920, 1920, 1.25);
        let (mut state, preparation) = preparing_surface_state_from_host(accepted_host);
        let moved_frame = PhysicalHostFrame {
            x: -1800,
            y: 32,
            width: 1920,
            height: 1040,
        };
        let inspected = PreparedSearchHost {
            changed: true,
            frame: moved_frame,
            target_frame: host_frame(1920),
            scale_factor: 1.25,
        };

        assert!(matches!(
            refresh_host_if_needed(&mut state, inspected),
            HostRefreshOutcome::Current
        ));
        assert_eq!(state.protocol.phase(), SearchSurfacePhase::Preparing);
        assert_eq!(state.protocol.preparation(), Some(preparation));
        let pending = state
            .pending_preparation
            .as_ref()
            .expect("position changes should update the accepted host facts");
        assert_eq!(pending.payload.physical_viewport, moved_frame);
        assert_eq!(pending.target_frame, host_frame(1920));
    }

    #[test]
    fn visible_host_position_change_rebases_without_refreshing() {
        let mut state = visible_surface_state();
        let moved_frame = PhysicalHostFrame {
            x: -1800,
            y: 32,
            width: 1920,
            height: 1040,
        };
        let inspected = PreparedSearchHost {
            changed: true,
            frame: moved_frame,
            target_frame: host_frame(1920),
            scale_factor: 1.25,
        };

        assert!(matches!(
            refresh_host_if_needed(&mut state, inspected),
            HostRefreshOutcome::Current
        ));
        assert_eq!(state.protocol.phase(), SearchSurfacePhase::Visible);
        assert!(state.pending_preparation.is_none());
        let active = state
            .active_preparation
            .as_ref()
            .expect("visible position changes should update the active host facts");
        assert_eq!(active.payload.physical_viewport, moved_frame);
        assert_eq!(active.target_frame, moved_frame);
    }

    #[test]
    fn visible_resize_commit_rebases_active_host_without_starting_preparation() {
        let mut state = visible_surface_state();
        let resized_host = PreparedSearchHost {
            changed: true,
            frame: PhysicalHostFrame {
                x: -1800,
                y: 32,
                width: 1920,
                height: 1500,
            },
            target_frame: PhysicalHostFrame {
                x: -1800,
                y: 32,
                width: 1920,
                height: 1500,
            },
            scale_factor: 1.25,
        };

        assert!(accept_host_resize_for_current_surface(
            &mut state,
            resized_host
        ));
        assert_eq!(state.protocol.phase(), SearchSurfacePhase::Visible);
        assert!(matches!(
            refresh_host_if_needed(&mut state, resized_host),
            HostRefreshOutcome::Current
        ));
        let active = state
            .active_preparation
            .as_ref()
            .expect("visible resize should keep the active preparation");
        assert_eq!(active.payload.physical_viewport, resized_host.frame);
        assert_eq!(active.payload.scale_factor, resized_host.scale_factor);
        assert_eq!(active.target_frame, resized_host.target_frame);
    }

    #[test]
    fn visible_host_size_change_refreshes_the_surface() {
        let mut state = visible_surface_state();
        let resized_frame = PhysicalHostFrame {
            x: -1800,
            y: 32,
            width: 1920,
            height: 1500,
        };
        let inspected = PreparedSearchHost {
            changed: true,
            frame: resized_frame,
            target_frame: host_frame(1920),
            scale_factor: 1.25,
        };

        assert!(matches!(
            refresh_host_if_needed(&mut state, inspected),
            HostRefreshOutcome::Refreshed { .. }
        ));
        assert_eq!(state.protocol.phase(), SearchSurfacePhase::PreparingHost);
        assert!(state.pending_preparation.is_none());
        assert!(state.active_preparation.is_none());
    }

    #[test]
    fn pending_scale_fact_mismatch_refreshes_before_commit() {
        let (mut state, old_preparation) = preparing_surface_state();
        let inspected = PreparedSearchHost {
            changed: false,
            frame: host_frame(1920),
            target_frame: host_frame(1920),
            scale_factor: 1.5,
        };

        assert!(matches!(
            refresh_host_if_needed(&mut state, inspected),
            HostRefreshOutcome::Refreshed { .. }
        ));
        assert_eq!(state.protocol.phase(), SearchSurfacePhase::PreparingHost);
        assert!(state.protocol.region_applied(old_preparation, 11).is_none());
    }

    #[test]
    fn stable_visible_actual_and_target_facts_do_not_refresh() {
        let accepted_host = prepared_host(1920, 1918, 1.25);
        let (mut state, preparation) = preparing_surface_state_from_host(accepted_host);
        let activation = state
            .protocol
            .region_applied(preparation, 10)
            .expect("matching region should activate");
        state
            .protocol
            .activation_succeeded(activation)
            .expect("activation should become visible");
        state.active_preparation = state.pending_preparation.take();

        assert!(matches!(
            refresh_host_if_needed(&mut state, accepted_host),
            HostRefreshOutcome::Current
        ));
        assert_eq!(state.protocol.phase(), SearchSurfacePhase::Visible);
        assert!(state.active_preparation.is_some());
    }

    #[test]
    fn pending_target_fact_change_refreshes_and_invalidates_old_ack() {
        let accepted_host = prepared_host(1920, 1920, 1.25);
        let (mut state, old_preparation) = preparing_surface_state_from_host(accepted_host);
        let inspected = PreparedSearchHost {
            changed: true,
            frame: PhysicalHostFrame {
                x: -1800,
                y: 32,
                width: 1918,
                height: 1040,
            },
            target_frame: host_frame(1918),
            scale_factor: 1.25,
        };

        let request = match refresh_host_if_needed(&mut state, inspected) {
            HostRefreshOutcome::Refreshed {
                request,
                target_frame,
            } => {
                assert_eq!(target_frame.x, -1800);
                assert_eq!(target_frame.y, 32);
                assert_eq!(target_frame.width, 1918);
                assert_eq!(target_frame.height, 1040);
                request
            }
            _ => panic!("a changed target frame should refresh the pending transaction"),
        };

        assert_eq!(state.protocol.phase(), SearchSurfacePhase::PreparingHost);
        assert!(state.protocol.region_applied(old_preparation, 11).is_none());
        let refreshed = state
            .protocol
            .host_prepared(request)
            .expect("refreshed host should produce a new preparation");
        assert!(refreshed.host_epoch > old_preparation.host_epoch);
    }
}
