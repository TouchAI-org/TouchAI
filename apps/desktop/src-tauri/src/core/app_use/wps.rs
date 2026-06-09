// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

use super::{
    discovery, AppUseActRequest, AppUseActResponse, AppUseAdapter, AppUseAuthorizeActRequest,
    AppUseObserveRequest, AppUseObserveResponse,
};
use base64::{engine::general_purpose, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

pub trait WpsAutomationRunner: Send + Sync {
    fn run_script(&self, script: &str, timeout_ms: u64) -> Result<String, String>;
}

struct PowerShellWpsAutomationRunner;

fn powershell_executable() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let windows_root = PathBuf::from(r"C:\Windows");
        let wow64_powershell = windows_root
            .join("SysWOW64")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");

        if wow64_powershell.exists() {
            return Ok(wow64_powershell);
        }

        return Err(format!(
            "Trusted Windows PowerShell executable is unavailable at {}.",
            wow64_powershell.display()
        ));
    }

    #[cfg(not(windows))]
    {
        Err("WPS App Use automation is only available on Windows.".to_string())
    }
}

fn powershell_arguments(encoded_script: &str) -> Vec<String> {
    [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Sta",
        "-EncodedCommand",
        encoded_script,
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

impl WpsAutomationRunner for PowerShellWpsAutomationRunner {
    fn run_script(&self, script: &str, timeout_ms: u64) -> Result<String, String> {
        let encoded_script = general_purpose::STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        let shell_path = powershell_executable()?;
        let mut child = Command::new(&shell_path)
            .args(powershell_arguments(&encoded_script))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                format!(
                    "Failed to start WPS automation shell ({}): {error}",
                    shell_path.display()
                )
            })?;

        let started_at = Instant::now();
        let timeout = Duration::from_millis(timeout_ms.max(1_000));
        loop {
            match child
                .try_wait()
                .map_err(|error| format!("Failed to wait for WPS automation shell: {error}"))?
            {
                Some(_) => {
                    let output = child.wait_with_output().map_err(|error| {
                        format!("Failed to collect WPS automation output: {error}")
                    })?;
                    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    if output.status.success() {
                        return Ok(stdout);
                    }

                    return Err(if stderr.is_empty() { stdout } else { stderr });
                }
                None if started_at.elapsed() >= timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "WPS automation timed out after {timeout_ms}ms while waiting for KWPS.Application. Check WPS COM registration and close any blocking WPS first-run or modal prompts."
                    ));
                }
                None => thread::sleep(Duration::from_millis(50)),
            }
        }
    }
}

pub struct WpsWriterAdapter {
    runner: Arc<dyn WpsAutomationRunner>,
}

impl WpsWriterAdapter {
    pub fn new() -> Self {
        Self {
            runner: Arc::new(PowerShellWpsAutomationRunner),
        }
    }

    #[cfg(test)]
    pub fn with_runner(runner: Arc<dyn WpsAutomationRunner>) -> Self {
        Self { runner }
    }
}

impl Default for WpsWriterAdapter {
    fn default() -> Self {
        Self::new()
    }
}

pub struct WpsSpreadsheetAdapter {
    runner: Arc<dyn WpsAutomationRunner>,
}

impl WpsSpreadsheetAdapter {
    pub fn new() -> Self {
        Self {
            runner: Arc::new(PowerShellWpsAutomationRunner),
        }
    }

    #[cfg(test)]
    pub fn with_runner(runner: Arc<dyn WpsAutomationRunner>) -> Self {
        Self { runner }
    }
}

impl Default for WpsSpreadsheetAdapter {
    fn default() -> Self {
        Self::new()
    }
}

pub struct WpsPresentationAdapter {
    runner: Arc<dyn WpsAutomationRunner>,
}

impl WpsPresentationAdapter {
    pub fn new() -> Self {
        Self {
            runner: Arc::new(PowerShellWpsAutomationRunner),
        }
    }

    #[cfg(test)]
    pub fn with_runner(runner: Arc<dyn WpsAutomationRunner>) -> Self {
        Self { runner }
    }
}

impl Default for WpsPresentationAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl AppUseAdapter for WpsWriterAdapter {
    fn id(&self) -> &'static str {
        "wps_writer"
    }

    fn label(&self) -> &'static str {
        "WPS Writer"
    }

    fn capabilities(&self) -> &'static [&'static str] {
        &[
            "discover",
            "observe_active_document",
            "observe_selection",
            "replace_document_text",
            "format_document_text",
        ]
    }

    fn vendor(&self) -> &'static str {
        "WPS Office"
    }

    fn contract_version(&self) -> &'static str {
        "wps-com-v1"
    }

    fn observe_scopes(&self) -> &'static [&'static str] {
        &["active_document", "selection"]
    }

    fn actions(&self) -> &'static [&'static str] {
        &["replace_document_text", "format_document_text"]
    }

    fn installed(&self) -> bool {
        discovery::discover_adapter_install_status(self.id()).installed
    }

    fn observe(&self, request: &AppUseObserveRequest) -> AppUseObserveResponse {
        let owned_target = match validate_owned_target(request.target_id.as_deref(), false) {
            Ok(owned_target) => owned_target,
            Err(error) => {
                return AppUseObserveResponse {
                    ok: false,
                    adapter_id: request.adapter_id.clone(),
                    scope: request.scope.clone(),
                    target: request.target_id.clone(),
                    content: Some(error),
                    metadata: json!({
                        "executionId": request.execution_id,
                        "reason": "target_not_owned",
                    }),
                    truncated: false,
                };
            }
        };
        let target_path = owned_target.as_ref().map(OwnedTargetGuard::path_string);
        let script = wps_observe_script(target_path.as_deref(), &request.scope);
        match run_json_script(self.runner.as_ref(), &script, request.config.timeout_ms) {
            Ok(metadata) => {
                let content = format_observe_content(&metadata, &request.scope);
                let (content, truncated) = truncate_content(content, request.max_output_chars);
                AppUseObserveResponse {
                    ok: true,
                    adapter_id: request.adapter_id.clone(),
                    scope: request.scope.clone(),
                    target: target_path,
                    content: Some(content),
                    metadata,
                    truncated,
                }
            }
            Err(error) => AppUseObserveResponse {
                ok: false,
                adapter_id: request.adapter_id.clone(),
                scope: request.scope.clone(),
                target: request.target_id.clone(),
                content: Some(error),
                metadata: json!({
                    "executionId": request.execution_id,
                    "reason": "wps_automation_failed",
                }),
                truncated: false,
            },
        }
    }

    fn validate_act(&self, request: &AppUseAuthorizeActRequest) -> Result<(), String> {
        if !matches!(
            request.action.as_str(),
            "replace_document_text" | "format_document_text"
        ) {
            return Err(format!("Unsupported WPS Writer action: {}", request.action));
        }

        if request.action == "format_document_text" {
            format_document_text_parameters(request.parameters.as_ref()).map(|_| ())?;
        } else {
            text_parameter(request.parameters.as_ref()).map(|_| ())?;
        }
        validate_owned_target(request.target_id.as_deref(), true).map(|_| ())
    }

    fn act(&self, request: &AppUseActRequest) -> AppUseActResponse {
        if !matches!(
            request.action.as_str(),
            "replace_document_text" | "format_document_text"
        ) {
            return AppUseActResponse {
                ok: false,
                adapter_id: request.adapter_id.clone(),
                action: request.action.clone(),
                receipt: format!("Unsupported WPS Writer action: {}", request.action),
                changed: false,
                metadata: json!({
                    "executionId": request.execution_id,
                    "reason": "unsupported_action",
                }),
            };
        }

        enum WpsWriterActionPayload {
            Format(WpsSelectionFormat),
            Replace(String),
        }

        let payload = if request.action == "format_document_text" {
            match format_document_text_parameters(request.parameters.as_ref()) {
                Ok(format) => WpsWriterActionPayload::Format(format),
                Err(error) => {
                    return AppUseActResponse {
                        ok: false,
                        adapter_id: request.adapter_id.clone(),
                        action: request.action.clone(),
                        receipt: error,
                        changed: false,
                        metadata: json!({
                            "executionId": request.execution_id,
                            "reason": "invalid_parameters",
                        }),
                    };
                }
            }
        } else {
            match text_parameter(request.parameters.as_ref()) {
                Ok(text) => WpsWriterActionPayload::Replace(text),
                Err(error) => {
                    return AppUseActResponse {
                        ok: false,
                        adapter_id: request.adapter_id.clone(),
                        action: request.action.clone(),
                        receipt: error,
                        changed: false,
                        metadata: json!({
                            "executionId": request.execution_id,
                            "reason": "invalid_parameters",
                        }),
                    };
                }
            }
        };

        let owned_target = match validate_owned_target(request.target_id.as_deref(), true) {
            Ok(Some(owned_target)) => owned_target,
            Ok(None) => {
                return AppUseActResponse {
                    ok: false,
                    adapter_id: request.adapter_id.clone(),
                    action: request.action.clone(),
                    receipt: "WPS Writer targetId must reference a TouchAI-owned document before running write actions.".to_string(),
                    changed: false,
                    metadata: json!({
                        "executionId": request.execution_id,
                        "reason": "target_not_owned",
                    }),
                };
            }
            Err(error) => {
                return AppUseActResponse {
                    ok: false,
                    adapter_id: request.adapter_id.clone(),
                    action: request.action.clone(),
                    receipt: error,
                    changed: false,
                    metadata: json!({
                        "executionId": request.execution_id,
                        "reason": "target_not_owned",
                    }),
                };
            }
        };
        let target_path = owned_target.path_string();
        let script = match payload {
            WpsWriterActionPayload::Format(format) => {
                wps_format_document_text_script(&format, Some(&target_path))
            }
            WpsWriterActionPayload::Replace(text) => {
                wps_type_text_script(&text, Some(&target_path))
            }
        };

        match run_json_script(self.runner.as_ref(), &script, request.config.timeout_ms) {
            Ok(metadata) => {
                let document_name = metadata
                    .get("documentName")
                    .and_then(Value::as_str)
                    .unwrap_or("active WPS document");
                AppUseActResponse {
                    ok: true,
                    adapter_id: request.adapter_id.clone(),
                    action: request.action.clone(),
                    receipt: format!(
                        "WPS Writer {} completed for {document_name}",
                        request.action
                    ),
                    changed: metadata
                        .get("changed")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    metadata,
                }
            }
            Err(error) => AppUseActResponse {
                ok: false,
                adapter_id: request.adapter_id.clone(),
                action: request.action.clone(),
                receipt: error,
                changed: false,
                metadata: json!({
                    "executionId": request.execution_id,
                    "reason": "wps_automation_failed",
                }),
            },
        }
    }
}

