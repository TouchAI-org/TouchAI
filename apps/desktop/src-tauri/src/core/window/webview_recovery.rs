// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

//! WebView2 process-failure recovery.

use std::collections::{HashMap, VecDeque};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

use tauri::{Manager, Runtime, WebviewWindow};
#[cfg(target_os = "windows")]
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
#[cfg(target_os = "windows")]
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2Controller, ICoreWebView2NavigationCompletedEventArgs,
        ICoreWebView2NavigationStartingEventArgs, ICoreWebView2ProcessFailedEventArgs,
        ICoreWebView2ProcessFailedEventArgs2, COREWEBVIEW2_PROCESS_FAILED_KIND,
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
        COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_REASON, COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED,
        COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED,
        COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY,
        COREWEBVIEW2_PROCESS_FAILED_REASON_PROFILE_DELETED,
        COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED,
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED,
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE,
    },
    NavigationCompletedEventHandler, NavigationStartingEventHandler, ProcessFailedEventHandler,
};
#[cfg(target_os = "windows")]
use windows::core::BOOL;
#[cfg(target_os = "windows")]
use windows::Win32::System::{
    ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
    SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX},
    Threading::GetCurrentProcess,
};
#[cfg(target_os = "windows")]
use windows_core::Interface;

use crate::core::window::search::surface::SearchSurfaceShowSource;

