// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

//! Screen-edge activity glow for computer-use actions.
//!
//! The window is decorative only: it never receives focus or pointer input, and
//! Windows excludes it from screen capture so the driver still observes the same
//! desktop it is acting on.

mod stop_shortcut;

use std::collections::HashMap;
use std::sync::Mutex;

use log::warn;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Runtime, Size,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

pub const WINDOW_LABEL: &str = "computer-use-glow";

pub(crate) const WINDOW_TITLE: &str = "TouchAI computer use";
const WINDOW_ROUTE: &str = "#/computer-use-glow";
const PULSE_EVENT: &str = "computer-use-glow-pulse";

#[derive(Default)]
struct GlowState {
    generation: u64,
    active_tasks: HashMap<String, Activity>,
    next_ordinal: u32,
    locale: String,
}

struct Activity {
    ordinal: u32,
    pointer: Option<PointerPosition>,
    foreground_calls: usize,
    cancellation: tokio::sync::watch::Sender<bool>,
}

impl GlowState {
    fn accepts_pulse(&self, activity_id: Option<&str>) -> bool {
        activity_id
            .and_then(|id| self.active_tasks.get(id))
            .is_some_and(|activity| activity.foreground_calls > 0)
    }

    fn can_hide(&self, generation: u64) -> bool {
        self.generation == generation
            && self
                .active_tasks
                .values()
                .all(|activity| activity.foreground_calls == 0)
    }

    fn begin(&mut self, activity_id: &str) -> Result<bool, String> {
        if self.active_tasks.contains_key(activity_id) {
            return Ok(false);
        }
        if self.active_tasks.len() >= 32 {
            return Err("Too many active computer-use tasks".into());
        }
        if self.active_tasks.is_empty() {
            self.next_ordinal = 0;
        }
        self.next_ordinal += 1;
        self.active_tasks.insert(
            activity_id.into(),
            Activity {
                ordinal: self.next_ordinal,
                pointer: None,
                foreground_calls: 0,
                cancellation: tokio::sync::watch::channel(false).0,
            },
        );
        Ok(true)
    }

    fn finish(&mut self, activity_id: &str) -> bool {
        if let Some(activity) = self.active_tasks.remove(activity_id) {
            activity.cancellation.send_replace(true);
            return true;
        }
        false
    }

    fn begin_foreground(&mut self, activity_id: &str) -> Result<(), String> {
        let activity = self
            .active_tasks
            .get_mut(activity_id)
            .ok_or_else(|| "computer use cancelled".to_string())?;
        activity.foreground_calls += 1;
        Ok(())
    }

    fn end_foreground(&mut self, activity_id: &str) {
        if let Some(activity) = self.active_tasks.get_mut(activity_id) {
            activity.foreground_calls = activity.foreground_calls.saturating_sub(1);
            if activity.foreground_calls == 0 {
                activity.pointer = None;
            }
        }
    }

    fn pointers(&self, bounds: ScreenRect, scale: f64) -> Vec<ActivityPayload> {
        let mut activities: Vec<_> = self
            .active_tasks
            .iter()
            .filter(|(_, activity)| activity.foreground_calls > 0)
            .map(|(id, activity)| ActivityPayload {
                id: id.clone(),
                ordinal: activity.ordinal,
                pointer: activity
                    .pointer
                    .and_then(|point| local_pointer(point, bounds, scale)),
            })
            .collect();
        activities.sort_by_key(|activity| activity.ordinal);
        activities
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
pub struct PointerPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Serialize)]
pub struct PulsePayload {
    generation: u64,
    activities: Vec<ActivityPayload>,
    banner: Option<PointerPosition>,
    locale: String,
}

#[derive(Clone, Serialize)]
struct ActivityPayload {
    id: String,
    ordinal: u32,
    pointer: Option<PointerPosition>,
}

