// Copyright (c) 2026. 千诚. Licensed under GPL v3

//! 快捷键处理模块
//!
//! 负责解析、注册和处理全局快捷键

use log::warn;
use std::sync::Mutex;
use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

static CURRENT_SHORTCUT: Mutex<Option<Shortcut>> = Mutex::new(None);
static REGISTRATION_STATUS: Mutex<(bool, Option<String>)> = Mutex::new((false, None));

/// 先异步跳出 WM_HOTKEY 回调栈，再把搜索窗口切换投递回 Tauri 主事件循环。
fn schedule_search_window_toggle<R: Runtime>(app_handle: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let task_handle = app_handle.clone();
        if let Err(error) = app_handle.run_on_main_thread(move || {
            if let Err(error) = crate::core::window::show_search_window_from_shortcut(&task_handle)
            {
                warn!(
                    "Failed to toggle search window from global shortcut: {}",
                    error
                );
            }
        }) {
            warn!(
                "Failed to queue global shortcut task on main thread: {}",
                error
            );
        }
    });
}

pub fn create_shortcut_handler<R: Runtime>() -> impl Fn(&AppHandle<R>, &Shortcut, ShortcutEvent) {
    move |app_handle, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            schedule_search_window_toggle(app_handle.clone());
        }
    }
}

pub fn register_global_shortcut<R: Runtime>(
    app: AppHandle<R>,
    shortcut: String,
) -> Result<(), String> {
    let new_shortcut = parse_shortcut(&shortcut)?;

    let old_shortcut = CURRENT_SHORTCUT.lock().ok().and_then(|current| *current);
    if let Some(old_shortcut) = old_shortcut {
        if let Err(error) = app.global_shortcut().unregister(old_shortcut) {
            let message = format!("Failed to unregister previous shortcut: {}", error);
            if let Ok(mut status) = REGISTRATION_STATUS.lock() {
                *status = (true, Some(message.clone()));
            }
            return Err(message);
        }
    }

    let result = app
        .global_shortcut()
        .register(new_shortcut)
        .map_err(|e| format!("Failed to register shortcut: {}", e));

    if result.is_err() {
        if let Some(old_shortcut) = old_shortcut {
            let _ = app.global_shortcut().register(old_shortcut);
        }
    }

    match result {
        Ok(_) => {
            if let Ok(mut current) = CURRENT_SHORTCUT.lock() {
                *current = Some(new_shortcut);
            }
            if let Ok(mut status) = REGISTRATION_STATUS.lock() {
                *status = (false, None);
            }
        }
        Err(ref e) => {
            if let Ok(mut status) = REGISTRATION_STATUS.lock() {
                *status = (true, Some(e.clone()));
            }
        }
    }

    result
}

pub fn get_shortcut_status() -> (bool, Option<String>) {
    REGISTRATION_STATUS
        .lock()
        .map(|status| status.clone())
        .unwrap_or((false, None))
}

