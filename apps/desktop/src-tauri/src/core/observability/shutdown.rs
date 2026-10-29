// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 退出前的最后一次刷盘。
//!
//! 托盘退出和更新重启都直接调用 `AppHandle::exit`，不会触发窗口的
//! `onCloseRequested`，前端队列里最多 1000 条日志会随 WebView 一起消失。
//! 这里在 `RunEvent::ExitRequested` 上截一次退出：通知每个窗口刷队列，
//! 全部确认（或等待超时）后再用同一个退出码真正退出。

use std::collections::HashSet;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, Runtime};

/// 前端监听该事件后刷队列，再调用 `obs_flush_done` 回报。
pub const FLUSH_EVENT: &str = "obs://flush";

/// 等待前端确认的上限：后端卡住时也不能让应用退不掉。
const MAX_WAIT: Duration = Duration::from_millis(800);

/// 已经有一个窗口确认后，给其余窗口的宽限。
///
/// 只注册了一半窗口（例如刚创建还没初始化）时，不应该让退出整整等满上限。
const SETTLE: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle,
    /// 已通知前端，等待确认。
    Flushing,
    /// 刷盘结束，正在发起真正退出。
    Exiting,
}

struct State {
    phase: Phase,
    pending: HashSet<String>,
    first_ack_at: Option<Instant>,
}

static GATE: OnceLock<(Mutex<State>, Condvar)> = OnceLock::new();

fn gate() -> &'static (Mutex<State>, Condvar) {
    GATE.get_or_init(|| {
        (
            Mutex::new(State {
                phase: Phase::Idle,
                pending: HashSet::new(),
                first_ack_at: None,
            }),
            Condvar::new(),
        )
    })
}

fn lock() -> std::sync::MutexGuard<'static, State> {
    gate().0.lock().unwrap_or_else(|error| error.into_inner())
}

/// 第一次退出请求返回 `true`：调用方应当 `prevent_exit`，刷盘后由本模块重新退出。
///
/// 刷盘期间的重复退出请求同样返回 `true`，否则第二次点击托盘“退出”会直接
/// 结束进程，把还没落盘的日志丢掉。只有本模块发起的退出才放行。
pub fn begin<R: Runtime>(app: &AppHandle<R>, code: i32) -> bool {
    {
        let mut state = lock();
        match state.phase {
            Phase::Idle => {
                state.phase = Phase::Flushing;
                state.pending = app.webview_windows().keys().cloned().collect();
                state.first_ack_at = None;
            }
            Phase::Flushing => return true,
            Phase::Exiting => return false,
        }
    }

    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = app.emit(FLUSH_EVENT, ()) {
            log::warn!(target: "obs", "obs.shutdown.flush_emit_failed error={error}");
        }
        wait_for_flush(MAX_WAIT, SETTLE);
        lock().phase = Phase::Exiting;
        app.exit(code);
    });

    true
}

/// 窗口刷完队列后回报，全部确认后等待方立即退出。
pub fn mark_flushed(window: &str) {
    let mut state = lock();
    // 未知标签（重复回报、已经销毁的窗口）不能开启宽限期，否则还在写盘的窗口
    // 会被提前切断。
    if !state.pending.remove(window) {
        return;
    }
    if state.first_ack_at.is_none() {
        state.first_ack_at = Some(Instant::now());
    }
    gate().1.notify_all();
}

fn wait_for_flush(max_wait: Duration, settle: Duration) {
    let deadline = Instant::now() + max_wait;
    let mut state = lock();

    while !state.pending.is_empty() {
        let mut until = deadline;
        if let Some(first_ack) = state.first_ack_at {
            until = until.min(first_ack + settle);
        }
        let remaining = until.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        state = gate()
            .1
            .wait_timeout(state, remaining)
            .map(|(guard, _)| guard)
            .unwrap_or_else(|error| error.into_inner().0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use std::thread;

    /// 两个用例共用同一个全局闸门，必须串行执行。
    static TEST_LOCK: StdMutex<()> = StdMutex::new(());

    fn reset(pending: &[&str]) {
        let mut state = lock();
        state.phase = Phase::Idle;
        state.pending = pending.iter().map(|label| (*label).to_string()).collect();
        state.first_ack_at = None;
    }

    #[test]
    fn user_does_not_wait_for_the_full_timeout_once_every_window_confirms() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        reset(&["main", "settings"]);
        thread::spawn(|| {
            thread::sleep(Duration::from_millis(20));
            mark_flushed("main");
            mark_flushed("settings");
        });

        let started = Instant::now();
        wait_for_flush(Duration::from_secs(5), Duration::from_secs(5));

        assert!(started.elapsed() < Duration::from_secs(1));
        reset(&[]);
    }

    #[test]
    fn user_does_not_wait_for_a_window_that_never_answers() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        reset(&["main", "popup"]);
        thread::spawn(|| {
            thread::sleep(Duration::from_millis(20));
            mark_flushed("main");
        });

        let started = Instant::now();
        wait_for_flush(Duration::from_secs(5), Duration::from_millis(100));

        assert!(started.elapsed() < Duration::from_secs(1));
        reset(&[]);
    }

    #[test]
    fn user_keeps_the_full_wait_when_an_unknown_window_reports_back() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        reset(&["main"]);
        mark_flushed("ghost");

        let started = Instant::now();
        wait_for_flush(Duration::from_millis(150), Duration::from_millis(10));

        assert!(started.elapsed() >= Duration::from_millis(100));
        reset(&[]);
    }
}