fn local_pointer(
    pointer: PointerPosition,
    bounds: ScreenRect,
    scale: f64,
) -> Option<PointerPosition> {
    let local_x = pointer.x - f64::from(bounds.x);
    let local_y = pointer.y - f64::from(bounds.y);
    if !scale.is_finite()
        || scale <= 0.0
        || !local_x.is_finite()
        || !local_y.is_finite()
        || local_x < 0.0
        || local_y < 0.0
        || local_x >= f64::from(bounds.width)
        || local_y >= f64::from(bounds.height)
    {
        return None;
    }
    Some(PointerPosition {
        x: local_x / scale,
        y: local_y / scale,
    })
}

pub struct ComputerUseGlowRuntime {
    state: Mutex<GlowState>,
}

impl ComputerUseGlowRuntime {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(GlowState::default()),
        }
    }
}

impl Default for ComputerUseGlowRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ScreenRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn union_screen_bounds(rects: impl IntoIterator<Item = ScreenRect>) -> Option<ScreenRect> {
    let mut bounds: Option<ScreenRect> = None;

    for rect in rects {
        if rect.width == 0 || rect.height == 0 {
            continue;
        }

        bounds = Some(match bounds {
            None => rect,
            Some(current) => {
                let left = i64::from(current.x.min(rect.x));
                let top = i64::from(current.y.min(rect.y));
                let right = (i64::from(current.x) + i64::from(current.width))
                    .max(i64::from(rect.x) + i64::from(rect.width));
                let bottom = (i64::from(current.y) + i64::from(current.height))
                    .max(i64::from(rect.y) + i64::from(rect.height));

                ScreenRect {
                    x: i32::try_from(left).ok()?,
                    y: i32::try_from(top).ok()?,
                    width: u32::try_from(right - left).ok()?,
                    height: u32::try_from(bottom - top).ok()?,
                }
            }
        });
    }

    bounds
}

fn current_screen_bounds<R: Runtime>(app: &AppHandle<R>) -> Result<ScreenRect, String> {
    let monitors = app
        .available_monitors()
        .map_err(|error| format!("Failed to list monitors for the computer-use glow: {error}"))?;

    union_screen_bounds(monitors.iter().map(|monitor| ScreenRect {
        x: monitor.position().x,
        y: monitor.position().y,
        width: monitor.size().width,
        height: monitor.size().height,
    }))
    .ok_or_else(|| "No monitor is available for the computer-use glow".to_string())
}

pub fn preload<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    ensure_window(app).map(|_| ())
}

fn ensure_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        return Ok(window);
    }

    let mut builder =
        WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App(WINDOW_ROUTE.into()))
            .title(WINDOW_TITLE)
            .inner_size(1.0, 1.0)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .content_protected(true)
            .visible(false)
            .focused(false)
            .focusable(false);

    if let Some(browser_args) = crate::core::system::runtime::e2e_webview_additional_browser_args()
    {
        builder = builder.additional_browser_args(&browser_args);
    }

    let window = builder
        .build()
        .map_err(|error| format!("Failed to create the computer-use glow window: {error}"))?;

    if let Err(error) = window.set_ignore_cursor_events(true) {
        let _ = window.destroy();
        return Err(format!(
            "Failed to make the computer-use glow click-through: {error}"
        ));
    }

    if let Err(error) =
        crate::core::window::webview_defaults::apply_webview_runtime_defaults(&window)
    {
        warn!("Failed to apply webview defaults to the computer-use glow: {error}");
    }

    Ok(window)
}

fn set_visible<R: Runtime>(window: &WebviewWindow<R>, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, SWP_ASYNCWINDOWPOS, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE,
            SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW,
        };
        let handle = window.hwnd().map_err(|error| error.to_string())?;
        let visibility = if visible {
            SWP_SHOWWINDOW
        } else {
            SWP_HIDEWINDOW
        };
        unsafe {
            SetWindowPos(
                handle,
                None,
                0,
                0,
                0,
                0,
                visibility
                    | SWP_NOACTIVATE
                    | SWP_NOZORDER
                    | SWP_NOMOVE
                    | SWP_NOSIZE
                    | SWP_ASYNCWINDOWPOS,
            )
        }
        .map_err(|error| format!("Failed to set computer-use glow visibility: {error}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        if visible {
            window.show()
        } else {
            window.hide()
        }
        .map_err(|error| error.to_string())
    }
}

