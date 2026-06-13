// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

//! Read-only desktop context capsules captured at TouchAI invocation time.

use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    thread,
    time::Duration,
};

use image::{imageops, RgbaImage};
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use xcap::{Monitor, Window};

use crate::core::system::{
    clipboard::{ClipboardPayload, ClipboardRuntime},
    paths::{app_directory_path, AppDirectory},
};

const CLIPBOARD_SUMMARY_LIMIT: usize = 500;
const SELECTED_TEXT_LIMIT: usize = 20_000;
const DOCUMENT_TEXT_LIMIT: usize = 50_000;
const MAX_RETAINED_CAPSULES: usize = 32;
const UIA_TEXT_PATTERN_DESCENDANT_LIMIT: i32 = 500;
const NATIVE_TEXT_BUFFER_LIMIT: usize = 1_000_000;
const SENSITIVE_ACCESS_REQUIRES_APPROVAL: &str =
    "Requires user approval before reading this desktop context signal.";
const SELECTED_TEXT_PENDING_ASYNC: &str =
    "Selected text capture is still running asynchronously after surface display.";

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
    // 活动窗口为浏览器时，后台 enrich 阶段用 UIA ValuePattern 读取的地址栏 URL。
    // 仅在 capture_browser_url 开关开启且识别为浏览器时填充。
    pub browser_url: Option<String>,
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
pub struct DesktopContextDocument {
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
    // 剪贴板图片/文件的本地路径，仅在用户批准 clipboard.* 后随 capture_sensitive 透出。
    pub image_paths: Vec<String>,
    pub file_paths: Vec<String>,
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
    // 仅在 enable_screenshot_ocr 开启且 OCR 成功时填充，让非视觉模型也能用屏幕文字。
    pub ocr_text: Option<String>,
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
    // 活动文档全文，仅在用户批准 document.full_text 后由 capture_sensitive 读取。
    pub document: DesktopContextDocument,
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

pub struct DesktopContextRuntime {
    next_sequence: AtomicU64,
    capsules: Mutex<HashMap<String, DesktopContextCapsule>>,
    // 工具开关同步到原生层：禁用时直接跳过所有捕获，避免无谓的 UIA 扫描。
    capture_enabled: AtomicBool,
    // 工具配置中的子捕获开关，从前端同步下来，控制 enrich/sensitive 阶段跑哪些子捕获。
    capture_selected_text: AtomicBool,
    capture_browser_url: AtomicBool,
    enable_screenshot_ocr: AtomicBool,
}

impl Default for DesktopContextRuntime {
    fn default() -> Self {
        Self {
            next_sequence: AtomicU64::new(0),
            capsules: Mutex::new(HashMap::new()),
            capture_enabled: AtomicBool::new(true),
            capture_selected_text: AtomicBool::new(true),
            capture_browser_url: AtomicBool::new(true),
            enable_screenshot_ocr: AtomicBool::new(false),
        }
    }
}

struct CaptureOutcome<T> {
    value: Option<T>,
    method: &'static str,
    reason: Option<String>,
}

impl DesktopContextRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    /// 同步工具启用状态到原生层。禁用后 `begin_invocation` 直接跳过捕获。
    pub fn set_capture_enabled(&self, enabled: bool) {
        self.capture_enabled.store(enabled, Ordering::Relaxed);
    }

    /// 读取当前是否允许捕获桌面上下文。
    pub fn is_capture_enabled(&self) -> bool {
        self.capture_enabled.load(Ordering::Relaxed)
    }

    /// 从前端工具配置同步子捕获开关到原生层。
    pub fn set_capture_config(
        &self,
        capture_selected_text: bool,
        capture_browser_url: bool,
        enable_screenshot_ocr: bool,
    ) {
        self.capture_selected_text
            .store(capture_selected_text, Ordering::Relaxed);
        self.capture_browser_url
            .store(capture_browser_url, Ordering::Relaxed);
        self.enable_screenshot_ocr
            .store(enable_screenshot_ocr, Ordering::Relaxed);
    }

    /// 是否在 enrich 阶段捕获选中文本。
    pub fn is_selected_text_capture_enabled(&self) -> bool {
        self.capture_selected_text.load(Ordering::Relaxed)
    }

    /// 是否在 active window 为浏览器时捕获 URL/标题。预留给 D1。
    pub fn is_browser_url_capture_enabled(&self) -> bool {
        self.capture_browser_url.load(Ordering::Relaxed)
    }

    /// 是否对已批准的截图做 OCR。预留给 D4。
    pub fn is_screenshot_ocr_enabled(&self) -> bool {
        self.enable_screenshot_ocr.load(Ordering::Relaxed)
    }

    /// 同步开始一次呼出捕获：只抓便宜的活动窗口信息并立即落一个占位 capsule，
    /// 返回 capsule_id 后由调用方显示搜索窗口，再调用 `enrich_capsule` 在后台
    /// 补齐昂贵的选中文本捕获（UIA/原生扫描），避免阻塞窗口显示。
    ///
    /// 必须在显示 TouchAI 搜索窗口之前调用，否则前台窗口会变成 TouchAI 自身，
    /// 活动窗口将被错误地捕获成搜索框。
    pub fn begin_invocation(
        &self,
        source: &'static str,
    ) -> Result<Option<String>, String> {
        if !self.is_capture_enabled() {
            return Ok(None);
        }

        let sequence = self.next_sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let capsule_id = format!("desktop-context-{sequence}");
        let captured_at = now_rfc3339_millis();
        let active_window_capture = capture_active_window();
        let active_window = active_window_capture.value.clone();
        // 选中文本捕获是主要延迟来源，这里先占位，由后台 enrich 补齐。
        let selected_text =
            unavailable_selected_text(Some(selected_text_provider_method()), SELECTED_TEXT_PENDING_ASYNC);
        let clipboard = pending_clipboard_without_runtime();
        let screenshot = pending_screenshot();
        // 活动文档全文同样是“待审批”占位，仅在用户批准 document.full_text 后读取。
        let document = pending_document();
        let capabilities =
            build_initial_capabilities(&active_window_capture, &selected_text, &clipboard);
        let redactions = sensitive_redactions();
        let summary = build_summary(
            active_window.as_ref(),
            &selected_text,
            &clipboard,
            &screenshot,
            &document,
        );

        let capsule = DesktopContextCapsule {
            id: capsule_id.clone(),
            sequence,
            captured_at,
            invocation_source: source.to_string(),
            platform: std::env::consts::OS.to_string(),
            summary,
            active_window,
            selected_text,
            clipboard,
            screenshot,
            document,
            capabilities,
            redactions,
        };

        let mut capsules = self
            .capsules
            .lock()
            .map_err(|error| format!("Desktop context state is poisoned: {error}"))?;
        capsules.insert(capsule.id.clone(), capsule);
        evict_excess_capsules(&mut capsules);
        Ok(Some(capsule_id))
    }

    /// 后台补齐占位 capsule 的昂贵字段（选中文本、浏览器 URL）。
    /// 各子捕获按各自的配置开关独立执行；若 capsule 已被淘汰则静默丢弃结果。
    pub fn enrich_capsule(&self, capsule_id: &str) -> Result<(), String> {
        let capture_selected = self.is_selected_text_capture_enabled();
        let capture_browser = self.is_browser_url_capture_enabled();
        // 两个子捕获都被关掉时无事可做，占位 capsule 保持原样。
        if !capture_selected && !capture_browser {
            return Ok(());
        }

        // 先读出占位 capsule 的活动窗口（不持锁跑昂贵的 UIA 扫描）。
        let active_window = {
            let capsules = self
                .capsules
                .lock()
                .map_err(|error| format!("Desktop context state is poisoned: {error}"))?;
            let Some(capsule) = capsules.get(capsule_id) else {
                return Ok(());
            };
            capsule.active_window.clone()
        };

        let selected_text =
            capture_selected.then(|| capture_selected_text(active_window.as_ref()));
        let browser_url = if capture_browser {
            capture_browser_url(active_window.as_ref())
        } else {
            None
        };

        let mut capsules = self
            .capsules
            .lock()
            .map_err(|error| format!("Desktop context state is poisoned: {error}"))?;
        let Some(capsule) = capsules.get_mut(capsule_id) else {
            // capsule 已被淘汰，丢弃 enrich 结果。
            return Ok(());
        };

        if let Some(selected_text) = selected_text {
            capsule.selected_text = selected_text;
        }
        if let Some(active_window) = capsule.active_window.as_mut() {
            active_window.browser_url = browser_url;
        }
        capsule.capabilities = build_sensitive_capabilities(
            capsule.active_window.as_ref(),
            &capsule.selected_text,
            &capsule.clipboard,
            &capsule.screenshot,
        );
        capsule.summary = build_summary(
            capsule.active_window.as_ref(),
            &capsule.selected_text,
            &capsule.clipboard,
            &capsule.screenshot,
            &capsule.document,
        );
        Ok(())
    }

