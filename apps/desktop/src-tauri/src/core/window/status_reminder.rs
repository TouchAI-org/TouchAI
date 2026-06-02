// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use tauri::Emitter;
use tauri::{AppHandle, Manager, Runtime};

const STATUS_REMINDER_NOTIFICATION_GROUP: &str = "session-status-reminders";
const SESSION_STATUS_REMINDER_ACTION_EVENT: &str = "session-status-reminder:action";
const REPLY_INPUT_ID: &str = "touchai-reply";

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
    pub open_label: Option<String>,
    pub reply_placeholder: Option<String>,
    pub reply_label: Option<String>,
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
    #[cfg(target_os = "macos")]
    active_notification_ids: Mutex<Vec<String>>,
    #[cfg(target_os = "linux")]
    active_notifications: Mutex<Vec<notify_rust::NotificationHandle>>,
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
            #[cfg(target_os = "macos")]
            active_notification_ids: Mutex::new(Vec::new()),
            #[cfg(target_os = "linux")]
            active_notifications: Mutex::new(Vec::new()),
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

    #[cfg(target_os = "macos")]
    pub fn track_active_notification(&self, identifier: String) {
        self.active_notification_ids
            .lock()
            .expect("session status reminder runtime poisoned")
            .push(identifier);
    }

    #[cfg(target_os = "macos")]
    pub fn clear_active_notification_ids(&self) {
        self.active_notification_ids
            .lock()
            .expect("session status reminder runtime poisoned")
            .clear();
    }

    #[cfg(target_os = "linux")]
    pub fn track_active_notification(&self, handle: notify_rust::NotificationHandle) {
        self.active_notifications
            .lock()
            .expect("session status reminder runtime poisoned")
            .push(handle);
    }

    #[cfg(target_os = "linux")]
    pub fn release_active_notification(&self, id: u32) {
        let mut handles = self
            .active_notifications
            .lock()
            .expect("session status reminder runtime poisoned");
        if let Some(index) = handles.iter().position(|handle| handle.id() == id) {
            handles.remove(index);
        }
    }

    #[cfg(target_os = "linux")]
    pub fn clear_active_notifications(&self) {
        let handles = {
            let mut handles = self
                .active_notifications
                .lock()
                .expect("session status reminder runtime poisoned");
            std::mem::take(&mut *handles)
        };

        for handle in handles {
            handle.close();
        }
    }
}

impl Default for SessionStatusReminderNotificationRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn restore_search_window_from_status_reminder<R: Runtime>(
    app_handle: AppHandle<R>,
    payload: Option<SessionStatusReminderActionPayload>,
) {
    tauri::async_runtime::spawn(async move {
        let task_handle = app_handle.clone();
        if let Err(error) = app_handle.run_on_main_thread(move || {
            if should_restore_search_window_from_status_reminder(payload.as_ref()) {
                if let Err(error) = crate::core::window::show_search_window(task_handle.clone()) {
                    log::warn!(
                        "Failed to restore search window from session status notification: {}",
                        error
                    );
                }
            }

            let Some(payload) = payload.as_ref() else {
                return;
            };

            if let Err(error) = task_handle
                .emit(SESSION_STATUS_REMINDER_ACTION_EVENT, payload)
                .map_err(|error| error.to_string())
            {
                log::warn!(
                    "Failed to emit session status reminder action event: {}",
                    error
                );
            }
        }) {
            log::warn!(
                "Failed to queue session status reminder action on main thread: {}",
                error
            );
        }
    });
}

fn should_restore_search_window_from_status_reminder(
    payload: Option<&SessionStatusReminderActionPayload>,
) -> bool {
    !matches!(
        payload,
        Some(payload)
            if payload.kind == SessionStatusReminderKind::WaitingApproval
                && payload.action == SessionStatusReminderAction::Approve
    )
}

fn has_windows_installation_marker(exe_path: &std::path::Path) -> bool {
    exe_path
        .parent()
        .map(|dir| dir.join("uninstall.exe").is_file())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn should_register_windows_notification_identity() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }

    std::env::current_exe()
        .map(|exe_path| has_windows_installation_marker(&exe_path))
        .unwrap_or(false)
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

    #[cfg(target_os = "macos")]
    {
        macos_notifications::show(app, runtime.inner(), payload)?;
        runtime.record_notification(payload);
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        linux_notifications::show(app, runtime.inner(), payload)?;
        runtime.record_notification(payload);
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = payload;
        Err("Session status reminder notifications are not supported on this platform".to_string())
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

    #[cfg(target_os = "macos")]
    {
        macos_notifications::clear(runtime.inner());
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        linux_notifications::clear(runtime.inner());
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("Session status reminder notifications are not supported on this platform".to_string())
    }
}

