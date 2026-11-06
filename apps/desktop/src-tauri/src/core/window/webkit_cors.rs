// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

//! WebKitGTK custom scheme compatibility for window content.
//!
//! WebKitGTK 2.46 and newer only serve requests to a registered custom URI
//! scheme through its protocol handler when the scheme is registered as
//! CORS-enabled. Tauri registers the app, IPC and asset schemes as secure but,
//! as of wry 0.57, not as CORS-enabled. The renderer therefore sees the whole
//! `asset://` URL and the raw `ipc://` response path as network failures on
//! Linux: bundled fonts fall back to a system serif and large binary IPC such
//! as `readFile` fails.
//!
//! The upstream fix (tauri-apps/wry#1725) registers the schemes as CORS-enabled
//! next to the secure registration. Until it ships, do the same through the
//! security manager of the context the Tauri window already uses. The call is
//! a no-op on older WebKitGTK releases, so it is safe on every supported
//! distribution.

use tauri::{Runtime, WebviewWindow};

const TAURI_CUSTOM_SCHEMES: [&str; 3] = ["tauri", "ipc", "asset"];

pub(crate) fn allow_custom_scheme_requests<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    use webkit2gtk::{SecurityManagerExt, WebContextExt, WebViewExt};

    window
        .with_webview(|webview| {
            let result: Result<(), String> = (|| {
                let context = webview
                    .inner()
                    .context()
                    .ok_or_else(|| "WebKitGTK did not expose a web context".to_string())?;
                let security_manager = context
                    .security_manager()
                    .ok_or_else(|| "WebKitGTK did not expose a security manager".to_string())?;

                for scheme in TAURI_CUSTOM_SCHEMES {
                    security_manager.register_uri_scheme_as_cors_enabled(scheme);
                }

                Ok(())
            })();

            if let Err(error) = result {
                log::warn!(
                    "Failed to register WebKitGTK custom schemes as CORS-enabled: {}",
                    error
                );
            }
        })
        .map_err(|error| format!("Failed to access the WebKitGTK webview: {error}"))
}