    pub fn capture_sensitive<R: Runtime>(
        &self,
        app_handle: &AppHandle<R>,
        capsule_id: &str,
        include: &[String],
        screenshot_target: Option<&str>,
    ) -> Result<Option<DesktopContextCapsule>, String> {
        let mut capsules = self
            .capsules
            .lock()
            .map_err(|error| format!("Desktop context state is poisoned: {error}"))?;
        let Some(existing) = capsules.get(capsule_id).cloned() else {
            return Ok(None);
        };

        let mut capsule = existing;
        if include_requests_clipboard(include) {
            capsule.clipboard = capture_clipboard(app_handle);
        }
        if include_requests_selected_text(include) {
            capsule.selected_text = capture_selected_text(capsule.active_window.as_ref());
        }
        if include_requests_screenshot(include) {
            let captured_at = now_rfc3339_millis();
            capsule.screenshot = capture_screenshot(
                app_handle,
                &capsule.id,
                &captured_at,
                capsule.active_window.as_ref(),
                screenshot_target,
            );
            // 截图成功且用户启用了 OCR 时，对已保存的 PNG 跑一次文字识别，
            // 让非视觉模型也能用到屏幕文字。失败只记日志，不影响截图本身。
            if self.is_screenshot_ocr_enabled() {
                if let Some(path) = capsule.screenshot.path.clone() {
                    capsule.screenshot.ocr_text = capture_screenshot_ocr(&path);
                }
            }
        }
        if include_requests_document(include) {
            capsule.document = capture_document(capsule.active_window.as_ref());
        }

        capsule.capabilities = build_sensitive_capabilities(
            capsule.active_window.as_ref(),
            &capsule.selected_text,
            &capsule.clipboard,
            &capsule.screenshot,
        );
        capsule.redactions = sensitive_redactions();
        capsule.summary = build_summary(
            capsule.active_window.as_ref(),
            &capsule.selected_text,
            &capsule.clipboard,
            &capsule.screenshot,
            &capsule.document,
        );

        capsules.insert(capsule.id.clone(), capsule.clone());
        Ok(Some(capsule))
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

    let image_count = payload.image_paths.len();
    let file_count = payload.file_paths.len();
    DesktopContextClipboard {
        available: true,
        snapshot_id: Some(payload.snapshot_id),
        observed_at: Some(payload.observed_at),
        text,
        text_summary,
        text_length,
        image_count,
        file_count,
        image_paths: payload.image_paths,
        file_paths: payload.file_paths,
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
            image_paths: Vec::new(),
            file_paths: Vec::new(),
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
            image_paths: Vec::new(),
            file_paths: Vec::new(),
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
            image_paths: Vec::new(),
            file_paths: Vec::new(),
            reason: Some(error),
        },
    }
}

/// 呼出时剪贴板始终是“待审批”占位：剪贴板内容只在用户批准
/// clipboard.* include 后才由 `capture_sensitive` 真正读取。
/// 因此这里不需要 app_handle，也无需检查 runtime 是否就绪。
fn pending_clipboard_without_runtime() -> DesktopContextClipboard {
    DesktopContextClipboard {
        available: false,
        snapshot_id: None,
        observed_at: None,
        text: None,
        text_summary: None,
        text_length: 0,
        image_count: 0,
        file_count: 0,
        image_paths: Vec::new(),
        file_paths: Vec::new(),
        reason: Some(SENSITIVE_ACCESS_REQUIRES_APPROVAL.to_string()),
    }
}

fn unavailable_selected_text(
    source: Option<&'static str>,
    reason: impl Into<String>,
) -> DesktopContextSelectedText {
    DesktopContextSelectedText {
        available: false,
        source: source.map(str::to_string),
        text: None,
        text_length: 0,
        truncated: false,
        reason: Some(reason.into()),
    }
}

fn selected_text_from_text(source: &'static str, text: String) -> DesktopContextSelectedText {
    let text_length = text.chars().count();
    if text_length == 0 {
        return unavailable_selected_text(
            Some(source),
            "The focused element reported no selected text.",
        );
    }

    let truncated = text_length > SELECTED_TEXT_LIMIT;
    let stored_text = if truncated {
        text.chars().take(SELECTED_TEXT_LIMIT).collect()
    } else {
        text
    };

    DesktopContextSelectedText {
        available: true,
        source: Some(source.to_string()),
        text: Some(stored_text),
        text_length,
        truncated,
        reason: None,
    }
}

fn unavailable_document(reason: impl Into<String>) -> DesktopContextDocument {
    DesktopContextDocument {
        available: false,
        source: None,
        text: None,
        text_length: 0,
        truncated: false,
        reason: Some(reason.into()),
    }
}

/// 呼出时文档全文始终是“待审批”占位：仅在用户批准 document.full_text 后，
/// 由 `capture_sensitive` 通过 UIA TextPattern DocumentRange 真正读取。
fn pending_document() -> DesktopContextDocument {
    unavailable_document(SENSITIVE_ACCESS_REQUIRES_APPROVAL)
}

fn document_from_text(source: &'static str, text: String) -> DesktopContextDocument {
    let text_length = text.chars().count();
    if text_length == 0 {
        return unavailable_document("The focused document reported no readable text.");
    }

    let truncated = text_length > DOCUMENT_TEXT_LIMIT;
    let stored_text = if truncated {
        text.chars().take(DOCUMENT_TEXT_LIMIT).collect()
    } else {
        text
    };

    DesktopContextDocument {
        available: true,
        source: Some(source.to_string()),
        text: Some(stored_text),
        text_length,
        truncated,
        reason: None,
    }
}

fn normalize_text_selection_range(start: usize, end: usize) -> Option<(usize, usize)> {
    if start == end {
        return None;
    }

    Some((start.min(end), start.max(end)))
}

fn selected_text_from_utf16_range(
    source: &'static str,
    text: &[u16],
    start: usize,
    end: usize,
) -> Result<DesktopContextSelectedText, String> {
    let Some((start, end)) = normalize_text_selection_range(start, end) else {
        return Err("The native text control reported no selected text.".to_string());
    };
    if end > text.len() {
        return Err("The native text control selection is outside the captured text.".to_string());
    }

    Ok(selected_text_from_text(
        source,
        String::from_utf16_lossy(&text[start..end]),
    ))
}

fn capture_selected_text(
    active_window: Option<&DesktopContextActiveWindow>,
) -> DesktopContextSelectedText {
    match capture_selected_text_result(active_window) {
        Ok(selected_text) => selected_text,
        Err(error) => unavailable_selected_text(Some(selected_text_provider_method()), error),
    }
}

fn selected_text_provider_method() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows-uia-textpattern"
    } else if cfg!(target_os = "macos") {
        "macos-accessibility-pending"
    } else if cfg!(target_os = "linux") {
        "linux-selection-unsupported"
    } else {
        "unsupported-platform"
    }
}

