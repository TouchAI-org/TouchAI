use tauri::{AppHandle, Runtime};

pub fn install<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let app = app.clone();
        platform::ENABLED.store(true, std::sync::atomic::Ordering::Release);
        platform::install(move || {
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(error) = super::stop_all(&app) {
                    log::warn!("Computer-use emergency stop failed: {error}");
                }
            });
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
        let shortcut = Shortcut::new(None, Code::Escape);
        if app.global_shortcut().is_registered(shortcut) {
            return Ok(());
        }
        app.global_shortcut()
            .on_shortcut(shortcut, |app, _, event| {
                if event.state == ShortcutState::Pressed {
                    if let Err(error) = super::stop_all(app) {
                        log::warn!("Computer-use emergency stop failed: {error}");
                    }
                }
            })
            .map_err(|error| error.to_string())
    }
}

pub fn uninstall<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        platform::ENABLED.store(false, std::sync::atomic::Ordering::Release);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut};
        app.global_shortcut()
            .unregister(Shortcut::new(None, Code::Escape))
            .map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::sync::OnceLock;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
        KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
    };

    static STOP: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
    static INSTALLED: OnceLock<Result<(), String>> = OnceLock::new();
    pub static ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    fn is_user_escape(message: usize, key: u32, injected: bool) -> bool {
        matches!(message as u32, WM_KEYDOWN | WM_SYSKEYDOWN) && key == 0x1b && !injected
    }

    unsafe extern "system" fn keyboard(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
        if code >= 0 && ENABLED.load(std::sync::atomic::Ordering::Acquire) {
            let event = &*(data.0 as *const KBDLLHOOKSTRUCT);
            if is_user_escape(
                message.0,
                event.vkCode,
                event.flags.contains(LLKHF_INJECTED),
            ) {
                if let Some(stop) = STOP.get() {
                    stop();
                }
            }
        }
        CallNextHookEx(None, code, message, data)
    }

    pub fn install(stop: impl Fn() + Send + Sync + 'static) -> Result<(), String> {
        INSTALLED
            .get_or_init(|| {
                let _ = STOP.set(Box::new(stop));
                let (sender, receiver) = std::sync::mpsc::sync_channel(1);
                std::thread::Builder::new()
                    .name("computer-use-stop".into())
                    .spawn(move || unsafe {
                        match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), None, 0) {
                            Ok(_hook) => {
                                let _ = sender.send(Ok(()));
                                let mut message = MSG::default();
                                while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                                    let _ = TranslateMessage(&message);
                                    DispatchMessageW(&message);
                                }
                            }
                            Err(error) => {
                                let _ = sender.send(Err(error.to_string()));
                            }
                        }
                    })
                    .map_err(|error| error.to_string())?;
                receiver
                    .recv_timeout(std::time::Duration::from_secs(2))
                    .map_err(|error| error.to_string())?
            })
            .clone()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn user_given_driver_generated_escape_when_dismissing_a_menu_then_does_not_stop_control() {
            assert!(!is_user_escape(WM_KEYDOWN as usize, 0x1b, true));
            assert!(is_user_escape(WM_KEYDOWN as usize, 0x1b, false));
            assert!(!is_user_escape(WM_KEYDOWN as usize, 0x41, false));
        }
    }
}
