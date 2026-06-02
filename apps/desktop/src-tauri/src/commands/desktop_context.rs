// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

//! Desktop context commands.

use tauri::State;

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