#[cfg(target_os = "windows")]
fn capture_selected_text_result(
    active_window: Option<&DesktopContextActiveWindow>,
) -> Result<DesktopContextSelectedText, String> {
    use windows::{
        core::{HRESULT, VARIANT},
        Win32::{
            Foundation::{BOOL, HWND, LPARAM, RPC_E_CHANGED_MODE, S_FALSE, S_OK, WPARAM},
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            UI::Accessibility::{
                CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
                TreeScope_Descendants, UIA_IsTextPatternAvailablePropertyId, UIA_TextPatternId,
            },
            UI::WindowsAndMessaging::{
                EnumChildWindows, GetClassNameW, SendMessageTimeoutW, SMTO_ABORTIFHUNG, WM_GETTEXT,
                WM_GETTEXTLENGTH,
            },
        },
    };

    const EM_GETSEL: u32 = 0x00B0;
    const NATIVE_TEXT_CHILD_SCAN_LIMIT: usize = 512;
    const TEXT_MESSAGE_TIMEOUT_MS: u32 = 80;

    struct CoInitializeGuard {
        should_uninitialize: bool,
    }

    impl Drop for CoInitializeGuard {
        fn drop(&mut self) {
            if self.should_uninitialize {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }

    fn coinitialize_guard() -> Result<CoInitializeGuard, String> {
        let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if result == S_OK || result == S_FALSE {
            return Ok(CoInitializeGuard {
                should_uninitialize: true,
            });
        }
        if result == RPC_E_CHANGED_MODE {
            return Ok(CoInitializeGuard {
                should_uninitialize: false,
            });
        }

        Err(format!(
            "Failed to initialize COM for UI Automation: {result:?}"
        ))
    }

    fn stringify_hresult(error: windows::core::Error) -> String {
        let code: HRESULT = error.code();
        format!("{error} ({code:?})")
    }

    fn selected_text_from_element(
        element: &IUIAutomationElement,
        source: &'static str,
    ) -> Result<DesktopContextSelectedText, String> {
        let text_pattern: IUIAutomationTextPattern =
            unsafe { element.GetCurrentPatternAs(UIA_TextPatternId) }.map_err(|error| {
                format!(
                    "Element does not expose UI Automation TextPattern: {}",
                    stringify_hresult(error)
                )
            })?;
        selected_text_from_pattern(&text_pattern, source)
    }

    fn selected_text_from_pattern(
        text_pattern: &IUIAutomationTextPattern,
        source: &'static str,
    ) -> Result<DesktopContextSelectedText, String> {
        let selection = unsafe { text_pattern.GetSelection() }
            .map_err(|error| format!("Failed to read UI Automation text selection: {error}"))?;
        let selection_count = unsafe { selection.Length() }
            .map_err(|error| format!("Failed to count selected text ranges: {error}"))?;
        if selection_count <= 0 {
            return Err("The element reported no selected text ranges.".to_string());
        }

        let mut ranges = Vec::new();
        for index in 0..selection_count {
            let range = unsafe { selection.GetElement(index) }
                .map_err(|error| format!("Failed to read selected text range {index}: {error}"))?;
            let text = unsafe { range.GetText((SELECTED_TEXT_LIMIT + 1) as i32) }
                .map_err(|error| format!("Failed to read selected text range {index}: {error}"))?
                .to_string();
            if !text.is_empty() {
                ranges.push(text);
            }
        }

        if ranges.is_empty() {
            return Err("The element reported empty selected text ranges.".to_string());
        }

        Ok(selected_text_from_text(source, ranges.join("\n")))
    }

    fn hwnd_is_null(hwnd: HWND) -> bool {
        hwnd.0.is_null()
    }

    fn parse_hwnd(window_handle: Option<&str>) -> Option<HWND> {
        let value = window_handle?;
        let trimmed = value.trim().strip_prefix("0x").unwrap_or(value.trim());
        usize::from_str_radix(trimmed, 16)
            .ok()
            .filter(|value| *value != 0)
            .map(|value| HWND(value as _))
    }

    fn send_text_message(
        hwnd: HWND,
        message: u32,
        wparam: usize,
        lparam: isize,
    ) -> Result<usize, String> {
        let mut result = 0usize;
        let status = unsafe {
            SendMessageTimeoutW(
                hwnd,
                message,
                WPARAM(wparam),
                LPARAM(lparam),
                SMTO_ABORTIFHUNG,
                TEXT_MESSAGE_TIMEOUT_MS,
                Some(&mut result),
            )
        };
        if status.0 == 0 {
            return Err(format!(
                "Native text control message 0x{message:x} timed out or failed."
            ));
        }

        Ok(result)
    }

    fn native_text_selection_range(hwnd: HWND) -> Result<(usize, usize), String> {
        let mut start = 0u32;
        let mut end = 0u32;
        send_text_message(
            hwnd,
            EM_GETSEL,
            &mut start as *mut u32 as usize,
            &mut end as *mut u32 as isize,
        )?;

        Ok((start as usize, end as usize))
    }

    fn read_native_text_prefix(hwnd: HWND, end: usize) -> Result<Vec<u16>, String> {
        if end > NATIVE_TEXT_BUFFER_LIMIT {
            return Err(format!(
                "Native text control selection exceeds the {NATIVE_TEXT_BUFFER_LIMIT} UTF-16 unit read limit."
            ));
        }

        let reported_length = send_text_message(hwnd, WM_GETTEXTLENGTH, 0, 0)?;
        if reported_length == 0 {
            return Err("Native text control reported empty text.".to_string());
        }

        let read_length = reported_length.min(end).min(NATIVE_TEXT_BUFFER_LIMIT);
        if read_length < end {
            return Err("Native text control selection is outside the readable text.".to_string());
        }

        let mut buffer = vec![0u16; read_length + 1];
        let copied =
            send_text_message(hwnd, WM_GETTEXT, buffer.len(), buffer.as_mut_ptr() as isize)?
                .min(read_length);
        buffer.truncate(copied);
        Ok(buffer)
    }

    fn selected_text_from_native_text_control(
        hwnd: HWND,
    ) -> Result<DesktopContextSelectedText, String> {
        let (start, end) = native_text_selection_range(hwnd)?;
        let Some((_, normalized_end)) = normalize_text_selection_range(start, end) else {
            return Err("Native text control reported no selected text.".to_string());
        };
        let text = read_native_text_prefix(hwnd, normalized_end)?;

        selected_text_from_utf16_range("windows-win32-native-text-control", &text, start, end)
    }

    unsafe extern "system" fn collect_child_hwnd(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let handles = &mut *(lparam.0 as *mut Vec<HWND>);
        if handles.len() >= NATIVE_TEXT_CHILD_SCAN_LIMIT {
            return BOOL(0);
        }

        handles.push(hwnd);
        BOOL(1)
    }

    fn child_hwnds(root: HWND) -> Vec<HWND> {
        let mut handles = Vec::new();
        unsafe {
            let _ = EnumChildWindows(
                root,
                Some(collect_child_hwnd),
                LPARAM(&mut handles as *mut Vec<HWND> as isize),
            );
        }
        handles
    }

    fn window_class_name(hwnd: HWND) -> Option<String> {
        let mut buffer = [0u16; 256];
        let length = unsafe { GetClassNameW(hwnd, &mut buffer) };
        (length > 0).then(|| String::from_utf16_lossy(&buffer[..length as usize]))
    }

    fn is_native_text_class(class_name: &str) -> bool {
        let normalized = class_name.to_ascii_lowercase();
        normalized == "edit" || normalized.contains("richedit")
    }

    fn selected_text_from_native_window(hwnd: HWND) -> Result<DesktopContextSelectedText, String> {
        if hwnd_is_null(hwnd) {
            return Err("Invocation active window handle is empty.".to_string());
        }

        let mut errors = Vec::new();
        let mut scanned = 0usize;
        for candidate in std::iter::once(hwnd).chain(child_hwnds(hwnd).into_iter()) {
            let Some(class_name) = window_class_name(candidate) else {
                continue;
            };
            if !is_native_text_class(&class_name) {
                continue;
            }

            scanned += 1;
            match selected_text_from_native_text_control(candidate) {
                Ok(selected_text) => return Ok(selected_text),
                Err(error) => errors.push(format!("{class_name}: {error}")),
            }
        }

        if scanned == 0 {
            Err("No native Edit/RichEdit text controls were found under the invocation active window.".to_string())
        } else {
            Err(format!(
                "No selected text was found in {scanned} native text controls: {}",
                errors.join("; ")
            ))
        }
    }

    fn selected_text_from_descendants(
        automation: &IUIAutomation,
        root: &IUIAutomationElement,
    ) -> Result<DesktopContextSelectedText, String> {
        let is_text_pattern_available = VARIANT::from(true);
        let condition = unsafe {
            automation.CreatePropertyCondition(
                UIA_IsTextPatternAvailablePropertyId,
                &is_text_pattern_available,
            )
        }
        .map_err(|error| {
            format!("Failed to create UI Automation TextPattern search condition: {error}")
        })?;
        let descendants = unsafe { root.FindAll(TreeScope_Descendants, &condition) }
            .map_err(|error| format!("Failed to enumerate UI Automation descendants: {error}"))?;
        let descendant_count = unsafe { descendants.Length() }
            .map_err(|error| format!("Failed to count UI Automation descendants: {error}"))?;
        let limit = descendant_count.min(UIA_TEXT_PATTERN_DESCENDANT_LIMIT);

        for index in 0..limit {
            let Ok(element) = (unsafe { descendants.GetElement(index) }) else {
                continue;
            };
            if let Ok(selected_text) =
                selected_text_from_element(&element, "windows-uia-descendant-textpattern")
            {
                return Ok(selected_text);
            }
        }

        Err(format!(
            "No selected text was found in the first {limit} UI Automation descendants."
        ))
    }

    fn element_process_id(element: &IUIAutomationElement) -> Option<u32> {
        unsafe { element.CurrentProcessId() }
            .ok()
            .and_then(|process_id| u32::try_from(process_id).ok())
    }

    fn focused_element_matches_invocation_window(
        focused: &IUIAutomationElement,
        active_window: Option<&DesktopContextActiveWindow>,
    ) -> bool {
        let Some(active_window) = active_window else {
            return true;
        };
        let Some(invocation_process_id) = active_window.process_id else {
            return false;
        };

        element_process_id(focused) == Some(invocation_process_id)
    }

    let _guard = coinitialize_guard()?;
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
            .map_err(|error| format!("Failed to create UI Automation client: {error}"))?;

    let mut invocation_window_error: Option<String> = None;
    if let Some(hwnd) = parse_hwnd(active_window.and_then(|window| window.window_handle.as_deref()))
    {
        invocation_window_error = Some(match unsafe { automation.ElementFromHandle(hwnd) } {
            Ok(element) => {
                let direct_error =
                    match selected_text_from_element(&element, "windows-uia-window-textpattern") {
                        Ok(selected_text) => return Ok(selected_text),
                        Err(error) => error,
                    };
                match selected_text_from_descendants(&automation, &element) {
                    Ok(selected_text) => return Ok(selected_text),
                    Err(error) => match selected_text_from_native_window(hwnd) {
                        Ok(selected_text) => return Ok(selected_text),
                        Err(native_error) => {
                            format!("{direct_error}; {error}; {native_error}")
                        }
                    },
                }
            }
            Err(error) => {
                log::warn!(
                    "Failed to read UI Automation element from active window handle: {}",
                    error
                );
                match selected_text_from_native_window(hwnd) {
                    Ok(selected_text) => return Ok(selected_text),
                    Err(native_error) => format!(
                        "Failed to read UI Automation element from invocation active window handle: {error}; {native_error}"
                    ),
                }
            }
        });
    }

    let focused = unsafe { automation.GetFocusedElement() }
        .map_err(|error| format!("Failed to get focused UI Automation element: {error}"))?;
    if !focused_element_matches_invocation_window(&focused, active_window) {
        return Err(invocation_window_error.unwrap_or_else(|| {
            "Focused element no longer belongs to the invocation active window; selected text was not read to avoid capturing TouchAI approval UI focus.".to_string()
        }));
    }

    match selected_text_from_element(&focused, "windows-uia-focused-textpattern") {
        Ok(selected_text) => Ok(selected_text),
        Err(focused_error) => {
            let native_error = match unsafe { focused.CurrentNativeWindowHandle() } {
                Ok(hwnd) => match selected_text_from_native_window(hwnd) {
                    Ok(selected_text) => return Ok(selected_text),
                    Err(error) => Some(error),
                },
                Err(error) => Some(format!(
                    "Focused element does not expose a native window handle: {error}"
                )),
            };
            if let Some(window_error) = invocation_window_error {
                Err(format!(
                    "{window_error}; focused fallback failed: {focused_error}; {}",
                    native_error.unwrap_or_else(|| "native focused fallback failed".to_string())
                ))
            } else {
                Err(native_error
                    .map(|error| format!("{focused_error}; {error}"))
                    .unwrap_or(focused_error))
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn capture_selected_text_result(
    _active_window: Option<&DesktopContextActiveWindow>,
) -> Result<DesktopContextSelectedText, String> {
    if cfg!(target_os = "macos") {
        Err(
            "macOS selected-text extraction requires an Accessibility provider and user permission."
                .to_string(),
        )
    } else if cfg!(target_os = "linux") {
        Err(
            "Linux selected-text extraction has no stable cross-desktop read-only API; Wayland support is compositor dependent."
                .to_string(),
        )
    } else {
        Err("Selected-text extraction is not supported on this platform.".to_string())
    }
}

/// 已知 Chromium / Gecko 系浏览器的应用名 / 标题标记，用于判断是否尝试读取地址栏。
const BROWSER_NAME_MARKERS: &[&str] = &[
    "chrome", "chromium", "edge", "msedge", "firefox", "brave", "opera", "vivaldi", "arc",
];

/// 基于活动窗口的 app_name / title 粗判是否为浏览器。
///
/// 仅作为是否启动一次 UIA 地址栏扫描的前置过滤，避免对所有窗口都跑 ValuePattern 查询。
fn active_window_looks_like_browser(active_window: Option<&DesktopContextActiveWindow>) -> bool {
    let Some(window) = active_window else {
        return false;
    };

    let haystacks = [window.app_name.as_deref(), window.title.as_deref()];
    haystacks.iter().flatten().any(|value| {
        let normalized = value.to_ascii_lowercase();
        BROWSER_NAME_MARKERS
            .iter()
            .any(|marker| normalized.contains(marker))
    })
}

/// 读取活动窗口（浏览器）地址栏 URL。
///
/// `Ok(Some(url))` 表示成功识别到地址栏文本；`Ok(None)` 表示未找到地址栏或非浏览器；
/// `Err` 表示捕获过程出错。结果只在用户启用 capture_browser_url 时被调用。
fn capture_browser_url(active_window: Option<&DesktopContextActiveWindow>) -> Option<String> {
    if !active_window_looks_like_browser(active_window) {
        return None;
    }

    match capture_browser_url_result(active_window) {
        Ok(url) => url,
        Err(error) => {
            log::debug!("Failed to capture browser URL: {}", error);
            None
        }
    }
}

#[cfg(target_os = "windows")]
fn capture_browser_url_result(
    active_window: Option<&DesktopContextActiveWindow>,
) -> Result<Option<String>, String> {
    use windows::{
        core::VARIANT,
        Win32::{
            Foundation::{HWND, RPC_E_CHANGED_MODE, S_FALSE, S_OK},
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            UI::Accessibility::{
                CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationValuePattern,
                TreeScope_Descendants, UIA_ControlTypePropertyId, UIA_EditControlTypeId,
                UIA_IsValuePatternAvailablePropertyId, UIA_ValuePatternId,
            },
        },
    };

    const BROWSER_URL_EDIT_SCAN_LIMIT: i32 = 64;

    struct CoInitializeGuard {
        should_uninitialize: bool,
    }

    impl Drop for CoInitializeGuard {
        fn drop(&mut self) {
            if self.should_uninitialize {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }

    fn coinitialize_guard() -> Result<CoInitializeGuard, String> {
        let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if result == S_OK || result == S_FALSE {
            return Ok(CoInitializeGuard {
                should_uninitialize: true,
            });
        }
        if result == RPC_E_CHANGED_MODE {
            return Ok(CoInitializeGuard {
                should_uninitialize: false,
            });
        }

        Err(format!(
            "Failed to initialize COM for UI Automation: {result:?}"
        ))
    }

    fn parse_hwnd(window_handle: Option<&str>) -> Option<HWND> {
        let value = window_handle?;
        let trimmed = value.trim().strip_prefix("0x").unwrap_or(value.trim());
        usize::from_str_radix(trimmed, 16)
            .ok()
            .filter(|value| *value != 0)
            .map(|value| HWND(value as _))
    }

    /// 地址栏取出的值常常省略 scheme（如 `example.com/foo`），
    /// 这里做一个宽松的“看起来像 URL / 域名”判断，过滤掉搜索框等无关 Edit。
    fn looks_like_url(value: &str) -> bool {
        let trimmed = value.trim();
        if trimmed.is_empty() || trimmed.contains(char::is_whitespace) {
            return false;
        }
        if trimmed.starts_with("http://")
            || trimmed.starts_with("https://")
            || trimmed.starts_with("about:")
            || trimmed.starts_with("file://")
        {
            return true;
        }
        // 形如 host.tld[/...]：第一个路径段之前需要含点。
        let host = trimmed.split('/').next().unwrap_or(trimmed);
        host.contains('.') && !host.starts_with('.') && !host.ends_with('.')
    }

    fn value_from_element(element: &IUIAutomationElement) -> Option<String> {
        let value_pattern: IUIAutomationValuePattern =
            unsafe { element.GetCurrentPatternAs(UIA_ValuePatternId) }.ok()?;
        let value = unsafe { value_pattern.CurrentValue() }.ok()?.to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    }

    let _guard = coinitialize_guard()?;
    let Some(hwnd) =
        parse_hwnd(active_window.and_then(|window| window.window_handle.as_deref()))
    else {
        return Ok(None);
    };

    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
            .map_err(|error| format!("Failed to create UI Automation client: {error}"))?;
    let root = unsafe { automation.ElementFromHandle(hwnd) }
        .map_err(|error| format!("Failed to read UI Automation element from browser window: {error}"))?;

    // 只在“是 Edit 控件且暴露 ValuePattern”的后代里找地址栏。
    let is_edit = VARIANT::from(UIA_EditControlTypeId.0);
    let control_type_condition = unsafe {
        automation.CreatePropertyCondition(UIA_ControlTypePropertyId, &is_edit)
    }
    .map_err(|error| format!("Failed to create control-type condition: {error}"))?;
    let has_value = VARIANT::from(true);
    let value_pattern_condition = unsafe {
        automation.CreatePropertyCondition(UIA_IsValuePatternAvailablePropertyId, &has_value)
    }
    .map_err(|error| format!("Failed to create value-pattern condition: {error}"))?;
    let condition = unsafe {
        automation.CreateAndCondition(&control_type_condition, &value_pattern_condition)
    }
    .map_err(|error| format!("Failed to combine browser URL search conditions: {error}"))?;

    let edits = unsafe { root.FindAll(TreeScope_Descendants, &condition) }
        .map_err(|error| format!("Failed to enumerate browser Edit controls: {error}"))?;
    let count = unsafe { edits.Length() }
        .map_err(|error| format!("Failed to count browser Edit controls: {error}"))?;
    let limit = count.min(BROWSER_URL_EDIT_SCAN_LIMIT);

    for index in 0..limit {
        let Ok(element) = (unsafe { edits.GetElement(index) }) else {
            continue;
        };
        if let Some(value) = value_from_element(&element) {
            if looks_like_url(&value) {
                return Ok(Some(value.trim().to_string()));
            }
        }
    }

    Ok(None)
}

#[cfg(not(target_os = "windows"))]
fn capture_browser_url_result(
    _active_window: Option<&DesktopContextActiveWindow>,
) -> Result<Option<String>, String> {
    Err("Browser URL capture is only implemented on Windows.".to_string())
}

/// 读取活动窗口聚焦文档的可见全文（UIA TextPattern 的 DocumentRange）。
///
/// 仅在用户批准 `document.full_text` 后由 `capture_sensitive` 调用。
fn capture_document(active_window: Option<&DesktopContextActiveWindow>) -> DesktopContextDocument {
    match capture_document_result(active_window) {
        Ok(document) => document,
        Err(error) => unavailable_document(error),
    }
}

fn document_provider_method() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows-uia-document-textpattern"
    } else if cfg!(target_os = "macos") {
        "macos-accessibility-pending"
    } else if cfg!(target_os = "linux") {
        "linux-document-unsupported"
    } else {
        "unsupported-platform"
    }
}

#[cfg(target_os = "windows")]
fn capture_document_result(
    active_window: Option<&DesktopContextActiveWindow>,
) -> Result<DesktopContextDocument, String> {
    use windows::{
        core::VARIANT,
        Win32::{
            Foundation::{HWND, RPC_E_CHANGED_MODE, S_FALSE, S_OK},
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            UI::Accessibility::{
                CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
                TreeScope_Descendants, UIA_IsTextPatternAvailablePropertyId, UIA_TextPatternId,
            },
        },
    };

    const DOCUMENT_TEXTPATTERN_DESCENDANT_LIMIT: i32 = 500;

    struct CoInitializeGuard {
        should_uninitialize: bool,
    }

    impl Drop for CoInitializeGuard {
        fn drop(&mut self) {
            if self.should_uninitialize {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }

    fn coinitialize_guard() -> Result<CoInitializeGuard, String> {
        let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if result == S_OK || result == S_FALSE {
            return Ok(CoInitializeGuard {
                should_uninitialize: true,
            });
        }
        if result == RPC_E_CHANGED_MODE {
            return Ok(CoInitializeGuard {
                should_uninitialize: false,
            });
        }

        Err(format!(
            "Failed to initialize COM for UI Automation: {result:?}"
        ))
    }

    fn parse_hwnd(window_handle: Option<&str>) -> Option<HWND> {
        let value = window_handle?;
        let trimmed = value.trim().strip_prefix("0x").unwrap_or(value.trim());
        usize::from_str_radix(trimmed, 16)
            .ok()
            .filter(|value| *value != 0)
            .map(|value| HWND(value as _))
    }

    /// 从一个暴露 TextPattern 的元素读取 DocumentRange 全文。
    fn document_text_from_element(element: &IUIAutomationElement) -> Option<String> {
        let text_pattern: IUIAutomationTextPattern =
            unsafe { element.GetCurrentPatternAs(UIA_TextPatternId) }.ok()?;
        let document_range = unsafe { text_pattern.DocumentRange() }.ok()?;
        // -1 表示读取整个范围；这里仍传一个上限做防御，避免超大文档卡住。
        let text = unsafe { document_range.GetText((DOCUMENT_TEXT_LIMIT + 1) as i32) }
            .ok()?
            .to_string();
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(text)
        }
    }

    let _guard = coinitialize_guard()?;
    let Some(hwnd) = parse_hwnd(active_window.and_then(|window| window.window_handle.as_deref()))
    else {
        return Err("Invocation active window handle is empty.".to_string());
    };

    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
            .map_err(|error| format!("Failed to create UI Automation client: {error}"))?;
    let root = unsafe { automation.ElementFromHandle(hwnd) }.map_err(|error| {
        format!("Failed to read UI Automation element from active window: {error}")
    })?;

    // 先尝试根元素本身是否就是文档（很多编辑器/阅读器的文档区即根）。
    if let Some(text) = document_text_from_element(&root) {
        return Ok(document_from_text(document_provider_method(), text));
    }

    // 否则在暴露 TextPattern 的后代里找第一个非空 DocumentRange。
    let is_text_pattern_available = VARIANT::from(true);
    let condition = unsafe {
        automation
            .CreatePropertyCondition(UIA_IsTextPatternAvailablePropertyId, &is_text_pattern_available)
    }
    .map_err(|error| format!("Failed to create document TextPattern search condition: {error}"))?;
    let descendants = unsafe { root.FindAll(TreeScope_Descendants, &condition) }
        .map_err(|error| format!("Failed to enumerate UI Automation descendants: {error}"))?;
    let descendant_count = unsafe { descendants.Length() }
        .map_err(|error| format!("Failed to count UI Automation descendants: {error}"))?;
    let limit = descendant_count.min(DOCUMENT_TEXTPATTERN_DESCENDANT_LIMIT);

    for index in 0..limit {
        let Ok(element) = (unsafe { descendants.GetElement(index) }) else {
            continue;
        };
        if let Some(text) = document_text_from_element(&element) {
            return Ok(document_from_text(document_provider_method(), text));
        }
    }

    Err(format!(
        "No document text was found in the active window or its first {limit} UI Automation descendants."
    ))
}

#[cfg(not(target_os = "windows"))]
fn capture_document_result(
    _active_window: Option<&DesktopContextActiveWindow>,
) -> Result<DesktopContextDocument, String> {
    Err("Active-document full-text capture is only implemented on Windows.".to_string())
}

fn unsupported_screenshot_for_target(
    captured_at: &str,
    target: &str,
    reason: String,
) -> DesktopContextScreenshot {
    DesktopContextScreenshot {
        available: false,
        path: None,
        mime_type: None,
        width: None,
        height: None,
        target: target.to_string(),
        persisted: false,
        captured_at: Some(captured_at.to_string()),
        ocr_text: None,
        reason: Some(reason),
    }
}

fn pending_screenshot() -> DesktopContextScreenshot {
    DesktopContextScreenshot {
        available: false,
        path: None,
        mime_type: None,
        width: None,
        height: None,
        target: "active_display".to_string(),
        persisted: false,
        captured_at: None,
        ocr_text: None,
        reason: Some(SENSITIVE_ACCESS_REQUIRES_APPROVAL.to_string()),
    }
}

fn sanitize_artifact_file_stem(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();

    if sanitized.trim_matches('_').is_empty() {
        "desktop-context".to_string()
    } else {
        sanitized
    }
}

fn screenshot_artifact_path(data_root: PathBuf, capsule_id: &str) -> PathBuf {
    data_root
        .join("desktop-context")
        .join("screenshots")
        .join(format!("{}.png", sanitize_artifact_file_stem(capsule_id)))
}

/// 临时截图目录：capsule 捕获阶段写入，按 capsule 淘汰 / 启动清扫回收。
fn temp_screenshot_dir(data_root: &std::path::Path) -> PathBuf {
    data_root.join("desktop-context").join("screenshots")
}

/// 持久截图目录：turn 持久化阶段从临时副本拷贝出独立副本，DB artifact 引用这里。
fn persisted_screenshot_dir(data_root: &std::path::Path) -> PathBuf {
    data_root.join("desktop-context").join("artifacts")
}

/// 持久截图副本路径：`desktop-context/artifacts/{turn_id}-{capsule_id}.png`。
fn persisted_screenshot_artifact_path(
    data_root: &std::path::Path,
    turn_id: i64,
    capsule_id: &str,
) -> PathBuf {
    persisted_screenshot_dir(data_root).join(format!(
        "{}-{}.png",
        turn_id,
        sanitize_artifact_file_stem(capsule_id)
    ))
}

/// 把 capsule 的临时截图拷贝成独立的持久副本，返回持久副本路径。
///
/// 历史会话使用持久副本，capsule 临时副本随后可被安全淘汰/清扫。
pub fn persist_screenshot_artifact_copy(turn_id: i64, capsule_id: &str) -> Result<String, String> {
    let data_root = app_directory_path(AppDirectory::Data)?;
    let source = screenshot_artifact_path(data_root.clone(), capsule_id);
    if !source.exists() {
        return Err(format!(
            "Desktop context temp screenshot not found: {}",
            source.display()
        ));
    }

    let target = persisted_screenshot_artifact_path(&data_root, turn_id, capsule_id);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("Failed to create desktop context artifact directory: {error}")
        })?;
    }

    fs::copy(&source, &target)
        .map_err(|error| format!("Failed to copy desktop context screenshot artifact: {error}"))?;
    Ok(target.to_string_lossy().into_owned())
}

/// 删除指定目录下所有 `.png` 文件（仅一层，目录本身保留）。
fn remove_png_files_in_dir(dir: &std::path::Path) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "Failed to read desktop context directory '{}': {}",
                    dir.display(),
                    error
                );
            }
            return;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("png") {
            continue;
        }
        if let Err(error) = fs::remove_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "Failed to remove desktop context screenshot '{}': {}",
                    path.display(),
                    error
                );
            }
        }
    }
}

