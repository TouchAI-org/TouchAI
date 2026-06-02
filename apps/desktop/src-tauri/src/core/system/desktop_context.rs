// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

//! Read-only desktop context capsules captured at TouchAI invocation time.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::core::system::clipboard::{ClipboardPayload, ClipboardRuntime};

const CLIPBOARD_SUMMARY_LIMIT: usize = 500;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContextCapability {
    pub id: String,
    pub supported: bool,
    pub method: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContextBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContextActiveWindow {
    pub title: Option<String>,
    pub app_name: Option<String>,
    pub process_name: Option<String>,
    pub process_id: Option<u32>,
    pub window_handle: Option<String>,
    pub bounds: Option<DesktopContextBounds>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContextSelectedText {
    pub available: bool,
    pub source: Option<String>,
    pub text: Option<String>,
    pub text_length: usize,
    pub truncated: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContextClipboard {
    pub available: bool,
    pub snapshot_id: Option<String>,
    pub observed_at: Option<u64>,
    pub text: Option<String>,
    pub text_summary: Option<String>,
    pub text_length: usize,
    pub image_count: usize,
    pub file_count: usize,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContextScreenshot {
    pub available: bool,
    pub path: Option<String>,
    pub mime_type: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub target: String,
    pub persisted: bool,
    pub captured_at: Option<String>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContextRedaction {
    pub field: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContextCapsule {
    pub id: String,
    pub sequence: u64,
    pub captured_at: String,
    pub invocation_source: String,
    pub platform: String,
    pub summary: String,
    pub active_window: Option<DesktopContextActiveWindow>,
    pub selected_text: DesktopContextSelectedText,
    pub clipboard: DesktopContextClipboard,
    pub screenshot: DesktopContextScreenshot,
    pub capabilities: Vec<DesktopContextCapability>,
    pub redactions: Vec<DesktopContextRedaction>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundDesktopContext {
    #[serde(flatten)]
    pub capsule: DesktopContextCapsule,
    pub bound_at: String,
}

#[derive(Default)]
pub struct DesktopContextRuntime {
    next_sequence: AtomicU64,
    capsules: Mutex<HashMap<String, DesktopContextCapsule>>,
}

impl DesktopContextRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn capture_invocation<R: Runtime>(
        &self,
        app_handle: &AppHandle<R>,
        source: &'static str,
    ) -> Result<DesktopContextCapsule, String> {
        let sequence = self.next_sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let captured_at = now_rfc3339_millis();
        let active_window = capture_active_window();
        let clipboard = capture_clipboard(app_handle);
        let selected_text = unsupported_selected_text();
        let screenshot = unsupported_screenshot(&captured_at);
        let capabilities = build_capabilities(&active_window, &clipboard, &screenshot);
        let redactions = vec![DesktopContextRedaction {
            field: "clipboard.fullText".to_string(),
            reason: "Only returned when the model explicitly asks for clipboard.full_text."
                .to_string(),
        }];
        let summary = build_summary(
            active_window.as_ref(),
            &selected_text,
            &clipboard,
            &screenshot,
        );

        let capsule = DesktopContextCapsule {
            id: format!("desktop-context-{sequence}"),
            sequence,
            captured_at,
            invocation_source: source.to_string(),
            platform: std::env::consts::OS.to_string(),
            summary,
            active_window,
            selected_text,
            clipboard,
            screenshot,
            capabilities,
            redactions,
        };

        let mut capsules = self
            .capsules
            .lock()
            .map_err(|error| format!("Desktop context state is poisoned: {error}"))?;
        capsules.insert(capsule.id.clone(), capsule.clone());
        Ok(capsule)
    }

    pub fn get_capsule(&self, capsule_id: &str) -> Result<Option<DesktopContextCapsule>, String> {
        let capsules = self
            .capsules
            .lock()
            .map_err(|error| format!("Desktop context state is poisoned: {error}"))?;
        Ok(capsules.get(capsule_id).cloned())
    }

    pub fn bind_capsule(&self, capsule_id: &str) -> Result<Option<BoundDesktopContext>, String> {
        Ok(self
            .get_capsule(capsule_id)?
            .map(|capsule| BoundDesktopContext {
                capsule,
                bound_at: now_rfc3339_millis(),
            }))
    }
}

fn clipboard_from_payload(payload: ClipboardPayload) -> DesktopContextClipboard {
    let text = payload.text;
    let text_length = text
        .as_ref()
        .map(|value| value.chars().count())
        .unwrap_or(0);
    let text_summary = text
        .as_ref()
        .map(|value| value.chars().take(CLIPBOARD_SUMMARY_LIMIT).collect());

    DesktopContextClipboard {
        available: true,
        snapshot_id: Some(payload.snapshot_id),
        observed_at: Some(payload.observed_at),
        text,
        text_summary,
        text_length,
        image_count: payload.image_paths.len(),
        file_count: payload.file_paths.len(),
        reason: None,
    }
}

fn capture_clipboard<R: Runtime>(app_handle: &AppHandle<R>) -> DesktopContextClipboard {
    let Some(runtime) = app_handle.try_state::<ClipboardRuntime>() else {
        return DesktopContextClipboard {
            available: false,
            snapshot_id: None,
            observed_at: None,
            text: None,
            text_summary: None,
            text_length: 0,
            image_count: 0,
            file_count: 0,
            reason: Some("Clipboard runtime is not initialized.".to_string()),
        };
    };

    match runtime.read_clipboard_payload() {
        Ok(Some(payload)) => clipboard_from_payload(payload),
        Ok(None) => DesktopContextClipboard {
            available: false,
            snapshot_id: None,
            observed_at: None,
            text: None,
            text_summary: None,
            text_length: 0,
            image_count: 0,
            file_count: 0,
            reason: Some("Clipboard is empty or unsupported.".to_string()),
        },
        Err(error) => DesktopContextClipboard {
            available: false,
            snapshot_id: None,
            observed_at: None,
            text: None,
            text_summary: None,
            text_length: 0,
            image_count: 0,
            file_count: 0,
            reason: Some(error),
        },
    }
}

fn unsupported_selected_text() -> DesktopContextSelectedText {
    DesktopContextSelectedText {
        available: false,
        source: None,
        text: None,
        text_length: 0,
        truncated: false,
        reason: Some(
            "Native selected-text extraction is not enabled in this first desktop-context slice."
                .to_string(),
        ),
    }
}

fn unsupported_screenshot(captured_at: &str) -> DesktopContextScreenshot {
    DesktopContextScreenshot {
        available: false,
        path: None,
        mime_type: None,
        width: None,
        height: None,
        target: "active_display".to_string(),
        persisted: false,
        captured_at: Some(captured_at.to_string()),
        reason: Some(
            "Native screenshot persistence is reserved for the follow-up capture backend."
                .to_string(),
        ),
    }
}

fn build_capabilities(
    active_window: &Option<DesktopContextActiveWindow>,
    clipboard: &DesktopContextClipboard,
    screenshot: &DesktopContextScreenshot,
) -> Vec<DesktopContextCapability> {
    vec![
        DesktopContextCapability {
            id: "active_window".to_string(),
            supported: active_window.is_some(),
            method: if cfg!(target_os = "windows") {
                "win32-foreground-window"
            } else {
                "unsupported-platform"
            }
            .to_string(),
            reason: active_window
                .is_none()
                .then(|| "Foreground window metadata is only implemented on Windows.".to_string()),
        },
        DesktopContextCapability {
            id: "clipboard".to_string(),
            supported: clipboard.available,
            method: "clipboard-runtime-snapshot".to_string(),
            reason: clipboard.reason.clone(),
        },
        DesktopContextCapability {
            id: "selected_text".to_string(),
            supported: false,
            method: "pending-native-backend".to_string(),
            reason: Some(
                "Selected-text extraction requires a dedicated native backend.".to_string(),
            ),
        },
        DesktopContextCapability {
            id: "screenshot".to_string(),
            supported: screenshot.available,
            method: "pending-capture-backend".to_string(),
            reason: screenshot.reason.clone(),
        },
    ]
}

fn build_summary(
    active_window: Option<&DesktopContextActiveWindow>,
    selected_text: &DesktopContextSelectedText,
    clipboard: &DesktopContextClipboard,
    screenshot: &DesktopContextScreenshot,
) -> String {
    let mut parts = Vec::new();
    if let Some(title) = active_window.and_then(|window| window.title.as_deref()) {
        if !title.trim().is_empty() {
            parts.push(format!("Active window: {title}"));
        }
    }
    if selected_text.available {
        parts.push(format!(
            "Selected text length: {}",
            selected_text.text_length
        ));
    }
    if clipboard.available {
        parts.push(format!(
            "Clipboard: {} chars, {} images, {} files",
            clipboard.text_length, clipboard.image_count, clipboard.file_count
        ));
    }
    if screenshot.available {
        parts.push("Screenshot persisted".to_string());
    }

    if parts.is_empty() {
        "Desktop context capsule captured with no supported desktop signals.".to_string()
    } else {
        parts.join("; ")
    }
}

fn now_rfc3339_millis() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

#[cfg(target_os = "windows")]
fn capture_active_window() -> Option<DesktopContextActiveWindow> {
    use windows::Win32::{
        Foundation::RECT,
        UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId,
        },
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }

        let mut title_buffer = [0u16; 512];
        let title_len = GetWindowTextW(hwnd, &mut title_buffer);
        let title = (title_len > 0).then(|| {
            String::from_utf16_lossy(&title_buffer[..title_len as usize])
                .trim()
                .to_string()
        });

        let mut process_id = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));

        let mut rect = RECT::default();
        let bounds = GetWindowRect(hwnd, &mut rect)
            .ok()
            .map(|_| DesktopContextBounds {
                x: rect.left,
                y: rect.top,
                width: rect.right.saturating_sub(rect.left),
                height: rect.bottom.saturating_sub(rect.top),
            });

        Some(DesktopContextActiveWindow {
            title,
            app_name: None,
            process_name: None,
            process_id: (process_id > 0).then_some(process_id),
            window_handle: Some(format!("0x{:x}", hwnd.0 as usize)),
            bounds,
        })
    }
}

#[cfg(not(target_os = "windows"))]
fn capture_active_window() -> Option<DesktopContextActiveWindow> {
    None
}
