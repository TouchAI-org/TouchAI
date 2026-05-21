// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 剪贴板命令。

use tauri::State;

use crate::core::system::clipboard::{ClipboardPayload, ClipboardRuntime};

/// 读取当前剪贴板标准化 payload。
#[tauri::command]
pub fn read_clipboard_payload(
    runtime: State<'_, ClipboardRuntime>,
) -> Result<Option<ClipboardPayload>, String> {
    runtime.read_clipboard_payload()
}

/// 消费一次快捷键授权的 auto-paste payload。
#[tauri::command]
pub fn consume_shortcut_auto_paste_payload(
    runtime: State<'_, ClipboardRuntime>,
    max_age_ms: u64,
) -> Result<Option<ClipboardPayload>, String> {
    runtime.consume_shortcut_auto_paste_payload(max_age_ms)
}

/// 将文本写入系统剪贴板。
#[tauri::command]
pub fn write_clipboard_text(
    runtime: State<'_, ClipboardRuntime>,
    text: String,
) -> Result<(), String> {
    runtime.write_text(text)
}