/// 启动时清空临时截图目录：进程重启后内存 capsule 集合为空，
/// 这些临时副本不再被任何 capsule 引用，可全部回收。
/// 持久副本目录 `artifacts/` 不在此清理范围。
pub fn cleanup_temp_screenshots() {
    let Ok(data_root) = app_directory_path(AppDirectory::Data) else {
        return;
    };
    remove_png_files_in_dir(&temp_screenshot_dir(&data_root));
}

/// 清空所有持久截图副本：在用户清除全部对话历史时调用。
pub fn clear_persisted_screenshots() -> Result<(), String> {
    let data_root = app_directory_path(AppDirectory::Data)?;
    remove_png_files_in_dir(&persisted_screenshot_dir(&data_root));
    Ok(())
}

/// 删除被淘汰 capsule 自己的临时截图文件。
///
/// 这里删的是 `desktop-context/screenshots/{capsule_id}.png` 临时副本。
/// 历史会话使用的是持久化阶段拷贝出的独立副本，不受影响。
fn remove_capsule_temp_screenshot(capsule: &DesktopContextCapsule) {
    if !capsule.screenshot.persisted {
        return;
    }
    let Some(path) = capsule.screenshot.path.as_ref() else {
        return;
    };
    if let Err(error) = fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::warn!(
                "Failed to remove evicted desktop context screenshot '{}': {}",
                path,
                error
            );
        }
    }
}

