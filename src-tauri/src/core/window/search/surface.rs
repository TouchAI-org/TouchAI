// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 搜索窗口组原生 surface 状态。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

/// 搜索窗口组显示来源。
pub enum SearchSurfaceShowSource {
    Shortcut,
}

impl SearchSurfaceShowSource {
    /// 转成前端事件载荷字符串。
    fn as_str(&self) -> &'static str {
        match self {
            Self::Shortcut => "shortcut",
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
    sequence: AtomicU64,
    popup_sessions: Mutex<HashMap<String, PopupSurfaceSession>>,
}

/// 搜索窗口组失焦隐藏决策输入。
#[derive(Debug, Clone, Copy)]
struct FocusLostDecisionInput<'a> {
    window_label: &'a str,
    hide_on_app_blur: bool,
    main_visible: bool,
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
            sequence: AtomicU64::new(0),
            popup_sessions: Mutex::new(HashMap::new()),
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
}

/// 判断某次原生失焦是否应该隐藏完整搜索窗口组。
fn should_hide_on_focus_lost(input: FocusLostDecisionInput<'_>) -> bool {
    if !input.hide_on_app_blur || !input.main_visible || input.main_always_on_top {
        return false;
    }
    if input.app_focused {
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
pub fn set_hide_on_app_blur(app_handle: &AppHandle, should_hide: bool) -> Result<(), String> {
    let runtime = app_handle
        .try_state::<SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
    runtime.set_hide_on_app_blur(should_hide);
    Ok(())
}

/// 广播并清空所有已登记的 popup 关闭事实。
pub fn emit_registered_popup_closed(
    app_handle: &AppHandle,
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
pub fn hide_popup_surface(
    app_handle: &AppHandle,
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
        emit_registered_popup_closed(app_handle, vec![closed_session])
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
pub fn show_surface(app_handle: &AppHandle, source: SearchSurfaceShowSource) -> Result<(), String> {
    let runtime = app_handle
        .try_state::<SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "Failed to get main window".to_string())?;

    super::show_and_activate_search_window(&window)?;
    app_handle
        .emit(
            "search-surface-shown",
            SearchSurfaceShownPayload {
                source: source.as_str(),
                sequence: runtime.next_sequence(),
            },
        )
        .map_err(|error| format!("Failed to emit search surface shown event: {}", error))
}

/// 隐藏搜索窗口组并广播原生事实。
pub fn hide_surface(app_handle: &AppHandle, reason: SearchSurfaceHideReason) -> Result<(), String> {
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
pub fn handle_focus_lost(app_handle: &AppHandle, window_label: &str) -> Result<(), String> {
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
pub fn handle_window_blur(app_handle: &AppHandle, window_label: &str) {
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
pub fn handle_window_destroyed(app_handle: &AppHandle, window_label: &str) {
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