impl AppUseAdapter for WpsSpreadsheetAdapter {
    fn id(&self) -> &'static str {
        "wps_spreadsheet"
    }

    fn label(&self) -> &'static str {
        "WPS Spreadsheet"
    }

    fn capabilities(&self) -> &'static [&'static str] {
        &[
            "discover",
            "observe_workbook",
            "observe_worksheet",
            "write_cells",
        ]
    }

    fn vendor(&self) -> &'static str {
        "WPS Office"
    }

    fn contract_version(&self) -> &'static str {
        "wps-com-v1"
    }

    fn observe_scopes(&self) -> &'static [&'static str] {
        &["workbook", "worksheet"]
    }

    fn actions(&self) -> &'static [&'static str] {
        &["write_cells"]
    }

    fn installed(&self) -> bool {
        discovery::discover_adapter_install_status(self.id()).installed
    }

    fn observe(&self, request: &AppUseObserveRequest) -> AppUseObserveResponse {
        let owned_target = match validate_owned_target_for_app(
            request.target_id.as_deref(),
            false,
            self.label(),
        ) {
            Ok(owned_target) => owned_target,
            Err(error) => {
                return AppUseObserveResponse {
                    ok: false,
                    adapter_id: request.adapter_id.clone(),
                    scope: request.scope.clone(),
                    target: request.target_id.clone(),
                    content: Some(error),
                    metadata: json!({
                        "executionId": request.execution_id,
                        "reason": "target_not_owned",
                    }),
                    truncated: false,
                };
            }
        };
        let target_path = owned_target.as_ref().map(OwnedTargetGuard::path_string);
        let script = wps_spreadsheet_observe_script(target_path.as_deref());
        match run_json_script(self.runner.as_ref(), &script, request.config.timeout_ms) {
            Ok(metadata) => {
                let content = format_spreadsheet_observe_content(&metadata, &request.scope);
                let (content, truncated) = truncate_content(content, request.max_output_chars);
                AppUseObserveResponse {
                    ok: true,
                    adapter_id: request.adapter_id.clone(),
                    scope: request.scope.clone(),
                    target: target_path,
                    content: Some(content),
                    metadata,
                    truncated,
                }
            }
            Err(error) => AppUseObserveResponse {
                ok: false,
                adapter_id: request.adapter_id.clone(),
                scope: request.scope.clone(),
                target: request.target_id.clone(),
                content: Some(error),
                metadata: json!({
                    "executionId": request.execution_id,
                    "reason": "wps_automation_failed",
                }),
                truncated: false,
            },
        }
    }

    fn validate_act(&self, request: &AppUseAuthorizeActRequest) -> Result<(), String> {
        if request.action != "write_cells" {
            return Err(format!(
                "Unsupported WPS Spreadsheet action: {}",
                request.action
            ));
        }

        spreadsheet_write_parameters(request.parameters.as_ref()).map(|_| ())?;
        validate_owned_target_for_app(request.target_id.as_deref(), true, self.label()).map(|_| ())
    }

    fn act(&self, request: &AppUseActRequest) -> AppUseActResponse {
        if request.action != "write_cells" {
            return AppUseActResponse {
                ok: false,
                adapter_id: request.adapter_id.clone(),
                action: request.action.clone(),
                receipt: format!("Unsupported WPS Spreadsheet action: {}", request.action),
                changed: false,
                metadata: json!({
                    "executionId": request.execution_id,
                    "reason": "unsupported_action",
                }),
            };
        }

        let cells = match spreadsheet_write_parameters(request.parameters.as_ref()) {
            Ok(cells) => cells,
            Err(error) => {
                return AppUseActResponse {
                    ok: false,
                    adapter_id: request.adapter_id.clone(),
                    action: request.action.clone(),
                    receipt: error,
                    changed: false,
                    metadata: json!({
                        "executionId": request.execution_id,
                        "reason": "invalid_parameters",
                    }),
                };
            }
        };

        let owned_target = match validate_owned_target_for_app(
            request.target_id.as_deref(),
            true,
            self.label(),
        ) {
            Ok(Some(owned_target)) => owned_target,
            Ok(None) => {
                return AppUseActResponse {
                        ok: false,
                        adapter_id: request.adapter_id.clone(),
                        action: request.action.clone(),
                        receipt: format!(
                            "{} targetId must reference a TouchAI-owned document before running write actions.",
                            self.label()
                        ),
                        changed: false,
                        metadata: json!({
                            "executionId": request.execution_id,
                            "reason": "target_not_owned",
                        }),
                    };
            }
            Err(error) => {
                return AppUseActResponse {
                    ok: false,
                    adapter_id: request.adapter_id.clone(),
                    action: request.action.clone(),
                    receipt: error,
                    changed: false,
                    metadata: json!({
                        "executionId": request.execution_id,
                        "reason": "target_not_owned",
                    }),
                };
            }
        };
        let target_path = owned_target.path_string();
        let script = wps_spreadsheet_write_cells_script(&cells, Some(&target_path));
        match run_json_script(self.runner.as_ref(), &script, request.config.timeout_ms) {
            Ok(metadata) => {
                let workbook_name = metadata
                    .get("workbookName")
                    .and_then(Value::as_str)
                    .unwrap_or("active WPS workbook");
                AppUseActResponse {
                    ok: true,
                    adapter_id: request.adapter_id.clone(),
                    action: request.action.clone(),
                    receipt: format!("WPS Spreadsheet write_cells completed for {workbook_name}"),
                    changed: metadata
                        .get("changed")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    metadata,
                }
            }
            Err(error) => AppUseActResponse {
                ok: false,
                adapter_id: request.adapter_id.clone(),
                action: request.action.clone(),
                receipt: error,
                changed: false,
                metadata: json!({
                    "executionId": request.execution_id,
                    "reason": "wps_automation_failed",
                }),
            },
        }
    }
}

impl AppUseAdapter for WpsPresentationAdapter {
    fn id(&self) -> &'static str {
        "wps_presentation"
    }

    fn label(&self) -> &'static str {
        "WPS Presentation"
    }

    fn capabilities(&self) -> &'static [&'static str] {
        &[
            "discover",
            "observe_presentation",
            "observe_slide",
            "add_slide_text",
        ]
    }

    fn vendor(&self) -> &'static str {
        "WPS Office"
    }

    fn contract_version(&self) -> &'static str {
        "wps-com-v1"
    }

    fn observe_scopes(&self) -> &'static [&'static str] {
        &["presentation", "slide"]
    }

    fn actions(&self) -> &'static [&'static str] {
        &["add_slide_text"]
    }

    fn installed(&self) -> bool {
        discovery::discover_adapter_install_status(self.id()).installed
    }

    fn observe(&self, request: &AppUseObserveRequest) -> AppUseObserveResponse {
        let owned_target = match validate_owned_target_for_app(
            request.target_id.as_deref(),
            false,
            self.label(),
        ) {
            Ok(owned_target) => owned_target,
            Err(error) => {
                return AppUseObserveResponse {
                    ok: false,
                    adapter_id: request.adapter_id.clone(),
                    scope: request.scope.clone(),
                    target: request.target_id.clone(),
                    content: Some(error),
                    metadata: json!({
                        "executionId": request.execution_id,
                        "reason": "target_not_owned",
                    }),
                    truncated: false,
                };
            }
        };
        let target_path = owned_target.as_ref().map(OwnedTargetGuard::path_string);
        let script = wps_presentation_observe_script(target_path.as_deref());
        match run_json_script(self.runner.as_ref(), &script, request.config.timeout_ms) {
            Ok(metadata) => {
                let content = format_presentation_observe_content(&metadata, &request.scope);
                let (content, truncated) = truncate_content(content, request.max_output_chars);
                AppUseObserveResponse {
                    ok: true,
                    adapter_id: request.adapter_id.clone(),
                    scope: request.scope.clone(),
                    target: target_path,
                    content: Some(content),
                    metadata,
                    truncated,
                }
            }
            Err(error) => AppUseObserveResponse {
                ok: false,
                adapter_id: request.adapter_id.clone(),
                scope: request.scope.clone(),
                target: request.target_id.clone(),
                content: Some(error),
                metadata: json!({
                    "executionId": request.execution_id,
                    "reason": "wps_automation_failed",
                }),
                truncated: false,
            },
        }
    }

    fn validate_act(&self, request: &AppUseAuthorizeActRequest) -> Result<(), String> {
        if request.action != "add_slide_text" {
            return Err(format!(
                "Unsupported WPS Presentation action: {}",
                request.action
            ));
        }

        presentation_text_parameters(request.parameters.as_ref()).map(|_| ())?;
        validate_owned_target_for_app(request.target_id.as_deref(), true, self.label()).map(|_| ())
    }

    fn act(&self, request: &AppUseActRequest) -> AppUseActResponse {
        if request.action != "add_slide_text" {
            return AppUseActResponse {
                ok: false,
                adapter_id: request.adapter_id.clone(),
                action: request.action.clone(),
                receipt: format!("Unsupported WPS Presentation action: {}", request.action),
                changed: false,
                metadata: json!({
                    "executionId": request.execution_id,
                    "reason": "unsupported_action",
                }),
            };
        }

        let slide_text = match presentation_text_parameters(request.parameters.as_ref()) {
            Ok(slide_text) => slide_text,
            Err(error) => {
                return AppUseActResponse {
                    ok: false,
                    adapter_id: request.adapter_id.clone(),
                    action: request.action.clone(),
                    receipt: error,
                    changed: false,
                    metadata: json!({
                        "executionId": request.execution_id,
                        "reason": "invalid_parameters",
                    }),
                };
            }
        };

        let owned_target = match validate_owned_target_for_app(
            request.target_id.as_deref(),
            true,
            self.label(),
        ) {
            Ok(Some(owned_target)) => owned_target,
            Ok(None) => {
                return AppUseActResponse {
                        ok: false,
                        adapter_id: request.adapter_id.clone(),
                        action: request.action.clone(),
                        receipt: format!(
                            "{} targetId must reference a TouchAI-owned document before running write actions.",
                            self.label()
                        ),
                        changed: false,
                        metadata: json!({
                            "executionId": request.execution_id,
                            "reason": "target_not_owned",
                        }),
                    };
            }
            Err(error) => {
                return AppUseActResponse {
                    ok: false,
                    adapter_id: request.adapter_id.clone(),
                    action: request.action.clone(),
                    receipt: error,
                    changed: false,
                    metadata: json!({
                        "executionId": request.execution_id,
                        "reason": "target_not_owned",
                    }),
                };
            }
        };
        let target_path = owned_target.path_string();
        let script = wps_presentation_add_slide_text_script(&slide_text, Some(&target_path));
        match run_json_script(self.runner.as_ref(), &script, request.config.timeout_ms) {
            Ok(metadata) => {
                let presentation_name = metadata
                    .get("presentationName")
                    .and_then(Value::as_str)
                    .unwrap_or("active WPS presentation");
                AppUseActResponse {
                    ok: true,
                    adapter_id: request.adapter_id.clone(),
                    action: request.action.clone(),
                    receipt: format!(
                        "WPS Presentation add_slide_text completed for {presentation_name}"
                    ),
                    changed: metadata
                        .get("changed")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    metadata,
                }
            }
            Err(error) => AppUseActResponse {
                ok: false,
                adapter_id: request.adapter_id.clone(),
                action: request.action.clone(),
                receipt: error,
                changed: false,
                metadata: json!({
                    "executionId": request.execution_id,
                    "reason": "wps_automation_failed",
                }),
            },
        }
    }
}

fn run_json_script(
    runner: &dyn WpsAutomationRunner,
    script: &str,
    timeout_ms: u64,
) -> Result<Value, String> {
    let output = runner.run_script(script, timeout_ms)?;
    serde_json::from_str(output.trim())
        .map_err(|error| format!("WPS automation returned invalid JSON: {error}"))
}

fn text_parameter(parameters: Option<&Value>) -> Result<String, String> {
    let text = parameters
        .and_then(|value| value.get("text"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_default();

    if text.trim().is_empty() {
        return Err("WPS Writer action requires a non-empty text parameter.".to_string());
    }
    if text.chars().count() > 20_000 {
        return Err("WPS Writer text must be 20000 characters or fewer.".to_string());
    }

    Ok(text)
}

#[derive(Clone, Debug, Default, PartialEq)]
struct WpsSelectionFormat {
    bold: Option<bool>,
    italic: Option<bool>,
    underline: Option<bool>,
    font_size: Option<f64>,
    font_name: Option<String>,
}

impl WpsSelectionFormat {
    fn is_empty(&self) -> bool {
        self.bold.is_none()
            && self.italic.is_none()
            && self.underline.is_none()
            && self.font_size.is_none()
            && self.font_name.is_none()
    }
}

fn format_document_text_parameters(
    parameters: Option<&Value>,
) -> Result<WpsSelectionFormat, String> {
    let Some(parameters) = parameters.and_then(Value::as_object) else {
        return Err(
            "WPS Writer format_document_text requires structured format parameters.".to_string(),
        );
    };

    let mut format = WpsSelectionFormat::default();
    if let Some(value) = parameters.get("bold") {
        format.bold = Some(value.as_bool().ok_or_else(|| {
            "WPS Writer format_document_text bold must be a boolean.".to_string()
        })?);
    }
    if let Some(value) = parameters.get("italic") {
        format.italic = Some(value.as_bool().ok_or_else(|| {
            "WPS Writer format_document_text italic must be a boolean.".to_string()
        })?);
    }
    if let Some(value) = parameters.get("underline") {
        format.underline = Some(value.as_bool().ok_or_else(|| {
            "WPS Writer format_document_text underline must be a boolean.".to_string()
        })?);
    }
    if let Some(value) = parameters.get("fontSize") {
        let font_size = value.as_f64().ok_or_else(|| {
            "WPS Writer format_document_text fontSize must be a number.".to_string()
        })?;
        if !(6.0..=96.0).contains(&font_size) {
            return Err(
                "WPS Writer format_document_text fontSize must be between 6 and 96.".to_string(),
            );
        }
        format.font_size = Some(font_size);
    }
    if let Some(value) = parameters.get("fontName") {
        let font_name = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "WPS Writer format_document_text fontName must be a non-empty string.".to_string()
            })?;
        if font_name.chars().count() > 128 {
            return Err(
                "WPS Writer format_document_text fontName must be 128 characters or fewer."
                    .to_string(),
            );
        }
        format.font_name = Some(font_name.to_string());
    }

    if format.is_empty() {
        return Err(
            "WPS Writer format_document_text requires at least one format option.".to_string(),
        );
    }

    Ok(format)
}

