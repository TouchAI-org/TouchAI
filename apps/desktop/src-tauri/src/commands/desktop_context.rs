// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

//! Desktop context commands.

use tauri::{AppHandle, Runtime, State};

use crate::core::system::desktop_context::{
    BoundDesktopContext, DesktopContextCapsule, DesktopContextRuntime,
};

#[tauri::command]
pub fn desktop_context_get_capsule(
    runtime: State<'_, DesktopContextRuntime>,
    capsule_id: String,
) -> Result<Option<DesktopContextCapsule>, String> {
    runtime.get_capsule(&capsule_id)
}

#[tauri::command]
pub fn desktop_context_bind_capsule(
    runtime: State<'_, DesktopContextRuntime>,
    capsule_id: String,
) -> Result<Option<BoundDesktopContext>, String> {
    runtime.bind_capsule(&capsule_id)
}

#[tauri::command]
pub fn desktop_context_capture_sensitive<R: Runtime>(
    app: AppHandle<R>,
    runtime: State<'_, DesktopContextRuntime>,
    capsule_id: String,
    include: Vec<String>,
    screenshot_target: Option<String>,
) -> Result<Option<DesktopContextCapsule>, String> {
    runtime.capture_sensitive(&app, &capsule_id, &include, screenshot_target.as_deref())
}
