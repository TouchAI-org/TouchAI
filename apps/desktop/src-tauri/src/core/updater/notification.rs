// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

//! Actionable system notifications for application updates.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

use super::AppUpdateChannel;

const UPDATE_NOTIFICATION_ACTION_EVENT: &str = "app-update:notification-action";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateNotificationPayload {
    pub channel: AppUpdateChannel,
    pub version: String,
    pub title: String,
    pub body: String,
    pub update_label: String,
    pub ignore_label: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppUpdateNotificationAction {
    Open,
    Update,
    Ignore,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateNotificationActionPayload {
    pub action: AppUpdateNotificationAction,
    pub channel: AppUpdateChannel,
    pub version: String,
}

#[derive(Default)]
pub struct AppUpdateNotificationRuntime {
    #[cfg(target_os = "windows")]
    active_toast: std::sync::Mutex<Option<windows::UI::Notifications::ToastNotification>>,
}

pub fn dispatch_action<R: Runtime>(
    app: &AppHandle<R>,
    payload: &AppUpdateNotificationActionPayload,
) {
    if let Err(error) = app.emit_to("main", UPDATE_NOTIFICATION_ACTION_EVENT, payload) {
        log::warn!("Failed to dispatch update notification action: {error}");
    }
}

pub fn show<R: Runtime>(
    app: &AppHandle<R>,
    payload: &AppUpdateNotificationPayload,
) -> Result<(), String> {
    semver::Version::parse(payload.version.trim_start_matches('v'))
        .map_err(|error| format!("Invalid update notification version: {error}"))?;

    #[cfg(target_os = "windows")]
    return show_windows(app, payload);

    #[cfg(target_os = "macos")]
    return crate::core::window::status_reminder::show_app_update_notification(app, payload);

    #[cfg(target_os = "linux")]
    return show_linux(app, payload);

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Err("Update notifications are not supported on this platform".to_string())
}

#[cfg(target_os = "windows")]
fn show_windows<R: Runtime>(
    app: &AppHandle<R>,
    payload: &AppUpdateNotificationPayload,
) -> Result<(), String> {
    use tauri::Manager;
    use windows::core::{Interface, HSTRING};
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{
        NotificationSetting, ToastActivatedEventArgs, ToastFailedEventArgs, ToastNotification,
        ToastNotificationManager,
    };

    let runtime = app.state::<AppUpdateNotificationRuntime>();
    let toast = ToastNotification::CreateToastNotification(&build_toast_document(payload)?)
        .map_err(|error| error.to_string())?;
    toast
        .SetTag(&HSTRING::from("available-update"))
        .map_err(|error| error.to_string())?;
    toast
        .SetGroup(&HSTRING::from("app-updates"))
        .map_err(|error| error.to_string())?;
    toast
        .SetSuppressPopup(false)
        .map_err(|error| error.to_string())?;

    let action_app = app.clone();
    let expected_channel = payload.channel;
    let expected_version = payload.version.clone();
    toast
        .Activated(&TypedEventHandler::new(
            move |_sender: windows::core::Ref<'_, ToastNotification>,
                  args: windows::core::Ref<'_, windows::core::IInspectable>| {
                let action = args
                    .as_ref()
                    .and_then(|args| args.cast::<ToastActivatedEventArgs>().ok())
                    .and_then(|args| args.Arguments().ok())
                    .and_then(|args| {
                        serde_json::from_str::<AppUpdateNotificationActionPayload>(
                            &args.to_string(),
                        )
                        .ok()
                    });
                if let Some(action) = action.filter(|action| {
                    action.channel == expected_channel && action.version == expected_version
                }) {
                    dispatch_action(&action_app, &action);
                }
                Ok(())
            },
        ))
        .map_err(|error| error.to_string())?;
    toast
        .Failed(&TypedEventHandler::new(
            |_sender: windows::core::Ref<'_, ToastNotification>,
             args: windows::core::Ref<'_, ToastFailedEventArgs>| {
                log::warn!(
                    "Windows rejected update notification: {:?}",
                    args.as_ref().and_then(|args| args.ErrorCode().ok())
                );
                Ok(())
            },
        ))
        .map_err(|error| error.to_string())?;

    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(
        &app.config().identifier,
    ))
    .map_err(|error| error.to_string())?;
    let setting = notifier.Setting().map_err(|error| error.to_string())?;
    if setting != NotificationSetting::Enabled {
        return Err(format!(
            "Windows update notifications are disabled: {setting:?}"
        ));
    }
    notifier
        .Show(&toast)
        .map_err(|error| format!("Failed to show update notification: {error}"))?;
    *runtime
        .active_toast
        .lock()
        .map_err(|_| "Update notification lock poisoned")? = Some(toast);
    Ok(())
}