#[derive(Clone, Debug, PartialEq)]
struct WpsSpreadsheetWriteCells {
    range: String,
    sheet_name: Option<String>,
    values: Vec<Vec<Value>>,
}

const WPS_SPREADSHEET_MAX_ROWS: usize = 100;
const WPS_SPREADSHEET_MAX_COLUMNS: usize = 50;
const WPS_SPREADSHEET_MAX_CELLS: usize = 5_000;
const WPS_SPREADSHEET_MAX_CELL_TEXT_CHARS: usize = 4_096;
const WPS_SPREADSHEET_MAX_VALUES_JSON_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, PartialEq)]
struct WpsPresentationSlideText {
    text: String,
    slide_index: Option<i64>,
}

fn presentation_text_parameters(
    parameters: Option<&Value>,
) -> Result<WpsPresentationSlideText, String> {
    let Some(parameters) = parameters.and_then(Value::as_object) else {
        return Err(
            "WPS Presentation add_slide_text requires structured text parameters.".to_string(),
        );
    };

    let text = parameters
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "WPS Presentation add_slide_text requires a non-empty text parameter.".to_string()
        })?;
    if text.chars().count() > 2_000 {
        return Err(
            "WPS Presentation add_slide_text text must be 2000 characters or fewer.".to_string(),
        );
    }

    let slide_index = match parameters.get("slideIndex") {
        Some(value) => {
            let index = value.as_i64().ok_or_else(|| {
                "WPS Presentation add_slide_text slideIndex must be an integer.".to_string()
            })?;
            if index < 1 {
                return Err(
                    "WPS Presentation add_slide_text slideIndex must be at least 1.".to_string(),
                );
            }
            Some(index)
        }
        None => None,
    };

    Ok(WpsPresentationSlideText {
        text: text.to_string(),
        slide_index,
    })
}

fn validate_spreadsheet_cell(cell: &Value) -> Result<(), String> {
    let Value::String(text) = cell else {
        return Ok(());
    };

    if text.chars().count() > WPS_SPREADSHEET_MAX_CELL_TEXT_CHARS {
        return Err(format!(
            "WPS Spreadsheet write_cells cell text must be {WPS_SPREADSHEET_MAX_CELL_TEXT_CHARS} characters or fewer."
        ));
    }

    let trimmed = text.trim_start();
    if trimmed.starts_with(['=', '+', '-', '@']) {
        return Err(
            "WPS Spreadsheet write_cells rejects formula-like strings; formulas require an explicit future action."
                .to_string(),
        );
    }

    Ok(())
}

fn spreadsheet_write_parameters(
    parameters: Option<&Value>,
) -> Result<WpsSpreadsheetWriteCells, String> {
    let Some(parameters) = parameters.and_then(Value::as_object) else {
        return Err("WPS Spreadsheet write_cells requires structured cell parameters.".to_string());
    };

    let range = parameters
        .get("range")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "WPS Spreadsheet write_cells requires a non-empty range.".to_string())?;
    if range.chars().count() > 64
        || !range
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, ':' | '$'))
    {
        return Err("WPS Spreadsheet write_cells range must be an A1-style address.".to_string());
    }

    let sheet_name = parameters
        .get("sheetName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if sheet_name
        .as_ref()
        .is_some_and(|value| value.chars().count() > 128)
    {
        return Err(
            "WPS Spreadsheet write_cells sheetName must be 128 characters or fewer.".to_string(),
        );
    }

    let Some(rows) = parameters.get("values").and_then(Value::as_array) else {
        return Err("WPS Spreadsheet write_cells requires values.".to_string());
    };
    if rows.is_empty() {
        return Err("WPS Spreadsheet write_cells values cannot be empty.".to_string());
    }
    if rows.len() > WPS_SPREADSHEET_MAX_ROWS {
        return Err(format!(
            "WPS Spreadsheet write_cells supports at most {WPS_SPREADSHEET_MAX_ROWS} rows per action."
        ));
    }

    let mut values = Vec::with_capacity(rows.len());
    let mut width = None;
    for row in rows {
        let Some(cells) = row.as_array() else {
            return Err(
                "WPS Spreadsheet write_cells values must be a two-dimensional array.".to_string(),
            );
        };
        if cells.is_empty() {
            return Err("WPS Spreadsheet write_cells rows cannot be empty.".to_string());
        }
        if cells.len() > WPS_SPREADSHEET_MAX_COLUMNS {
            return Err(format!(
                "WPS Spreadsheet write_cells supports at most {WPS_SPREADSHEET_MAX_COLUMNS} columns per action."
            ));
        }
        if width.is_some_and(|expected| expected != cells.len()) {
            return Err(
                "WPS Spreadsheet write_cells values must use rectangular rows.".to_string(),
            );
        }
        width = Some(cells.len());

        let mut normalized_row = Vec::with_capacity(cells.len());
        for cell in cells {
            if !matches!(
                cell,
                Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
            ) {
                return Err(
                    "WPS Spreadsheet write_cells values can only contain scalar cells.".to_string(),
                );
            }
            validate_spreadsheet_cell(cell)?;
            normalized_row.push(cell.clone());
        }
        values.push(normalized_row);
    }
    if values.len() * width.unwrap_or_default() > WPS_SPREADSHEET_MAX_CELLS {
        return Err(format!(
            "WPS Spreadsheet write_cells supports at most {WPS_SPREADSHEET_MAX_CELLS} cells per action."
        ));
    }
    let values_json = serde_json::to_string(&values).unwrap_or_default();
    if values_json.len() > WPS_SPREADSHEET_MAX_VALUES_JSON_BYTES {
        return Err(format!(
            "WPS Spreadsheet write_cells payload must be {WPS_SPREADSHEET_MAX_VALUES_JSON_BYTES} bytes or fewer."
        ));
    }

    Ok(WpsSpreadsheetWriteCells {
        range: range.to_string(),
        sheet_name,
        values,
    })
}

const WPS_OWNED_ROOT_ENV: &str = "TOUCHAI_APP_USE_WPS_OWNED_ROOT";
const OWNED_SECRET_ENV: &str = "TOUCHAI_APP_USE_OWNED_SECRET";

fn owned_wps_target_root() -> PathBuf {
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var_os(WPS_OWNED_ROOT_ENV) {
            return PathBuf::from(path);
        }
    }

    app_use_owned_data_root().join("wps")
}

pub(crate) fn owned_wps_target_root_path() -> PathBuf {
    owned_wps_target_root()
}

fn app_use_owned_data_root() -> PathBuf {
    crate::core::system::paths::app_directory_path_without_app_root_override(
        crate::core::system::paths::AppDirectory::Data,
    )
    .unwrap_or_else(|_| fallback_app_data_root())
    .join("app-use")
    .join("owned-targets")
}

fn fallback_app_data_root() -> PathBuf {
    if cfg!(target_os = "windows") {
        if let Some(path) = std::env::var_os("LOCALAPPDATA")
            .or_else(|| std::env::var_os("APPDATA"))
            .map(PathBuf::from)
        {
            return path.join("TouchAI").join("data");
        }
    }

    if let Some(path) = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
        return path.join("TouchAI").join("data");
    }

    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        return home
            .join(".local")
            .join("share")
            .join("TouchAI")
            .join("data");
    }

    PathBuf::from(".").join("touchai-data")
}

fn owned_marker_path(target_path: &Path) -> PathBuf {
    let mut marker_name = target_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("target")
        .to_string();
    marker_name.push_str(".touchai-owned.json");
    target_path.with_file_name(marker_name)
}

fn hash_owned_path(target_path: &Path) -> String {
    let canonical = target_path.to_string_lossy().to_ascii_lowercase();
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(windows)]
fn owned_file_information(
    file: &File,
    label: &str,
) -> Result<windows::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION, String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    unsafe {
        GetFileInformationByHandle(
            HANDLE(file.as_raw_handle() as *mut core::ffi::c_void),
            &mut information,
        )
    }
    .map_err(|error| format!("TouchAI-owned {label} metadata is unavailable: {error}"))?;

    Ok(information)
}

#[cfg(windows)]
fn file_identity(file: &File) -> Result<String, String> {
    let information = owned_file_information(file, "file identity")?;

    Ok(format!(
        "{}:{}:{}",
        information.dwVolumeSerialNumber, information.nFileIndexHigh, information.nFileIndexLow
    ))
}

#[cfg(not(windows))]
fn file_identity(_file: &File) -> Result<String, String> {
    Ok("non-windows-test-file".to_string())
}

fn hash_owned_marker(canonical_path: &Path, file_identity: &str, nonce: Option<&str>) -> String {
    let canonical = canonical_path.to_string_lossy().to_ascii_lowercase();
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hasher.update(b"\0");
    hasher.update(file_identity.as_bytes());
    hasher.update(b"\0");
    hasher.update(nonce.unwrap_or_default().as_bytes());
    format!("{:x}", hasher.finalize())
}

fn read_owned_marker_secret(secret_path: &Path) -> Result<Option<String>, String> {
    if !secret_path.exists() {
        return Ok(None);
    }

    if let Some(parent) = secret_path.parent() {
        ensure_path_chain_not_reparse(parent, "secret root")?;
    }
    let mut secret_file = match open_owned_guard_file(secret_path, "secret", false) {
        Ok(file) => file,
        Err(_) if !secret_path.exists() => return Ok(None),
        Err(error) => {
            return Err(format!(
                "TouchAI owned-target secret could not be opened: {error}"
            ));
        }
    };
    let mut secret = String::new();
    secret_file
        .read_to_string(&mut secret)
        .map_err(|error| format!("TouchAI owned-target secret could not be read: {error}"))?;
    let secret = secret.trim().to_string();
    if secret.is_empty() {
        Ok(None)
    } else {
        Ok(Some(secret))
    }
}

fn owned_marker_secret() -> Result<String, String> {
    if cfg!(debug_assertions) {
        if let Some(secret) = std::env::var_os(OWNED_SECRET_ENV)
            .and_then(|value| value.into_string().ok())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            return Ok(secret);
        }
    }

    let root = app_use_owned_data_root();
    if root.exists() {
        ensure_path_chain_not_reparse(&root, "secret root")?;
    }
    let secret_path = root.join(".ownership-secret");
    if let Some(secret) = read_owned_marker_secret(&secret_path)? {
        return Ok(secret);
    }

    fs::create_dir_all(&root)
        .map_err(|error| format!("TouchAI owned-target secret root is unavailable: {error}"))?;
    ensure_path_chain_not_reparse(&root, "secret root")?;
    let secret = uuid::Uuid::new_v4().to_string();
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&secret_path)
    {
        Ok(mut file) => file.write_all(secret.as_bytes()).map_err(|error| {
            format!("TouchAI owned-target secret could not be written: {error}")
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if let Some(secret) = read_owned_marker_secret(&secret_path)? {
                return Ok(secret);
            }
            return Err("TouchAI owned-target secret already exists but is empty.".to_string());
        }
        Err(error) => {
            return Err(format!(
                "TouchAI owned-target secret could not be created: {error}"
            ));
        }
    }
    Ok(secret)
}

fn hmac_sha256_hex(secret: &str, parts: &[&[u8]]) -> String {
    const BLOCK_SIZE: usize = 64;

    let mut key = secret.as_bytes().to_vec();
    if key.len() > BLOCK_SIZE {
        key = Sha256::digest(&key).to_vec();
    }
    key.resize(BLOCK_SIZE, 0);

    let mut inner_pad = [0x36; BLOCK_SIZE];
    let mut outer_pad = [0x5c; BLOCK_SIZE];
    for (index, byte) in key.iter().enumerate() {
        inner_pad[index] ^= byte;
        outer_pad[index] ^= byte;
    }

    let mut inner = Sha256::new();
    inner.update(inner_pad);
    for part in parts {
        inner.update(part);
    }
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_hash);
    format!("{:x}", outer.finalize())
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut diff = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        let left_byte = left.get(index).copied().unwrap_or_default();
        let right_byte = right.get(index).copied().unwrap_or_default();
        diff |= (left_byte ^ right_byte) as usize;
    }
    diff == 0
}

