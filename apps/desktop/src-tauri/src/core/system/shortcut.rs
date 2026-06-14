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
static SEARCH_SURFACE_SHORTCUTS: Mutex<Vec<SearchSurfaceShortcut>> = Mutex::new(Vec::new());

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSurfaceShortcutEntry {
    pub action_id: String,
    pub shortcut: String,
}

#[derive(Debug, Clone)]
struct SearchSurfaceShortcut {
    action_id: String,
    shortcut: String,
    parsed: Shortcut,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSurfaceCommand {
    pub action_id: String,
    pub shortcut: String,
    pub source: &'static str,
}

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
            if let Some(old_shortcut) = old_shortcut {
                match app.global_shortcut().register(old_shortcut) {
                    Ok(_) => {
                        if let Ok(mut status) = REGISTRATION_STATUS.lock() {
                            *status = (false, None);
                        }
                    }
                    Err(restore_error) => {
                        let message = format!(
                            "{}; failed to restore previous shortcut: {}",
                            e, restore_error
                        );
                        if let Ok(mut current) = CURRENT_SHORTCUT.lock() {
                            *current = None;
                        }
                        if let Ok(mut status) = REGISTRATION_STATUS.lock() {
                            *status = (true, Some(message));
                        }
                    }
                }
            } else if let Ok(mut status) = REGISTRATION_STATUS.lock() {
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

pub fn set_search_surface_shortcuts(
    entries: Vec<SearchSurfaceShortcutEntry>,
) -> Result<(), String> {
    let mut parsed_entries = Vec::with_capacity(entries.len());
    let mut parse_errors = Vec::new();
    for entry in entries {
        match parse_shortcut(&entry.shortcut) {
            Ok(parsed) => parsed_entries.push(SearchSurfaceShortcut {
                parsed,
                action_id: entry.action_id,
                shortcut: entry.shortcut,
            }),
            Err(error) => parse_errors.push(format!("{}: {}", entry.action_id, error)),
        }
    }

    let mut shortcuts = SEARCH_SURFACE_SHORTCUTS
        .lock()
        .map_err(|_| "Failed to lock search surface shortcuts".to_string())?;
    *shortcuts = parsed_entries;
    if parse_errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Ignored unsupported search surface shortcuts: {}",
            parse_errors.join("; ")
        ))
    }
}

pub fn find_search_surface_command_for_windows_accelerator(
    virtual_key: u32,
    control: bool,
    alt: bool,
    shift: bool,
    super_key: bool,
) -> Option<SearchSurfaceCommand> {
    let candidate = windows_accelerator_to_shortcut(virtual_key, control, alt, shift, super_key)?;
    let shortcuts = SEARCH_SURFACE_SHORTCUTS.lock().ok()?;
    shortcuts
        .iter()
        .find(|entry| entry.parsed.mods == candidate.mods && entry.parsed.key == candidate.key)
        .map(|entry| SearchSurfaceCommand {
            action_id: entry.action_id.clone(),
            shortcut: entry.shortcut.clone(),
            source: "webview2-accelerator",
        })
}

fn windows_accelerator_to_shortcut(
    virtual_key: u32,
    control: bool,
    alt: bool,
    shift: bool,
    super_key: bool,
) -> Option<Shortcut> {
    let key = windows_virtual_key_to_code(virtual_key)?;
    let mut modifiers = Modifiers::empty();
    if control {
        modifiers |= Modifiers::CONTROL;
    }
    if alt {
        modifiers |= Modifiers::ALT;
    }
    if shift {
        modifiers |= Modifiers::SHIFT;
    }
    if super_key {
        modifiers |= Modifiers::SUPER;
    }

    Some(Shortcut::new(
        if modifiers.is_empty() {
            None
        } else {
            Some(modifiers)
        },
        key,
    ))
}

