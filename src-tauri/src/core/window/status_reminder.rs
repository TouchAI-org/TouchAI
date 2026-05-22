// Copyright (c) 2026. 千诚. Licensed under GPL v3

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusReminderNotificationRecord {
    pub title: String,
    pub body: String,
}

pub struct SessionStatusReminderNotificationRuntime {
    test_mode: AtomicBool,
    next_tag: AtomicU64,
    records: Mutex<Vec<SessionStatusReminderNotificationRecord>>,
    clear_count: AtomicUsize,
    #[cfg(target_os = "windows")]
    active_toasts: Mutex<Vec<windows::UI::Notifications::ToastNotification>>,
}

impl SessionStatusReminderNotificationRuntime {
    pub fn new() -> Self {
        Self {
            test_mode: AtomicBool::new(false),
            next_tag: AtomicU64::new(0),
            records: Mutex::new(Vec::new()),
            clear_count: AtomicUsize::new(0),
            #[cfg(target_os = "windows")]
            active_toasts: Mutex::new(Vec::new()),
        }
    }

    pub fn for_tests() -> Self {
        let runtime = Self::new();
        runtime.test_mode.store(true, Ordering::Relaxed);
        runtime
    }

    pub fn is_test_mode(&self) -> bool {
        self.test_mode.load(Ordering::Relaxed)
    }

    pub fn next_tag(&self) -> String {
        let next = self.next_tag.fetch_add(1, Ordering::Relaxed) + 1;
        format!("touchai-session-status-reminder-{next}")
    }

    pub fn record_notification(&self, title: impl Into<String>, body: impl Into<String>) {
        self.records
            .lock()
            .expect("session status reminder runtime poisoned")
            .push(SessionStatusReminderNotificationRecord {
                title: title.into(),
                body: body.into(),
            });
    }

    pub fn records(&self) -> Vec<SessionStatusReminderNotificationRecord> {
        self.records
            .lock()
            .expect("session status reminder runtime poisoned")
            .clone()
    }

    pub fn mark_cleared(&self) {
        self.clear_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn clear_count(&self) -> usize {
        self.clear_count.load(Ordering::Relaxed)
    }

    #[cfg(target_os = "windows")]
    pub fn track_active_toast(&self, toast: windows::UI::Notifications::ToastNotification) {
        self.active_toasts
            .lock()
            .expect("session status reminder runtime poisoned")
            .push(toast);
    }

    #[cfg(target_os = "windows")]
    pub fn clear_active_toasts(&self) {
        self.active_toasts
            .lock()
            .expect("session status reminder runtime poisoned")
            .clear();
    }
}

impl Default for SessionStatusReminderNotificationRuntime {
    fn default() -> Self {
        Self::new()
    }
}

const STATUS_REMINDER_NOTIFICATION_GROUP: &str = "session-status-reminders";
#[cfg(target_os = "windows")]
const POWERSHELL_APP_ID: &str =
    "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

pub fn show_session_status_reminder_notification<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
) -> Result<(), String> {
    let runtime = app
        .try_state::<SessionStatusReminderNotificationRuntime>()
        .ok_or_else(|| "Session status reminder runtime is not initialized".to_string())?;

    if runtime.is_test_mode() {
        runtime.record_notification(title, body);
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        show_windows_status_reminder_notification(app, runtime.inner(), title, body)?;
        runtime.record_notification(title, body);
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (title, body);
        Err("Session status reminder notifications are only supported on Windows".to_string())
    }
}

pub fn clear_session_status_reminder_notifications<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(), String> {
    let runtime = app
        .try_state::<SessionStatusReminderNotificationRuntime>()
        .ok_or_else(|| "Session status reminder runtime is not initialized".to_string())?;
    runtime.mark_cleared();

    if runtime.is_test_mode() {
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        clear_windows_status_reminder_notifications(app, runtime.inner())?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Session status reminder notifications are only supported on Windows".to_string())
    }
}