fn sign_owned_marker(
    canonical_path: &Path,
    file_identity: &str,
    nonce: &str,
) -> Result<String, String> {
    let secret = owned_marker_secret()?;
    let canonical = canonical_path.to_string_lossy().to_ascii_lowercase();
    Ok(hmac_sha256_hex(
        &secret,
        &[
            b"touchai-owned-target-v1",
            canonical.as_bytes(),
            file_identity.as_bytes(),
            nonce.as_bytes(),
        ],
    ))
}

fn create_owned_marker_file(
    marker_path: &Path,
    marker: &Value,
    app_label: &str,
) -> Result<(), String> {
    if marker_path.exists() {
        ensure_path_chain_not_reparse(marker_path, "marker")?;
        if is_path_symlink(marker_path) || has_windows_reparse_point(marker_path) {
            return Err(format!(
                "{app_label} owned marker must not be a symlink or reparse point."
            ));
        }
        return Err(format!(
            "{app_label} owned target marker already exists; create a fresh TouchAI-owned target before issuing a new marker."
        ));
    }

    if let Some(parent) = marker_path.parent() {
        ensure_path_chain_not_reparse(parent, "marker parent")?;
    }
    let marker_json = marker.to_string();
    let mut marker_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(marker_path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                format!("{app_label} owned target marker already exists.")
            } else {
                format!("{app_label} owned target marker could not be created: {error}")
            }
        })?;
    if let Err(error) = marker_file.write_all(marker_json.as_bytes()) {
        drop(marker_file);
        let _ = fs::remove_file(marker_path);
        return Err(format!(
            "{app_label} owned target marker could not be written: {error}"
        ));
    }

    Ok(())
}

pub(crate) fn mark_owned_wps_target(
    target_path: &Path,
    app_label: &str,
    created_by: &str,
) -> Result<PathBuf, String> {
    if !target_path.is_absolute() {
        return Err(format!(
            "{app_label} owned target must be an absolute document path."
        ));
    }

    let root_path = owned_wps_target_root();
    fs::create_dir_all(&root_path)
        .map_err(|error| format!("{app_label} owned target root is unavailable: {error}"))?;
    ensure_path_chain_not_reparse(&root_path, "target root")?;
    let canonical_root = root_path.canonicalize().map_err(|_| {
        format!("{app_label} owned target root is not available for marker issuance.")
    })?;

    let canonical_candidate = target_path.canonicalize().map_err(|_| {
        format!("{app_label} owned target must reference an existing TouchAI document.")
    })?;
    validate_owned_target_extension(&canonical_candidate, app_label)?;
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(format!(
            "{app_label} owned target must live inside the TouchAI-owned document root."
        ));
    }
    ensure_path_chain_not_reparse(&canonical_candidate, "target")?;

    let target_file =
        open_owned_guard_file(&canonical_candidate, "target", true).map_err(|error| {
            format!("{app_label} owned target must reference an existing TouchAI document: {error}")
        })?;

    let marker_path = owned_marker_path(&canonical_candidate);
    let identity = file_identity(&target_file)?;
    let nonce = uuid::Uuid::new_v4().to_string();
    let marker = json!({
        "version": "touchai-owned-target/v1",
        "createdBy": created_by,
        "pathHash": hash_owned_path(&canonical_candidate),
        "nonce": nonce,
        "identityHash": hash_owned_marker(&canonical_candidate, &identity, Some(&nonce)),
        "signature": sign_owned_marker(&canonical_candidate, &identity, &nonce)?,
    });
    create_owned_marker_file(&marker_path, &marker, app_label)?;
    let _marker_file = verify_owned_marker(&canonical_candidate, &target_file)?;

    Ok(canonical_candidate)
}

#[cfg(windows)]
fn open_owned_guard_file(
    path: &Path,
    label: &str,
    allow_shared_writes: bool,
) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_SHARE_READ: u32 = 0x00000001;
    const FILE_SHARE_WRITE: u32 = 0x00000002;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;

    let share_mode = if allow_shared_writes {
        FILE_SHARE_READ | FILE_SHARE_WRITE
    } else {
        FILE_SHARE_READ
    };

    let file = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(share_mode)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| format!("TouchAI-owned {label} guard could not be opened: {error}"))?;
    ensure_owned_guard_file_handle(&file, label)?;
    Ok(file)
}

#[cfg(not(windows))]
fn open_owned_guard_file(
    path: &Path,
    label: &str,
    _allow_shared_writes: bool,
) -> Result<File, String> {
    File::open(path)
        .map_err(|error| format!("TouchAI-owned {label} guard could not be opened: {error}"))
}

fn is_path_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
}