#[cfg(target_os = "windows")]
fn show_windows_status_reminder_notification<R: Runtime>(
    app: &AppHandle<R>,
    runtime: &SessionStatusReminderNotificationRuntime,
    payload: &SessionStatusReminderNotificationPayload,
) -> Result<(), String> {
    use windows::core::{Interface, HSTRING};
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{
        ToastActivatedEventArgs, ToastNotification, ToastNotificationManager,
    };

    let notification_xml = build_toast_document(payload)?;
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
            let activation_payload = args
                .as_ref()
                .and_then(|value| value.cast::<ToastActivatedEventArgs>().ok())
                .and_then(|activated| parse_activated_payload(&activated).ok());
            restore_search_window_from_status_reminder(app_handle.clone(), activation_payload);
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

/// 设置当前进程的 AppUserModelId 并确保开始菜单存在快捷方式，
/// 仅在正式安装版中启用，避免本地开发或直接运行 release 二进制污染通知身份。
#[cfg(target_os = "windows")]
pub fn ensure_windows_start_menu_shortcut(app_id: &str) -> Result<(), String> {
    use std::path::PathBuf;
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

    if !should_register_windows_notification_identity() {
        return Ok(());
    }

    let app_id_hstring = HSTRING::from(app_id);
    unsafe {
        SetCurrentProcessExplicitAppUserModelID(&app_id_hstring)
            .map_err(|error| format!("Failed to set current process AUMID: {error}"))?;
    }

    let shortcut_dir = {
        let appdata =
            std::env::var("APPDATA").map_err(|error| format!("APPDATA not set: {error}"))?;
        PathBuf::from(appdata)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("TouchAI")
    };
    let shortcut_path = shortcut_dir.join("TouchAI.lnk");

    let exe_path = std::env::current_exe()
        .map_err(|error| format!("Failed to get current exe path: {error}"))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "exe has no parent directory".to_string())?;

    std::fs::create_dir_all(&shortcut_dir)
        .map_err(|error| format!("Failed to create shortcut directory: {error}"))?;

    let ps_script = format!(
        r#"$s = (New-Object -ComObject WScript.Shell).CreateShortcut('{}'); $s.TargetPath = '{}'; $s.WorkingDirectory = '{}'; $s.Save()"#,
        shortcut_path.display(),
        exe_path.display(),
        exe_dir.display(),
    );

    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
        .output()
        .map_err(|error| format!("Failed to run PowerShell: {error}"))?;

    if !output.status.success() {
        return Err(format!(
            "PowerShell shortcut creation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn notification_application_id<R: Runtime>(app: &AppHandle<R>) -> String {
    app.config().identifier.clone()
}

#[cfg(all(test, target_os = "windows"))]
fn build_toast_xml(payload: &SessionStatusReminderNotificationPayload) -> Result<String, String> {
    let doc = build_toast_document(payload)?;
    let xml = doc.GetXml().map_err(|error| error.to_string())?;
    Ok(xml.to_string())
}

#[cfg(target_os = "windows")]
fn build_toast_document(
    payload: &SessionStatusReminderNotificationPayload,
) -> Result<windows::Data::Xml::Dom::XmlDocument, String> {
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;

    let doc = XmlDocument::new().map_err(|error| error.to_string())?;

    let launch = serialize_activation_payload(
        payload,
        SessionStatusReminderAction::Open,
        payload
            .approval
            .as_ref()
            .map(|approval| approval.call_id.clone()),
    )?;

    let toast = doc
        .CreateElement(&HSTRING::from("toast"))
        .map_err(|error| error.to_string())?;
    toast
        .SetAttribute(&HSTRING::from("launch"), &HSTRING::from(&launch))
        .map_err(|error| error.to_string())?;
    if payload.kind == SessionStatusReminderKind::WaitingApproval && payload.approval.is_some() {
        toast
            .SetAttribute(&HSTRING::from("scenario"), &HSTRING::from("reminder"))
            .map_err(|error| error.to_string())?;
    }

    let visual = doc
        .CreateElement(&HSTRING::from("visual"))
        .map_err(|error| error.to_string())?;
    let binding = doc
        .CreateElement(&HSTRING::from("binding"))
        .map_err(|error| error.to_string())?;
    binding
        .SetAttribute(&HSTRING::from("template"), &HSTRING::from("ToastGeneric"))
        .map_err(|error| error.to_string())?;

    let text1 = doc
        .CreateElement(&HSTRING::from("text"))
        .map_err(|error| error.to_string())?;
    text1
        .SetInnerText(&HSTRING::from(&payload.title))
        .map_err(|error| error.to_string())?;
    let text2 = doc
        .CreateElement(&HSTRING::from("text"))
        .map_err(|error| error.to_string())?;
    text2
        .SetInnerText(&HSTRING::from(&payload.body))
        .map_err(|error| error.to_string())?;

    binding
        .AppendChild(&text1)
        .map_err(|error| error.to_string())?;
    binding
        .AppendChild(&text2)
        .map_err(|error| error.to_string())?;
    visual
        .AppendChild(&binding)
        .map_err(|error| error.to_string())?;
    toast
        .AppendChild(&visual)
        .map_err(|error| error.to_string())?;

    let actions_element = doc
        .CreateElement(&HSTRING::from("actions"))
        .map_err(|error| error.to_string())?;

    if payload.kind == SessionStatusReminderKind::WaitingApproval {
        if let Some(approval) = payload.approval.as_ref() {
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

            append_action_element(
                &doc,
                &actions_element,
                &approval.approve_label,
                &approve_arguments,
                None,
            )?;
            append_action_element(
                &doc,
                &actions_element,
                &approval.reject_label,
                &reject_arguments,
                None,
            )?;
        } else {
            let open_arguments =
                serialize_activation_payload(payload, SessionStatusReminderAction::Open, None)?;
            let label = payload.open_label.as_deref().unwrap_or("Open");
            append_action_element(&doc, &actions_element, label, &open_arguments, None)?;
        }
    } else {
        let reply_arguments =
            serialize_activation_payload(payload, SessionStatusReminderAction::Reply, None)?;

        let placeholder = payload.reply_placeholder.as_deref().unwrap_or("Reply");
        let label = payload.reply_label.as_deref().unwrap_or("Reply");

        let input = doc
            .CreateElement(&HSTRING::from("input"))
            .map_err(|error| error.to_string())?;
        input
            .SetAttribute(&HSTRING::from("id"), &HSTRING::from(REPLY_INPUT_ID))
            .map_err(|error| error.to_string())?;
        input
            .SetAttribute(&HSTRING::from("type"), &HSTRING::from("text"))
            .map_err(|error| error.to_string())?;
        input
            .SetAttribute(
                &HSTRING::from("placeHolderContent"),
                &HSTRING::from(placeholder),
            )
            .map_err(|error| error.to_string())?;
        actions_element
            .AppendChild(&input)
            .map_err(|error| error.to_string())?;

        append_action_element(
            &doc,
            &actions_element,
            label,
            &reply_arguments,
            Some(REPLY_INPUT_ID),
        )?;
    }

    toast
        .AppendChild(&actions_element)
        .map_err(|error| error.to_string())?;
    doc.AppendChild(&toast).map_err(|error| error.to_string())?;

    Ok(doc)
}

#[cfg(target_os = "windows")]
fn append_action_element(
    doc: &windows::Data::Xml::Dom::XmlDocument,
    parent: &windows::Data::Xml::Dom::XmlElement,
    content: &str,
    arguments: &str,
    input_id: Option<&str>,
) -> Result<(), String> {
    use windows::core::HSTRING;

    let action = doc
        .CreateElement(&HSTRING::from("action"))
        .map_err(|error| error.to_string())?;
    action
        .SetAttribute(&HSTRING::from("content"), &HSTRING::from(content))
        .map_err(|error| error.to_string())?;
    action
        .SetAttribute(&HSTRING::from("arguments"), &HSTRING::from(arguments))
        .map_err(|error| error.to_string())?;
    action
        .SetAttribute(
            &HSTRING::from("activationType"),
            &HSTRING::from("foreground"),
        )
        .map_err(|error| error.to_string())?;

    if let Some(id) = input_id {
        action
            .SetAttribute(&HSTRING::from("hint-inputId"), &HSTRING::from(id))
            .map_err(|error| error.to_string())?;
    }

    parent
        .AppendChild(&action)
        .map_err(|error| error.to_string())?;
    Ok(())
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

// ---------------------------------------------------------------------------
// macOS notification support
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod macos_notifications {
    use std::sync::{Mutex, OnceLock};

    use block2::RcBlock;
    use dispatch2::{run_on_main, MainThreadBound};
    use log::warn;
    use objc2::{define_class, msg_send, rc::Retained, runtime::ProtocolObject, MainThreadOnly};
    use objc2_foundation::{NSArray, NSDictionary, NSObject, NSObjectProtocol, NSSet, NSString};
    use objc2_user_notifications::{
        UNMutableNotificationContent, UNNotificationAction, UNNotificationCategory,
        UNNotificationRequest, UNNotificationResponse, UNTextInputNotificationResponse,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use tauri::{AppHandle, Emitter, Runtime};

    use super::{
        finalize_activation_payload, serialize_activation_payload, SessionStatusReminderAction,
        SessionStatusReminderActionPayload, SessionStatusReminderKind,
        SessionStatusReminderNotificationPayload, SESSION_STATUS_REMINDER_ACTION_EVENT,
    };

    type ActionCallback = Box<dyn Fn(&str) + Send>;

    static ACTION_CALLBACK: OnceLock<Mutex<Option<ActionCallback>>> = OnceLock::new();
    static DELEGATE_INSTANCE: OnceLock<MainThreadBound<Retained<TouchAINotificationDelegate>>> =
        OnceLock::new();

    /// Register the callback invoked from the notification-center delegate when
    /// the user interacts with a delivered notification.
    fn set_action_callback(cb: ActionCallback) {
        let lock = ACTION_CALLBACK.get_or_init(|| Mutex::new(None));
        *lock.lock().expect("macos action callback poisoned") = Some(cb);
    }

    /// Ensure the delegate is set on the center exactly once and lives for the
    /// entire process lifetime. `UNUserNotificationCenter.delegate` is a weak
    /// property, so the delegate object must be held in a static to prevent
    /// deallocation.
    fn ensure_delegate_registered() {
        run_on_main(|mtm| {
            let center = UNUserNotificationCenter::currentNotificationCenter();
            let delegate = DELEGATE_INSTANCE.get_or_init(|| {
                let delegate = TouchAINotificationDelegate::new(mtm);
                MainThreadBound::new(delegate, mtm)
            });
            center.setDelegate(Some(ProtocolObject::from_ref(&**delegate.get(mtm))));
        });
    }

    /// Objective-C delegate that translates `UNUserNotificationCenter` action
    /// responses into serialised Rust payloads and forwards them through the
    /// registered callback.
    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        pub(crate) struct TouchAINotificationDelegate;

        unsafe impl NSObjectProtocol for TouchAINotificationDelegate {}

        unsafe impl UNUserNotificationCenterDelegate for TouchAINotificationDelegate {
            #[unsafe(method(
                userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:
            ))]
            fn did_receive_response(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion_handler: &block2::DynBlock<dyn Fn()>,
            ) {
                let action_id = response.actionIdentifier().to_string();
                let request = response.notification().request();
                let payload_key = NSString::from_str("touchai_payload");
                let user_info = request.content().userInfo();
                let raw_payload = unsafe { user_info.cast_unchecked::<NSString, NSString>() }
                    .objectForKey(&payload_key)
                    .map(|obj| obj.to_string());

                let reply_text = if let Some(text_response) =
                    response.downcast_ref::<UNTextInputNotificationResponse>()
                {
                    Some(text_response.userText().to_string())
                } else {
                    None
                };

                if let Some(payload_json) = raw_payload {
                    let handler_guard = ACTION_CALLBACK.get().and_then(|lock| lock.lock().ok());
                    if let Some(guard) = handler_guard {
                        if let Some(cb) = guard.as_ref() {
                            // We piggyback the action identifier and reply text on
                            // top of the stored base payload by post-processing.
                            let enriched = enrich_stored_payload(
                                &payload_json,
                                &action_id,
                                reply_text.as_deref(),
                            );
                            if let Some(json) = enriched {
                                cb(&json);
                            }
                        }
                    }
                }

                completion_handler.call(());
            }
        }
    );

    impl TouchAINotificationDelegate {
        fn new(mtm: objc2::MainThreadMarker) -> Retained<Self> {
            let delegate = Self::alloc(mtm);
            unsafe { msg_send![delegate, init] }
        }
    }

    /// Enrich the base payload JSON with the action identifier and optional
    /// reply text so that the frontend receives a complete action payload.
    fn enrich_stored_payload(
        base_json: &str,
        action_id: &str,
        reply_text: Option<&str>,
    ) -> Option<String> {
        let mut base: serde_json::Value = serde_json::from_str(base_json).ok()?;
        if let serde_json::Value::Object(obj) = &mut base {
            obj.insert(
                "action".to_string(),
                serde_json::Value::String(action_id.to_string()),
            );
            if let Some(text) = reply_text {
                obj.insert(
                    "replyText".to_string(),
                    serde_json::Value::String(text.to_string()),
                );
            }
        }
        Some(base.to_string())
    }

    /// Derive a stable unique notification identifier from the session/task.
    fn make_notification_identifier(payload: &SessionStatusReminderNotificationPayload) -> String {
        format!(
            "touchai-reminder-{}-{}",
            payload.session_id, payload.task_id
        )
    }

    /// Build and register notification category identifiers and their actions.
    fn ensure_categories_registered(
        center: &UNUserNotificationCenter,
        payload: &SessionStatusReminderNotificationPayload,
    ) {
        let approve_label = payload
            .approval
            .as_ref()
            .map(|approval| approval.approve_label.as_str())
            .unwrap_or("Approve");
        let reject_label = payload
            .approval
            .as_ref()
            .map(|approval| approval.reject_label.as_str())
            .unwrap_or("Reject");
        let open_label = payload.open_label.as_deref().unwrap_or("Open");
        let reply_label = payload.reply_label.as_deref().unwrap_or("Reply");
        let reply_placeholder = payload
            .reply_placeholder
            .as_deref()
            .unwrap_or("Reply to TouchAI");
        let empty_intents = NSArray::from_slice(&[]);

        let approve_action = UNNotificationAction::actionWithIdentifier_title_options(
            &NSString::from_str("approve"),
            &NSString::from_str(approve_label),
            objc2_user_notifications::UNNotificationActionOptions::Foreground,
        );
        let reject_action = UNNotificationAction::actionWithIdentifier_title_options(
            &NSString::from_str("reject"),
            &NSString::from_str(reject_label),
            objc2_user_notifications::UNNotificationActionOptions::Destructive,
        );
        let waiting_actions = NSArray::from_retained_slice(&[approve_action, reject_action]);
        let waiting_category =
            UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                &NSString::from_str("touchai-waiting-approval"),
                &waiting_actions,
                &empty_intents,
                objc2_user_notifications::UNNotificationCategoryOptions::empty(),
            );

        let open_action = UNNotificationAction::actionWithIdentifier_title_options(
            &NSString::from_str("open"),
            &NSString::from_str(open_label),
            objc2_user_notifications::UNNotificationActionOptions::Foreground,
        );
        let open_actions = NSArray::from_retained_slice(&[open_action]);
        let open_category =
            UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                &NSString::from_str("touchai-open-only"),
                &open_actions,
                &empty_intents,
                objc2_user_notifications::UNNotificationCategoryOptions::empty(),
            );

        let reply_action = objc2_user_notifications::UNTextInputNotificationAction::actionWithIdentifier_title_options_textInputButtonTitle_textInputPlaceholder(
            &NSString::from_str("reply"),
            &NSString::from_str(reply_label),
            objc2_user_notifications::UNNotificationActionOptions::Foreground,
            &NSString::from_str(reply_label),
            &NSString::from_str(reply_placeholder),
        );
        let reply_actions = NSArray::from_retained_slice(&[reply_action.into_super()]);
        let reply_category =
            UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                &NSString::from_str("touchai-completed-failed"),
                &reply_actions,
                &empty_intents,
                objc2_user_notifications::UNNotificationCategoryOptions::empty(),
            );

        let categories =
            NSSet::from_retained_slice(&[waiting_category, open_category, reply_category]);
        center.setNotificationCategories(&categories);
    }

    /// Show a session status reminder notification through the macOS
    /// UserNotificationCenter.
    pub fn show<R: Runtime>(
        app: &AppHandle<R>,
        runtime: &super::SessionStatusReminderNotificationRuntime,
        payload: &SessionStatusReminderNotificationPayload,
    ) -> Result<(), String> {
        let center =
            objc2_user_notifications::UNUserNotificationCenter::currentNotificationCenter();

        // Request authorisation (alert + sound).
        center.requestAuthorizationWithOptions_completionHandler(
            objc2_user_notifications::UNAuthorizationOptions::Alert
                | objc2_user_notifications::UNAuthorizationOptions::Sound,
            &RcBlock::new(|_granted, _error| {}),
        );

        // Persist an action callback that captures the producing app handle so
        // the delegate can emit events without holding a reference to AppHandle
        // itself.
        let app_handle = app.clone();
        set_action_callback(Box::new(move |json: &str| {
            let payload: serde_json::Value = match serde_json::from_str(json) {
                Ok(v) => v,
                Err(error) => {
                    warn!(
                        "Failed to parse macOS notification action payload: {}",
                        error
                    );
                    return;
                }
            };
            let action: Option<String> = payload
                .get("action")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let reply_text: Option<String> = payload
                .get("replyText")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let call_id: Option<String> = payload
                .get("callId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let session_id: Option<i64> = payload.get("sessionId").and_then(|v| v.as_i64());
            let task_id: Option<String> = payload
                .get("taskId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let kind: Option<SessionStatusReminderKind> = payload
                .get("kind")
                .and_then(|v| serde_json::from_value(v.clone()).ok());

            let action = match action.as_deref() {
                Some("approve") => SessionStatusReminderAction::Approve,
                Some("reject") => SessionStatusReminderAction::Reject,
                Some("reply") | Some("com.apple.notificationcenter.textinput") => {
                    SessionStatusReminderAction::Reply
                }
                _ => SessionStatusReminderAction::Open,
            };

            let final_payload = finalize_activation_payload(
                SessionStatusReminderActionPayload {
                    action,
                    session_id: session_id.unwrap_or(0),
                    task_id: task_id.unwrap_or_default(),
                    kind: kind.unwrap_or(SessionStatusReminderKind::Completed),
                    call_id,
                    reply_text: reply_text.clone(),
                },
                reply_text,
            );

            super::restore_search_window_from_status_reminder(
                app_handle.clone(),
                Some(final_payload),
            );
        }));

        // Ensure the delegate is registered exactly once and held by the static
        // so it lives for the process lifetime.
        ensure_delegate_registered();

        // Register the appropriate category (actions) for this notification.
        ensure_categories_registered(&center, payload);

        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&payload.title));
        content.setBody(&NSString::from_str(&payload.body));

        let category_id = if payload.kind == SessionStatusReminderKind::WaitingApproval
            && payload.approval.is_some()
        {
            "touchai-waiting-approval"
        } else if payload.kind == SessionStatusReminderKind::WaitingApproval {
            "touchai-open-only"
        } else {
            "touchai-completed-failed"
        };
        content.setCategoryIdentifier(&NSString::from_str(category_id));

        // Embed the base activation payload in the notification's userInfo
        // so the delegate can reconstruct it.
        let base_payload = serialize_activation_payload(
            payload,
            SessionStatusReminderAction::Open,
            payload.approval.as_ref().map(|a| a.call_id.clone()),
        )
        .map_err(|e| format!("Failed to serialize activation payload: {e}"))?;

        let key = NSString::from_str("touchai_payload");
        let value = NSString::from_str(&base_payload);
        let user_info = NSDictionary::from_slices(&[&*key], &[&*value]);
        let user_info = unsafe {
            user_info.cast_unchecked::<objc2::runtime::AnyObject, objc2::runtime::AnyObject>()
        };
        unsafe {
            content.setUserInfo(user_info);
        }

        let identifier = make_notification_identifier(payload);
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&identifier),
            &content,
            None, // deliver immediately
        );

        center.addNotificationRequest_withCompletionHandler(
            &request,
            Some(&RcBlock::new(|_error| {})),
        );

        runtime.track_active_notification(identifier);

        Ok(())
    }

    /// Clear all tracked macOS notifications.
    pub fn clear(runtime: &super::SessionStatusReminderNotificationRuntime) {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let ids = {
            let mut guard = runtime
                .active_notification_ids
                .lock()
                .expect("session status reminder runtime poisoned");
            std::mem::take(&mut *guard)
        };
        if ids.is_empty() {
            return;
        }
        let identifiers: Vec<Retained<NSString>> =
            ids.iter().map(|id| NSString::from_str(id)).collect();
        let identifier_array = NSArray::from_retained_slice(&identifiers);
        center.removeDeliveredNotificationsWithIdentifiers(&identifier_array);
    }
}