pub fn set_active<R: Runtime>(
    app: &AppHandle<R>,
    activity_id: &str,
    active: bool,
    locale: Option<&str>,
) -> Result<(), String> {
    if activity_id.is_empty() || activity_id.len() > 256 {
        return Err("Invalid computer-use activity identity".to_string());
    }
    let runtime = app
        .try_state::<ComputerUseGlowRuntime>()
        .ok_or_else(|| "Computer-use glow runtime is not initialized".to_string())?;
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| "Computer-use glow runtime is poisoned".to_string())?;
    if active {
        if !state.begin(activity_id)? {
            return Ok(());
        }
        if let Some(locale) = locale.filter(|locale| matches!(*locale, "zh-CN" | "en-US")) {
            state.locale = locale.into();
        }
    } else if state.finish(activity_id) {
        state.generation = state.generation.wrapping_add(1);
        let generation = state.generation;
        drop(state);
        publish(app)?;
        hide_if_current(app, generation);
    }
    Ok(())
}

pub struct ForegroundOperation<R: Runtime> {
    app: AppHandle<R>,
    activity_id: String,
    owns_activity: bool,
}

impl<R: Runtime> ForegroundOperation<R> {
    pub fn begin(
        app: &AppHandle<R>,
        activity_id: Option<&str>,
        execution_id: &str,
    ) -> Result<Self, String> {
        let owns_activity = activity_id.is_none();
        let activity_id = activity_id.unwrap_or(execution_id);
        if owns_activity {
            set_active(app, activity_id, true, None)?;
        }
        {
            let runtime = app.state::<ComputerUseGlowRuntime>();
            let mut state = runtime
                .state
                .lock()
                .map_err(|_| "Computer-use glow runtime is poisoned".to_string())?;
            state.begin_foreground(activity_id)?;
        }
        let operation = Self {
            app: app.clone(),
            activity_id: activity_id.into(),
            owns_activity,
        };
        stop_shortcut::install(app)?;
        pulse(app, None, Some(activity_id))?;
        Ok(operation)
    }

    pub fn activity_id(&self) -> &str {
        &self.activity_id
    }
}

impl<R: Runtime> Drop for ForegroundOperation<R> {
    fn drop(&mut self) {
        let result = (|| -> Result<(), String> {
            let runtime = self.app.state::<ComputerUseGlowRuntime>();
            let mut state = runtime
                .state
                .lock()
                .map_err(|_| "Computer-use glow runtime is poisoned".to_string())?;
            state.end_foreground(&self.activity_id);
            if self.owns_activity {
                state.finish(&self.activity_id);
            }
            state.generation = state.generation.wrapping_add(1);
            let generation = state.generation;
            drop(state);
            let published = publish(&self.app);
            hide_if_current(&self.app, generation);
            published
        })();
        if let Err(error) = result {
            warn!("Failed to release foreground feedback: {error}");
        }
    }
}

pub fn clear<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let Some(runtime) = app.try_state::<ComputerUseGlowRuntime>() else {
        return Ok(());
    };
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| "Computer-use glow runtime is poisoned".to_string())?;
    for (_, activity) in state.active_tasks.drain() {
        activity.cancellation.send_replace(true);
    }
    state.generation = state.generation.wrapping_add(1);
    let generation = state.generation;
    drop(state);
    publish(app)?;
    hide_if_current(app, generation);
    Ok(())
}

pub fn pulse<R: Runtime>(
    app: &AppHandle<R>,
    pointer: Option<PointerPosition>,
    activity_id: Option<&str>,
) -> Result<(), String> {
    let runtime = app
        .try_state::<ComputerUseGlowRuntime>()
        .ok_or_else(|| "Computer-use glow runtime is not initialized".to_string())?;
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| "Computer-use glow runtime is poisoned".to_string())?;
    if !state.accepts_pulse(activity_id) {
        return Ok(());
    }
    if let (Some(id), Some(pointer)) = (activity_id, pointer) {
        if let Some(activity) = state.active_tasks.get_mut(id) {
            activity.pointer = Some(pointer);
        }
    }
    state.generation = state.generation.wrapping_add(1);
    drop(state);

    let task_app = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = show_current(&task_app) {
            warn!("Failed to display computer-use feedback: {error}");
        }
    })
    .map_err(|error| error.to_string())
}