#[cfg(windows)]
fn has_windows_reparse_point(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    std::fs::symlink_metadata(path)
        .map(|metadata| metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn has_windows_reparse_point(_path: &Path) -> bool {
    false
}

fn ensure_path_chain_not_reparse(path: &Path, label: &str) -> Result<(), String> {
    for candidate in path.ancestors() {
        if candidate.as_os_str().is_empty() || !candidate.exists() {
            continue;
        }
        if is_path_symlink(candidate) || has_windows_reparse_point(candidate) {
            return Err(format!(
                "TouchAI-owned {label} path must not include a symlink or reparse point."
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn path_has_root_prefix(candidate: &Path, root: &Path) -> bool {
    let candidate = candidate
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    let root = root
        .to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase();
    candidate == root || candidate.starts_with(&format!("{root}\\"))
}

#[cfg(not(windows))]
fn path_has_root_prefix(candidate: &Path, root: &Path) -> bool {
    candidate.starts_with(root)
}

#[cfg(windows)]
fn ensure_owned_guard_file_handle(file: &File, label: &str) -> Result<(), String> {
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

    let information = owned_file_information(file, label)?;
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(format!(
            "TouchAI-owned {label} must not be a symlink or reparse point."
        ));
    }
    if information.nNumberOfLinks > 1 {
        return Err(format!("TouchAI-owned {label} must not be a hard link."));
    }
    Ok(())
}

#[cfg(not(windows))]
fn ensure_owned_guard_file_handle(_file: &File, _label: &str) -> Result<(), String> {
    Ok(())
}

struct OwnedTargetGuard {
    canonical_path: PathBuf,
    _target_file: File,
    _marker_file: File,
}

impl OwnedTargetGuard {
    fn path_string(&self) -> String {
        self.canonical_path.to_string_lossy().to_string()
    }
}

fn verify_owned_marker(target_path: &Path, target_file: &File) -> Result<File, String> {
    let marker_path = owned_marker_path(target_path);
    ensure_path_chain_not_reparse(&marker_path, "marker")?;
    if is_path_symlink(&marker_path) || has_windows_reparse_point(&marker_path) {
        return Err("TouchAI-owned marker must not be a symlink or reparse point.".to_string());
    }

    let mut marker_file = open_owned_guard_file(&marker_path, "marker", false)
        .map_err(|error| format!("TouchAI-owned marker is missing for this target: {error}"))?;
    let mut marker = String::new();
    marker_file
        .read_to_string(&mut marker)
        .map_err(|_| "TouchAI-owned marker is unreadable.".to_string())?;
    let marker: Value = serde_json::from_str(&marker)
        .map_err(|_| "TouchAI-owned marker is not valid JSON.".to_string())?;
    let marker_hash = marker
        .get("pathHash")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let marker_nonce = marker
        .get("nonce")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "TouchAI-owned marker nonce is missing.".to_string())?;
    let identity = file_identity(target_file)?;
    let identity_hash = marker
        .get("identityHash")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let marker_signature = marker
        .get("signature")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let expected_identity_hash = hash_owned_marker(target_path, &identity, Some(marker_nonce));
    let expected_signature = sign_owned_marker(target_path, &identity, marker_nonce)?;

    if marker_hash != hash_owned_path(target_path) {
        return Err("TouchAI-owned marker does not match this target path.".to_string());
    }
    if identity_hash != expected_identity_hash {
        return Err("TouchAI-owned marker does not match this target identity.".to_string());
    }
    if !constant_time_eq(marker_signature, &expected_signature) {
        return Err("TouchAI-owned marker is not signed by this TouchAI installation.".to_string());
    }

    Ok(marker_file)
}

fn validate_owned_target_extension(target_path: &Path, app_label: &str) -> Result<(), String> {
    let extension = target_path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let allowed = match app_label {
        "WPS Writer" => ["docx"].contains(&extension.as_str()),
        "WPS Spreadsheet" => ["xlsx"].contains(&extension.as_str()),
        "WPS Presentation" => ["pptx"].contains(&extension.as_str()),
        _ => false,
    };

    if allowed {
        Ok(())
    } else {
        Err(format!(
            "{app_label} targetId must use a macro-free TouchAI-owned document format."
        ))
    }
}

fn validate_owned_target(
    target_path: Option<&str>,
    required: bool,
) -> Result<Option<OwnedTargetGuard>, String> {
    validate_owned_target_for_app(target_path, required, "WPS Writer")
}

fn validate_owned_target_for_app(
    target_path: Option<&str>,
    required: bool,
    app_label: &str,
) -> Result<Option<OwnedTargetGuard>, String> {
    let Some(target_path) = target_path else {
        return if required {
            Err(format!(
                "{app_label} targetId must reference a TouchAI-owned document before running write actions."
            ))
        } else {
            Ok(None)
        };
    };

    let trimmed_path = target_path.trim();
    if trimmed_path.is_empty() {
        return if required {
            Err(format!(
                "{app_label} targetId must reference a TouchAI-owned document before running write actions."
            ))
        } else {
            Ok(None)
        };
    }

    let candidate = Path::new(trimmed_path);
    if !candidate.is_absolute() {
        return Err(format!(
            "{app_label} targetId must reference a TouchAI-owned absolute document path."
        ));
    }

    let root_path = owned_wps_target_root();
    if is_path_symlink(&root_path) || has_windows_reparse_point(&root_path) {
        return Err(format!(
            "{app_label} targetId root must not be a symlink or reparse point."
        ));
    }
    let canonical_root = root_path.canonicalize().map_err(|_| {
        format!("{app_label} targetId root is not available for owned document access.")
    })?;
    if !path_has_root_prefix(candidate, &root_path)
        && !path_has_root_prefix(candidate, &canonical_root)
    {
        return Err(format!(
            "{app_label} targetId is not a TouchAI-owned document path."
        ));
    }
    let canonical_candidate = candidate.canonicalize().map_err(|_| {
        format!("{app_label} targetId must reference an existing TouchAI-owned document.")
    })?;
    validate_owned_target_extension(&canonical_candidate, app_label)?;
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(format!(
            "{app_label} targetId is not a TouchAI-owned document path."
        ));
    }
    ensure_path_chain_not_reparse(&canonical_candidate, "target")?;
    let target_file =
        open_owned_guard_file(&canonical_candidate, "target", true).map_err(|error| {
            format!(
                "{app_label} targetId must reference an existing TouchAI-owned document: {error}"
            )
        })?;
    let marker_file = verify_owned_marker(&canonical_candidate, &target_file).map_err(|error| {
        format!("{app_label} targetId is missing valid TouchAI ownership proof: {error}")
    })?;
    Ok(Some(OwnedTargetGuard {
        canonical_path: canonical_candidate,
        _target_file: target_file,
        _marker_file: marker_file,
    }))
}

fn format_observe_content(metadata: &Value, scope: &str) -> String {
    let document_name = metadata
        .get("documentName")
        .and_then(Value::as_str)
        .unwrap_or("active WPS document");
    let selection = metadata
        .get("selectionText")
        .and_then(Value::as_str)
        .unwrap_or("");
    let character_count = metadata
        .get("characterCount")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let document_text = metadata
        .get("documentText")
        .and_then(Value::as_str)
        .unwrap_or("");

    if scope == "selection" {
        return format!("Document: {document_name}\nSelection: {selection}");
    }

    format!(
        "Document: {document_name}\nCharacters: {character_count}\nSelection: {selection}\nText: {document_text}"
    )
}

fn format_spreadsheet_observe_content(metadata: &Value, scope: &str) -> String {
    let workbook_name = metadata
        .get("workbookName")
        .and_then(Value::as_str)
        .unwrap_or("active WPS workbook");
    let active_sheet = metadata
        .get("activeSheetName")
        .and_then(Value::as_str)
        .unwrap_or("active sheet");
    let used_range = metadata
        .get("usedRange")
        .and_then(Value::as_str)
        .unwrap_or("");
    let values = metadata
        .get("values")
        .map(Value::to_string)
        .unwrap_or_else(|| "[]".to_string());

    if scope == "workbook" {
        let sheets = metadata
            .get("sheetNames")
            .and_then(Value::as_array)
            .map(|sheets| {
                sheets
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        return format!(
            "Workbook: {workbook_name}\nSheets: {sheets}\nActive sheet: {active_sheet}"
        );
    }

    format!(
        "Workbook: {workbook_name}\nSheet: {active_sheet}\nUsed range: {used_range}\nValues: {values}"
    )
}

fn format_presentation_observe_content(metadata: &Value, scope: &str) -> String {
    let presentation_name = metadata
        .get("presentationName")
        .and_then(Value::as_str)
        .unwrap_or("active WPS presentation");
    let slide_count = metadata
        .get("slideCount")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let active_slide_index = metadata
        .get("activeSlideIndex")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let slide_text = metadata
        .get("slideText")
        .and_then(Value::as_str)
        .unwrap_or("");

    if scope == "slide" {
        return format!(
            "Presentation: {presentation_name}\nSlide: {active_slide_index}\nText: {slide_text}"
        );
    }

    format!(
        "Presentation: {presentation_name}\nSlides: {slide_count}\nActive slide: {active_slide_index}\nText: {slide_text}"
    )
}

fn truncate_content(content: String, max_chars: usize) -> (String, bool) {
    if content.chars().count() <= max_chars {
        return (content, false);
    }

    (content.chars().take(max_chars).collect(), true)
}

fn encoded_utf8_script_value(value: Option<&str>) -> String {
    value
        .map(|value| general_purpose::STANDARD.encode(value.as_bytes()))
        .unwrap_or_default()
}

fn wps_observe_script(target_path: Option<&str>, scope: &str) -> String {
    let encoded_target_path = encoded_utf8_script_value(target_path);
    let include_document_text = if scope == "active_document" {
        "$true"
    } else {
        "$false"
    };
    r#"
$ErrorActionPreference = 'Stop'
function Invoke-WithComRetry([scriptblock]$Operation) {
    $lastError = $null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try {
            return & $Operation
        } catch {
            $lastError = $_
            Start-Sleep -Milliseconds 150
        }
    }
    throw $lastError
}
$targetPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__TARGET_PATH__'))
$includeDocumentText = __INCLUDE_DOCUMENT_TEXT__
$ownsDocument = $false
if ([string]::IsNullOrWhiteSpace($targetPath)) {
    $app = Invoke-WithComRetry { [Runtime.InteropServices.Marshal]::GetActiveObject('KWPS.Application') }
    $doc = Invoke-WithComRetry { $app.ActiveDocument }
} else {
    $app = Invoke-WithComRetry { New-Object -ComObject KWPS.Application }
    $doc = Invoke-WithComRetry { $app.Documents.Open($targetPath) }
    $ownsDocument = $true
}
if ($null -eq $doc) {
    throw 'WPS Writer does not have an active document.'
}
$selectionText = ''
if ($null -ne $app.Selection) {
    $selectionText = Invoke-WithComRetry { [string]$app.Selection.Text }
}
$fullName = $null
try {
    $fullName = Invoke-WithComRetry { [string]$doc.FullName }
} catch {
    $fullName = $null
}
$documentText = ''
if ($includeDocumentText) {
    $documentText = Invoke-WithComRetry { [string]$doc.Content.Text }
}
$result = [ordered]@{
    documentName = Invoke-WithComRetry { [string]$doc.Name }
    fullName = $fullName
    documentText = $documentText
    selectionText = $selectionText
    characterCount = Invoke-WithComRetry { [int]$doc.Characters.Count }
}
if ($ownsDocument) {
    Invoke-WithComRetry { $doc.Close([ref]$false) } | Out-Null
}
$result | ConvertTo-Json -Compress -Depth 4
"#
    .trim()
    .replace("__TARGET_PATH__", &encoded_target_path)
    .replace("__INCLUDE_DOCUMENT_TEXT__", include_document_text)
    .to_string()
}

fn wps_type_text_script(text: &str, target_path: Option<&str>) -> String {
    let encoded_text = general_purpose::STANDARD.encode(text.as_bytes());
    let encoded_target_path = encoded_utf8_script_value(target_path);
    format!(
        r#"
$ErrorActionPreference = 'Stop'
function Invoke-WithComRetry([scriptblock]$Operation) {{
    $lastError = $null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {{
        try {{
            return & $Operation
        }} catch {{
            $lastError = $_
            Start-Sleep -Milliseconds 150
        }}
    }}
    throw $lastError
}}
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_text}'))
$targetPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_target_path}'))
$ownsDocument = $false
if ([string]::IsNullOrWhiteSpace($targetPath)) {{
    $app = Invoke-WithComRetry {{ [Runtime.InteropServices.Marshal]::GetActiveObject('KWPS.Application') }}
    $doc = Invoke-WithComRetry {{ $app.ActiveDocument }}
}} else {{
    $app = Invoke-WithComRetry {{ New-Object -ComObject KWPS.Application }}
    $doc = Invoke-WithComRetry {{ $app.Documents.Open($targetPath) }}
    $ownsDocument = $true
    Invoke-WithComRetry {{ $doc.Content.Select() }} | Out-Null
}}
if ($null -eq $doc) {{
    throw 'WPS Writer does not have an active document.'
}}
$selection = Invoke-WithComRetry {{ $app.Selection }}
if ($null -eq $selection) {{
    throw 'WPS Writer does not have an active selection.'
}}
Invoke-WithComRetry {{ $selection.TypeText($text) }}
$fullName = $null
try {{
    $fullName = Invoke-WithComRetry {{ [string]$doc.FullName }}
}} catch {{
    $fullName = $null
}}
if ($ownsDocument) {{
    Invoke-WithComRetry {{ $doc.Save() }} | Out-Null
}}
$result = [ordered]@{{
    documentName = Invoke-WithComRetry {{ [string]$doc.Name }}
    fullName = $fullName
    changed = $true
}}
if ($ownsDocument) {{
    Invoke-WithComRetry {{ $doc.Close([ref]$false) }} | Out-Null
}}
$result | ConvertTo-Json -Compress -Depth 4
"#
    )
    .trim()
    .to_string()
}

fn wps_spreadsheet_observe_script(target_path: Option<&str>) -> String {
    let encoded_target_path = encoded_utf8_script_value(target_path);
    format!(
        r#"
$ErrorActionPreference = 'Stop'
function Invoke-WithComRetry([scriptblock]$Operation) {{
    $lastError = $null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {{
        try {{
            return & $Operation
        }} catch {{
            $lastError = $_
            Start-Sleep -Milliseconds 150
        }}
    }}
    throw $lastError
}}
function Convert-ColumnIndexToName([int]$index) {{
    $name = ''
    while ($index -gt 0) {{
        $index--
        $name = ([char](65 + ($index % 26))).ToString() + $name
        $index = [math]::Floor($index / 26)
    }}
    return $name
}}
function Get-CellAddress([int]$row, [int]$column) {{
    return "$(Convert-ColumnIndexToName $column)$row"
}}
function Convert-FirstInt($value) {{
    if ($value -is [array]) {{
        return [int]$value[0]
    }}
    return [int]$value
}}
function Convert-UsedRangeValues($sheet, $range) {{
    $values = @()
    $rowCount = Invoke-WithComRetry {{ [int]$range.Rows.Count }}
    $columnCount = Invoke-WithComRetry {{ [int]$range.Columns.Count }}
    $startRow = Invoke-WithComRetry {{ Convert-FirstInt $range.Row }}
    $startColumn = Invoke-WithComRetry {{ Convert-FirstInt $range.Column }}
    for ($row = 1; $row -le $rowCount; $row++) {{
        $rowValues = @()
        for ($column = 1; $column -le $columnCount; $column++) {{
            $cellAddress = Get-CellAddress ($startRow + $row - 1) ($startColumn + $column - 1)
            $rowValues += Invoke-WithComRetry {{ $sheet.Range($cellAddress).Value2 }}
        }}
        $values += ,$rowValues
    }}
    return $values
}}
$targetPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_target_path}'))
$ownsWorkbook = $false
if ([string]::IsNullOrWhiteSpace($targetPath)) {{
    $app = Invoke-WithComRetry {{ [Runtime.InteropServices.Marshal]::GetActiveObject('KET.Application') }}
    $workbook = Invoke-WithComRetry {{ $app.ActiveWorkbook }}
}} else {{
    $app = Invoke-WithComRetry {{ New-Object -ComObject KET.Application }}
    $workbook = Invoke-WithComRetry {{ $app.Workbooks.Open($targetPath) }}
    $ownsWorkbook = $true
}}
if ($null -eq $workbook) {{
    throw 'WPS Spreadsheet does not have an active workbook.'
}}
$sheet = Invoke-WithComRetry {{ $app.ActiveSheet }}
$sheetNames = @()
for ($i = 1; $i -le $workbook.Worksheets.Count; $i++) {{
    $sheetNames += Invoke-WithComRetry {{ [string]$workbook.Worksheets.Item($i).Name }}
}}
$usedRange = Invoke-WithComRetry {{ $sheet.UsedRange }}
$usedRangeRows = Invoke-WithComRetry {{ [int]$usedRange.Rows.Count }}
$usedRangeColumns = Invoke-WithComRetry {{ [int]$usedRange.Columns.Count }}
$fullName = $null
try {{
    $fullName = Invoke-WithComRetry {{ [string]$workbook.FullName }}
}} catch {{
    $fullName = $null
}}
$result = [ordered]@{{
    workbookName = Invoke-WithComRetry {{ [string]$workbook.Name }}
    fullName = $fullName
    activeSheetName = Invoke-WithComRetry {{ [string]$sheet.Name }}
    sheetNames = $sheetNames
    usedRange = "$usedRangeRows x $usedRangeColumns"
    values = Convert-UsedRangeValues $sheet $usedRange
}}
if ($ownsWorkbook) {{
    Invoke-WithComRetry {{ $workbook.Close($false) }} | Out-Null
}}
$result | ConvertTo-Json -Compress -Depth 6
"#
    )
    .trim()
    .to_string()
}

fn wps_spreadsheet_write_cells_script(
    cells: &WpsSpreadsheetWriteCells,
    target_path: Option<&str>,
) -> String {
    let encoded_target_path = encoded_utf8_script_value(target_path);
    let encoded_range = encoded_utf8_script_value(Some(&cells.range));
    let encoded_sheet_name = encoded_utf8_script_value(cells.sheet_name.as_deref());
    let values_json = serde_json::to_string(&cells.values).unwrap_or_else(|_| "[]".to_string());
    let encoded_values = general_purpose::STANDARD.encode(values_json.as_bytes());

    format!(
        r#"
$ErrorActionPreference = 'Stop'
function Invoke-WithComRetry([scriptblock]$Operation) {{
    $lastError = $null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {{
        try {{
            return & $Operation
        }} catch {{
            $lastError = $_
            Start-Sleep -Milliseconds 150
        }}
    }}
    throw $lastError
}}
function Convert-ColumnIndexToName([int]$index) {{
    $name = ''
    while ($index -gt 0) {{
        $index--
        $name = ([char](65 + ($index % 26))).ToString() + $name
        $index = [math]::Floor($index / 26)
    }}
    return $name
}}
function Get-CellAddress([int]$row, [int]$column) {{
    return "$(Convert-ColumnIndexToName $column)$row"
}}
function Convert-FirstInt($value) {{
    if ($value -is [array]) {{
        return [int]$value[0]
    }}
    return [int]$value
}}
$targetPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_target_path}'))
$rangeAddress = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_range}'))
$sheetName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_sheet_name}'))
$valuesJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_values}'))
$rows = $valuesJson | ConvertFrom-Json
$app = Invoke-WithComRetry {{ New-Object -ComObject KET.Application }}
$workbook = Invoke-WithComRetry {{ $app.Workbooks.Open($targetPath) }}
if ($null -eq $workbook) {{
    throw 'WPS Spreadsheet does not have an active workbook.'
}}
if ([string]::IsNullOrWhiteSpace($sheetName)) {{
    $sheet = Invoke-WithComRetry {{ $workbook.Worksheets.Item(1) }}
}} else {{
    $sheet = Invoke-WithComRetry {{ $workbook.Worksheets.Item($sheetName) }}
}}
$openedFullName = Invoke-WithComRetry {{ [string]$workbook.FullName }}
if ([string]::Compare($openedFullName, $targetPath, $true, [Globalization.CultureInfo]::InvariantCulture) -ne 0) {{
    throw 'WPS Spreadsheet opened a workbook that does not match the requested target.'
}}
$range = Invoke-WithComRetry {{ $sheet.Range($rangeAddress) }}
$startRow = Invoke-WithComRetry {{ Convert-FirstInt $range.Row }}
$startColumn = Invoke-WithComRetry {{ Convert-FirstInt $range.Column }}
for ($rowIndex = 0; $rowIndex -lt $rows.Count; $rowIndex++) {{
    $row = @($rows[$rowIndex])
    for ($columnIndex = 0; $columnIndex -lt $row.Count; $columnIndex++) {{
        $value = $row[$columnIndex]
        $cellAddress = Get-CellAddress ($startRow + $rowIndex) ($startColumn + $columnIndex)
        Invoke-WithComRetry {{ $sheet.Range($cellAddress).Value2 = $value }} | Out-Null
    }}
}}
$fullName = $null
try {{
    $fullName = $openedFullName
}} catch {{
    $fullName = $null
}}
Invoke-WithComRetry {{ $workbook.Save() }} | Out-Null
$result = [ordered]@{{
    workbookName = Invoke-WithComRetry {{ [string]$workbook.Name }}
    fullName = $fullName
    sheetName = Invoke-WithComRetry {{ [string]$sheet.Name }}
    range = $rangeAddress
    changed = $true
    values = $rows
}}
Invoke-WithComRetry {{ $workbook.Close($false) }} | Out-Null
$result | ConvertTo-Json -Compress -Depth 6
"#
    )
    .trim()
    .to_string()
}

