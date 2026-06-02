// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 搜索窗口组原生 surface 状态。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::bounds::{SearchWindowDefaults, SearchWindowState};

/// 搜索窗口组显示来源。
pub enum SearchSurfaceShowSource {
    Shortcut,
    Notification,
}

impl SearchSurfaceShowSource {
    /// 转成前端事件载荷字符串。
    fn as_str(&self) -> &'static str {
        match self {
            Self::Shortcut => "shortcut",
            Self::Notification => "notification",
        }
    }

    /// 转成桌面上下文胶囊的调用来源。
    fn as_desktop_context_source(&self) -> &'static str {
        match self {
            Self::Shortcut => "shortcut",
            Self::Notification => "notification",
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

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchSurfaceShownPayload {
    source: &'static str,
    sequence: u64,
    context_capsule_id: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchSurfaceHiddenPayload {
    reason: &'static str,
    sequence: u64,
}

/// 当前打开的 popup 会话信息。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PopupSurfaceSession {
    pub popup_id: String,
    pub popup_session_version: u64,
    #[serde(rename = "type")]
    pub popup_type: String,
    pub window_label: String,
}

/// 搜索窗口组原生运行时状态。
pub struct SearchWindowRuntime {
    hide_on_app_blur: AtomicBool,
    allow_height_override: AtomicBool,
    sequence: AtomicU64,
    popup_sessions: Mutex<HashMap<String, PopupSurfaceSession>>,
    window_state: SearchWindowState,
}

/// 搜索窗口组失焦隐藏决策输入。
#[derive(Debug, Clone, Copy)]
struct FocusLostDecisionInput<'a> {
    window_label: &'a str,
    hide_on_app_blur: bool,
    main_visible: bool,
    main_maximized: bool,
    main_always_on_top: bool,
    app_focused: bool,
    has_popup_sessions: bool,
}

pub type SearchSurfaceRuntime = SearchWindowRuntime;