pub fn parse_shortcut(shortcut_str: &str) -> Result<Shortcut, String> {
    let parts: Vec<&str> = shortcut_str.split('+').map(|s| s.trim()).collect();

    if parts.is_empty() {
        return Err("Invalid shortcut format".to_string());
    }

    let mut modifiers = Modifiers::empty();
    let mut key_code: Option<Code> = None;

    for part in parts {
        match part.to_lowercase().as_str() {
            "ctrl" | "control" => modifiers |= Modifiers::CONTROL,
            "alt" | "option" => modifiers |= Modifiers::ALT,
            "shift" => modifiers |= Modifiers::SHIFT,
            // global-hotkey 把 Cmd / Win / Super 都映射到 Modifiers::SUPER；
            // HotKey::new 还会把 META 自动转为 SUPER，统一在这里直接发 SUPER。
            "cmd" | "command" | "meta" | "super" | "win" | "windows" => {
                modifiers |= Modifiers::SUPER
            }
            // 跨平台主修饰键别名：Mac 上为 Cmd（SUPER），其余平台为 Ctrl。
            // 与前端 utils/shortcuts.ts 的 `Mod` 抽象一致。
            "mod" => {
                if cfg!(target_os = "macos") {
                    modifiers |= Modifiers::SUPER;
                } else {
                    modifiers |= Modifiers::CONTROL;
                }
            }
            key => {
                key_code = Some(match key.to_lowercase().as_str() {
                    "space" => Code::Space,
                    "enter" | "return" => Code::Enter,
                    "tab" => Code::Tab,
                    "backspace" => Code::Backspace,
                    "escape" | "esc" => Code::Escape,
                    "delete" | "del" => Code::Delete,
                    "insert" => Code::Insert,
                    "home" => Code::Home,
                    "end" => Code::End,
                    "pageup" => Code::PageUp,
                    "pagedown" => Code::PageDown,
                    "arrowup" | "up" => Code::ArrowUp,
                    "arrowdown" | "down" => Code::ArrowDown,
                    "arrowleft" | "left" => Code::ArrowLeft,
                    "arrowright" | "right" => Code::ArrowRight,
                    "a" => Code::KeyA,
                    "b" => Code::KeyB,
                    "c" => Code::KeyC,
                    "d" => Code::KeyD,
                    "e" => Code::KeyE,
                    "f" => Code::KeyF,
                    "g" => Code::KeyG,
                    "h" => Code::KeyH,
                    "i" => Code::KeyI,
                    "j" => Code::KeyJ,
                    "k" => Code::KeyK,
                    "l" => Code::KeyL,
                    "m" => Code::KeyM,
                    "n" => Code::KeyN,
                    "o" => Code::KeyO,
                    "p" => Code::KeyP,
                    "q" => Code::KeyQ,
                    "r" => Code::KeyR,
                    "s" => Code::KeyS,
                    "t" => Code::KeyT,
                    "u" => Code::KeyU,
                    "v" => Code::KeyV,
                    "w" => Code::KeyW,
                    "x" => Code::KeyX,
                    "y" => Code::KeyY,
                    "z" => Code::KeyZ,
                    "0" => Code::Digit0,
                    "1" => Code::Digit1,
                    "2" => Code::Digit2,
                    "3" => Code::Digit3,
                    "4" => Code::Digit4,
                    "5" => Code::Digit5,
                    "6" => Code::Digit6,
                    "7" => Code::Digit7,
                    "8" => Code::Digit8,
                    "9" => Code::Digit9,
                    "f1" => Code::F1,
                    "f2" => Code::F2,
                    "f3" => Code::F3,
                    "f4" => Code::F4,
                    "f5" => Code::F5,
                    "f6" => Code::F6,
                    "f7" => Code::F7,
                    "f8" => Code::F8,
                    "f9" => Code::F9,
                    "f10" => Code::F10,
                    "f11" => Code::F11,
                    "f12" => Code::F12,
                    _ => return Err(format!("Unknown key: {}", key)),
                });
            }
        }
    }

    match key_code {
        Some(code) => Ok(Shortcut::new(
            if modifiers.is_empty() {
                None
            } else {
                Some(modifiers)
            },
            code,
        )),
        None => Err("No key code specified".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_shortcut_accepts_ctrl_alias() {
        let shortcut = parse_shortcut("Ctrl+Space").expect("ctrl+space parses");
        assert_eq!(shortcut.mods, Modifiers::CONTROL);
        assert_eq!(shortcut.key, Code::Space);
    }

    #[test]
    fn parse_shortcut_accepts_super_aliases_for_cmd_or_win() {
        // global-hotkey 把 Cmd（macOS）和 Win/Super（Linux）都映射到 SUPER；
        // 这里不区分平台，所有别名都应解析到 Modifiers::SUPER。
        for token in ["Cmd", "Command", "Meta", "Super", "Win", "Windows"] {
            let input = format!("{}+Space", token);
            let shortcut = parse_shortcut(&input)
                .unwrap_or_else(|error| panic!("{} should parse: {}", token, error));
            assert_eq!(
                shortcut.mods,
                Modifiers::SUPER,
                "{} should map to SUPER",
                token
            );
            assert_eq!(shortcut.key, Code::Space);
        }
    }

    #[test]
    fn parse_shortcut_mod_resolves_to_platform_primary() {
        let shortcut = parse_shortcut("Mod+Space").expect("mod+space parses");
        let expected = if cfg!(target_os = "macos") {
            Modifiers::SUPER
        } else {
            Modifiers::CONTROL
        };
        assert_eq!(shortcut.mods, expected);
        assert_eq!(shortcut.key, Code::Space);
    }

    #[test]
    fn parse_shortcut_combines_super_with_other_modifiers() {
        let shortcut = parse_shortcut("Cmd+Shift+T").expect("cmd+shift+t parses");
        assert_eq!(shortcut.mods, Modifiers::SUPER | Modifiers::SHIFT);
        assert_eq!(shortcut.key, Code::KeyT);
    }

    #[test]
    fn parse_shortcut_is_case_insensitive() {
        let shortcut = parse_shortcut("cmd+SPACE").expect("lowercase cmd parses");
        assert_eq!(shortcut.mods, Modifiers::SUPER);
        assert_eq!(shortcut.key, Code::Space);
    }
}
