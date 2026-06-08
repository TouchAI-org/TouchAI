// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

use super::{
    discovery, AppUseActRequest, AppUseActResponse, AppUseAdapter, AppUseObserveRequest,
    AppUseObserveResponse,
};
use base64::{engine::general_purpose, Engine as _};
use serde_json::{json, Value};
use std::{
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

fn powershell_executable() -> PathBuf {
    #[cfg(windows)]
    {
        let windows_root = std::env::var_os("WINDIR")
            .or_else(|| std::env::var_os("SystemRoot"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let wow64_powershell = windows_root
            .join("SysWOW64")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");

        if wow64_powershell.exists() {
            return wow64_powershell;
        }
    }

    PathBuf::from("powershell.exe")
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
        let shell_path = powershell_executable();
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
            "insert_text",
            "replace_selection",
            "format_selection",
        ]
    }

    fn installed(&self) -> bool {
        discovery::discover_adapter_install_status(self.id()).installed
    }

    fn observe(&self, request: &AppUseObserveRequest) -> AppUseObserveResponse {
        if let Err(error) = validate_owned_target(request.target_id.as_deref(), false) {
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

        let script = wps_observe_script(request.target_id.as_deref());
        match run_json_script(self.runner.as_ref(), &script, request.config.timeout_ms) {
            Ok(metadata) => {
                let content = format_observe_content(&metadata, &request.scope);
                let (content, truncated) = truncate_content(content, request.max_output_chars);
                AppUseObserveResponse {
                    ok: true,
                    adapter_id: request.adapter_id.clone(),
                    scope: request.scope.clone(),
                    target: metadata
                        .get("fullName")
                        .and_then(Value::as_str)
                        .map(str::to_string),
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

    fn act(&self, request: &AppUseActRequest) -> AppUseActResponse {
        if !matches!(request.action.as_str(), "insert_text" | "replace_selection") {
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

        let text = match text_parameter(request.parameters.as_ref()) {
            Ok(text) => text,
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
        if let Err(error) = validate_owned_target(request.target_id.as_deref(), true) {
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
        let script = wps_type_text_script(&text, request.target_id.as_deref());

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

    Ok(text)
}

fn owned_wps_target_root() -> PathBuf {
    std::env::temp_dir().join("touchai-wps-smoke")
}

fn validate_owned_target(target_path: Option<&str>, required: bool) -> Result<(), String> {
    let Some(target_path) = target_path else {
        return if required {
            Err(
                "WPS Writer targetId must reference a TouchAI-owned document before running write actions."
                    .to_string(),
            )
        } else {
            Ok(())
        };
    };

    let trimmed_path = target_path.trim();
    if trimmed_path.is_empty() {
        return if required {
            Err(
                "WPS Writer targetId must reference a TouchAI-owned document before running write actions."
                    .to_string(),
            )
        } else {
            Ok(())
        };
    }

    let candidate = Path::new(trimmed_path);
    if !candidate.is_absolute() {
        return Err(
            "WPS Writer targetId must reference a TouchAI-owned absolute document path."
                .to_string(),
        );
    }

    let canonical_root = owned_wps_target_root().canonicalize().map_err(|_| {
        "WPS Writer targetId root is not available for owned document access.".to_string()
    })?;
    let canonical_candidate = candidate.canonicalize().map_err(|_| {
        "WPS Writer targetId must reference an existing TouchAI-owned document.".to_string()
    })?;

    if canonical_candidate.starts_with(&canonical_root) {
        Ok(())
    } else {
        Err("WPS Writer targetId is not a TouchAI-owned document path.".to_string())
    }
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

fn wps_observe_script(target_path: Option<&str>) -> String {
    let encoded_target_path = encoded_utf8_script_value(target_path);
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
$documentText = Invoke-WithComRetry { [string]$doc.Content.Text }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::app_use::types::{AppUseActRequest, AppUseConfig, AppUseObserveRequest};
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
        }
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
            action: "replace_selection".to_string(),
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
        let owned_root = owned_wps_target_root();
        std::fs::create_dir_all(&owned_root).expect("owned root");
        let owned_path = owned_root.join("owned-target.docx");
        std::fs::write(&owned_path, b"owned").expect("owned file");
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
            action: "replace_selection".to_string(),
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
        let _ = std::fs::remove_file(&owned_path);
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
            action: "replace_selection".to_string(),
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
            action: "replace_selection".to_string(),
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
    fn powershell_runner_uses_sta_for_wps_com_automation() {
        let args = powershell_arguments("encoded-script");

        assert!(args.iter().any(|arg| arg == "-Sta"));
        assert!(args.iter().any(|arg| arg == "-EncodedCommand"));
        assert_eq!(args.last().map(String::as_str), Some("encoded-script"));
    }
}
