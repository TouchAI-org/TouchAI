// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 运行时模式与环境开关。

use std::path::PathBuf;

const TOUCHAI_APP_ROOT_ENV: &str = "TOUCHAI_APP_ROOT";
const TOUCHAI_E2E_ENV: &str = "TOUCHAI_E2E";
const TOUCHAI_E2E_DISABLE_SINGLE_INSTANCE_ENV: &str = "TOUCHAI_E2E_DISABLE_SINGLE_INSTANCE";
const TOUCHAI_UI_PREVIEW_ENV: &str = "TOUCHAI_UI_PREVIEW";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub is_e2e_test_mode: bool,
    pub is_ui_preview_mode: bool,
}

impl RuntimeInfo {
    pub fn current() -> Self {
        Self {
            is_e2e_test_mode: is_e2e_test_mode(),
            is_ui_preview_mode: is_ui_preview_mode(),
        }
    }
}

pub fn is_e2e_test_mode() -> bool {
    matches!(
        std::env::var(TOUCHAI_E2E_ENV)
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

pub fn can_show_startup_failure_dialog() -> bool {
    if is_e2e_test_mode() {
        return false;
    }

    #[cfg(target_os = "linux")]
    {
        has_linux_display(
            std::env::var_os("DISPLAY"),
            std::env::var_os("WAYLAND_DISPLAY"),
        )
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

#[cfg(any(target_os = "linux", test))]
fn has_linux_display(
    display: Option<std::ffi::OsString>,
    wayland_display: Option<std::ffi::OsString>,
) -> bool {
    display
        .into_iter()
        .chain(wayland_display)
        .any(|address| !address.is_empty())
}

/// The preview records a fixed-size, centered window. Content-driven resizes
/// would move the window while the viewer is reading it, so they are disabled
/// in this mode and the recorder sets the window frame once before capture.
pub fn is_ui_preview_mode() -> bool {
    matches!(
        std::env::var(TOUCHAI_UI_PREVIEW_ENV)
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// WebView2 browser arguments applied only in E2E mode.
///
/// wry defaults to `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`.
/// Providing `additional_browser_args` replaces that default, so keep those flags.
/// GitHub Windows runners with WebView2 150+ also need remote debugging for
/// tauri-driver/msedgedriver session creation (DevToolsActivePort).
pub fn e2e_webview_additional_browser_args() -> Option<String> {
    if !is_e2e_test_mode() {
        return None;
    }

    if let Ok(configured) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        let trimmed = configured.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    Some(DEFAULT_E2E_WEBVIEW_ADDITIONAL_BROWSER_ARGS.to_string())
}

const DEFAULT_E2E_WEBVIEW_ADDITIONAL_BROWSER_ARGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection ",
    "--remote-debugging-port=9222 ",
    "--enable-features=msEdgeDevToolsWdpRemoteDebugging ",
    "--no-sandbox ",
    "--disable-gpu ",
    "--disable-dev-shm-usage"
);

/// Browser arguments for every WebView2 window outside E2E mode.
///
/// Chromium throttles timers, renderers and occlusion for windows that are not
/// focused or are covered. A launcher is covered most of its life, so those
/// defaults make the first frame after a shortcut slow. Raycast keeps Chromium
/// from throttling its WebView for the same reason; these are the equivalent
/// WebView2 switches.
///
/// The first window creates the shared WebView2 environment, so every window
/// creation path must pass an identical value. Providing arguments replaces
/// wry's defaults, hence `msWebOOUI`, `msPdfOOUI` and `msSmartScreenProtection`
/// are repeated here.
#[cfg(target_os = "windows")]
const DEFAULT_PRODUCTION_WEBVIEW_ADDITIONAL_BROWSER_ARGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion ",
    "--disable-background-timer-throttling ",
    "--disable-backgrounding-occluded-windows ",
    "--disable-renderer-backgrounding"
);

/// The arguments this build asks for when nobody else configured any. Leaf of
/// the precedence chain: it reads nothing, so callers cannot recurse through it.
fn default_webview_browser_arguments() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        if is_e2e_test_mode() {
            return e2e_webview_additional_browser_args();
        }
        Some(DEFAULT_PRODUCTION_WEBVIEW_ADDITIONAL_BROWSER_ARGS.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// Browser arguments applied to the shared WebView2 environment.
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` still wins, matching wry's behavior.
pub fn webview_additional_browser_args() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        if is_e2e_test_mode() {
            return e2e_webview_additional_browser_args();
        }
        if let Ok(configured) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
            let trimmed = configured.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    browser_arguments_to_apply(None, webview2_policy_arguments().as_deref())
}

/// Additional browser arguments an administrator configured through the WebView2
/// `AdditionalBrowserArguments` policy.
///
/// The policy is a subkey under `Edge\\WebView2` whose value names are the
/// executable file name, an app id, or `*`, so the arguments have to be looked up
/// by name rather than read as a single value.
///
/// WebView2 checks the environment variable before the registry, so exporting
/// our defaults would shadow a policy that exists to be obeyed. The policy stays
/// authoritative for every window: it is machine configuration, not ours.
#[cfg(target_os = "windows")]
fn webview2_policy_arguments() -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    const POLICY_KEY: &str =
        "Software\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments";

    // WebView2 resolves an entry by the process's app user model id first, then
    // by the executable file name, then `*`. Read the id it will see: this runs
    // before anything sets an explicit one on this process.
    let candidates: Vec<String> = [process_app_user_model_id(), executable_file_name()]
        .into_iter()
        .flatten()
        .collect();

    // WebView2 reads machine policy before the user's.
    let hives = [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER].map(|hive| {
        RegKey::predef(hive)
            .open_subkey(POLICY_KEY)
            .ok()
            .map(|key| {
                key.enum_values()
                    .filter_map(Result::ok)
                    .filter_map(|(name, _)| {
                        key.get_value::<String, _>(&name)
                            .ok()
                            .map(|value| (name, value))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    });
    policy_arguments_from(&hives, &candidates)
}

/// The process's explicit app user model id, if one is already set.
#[cfg(target_os = "windows")]
fn process_app_user_model_id() -> Option<String> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::GetCurrentProcessExplicitAppUserModelID;

    unsafe {
        let id = GetCurrentProcessExplicitAppUserModelID().ok()?;
        if id.0.is_null() {
            return None;
        }
        let value = id.to_string().ok();
        CoTaskMemFree(Some(id.0 as *const core::ffi::c_void));
        value.filter(|value| !value.trim().is_empty())
    }
}

/// The file name WebView2 uses to resolve a policy entry.
#[cfg(target_os = "windows")]
fn executable_file_name() -> Option<String> {
    std::env::current_exe().ok().and_then(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
    })
}

/// Arguments of the first policy entry that applies to this process.
///
/// Hives are searched in the order WebView2 reads them, and a blank value is not
/// an argument string, so it must not stop the search: a blank machine entry
/// cannot hide a user entry.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn policy_arguments_from(hives: &[Vec<(String, String)>], candidates: &[String]) -> Option<String> {
    hives.iter().find_map(|entries| {
        let name = policy_entry_for(entries, candidates)?;
        entries
            .iter()
            .find(|(entry, _)| *entry == name)
            .map(|(_, value)| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

/// Which policy entry applies to this process.
///
/// The policy names its entries by app user model id, executable file name, or
/// `*`. Registry value names are case-insensitive, so candidates are matched that
/// way, in order, and an entry naming anything else does not apply.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn policy_entry_for(entries: &[(String, String)], candidates: &[String]) -> Option<String> {
    for candidate in candidates {
        if let Some((name, _)) = entries
            .iter()
            .find(|(entry, _)| entry.eq_ignore_ascii_case(candidate))
        {
            return Some(name.clone());
        }
    }
    entries
        .iter()
        .find(|(entry, _)| entry == "*")
        .map(|(name, _)| name.clone())
}

#[cfg(not(target_os = "windows"))]
fn webview2_policy_arguments() -> Option<String> {
    None
}

/// The search window is declared in `tauri.conf.json`, so it is created before
/// any code can hand it browser arguments. WebView2 reads this variable when it
/// builds the shared environment, and the first window builds that environment,
/// so setting it before the app starts is what actually keeps the launcher's
/// renderer from being backgrounded. An existing value still wins, which is how
/// E2E and manual overrides keep working.
pub fn apply_webview_browser_arguments_env() {
    let Some(arguments) = browser_arguments_to_apply(
        std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").as_deref(),
        webview2_policy_arguments().as_deref(),
    ) else {
        return;
    };
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", arguments);
}

/// Browser arguments to export for the shared WebView2 environment.
///
/// `None` means "leave WebView2 alone": the environment already defines its own
/// arguments, or an administrator policy does, and either outranks our defaults.
fn browser_arguments_to_apply(
    existing: Option<&std::ffi::OsStr>,
    policy: Option<&str>,
) -> Option<String> {
    if existing.is_some_and(|value| !value.is_empty()) {
        return None;
    }
    if policy.is_some_and(|value| !value.trim().is_empty()) {
        return None;
    }
    default_webview_browser_arguments().filter(|arguments| !arguments.trim().is_empty())
}

pub fn should_enable_single_instance() -> bool {
    !is_e2e_test_mode()
        && !matches!(
            std::env::var(TOUCHAI_E2E_DISABLE_SINGLE_INSTANCE_ENV)
                .ok()
                .map(|value| value.trim().to_ascii_lowercase())
                .as_deref(),
            Some("1" | "true" | "yes" | "on")
        )
}

pub fn resolve_app_root_override() -> Option<PathBuf> {
    std::env::var(TOUCHAI_APP_ROOT_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::{
        browser_arguments_to_apply, can_show_startup_failure_dialog,
        e2e_webview_additional_browser_args, has_linux_display, is_e2e_test_mode,
        is_ui_preview_mode, policy_arguments_from, should_enable_single_instance,
        webview_additional_browser_args, DEFAULT_E2E_WEBVIEW_ADDITIONAL_BROWSER_ARGS,
        TOUCHAI_E2E_DISABLE_SINGLE_INSTANCE_ENV, TOUCHAI_E2E_ENV, TOUCHAI_UI_PREVIEW_ENV,
    };
    use std::ffi::OsStr;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn user_does_not_wait_for_a_startup_dialog_when_e2e_mode_is_enabled() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        for value in ["1", "true", "YES", " on "] {
            std::env::set_var(TOUCHAI_E2E_ENV, value);
            assert!(!can_show_startup_failure_dialog(), "E2E value: {value}");
        }
        std::env::remove_var(TOUCHAI_E2E_ENV);
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn user_can_see_a_startup_dialog_when_launching_interactively_on_a_native_desktop() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::remove_var(TOUCHAI_E2E_ENV);

        assert!(can_show_startup_failure_dialog());
    }

    #[test]
    fn user_cannot_see_a_linux_dialog_when_both_display_addresses_are_absent_or_empty() {
        assert!(!has_linux_display(None, None));
        assert!(!has_linux_display(Some("".into()), Some("".into())));
        assert!(!has_linux_display(Some("".into()), None));
        assert!(!has_linux_display(None, Some("".into())));
    }

    #[test]
    fn user_can_see_a_linux_dialog_when_either_display_protocol_is_available() {
        assert!(has_linux_display(Some(":99".into()), None));
        assert!(has_linux_display(None, Some("wayland-0".into())));
        assert!(has_linux_display(Some("".into()), Some("wayland-0".into())));
        assert!(has_linux_display(Some(":99".into()), Some("".into())));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn user_keeps_wry_defaults_and_anti_throttling_in_production_mode() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::remove_var(TOUCHAI_E2E_ENV);
        std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");

        let args = webview_additional_browser_args().expect("production args");
        assert!(args.contains("msWebOOUI"));
        assert!(args.contains("msPdfOOUI"));
        assert!(args.contains("msSmartScreenProtection"));
        assert!(args.contains("CalculateNativeWinOcclusion"));
        assert!(args.contains("--disable-background-timer-throttling"));
        assert!(args.contains("--disable-backgrounding-occluded-windows"));
        assert!(args.contains("--disable-renderer-backgrounding"));
    }

    #[test]
    fn user_keeps_webview_arguments_the_environment_already_defines() {
        assert_eq!(
            browser_arguments_to_apply(Some(OsStr::new("--remote-debugging-port=9333")), None),
            None
        );
    }

    fn policy_hive(values: &[(&str, &str)]) -> Vec<(String, String)> {
        values
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect()
    }

    fn candidates(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn user_gets_the_policy_entry_that_names_this_executable_in_any_case() {
        let hives = vec![policy_hive(&[("TOUCHAI.EXE", "--from-machine")])];

        assert_eq!(
            policy_arguments_from(&hives, &candidates(&["TouchAI.exe"])).as_deref(),
            Some("--from-machine")
        );
    }

    #[test]
    fn user_gets_the_policy_entry_for_the_process_identity_before_the_executable() {
        let hives = vec![policy_hive(&[
            ("TouchAI.Desktop", "--from-identity"),
            ("TouchAI.exe", "--from-executable"),
        ])];

        assert_eq!(
            policy_arguments_from(&hives, &candidates(&["touchai.desktop", "TouchAI.exe"]))
                .as_deref(),
            Some("--from-identity")
        );
    }

    #[test]
    fn user_gets_the_machine_policy_before_the_user_policy() {
        let hives = vec![
            policy_hive(&[("TouchAI.exe", "--from-machine")]),
            policy_hive(&[("TouchAI.exe", "--from-user")]),
        ];

        assert_eq!(
            policy_arguments_from(&hives, &candidates(&["TouchAI.exe"])).as_deref(),
            Some("--from-machine")
        );
    }

    #[test]
    fn user_gets_the_user_policy_when_the_machine_entry_is_blank() {
        let hives = vec![
            policy_hive(&[("TouchAI.exe", "   ")]),
            policy_hive(&[("TouchAI.exe", "--from-user")]),
        ];

        assert_eq!(
            policy_arguments_from(&hives, &candidates(&["TouchAI.exe"])).as_deref(),
            Some("--from-user")
        );
    }

    #[test]
    fn user_gets_the_wildcard_policy_when_no_entry_names_the_executable() {
        let hives = vec![policy_hive(&[
            ("other.exe", "--elsewhere"),
            ("*", "--anywhere"),
        ])];

        assert_eq!(
            policy_arguments_from(&hives, &candidates(&["TouchAI.exe"])).as_deref(),
            Some("--anywhere")
        );
        assert_eq!(
            policy_arguments_from(
                &[policy_hive(&[("other.exe", "--elsewhere")])],
                &candidates(&["TouchAI.exe"])
            ),
            None
        );
        assert_eq!(
            policy_arguments_from(&[], &candidates(&["TouchAI.exe"])),
            None
        );
    }

    #[test]
    fn user_keeps_webview_arguments_an_administrator_policy_defines() {
        assert_eq!(
            browser_arguments_to_apply(None, Some("--remote-debugging-port=9333")),
            None
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn user_gets_anti_throttling_arguments_exported_when_the_environment_defines_none() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::remove_var(TOUCHAI_E2E_ENV);
        std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");

        let args = browser_arguments_to_apply(None, None).expect("arguments to export");
        assert!(args.contains("--disable-renderer-backgrounding"));
        assert!(args.contains("CalculateNativeWinOcclusion"));
        assert_eq!(
            browser_arguments_to_apply(Some(OsStr::new("")), None).as_deref(),
            Some(&args[..])
        );
        // The per-window path must also terminate on the no-override startup
        // path: it used to call `browser_arguments_to_apply`, which called it
        // back without a base case.
        assert_eq!(
            webview_additional_browser_args().as_deref(),
            Some(&args[..])
        );
    }

    #[test]
    fn e2e_browser_args_are_none_outside_e2e_mode() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::remove_var(TOUCHAI_E2E_ENV);
        std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");

        assert!(!is_e2e_test_mode());
        assert_eq!(e2e_webview_additional_browser_args(), None);
    }

    #[test]
    fn e2e_browser_args_use_default_remote_debugging_flags_in_e2e_mode() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::set_var(TOUCHAI_E2E_ENV, "1");
        std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");

        let args = e2e_webview_additional_browser_args().expect("args");
        assert_eq!(args, DEFAULT_E2E_WEBVIEW_ADDITIONAL_BROWSER_ARGS);
        assert!(args.contains("--remote-debugging-port=9222"));
        assert!(args.contains("msWebOOUI"));
        assert!(args.contains("msEdgeDevToolsWdpRemoteDebugging"));

        std::env::remove_var(TOUCHAI_E2E_ENV);
    }

    #[test]
    fn e2e_browser_args_prefer_explicit_env_override() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::set_var(TOUCHAI_E2E_ENV, "1");
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--remote-debugging-port=9333",
        );

        assert_eq!(
            e2e_webview_additional_browser_args().as_deref(),
            Some("--remote-debugging-port=9333")
        );

        std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
        std::env::remove_var(TOUCHAI_E2E_ENV);
    }

    #[test]
    fn user_can_disable_single_instance_without_enabling_e2e_mode() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::remove_var(TOUCHAI_E2E_ENV);
        std::env::remove_var(TOUCHAI_E2E_DISABLE_SINGLE_INSTANCE_ENV);

        assert!(should_enable_single_instance());

        for value in ["1", "true", "YES", " on "] {
            std::env::set_var(TOUCHAI_E2E_DISABLE_SINGLE_INSTANCE_ENV, value);
            assert!(!should_enable_single_instance(), "disable value: {value}");
        }

        std::env::set_var(TOUCHAI_E2E_DISABLE_SINGLE_INSTANCE_ENV, "0");
        assert!(should_enable_single_instance());

        std::env::set_var(TOUCHAI_E2E_ENV, "1");
        assert!(!should_enable_single_instance());

        std::env::remove_var(TOUCHAI_E2E_ENV);
        std::env::remove_var(TOUCHAI_E2E_DISABLE_SINGLE_INSTANCE_ENV);
    }

    #[test]
    fn ui_preview_mode_accepts_the_same_truthy_values_as_e2e_mode() {
        let _guard = ENV_LOCK.lock().expect("env lock");

        for value in ["1", "true", "YES", " on "] {
            std::env::set_var(TOUCHAI_UI_PREVIEW_ENV, value);
            assert!(is_ui_preview_mode(), "{value:?} should enable preview mode");
        }

        std::env::set_var(TOUCHAI_UI_PREVIEW_ENV, "0");
        assert!(!is_ui_preview_mode());
        std::env::remove_var(TOUCHAI_UI_PREVIEW_ENV);
    }

    #[test]
    fn user_preview_mode_keeps_session_reminders_in_process() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::remove_var(TOUCHAI_E2E_ENV);
        std::env::set_var(TOUCHAI_UI_PREVIEW_ENV, "1");

        let runtime =
            crate::core::window::status_reminder::SessionStatusReminderNotificationRuntime::new();

        assert!(runtime.is_test_mode());
        std::env::remove_var(TOUCHAI_UI_PREVIEW_ENV);
    }
}