// ---------------------------------------------------------------------------
// Linux notification support
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod linux_notifications {
    use notify_rust::{ActionResponse, Notification, Timeout};
    use tauri::{AppHandle, Runtime};

    use super::{
        SessionStatusReminderAction, SessionStatusReminderActionPayload, SessionStatusReminderKind,
        SessionStatusReminderNotificationPayload,
    };

    const STANDARD_REMINDER_TIMEOUT_MS: u32 = 15_000;
    fn notification_timeout(kind: SessionStatusReminderKind) -> Timeout {
        match kind {
            SessionStatusReminderKind::WaitingApproval => Timeout::Never,
            SessionStatusReminderKind::Completed | SessionStatusReminderKind::Failed => {
                Timeout::Milliseconds(STANDARD_REMINDER_TIMEOUT_MS)
            }
        }
    }

    fn resolve_action(action_name: &str) -> Option<SessionStatusReminderAction> {
        match action_name {
            "approve" => Some(SessionStatusReminderAction::Approve),
            "reject" => Some(SessionStatusReminderAction::Reject),
            "open" => Some(SessionStatusReminderAction::Open),
            "__closed" => None,
            _ => Some(SessionStatusReminderAction::Open),
        }
    }

    /// Show a session status reminder notification through the D-Bus
    /// notification daemon (GNOME / KDE / XFCE).
    pub fn show<R: Runtime>(
        app: &AppHandle<R>,
        runtime: &super::SessionStatusReminderNotificationRuntime,
        payload: &SessionStatusReminderNotificationPayload,
    ) -> Result<(), String> {
        let approve_label = payload
            .approval
            .as_ref()
            .map(|a| a.approve_label.as_str())
            .unwrap_or("Approve");
        let reject_label = payload
            .approval
            .as_ref()
            .map(|a| a.reject_label.as_str())
            .unwrap_or("Reject");
        let open_label = payload.open_label.as_deref().unwrap_or("Open");

        let mut notification = Notification::new();
        notification
            .summary(&payload.title)
            .body(&payload.body)
            .appname("TouchAI")
            .timeout(notification_timeout(payload.kind));

        if payload.kind == SessionStatusReminderKind::WaitingApproval && payload.approval.is_some()
        {
            notification.action("approve", approve_label);
            notification.action("reject", reject_label);
        } else {
            notification.action("open", open_label);
        }

        let handle = notification
            .show()
            .map_err(|error| format!("Failed to show Linux notification: {error}"))?;

        let notification_id = handle.id();
        let app_handle = app.clone();
        let action_payload = SessionStatusReminderActionPayload {
            action: SessionStatusReminderAction::Open,
            session_id: payload.session_id,
            task_id: payload.task_id.clone(),
            kind: payload.kind,
            call_id: payload.approval.as_ref().map(|a| a.call_id.clone()),
            reply_text: None,
        };

        runtime.track_active_notification(handle);

        // Listen for the notification action on a background thread while
        // keeping the original handle available for explicit closing.
        std::thread::spawn(move || {
            notify_rust::handle_action(notification_id, move |action| {
                if let Some(runtime) =
                    app_handle.try_state::<super::SessionStatusReminderNotificationRuntime>()
                {
                    runtime.release_active_notification(notification_id);
                }

                let resolved_action = match action {
                    ActionResponse::Custom(action_name) => resolve_action(action_name),
                    ActionResponse::Closed(_) => None,
                };
                let Some(resolved_action) = resolved_action else {
                    return;
                };

                let final_payload = SessionStatusReminderActionPayload {
                    action: resolved_action,
                    ..action_payload
                };

                super::restore_search_window_from_status_reminder(
                    app_handle.clone(),
                    Some(final_payload),
                );
            });
        });

        Ok(())
    }

    /// Clear tracked Linux notifications.
    pub fn clear(runtime: &super::SessionStatusReminderNotificationRuntime) {
        // Close any still-tracked notifications. Notifications that already
        // received an action are released from tracking by the action listener.
        runtime.clear_active_notifications();
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::{
        finalize_activation_payload, has_windows_installation_marker,
        should_restore_search_window_from_status_reminder, SessionStatusReminderAction,
        SessionStatusReminderActionPayload, SessionStatusReminderKind,
    };

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

    #[test]
    fn windows_installation_marker_requires_sibling_uninstall_exe() {
        let dir = tempdir().expect("tempdir");
        let exe_path = dir.path().join("TouchAI.exe");
        fs::write(&exe_path, b"binary").expect("write exe");

        assert!(!has_windows_installation_marker(&exe_path));

        fs::write(dir.path().join("uninstall.exe"), b"stub").expect("write uninstall");
        assert!(has_windows_installation_marker(&exe_path));
    }

    #[test]
    fn waiting_approval_approve_does_not_restore_search_window() {
        let payload = SessionStatusReminderActionPayload {
            action: SessionStatusReminderAction::Approve,
            session_id: 1,
            task_id: "task-1".to_string(),
            kind: SessionStatusReminderKind::WaitingApproval,
            call_id: Some("call-1".to_string()),
            reply_text: None,
        };

        assert!(!should_restore_search_window_from_status_reminder(Some(
            &payload
        )));
    }

    #[test]
    fn other_status_reminder_actions_still_restore_search_window() {
        let approve_completed = SessionStatusReminderActionPayload {
            action: SessionStatusReminderAction::Approve,
            session_id: 1,
            task_id: "task-1".to_string(),
            kind: SessionStatusReminderKind::Completed,
            call_id: None,
            reply_text: None,
        };
        let reject_waiting = SessionStatusReminderActionPayload {
            action: SessionStatusReminderAction::Reject,
            session_id: 1,
            task_id: "task-1".to_string(),
            kind: SessionStatusReminderKind::WaitingApproval,
            call_id: Some("call-1".to_string()),
            reply_text: None,
        };

        assert!(should_restore_search_window_from_status_reminder(None));
        assert!(should_restore_search_window_from_status_reminder(Some(
            &approve_completed
        )));
        assert!(should_restore_search_window_from_status_reminder(Some(
            &reject_waiting
        )));
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests_windows {
    use super::{
        build_toast_xml, SessionStatusReminderKind,
        SessionStatusReminderNotificationApprovalPayload, SessionStatusReminderNotificationPayload,
    };

    #[test]
    fn build_toast_xml_embeds_reply_input_for_non_approval_notifications() {
        let xml = build_toast_xml(&SessionStatusReminderNotificationPayload {
            title: "Done & ready".to_string(),
            body: "<approved>".to_string(),
            session_id: 7,
            task_id: "task-1".to_string(),
            kind: SessionStatusReminderKind::Completed,
            approval: None,
            open_label: None,
            reply_placeholder: Some("Reply to TouchAI".to_string()),
            reply_label: Some("Reply".to_string()),
        })
        .expect("toast xml");

        assert!(xml.contains("Done &amp; ready"));
        assert!(xml.contains("&lt;approved&gt;"));
        assert!(xml.contains("Reply to TouchAI"));
        assert!(xml.contains("reply"));
        assert!(xml.contains("input"));
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
            open_label: None,
            reply_placeholder: None,
            reply_label: None,
        })
        .expect("toast xml");

        assert!(xml.contains("<actions>"));
        assert!(xml.contains("scenario=\"reminder\""));
        assert!(xml.contains("Approve"));
        assert!(xml.contains("Reject"));
        assert!(!xml.contains("Reply to TouchAI"));
    }

    #[test]
    fn build_toast_xml_opens_waiting_reminder_without_approval_payload() {
        let xml = build_toast_xml(&SessionStatusReminderNotificationPayload {
            title: "Waiting for response".to_string(),
            body: "Pick the deployment target".to_string(),
            session_id: 11,
            task_id: "task-question".to_string(),
            kind: SessionStatusReminderKind::WaitingApproval,
            approval: None,
            open_label: Some("Open".to_string()),
            reply_placeholder: None,
            reply_label: None,
        })
        .expect("toast xml");

        assert!(xml.contains("<actions>"));
        assert!(xml.contains("Open"));
        assert!(!xml.contains("Approve"));
        assert!(!xml.contains("Reject"));
        assert!(!xml.contains("input"));
    }
}