#[cfg(target_os = "windows")]
fn show_windows_status_reminder_notification<R: Runtime>(
    app: &AppHandle<R>,
    runtime: &SessionStatusReminderNotificationRuntime,
    title: &str,
    body: &str,
) -> Result<(), String> {
    use log::warn;
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    let notification_xml = XmlDocument::new().map_err(|error| error.to_string())?;
    notification_xml
        .LoadXml(&HSTRING::from(build_toast_xml(title, body)))
        .map_err(|error| format!("Failed to load toast xml: {error}"))?;

    let toast = ToastNotification::CreateToastNotification(&notification_xml)
        .map_err(|error| format!("Failed to create toast notification: {error}"))?;
    toast
        .SetTag(&HSTRING::from(runtime.next_tag()))
        .map_err(|error| format!("Failed to set toast tag: {error}"))?;
    toast
        .SetGroup(&HSTRING::from(STATUS_REMINDER_NOTIFICATION_GROUP))
        .map_err(|error| format!("Failed to set toast group: {error}"))?;

    let app_handle = app.clone();
    let activated_handler =
        TypedEventHandler::new(move |_toast: &Option<ToastNotification>, _args| {
            let app_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                let task_handle = app_handle.clone();
                if let Err(error) = app_handle.run_on_main_thread(move || {
                    if let Err(error) = crate::core::window::show_search_window(task_handle) {
                        warn!(
                            "Failed to restore search window from session status notification: {}",
                            error
                        );
                    }
                }) {
                    warn!(
                        "Failed to queue session status notification activation on main thread: {}",
                        error
                    );
                }
            });
            Ok(())
        });

    toast
        .Activated(&activated_handler)
        .map_err(|error| format!("Failed to register toast activation handler: {error}"))?;

    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(
        notification_application_id(app),
    ))
    .map_err(|error| format!("Failed to create toast notifier: {error}"))?;
    notifier
        .Show(&toast)
        .map_err(|error| format!("Failed to show toast notification: {error}"))?;

    runtime.track_active_toast(toast);
    Ok(())
}

#[cfg(target_os = "windows")]
fn clear_windows_status_reminder_notifications<R: Runtime>(
    app: &AppHandle<R>,
    runtime: &SessionStatusReminderNotificationRuntime,
) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::UI::Notifications::ToastNotificationManager;

    ToastNotificationManager::History()
        .and_then(|history| {
            history.RemoveGroupWithId(
                &HSTRING::from(STATUS_REMINDER_NOTIFICATION_GROUP),
                &HSTRING::from(notification_application_id(app)),
            )
        })
        .map_err(|error| format!("Failed to clear session status reminders: {error}"))?;

    runtime.clear_active_toasts();
    Ok(())
}

#[cfg(target_os = "windows")]
fn notification_application_id<R: Runtime>(app: &AppHandle<R>) -> String {
    use std::path::MAIN_SEPARATOR;

    let default_id = app.config().identifier.clone();
    let exe = match tauri::utils::platform::current_exe() {
        Ok(exe) => exe,
        Err(_) => return default_id,
    };
    let exe_dir = match exe.parent() {
        Some(parent) => parent.display().to_string(),
        None => return default_id,
    };

    let debug_dir = format!("{MAIN_SEPARATOR}target{MAIN_SEPARATOR}debug");
    let release_dir = format!("{MAIN_SEPARATOR}target{MAIN_SEPARATOR}release");
    if exe_dir.ends_with(&debug_dir) || exe_dir.ends_with(&release_dir) {
        return POWERSHELL_APP_ID.to_string();
    }

    default_id
}

fn build_toast_xml(title: &str, body: &str) -> String {
    format!(
        r#"<toast>
            <visual>
                <binding template="ToastGeneric">
                    <text>{}</text>
                    <text>{}</text>
                </binding>
            </visual>
        </toast>"#,
        escape_xml(title),
        escape_xml(body)
    )
}

fn escape_xml(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::{build_toast_xml, escape_xml};

    #[test]
    fn escape_xml_escapes_reserved_characters() {
        assert_eq!(
            escape_xml(r#"<TouchAI "done" & 'ok'>"#),
            "&lt;TouchAI &quot;done&quot; &amp; &apos;ok&apos;&gt;"
        );
    }

    #[test]
    fn build_toast_xml_embeds_escaped_title_and_body() {
        let xml = build_toast_xml("Done & ready", "<approved>");

        assert!(xml.contains("Done &amp; ready"));
        assert!(xml.contains("&lt;approved&gt;"));
    }
}
