// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime};

const STATUS_REMINDER_NOTIFICATION_GROUP: &str = "session-status-reminders";
const SESSION_STATUS_REMINDER_ACTION_EVENT: &str = "session-status-reminder:action";
const REPLY_INPUT_ID: &str = "touchai-reply";
const REPLY_PLACEHOLDER: &str = "Reply to TouchAI";
const REPLY_ACTION_LABEL: &str = "Reply";

#[cfg(target_os = "windows")]
const POWERSHELL_APP_ID: &str =
    "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatusReminderKind {
    Completed,
    Failed,
    WaitingApproval,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatusReminderAction {
    Open,
    Reply,
    Approve,
    Reject,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusReminderNotificationApprovalPayload {
    pub call_id: String,
    pub approve_label: String,
    pub reject_label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusReminderNotificationPayload {
    pub title: String,
    pub body: String,
    pub session_id: i64,
    pub task_id: String,
    pub kind: SessionStatusReminderKind,
    pub approval: Option<SessionStatusReminderNotificationApprovalPayload>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatusReminderActionPayload {
    action: SessionStatusReminderAction,
    session_id: i64,
    task_id: String,
    kind: SessionStatusReminderKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reply_text: Option<String>,
}

pub struct SessionStatusReminderNotificationRuntime {
    test_mode: AtomicBool,
    next_tag: AtomicU64,
    records: Mutex<Vec<SessionStatusReminderNotificationPayload>>,
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

    pub fn record_notification(&self, payload: &SessionStatusReminderNotificationPayload) {
        self.records
            .lock()
            .expect("session status reminder runtime poisoned")
            .push(payload.clone());
    }

    pub fn records(&self) -> Vec<SessionStatusReminderNotificationPayload> {
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

pub fn show_session_status_reminder_notification<R: Runtime>(
    app: &AppHandle<R>,
    payload: &SessionStatusReminderNotificationPayload,
) -> Result<(), String> {
    let runtime = app
        .try_state::<SessionStatusReminderNotificationRuntime>()
        .ok_or_else(|| "Session status reminder runtime is not initialized".to_string())?;

    if runtime.is_test_mode() {
        runtime.record_notification(payload);
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        show_windows_status_reminder_notification(app, runtime.inner(), payload)?;
        runtime.record_notification(payload);
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = payload;
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
    payload: &SessionStatusReminderNotificationPayload,
) -> Result<(), String> {
    use log::warn;
    use windows::core::{Interface, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{
        ToastActivatedEventArgs, ToastNotification, ToastNotificationManager,
    };

    let notification_xml = XmlDocument::new().map_err(|error| error.to_string())?;
    notification_xml
        .LoadXml(&HSTRING::from(build_toast_xml(payload)?))
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
    let activated_handler = TypedEventHandler::new(
        move |_toast: &Option<ToastNotification>, args: &Option<windows::core::IInspectable>| {
            let app_handle = app_handle.clone();
            let activation_payload = args
                .as_ref()
                .and_then(|value| value.cast::<ToastActivatedEventArgs>().ok())
                .and_then(|activated| parse_activated_payload(&activated).ok());

            tauri::async_runtime::spawn(async move {
                let task_handle = app_handle.clone();
                if let Err(error) = app_handle.run_on_main_thread(move || {
                    if let Err(error) = crate::core::window::show_search_window(task_handle.clone())
                    {
                        warn!(
                            "Failed to restore search window from session status notification: {}",
                            error
                        );
                    }

                    if let Some(payload) = activation_payload.as_ref() {
                        if let Err(error) = task_handle
                            .emit(SESSION_STATUS_REMINDER_ACTION_EVENT, payload)
                            .map_err(|error| error.to_string())
                        {
                            warn!(
                                "Failed to emit session status reminder action event: {}",
                                error
                            );
                        }
                    }
                }) {
                    warn!(
                        "Failed to queue session status notification activation on main thread: {}",
                        error
                    );
                }
            });
            Ok(())
        },
    );

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
fn parse_activated_payload(
    activated: &windows::UI::Notifications::ToastActivatedEventArgs,
) -> Result<SessionStatusReminderActionPayload, String> {
    let arguments = activated.Arguments().map_err(|error| error.to_string())?;
    let payload =
        serde_json::from_str(&arguments.to_string()).map_err(|error| error.to_string())?;
    Ok(finalize_activation_payload(
        payload,
        extract_reply_text(activated),
    ))
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

fn build_toast_xml(payload: &SessionStatusReminderNotificationPayload) -> Result<String, String> {
    let launch = serialize_activation_payload(
        payload,
        SessionStatusReminderAction::Open,
        payload
            .approval
            .as_ref()
            .map(|approval| approval.call_id.clone()),
    )?;

    let actions = if payload.kind == SessionStatusReminderKind::WaitingApproval {
        build_approval_actions_xml(payload)?
    } else {
        build_reply_actions_xml(payload)?
    };

    Ok(format!(
        r#"<toast launch="{}">
            <visual>
                <binding template="ToastGeneric">
                    <text>{}</text>
                    <text>{}</text>
                </binding>
            </visual>
            {}
        </toast>"#,
        escape_xml(&launch),
        escape_xml(&payload.title),
        escape_xml(&payload.body),
        actions
    ))
}

fn build_approval_actions_xml(
    payload: &SessionStatusReminderNotificationPayload,
) -> Result<String, String> {
    let Some(approval) = payload.approval.as_ref() else {
        return Err("waiting_approval reminder requires approval payload".to_string());
    };

    let approve_arguments = serialize_activation_payload(
        payload,
        SessionStatusReminderAction::Approve,
        Some(approval.call_id.clone()),
    )?;
    let reject_arguments = serialize_activation_payload(
        payload,
        SessionStatusReminderAction::Reject,
        Some(approval.call_id.clone()),
    )?;

    Ok(format!(
        r#"<actions>
            {}
            {}
        </actions>"#,
        build_action_xml(&approval.approve_label, &approve_arguments, None),
        build_action_xml(&approval.reject_label, &reject_arguments, None)
    ))
}

fn build_reply_actions_xml(
    payload: &SessionStatusReminderNotificationPayload,
) -> Result<String, String> {
    let reply_arguments =
        serialize_activation_payload(payload, SessionStatusReminderAction::Reply, None)?;

    Ok(format!(
        r#"<actions>
            <input id="{}" type="text" placeHolderContent="{}" />
            {}
        </actions>"#,
        escape_xml(REPLY_INPUT_ID),
        escape_xml(REPLY_PLACEHOLDER),
        build_action_xml(REPLY_ACTION_LABEL, &reply_arguments, Some(REPLY_INPUT_ID))
    ))
}

fn build_action_xml(content: &str, arguments: &str, input_id: Option<&str>) -> String {
    let hint_input = input_id
        .map(|value| format!(r#" hint-inputId="{}""#, escape_xml(value)))
        .unwrap_or_default();

    format!(
        r#"<action content="{}" arguments="{}" activationType="foreground"{} />"#,
        escape_xml(content),
        escape_xml(arguments),
        hint_input
    )
}

fn serialize_activation_payload(
    payload: &SessionStatusReminderNotificationPayload,
    action: SessionStatusReminderAction,
    call_id: Option<String>,
) -> Result<String, String> {
    serde_json::to_string(&SessionStatusReminderActionPayload {
        action,
        session_id: payload.session_id,
        task_id: payload.task_id.clone(),
        kind: payload.kind,
        call_id,
        reply_text: None,
    })
    .map_err(|error| error.to_string())
}

fn finalize_activation_payload(
    mut payload: SessionStatusReminderActionPayload,
    reply_text: Option<String>,
) -> SessionStatusReminderActionPayload {
    if payload.action != SessionStatusReminderAction::Reply {
        payload.reply_text = None;
        return payload;
    }

    let normalized = reply_text
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if let Some(value) = normalized {
        payload.reply_text = Some(value);
        return payload;
    }

    payload.action = SessionStatusReminderAction::Open;
    payload.reply_text = None;
    payload
}

#[cfg(target_os = "windows")]
fn extract_reply_text(
    activated: &windows::UI::Notifications::ToastActivatedEventArgs,
) -> Option<String> {
    use windows::core::{Interface, HSTRING};
    use windows::Foundation::IPropertyValue;

    let inputs = activated.UserInput().ok()?;
    let value = inputs.Lookup(&HSTRING::from(REPLY_INPUT_ID)).ok()?;
    let property = value.cast::<IPropertyValue>().ok()?;
    property.GetString().ok().map(|value| value.to_string())
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
    use super::{
        build_toast_xml, escape_xml, finalize_activation_payload, SessionStatusReminderAction,
        SessionStatusReminderActionPayload, SessionStatusReminderKind,
        SessionStatusReminderNotificationApprovalPayload, SessionStatusReminderNotificationPayload,
        REPLY_PLACEHOLDER,
    };

    #[test]
    fn escape_xml_escapes_reserved_characters() {
        assert_eq!(
            escape_xml(r#"<TouchAI "done" & 'ok'>"#),
            "&lt;TouchAI &quot;done&quot; &amp; &apos;ok&apos;&gt;"
        );
    }

    #[test]
    fn build_toast_xml_embeds_reply_input_for_non_approval_notifications() {
        let xml = build_toast_xml(&SessionStatusReminderNotificationPayload {
            title: "Done & ready".to_string(),
            body: "<approved>".to_string(),
            session_id: 7,
            task_id: "task-1".to_string(),
            kind: SessionStatusReminderKind::Completed,
            approval: None,
        })
        .expect("toast xml");

        assert!(xml.contains("Done &amp; ready"));
        assert!(xml.contains("&lt;approved&gt;"));
        assert!(xml.contains("&quot;action&quot;:&quot;open&quot;"));
        assert!(xml.contains(REPLY_PLACEHOLDER));
        assert!(xml.contains("&quot;action&quot;:&quot;reply&quot;"));
    }

    #[test]
    fn build_toast_xml_includes_approval_actions_when_requested() {
        let xml = build_toast_xml(&SessionStatusReminderNotificationPayload {
            title: "Waiting approval".to_string(),
            body: "User approval is required".to_string(),
            session_id: 9,
            task_id: "task-approve".to_string(),
            kind: SessionStatusReminderKind::WaitingApproval,
            approval: Some(SessionStatusReminderNotificationApprovalPayload {
                call_id: "call-1".to_string(),
                approve_label: "Approve".to_string(),
                reject_label: "Reject".to_string(),
            }),
        })
        .expect("toast xml");

        assert!(xml.contains("<actions>"));
        assert!(xml.contains("Approve"));
        assert!(xml.contains("Reject"));
        assert!(xml.contains("&quot;action&quot;:&quot;approve&quot;"));
        assert!(xml.contains("&quot;action&quot;:&quot;reject&quot;"));
        assert!(!xml.contains(REPLY_PLACEHOLDER));
    }

    #[test]
    fn finalize_activation_payload_promotes_blank_reply_to_open() {
        let payload = finalize_activation_payload(
            SessionStatusReminderActionPayload {
                action: SessionStatusReminderAction::Reply,
                session_id: 1,
                task_id: "task-1".to_string(),
                kind: SessionStatusReminderKind::Completed,
                call_id: None,
                reply_text: None,
            },
            Some("   ".to_string()),
        );

        assert_eq!(payload.action, SessionStatusReminderAction::Open);
        assert_eq!(payload.reply_text, None);
    }

    #[test]
    fn finalize_activation_payload_preserves_reply_text() {
        let payload = finalize_activation_payload(
            SessionStatusReminderActionPayload {
                action: SessionStatusReminderAction::Reply,
                session_id: 1,
                task_id: "task-1".to_string(),
                kind: SessionStatusReminderKind::Failed,
                call_id: None,
                reply_text: None,
            },
            Some(" follow up ".to_string()),
        );

        assert_eq!(payload.action, SessionStatusReminderAction::Reply);
        assert_eq!(payload.reply_text.as_deref(), Some("follow up"));
    }
}