/// 保持内存 capsule 数量有界：超过上限时按 sequence 淘汰最旧条目，
/// 并清理其临时截图文件，避免内存与磁盘无限增长。
fn evict_excess_capsules(capsules: &mut HashMap<String, DesktopContextCapsule>) {
    while capsules.len() > MAX_RETAINED_CAPSULES {
        let Some(oldest_id) = capsules
            .values()
            .min_by_key(|capsule| capsule.sequence)
            .map(|capsule| capsule.id.clone())
        else {
            break;
        };

        if let Some(evicted) = capsules.remove(&oldest_id) {
            remove_capsule_temp_screenshot(&evicted);
        }
    }
}

fn include_requests_key(include: &[String], key: &str) -> bool {
    include.iter().any(|item| item == key)
}

fn include_requests_selected_text(include: &[String]) -> bool {
    include_requests_key(include, "selected_text.summary")
        || include_requests_key(include, "selected_text.full_text")
}

fn include_requests_clipboard(include: &[String]) -> bool {
    include_requests_key(include, "clipboard.summary")
        || include_requests_key(include, "clipboard.full_text")
}

fn include_requests_screenshot(include: &[String]) -> bool {
    include_requests_key(include, "screenshot.metadata")
        || include_requests_key(include, "screenshot.image")
}