const RECOVERY_ATTEMPT_LIMIT: usize = 3;
const RECOVERY_ATTEMPT_WINDOW_MS: u64 = 60_000;
const RECOVERY_TIMEOUT_MS: u64 = 30_000;
const UNRESPONSIVE_EVENT_LIMIT: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessFailureKind {
    BrowserExited,
    RendererExited,
    RendererUnresponsive,
    ChromiumManaged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryDecision {
    Ignore,
    Reload { attempt: u32 },
    Exhausted,
    RestartApplication,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryAction {
    Ignore,
    Reload { attempt: u32, recovery_id: u64 },
    Exhausted { notify_user: bool },
    RestartApplication,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShowIntent {
    Focus,
    SearchSurface(SearchSurfaceShowSource),
    Settings { show_updates: bool },
}

#[derive(Debug, Default)]
pub(crate) struct RecoveryPolicyState {
    attempts: VecDeque<u64>,
    unresponsive_events: VecDeque<u64>,
}

impl RecoveryPolicyState {
    pub(crate) fn record(&mut self, failure: ProcessFailureKind, now_ms: u64) -> RecoveryDecision {
        match failure {
            ProcessFailureKind::BrowserExited => RecoveryDecision::RestartApplication,
            ProcessFailureKind::ChromiumManaged => RecoveryDecision::Ignore,
            ProcessFailureKind::RendererExited => {
                self.unresponsive_events.clear();
                self.record_recovery_attempt(now_ms)
            }
            ProcessFailureKind::RendererUnresponsive => {
                prune_events(&mut self.unresponsive_events, now_ms);
                self.unresponsive_events.push_back(now_ms);
                if self.unresponsive_events.len() < UNRESPONSIVE_EVENT_LIMIT {
                    return RecoveryDecision::Ignore;
                }

                self.unresponsive_events.clear();
                self.record_recovery_attempt(now_ms)
            }
        }
    }

    fn reset(&mut self) {
        self.attempts.clear();
        self.unresponsive_events.clear();
    }

    fn record_recovery_attempt(&mut self, now_ms: u64) -> RecoveryDecision {
        prune_events(&mut self.attempts, now_ms);
        if self.attempts.len() >= RECOVERY_ATTEMPT_LIMIT {
            return RecoveryDecision::Exhausted;
        }

        self.attempts.push_back(now_ms);
        RecoveryDecision::Reload {
            attempt: self.attempts.len() as u32,
        }
    }
}

fn prune_events(events: &mut VecDeque<u64>, now_ms: u64) {
    if now_ms < RECOVERY_ATTEMPT_WINDOW_MS {
        return;
    }

    let cutoff = now_ms - RECOVERY_ATTEMPT_WINDOW_MS;
    while events.front().is_some_and(|event| *event <= cutoff) {
        events.pop_front();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum RecoveryPhase {
    #[default]
    Idle,
    Recovering,
    Exhausted,
}

#[derive(Debug, Default)]
struct WindowRecoveryState {
    policy: RecoveryPolicyState,
    phase: RecoveryPhase,
    show_after_recovery: bool,
    show_intent: Option<ShowIntent>,
    retry_dialog_open: bool,
    recovery_id: u64,
    navigation_id: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShowReadiness {
    Ready,
    Deferred,
    AwaitingRetry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NavigationCompletion {
    NotRecovering,
    Show {
        show: bool,
        intent: Option<ShowIntent>,
    },
    Failed {
        notify_user: bool,
    },
}

pub(crate) struct WebviewRecoveryRuntime {
    started_at: Instant,
    windows: Mutex<HashMap<String, WindowRecoveryState>>,
    next_recovery_id: AtomicU64,
    restart_requested: AtomicBool,
}

impl WebviewRecoveryRuntime {
    pub(crate) fn new() -> Self {
        Self {
            started_at: Instant::now(),
            windows: Mutex::new(HashMap::new()),
            next_recovery_id: AtomicU64::new(0),
            restart_requested: AtomicBool::new(false),
        }
    }

    fn now_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }

    fn allocate_recovery_id(&self) -> u64 {
        self.next_recovery_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn record_failure(
        &self,
        window_label: &str,
        failure: ProcessFailureKind,
        was_visible: bool,
    ) -> RecoveryAction {
        self.record_failure_at(window_label, failure, was_visible, self.now_ms())
    }

    pub(crate) fn record_failure_at(
        &self,
        window_label: &str,
        failure: ProcessFailureKind,
        was_visible: bool,
        now_ms: u64,
    ) -> RecoveryAction {
        let mut windows = self
            .windows
            .lock()
            .expect("webview recovery runtime poisoned");
        let state = windows.entry(window_label.to_string()).or_default();

        let decision = state.policy.record(failure, now_ms);
        if matches!(
            decision,
            RecoveryDecision::Reload { .. } | RecoveryDecision::Exhausted
        ) {
            state.show_after_recovery |= was_visible;
        }
        match decision {
            RecoveryDecision::Reload { attempt } => {
                state.phase = RecoveryPhase::Recovering;
                state.recovery_id = self.allocate_recovery_id();
                state.navigation_id = None;
                RecoveryAction::Reload {
                    attempt,
                    recovery_id: state.recovery_id,
                }
            }
            RecoveryDecision::Exhausted => {
                state.phase = RecoveryPhase::Exhausted;
                RecoveryAction::Exhausted {
                    notify_user: state.show_after_recovery,
                }
            }
            RecoveryDecision::Ignore => RecoveryAction::Ignore,
            RecoveryDecision::RestartApplication => RecoveryAction::RestartApplication,
        }
    }

    fn request_show(&self, window_label: &str, intent: ShowIntent) -> ShowReadiness {
        let mut windows = self
            .windows
            .lock()
            .expect("webview recovery runtime poisoned");
        let state = windows.entry(window_label.to_string()).or_default();
        match state.phase {
            RecoveryPhase::Idle => ShowReadiness::Ready,
            RecoveryPhase::Recovering => {
                state.show_after_recovery = true;
                state.show_intent = Some(merge_show_intent(state.show_intent, intent));
                ShowReadiness::Deferred
            }
            RecoveryPhase::Exhausted => {
                state.show_after_recovery = true;
                state.show_intent = Some(merge_show_intent(state.show_intent, intent));
                ShowReadiness::AwaitingRetry
            }
        }
    }

    fn cancel_pending_show(&self, window_label: &str) {
        let mut windows = self
            .windows
            .lock()
            .expect("webview recovery runtime poisoned");
        let Some(state) = windows.get_mut(window_label) else {
            return;
        };
        if state.phase == RecoveryPhase::Idle {
            return;
        }

        state.show_after_recovery = false;
        state.show_intent = None;
    }

    fn note_navigation_started(&self, window_label: &str, navigation_id: u64) -> bool {
        let mut windows = self
            .windows
            .lock()
            .expect("webview recovery runtime poisoned");
        let Some(state) = windows.get_mut(window_label) else {
            return false;
        };
        if state.phase != RecoveryPhase::Recovering {
            return false;
        }

        state.navigation_id = Some(navigation_id);
        true
    }

    fn complete_navigation(
        &self,
        window_label: &str,
        navigation_id: u64,
        is_success: bool,
    ) -> NavigationCompletion {
        let mut windows = self
            .windows
            .lock()
            .expect("webview recovery runtime poisoned");
        let Some(state) = windows.get_mut(window_label) else {
            return NavigationCompletion::NotRecovering;
        };
        if state.phase != RecoveryPhase::Recovering {
            return NavigationCompletion::NotRecovering;
        }
        if state.navigation_id != Some(navigation_id) {
            return NavigationCompletion::NotRecovering;
        }
        state.navigation_id = None;

        if !is_success {
            state.phase = RecoveryPhase::Exhausted;
            return NavigationCompletion::Failed {
                notify_user: state.show_after_recovery,
            };
        }

        state.phase = RecoveryPhase::Idle;
        NavigationCompletion::Show {
            show: std::mem::take(&mut state.show_after_recovery),
            intent: state.show_intent.take(),
        }
    }

    fn reload_failed(&self, window_label: &str, recovery_id: u64) -> bool {
        let mut windows = self
            .windows
            .lock()
            .expect("webview recovery runtime poisoned");
        let Some(state) = windows.get_mut(window_label) else {
            return false;
        };
        if state.phase != RecoveryPhase::Recovering || state.recovery_id != recovery_id {
            return false;
        }

        state.phase = RecoveryPhase::Exhausted;
        state.show_after_recovery
    }

    fn expire_recovery(&self, window_label: &str, recovery_id: u64) -> Option<bool> {
        let mut windows = self
            .windows
            .lock()
            .expect("webview recovery runtime poisoned");
        let state = windows.get_mut(window_label)?;
        if state.phase != RecoveryPhase::Recovering || state.recovery_id != recovery_id {
            return None;
        }

        state.phase = RecoveryPhase::Exhausted;
        Some(state.show_after_recovery)
    }

    fn is_current_recovery(&self, window_label: &str, recovery_id: u64) -> bool {
        let windows = self
            .windows
            .lock()
            .expect("webview recovery runtime poisoned");
        windows.get(window_label).is_some_and(|state| {
            state.phase == RecoveryPhase::Recovering && state.recovery_id == recovery_id
        })
    }

    fn begin_retry_dialog(&self, window_label: &str) -> bool {
        let mut windows = self
            .windows
            .lock()
            .expect("webview recovery runtime poisoned");
        let state = windows.entry(window_label.to_string()).or_default();
        if state.phase != RecoveryPhase::Exhausted || state.retry_dialog_open {
            return false;
        }

        state.retry_dialog_open = true;
        true
    }

    fn finish_retry_dialog(&self, window_label: &str) {
        let mut windows = self
            .windows
            .lock()
            .expect("webview recovery runtime poisoned");
        if let Some(state) = windows.get_mut(window_label) {
            state.retry_dialog_open = false;
        }
    }

    fn retry_after_exhaustion(&self, window_label: &str) -> Option<u64> {
        let mut windows = self
            .windows
            .lock()
            .expect("webview recovery runtime poisoned");
        let state = windows.entry(window_label.to_string()).or_default();
        if state.phase != RecoveryPhase::Exhausted {
            return None;
        }

        state.policy.reset();
        state.phase = RecoveryPhase::Recovering;
        state.recovery_id = self.allocate_recovery_id();
        state.navigation_id = None;
        Some(state.recovery_id)
    }

    fn forget_window(&self, window_label: &str) {
        let mut windows = self
            .windows
            .lock()
            .expect("webview recovery runtime poisoned");
        windows.remove(window_label);
    }

    fn claim_restart(&self) -> bool {
        !self.restart_requested.swap(true, Ordering::SeqCst)
    }
}

fn merge_show_intent(pending: Option<ShowIntent>, incoming: ShowIntent) -> ShowIntent {
    match (pending, incoming) {
        (
            Some(ShowIntent::Settings { show_updates: true }),
            ShowIntent::Settings {
                show_updates: false,
            },
        ) => ShowIntent::Settings { show_updates: true },
        (_, incoming) => incoming,
    }
}

impl Default for WebviewRecoveryRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn register_webview_recovery<R: Runtime>(
    window: &WebviewWindow<R>,
    controller: &ICoreWebView2Controller,
) -> Result<(), String> {
    let core_webview = unsafe {
        controller
            .CoreWebView2()
            .map_err(|error| format!("Failed to get CoreWebView2 instance: {error}"))?
    };
    register_process_failed_handler(window, &core_webview)?;
    register_navigation_starting_handler(window, &core_webview)?;
    register_navigation_completed_handler(window, &core_webview)?;

    let settings = unsafe {
        core_webview
            .Settings()
            .map_err(|error| format!("Failed to get CoreWebView2 settings: {error}"))?
    };
    unsafe {
        settings
            .SetIsBuiltInErrorPageEnabled(false)
            .map_err(|error| format!("Failed to disable WebView2 built-in error page: {error}"))
    }
}

#[cfg(target_os = "windows")]
fn register_process_failed_handler<R: Runtime>(
    window: &WebviewWindow<R>,
    core_webview: &ICoreWebView2,
) -> Result<(), String> {
    let window = window.clone();
    let mut token = 0i64;
    let handler = ProcessFailedEventHandler::create(Box::new(
        move |_sender: Option<ICoreWebView2>, args: Option<ICoreWebView2ProcessFailedEventArgs>| {
            let Some(args) = args else {
                return Ok(());
            };

            match read_process_failure(&args) {
                Ok(failure) => handle_process_failure(&window, failure),
                Err(error) => log::warn!(
                    "Failed to read WebView2 process failure details for '{}': {}",
                    window.label(),
                    error
                ),
            }
            Ok(())
        },
    ));

    unsafe {
        core_webview
            .add_ProcessFailed(&handler, &mut token)
            .map_err(|error| {
                format!("Failed to register WebView2 process failure handler: {error}")
            })
    }
}

#[cfg(target_os = "windows")]
fn register_navigation_starting_handler<R: Runtime>(
    window: &WebviewWindow<R>,
    core_webview: &ICoreWebView2,
) -> Result<(), String> {
    let window = window.clone();
    let mut token = 0i64;
    let handler = NavigationStartingEventHandler::create(Box::new(
        move |_sender: Option<ICoreWebView2>,
              args: Option<ICoreWebView2NavigationStartingEventArgs>| {
            let Some(args) = args else {
                return Ok(());
            };

            let mut navigation_id = 0u64;
            unsafe {
                args.NavigationId(&mut navigation_id)?;
            }
            handle_navigation_started(&window, navigation_id);
            Ok(())
        },
    ));

    unsafe {
        core_webview
            .add_NavigationStarting(&handler, &mut token)
            .map_err(|error| {
                format!("Failed to register WebView2 navigation starting handler: {error}")
            })
    }
}

#[cfg(target_os = "windows")]
fn register_navigation_completed_handler<R: Runtime>(
    window: &WebviewWindow<R>,
    core_webview: &ICoreWebView2,
) -> Result<(), String> {
    let window = window.clone();
    let mut token = 0i64;
    let handler = NavigationCompletedEventHandler::create(Box::new(
        move |_sender: Option<ICoreWebView2>,
              args: Option<ICoreWebView2NavigationCompletedEventArgs>| {
            let Some(args) = args else {
                return Ok(());
            };

            let mut navigation_id = 0u64;
            let mut is_success = BOOL(0);
            unsafe {
                args.NavigationId(&mut navigation_id)?;
                args.IsSuccess(&mut is_success)?;
            }
            handle_navigation_completed(&window, navigation_id, is_success.as_bool());
            Ok(())
        },
    ));

    unsafe {
        core_webview
            .add_NavigationCompleted(&handler, &mut token)
            .map_err(|error| {
                format!("Failed to register WebView2 navigation completion handler: {error}")
            })
    }
}

#[cfg(target_os = "windows")]
#[derive(Debug)]
struct ProcessFailure {
    kind: ProcessFailureKind,
    kind_name: &'static str,
    reason: &'static str,
    exit_code: Option<i32>,
}

#[cfg(target_os = "windows")]
fn read_process_failure(
    args: &ICoreWebView2ProcessFailedEventArgs,
) -> windows::core::Result<ProcessFailure> {
    let mut raw_kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
    unsafe {
        args.ProcessFailedKind(&mut raw_kind)?;
    }
    let (kind, kind_name) = classify_process_failed_kind(raw_kind);

    let mut reason = "unknown";
    let mut exit_code = None;
    if let Ok(args2) = Interface::cast::<ICoreWebView2ProcessFailedEventArgs2>(args) {
        let mut raw_reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
        if unsafe { args2.Reason(&mut raw_reason) }.is_ok() {
            reason = process_failed_reason_name(raw_reason);
        }

        let mut raw_exit_code = 0i32;
        if unsafe { args2.ExitCode(&mut raw_exit_code) }.is_ok() {
            exit_code = Some(raw_exit_code);
        }
    }

    Ok(ProcessFailure {
        kind,
        kind_name,
        reason,
        exit_code,
    })
}

#[cfg(target_os = "windows")]
fn classify_process_failed_kind(
    kind: COREWEBVIEW2_PROCESS_FAILED_KIND,
) -> (ProcessFailureKind, &'static str) {
    match kind {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => {
            (ProcessFailureKind::BrowserExited, "browser_process_exited")
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => {
            (ProcessFailureKind::RendererExited, "render_process_exited")
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => (
            ProcessFailureKind::RendererUnresponsive,
            "render_process_unresponsive",
        ),
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED => (
            ProcessFailureKind::ChromiumManaged,
            "frame_render_process_exited",
        ),
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => {
            (ProcessFailureKind::ChromiumManaged, "gpu_process_exited")
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED => (
            ProcessFailureKind::ChromiumManaged,
            "utility_process_exited",
        ),
        COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED => (
            ProcessFailureKind::ChromiumManaged,
            "sandbox_helper_process_exited",
        ),
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED => (
            ProcessFailureKind::ChromiumManaged,
            "ppapi_broker_process_exited",
        ),
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED => (
            ProcessFailureKind::ChromiumManaged,
            "ppapi_plugin_process_exited",
        ),
        COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED => (
            ProcessFailureKind::ChromiumManaged,
            "unknown_process_exited",
        ),
        _ => (ProcessFailureKind::ChromiumManaged, "unknown"),
    }
}

#[cfg(target_os = "windows")]
fn process_failed_reason_name(reason: COREWEBVIEW2_PROCESS_FAILED_REASON) -> &'static str {
    match reason {
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED => "unexpected",
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE => "unresponsive",
        COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED => "terminated",
        COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED => "crashed",
        COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED => "launch_failed",
        COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY => "out_of_memory",
        COREWEBVIEW2_PROCESS_FAILED_REASON_PROFILE_DELETED => "profile_deleted",
        _ => "unknown",
    }
}

#[cfg(target_os = "windows")]
fn handle_process_failure<R: Runtime>(window: &WebviewWindow<R>, failure: ProcessFailure) {
    let was_visible = window.is_visible().unwrap_or(false);
    log_process_failure(window, &failure, was_visible);

    let Some(runtime) = window.app_handle().try_state::<WebviewRecoveryRuntime>() else {
        log::warn!(
            "WebView recovery runtime is unavailable for window '{}'",
            window.label()
        );
        return;
    };
    let decision = runtime.record_failure(window.label(), failure.kind, was_visible);

    match decision {
        RecoveryAction::Ignore => {}
        RecoveryAction::Reload {
            attempt,
            recovery_id,
        } => {
            hide_for_recovery(window);
            log::warn!(
                "Recovering WebView2 process failure in window '{}' with attempt {} (recovery {})",
                window.label(),
                attempt,
                recovery_id
            );
            schedule_reload(window, recovery_id);
        }
        RecoveryAction::Exhausted { notify_user } => {
            hide_for_recovery(window);
            log::error!(
                "Stopping WebView2 recovery for window '{}' after {} attempts in 60 seconds",
                window.label(),
                RECOVERY_ATTEMPT_LIMIT
            );
            if notify_user {
                show_retry_dialog(window);
            }
        }
        RecoveryAction::RestartApplication => {
            hide_for_recovery(window);
            schedule_restart(window);
        }
    }
}

#[cfg(target_os = "windows")]
fn handle_navigation_started<R: Runtime>(window: &WebviewWindow<R>, navigation_id: u64) {
    let Some(runtime) = window.app_handle().try_state::<WebviewRecoveryRuntime>() else {
        return;
    };

    runtime.note_navigation_started(window.label(), navigation_id);
}

#[cfg(target_os = "windows")]
fn handle_navigation_completed<R: Runtime>(
    window: &WebviewWindow<R>,
    navigation_id: u64,
    is_success: bool,
) {
    let Some(runtime) = window.app_handle().try_state::<WebviewRecoveryRuntime>() else {
        return;
    };

    match runtime.complete_navigation(window.label(), navigation_id, is_success) {
        NavigationCompletion::NotRecovering => {}
        NavigationCompletion::Show { show, intent } => {
            log::info!(
                "WebView2 recovery completed for window '{}' (show={}, intent={intent:?})",
                window.label(),
                show
            );
            if show {
                show_recovered_window(window, intent);
            }
        }
        NavigationCompletion::Failed { notify_user } => {
            log::warn!(
                "WebView2 navigation failed after recovery in window '{}'",
                window.label()
            );
            if notify_user {
                show_retry_dialog(window);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn hide_for_recovery<R: Runtime>(window: &WebviewWindow<R>) {
    if let Err(error) = window.hide() {
        log::warn!(
            "Failed to hide window '{}' during WebView2 recovery: {}",
            window.label(),
            error
        );
    }
}

#[cfg(target_os = "windows")]
fn schedule_reload<R: Runtime>(window: &WebviewWindow<R>, recovery_id: u64) {
    let app = window.app_handle().clone();
    let window_label = window.label().to_string();
    let app_for_main_thread = app.clone();
    let main_thread_result = app.run_on_main_thread(move || {
        let Some(runtime) = app_for_main_thread.try_state::<WebviewRecoveryRuntime>() else {
            return;
        };
        if !runtime.is_current_recovery(&window_label, recovery_id) {
            return;
        }

        let Some(window) = app_for_main_thread.get_webview_window(&window_label) else {
            return;
        };
        if let Err(error) = window.reload() {
            log::error!(
                "Failed to reload WebView2 after process failure in window '{}': {}",
                window_label,
                error
            );
            let notify_user = app_for_main_thread
                .try_state::<WebviewRecoveryRuntime>()
                .is_some_and(|runtime| runtime.reload_failed(&window_label, recovery_id));
            if notify_user {
                show_retry_dialog(&window);
            }
        } else {
            schedule_recovery_timeout(app_for_main_thread.clone(), window_label, recovery_id);
        }
    });

    if let Err(error) = main_thread_result {
        log::error!(
            "Failed to schedule WebView2 reload for window '{}': {}",
            window.label(),
            error
        );
    }
}

#[cfg(target_os = "windows")]
fn schedule_recovery_timeout<R: Runtime>(
    app: tauri::AppHandle<R>,
    window_label: String,
    recovery_id: u64,
) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(RECOVERY_TIMEOUT_MS));

        let Some(runtime) = app.try_state::<WebviewRecoveryRuntime>() else {
            return;
        };
        let Some(notify_user) = runtime.expire_recovery(&window_label, recovery_id) else {
            return;
        };
        log::error!(
            "WebView2 recovery timed out for window '{}' (recovery {})",
            window_label,
            recovery_id
        );
        if !notify_user {
            return;
        }

        let app_for_main_thread = app.clone();
        let label_for_main_thread = window_label.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            let Some(window) = app_for_main_thread.get_webview_window(&label_for_main_thread)
            else {
                return;
            };
            show_retry_dialog(&window);
        }) {
            log::error!(
                "Failed to show WebView2 recovery timeout dialog for window '{}': {}",
                window_label,
                error
            );
        }
    });
}

#[cfg(target_os = "windows")]
fn show_recovered_window<R: Runtime>(window: &WebviewWindow<R>, intent: Option<ShowIntent>) {
    let app = window.app_handle().clone();
    let window_label = window.label().to_string();
    let app_for_main_thread = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let Some(window) = app_for_main_thread.get_webview_window(&window_label) else {
            return;
        };

        match intent {
            Some(ShowIntent::SearchSurface(source)) => {
                if let Err(error) =
                    crate::core::window::search::surface::show_surface(&app_for_main_thread, source)
                {
                    log::warn!("Failed to show recovered main window: {}", error);
                }
                return;
            }
            Some(ShowIntent::Settings { show_updates }) => {
                if let Err(error) = crate::core::window::settings::show_settings_window(
                    &app_for_main_thread,
                    show_updates,
                ) {
                    log::warn!("Failed to show recovered settings window: {}", error);
                }
                return;
            }
            Some(ShowIntent::Focus) | None => {}
        }

        if window_label == "main" {
            if let Err(error) = crate::core::window::show_search_window(
                app_for_main_thread.clone(),
                SearchSurfaceShowSource::Main,
            ) {
                log::warn!("Failed to show recovered main window: {}", error);
            }
            return;
        }

        if crate::core::window::webview_recovery::defer_show_if_recovering(
            &window,
            ShowIntent::Focus,
        ) {
            return;
        }
        if window_label == "settings" {
            let _ = crate::core::window::rounded_corners::sync_window_corner_style(&window);
        }
        let _ = window.unminimize();
        if let Err(error) = window.show() {
            log::warn!(
                "Failed to show recovered window '{}': {}",
                window_label,
                error
            );
            return;
        }
        if window_label == "settings" {
            let _ = crate::core::window::rounded_corners::sync_window_corner_style(&window);
        }
        if let Err(error) = window.set_focus() {
            log::warn!(
                "Failed to focus recovered window '{}': {}",
                window_label,
                error
            );
        }
    }) {
        log::error!(
            "Failed to schedule showing recovered WebView2 window '{}': {}",
            window.label(),
            error
        );
    }
}

#[cfg(target_os = "windows")]
fn schedule_restart<R: Runtime>(window: &WebviewWindow<R>) {
    let app = window.app_handle().clone();
    let Some(runtime) = app.try_state::<WebviewRecoveryRuntime>() else {
        return;
    };
    if !runtime.claim_restart() {
        return;
    }

    let app_for_main_thread = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        log::error!("Restarting TouchAI because the WebView2 browser process exited");
        app_for_main_thread.request_restart();
    }) {
        log::error!(
            "Failed to schedule WebView2 browser-process restart: {}",
            error
        );
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn defer_show_if_recovering<R: Runtime>(
    window: &WebviewWindow<R>,
    intent: ShowIntent,
) -> bool {
    let Some(runtime) = window.app_handle().try_state::<WebviewRecoveryRuntime>() else {
        return false;
    };

    match runtime.request_show(window.label(), intent) {
        ShowReadiness::Ready => false,
        ShowReadiness::Deferred => true,
        ShowReadiness::AwaitingRetry => {
            show_retry_dialog(window);
            true
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn defer_show_if_recovering<R: Runtime>(
    _window: &WebviewWindow<R>,
    _intent: ShowIntent,
) -> bool {
    false
}

pub(crate) fn cancel_pending_show<R: Runtime>(app: &tauri::AppHandle<R>, window_label: &str) {
    let Some(runtime) = app.try_state::<WebviewRecoveryRuntime>() else {
        return;
    };
    runtime.cancel_pending_show(window_label);
}

#[cfg(target_os = "windows")]
fn show_retry_dialog<R: Runtime>(window: &WebviewWindow<R>) {
    let app = window.app_handle().clone();
    let window_label = window.label().to_string();
    let Some(runtime) = app.try_state::<WebviewRecoveryRuntime>() else {
        return;
    };
    if !runtime.begin_retry_dialog(&window_label) {
        return;
    }

    let retry_label = "重新加载".to_string();
    let app_for_callback = app.clone();
    app.dialog()
        .message("窗口意外终止。你可以重新加载窗口继续使用。")
        .title("TouchAI")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            retry_label.clone(),
            "暂不".to_string(),
        ))
        .show_with_result(move |result| {
            let Some(runtime) = app_for_callback.try_state::<WebviewRecoveryRuntime>() else {
                return;
            };
            runtime.finish_retry_dialog(&window_label);
            if result != MessageDialogResult::Custom(retry_label) {
                return;
            }
            let Some(recovery_id) = runtime.retry_after_exhaustion(&window_label) else {
                return;
            };
            if let Some(window) = app_for_callback.get_webview_window(&window_label) {
                schedule_reload(&window, recovery_id);
            }
        });
}

/// Diagnostic context only; recovery never branches on a memory-size threshold.
#[cfg(target_os = "windows")]
#[derive(Debug)]
struct MemorySnapshot {
    total_physical_bytes: u64,
    available_physical_bytes: u64,
    load_percent: u32,
    process_working_set_bytes: u64,
}

#[cfg(target_os = "windows")]
fn memory_snapshot() -> Result<MemorySnapshot, String> {
    let mut memory_status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    let mut counters = PROCESS_MEMORY_COUNTERS::default();

    unsafe {
        GlobalMemoryStatusEx(&mut memory_status)
            .map_err(|error| format!("Failed to read system memory: {error}"))?;
        GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut counters,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
        .map_err(|error| format!("Failed to read process memory: {error}"))?;
    }

    Ok(MemorySnapshot {
        total_physical_bytes: memory_status.ullTotalPhys,
        available_physical_bytes: memory_status.ullAvailPhys,
        load_percent: memory_status.dwMemoryLoad,
        process_working_set_bytes: counters.WorkingSetSize as u64,
    })
}

#[cfg(target_os = "windows")]
fn log_process_failure<R: Runtime>(
    window: &WebviewWindow<R>,
    failure: &ProcessFailure,
    was_visible: bool,
) {
    match memory_snapshot() {
        Ok(memory) => log::warn!(
            "WebView2 process failure: window='{}', visible={}, kind={}, reason={}, exit_code={:?}, \
             physical_total_mb={}, physical_available_mb={}, physical_load_percent={}, \
             app_working_set_mb={}",
            window.label(),
            was_visible,
            failure.kind_name,
            failure.reason,
            failure.exit_code,
            memory.total_physical_bytes / 1024 / 1024,
            memory.available_physical_bytes / 1024 / 1024,
            memory.load_percent,
            memory.process_working_set_bytes / 1024 / 1024
        ),
        Err(error) => log::warn!(
            "WebView2 process failure: window='{}', visible={}, kind={}, reason={}, exit_code={:?}; \
             memory snapshot unavailable: {}",
            window.label(),
            was_visible,
            failure.kind_name,
            failure.reason,
            failure.exit_code,
            error
        ),
    }
}

pub(crate) fn forget_window<R: Runtime>(app: &tauri::AppHandle<R>, window_label: &str) {
    let Some(runtime) = app.try_state::<WebviewRecoveryRuntime>() else {
        return;
    };
    runtime.forget_window(window_label);
}

#[cfg(test)]
mod tests {
    use super::{
        NavigationCompletion, ProcessFailureKind, RecoveryAction, RecoveryDecision,
        RecoveryPolicyState, ShowIntent, ShowReadiness, WebviewRecoveryRuntime,
    };

    fn recovery_decision(
        state: &mut RecoveryPolicyState,
        failure: ProcessFailureKind,
        now_ms: u64,
    ) -> RecoveryDecision {
        state.record(failure, now_ms)
    }

    fn start_recovery(
        runtime: &WebviewRecoveryRuntime,
        window_label: &str,
        was_visible: bool,
        now_ms: u64,
    ) -> u64 {
        match runtime.record_failure_at(
            window_label,
            ProcessFailureKind::RendererExited,
            was_visible,
            now_ms,
        ) {
            RecoveryAction::Reload { recovery_id, .. } => recovery_id,
            decision => panic!("expected recovery, got {decision:?}"),
        }
    }

    #[test]
    fn user_gets_a_renderer_crash_recovered() {
        let mut state = RecoveryPolicyState::default();

        let decision = recovery_decision(&mut state, ProcessFailureKind::RendererExited, 0);

        assert_eq!(decision, RecoveryDecision::Reload { attempt: 1 });
    }

    #[test]
    fn user_gets_recovery_stopped_after_three_crashes_in_a_minute() {
        let mut state = RecoveryPolicyState::default();
        for now_ms in [0, 10_000, 20_000] {
            assert!(matches!(
                recovery_decision(&mut state, ProcessFailureKind::RendererExited, now_ms),
                RecoveryDecision::Reload { .. }
            ));
        }

        let decision = recovery_decision(&mut state, ProcessFailureKind::RendererExited, 30_000);

        assert_eq!(decision, RecoveryDecision::Exhausted);
    }

    #[test]
    fn user_gets_another_recovery_after_a_minute_passes() {
        let mut state = RecoveryPolicyState::default();
        for now_ms in [0, 10_000, 20_000] {
            let _ = recovery_decision(&mut state, ProcessFailureKind::RendererExited, now_ms);
        }

        let decision = recovery_decision(&mut state, ProcessFailureKind::RendererExited, 80_001);

        assert_eq!(decision, RecoveryDecision::Reload { attempt: 1 });
    }

    #[test]
    fn user_gets_no_reload_for_the_first_unresponsive_notice() {
        let mut state = RecoveryPolicyState::default();

        let decision = recovery_decision(&mut state, ProcessFailureKind::RendererUnresponsive, 0);

        assert_eq!(decision, RecoveryDecision::Ignore);
    }

    #[test]
    fn user_gets_recovery_for_a_repeated_unresponsive_notice() {
        let mut state = RecoveryPolicyState::default();
        let _ = recovery_decision(&mut state, ProcessFailureKind::RendererUnresponsive, 0);

        let decision =
            recovery_decision(&mut state, ProcessFailureKind::RendererUnresponsive, 1_000);

        assert_eq!(decision, RecoveryDecision::Reload { attempt: 1 });
    }

    #[test]
    fn user_gets_an_old_unresponsive_notice_forgotten() {
        let mut state = RecoveryPolicyState::default();
        let _ = recovery_decision(&mut state, ProcessFailureKind::RendererUnresponsive, 0);

        let decision =
            recovery_decision(&mut state, ProcessFailureKind::RendererUnresponsive, 60_001);

        assert_eq!(decision, RecoveryDecision::Ignore);
    }

    #[test]
    fn user_gets_unresponsive_recoveries_counted_toward_the_crash_cap() {
        let mut state = RecoveryPolicyState::default();
        for now_ms in [0, 10_000, 20_000] {
            let _ = recovery_decision(&mut state, ProcessFailureKind::RendererExited, now_ms);
        }
        let _ = recovery_decision(&mut state, ProcessFailureKind::RendererUnresponsive, 30_000);

        let decision =
            recovery_decision(&mut state, ProcessFailureKind::RendererUnresponsive, 31_000);

        assert_eq!(decision, RecoveryDecision::Exhausted);
    }

    #[test]
    fn user_gets_the_app_restarted_when_the_browser_process_exits() {
        let mut state = RecoveryPolicyState::default();

        let decision = recovery_decision(&mut state, ProcessFailureKind::BrowserExited, 0);

        assert_eq!(decision, RecoveryDecision::RestartApplication);
    }

    #[test]
    fn user_gets_chromium_managed_process_exits_left_alone() {
        let mut state = RecoveryPolicyState::default();

        let decision = recovery_decision(&mut state, ProcessFailureKind::ChromiumManaged, 0);

        assert_eq!(decision, RecoveryDecision::Ignore);
    }

    #[test]
    fn user_gets_a_visible_window_back_only_after_recovery_finishes() {
        let runtime = WebviewRecoveryRuntime::new();
        let recovery_id = start_recovery(&runtime, "main", true, 0);

        runtime.note_navigation_started("main", 7);
        assert_eq!(
            runtime.complete_navigation("main", 7, true),
            NavigationCompletion::Show {
                show: true,
                intent: None
            }
        );
        assert!(!runtime.is_current_recovery("main", recovery_id));
    }

    #[test]
    fn user_gets_a_hidden_window_left_hidden_after_recovery() {
        let runtime = WebviewRecoveryRuntime::new();
        start_recovery(&runtime, "main", false, 0);

        runtime.note_navigation_started("main", 7);
        assert_eq!(
            runtime.complete_navigation("main", 7, true),
            NavigationCompletion::Show {
                show: false,
                intent: None
            }
        );
    }

    #[test]
    fn user_gets_a_hidden_window_shown_when_it_was_requested_during_recovery() {
        let runtime = WebviewRecoveryRuntime::new();
        start_recovery(&runtime, "settings", false, 0);

        assert_eq!(
            runtime.request_show("settings", ShowIntent::Settings { show_updates: true }),
            ShowReadiness::Deferred
        );
        runtime.note_navigation_started("settings", 9);
        assert_eq!(
            runtime.complete_navigation("settings", 9, true),
            NavigationCompletion::Show {
                show: true,
                intent: Some(ShowIntent::Settings { show_updates: true })
            }
        );
    }

    #[test]
    fn user_gets_a_pending_show_cancelled_when_the_window_is_hidden_during_recovery() {
        let runtime = WebviewRecoveryRuntime::new();
        start_recovery(&runtime, "settings", false, 0);
        assert_eq!(
            runtime.request_show("settings", ShowIntent::Settings { show_updates: true }),
            ShowReadiness::Deferred
        );

        runtime.cancel_pending_show("settings");
        runtime.note_navigation_started("settings", 9);

        assert_eq!(
            runtime.complete_navigation("settings", 9, true),
            NavigationCompletion::Show {
                show: false,
                intent: None
            }
        );
    }

    #[test]
    fn user_gets_pending_updates_preserved_when_settings_is_requested_again_during_recovery() {
        let runtime = WebviewRecoveryRuntime::new();
        start_recovery(&runtime, "settings", false, 0);
        let _ = runtime.request_show("settings", ShowIntent::Settings { show_updates: true });

        assert_eq!(
            runtime.request_show(
                "settings",
                ShowIntent::Settings {
                    show_updates: false
                }
            ),
            ShowReadiness::Deferred
        );
        runtime.note_navigation_started("settings", 9);

        assert_eq!(
            runtime.complete_navigation("settings", 9, true),
            NavigationCompletion::Show {
                show: true,
                intent: Some(ShowIntent::Settings { show_updates: true })
            }
        );
    }

    #[test]
    fn user_gets_pending_updates_preserved_when_settings_is_requested_again_after_exhaustion() {
        let runtime = WebviewRecoveryRuntime::new();
        for now_ms in [0, 10_000, 20_000, 30_000] {
            let _ = runtime.record_failure_at(
                "settings",
                ProcessFailureKind::RendererExited,
                true,
                now_ms,
            );
        }
        let _ = runtime.request_show("settings", ShowIntent::Settings { show_updates: true });

        assert_eq!(
            runtime.request_show(
                "settings",
                ShowIntent::Settings {
                    show_updates: false
                }
            ),
            ShowReadiness::AwaitingRetry
        );
        assert!(runtime.retry_after_exhaustion("settings").is_some());
        runtime.note_navigation_started("settings", 9);

        assert_eq!(
            runtime.complete_navigation("settings", 9, true),
            NavigationCompletion::Show {
                show: true,
                intent: Some(ShowIntent::Settings { show_updates: true })
            }
        );
    }

    #[test]
    fn user_gets_a_hidden_window_left_hidden_after_an_ignored_unresponsive_notice() {
        let runtime = WebviewRecoveryRuntime::new();
        let decision =
            runtime.record_failure_at("main", ProcessFailureKind::RendererUnresponsive, true, 0);
        assert_eq!(decision, RecoveryAction::Ignore);
        runtime.cancel_pending_show("main");

        let _ = runtime.record_failure_at("main", ProcessFailureKind::RendererExited, false, 1_000);
        runtime.note_navigation_started("main", 7);

        assert_eq!(
            runtime.complete_navigation("main", 7, true),
            NavigationCompletion::Show {
                show: false,
                intent: None
            }
        );
    }

    #[test]
    fn user_does_not_get_a_retry_dialog_for_a_hidden_window_after_an_ignored_unresponsive_notice() {
        let runtime = WebviewRecoveryRuntime::new();
        let decision =
            runtime.record_failure_at("main", ProcessFailureKind::RendererUnresponsive, true, 0);
        assert_eq!(decision, RecoveryAction::Ignore);
        runtime.cancel_pending_show("main");

        for now_ms in [1_000, 2_000, 3_000] {
            let decision = runtime.record_failure_at(
                "main",
                ProcessFailureKind::RendererExited,
                false,
                now_ms,
            );
            assert!(matches!(decision, RecoveryAction::Reload { .. }));
        }
        let decision =
            runtime.record_failure_at("main", ProcessFailureKind::RendererExited, false, 4_000);

        assert_eq!(decision, RecoveryAction::Exhausted { notify_user: false });
    }

    #[test]
    fn user_gets_no_stale_navigation_completion_used_for_recovery() {
        let runtime = WebviewRecoveryRuntime::new();
        start_recovery(&runtime, "main", true, 0);

        assert_eq!(
            runtime.complete_navigation("main", 3, true),
            NavigationCompletion::NotRecovering
        );
        runtime.note_navigation_started("main", 4);
        assert_eq!(
            runtime.complete_navigation("main", 3, true),
            NavigationCompletion::NotRecovering
        );
        assert_eq!(
            runtime.complete_navigation("main", 4, true),
            NavigationCompletion::Show {
                show: true,
                intent: None
            }
        );
    }

    #[test]
    fn user_gets_recovery_stopped_when_the_reload_times_out() {
        let runtime = WebviewRecoveryRuntime::new();
        let recovery_id = start_recovery(&runtime, "main", true, 0);

        assert_eq!(
            runtime.expire_recovery("main", recovery_id),
            Some(true),
            "a pending visible window should notify the user"
        );
        assert_eq!(
            runtime.expire_recovery("main", recovery_id),
            None,
            "the same recovery must not time out twice"
        );
        assert_eq!(
            runtime.request_show("main", ShowIntent::Focus),
            ShowReadiness::AwaitingRetry
        );
    }

    #[test]
    fn user_gets_an_old_timeout_ignored_after_a_new_recovery_starts() {
        let runtime = WebviewRecoveryRuntime::new();
        let old_recovery_id = start_recovery(&runtime, "main", true, 0);
        let new_recovery_id = start_recovery(&runtime, "main", true, 1_000);

        assert_eq!(runtime.expire_recovery("main", old_recovery_id), None);
        assert!(runtime.is_current_recovery("main", new_recovery_id));
    }

    #[test]
    fn user_gets_an_old_timeout_ignored_after_the_window_is_recreated() {
        let runtime = WebviewRecoveryRuntime::new();
        let old_recovery_id = start_recovery(&runtime, "settings", true, 0);
        runtime.forget_window("settings");
        let new_recovery_id = start_recovery(&runtime, "settings", true, 1_000);

        assert_ne!(old_recovery_id, new_recovery_id);
        assert_eq!(runtime.expire_recovery("settings", old_recovery_id), None);
        assert!(runtime.is_current_recovery("settings", new_recovery_id));
    }

    #[test]
    fn user_gets_one_retry_dialog_after_the_recovery_cap() {
        let runtime = WebviewRecoveryRuntime::new();
        for now_ms in [0, 10_000, 20_000] {
            let _ =
                runtime.record_failure_at("main", ProcessFailureKind::RendererExited, true, now_ms);
        }
        let decision =
            runtime.record_failure_at("main", ProcessFailureKind::RendererExited, true, 30_000);

        assert_eq!(decision, RecoveryAction::Exhausted { notify_user: true });
        assert!(runtime.begin_retry_dialog("main"));
        assert!(!runtime.begin_retry_dialog("main"));
        runtime.finish_retry_dialog("main");
        assert!(runtime.begin_retry_dialog("main"));
    }

    #[test]
    fn user_does_not_get_a_hidden_window_dialog_after_the_recovery_cap() {
        let runtime = WebviewRecoveryRuntime::new();
        for now_ms in [0, 10_000, 20_000] {
            let decision = runtime.record_failure_at(
                "popup-model-dropdown-popup",
                ProcessFailureKind::RendererExited,
                false,
                now_ms,
            );
            assert!(matches!(decision, RecoveryAction::Reload { .. }));
        }
        let decision = runtime.record_failure_at(
            "popup-model-dropdown-popup",
            ProcessFailureKind::RendererExited,
            false,
            30_000,
        );

        assert_eq!(decision, RecoveryAction::Exhausted { notify_user: false });
        assert_eq!(
            runtime.request_show("popup-model-dropdown-popup", ShowIntent::Focus),
            ShowReadiness::AwaitingRetry
        );
    }

    #[test]
    fn user_gets_a_manual_retry_to_start_recovery_again() {
        let runtime = WebviewRecoveryRuntime::new();
        for now_ms in [0, 10_000, 20_000] {
            let _ =
                runtime.record_failure_at("main", ProcessFailureKind::RendererExited, true, now_ms);
        }
        let _ = runtime.record_failure_at("main", ProcessFailureKind::RendererExited, true, 30_000);

        assert!(runtime.retry_after_exhaustion("main").is_some());
        assert_eq!(
            runtime.request_show("main", ShowIntent::Focus),
            ShowReadiness::Deferred
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn user_gets_subframe_renderer_exits_left_to_chromium() {
        use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED;

        let (kind, _) = super::classify_process_failed_kind(
            COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
        );

        assert_eq!(kind, ProcessFailureKind::ChromiumManaged);
    }
}