fn show_current<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    {
        let runtime = app.state::<ComputerUseGlowRuntime>();
        let state = runtime
            .state
            .lock()
            .map_err(|_| "Computer-use glow runtime is poisoned")?;
        if state.can_hide(state.generation) {
            return Ok(());
        }
    }
    let window = ensure_window(app)?;

    let show_result = (|| -> Result<(), String> {
        let bounds = current_screen_bounds(app)?;
        window
            .set_position(Position::Physical(PhysicalPosition::new(
                bounds.x, bounds.y,
            )))
            .map_err(|error| format!("Failed to position the computer-use glow: {error}"))?;
        window
            .set_size(Size::Physical(PhysicalSize::new(
                bounds.width,
                bounds.height,
            )))
            .map_err(|error| format!("Failed to size the computer-use glow: {error}"))?;
        window.set_ignore_cursor_events(true).map_err(|error| {
            format!("Failed to keep the computer-use glow click-through: {error}")
        })?;
        let feedback = snapshot(app)?;
        if feedback.activities.is_empty() {
            return set_visible(&window, false);
        }
        set_visible(&window, true)?;
        let _ = window.set_content_protected(true);
        app.emit_to(WINDOW_LABEL, PULSE_EVENT, feedback)
            .map_err(|error| format!("Failed to restart the computer-use glow: {error}"))?;
        Ok(())
    })();

    if let Err(error) = show_result {
        let _ = set_visible(&window, false);
        return Err(error);
    }

    Ok(())
}

fn payload(
    state: &GlowState,
    bounds: ScreenRect,
    scale: f64,
    banner: Option<PointerPosition>,
) -> PulsePayload {
    PulsePayload {
        generation: state.generation,
        activities: state.pointers(bounds, scale),
        banner,
        locale: if state.locale.is_empty() {
            "en-US".into()
        } else {
            state.locale.clone()
        },
    }
}

pub fn snapshot<R: Runtime>(app: &AppHandle<R>) -> Result<PulsePayload, String> {
    let bounds = current_screen_bounds(app)?;
    let scale = app
        .get_webview_window(WINDOW_LABEL)
        .and_then(|window| window.scale_factor().ok())
        .unwrap_or(1.0);
    let banner = app
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .and_then(|monitor| {
            local_pointer(
                PointerPosition {
                    x: f64::from(monitor.position().x) + f64::from(monitor.size().width) / 2.0,
                    y: f64::from(monitor.position().y),
                },
                bounds,
                scale,
            )
        });
    let runtime = app.state::<ComputerUseGlowRuntime>();
    let state = runtime
        .state
        .lock()
        .map_err(|_| "Computer-use glow runtime is poisoned")?;
    Ok(payload(&state, bounds, scale, banner))
}

fn publish<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    app.emit_to(WINDOW_LABEL, PULSE_EVENT, snapshot(app)?)
        .map_err(|error| error.to_string())
}

pub fn cancellation<R: Runtime>(
    app: &AppHandle<R>,
    activity_id: &str,
) -> Result<tokio::sync::watch::Receiver<bool>, String> {
    let runtime = app.state::<ComputerUseGlowRuntime>();
    let state = runtime
        .state
        .lock()
        .map_err(|_| "Computer-use glow runtime is poisoned")?;
    state
        .active_tasks
        .get(activity_id)
        .map(|activity| activity.cancellation.subscribe())
        .ok_or_else(|| "computer use cancelled".into())
}