fn windows_virtual_key_to_code(virtual_key: u32) -> Option<Code> {
    match virtual_key {
        0x08 => Some(Code::Backspace),
        0x09 => Some(Code::Tab),
        0x0D => Some(Code::Enter),
        0x1B => Some(Code::Escape),
        0x20 => Some(Code::Space),
        0x21 => Some(Code::PageUp),
        0x22 => Some(Code::PageDown),
        0x23 => Some(Code::End),
        0x24 => Some(Code::Home),
        0x25 => Some(Code::ArrowLeft),
        0x26 => Some(Code::ArrowUp),
        0x27 => Some(Code::ArrowRight),
        0x28 => Some(Code::ArrowDown),
        0x2D => Some(Code::Insert),
        0x2E => Some(Code::Delete),
        0x30 => Some(Code::Digit0),
        0x31 => Some(Code::Digit1),
        0x32 => Some(Code::Digit2),
        0x33 => Some(Code::Digit3),
        0x34 => Some(Code::Digit4),
        0x35 => Some(Code::Digit5),
        0x36 => Some(Code::Digit6),
        0x37 => Some(Code::Digit7),
        0x38 => Some(Code::Digit8),
        0x39 => Some(Code::Digit9),
        0x41 => Some(Code::KeyA),
        0x42 => Some(Code::KeyB),
        0x43 => Some(Code::KeyC),
        0x44 => Some(Code::KeyD),
        0x45 => Some(Code::KeyE),
        0x46 => Some(Code::KeyF),
        0x47 => Some(Code::KeyG),
        0x48 => Some(Code::KeyH),
        0x49 => Some(Code::KeyI),
        0x4A => Some(Code::KeyJ),
        0x4B => Some(Code::KeyK),
        0x4C => Some(Code::KeyL),
        0x4D => Some(Code::KeyM),
        0x4E => Some(Code::KeyN),
        0x4F => Some(Code::KeyO),
        0x50 => Some(Code::KeyP),
        0x51 => Some(Code::KeyQ),
        0x52 => Some(Code::KeyR),
        0x53 => Some(Code::KeyS),
        0x54 => Some(Code::KeyT),
        0x55 => Some(Code::KeyU),
        0x56 => Some(Code::KeyV),
        0x57 => Some(Code::KeyW),
        0x58 => Some(Code::KeyX),
        0x59 => Some(Code::KeyY),
        0x5A => Some(Code::KeyZ),
        0x70 => Some(Code::F1),
        0x71 => Some(Code::F2),
        0x72 => Some(Code::F3),
        0x73 => Some(Code::F4),
        0x74 => Some(Code::F5),
        0x75 => Some(Code::F6),
        0x76 => Some(Code::F7),
        0x77 => Some(Code::F8),
        0x78 => Some(Code::F9),
        0x79 => Some(Code::F10),
        0x7A => Some(Code::F11),
        0x7B => Some(Code::F12),
        0xBA => Some(Code::Semicolon),
        0xBB => Some(Code::Equal),
        0xBC => Some(Code::Comma),
        0xBD => Some(Code::Minus),
        0xBE => Some(Code::Period),
        0xBF => Some(Code::Slash),
        0xC0 => Some(Code::Backquote),
        0xDB => Some(Code::BracketLeft),
        0xDC => Some(Code::Backslash),
        0xDD => Some(Code::BracketRight),
        0xDE => Some(Code::Quote),
        _ => None,
    }
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
                if key_code.is_some() {
                    return Err("Shortcut must contain exactly one key code".to_string());
                }
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
                    "," | "comma" => Code::Comma,
                    "." | "period" => Code::Period,
                    "=" | "equal" | "equals" => Code::Equal,
                    "-" | "minus" => Code::Minus,
                    ";" | "semicolon" => Code::Semicolon,
                    "/" | "slash" => Code::Slash,
                    "'" | "quote" => Code::Quote,
                    "`" | "backquote" => Code::Backquote,
                    "[" | "bracketleft" => Code::BracketLeft,
                    "]" | "bracketright" => Code::BracketRight,
                    "\\" | "backslash" => Code::Backslash,
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
    use std::sync::Mutex;

    static SEARCH_SURFACE_SHORTCUT_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn parse_shortcut_accepts_ctrl_alias() {
        let shortcut = parse_shortcut("Ctrl+Space").expect("ctrl+space parses");
        assert_eq!(shortcut.mods, Modifiers::CONTROL);
        assert_eq!(shortcut.key, Code::Space);
    }

    #[test]
    fn parse_shortcut_accepts_option_alias_for_alt() {
        let shortcut = parse_shortcut("Option+Shift+Space").expect("option+shift+space parses");
        assert_eq!(shortcut.mods, Modifiers::ALT | Modifiers::SHIFT);
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

    #[test]
    fn parse_shortcut_accepts_punctuation_keys() {
        let shortcut = parse_shortcut("Mod+,").expect("mod+comma parses");
        let expected_mod = if cfg!(target_os = "macos") {
            Modifiers::SUPER
        } else {
            Modifiers::CONTROL
        };
        assert_eq!(shortcut.mods, expected_mod);
        assert_eq!(shortcut.key, Code::Comma);

        let shortcut = parse_shortcut("Ctrl+=").expect("ctrl+equal parses");
        assert_eq!(shortcut.mods, Modifiers::CONTROL);
        assert_eq!(shortcut.key, Code::Equal);
    }

    #[test]
    fn parse_shortcut_rejects_multiple_key_codes() {
        let error = parse_shortcut("Ctrl+A+B").expect_err("multiple keys should be rejected");
        assert_eq!(error, "Shortcut must contain exactly one key code");
    }

    #[test]
    fn search_surface_command_matches_windows_accelerator() {
        let _guard = SEARCH_SURFACE_SHORTCUT_TEST_LOCK.lock().expect("test lock");
        set_search_surface_shortcuts(vec![
            SearchSurfaceShortcutEntry {
                action_id: "search.model.toggle".to_string(),
                shortcut: "Mod+M".to_string(),
            },
            SearchSurfaceShortcutEntry {
                action_id: "search.settings.open".to_string(),
                shortcut: "Mod+,".to_string(),
            },
        ])
        .expect("shortcuts sync");

        let command = find_search_surface_command_for_windows_accelerator(
            0xBC,
            !cfg!(target_os = "macos"),
            false,
            false,
            cfg!(target_os = "macos"),
        )
        .expect("comma shortcut matches");
        assert_eq!(command.action_id, "search.settings.open");
        assert_eq!(command.shortcut, "Mod+,");

        assert!(find_search_surface_command_for_windows_accelerator(
            0x4D, false, false, false, false
        )
        .is_none());
    }

    #[test]
    fn search_surface_command_matches_alt_space_windows_system_accelerator() {
        let _guard = SEARCH_SURFACE_SHORTCUT_TEST_LOCK.lock().expect("test lock");
        set_search_surface_shortcuts(vec![SearchSurfaceShortcutEntry {
            action_id: "search.model.toggle".to_string(),
            shortcut: "Alt+Space".to_string(),
        }])
        .expect("shortcuts sync");

        let command =
            find_search_surface_command_for_windows_accelerator(0x20, false, true, false, false)
                .expect("alt+space shortcut matches");
        assert_eq!(command.action_id, "search.model.toggle");
        assert_eq!(command.shortcut, "Alt+Space");
    }

    #[test]
    fn search_surface_shortcut_sync_drops_invalid_entries_without_retaining_old_commands() {
        let _guard = SEARCH_SURFACE_SHORTCUT_TEST_LOCK.lock().expect("test lock");
        set_search_surface_shortcuts(vec![SearchSurfaceShortcutEntry {
            action_id: "search.model.toggle".to_string(),
            shortcut: "Mod+M".to_string(),
        }])
        .expect("initial shortcut sync");

        let result = set_search_surface_shortcuts(vec![
            SearchSurfaceShortcutEntry {
                action_id: "search.model.toggle".to_string(),
                shortcut: "Mod+F13".to_string(),
            },
            SearchSurfaceShortcutEntry {
                action_id: "search.settings.open".to_string(),
                shortcut: "Mod+,".to_string(),
            },
        ]);

        assert!(result.is_err());
        assert!(find_search_surface_command_for_windows_accelerator(
            0x4D,
            !cfg!(target_os = "macos"),
            false,
            false,
            cfg!(target_os = "macos"),
        )
        .is_none());
        let command = find_search_surface_command_for_windows_accelerator(
            0xBC,
            !cfg!(target_os = "macos"),
            false,
            false,
            cfg!(target_os = "macos"),
        )
        .expect("valid shortcut remains synced");
        assert_eq!(command.action_id, "search.settings.open");
    }
}
