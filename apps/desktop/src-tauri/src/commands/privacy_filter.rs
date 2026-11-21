use crate::core::privacy_filter::records::{
    PrivacyProtectionDetails, PrivacyProtectionEntry, PrivacyProtectionRecordInput,
    RECORDS_CHANGED_EVENT,
};
use crate::core::privacy_filter::{
    self, PrivacyFilterDownloadProgress, PrivacyFilterModelStatus, PrivacyFilterRuntime,
    PrivacyFilterSpan,
};
use tauri::{AppHandle, Emitter, Runtime, State};

#[tauri::command]
pub fn privacy_filter_record_protection<R: Runtime>(
    app: AppHandle<R>,
    runtime: State<'_, PrivacyFilterRuntime>,
    record: PrivacyProtectionRecordInput,
    details: Option<PrivacyProtectionDetails>,
    generation: Option<u64>,
) -> Result<(), String> {
    if runtime
        .records
        .append_at_generation(record, details, generation)?
        .is_none()
    {
        return Ok(());
    }
    if app.emit(RECORDS_CHANGED_EVENT, ()).is_err() {
        log::warn!("Could not notify privacy protection record listeners");
    }
    Ok(())
}

#[tauri::command]
pub fn privacy_filter_record_generation(
    runtime: State<'_, PrivacyFilterRuntime>,
) -> Result<u64, String> {
    runtime.records.generation()
}

#[tauri::command]
pub fn privacy_filter_records(
    runtime: State<'_, PrivacyFilterRuntime>,
) -> Result<Vec<PrivacyProtectionEntry>, String> {
    runtime.records.entries()
}

#[tauri::command]
pub fn privacy_filter_record_restoration<R: Runtime>(
    app: AppHandle<R>,
    runtime: State<'_, PrivacyFilterRuntime>,
    record: PrivacyProtectionRecordInput,
    details: PrivacyProtectionDetails,
    generation: Option<u64>,
) -> Result<(), String> {
    if runtime
        .records
        .append_restoration_at_generation(record, details, generation)?
        .is_none()
    {
        return Ok(());
    }
    if app.emit(RECORDS_CHANGED_EVENT, ()).is_err() {
        log::warn!("Could not notify privacy restoration record listeners");
    }
    Ok(())
}

#[tauri::command]
pub fn privacy_filter_record_detail_ids(
    runtime: State<'_, PrivacyFilterRuntime>,
) -> Result<Vec<String>, String> {
    runtime.records.detail_ids()
}

#[tauri::command]
pub fn privacy_filter_record_details(
    runtime: State<'_, PrivacyFilterRuntime>,
    record_id: String,
) -> Result<Option<PrivacyProtectionDetails>, String> {
    runtime.records.details(&record_id)
}

#[tauri::command]
pub fn privacy_filter_clear_records<R: Runtime>(
    app: AppHandle<R>,
    runtime: State<'_, PrivacyFilterRuntime>,
) -> Result<u64, String> {
    let generation = runtime.records.clear()?;
    if app
        .emit(
            RECORDS_CHANGED_EVENT,
            serde_json::json!({"cleared": true, "generation": generation}),
        )
        .is_err()
    {
        log::warn!("Could not notify privacy protection record listeners");
    }
    Ok(generation)
}

#[tauri::command]
pub fn privacy_filter_models() -> Vec<privacy_filter::models::PrivacyFilterModelInfo> {
    privacy_filter::models::catalog()
}

#[tauri::command]
pub fn privacy_filter_model_status(
    runtime: State<'_, PrivacyFilterRuntime>,
    model_id: Option<privacy_filter::models::PrivacyFilterModelId>,
) -> Result<PrivacyFilterModelStatus, String> {
    privacy_filter::model_status(runtime.inner(), model_id.unwrap_or_default())
}

#[tauri::command]
pub async fn privacy_filter_download_model<R: Runtime>(
    app: AppHandle<R>,
    runtime: State<'_, PrivacyFilterRuntime>,
    model_id: Option<privacy_filter::models::PrivacyFilterModelId>,
    source: Option<privacy_filter::models::PrivacyFilterModelSource>,
) -> Result<(), String> {
    privacy_filter::download_model(
        app,
        runtime.inner().clone(),
        model_id.unwrap_or_default(),
        source.unwrap_or_default(),
    )
    .await
}

#[tauri::command]
pub fn privacy_filter_cancel_model_download(
    runtime: State<'_, PrivacyFilterRuntime>,
    model_id: Option<privacy_filter::models::PrivacyFilterModelId>,
) -> Result<(), String> {
    runtime.cancel_download(model_id.unwrap_or_default())
}