fn include_requests_document(include: &[String]) -> bool {
    include_requests_key(include, "document.full_text")
}

fn normalize_screenshot_target(target: Option<&str>) -> &'static str {
    match target {
        Some("active_window") => "active_window",
        Some("all_displays") => "all_displays",
        Some("active_display") | Some("capsule_default") | None => "active_display",
        Some(_) => "active_display",
    }
}

fn active_window_center(active_window: Option<&DesktopContextActiveWindow>) -> Option<(i32, i32)> {
    let bounds = active_window?.bounds.as_ref()?;
    if bounds.width <= 0 || bounds.height <= 0 {
        return None;
    }

    Some((
        bounds.x.saturating_add(bounds.width / 2),
        bounds.y.saturating_add(bounds.height / 2),
    ))
}

fn select_capture_monitor(
    active_window: Option<&DesktopContextActiveWindow>,
) -> Result<Monitor, String> {
    if let Some((x, y)) = active_window_center(active_window) {
        if let Ok(monitor) = Monitor::from_point(x, y) {
            return Ok(monitor);
        }
    }

    let monitors =
        Monitor::all().map_err(|error| format!("Failed to enumerate monitors: {error}"))?;
    monitors
        .iter()
        .find_map(|monitor| match monitor.is_primary() {
            Ok(true) => Some(monitor.clone()),
            _ => None,
        })
        .or_else(|| monitors.into_iter().next())
        .ok_or_else(|| "No monitor is available for screenshot capture.".to_string())
}

fn capture_screenshot(
    app_handle: &AppHandle<impl Runtime>,
    capsule_id: &str,
    captured_at: &str,
    active_window: Option<&DesktopContextActiveWindow>,
    screenshot_target: Option<&str>,
) -> DesktopContextScreenshot {
    let target = normalize_screenshot_target(screenshot_target);
    match capture_screenshot_result(app_handle, capsule_id, captured_at, active_window, target) {
        Ok(screenshot) => screenshot,
        Err(error) => unsupported_screenshot_for_target(captured_at, target, error),
    }
}

fn should_hide_window_for_context_screenshot(label: &str) -> bool {
    label == "main" || label == "tray-menu" || label.starts_with("popup-")
}

fn context_screenshot_window_hide_priority(label: &str) -> u8 {
    if label == "main" {
        1
    } else {
        0
    }
}

struct HiddenContextScreenshotWindow<R: Runtime> {
    label: String,
    window: WebviewWindow<R>,
    was_focused: bool,
}

struct ContextScreenshotWindowGuard<R: Runtime> {
    app_handle: AppHandle<R>,
    hidden_windows: Vec<HiddenContextScreenshotWindow<R>>,
    entered_context_screenshot_window_hide: bool,
}

impl<R: Runtime> ContextScreenshotWindowGuard<R> {
    fn hide_visible_touchai_windows(app_handle: &AppHandle<R>) -> Self {
        let entered_context_screenshot_window_hide = app_handle
            .try_state::<crate::core::window::search::surface::SearchSurfaceRuntime>()
            .map(|runtime| {
                runtime.enter_context_screenshot_window_hide();
            })
            .is_some();

        let mut windows = app_handle
            .webview_windows()
            .into_iter()
            .filter(|(label, _)| should_hide_window_for_context_screenshot(label))
            .collect::<Vec<_>>();
        windows.sort_by(|(left_label, _), (right_label, _)| {
            context_screenshot_window_hide_priority(left_label)
                .cmp(&context_screenshot_window_hide_priority(right_label))
                .then_with(|| left_label.cmp(right_label))
        });

        let mut hidden_windows = Vec::new();
        for (label, window) in windows {
            if !window.is_visible().unwrap_or(false) {
                continue;
            }

            let was_focused = window.is_focused().unwrap_or(false);
            match window.hide() {
                Ok(()) => hidden_windows.push(HiddenContextScreenshotWindow {
                    label,
                    window,
                    was_focused,
                }),
                Err(error) => log::warn!(
                    "Failed to temporarily hide TouchAI window for context screenshot: {}",
                    error
                ),
            }
        }

        if !hidden_windows.is_empty() {
            thread::sleep(Duration::from_millis(80));
        }

        Self {
            app_handle: app_handle.clone(),
            hidden_windows,
            entered_context_screenshot_window_hide,
        }
    }
}

impl<R: Runtime> Drop for ContextScreenshotWindowGuard<R> {
    fn drop(&mut self) {
        for hidden_window in self.hidden_windows.iter().rev() {
            if let Err(error) = hidden_window.window.show() {
                log::warn!(
                    "Failed to restore TouchAI window '{}' after context screenshot: {}",
                    hidden_window.label,
                    error
                );
                continue;
            }
            if hidden_window.was_focused {
                if let Err(error) = hidden_window.window.set_focus() {
                    log::warn!(
                        "Failed to restore TouchAI window '{}' focus after context screenshot: {}",
                        hidden_window.label,
                        error
                    );
                }
            }
        }

        if self.entered_context_screenshot_window_hide {
            if !self.hidden_windows.is_empty() {
                thread::sleep(Duration::from_millis(80));
            }
            if let Some(runtime) =
                self.app_handle
                    .try_state::<crate::core::window::search::surface::SearchSurfaceRuntime>()
            {
                runtime.leave_context_screenshot_window_hide();
            }
        }
    }
}

fn capture_screenshot_result<R: Runtime>(
    app_handle: &AppHandle<R>,
    capsule_id: &str,
    captured_at: &str,
    active_window: Option<&DesktopContextActiveWindow>,
    target: &'static str,
) -> Result<DesktopContextScreenshot, String> {
    let data_root = app_directory_path(AppDirectory::Data)?;
    let target_path = screenshot_artifact_path(data_root, capsule_id);
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("Failed to create desktop context screenshot directory: {error}")
        })?;
    }

    let image = {
        let _touchai_window_guard =
            ContextScreenshotWindowGuard::hide_visible_touchai_windows(app_handle);
        match target {
            "active_window" => capture_active_window_image(active_window)?,
            "all_displays" => capture_all_displays_image()?,
            _ => capture_active_display_image(active_window)?,
        }
    };
    let width = image.width();
    let height = image.height();
    image
        .save(&target_path)
        .map_err(|error| format!("Failed to save desktop context screenshot: {error}"))?;

    Ok(DesktopContextScreenshot {
        available: true,
        path: Some(target_path.to_string_lossy().into_owned()),
        mime_type: Some("image/png".to_string()),
        width: Some(width),
        height: Some(height),
        target: target.to_string(),
        persisted: true,
        captured_at: Some(captured_at.to_string()),
        // OCR 文本在 capture_sensitive 里按开关对已保存 PNG 回填。
        ocr_text: None,
        reason: None,
    })
}

/// 对已保存的截图 PNG 运行一次 OCR 文字识别。
///
/// 成功返回识别到的非空文本；无文字、识别失败或平台不支持时返回 `None`（仅记日志）。
/// OCR 文本让非视觉模型也能利用屏幕内容，但不影响截图本身的可用性。
fn capture_screenshot_ocr(path: &str) -> Option<String> {
    match capture_screenshot_ocr_result(path) {
        Ok(text) => text,
        Err(error) => {
            log::debug!("Failed to OCR desktop context screenshot: {}", error);
            None
        }
    }
}