impl SearchWindowRuntime {
    /// 创建搜索窗口组运行时。
    pub fn new() -> Self {
        Self {
            hide_on_app_blur: AtomicBool::new(true),
            allow_height_override: AtomicBool::new(false),
            sequence: AtomicU64::new(0),
            popup_sessions: Mutex::new(HashMap::new()),
            window_state: SearchWindowState::default(),
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

    /// 记录一个 popup 原生窗口会话。
    pub fn register_popup_session(&self, session: PopupSurfaceSession) {
        let mut sessions = self
            .popup_sessions
            .lock()
            .expect("search surface popup session state poisoned");
        sessions.insert(session.window_label.clone(), session);
    }

    /// 取出并移除所有 popup 会话。
    pub fn take_popup_sessions(&self) -> Vec<PopupSurfaceSession> {
        let mut sessions = self
            .popup_sessions
            .lock()
            .expect("search surface popup session state poisoned");
        sessions.drain().map(|(_, session)| session).collect()
    }

    /// 只取出命中指定身份的 popup 会话。
    pub fn take_popup_session(
        &self,
        popup_id: &str,
        window_label: &str,
        popup_session_version: u64,
    ) -> Option<PopupSurfaceSession> {
        let mut sessions = self
            .popup_sessions
            .lock()
            .expect("search surface popup session state poisoned");
        let session = sessions.get(window_label)?;
        if session.popup_id != popup_id || session.popup_session_version != popup_session_version {
            return None;
        }

        sessions.remove(window_label)
    }

    /// 按窗口 label 取出并移除 popup 会话。
    pub fn take_popup_session_by_window_label(
        &self,
        window_label: &str,
    ) -> Option<PopupSurfaceSession> {
        let mut sessions = self
            .popup_sessions
            .lock()
            .expect("search surface popup session state poisoned");
        sessions.remove(window_label)
    }

    /// 判断当前是否存在已登记的 popup 会话。
    fn has_popup_sessions(&self) -> bool {
        let sessions = self
            .popup_sessions
            .lock()
            .expect("search surface popup session state poisoned");
        !sessions.is_empty()
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
fn should_hide_on_focus_lost(input: FocusLostDecisionInput<'_>) -> bool {
    if !input.hide_on_app_blur || !input.main_visible || input.main_always_on_top {
        return false;
    }
    if input.app_focused {
        return false;
    }
    if input.main_maximized {
        return false;
    }

    // 主窗口失焦到 popup 的切换过程中，popup 可能尚未真正成为前台窗口。
    // 只要已有 popup 会话，main blur 不能直接判定为离开整个 surface。
    if input.window_label == "main" && input.has_popup_sessions {
        return false;
    }

    true
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

/// 广播并清空所有已登记的 popup 关闭事实。
pub fn emit_registered_popup_closed<R: Runtime>(
    app_handle: &AppHandle<R>,
    sessions: Vec<PopupSurfaceSession>,
) -> Result<(), String> {
    for session in sessions {
        app_handle
            .emit("popup-closed", session)
            .map_err(|error| format!("Failed to emit popup closed event: {}", error))?;
    }
    Ok(())
}

/// 隐藏所有 popup 原生窗口，并广播 popup 关闭事实。
pub fn hide_popup_surface<R: Runtime>(
    app_handle: &AppHandle<R>,
    target_session: Option<PopupSurfaceSession>,
) -> Result<(), String> {
    if let Some(target_session) = target_session.as_ref() {
        let runtime = app_handle
            .try_state::<SearchWindowRuntime>()
            .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
        let Some(closed_session) = runtime.take_popup_session(
            &target_session.popup_id,
            &target_session.window_label,
            target_session.popup_session_version,
        ) else {
            return Ok(());
        };

        if let Some(window) = app_handle.get_webview_window(&closed_session.window_label) {
            let _ = window.set_focusable(false);
            window.hide().map_err(|error| error.to_string())?;
        }
        emit_registered_popup_closed(app_handle, vec![closed_session])?;

        // popup 关闭后将键盘焦点还给主搜索窗口。
        if let Some(main_window) = app_handle.get_webview_window("main") {
            if main_window.is_visible().unwrap_or(false) {
                super::reactivate_search_window_input(&main_window)?;
            }
        }

        Ok(())
    } else {
        let runtime = app_handle
            .try_state::<SearchWindowRuntime>()
            .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
        for (label, window) in app_handle.webview_windows() {
            if label.starts_with("popup-") {
                let _ = window.set_focusable(false);
                window.hide().map_err(|error| error.to_string())?;
            }
        }
        emit_registered_popup_closed(app_handle, runtime.take_popup_sessions())
    }
}

/// 显示搜索窗口组并广播原生事实。
pub fn show_surface<R: Runtime>(
    app_handle: &AppHandle<R>,
    source: SearchSurfaceShowSource,
) -> Result<(), String> {
    let runtime = app_handle
        .try_state::<SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "Failed to get main window".to_string())?;
    let context_capsule_id = if let Some(desktop_context_runtime) =
        app_handle.try_state::<crate::core::system::desktop_context::DesktopContextRuntime>()
    {
        match desktop_context_runtime
            .capture_invocation(app_handle, source.as_desktop_context_source())
        {
            Ok(capsule) => Some(capsule.id),
            Err(error) => {
                log::warn!("Failed to capture desktop context capsule: {}", error);
                None
            }
        }
    } else {
        None
    };

    super::show_and_activate_search_window(&window)?;
    app_handle
        .emit(
            "search-surface-shown",
            SearchSurfaceShownPayload {
                source: source.as_str(),
                sequence: runtime.next_sequence(),
                context_capsule_id,
            },
        )
        .map_err(|error| format!("Failed to emit search surface shown event: {}", error))
}

/// 隐藏搜索窗口组并广播原生事实。
pub fn hide_surface<R: Runtime>(
    app_handle: &AppHandle<R>,
    reason: SearchSurfaceHideReason,
) -> Result<(), String> {
    let runtime = app_handle
        .try_state::<SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "Failed to get main window".to_string())?;

    hide_popup_surface(app_handle, None)?;
    window.hide().map_err(|error| error.to_string())?;
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

/// 在原生窗口失焦时判断是否离开搜索窗口组，必要时隐藏完整 surface。
pub fn handle_focus_lost<R: Runtime>(
    app_handle: &AppHandle<R>,
    window_label: &str,
) -> Result<(), String> {
    let runtime = app_handle
        .try_state::<SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;

    let Some(main_window) = app_handle.get_webview_window("main") else {
        return Ok(());
    };
    let decision_input = FocusLostDecisionInput {
        window_label,
        hide_on_app_blur: runtime.should_hide_on_app_blur(),
        main_visible: main_window.is_visible().unwrap_or(false),
        main_maximized: main_window.is_maximized().unwrap_or(false),
        main_always_on_top: main_window.is_always_on_top().unwrap_or(false),
        app_focused: crate::core::window::popup::is_app_focused(app_handle.clone())?,
        has_popup_sessions: runtime.has_popup_sessions(),
    };
    let should_hide = should_hide_on_focus_lost(decision_input);
    if !should_hide {
        return Ok(());
    }

    hide_surface(app_handle, SearchSurfaceHideReason::AppBlurHide)
}

/// 处理搜索窗口组窗口失焦事件。
pub fn handle_window_blur<R: Runtime>(app_handle: &AppHandle<R>, window_label: &str) {
    if window_label != "main" && !window_label.starts_with("popup-") {
        return;
    }

    if let Err(error) = handle_focus_lost(app_handle, window_label) {
        log::warn!(
            "Failed to handle search surface blur for '{}': {}",
            window_label,
            error
        );
    }
}

/// 处理 popup 窗口被销毁后的 runtime 清理。
pub fn handle_window_destroyed<R: Runtime>(app_handle: &AppHandle<R>, window_label: &str) {
    if !window_label.starts_with("popup-") {
        return;
    }

    let Some(runtime) = app_handle.try_state::<SearchWindowRuntime>() else {
        return;
    };
    let Some(closed_session) = runtime.take_popup_session_by_window_label(window_label) else {
        return;
    };

    if let Err(error) = emit_registered_popup_closed(app_handle, vec![closed_session]) {
        log::warn!(
            "Failed to emit popup closed event for destroyed window '{}': {}",
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
    use super::{should_hide_on_focus_lost, FocusLostDecisionInput};

    fn decision_input(window_label: &'static str) -> FocusLostDecisionInput<'static> {
        FocusLostDecisionInput {
            window_label,
            hide_on_app_blur: true,
            main_visible: true,
            main_maximized: false,
            main_always_on_top: false,
            app_focused: false,
            has_popup_sessions: false,
        }
    }

    #[test]
    fn main_blur_keeps_surface_visible_while_popup_session_is_open() {
        let should_hide = should_hide_on_focus_lost(FocusLostDecisionInput {
            has_popup_sessions: true,
            ..decision_input("main")
        });

        assert!(!should_hide);
    }

    #[test]
    fn main_blur_hides_surface_when_app_focus_is_lost_without_popups() {
        let should_hide = should_hide_on_focus_lost(decision_input("main"));

        assert!(should_hide);
    }

    #[test]
    fn blur_does_not_hide_surface_when_policy_is_disabled() {
        let should_hide = should_hide_on_focus_lost(FocusLostDecisionInput {
            hide_on_app_blur: false,
            ..decision_input("main")
        });

        assert!(!should_hide);
    }

    #[test]
    fn blur_does_not_hide_surface_while_app_is_still_focused() {
        let should_hide = should_hide_on_focus_lost(FocusLostDecisionInput {
            app_focused: true,
            ..decision_input("main")
        });

        assert!(!should_hide);
    }
}