fn wps_presentation_observe_script(target_path: Option<&str>) -> String {
    let encoded_target_path = encoded_utf8_script_value(target_path);
    format!(
        r#"
$ErrorActionPreference = 'Stop'
function Invoke-WithComRetry([scriptblock]$Operation) {{
    $lastError = $null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {{
        try {{
            return & $Operation
        }} catch {{
            $lastError = $_
            Start-Sleep -Milliseconds 150
        }}
    }}
    throw $lastError
}}
function Get-SlideText($slide) {{
    $parts = @()
    for ($i = 1; $i -le $slide.Shapes.Count; $i++) {{
        $shape = $slide.Shapes.Item($i)
        try {{
            if ($shape.HasTextFrame -and $shape.TextFrame.HasText) {{
                $parts += [string]$shape.TextFrame.TextRange.Text
            }}
        }} catch {{}}
    }}
    return ($parts -join "`n")
}}
$targetPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_target_path}'))
$ownsPresentation = $false
if ([string]::IsNullOrWhiteSpace($targetPath)) {{
    $app = Invoke-WithComRetry {{ [Runtime.InteropServices.Marshal]::GetActiveObject('KWPP.Application') }}
    $presentation = Invoke-WithComRetry {{ $app.ActivePresentation }}
}} else {{
    $app = Invoke-WithComRetry {{ New-Object -ComObject KWPP.Application }}
    $presentation = Invoke-WithComRetry {{ $app.Presentations.Open($targetPath) }}
    $ownsPresentation = $true
}}
if ($null -eq $presentation) {{
    throw 'WPS Presentation does not have an active presentation.'
}}
$slide = $null
$activeSlideIndex = 0
try {{
    $slide = Invoke-WithComRetry {{ $app.ActiveWindow.View.Slide }}
    $activeSlideIndex = Invoke-WithComRetry {{ [int]$slide.SlideIndex }}
}} catch {{
    if ($presentation.Slides.Count -gt 0) {{
        $slide = Invoke-WithComRetry {{ $presentation.Slides.Item(1) }}
        $activeSlideIndex = 1
    }}
}}
$fullName = $null
try {{
    $fullName = Invoke-WithComRetry {{ [string]$presentation.FullName }}
}} catch {{
    $fullName = $null
}}
$result = [ordered]@{{
    presentationName = Invoke-WithComRetry {{ [string]$presentation.Name }}
    fullName = $fullName
    slideCount = Invoke-WithComRetry {{ [int]$presentation.Slides.Count }}
    activeSlideIndex = $activeSlideIndex
    slideText = if ($null -eq $slide) {{ '' }} else {{ Get-SlideText $slide }}
}}
if ($ownsPresentation) {{
    Invoke-WithComRetry {{ $presentation.Close() }} | Out-Null
}}
$result | ConvertTo-Json -Compress -Depth 5
"#
    )
    .trim()
    .to_string()
}

fn wps_presentation_add_slide_text_script(
    slide_text: &WpsPresentationSlideText,
    target_path: Option<&str>,
) -> String {
    let encoded_target_path = encoded_utf8_script_value(target_path);
    let encoded_text = encoded_utf8_script_value(Some(&slide_text.text));
    let slide_index = slide_text
        .slide_index
        .map(|value| value.to_string())
        .unwrap_or_else(|| "$null".to_string());

    format!(
        r#"
$ErrorActionPreference = 'Stop'
function Invoke-WithComRetry([scriptblock]$Operation) {{
    $lastError = $null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {{
        try {{
            return & $Operation
        }} catch {{
            $lastError = $_
            Start-Sleep -Milliseconds 150
        }}
    }}
    throw $lastError
}}
$targetPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_target_path}'))
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_text}'))
$slideIndex = {slide_index}
$app = Invoke-WithComRetry {{ New-Object -ComObject KWPP.Application }}
$presentation = Invoke-WithComRetry {{ $app.Presentations.Open($targetPath) }}
if ($null -eq $presentation) {{
    throw 'WPS Presentation does not have an active presentation.'
}}
if ($presentation.Slides.Count -eq 0) {{
    $slide = Invoke-WithComRetry {{ $presentation.Slides.Add(1, 12) }}
}} elseif ($null -eq $slideIndex) {{
    $slide = Invoke-WithComRetry {{ $presentation.Slides.Item($presentation.Slides.Count) }}
    $slideIndex = Invoke-WithComRetry {{ [int]$slide.SlideIndex }}
}} else {{
    $slide = Invoke-WithComRetry {{ $presentation.Slides.Item([int]$slideIndex) }}
}}
$shape = Invoke-WithComRetry {{ $slide.Shapes.AddTextbox(1, 48, 48, 600, 120) }}
Invoke-WithComRetry {{ $shape.TextFrame.TextRange.Text = $text }} | Out-Null
$fullName = $null
try {{
    $fullName = Invoke-WithComRetry {{ [string]$presentation.FullName }}
}} catch {{
    $fullName = $null
}}
Invoke-WithComRetry {{ $presentation.Save() }} | Out-Null
$result = [ordered]@{{
    presentationName = Invoke-WithComRetry {{ [string]$presentation.Name }}
    fullName = $fullName
    slideIndex = Invoke-WithComRetry {{ [int]$slide.SlideIndex }}
    text = $text
    changed = $true
}}
Invoke-WithComRetry {{ $presentation.Close() }} | Out-Null
$result | ConvertTo-Json -Compress -Depth 5
"#
    )
    .trim()
    .to_string()
}

fn powershell_optional_bool(value: Option<bool>) -> &'static str {
    match value {
        Some(true) => "$true",
        Some(false) => "$false",
        None => "$null",
    }
}

fn powershell_optional_number(value: Option<f64>) -> String {
    value
        .map(|value| value.to_string())
        .unwrap_or_else(|| "$null".to_string())
}