#[tauri::command]
pub async fn privacy_filter_delete_model<R: Runtime>(
    app: AppHandle<R>,
    runtime: State<'_, PrivacyFilterRuntime>,
    model_id: Option<privacy_filter::models::PrivacyFilterModelId>,
) -> Result<(), String> {
    let model_id = model_id.unwrap_or_default();
    privacy_filter::delete_model(runtime.inner(), model_id).await?;
    let _ = app.emit(
        privacy_filter::DOWNLOAD_PROGRESS_EVENT,
        PrivacyFilterDownloadProgress {
            model_id,
            downloaded_bytes: 0,
            total_bytes: 0,
            current_file: String::new(),
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn privacy_filter_release_models(
    runtime: State<'_, PrivacyFilterRuntime>,
) -> Result<(), String> {
    runtime.release_models().await
}

#[tauri::command]
pub async fn privacy_filter_detect(
    runtime: State<'_, PrivacyFilterRuntime>,
    texts: Vec<String>,
    model_id: Option<privacy_filter::models::PrivacyFilterModelId>,
) -> Result<Vec<Vec<PrivacyFilterSpan>>, String> {
    let model_id = model_id.unwrap_or_default();
    let directory = privacy_filter::model_directory(model_id)?;
    privacy_filter::detect_with_model(runtime.inner(), texts, directory, model_id).await
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    use tauri::{
        ipc::{CallbackFn, InvokeBody},
        test::{
            get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY,
        },
        WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    };

    fn invoke(window: &WebviewWindow<MockRuntime>, command: &str, body: Value) -> Value {
        get_ipc_response(
            window,
            tauri::webview::InvokeRequest {
                cmd: command.to_string(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: if cfg!(windows) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .expect("test url"),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .expect("privacy command succeeds")
        .deserialize()
        .expect("privacy response")
    }

    #[test]
    fn user_records_a_request_then_settings_reads_memory_only_details_and_clearing_removes_both_while_legacy_payloads_still_work(
    ) {
        let app = mock_builder()
            .manage(super::PrivacyFilterRuntime::default())
            .invoke_handler(crate::commands::invoke_handler::<MockRuntime>())
            .build(mock_context(noop_assets()))
            .expect("test app");
        let main = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .visible(false)
            .build()
            .expect("main window");
        let settings = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::default())
            .visible(false)
            .build()
            .expect("settings window");
        let summary = json!({"mode": "rules", "outcome": "protected", "maskedCount": 1, "categories": [{"kind": "email", "count": 1}]});
        let generation = invoke(&main, "privacy_filter_record_generation", json!({}));
        let details = json!({"values": [{"kind": "email", "original": "alice@example.test", "placeholder": "{{EMAIL_0123456789abcdef}}", "count": 1, "matches": [{"id": "email", "count": 1}]}], "texts": ["Email {{EMAIL_0123456789abcdef}}"], "truncated": false});
        invoke(
            &main,
            "privacy_filter_record_protection",
            json!({"record": summary, "details": details}),
        );
        let records = invoke(&settings, "privacy_filter_records", json!({}));
        assert_eq!(records[0]["maskedCount"], 1);
        assert!(records[0].get("values").is_none());
        let id = records[0]["id"].as_str().expect("record id");
        assert_eq!(
            invoke(
                &settings,
                "privacy_filter_record_details",
                json!({"recordId": id})
            ),
            details
        );
        assert!(invoke(
            &settings,
            "privacy_filter_record_details",
            json!({"recordId": "unknown"})
        )
        .is_null());
        invoke(
            &main,
            "privacy_filter_record_restoration",
            json!({"record": summary, "details": details}),
        );
        let entries = invoke(&settings, "privacy_filter_records", json!({}));
        let restored = entries
            .as_array()
            .expect("entries")
            .iter()
            .find(|entry| entry["direction"] == "restore")
            .expect("reverse record");
        let reply_id = restored["id"].as_str().expect("reply id");
        assert_eq!(
            invoke(
                &settings,
                "privacy_filter_record_details",
                json!({"recordId": reply_id})
            ),
            details
        );
        let cleared = invoke(&settings, "privacy_filter_clear_records", json!({}));
        assert_eq!(cleared, json!(generation.as_u64().expect("generation") + 1));
        for command in [
            "privacy_filter_record_protection",
            "privacy_filter_record_restoration",
        ] {
            invoke(
                &main,
                command,
                json!({"record": summary, "details": details, "generation": generation}),
            );
        }
        assert_eq!(
            invoke(&main, "privacy_filter_records", json!({})),
            json!([])
        );
        assert!(invoke(
            &main,
            "privacy_filter_record_details",
            json!({"recordId": id})
        )
        .is_null());
        assert!(invoke(
            &main,
            "privacy_filter_record_details",
            json!({"recordId": reply_id})
        )
        .is_null());
        invoke(
            &main,
            "privacy_filter_record_protection",
            json!({"record": summary}),
        );
        assert_eq!(
            invoke(&settings, "privacy_filter_records", json!({}))[0]["maskedCount"],
            1
        );
    }
}