#[cfg(target_os = "windows")]
fn capture_screenshot_ocr_result(path: &str) -> Result<Option<String>, String> {
    use windows::{
        Graphics::Imaging::BitmapDecoder,
        Media::Ocr::OcrEngine,
        Storage::{FileAccessMode, StorageFile},
        core::HSTRING,
    };

    // OCR 文本上限，避免超大截图产出过长文本拖垮 prompt。
    const OCR_TEXT_LIMIT: usize = 20_000;

    let hpath = HSTRING::from(path);
    let file = StorageFile::GetFileFromPathAsync(&hpath)
        .map_err(|error| format!("Failed to open screenshot for OCR: {error}"))?
        .get()
        .map_err(|error| format!("Failed to await screenshot file for OCR: {error}"))?;
    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .map_err(|error| format!("Failed to open screenshot stream for OCR: {error}"))?
        .get()
        .map_err(|error| format!("Failed to await screenshot stream for OCR: {error}"))?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|error| format!("Failed to create bitmap decoder for OCR: {error}"))?
        .get()
        .map_err(|error| format!("Failed to await bitmap decoder for OCR: {error}"))?;
    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|error| format!("Failed to read software bitmap for OCR: {error}"))?
        .get()
        .map_err(|error| format!("Failed to await software bitmap for OCR: {error}"))?;

    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|error| format!("Failed to create OCR engine: {error}"))?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|error| format!("Failed to start OCR: {error}"))?
        .get()
        .map_err(|error| format!("Failed to await OCR result: {error}"))?;
    let text = result
        .Text()
        .map_err(|error| format!("Failed to read OCR text: {error}"))?
        .to_string();

    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let stored = if trimmed.chars().count() > OCR_TEXT_LIMIT {
        trimmed.chars().take(OCR_TEXT_LIMIT).collect()
    } else {
        trimmed.to_string()
    };
    Ok(Some(stored))
}

#[cfg(not(target_os = "windows"))]
fn capture_screenshot_ocr_result(_path: &str) -> Result<Option<String>, String> {
    Err("Screenshot OCR is only implemented on Windows.".to_string())
}

fn capture_active_display_image(
    active_window: Option<&DesktopContextActiveWindow>,
) -> Result<RgbaImage, String> {
    let monitor = select_capture_monitor(active_window)?;
    monitor
        .capture_image()
        .map_err(|error| format!("Failed to capture active display screenshot: {error}"))
}

fn parse_window_provider_id(handle: Option<&str>) -> Option<u32> {
    let value = handle?.trim();
    if let Some(hex) = value.strip_prefix("0x") {
        return u32::from_str_radix(hex, 16).ok();
    }
    if let Some(decimal) = value.strip_prefix("xcap-window-") {
        return decimal.parse::<u32>().ok();
    }
    value.parse::<u32>().ok()
}

fn find_xcap_window_for_active_window(
    active_window: &DesktopContextActiveWindow,
) -> Result<Window, String> {
    let target_id = parse_window_provider_id(active_window.window_handle.as_deref());
    let windows = Window::all().map_err(|error| format!("Failed to enumerate windows: {error}"))?;

    if let Some(target_id) = target_id {
        if let Some(window) = windows
            .iter()
            .find(|window| window.id().ok() == Some(target_id))
        {
            return Ok(window.clone());
        }
    }

    let expected_pid = active_window.process_id;
    let expected_title = active_window
        .title
        .as_deref()
        .filter(|title| !title.is_empty());
    windows
        .into_iter()
        .find(|window| {
            expected_pid.is_some_and(|pid| window.pid().ok() == Some(pid))
                && expected_title.is_none_or(|title| window.title().ok().as_deref() == Some(title))
        })
        .ok_or_else(|| {
            "Failed to find the invocation active window for screenshot capture.".to_string()
        })
}

fn capture_active_window_region_fallback(
    active_window: &DesktopContextActiveWindow,
) -> Result<RgbaImage, String> {
    let bounds = active_window
        .bounds
        .as_ref()
        .ok_or_else(|| "Active window bounds are unavailable.".to_string())?;
    if bounds.width <= 0 || bounds.height <= 0 {
        return Err("Active window bounds are empty.".to_string());
    }

    let monitor = select_capture_monitor(Some(active_window))?;
    let monitor_x = monitor
        .x()
        .map_err(|error| format!("Failed to read monitor x coordinate: {error}"))?;
    let monitor_y = monitor
        .y()
        .map_err(|error| format!("Failed to read monitor y coordinate: {error}"))?;
    let relative_x = bounds.x.saturating_sub(monitor_x);
    let relative_y = bounds.y.saturating_sub(monitor_y);
    if relative_x < 0 || relative_y < 0 {
        return Err("Active window is outside the selected monitor capture bounds.".to_string());
    }

    monitor
        .capture_region(
            relative_x as u32,
            relative_y as u32,
            bounds.width as u32,
            bounds.height as u32,
        )
        .map_err(|error| format!("Failed to capture active window screenshot region: {error}"))
}

fn capture_active_window_image(
    active_window: Option<&DesktopContextActiveWindow>,
) -> Result<RgbaImage, String> {
    let active_window = active_window.ok_or_else(|| {
        "No invocation active window is available for screenshot capture.".to_string()
    })?;
    if let Ok(window) = find_xcap_window_for_active_window(active_window) {
        if let Ok(image) = window.capture_image() {
            return Ok(image);
        }
    }

    capture_active_window_region_fallback(active_window)
}

fn capture_all_displays_image() -> Result<RgbaImage, String> {
    struct CapturedDisplay {
        x: i32,
        y: i32,
        image: RgbaImage,
    }

    let monitors =
        Monitor::all().map_err(|error| format!("Failed to enumerate monitors: {error}"))?;
    let mut captures = Vec::new();
    for monitor in monitors {
        let x = monitor
            .x()
            .map_err(|error| format!("Failed to read monitor x coordinate: {error}"))?;
        let y = monitor
            .y()
            .map_err(|error| format!("Failed to read monitor y coordinate: {error}"))?;
        let image = monitor
            .capture_image()
            .map_err(|error| format!("Failed to capture monitor screenshot: {error}"))?;
        captures.push(CapturedDisplay { x, y, image });
    }

    if captures.is_empty() {
        return Err("No monitor is available for screenshot capture.".to_string());
    }

    let min_x = captures.iter().map(|capture| capture.x).min().unwrap_or(0);
    let min_y = captures.iter().map(|capture| capture.y).min().unwrap_or(0);
    let max_x = captures
        .iter()
        .map(|capture| capture.x.saturating_add(capture.image.width() as i32))
        .max()
        .unwrap_or(0);
    let max_y = captures
        .iter()
        .map(|capture| capture.y.saturating_add(capture.image.height() as i32))
        .max()
        .unwrap_or(0);
    let width = max_x.saturating_sub(min_x) as u32;
    let height = max_y.saturating_sub(min_y) as u32;
    if width == 0 || height == 0 {
        return Err("Combined display screenshot bounds are empty.".to_string());
    }

    let mut canvas = RgbaImage::new(width, height);
    for capture in captures {
        imageops::overlay(
            &mut canvas,
            &capture.image,
            i64::from(capture.x.saturating_sub(min_x)),
            i64::from(capture.y.saturating_sub(min_y)),
        );
    }

    Ok(canvas)
}

fn build_capabilities(
    active_window: &CaptureOutcome<DesktopContextActiveWindow>,
    selected_text: &DesktopContextSelectedText,
    clipboard: &DesktopContextClipboard,
    screenshot: &DesktopContextScreenshot,
) -> Vec<DesktopContextCapability> {
    vec![
        DesktopContextCapability {
            id: "active_window".to_string(),
            supported: active_window.value.is_some(),
            method: active_window.method.to_string(),
            reason: active_window.reason.clone(),
        },
        DesktopContextCapability {
            id: "clipboard".to_string(),
            supported: clipboard.available,
            method: "clipboard-runtime-snapshot".to_string(),
            reason: clipboard.reason.clone(),
        },
        DesktopContextCapability {
            id: "selected_text".to_string(),
            supported: selected_text.available,
            method: selected_text
                .source
                .clone()
                .unwrap_or_else(|| selected_text_provider_method().to_string()),
            reason: selected_text.reason.clone(),
        },
        DesktopContextCapability {
            id: "screenshot".to_string(),
            supported: screenshot.available,
            method: "xcap-monitor-capture".to_string(),
            reason: screenshot.reason.clone(),
        },
    ]
}

fn build_initial_capabilities(
    active_window: &CaptureOutcome<DesktopContextActiveWindow>,
    selected_text: &DesktopContextSelectedText,
    clipboard: &DesktopContextClipboard,
) -> Vec<DesktopContextCapability> {
    build_capabilities(
        active_window,
        selected_text,
        clipboard,
        &pending_screenshot(),
    )
}