pub fn stop_all<R: Runtime>(app: &AppHandle<R>) -> Result<usize, String> {
    let (activities, generation) = {
        let runtime = app.state::<ComputerUseGlowRuntime>();
        let mut state = runtime
            .state
            .lock()
            .map_err(|_| "Computer-use glow runtime is poisoned")?;
        let activities: Vec<String> = state
            .active_tasks
            .drain()
            .map(|(id, activity)| {
                activity.cancellation.send_replace(true);
                id
            })
            .collect();
        state.generation = state.generation.wrapping_add(1);
        (activities, state.generation)
    };
    let count = crate::core::computer_use::driver::cancel_all()
        + crate::core::computer_use::agent_desktop::cancel_all();
    let released = activities.clone();
    tauri::async_runtime::spawn(async move {
        for activity_id in released {
            crate::core::computer_use::driver::end_activity(&activity_id);
            if let Err(error) =
                crate::core::computer_use::agent_desktop::end_activity(&activity_id).await
            {
                warn!("Failed to release stopped desktop session: {error}");
            }
        }
    });
    publish(app)?;
    hide_if_current(app, generation);
    if !activities.is_empty() {
        app.emit("computer-use-stopped", &activities)
            .map_err(|error| error.to_string())?;
    }
    Ok(count)
}