fn wps_format_document_text_script(
    format: &WpsSelectionFormat,
    target_path: Option<&str>,
) -> String {
    let encoded_target_path = encoded_utf8_script_value(target_path);
    let encoded_font_name = encoded_utf8_script_value(format.font_name.as_deref());
    let bold = powershell_optional_bool(format.bold);
    let italic = powershell_optional_bool(format.italic);
    let underline = powershell_optional_bool(format.underline);
    let font_size = powershell_optional_number(format.font_size);

    format!(
        r#"
$ErrorActionPreference = 'Stop'
function Invoke-WithComRetry([scriptblock]$Operation) {{
    $lastError = $null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {{
        try {{
            return & $Operation
        }} catch {{
            $lastError = $_
            Start-Sleep -Milliseconds 150
        }}
    }}
    throw $lastError
}}
$targetPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_target_path}'))
$fontName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_font_name}'))
$formatBold = {bold}
$formatItalic = {italic}
$formatUnderline = {underline}
$formatFontSize = {font_size}
$app = Invoke-WithComRetry {{ New-Object -ComObject KWPS.Application }}
$doc = Invoke-WithComRetry {{ $app.Documents.Open($targetPath) }}
if ($null -eq $doc) {{
    throw 'WPS Writer does not have an active document.'
}}
Invoke-WithComRetry {{ $doc.Content.Select() }} | Out-Null
$selection = Invoke-WithComRetry {{ $app.Selection }}
if ($null -eq $selection) {{
    throw 'WPS Writer does not have an active selection.'
}}
if ($null -ne $formatBold) {{
    if ([bool]$formatBold) {{
        Invoke-WithComRetry {{ $selection.Font.Bold = 1 }} | Out-Null
    }} else {{
        Invoke-WithComRetry {{ $selection.Font.Bold = 0 }} | Out-Null
    }}
}}
if ($null -ne $formatItalic) {{
    if ([bool]$formatItalic) {{
        Invoke-WithComRetry {{ $selection.Font.Italic = 1 }} | Out-Null
    }} else {{
        Invoke-WithComRetry {{ $selection.Font.Italic = 0 }} | Out-Null
    }}
}}
if ($null -ne $formatUnderline) {{
    if ([bool]$formatUnderline) {{
        Invoke-WithComRetry {{ $selection.Font.Underline = 1 }} | Out-Null
    }} else {{
        Invoke-WithComRetry {{ $selection.Font.Underline = 0 }} | Out-Null
    }}
}}
if ($null -ne $formatFontSize) {{
    Invoke-WithComRetry {{ $selection.Font.Size = [double]$formatFontSize }} | Out-Null
}}
if (-not [string]::IsNullOrWhiteSpace($fontName)) {{
    Invoke-WithComRetry {{ $selection.Font.Name = $fontName }} | Out-Null
}}
$fullName = $null
try {{
    $fullName = Invoke-WithComRetry {{ [string]$doc.FullName }}
}} catch {{
    $fullName = $null
}}
Invoke-WithComRetry {{ $doc.Save() }} | Out-Null
$format = [ordered]@{{}}
if ($null -ne $formatBold) {{
    $format.bold = [bool]$formatBold
}}
if ($null -ne $formatItalic) {{
    $format.italic = [bool]$formatItalic
}}
if ($null -ne $formatUnderline) {{
    $format.underline = [bool]$formatUnderline
}}
if ($null -ne $formatFontSize) {{
    $format.fontSize = [double]$formatFontSize
}}
if (-not [string]::IsNullOrWhiteSpace($fontName)) {{
    $format.fontName = $fontName
}}
$result = [ordered]@{{
    documentName = Invoke-WithComRetry {{ [string]$doc.Name }}
    fullName = $fullName
    changed = $true
    format = $format
}}
Invoke-WithComRetry {{ $doc.Close([ref]$false) }} | Out-Null
$result | ConvertTo-Json -Compress -Depth 5
"#
    )
    .trim()
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::app_use::types::{
        AppUseActRequest, AppUseAdvancedConfig, AppUseConfig, AppUseObserveRequest,
    };
    use crate::core::app_use::AppUseAdapter;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    struct RecordingRunner {
        output: Result<String, String>,
        scripts: Mutex<Vec<String>>,
    }

    impl RecordingRunner {
        fn new(output: Result<String, String>) -> Self {
            Self {
                output,
                scripts: Mutex::new(Vec::new()),
            }
        }

        fn scripts(&self) -> Vec<String> {
            self.scripts.lock().expect("scripts").clone()
        }
    }

    impl WpsAutomationRunner for RecordingRunner {
        fn run_script(&self, script: &str, _timeout_ms: u64) -> Result<String, String> {
            self.scripts
                .lock()
                .expect("scripts")
                .push(script.to_string());
            self.output.clone()
        }
    }

    fn config() -> AppUseConfig {
        AppUseConfig {
            mode: "interactive".to_string(),
            adapters: HashMap::from([("wps_writer".to_string(), true)]),
            mutating_approval_mode: "always".to_string(),
            read_scope: "active".to_string(),
            allow_background_operation: false,
            allow_raw_automation: false,
            timeout_ms: 15_000,
            max_output_chars: 12_000,
            advanced: AppUseAdvancedConfig::default(),
        }
    }

    fn prepare_owned_test_root() -> PathBuf {
        static OWNED_TEST_ROOT_LOCK: Mutex<()> = Mutex::new(());
        let _guard = OWNED_TEST_ROOT_LOCK.lock().expect("owned test root lock");
        let root = std::env::temp_dir().join("touchai-wps-owned-tests");
        std::env::set_var(WPS_OWNED_ROOT_ENV, &root);
        std::env::set_var(OWNED_SECRET_ENV, "app-use-owned-test-secret");
        std::fs::create_dir_all(&root).expect("owned root");
        root
    }

    fn write_owned_test_file(path: &Path) {
        remove_owned_test_file(path);
        std::fs::write(path, b"owned").expect("owned file");
        let app_label = match path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("docx") => "WPS Writer",
            Some("xlsx") => "WPS Spreadsheet",
            Some("pptx") => "WPS Presentation",
            _ => panic!("unsupported WPS test target extension"),
        };
        mark_owned_wps_target(path, app_label, "TouchAI App Use test").expect("owned marker");
    }

    fn remove_owned_test_file(path: &Path) {
        let marker = path
            .canonicalize()
            .ok()
            .map(|canonical_path| owned_marker_path(&canonical_path))
            .unwrap_or_else(|| owned_marker_path(path));
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(marker);
    }

    #[test]
    fn observe_uses_wps_specific_progid_and_returns_structured_content() {
        let runner = Arc::new(RecordingRunner::new(Ok(json!({
            "documentName": "demo.docx",
            "selectionText": "selected text",
            "characterCount": 42
        })
        .to_string())));
        let adapter = WpsWriterAdapter::with_runner(runner.clone());

        let response = adapter.observe(&AppUseObserveRequest {
            execution_id: "wps-observe-1".to_string(),
            adapter_id: "wps_writer".to_string(),
            scope: "selection".to_string(),
            description: "read WPS selection".to_string(),
            target_id: None,
            max_output_chars: 12_000,
            config: config(),
        });

        assert_eq!(response.ok, true);
        assert!(response
            .content
            .unwrap_or_default()
            .contains("selected text"));
        assert_eq!(response.metadata["documentName"], "demo.docx");
        let script = runner.scripts().join("\n");
        assert!(script.contains("KWPS.Application"));
        assert!(!script.contains("Word.Application"));
    }

    #[test]
    fn observe_active_document_includes_document_text() {
        let runner = Arc::new(RecordingRunner::new(Ok(json!({
            "documentName": "demo.docx",
            "documentText": "full WPS document text",
            "selectionText": "",
            "characterCount": 22
        })
        .to_string())));
        let adapter = WpsWriterAdapter::with_runner(runner);

        let response = adapter.observe(&AppUseObserveRequest {
            execution_id: "wps-observe-2".to_string(),
            adapter_id: "wps_writer".to_string(),
            scope: "active_document".to_string(),
            description: "read WPS active document".to_string(),
            target_id: None,
            max_output_chars: 12_000,
            config: config(),
        });

        assert_eq!(response.ok, true);
        assert!(response
            .content
            .unwrap_or_default()
            .contains("full WPS document text"));
    }

    #[test]
    fn act_rejects_missing_target_path_before_running_wps() {
        let runner = Arc::new(RecordingRunner::new(Ok(json!({
            "documentName": "owned-smoke.docx",
            "changed": true
        })
        .to_string())));
        let adapter = WpsWriterAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "wps-act-1".to_string(),
            adapter_id: "wps_writer".to_string(),
            action: "replace_document_text".to_string(),
            description: "replace WPS selection".to_string(),
            target_id: None,
            parameters: Some(json!({ "text": "hello from app use" })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert_eq!(response.metadata["reason"], "target_not_owned");
        assert!(response.receipt.contains("targetId"));
        assert!(runner.scripts().is_empty());
    }

    #[test]
    fn act_with_target_path_opens_owned_document_without_raw_path_interpolation() {
        let owned_root = prepare_owned_test_root();
        let owned_path = owned_root.join("owned-target.docx");
        write_owned_test_file(&owned_path);
        let owned_path_string = owned_path.to_string_lossy().to_string();
        let runner = Arc::new(RecordingRunner::new(Ok(json!({
            "documentName": "owned-target.docx",
            "fullName": owned_path_string.clone(),
            "changed": true
        })
        .to_string())));
        let adapter = WpsWriterAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "wps-act-3".to_string(),
            adapter_id: "wps_writer".to_string(),
            action: "replace_document_text".to_string(),
            description: "replace owned WPS document".to_string(),
            target_id: Some(owned_path_string.clone()),
            parameters: Some(json!({ "text": "hello target" })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, true);
        let script = runner.scripts().join("\n");
        assert!(script.contains("Documents.Open"));
        assert!(script.contains("TypeText"));
        assert!(!script.contains(&owned_path_string));
        assert!(!script.contains("hello target"));
        assert!(!script.contains("Word.Application"));
        remove_owned_test_file(&owned_path);
    }

    #[test]
    fn act_rejects_temp_root_target_without_owned_marker_before_running_wps() {
        let owned_root = prepare_owned_test_root();
        let unmarked_path = owned_root.join("unmarked-target.docx");
        std::fs::write(&unmarked_path, b"not owned").expect("unmarked file");
        let runner = Arc::new(RecordingRunner::new(Ok(json!({}).to_string())));
        let adapter = WpsWriterAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "wps-act-unmarked".to_string(),
            adapter_id: "wps_writer".to_string(),
            action: "replace_document_text".to_string(),
            description: "replace unmarked WPS document".to_string(),
            target_id: Some(unmarked_path.to_string_lossy().to_string()),
            parameters: Some(json!({ "text": "hello target" })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert_eq!(response.metadata["reason"], "target_not_owned");
        assert!(response.receipt.contains("ownership proof"));
        assert!(runner.scripts().is_empty());
        let _ = std::fs::remove_file(&unmarked_path);
    }

    #[test]
    fn act_rejects_self_minted_owned_target_marker_before_running_wps() {
        let owned_root = prepare_owned_test_root();
        let owned_path = owned_root.join("owned-unsigned-marker.docx");
        std::fs::write(&owned_path, b"owned").expect("owned file");
        let canonical_path = owned_path.canonicalize().expect("canonical owned file");
        let target_file = std::fs::File::open(&canonical_path).expect("owned target file");
        let identity = file_identity(&target_file).expect("owned identity");
        let nonce = "self-minted-wps-marker";
        let marker = json!({
            "createdBy": "legacy TouchAI App Use test",
            "pathHash": hash_owned_path(&canonical_path),
            "nonce": nonce,
            "identityHash": hash_owned_marker(&canonical_path, &identity, Some(nonce)),
        });
        std::fs::write(owned_marker_path(&canonical_path), marker.to_string())
            .expect("owned marker");
        let runner = Arc::new(RecordingRunner::new(Ok(json!({}).to_string())));
        let adapter = WpsWriterAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "wps-act-unsigned-marker".to_string(),
            adapter_id: "wps_writer".to_string(),
            action: "replace_document_text".to_string(),
            description: "replace legacy marked WPS document".to_string(),
            target_id: Some(owned_path.to_string_lossy().to_string()),
            parameters: Some(json!({ "text": "safe" })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert!(response.receipt.contains("signed"));
        assert!(runner.scripts().is_empty());
        remove_owned_test_file(&owned_path);
    }

    #[test]
    fn mark_owned_wps_target_refuses_to_overwrite_existing_marker() {
        let owned_root = prepare_owned_test_root();
        let owned_path = owned_root.join("owned-existing-marker.docx");
        remove_owned_test_file(&owned_path);
        std::fs::write(&owned_path, b"owned").expect("owned file");
        let canonical_path = owned_path.canonicalize().expect("canonical owned file");
        std::fs::write(owned_marker_path(&canonical_path), "{}").expect("existing marker");

        let error = mark_owned_wps_target(&owned_path, "WPS Writer", "TouchAI App Use test")
            .expect_err("existing marker must not be overwritten");

        assert!(error.contains("already exists"));
        remove_owned_test_file(&owned_path);
    }

    #[test]
    fn act_rejects_macro_enabled_owned_target_extension_before_running_wps() {
        let owned_root = prepare_owned_test_root();
        let owned_path = owned_root.join("owned-macro-target.docm");
        std::fs::write(&owned_path, b"owned").expect("owned file");
        let runner = Arc::new(RecordingRunner::new(Ok(json!({}).to_string())));
        let adapter = WpsWriterAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "wps-act-macro-extension".to_string(),
            adapter_id: "wps_writer".to_string(),
            action: "replace_document_text".to_string(),
            description: "replace macro WPS document".to_string(),
            target_id: Some(owned_path.to_string_lossy().to_string()),
            parameters: Some(json!({ "text": "safe" })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert!(response.receipt.contains("macro-free"));
        assert!(runner.scripts().is_empty());
        remove_owned_test_file(&owned_path);
    }

    #[cfg(windows)]
    #[test]
    fn act_rejects_hardlinked_owned_target_before_running_wps() {
        let owned_root = prepare_owned_test_root();
        let source_path = owned_root.join("owned-hardlink-source.docx");
        let linked_path = owned_root.join("owned-hardlink-target.docx");
        let _ = std::fs::remove_file(&source_path);
        let _ = std::fs::remove_file(&linked_path);
        write_owned_test_file(&linked_path);
        std::fs::hard_link(&linked_path, &source_path).expect("hardlink");
        let runner = Arc::new(RecordingRunner::new(Ok(json!({}).to_string())));
        let adapter = WpsWriterAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "wps-act-hardlink".to_string(),
            adapter_id: "wps_writer".to_string(),
            action: "replace_document_text".to_string(),
            description: "replace hardlinked WPS document".to_string(),
            target_id: Some(linked_path.to_string_lossy().to_string()),
            parameters: Some(json!({ "text": "do not write" })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert_eq!(response.metadata["reason"], "target_not_owned");
        assert!(response.receipt.contains("hard link"));
        assert!(runner.scripts().is_empty());
        remove_owned_test_file(&linked_path);
        let _ = std::fs::remove_file(&source_path);
    }

    #[cfg(windows)]
    #[test]
    fn act_rejects_hardlinked_owned_marker_before_running_wps() {
        let owned_root = prepare_owned_test_root();
        let owned_path = owned_root.join("owned-hardlink-marker-target.docx");
        let marker_link_path = owned_root.join("owned-hardlink-marker-source.json");
        let _ = std::fs::remove_file(&owned_path);
        let _ = std::fs::remove_file(&marker_link_path);
        write_owned_test_file(&owned_path);
        let marker_path = owned_marker_path(&owned_path.canonicalize().expect("canonical owned"));
        let marker_content = std::fs::read_to_string(&marker_path).expect("marker content");
        std::fs::remove_file(&marker_path).expect("remove original marker");
        std::fs::write(&marker_link_path, marker_content).expect("marker source");
        std::fs::hard_link(&marker_link_path, &marker_path).expect("hardlinked marker");
        let runner = Arc::new(RecordingRunner::new(Ok(json!({}).to_string())));
        let adapter = WpsWriterAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "wps-act-hardlinked-marker".to_string(),
            adapter_id: "wps_writer".to_string(),
            action: "replace_document_text".to_string(),
            description: "replace WPS document with hardlinked marker".to_string(),
            target_id: Some(owned_path.to_string_lossy().to_string()),
            parameters: Some(json!({ "text": "do not write" })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert_eq!(response.metadata["reason"], "target_not_owned");
        assert!(response.receipt.contains("hard link"));
        assert!(runner.scripts().is_empty());
        remove_owned_test_file(&owned_path);
        let _ = std::fs::remove_file(&marker_link_path);
    }

    #[test]
    fn format_document_text_with_target_path_applies_structured_font_options() {
        let owned_root = prepare_owned_test_root();
        let owned_path = owned_root.join("owned-format-target.docx");
        write_owned_test_file(&owned_path);
        let owned_path_string = owned_path.to_string_lossy().to_string();
        let runner = Arc::new(RecordingRunner::new(Ok(json!({
            "documentName": "owned-format-target.docx",
            "fullName": owned_path_string.clone(),
            "changed": true,
            "format": {
                "bold": true,
                "italic": true,
                "underline": true,
                "fontSize": 18,
                "fontName": "Arial"
            }
        })
        .to_string())));
        let adapter = WpsWriterAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "wps-format-1".to_string(),
            adapter_id: "wps_writer".to_string(),
            action: "format_document_text".to_string(),
            description: "format owned WPS document".to_string(),
            target_id: Some(owned_path_string.clone()),
            parameters: Some(json!({
                "bold": true,
                "italic": true,
                "underline": true,
                "fontSize": 18,
                "fontName": "Arial"
            })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, true);
        assert_eq!(response.changed, true);
        let script = runner.scripts().join("\n");
        assert!(script.contains("Documents.Open"));
        assert!(script.contains(".Font.Bold"));
        assert!(script.contains(".Font.Italic"));
        assert!(script.contains(".Font.Underline"));
        assert!(script.contains(".Font.Size"));
        assert!(script.contains(".Font.Name"));
        assert!(!script.contains(&owned_path_string));
        assert!(!script.contains("Arial"));
        assert!(!script.contains("Word.Application"));
        remove_owned_test_file(&owned_path);
    }

    #[test]
    fn format_document_text_rejects_empty_format_before_running_wps() {
        let owned_root = prepare_owned_test_root();
        let owned_path = owned_root.join("owned-empty-format.docx");
        write_owned_test_file(&owned_path);
        let runner = Arc::new(RecordingRunner::new(Ok("{}".to_string())));
        let adapter = WpsWriterAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "wps-format-2".to_string(),
            adapter_id: "wps_writer".to_string(),
            action: "format_document_text".to_string(),
            description: "format owned WPS document".to_string(),
            target_id: Some(owned_path.to_string_lossy().to_string()),
            parameters: Some(json!({})),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert_eq!(response.metadata["reason"], "invalid_parameters");
        assert!(response.receipt.contains("format"));
        assert!(runner.scripts().is_empty());
        remove_owned_test_file(&owned_path);
    }

    #[test]
    fn spreadsheet_write_cells_with_target_path_uses_ket_and_base64_payload() {
        let owned_root = prepare_owned_test_root();
        let owned_path = owned_root.join("owned-sheet-target.xlsx");
        write_owned_test_file(&owned_path);
        let owned_path_string = owned_path.to_string_lossy().to_string();
        let runner = Arc::new(RecordingRunner::new(Ok(json!({
            "workbookName": "owned-sheet-target.xlsx",
            "fullName": owned_path_string.clone(),
            "sheetName": "Sheet1",
            "range": "A1:B1",
            "changed": true,
            "values": [["hello", "42"]]
        })
        .to_string())));
        let adapter = WpsSpreadsheetAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "wps-sheet-1".to_string(),
            adapter_id: "wps_spreadsheet".to_string(),
            action: "write_cells".to_string(),
            description: "write owned WPS spreadsheet cells".to_string(),
            target_id: Some(owned_path_string.clone()),
            parameters: Some(json!({
                "range": "A1:B1",
                "values": [["hello", "42"]]
            })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, true);
        assert_eq!(response.changed, true);
        let script = runner.scripts().join("\n");
        assert!(script.contains("KET.Application"));
        assert!(script.contains("Workbooks.Open"));
        assert!(script.contains("$workbook.Worksheets.Item(1)"));
        assert!(script.contains("$openedFullName"));
        assert!(script.contains("does not match the requested target"));
        assert!(script.contains(".Range($rangeAddress)"));
        assert!(script.contains(".Value2"));
        assert!(!script.contains("$app.ActiveSheet"));
        assert!(!script.contains("$rows = @($valuesJson | ConvertFrom-Json)"));
        assert!(!script.contains("Cells.Item($rowIndex + 1, $columnIndex + 1)"));
        assert!(!script.contains(&owned_path_string));
        assert!(!script.contains("hello"));
        assert!(!script.contains("Excel.Application"));
        remove_owned_test_file(&owned_path);
    }

    #[test]
    fn spreadsheet_write_cells_rejects_empty_values_before_running_wps() {
        let owned_root = prepare_owned_test_root();
        let owned_path = owned_root.join("owned-empty-cells.xlsx");
        write_owned_test_file(&owned_path);
        let runner = Arc::new(RecordingRunner::new(Ok("{}".to_string())));
        let adapter = WpsSpreadsheetAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "wps-sheet-2".to_string(),
            adapter_id: "wps_spreadsheet".to_string(),
            action: "write_cells".to_string(),
            description: "write empty WPS spreadsheet cells".to_string(),
            target_id: Some(owned_path.to_string_lossy().to_string()),
            parameters: Some(json!({
                "range": "A1:B1",
                "values": []
            })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert_eq!(response.metadata["reason"], "invalid_parameters");
        assert!(response.receipt.contains("values"));
        assert!(runner.scripts().is_empty());
        remove_owned_test_file(&owned_path);
    }

    #[test]
    fn spreadsheet_write_cells_rejects_formula_like_strings_before_running_wps() {
        let owned_root = prepare_owned_test_root();
        let owned_path = owned_root.join("owned-formula-cells.xlsx");
        write_owned_test_file(&owned_path);
        let runner = Arc::new(RecordingRunner::new(Ok("{}".to_string())));
        let adapter = WpsSpreadsheetAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "wps-sheet-formula".to_string(),
            adapter_id: "wps_spreadsheet".to_string(),
            action: "write_cells".to_string(),
            description: "write formula-like WPS spreadsheet cells".to_string(),
            target_id: Some(owned_path.to_string_lossy().to_string()),
            parameters: Some(json!({
                "range": "A1",
                "values": [["=HYPERLINK(\"https://example.com\")"]]
            })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert_eq!(response.metadata["reason"], "invalid_parameters");
        assert!(response.receipt.contains("formula"));
        assert!(runner.scripts().is_empty());
        remove_owned_test_file(&owned_path);
    }

    #[test]
    fn spreadsheet_write_cells_rejects_oversized_payload_before_running_wps() {
        let owned_root = prepare_owned_test_root();
        let owned_path = owned_root.join("owned-large-cells.xlsx");
        write_owned_test_file(&owned_path);
        let runner = Arc::new(RecordingRunner::new(Ok("{}".to_string())));
        let adapter = WpsSpreadsheetAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "wps-sheet-large".to_string(),
            adapter_id: "wps_spreadsheet".to_string(),
            action: "write_cells".to_string(),
            description: "write oversized WPS spreadsheet cells".to_string(),
            target_id: Some(owned_path.to_string_lossy().to_string()),
            parameters: Some(json!({
                "range": "A1",
                "values": [[String::from_utf8(vec![b'a'; 4097]).expect("large string")]]
            })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert_eq!(response.metadata["reason"], "invalid_parameters");
        assert!(response.receipt.contains("cell text"));
        assert!(runner.scripts().is_empty());
        remove_owned_test_file(&owned_path);
    }

    #[test]
    fn presentation_add_slide_text_with_target_path_uses_kwpp_and_base64_payload() {
        let owned_root = prepare_owned_test_root();
        let owned_path = owned_root.join("owned-presentation-target.pptx");
        write_owned_test_file(&owned_path);
        let owned_path_string = owned_path.to_string_lossy().to_string();
        let runner = Arc::new(RecordingRunner::new(Ok(json!({
            "presentationName": "owned-presentation-target.pptx",
            "fullName": owned_path_string.clone(),
            "slideIndex": 1,
            "text": "hello slide",
            "changed": true
        })
        .to_string())));
        let adapter = WpsPresentationAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "wps-presentation-1".to_string(),
            adapter_id: "wps_presentation".to_string(),
            action: "add_slide_text".to_string(),
            description: "add text to owned WPS presentation".to_string(),
            target_id: Some(owned_path_string.clone()),
            parameters: Some(json!({
                "text": "hello slide",
                "slideIndex": 1
            })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, true);
        assert_eq!(response.changed, true);
        let script = runner.scripts().join("\n");
        assert!(script.contains("KWPP.Application"));
        assert!(script.contains("Presentations.Open"));
        assert!(script.contains(".Shapes.AddTextbox"));
        assert!(script.contains(".TextFrame.TextRange.Text"));
        assert!(!script.contains(&owned_path_string));
        assert!(!script.contains("hello slide"));
        assert!(!script.contains("PowerPoint.Application"));
        remove_owned_test_file(&owned_path);
    }

    #[test]
    fn presentation_add_slide_text_rejects_empty_text_before_running_wps() {
        let owned_root = prepare_owned_test_root();
        let owned_path = owned_root.join("owned-empty-slide-text.pptx");
        write_owned_test_file(&owned_path);
        let runner = Arc::new(RecordingRunner::new(Ok("{}".to_string())));
        let adapter = WpsPresentationAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "wps-presentation-2".to_string(),
            adapter_id: "wps_presentation".to_string(),
            action: "add_slide_text".to_string(),
            description: "add empty text to owned WPS presentation".to_string(),
            target_id: Some(owned_path.to_string_lossy().to_string()),
            parameters: Some(json!({
                "text": " "
            })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert_eq!(response.metadata["reason"], "invalid_parameters");
        assert!(response.receipt.contains("text"));
        assert!(runner.scripts().is_empty());
        remove_owned_test_file(&owned_path);
    }

    #[test]
    fn observe_rejects_non_owned_target_path_before_running_wps() {
        let runner = Arc::new(RecordingRunner::new(Ok(json!({}).to_string())));
        let adapter = WpsWriterAdapter::with_runner(runner.clone());

        let response = adapter.observe(&AppUseObserveRequest {
            execution_id: "wps-observe-3".to_string(),
            adapter_id: "wps_writer".to_string(),
            scope: "active_document".to_string(),
            description: "read arbitrary WPS document".to_string(),
            target_id: Some("C:\\Users\\Alice\\Documents\\report.docx".to_string()),
            max_output_chars: 12_000,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.metadata["reason"], "target_not_owned");
        assert!(runner.scripts().is_empty());
    }

    #[test]
    fn act_rejects_non_owned_target_path_before_running_wps() {
        let runner = Arc::new(RecordingRunner::new(Ok(json!({}).to_string())));
        let adapter = WpsWriterAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "wps-act-4".to_string(),
            adapter_id: "wps_writer".to_string(),
            action: "replace_document_text".to_string(),
            description: "replace arbitrary WPS document".to_string(),
            target_id: Some("C:\\Users\\Alice\\Documents\\report.docx".to_string()),
            parameters: Some(json!({ "text": "do not write" })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert_eq!(response.metadata["reason"], "target_not_owned");
        assert!(runner.scripts().is_empty());
    }

    #[test]
    fn act_rejects_missing_text_parameter_before_running_wps() {
        let runner = Arc::new(RecordingRunner::new(Ok("{}".to_string())));
        let adapter = WpsWriterAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "wps-act-2".to_string(),
            adapter_id: "wps_writer".to_string(),
            action: "replace_document_text".to_string(),
            description: "replace WPS selection".to_string(),
            target_id: None,
            parameters: Some(json!({})),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert!(response.receipt.contains("text"));
        assert!(runner.scripts().is_empty());
    }

    #[test]
    fn act_rejects_oversized_text_parameter_before_running_wps() {
        let runner = Arc::new(RecordingRunner::new(Ok("{}".to_string())));
        let adapter = WpsWriterAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "wps-act-large-text".to_string(),
            adapter_id: "wps_writer".to_string(),
            action: "replace_document_text".to_string(),
            description: "replace WPS selection".to_string(),
            target_id: None,
            parameters: Some(json!({ "text": "x".repeat(20_001) })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert!(response.receipt.contains("20000"));
        assert!(runner.scripts().is_empty());
    }

    #[test]
    fn powershell_runner_uses_sta_for_wps_com_automation() {
        let args = powershell_arguments("encoded-script");

        assert!(args.iter().any(|arg| arg == "-Sta"));
        assert!(args.iter().any(|arg| arg == "-EncodedCommand"));
        assert_eq!(args.last().map(String::as_str), Some("encoded-script"));
    }
}