#[cfg(target_os = "windows")]
fn build_toast_document(
    payload: &AppUpdateNotificationPayload,
) -> Result<windows::Data::Xml::Dom::XmlDocument, String> {
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;

    let document = XmlDocument::new().map_err(|error| error.to_string())?;
    document.LoadXml(&HSTRING::from(
        "<toast><visual><binding template=\"ToastGeneric\"><text/><text/></binding></visual><actions/></toast>",
    )).map_err(|error| error.to_string())?;
    let root = document
        .DocumentElement()
        .map_err(|error| error.to_string())?;
    let action_payload = |action| AppUpdateNotificationActionPayload {
        action,
        channel: payload.channel,
        version: payload.version.clone(),
    };
    let launch = serde_json::to_string(&action_payload(AppUpdateNotificationAction::Open))
        .map_err(|error| error.to_string())?;
    root.SetAttribute(&HSTRING::from("launch"), &HSTRING::from(launch))
        .map_err(|error| error.to_string())?;
    let texts = document
        .GetElementsByTagName(&HSTRING::from("text"))
        .map_err(|error| error.to_string())?;
    for (index, text) in [&payload.title, &payload.body].into_iter().enumerate() {
        texts
            .Item(index as u32)
            .and_then(|node| node.SetInnerText(&HSTRING::from(text)))
            .map_err(|error| error.to_string())?;
    }
    let actions = document
        .SelectSingleNode(&HSTRING::from("/toast/actions"))
        .map_err(|error| error.to_string())?;
    for (label, action) in [
        (&payload.update_label, AppUpdateNotificationAction::Update),
        (&payload.ignore_label, AppUpdateNotificationAction::Ignore),
    ] {
        let element = document
            .CreateElement(&HSTRING::from("action"))
            .map_err(|error| error.to_string())?;
        let arguments =
            serde_json::to_string(&action_payload(action)).map_err(|error| error.to_string())?;
        for (name, value) in [
            ("content", label.as_str()),
            ("arguments", arguments.as_str()),
            ("activationType", "foreground"),
        ] {
            element
                .SetAttribute(&HSTRING::from(name), &HSTRING::from(value))
                .map_err(|error| error.to_string())?;
        }
        actions
            .AppendChild(&element)
            .map_err(|error| error.to_string())?;
    }
    Ok(document)
}

#[cfg(target_os = "linux")]
fn show_linux<R: Runtime>(
    app: &AppHandle<R>,
    payload: &AppUpdateNotificationPayload,
) -> Result<(), String> {
    let handle = notify_rust::Notification::new()
        .summary(&payload.title)
        .body(&payload.body)
        .appname("TouchAI")
        .action("update", &payload.update_label)
        .action("ignore", &payload.ignore_label)
        .action("default", "")
        .show()
        .map_err(|error| error.to_string())?;
    let app = app.clone();
    let channel = payload.channel;
    let version = payload.version.clone();
    std::thread::spawn(move || {
        handle.wait_for_action(|action| {
            let action = match action {
                "update" => AppUpdateNotificationAction::Update,
                "ignore" => AppUpdateNotificationAction::Ignore,
                "default" => AppUpdateNotificationAction::Open,
                _ => return,
            };
            dispatch_action(
                &app,
                &AppUpdateNotificationActionPayload {
                    action,
                    channel,
                    version: version.clone(),
                },
            );
        });
    });
    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn toast_contains_update_and_ignore_actions_with_escaped_text() {
        let payload = AppUpdateNotificationPayload {
            channel: AppUpdateChannel::Stable,
            version: "1.2.3".to_string(),
            title: "TouchAI & updates".to_string(),
            body: "Version <1.2.3>".to_string(),
            update_label: "Update now".to_string(),
            ignore_label: "Ignore version".to_string(),
        };
        let document = build_toast_document(&payload).expect("toast document");
        let xml = document.GetXml().expect("toast XML").to_string();
        assert!(xml.contains("TouchAI &amp; updates"));
        assert!(xml.contains("Version &lt;1.2.3&gt;"));
        assert!(xml.contains("Update now"));
        assert!(xml.contains("Ignore version"));
        assert!(xml.contains("&quot;action&quot;:&quot;update&quot;"));
        assert!(xml.contains("&quot;action&quot;:&quot;ignore&quot;"));
    }
}