fn build_sensitive_capabilities(
    active_window: Option<&DesktopContextActiveWindow>,
    selected_text: &DesktopContextSelectedText,
    clipboard: &DesktopContextClipboard,
    screenshot: &DesktopContextScreenshot,
) -> Vec<DesktopContextCapability> {
    build_capabilities(
        &CaptureOutcome {
            value: active_window.cloned(),
            method: "captured-invocation-active-window",
            reason: active_window
                .is_none()
                .then(|| "No active window metadata was captured at invocation time.".to_string()),
        },
        selected_text,
        clipboard,
        screenshot,
    )
}

fn sensitive_redactions() -> Vec<DesktopContextRedaction> {
    vec![
        DesktopContextRedaction {
            field: "selectedText.fullText".to_string(),
            reason: "Selected text is captured at invocation, but raw full text is only returned after explicit user approval for selected_text.full_text.".to_string(),
        },
        DesktopContextRedaction {
            field: "clipboard.fullText".to_string(),
            reason: "Only read after explicit user approval for clipboard.full_text.".to_string(),
        },
        DesktopContextRedaction {
            field: "screenshot.path".to_string(),
            reason: "Only captured and returned after explicit user approval for screenshot."
                .to_string(),
        },
    ]
}

fn build_summary(
    active_window: Option<&DesktopContextActiveWindow>,
    selected_text: &DesktopContextSelectedText,
    clipboard: &DesktopContextClipboard,
    screenshot: &DesktopContextScreenshot,
    document: &DesktopContextDocument,
) -> String {
    let mut parts = Vec::new();
    if let Some(title) = active_window.and_then(|window| window.title.as_deref()) {
        if !title.trim().is_empty() {
            parts.push(format!("Active window: {title}"));
        }
    }
    if let Some(browser_url) = active_window.and_then(|window| window.browser_url.as_deref()) {
        if !browser_url.trim().is_empty() {
            parts.push(format!("Browser URL: {browser_url}"));
        }
    }
    if selected_text.available {
        parts.push(format!(
            "Selected text length: {}",
            selected_text.text_length
        ));
    }
    if document.available {
        parts.push(format!("Document text length: {}", document.text_length));
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

fn capture_active_window() -> CaptureOutcome<DesktopContextActiveWindow> {
    match capture_active_window_with_xcap() {
        Ok(active_window) => CaptureOutcome {
            value: Some(active_window),
            method: "xcap-focused-window",
            reason: None,
        },
        Err(error) => capture_active_window_fallback(error),
    }
}

fn capture_active_window_with_xcap() -> Result<DesktopContextActiveWindow, String> {
    let windows = Window::all().map_err(|error| format!("Failed to enumerate windows: {error}"))?;
    let focused_window = windows
        .into_iter()
        .find_map(|window| match window.is_focused() {
            Ok(true) => Some(window),
            _ => None,
        })
        .ok_or_else(|| "No focused window was reported by the window provider.".to_string())?;

    let title = focused_window
        .title()
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let app_name = focused_window
        .app_name()
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let width = focused_window
        .width()
        .ok()
        .and_then(|value| i32::try_from(value).ok());
    let height = focused_window
        .height()
        .ok()
        .and_then(|value| i32::try_from(value).ok());
    let bounds = match (
        focused_window.x().ok(),
        focused_window.y().ok(),
        width,
        height,
    ) {
        (Some(x), Some(y), Some(width), Some(height)) => Some(DesktopContextBounds {
            x,
            y,
            width,
            height,
        }),
        _ => None,
    };

    Ok(DesktopContextActiveWindow {
        title,
        app_name,
        process_name: None,
        process_id: focused_window.pid().ok(),
        window_handle: focused_window.id().ok().map(format_xcap_window_handle),
        bounds,
        browser_url: None,
    })
}

#[cfg(target_os = "windows")]
fn format_xcap_window_handle(id: u32) -> String {
    format!("0x{id:x}")
}

#[cfg(not(target_os = "windows"))]
fn format_xcap_window_handle(id: u32) -> String {
    format!("xcap-window-{id}")
}

#[cfg(target_os = "windows")]
fn capture_active_window_fallback(reason: String) -> CaptureOutcome<DesktopContextActiveWindow> {
    match capture_active_window_with_win32() {
        Some(active_window) => CaptureOutcome {
            value: Some(active_window),
            method: "win32-foreground-window",
            reason: None,
        },
        None => CaptureOutcome {
            value: None,
            method: "xcap-focused-window",
            reason: Some(reason),
        },
    }
}

#[cfg(not(target_os = "windows"))]
fn capture_active_window_fallback(reason: String) -> CaptureOutcome<DesktopContextActiveWindow> {
    CaptureOutcome {
        value: None,
        method: "xcap-focused-window",
        reason: Some(reason),
    }
}

#[cfg(target_os = "windows")]
fn capture_active_window_with_win32() -> Option<DesktopContextActiveWindow> {
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
            browser_url: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{
        evict_excess_capsules, screenshot_artifact_path, selected_text_from_text,
        selected_text_from_utf16_range, should_hide_window_for_context_screenshot,
        DesktopContextCapsule, DesktopContextClipboard, DesktopContextDocument,
        DesktopContextScreenshot, DesktopContextSelectedText, MAX_RETAINED_CAPSULES,
        SELECTED_TEXT_LIMIT,
    };
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn test_capsule(sequence: u64) -> DesktopContextCapsule {
        DesktopContextCapsule {
            id: format!("desktop-context-{sequence}"),
            sequence,
            captured_at: "2026-01-01T00:00:00.000Z".to_string(),
            invocation_source: "shortcut".to_string(),
            platform: "test".to_string(),
            summary: String::new(),
            active_window: None,
            selected_text: DesktopContextSelectedText {
                available: false,
                source: None,
                text: None,
                text_length: 0,
                truncated: false,
                reason: None,
            },
            clipboard: DesktopContextClipboard {
                available: false,
                snapshot_id: None,
                observed_at: None,
                text: None,
                text_summary: None,
                text_length: 0,
                image_count: 0,
                file_count: 0,
                image_paths: Vec::new(),
                file_paths: Vec::new(),
                reason: None,
            },
            screenshot: DesktopContextScreenshot {
                available: false,
                path: None,
                mime_type: None,
                width: None,
                height: None,
                target: "active_display".to_string(),
                persisted: false,
                captured_at: None,
                ocr_text: None,
                reason: None,
            },
            document: DesktopContextDocument {
                available: false,
                source: None,
                text: None,
                text_length: 0,
                truncated: false,
                reason: None,
            },
            capabilities: Vec::new(),
            redactions: Vec::new(),
        }
    }

    #[test]
    fn evict_excess_capsules_drops_oldest_by_sequence() {
        let mut capsules = HashMap::new();
        let total = MAX_RETAINED_CAPSULES + 5;
        for sequence in 1..=total as u64 {
            let capsule = test_capsule(sequence);
            capsules.insert(capsule.id.clone(), capsule);
        }

        evict_excess_capsules(&mut capsules);

        assert_eq!(capsules.len(), MAX_RETAINED_CAPSULES);
        // 最旧的 5 个（sequence 1..=5）应被淘汰，最新的保留。
        for sequence in 1..=5u64 {
            assert!(!capsules.contains_key(&format!("desktop-context-{sequence}")));
        }
        assert!(capsules.contains_key(&format!("desktop-context-{total}")));
    }

    #[test]
    fn context_screenshot_hides_only_transient_touchai_windows() {
        assert!(should_hide_window_for_context_screenshot("main"));
        assert!(should_hide_window_for_context_screenshot("tray-menu"));
        assert!(should_hide_window_for_context_screenshot(
            "popup-model-dropdown-popup"
        ));
        assert!(!should_hide_window_for_context_screenshot("settings"));
        assert!(!should_hide_window_for_context_screenshot("assistant-log"));
    }

    #[test]
    fn screenshot_artifact_path_stays_under_desktop_context_directory() {
        let path =
            screenshot_artifact_path(PathBuf::from("E:/TouchAI/data"), "../desktop-context-7");

        assert_eq!(
            path,
            PathBuf::from("E:/TouchAI/data")
                .join("desktop-context")
                .join("screenshots")
                .join("___desktop-context-7.png")
        );
    }

    #[test]
    fn selected_text_payload_truncates_large_selections() {
        let text = "a".repeat(SELECTED_TEXT_LIMIT + 7);

        let selected_text = selected_text_from_text("test-provider", text);

        assert!(selected_text.available);
        assert!(selected_text.truncated);
        assert_eq!(selected_text.text_length, SELECTED_TEXT_LIMIT + 7);
        assert_eq!(
            selected_text.text.unwrap().chars().count(),
            SELECTED_TEXT_LIMIT
        );
    }

    #[test]
    fn selected_text_from_utf16_range_reads_native_control_offsets() {
        let text = "before selected text after"
            .encode_utf16()
            .collect::<Vec<u16>>();
        let start = "before ".encode_utf16().count();
        let end = start + "selected text".encode_utf16().count();

        let selected_text =
            selected_text_from_utf16_range("test-provider", &text, start, end).unwrap();

        assert!(selected_text.available);
        assert_eq!(selected_text.text.as_deref(), Some("selected text"));
        assert_eq!(selected_text.text_length, 13);
    }
}
