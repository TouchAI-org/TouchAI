// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

//! Keeps the main search window renderable while it is logically hidden.
//!
//! A hidden AppKit window leaves the window server, and WebKit then throttles
//! `requestAnimationFrame`, timers and compositing. Showing it again has to
//! rebuild that pipeline before the first useful frame, which is what makes a
//! launcher feel slow after a long idle period.
//!
//! Raycast avoids that by never ordering the launcher out: the window stays in
//! the window server with `alphaValue = 0` and mouse events ignored, while
//! WebKit's occlusion detection is disabled. The renderer therefore stays warm
//! and a show only flips alpha back to one. This module implements the same
//! model for the search window on macOS.
//!
//! Windows keeps the existing hide/show path for now: its transparent host is
//! work-area sized and hosts a WebView2 child HWND, so the alpha-zero park needs
//! a separately validated mechanism (layered windows and WebView2 do not compose
//! reliably together). Chromium's own throttling is disabled there through the
//! WebView2 browser arguments instead. The public helpers still route through
//! this module so the platform split stays in one place.

use tauri::{Runtime, WebviewWindow};

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "macos")]
static LOGICALLY_VISIBLE: AtomicBool = AtomicBool::new(false);

/// Prepare the main window for warm parking and keep WebKit compositing while
/// the window is logically hidden. Safe to call once during setup.
pub(crate) fn install<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if window.label() != "main" {
            return Ok(());
        }
        park(window)?;
        window
            .with_webview(|webview| {
                let webview = webview.inner().cast::<objc2::runtime::AnyObject>();
                if webview.is_null() {
                    return;
                }
                unsafe {
                    // Private WKWebView API. A future WebKit can remove it, and
                    // sending an unknown selector would abort the process, so the
                    // guard is part of the call rather than a nicety.
                    let responds: objc2::runtime::Bool = objc2::msg_send![
                        webview,
                        respondsToSelector: objc2::sel!(_setWindowOcclusionDetectionEnabled:)
                    ];
                    if responds.as_bool() {
                        let _: () = objc2::msg_send![
                            webview,
                            _setWindowOcclusionDetectionEnabled: objc2::runtime::Bool::NO
                        ];
                    }
                }
            })
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
    }
    Ok(())
}

/// Reveal the main window without rebuilding the WebView pipeline.
pub(crate) fn show<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if window.label() == "main" {
            if let Ok(ns_window) = ns_window(window) {
                // Let Tauri update its own visible state, then make the parked
                // window opaque and interactive again on the same run loop turn.
                window.show().map_err(|error| error.to_string())?;
                unsafe {
                    let _: () = objc2::msg_send![
                        ns_window,
                        setIgnoresMouseEvents: objc2::runtime::Bool::NO
                    ];
                    let _: () = objc2::msg_send![ns_window, setAlphaValue: 1.0f64];
                }
                LOGICALLY_VISIBLE.store(true, Ordering::SeqCst);
                return Ok(());
            }
            log::warn!("Search window has no NSWindow; falling back to native show");
            window.show().map_err(|error| error.to_string())?;
            LOGICALLY_VISIBLE.store(true, Ordering::SeqCst);
            return Ok(());
        }
    }
    window.show().map_err(|error| error.to_string())
}

/// Hide the main window while keeping its renderer alive.
pub(crate) fn hide<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if window.label() == "main" {
            if let Err(error) = park(window) {
                log::warn!("Failed to park search window, hiding it natively: {error}");
                window.hide().map_err(|error| error.to_string())?;
                LOGICALLY_VISIBLE.store(false, Ordering::SeqCst);
            }
            return Ok(());
        }
    }
    window.hide().map_err(|error| error.to_string())
}

/// Logical visibility of the main window. On macOS the native window remains
/// ordered after the first show, so `WebviewWindow::is_visible` can no longer
/// answer this question.
pub(crate) fn is_visible<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    #[cfg(target_os = "macos")]
    {
        if window.label() == "main" {
            return LOGICALLY_VISIBLE.load(Ordering::SeqCst);
        }
    }
    window.is_visible().unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn park<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let ns_window = ns_window(window)?;
    unsafe {
        let _: () = objc2::msg_send![ns_window, setAlphaValue: 0.0f64];
        let _: () = objc2::msg_send![
            ns_window,
            setIgnoresMouseEvents: objc2::runtime::Bool::YES
        ];
        // The parked window must not keep keyboard focus or the previously
        // active app would stay inactive behind a window nobody can see.
        yield_activation_if_key(ns_window);
        // Keep the window in the window server without activating the app.
        // This is the state WebKit must keep seeing.
        let _: () = objc2::msg_send![ns_window, orderFrontRegardless];
    }
    LOGICALLY_VISIBLE.store(false, Ordering::SeqCst);
    Ok(())
}

#[cfg(target_os = "macos")]
unsafe fn yield_activation_if_key(ns_window: *mut objc2::runtime::AnyObject) {
    let is_key: objc2::runtime::Bool = objc2::msg_send![ns_window, isKeyWindow];
    if !is_key.as_bool() {
        return;
    }
    let application: *mut objc2::runtime::AnyObject =
        objc2::msg_send![objc2::class!(NSApplication), sharedApplication];
    if application.is_null() {
        return;
    }
    let _: () = objc2::msg_send![application, deactivate];
}

#[cfg(target_os = "macos")]
fn ns_window<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<*mut objc2::runtime::AnyObject, String> {
    let ns_window = window.ns_window().map_err(|error| error.to_string())?;
    if ns_window.is_null() {
        return Err("Search window has no NSWindow".to_string());
    }
    Ok(ns_window.cast())
}
