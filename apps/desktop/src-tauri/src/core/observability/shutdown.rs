// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 退出前的最后一次刷盘。
//!
//! 托盘退出和更新重启都直接调用 `AppHandle::exit`，不会触发窗口的
//! `onCloseRequested`，前端队列里最多 1000 条日志会随 WebView 一起消失。
//! 这里在 `RunEvent::ExitRequested` 上截一次退出：通知前端刷队列，收到确认
//! 或等待超时后再真正退出。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Runtime};

/// 前端监听该事件后刷队列，再调用 `obs_flush_done` 回报。
pub const FLUSH_EVENT: &str = "obs://flush";

/// 等待前端确认的上限：后端卡住时也不能让应用退不掉。
const MAX_WAIT: Duration = Duration::from_millis(800);

static STARTED: AtomicBool = AtomicBool::new(false);
static GATE: OnceLock<(Mutex<bool>, Condvar)> = OnceLock::new();

fn gate() -> &'static (Mutex<bool>, Condvar) {
    GATE.get_or_init(|| (Mutex::new(false), Condvar::new()))
}

/// 第一次退出请求返回 `true`：调用方应当 `prevent_exit`，刷盘后由本模块重新退出。
pub fn begin<R: Runtime>(app: &AppHandle<R>) -> bool {
    if STARTED.swap(true, Ordering::SeqCst) {
        return false;
    }

    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = app.emit(FLUSH_EVENT, ()) {
            log::warn!(target: "obs", "obs.shutdown.flush_emit_failed error={error}");
        }
        wait_for_flush(MAX_WAIT);
        app.exit(0);
    });

    true
}

/// 前端刷完队列后回报，让等待方立即退出。
pub fn mark_flushed() {
    let (lock, ready) = gate();
    *lock.lock().unwrap_or_else(|error| error.into_inner()) = true;
    ready.notify_all();
}

fn wait_for_flush(max_wait: Duration) {
    let (lock, ready) = gate();
    let mut done = lock.lock().unwrap_or_else(|error| error.into_inner());
    let deadline = Instant::now() + max_wait;

    while !*done {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        done = ready
            .wait_timeout(done, remaining)
            .map(|(guard, _)| guard)
            .unwrap_or_else(|error| error.into_inner().0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn user_does_not_wait_the_full_timeout_once_the_frontend_confirms() {
        thread::spawn(|| {
            thread::sleep(Duration::from_millis(20));
            mark_flushed();
        });

        let started = Instant::now();
        wait_for_flush(Duration::from_secs(5));

        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