fn hide_if_current<R: Runtime>(app: &AppHandle<R>, generation: u64) {
    let task_app = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let Some(runtime) = task_app.try_state::<ComputerUseGlowRuntime>() else {
            return;
        };
        let Ok(state) = runtime.state.lock() else {
            return;
        };
        if !state.can_hide(generation) {
            return;
        }
        drop(state);
        if let Err(error) = stop_shortcut::uninstall(&task_app) {
            warn!("Failed to release computer-use stop shortcut: {error}");
        }

        if let Some(window) = task_app.get_webview_window(WINDOW_LABEL) {
            if let Err(error) = set_visible(&window, false) {
                warn!("Failed to hide computer-use feedback: {error}");
            }
        }
    }) {
        warn!("Failed to queue computer-use feedback cleanup: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::{local_pointer, union_screen_bounds, GlowState, PointerPosition, ScreenRect};

    #[test]
    fn user_given_a_registered_task_when_waiting_for_foreground_input_then_feedback_stays_hidden() {
        let mut state = GlowState::default();
        state.begin("waiting").expect("registered task");
        let cancelled = state.active_tasks["waiting"].cancellation.subscribe();
        assert!(state.can_hide(state.generation));
        assert!(state.pointers(rect(0, 0, 1920, 1080), 1.0).is_empty());
        assert!(!state.accepts_pulse(Some("waiting")));
        assert!(!*cancelled.borrow());
    }

    #[test]
    fn user_given_no_foreground_operation_when_an_unscoped_pointer_arrives_then_feedback_stays_hidden(
    ) {
        assert!(!GlowState::default().accepts_pulse(None));
    }

    #[test]
    fn user_given_two_sessions_when_one_finishes_then_keeps_the_other_position_and_identity() {
        let mut state = GlowState::default();
        state.begin("one").expect("one");
        state.begin("two").expect("two");
        state.begin_foreground("one").expect("first operation");
        state.begin_foreground("two").expect("second operation");
        state.active_tasks.get_mut("one").expect("one").pointer =
            Some(PointerPosition { x: 10.0, y: 20.0 });
        state.active_tasks.get_mut("two").expect("two").pointer =
            Some(PointerPosition { x: 30.0, y: 40.0 });
        let cancelled = state.active_tasks["one"].cancellation.subscribe();
        let remaining = state.active_tasks["two"].cancellation.subscribe();
        assert_eq!(state.pointers(rect(0, 0, 1920, 1080), 1.0).len(), 2);
        state.finish("one");
        let pointers = state.pointers(rect(0, 0, 1920, 1080), 1.0);
        assert_eq!(pointers.len(), 1);
        assert_eq!(pointers[0].id, "two");
        assert_eq!(pointers[0].ordinal, 2);
        assert_eq!(
            pointers[0].pointer,
            Some(PointerPosition { x: 30.0, y: 40.0 })
        );
        assert!(*cancelled.borrow());
        assert!(!*remaining.borrow());
    }

    #[test]
    fn user_given_overlapping_foreground_operations_when_one_finishes_then_keeps_the_other_visible()
    {
        let mut state = GlowState::default();
        state.begin("first").expect("first");
        state.begin("second").expect("second");
        state.begin_foreground("first").expect("first operation");
        state.begin_foreground("second").expect("second operation");
        assert!(!state.can_hide(state.generation));
        state.end_foreground("first");
        assert!(!state.can_hide(state.generation));
        state.end_foreground("second");
        assert!(state.can_hide(state.generation));
        assert!(state.pointers(rect(0, 0, 1920, 1080), 1.0).is_empty());
    }

    #[test]
    fn user_given_a_finished_task_when_a_late_pointer_arrives_then_cannot_reopen_the_glow() {
        let mut state = GlowState::default();
        state.begin("current").expect("current");
        state.begin_foreground("current").expect("operation");
        assert!(state.accepts_pulse(Some("current")));
        assert!(!state.accepts_pulse(Some("finished")));
        state.finish("current");
        assert!(!state.accepts_pulse(Some("current")));
    }

    #[test]
    fn user_given_completed_foreground_input_when_the_next_action_runs_then_keeps_the_same_uncancelled_session(
    ) {
        let mut state = GlowState::default();
        state.begin("task").expect("task");
        let cancelled = state.active_tasks["task"].cancellation.subscribe();
        state.begin_foreground("task").expect("first input");
        state.active_tasks.get_mut("task").expect("task").pointer =
            Some(PointerPosition { x: 20.0, y: 30.0 });
        state.end_foreground("task");
        assert!(state.can_hide(state.generation));
        assert!(!state.accepts_pulse(Some("task")));
        assert!(!*cancelled.borrow());
        state.begin_foreground("task").expect("second input");
        let visible = state.pointers(rect(0, 0, 1920, 1080), 1.0);
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].id, "task");
        assert_eq!(visible[0].ordinal, 1);
        assert_eq!(visible[0].pointer, None);
        state.finish("task");
        assert!(*cancelled.borrow());
        assert!(state.can_hide(state.generation));
        assert!(state.begin_foreground("task").is_err());
    }

    #[test]
    fn user_given_overlapping_input_in_one_task_when_one_call_returns_then_feedback_waits_for_the_last_call(
    ) {
        let mut state = GlowState::default();
        state.begin("task").expect("task");
        state.begin_foreground("task").expect("first");
        state.begin_foreground("task").expect("second");
        state.end_foreground("task");
        assert!(!state.can_hide(state.generation));
        state.end_foreground("task");
        assert!(state.can_hide(state.generation));
    }

    #[test]
    fn user_sees_the_pointer_at_the_action_on_a_scaled_negative_origin_desktop() {
        assert_eq!(
            local_pointer(
                PointerPosition {
                    x: -200.0,
                    y: 300.0
                },
                rect(-1280, 0, 3200, 1080),
                1.5
            ),
            Some(PointerPosition { x: 720.0, y: 200.0 })
        );
    }

    #[test]
    fn user_does_not_see_a_pointer_outside_the_desktop_or_with_invalid_coordinates() {
        for pointer in [
            PointerPosition { x: -1.0, y: 20.0 },
            PointerPosition {
                x: f64::NAN,
                y: 20.0,
            },
            PointerPosition { x: 1920.0, y: 20.0 },
        ] {
            assert_eq!(local_pointer(pointer, rect(0, 0, 1920, 1080), 1.0), None);
        }
    }

    fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn user_gets_the_monitor_bounds_for_a_single_screen() {
        assert_eq!(
            union_screen_bounds([rect(0, 0, 1920, 1080)]),
            Some(rect(0, 0, 1920, 1080))
        );
    }

    #[test]
    fn user_gets_the_virtual_desktop_when_a_monitor_is_left_of_the_primary_screen() {
        assert_eq!(
            union_screen_bounds([rect(0, 0, 1920, 1080), rect(-1280, 0, 1280, 1024)]),
            Some(rect(-1280, 0, 3200, 1080))
        );
    }

    #[test]
    fn user_gets_the_virtual_desktop_when_monitors_have_different_heights() {
        assert_eq!(
            union_screen_bounds([rect(0, 0, 1920, 1080), rect(1920, 200, 2560, 1440)]),
            Some(rect(0, 0, 4480, 1640))
        );
    }

    #[test]
    fn user_gets_no_glow_bounds_when_no_monitor_has_an_area() {
        assert_eq!(union_screen_bounds([rect(10, 20, 0, 100)]), None);
    }
}
