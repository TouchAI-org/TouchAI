// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

use super::{
    discovery, AppUseActRequest, AppUseActResponse, AppUseAdapter, AppUseAuthorizeActRequest,
    AppUseObserveRequest, AppUseObserveResponse,
};
use base64::{engine::general_purpose, Engine as _};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    process::{Command, Stdio},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

pub trait AdobeAutomationRunner: Send + Sync {
    fn run_script(&self, script: &str, timeout_ms: u64) -> Result<String, String>;
}

struct PowerShellAdobeAutomationRunner;

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
        Err("Adobe App Use automation is only available on Windows.".to_string())
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

impl AdobeAutomationRunner for PowerShellAdobeAutomationRunner {
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
                    "Failed to start Adobe automation shell ({}): {error}",
                    shell_path.display()
                )
            })?;

        let started_at = Instant::now();
        let timeout = Duration::from_millis(timeout_ms.max(1_000));
        loop {
            match child
                .try_wait()
                .map_err(|error| format!("Failed to wait for Adobe automation shell: {error}"))?
            {
                Some(_) => {
                    let output = child.wait_with_output().map_err(|error| {
                        format!("Failed to collect Adobe automation output: {error}")
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
                        "Adobe automation timed out after {timeout_ms}ms while reading active document state."
                    ));
                }
                None => thread::sleep(Duration::from_millis(50)),
            }
        }
    }
}

pub struct PhotoshopAdapter {
    runner: Arc<dyn AdobeAutomationRunner>,
}

impl PhotoshopAdapter {
    pub fn new() -> Self {
        Self {
            runner: Arc::new(PowerShellAdobeAutomationRunner),
        }
    }

    #[cfg(test)]
    pub fn with_runner(runner: Arc<dyn AdobeAutomationRunner>) -> Self {
        Self { runner }
    }
}

impl Default for PhotoshopAdapter {
    fn default() -> Self {
        Self::new()
    }
}

pub struct IllustratorAdapter {
    runner: Arc<dyn AdobeAutomationRunner>,
}

impl IllustratorAdapter {
    pub fn new() -> Self {
        Self {
            runner: Arc::new(PowerShellAdobeAutomationRunner),
        }
    }

    #[cfg(test)]
    pub fn with_runner(runner: Arc<dyn AdobeAutomationRunner>) -> Self {
        Self { runner }
    }
}

impl Default for IllustratorAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl AppUseAdapter for PhotoshopAdapter {
    fn id(&self) -> &'static str {
        "photoshop"
    }

    fn label(&self) -> &'static str {
        "Adobe Photoshop"
    }

    fn capabilities(&self) -> &'static [&'static str] {
        &["discover", "observe_layers"]
    }

    fn vendor(&self) -> &'static str {
        "Adobe"
    }

    fn contract_version(&self) -> &'static str {
        "adobe-readonly-v1"
    }

    fn observe_scopes(&self) -> &'static [&'static str] {
        &["layers"]
    }

    fn installed(&self) -> bool {
        discovery::discover_adapter_install_status(self.id()).installed
    }

    fn observe(&self, request: &AppUseObserveRequest) -> AppUseObserveResponse {
        observe_active_adobe_document(
            self.runner.as_ref(),
            request,
            photoshop_observe_script(),
            format_photoshop_observe_content,
        )
    }

    fn validate_act(&self, _request: &AppUseAuthorizeActRequest) -> Result<(), String> {
        Err("Adobe Photoshop App Use is read-only in this phase.".to_string())
    }

    fn act(&self, request: &AppUseActRequest) -> AppUseActResponse {
        unsupported_adobe_action(request, self.label())
    }
}

impl AppUseAdapter for IllustratorAdapter {
    fn id(&self) -> &'static str {
        "illustrator"
    }

    fn label(&self) -> &'static str {
        "Adobe Illustrator"
    }

    fn capabilities(&self) -> &'static [&'static str] {
        &["discover", "observe_artboards"]
    }

    fn vendor(&self) -> &'static str {
        "Adobe"
    }

    fn contract_version(&self) -> &'static str {
        "adobe-readonly-v1"
    }

    fn observe_scopes(&self) -> &'static [&'static str] {
        &["artboards"]
    }

    fn installed(&self) -> bool {
        discovery::discover_adapter_install_status(self.id()).installed
    }

    fn observe(&self, request: &AppUseObserveRequest) -> AppUseObserveResponse {
        observe_active_adobe_document(
            self.runner.as_ref(),
            request,
            illustrator_observe_script(),
            format_illustrator_observe_content,
        )
    }

    fn validate_act(&self, _request: &AppUseAuthorizeActRequest) -> Result<(), String> {
        Err("Adobe Illustrator App Use is read-only in this phase.".to_string())
    }

    fn act(&self, request: &AppUseActRequest) -> AppUseActResponse {
        unsupported_adobe_action(request, self.label())
    }
}

fn observe_active_adobe_document(
    runner: &dyn AdobeAutomationRunner,
    request: &AppUseObserveRequest,
    script: &'static str,
    format_content: fn(&Value) -> String,
) -> AppUseObserveResponse {
    if request
        .target_id
        .as_deref()
        .is_some_and(|target_id| !target_id.trim().is_empty())
    {
        return AppUseObserveResponse {
            ok: false,
            adapter_id: request.adapter_id.clone(),
            scope: request.scope.clone(),
            target: request.target_id.clone(),
            content: Some(
                "Adobe App Use adapters only observe the active foreground document in this phase."
                    .to_string(),
            ),
            metadata: json!({
                "executionId": request.execution_id,
                "reason": "target_not_supported",
            }),
            truncated: false,
        };
    }

    match run_json_script(runner, script, request.config.timeout_ms) {
        Ok(metadata) => {
            let content = format_content(&metadata);
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
                "reason": "adobe_automation_failed",
            }),
            truncated: false,
        },
    }
}

fn unsupported_adobe_action(request: &AppUseActRequest, label: &str) -> AppUseActResponse {
    AppUseActResponse {
        ok: false,
        adapter_id: request.adapter_id.clone(),
        action: request.action.clone(),
        receipt: format!(
            "{label} App Use currently supports structured read-only observation; mutating or export actions are not enabled yet."
        ),
        changed: false,
        metadata: json!({
            "executionId": request.execution_id,
            "reason": "read_only_adapter",
        }),
    }
}

fn run_json_script(
    runner: &dyn AdobeAutomationRunner,
    script: &str,
    timeout_ms: u64,
) -> Result<Value, String> {
    let output = runner.run_script(script, timeout_ms)?;
    serde_json::from_str(output.trim())
        .map_err(|error| format!("Adobe automation returned invalid JSON: {error}"))
}

fn truncate_content(content: String, max_chars: usize) -> (String, bool) {
    if content.chars().count() <= max_chars {
        return (content, false);
    }

    (content.chars().take(max_chars).collect(), true)
}

fn format_photoshop_observe_content(metadata: &Value) -> String {
    let document_name = metadata
        .get("documentName")
        .and_then(Value::as_str)
        .unwrap_or("active Photoshop document");
    let width = metadata.get("width").and_then(Value::as_str).unwrap_or("");
    let height = metadata.get("height").and_then(Value::as_str).unwrap_or("");
    let active_layer = metadata
        .get("activeLayerName")
        .and_then(Value::as_str)
        .unwrap_or("");
    let layers = metadata
        .get("layers")
        .map(Value::to_string)
        .unwrap_or_else(|| "[]".to_string());

    format!(
        "Document: {document_name}\nCanvas: {width} x {height}\nActive layer: {active_layer}\nLayers: {layers}"
    )
}

fn format_illustrator_observe_content(metadata: &Value) -> String {
    let document_name = metadata
        .get("documentName")
        .and_then(Value::as_str)
        .unwrap_or("active Illustrator document");
    let active_layer = metadata
        .get("activeLayerName")
        .and_then(Value::as_str)
        .unwrap_or("");
    let artboards = metadata
        .get("artboards")
        .map(Value::to_string)
        .unwrap_or_else(|| "[]".to_string());
    let layers = metadata
        .get("layers")
        .map(Value::to_string)
        .unwrap_or_else(|| "[]".to_string());

    format!(
        "Document: {document_name}\nActive layer: {active_layer}\nArtboards: {artboards}\nLayers: {layers}"
    )
}

fn photoshop_observe_script() -> &'static str {
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
$app = Invoke-WithComRetry { [Runtime.InteropServices.Marshal]::GetActiveObject('Photoshop.Application') }
$doc = Invoke-WithComRetry { $app.ActiveDocument }
if ($null -eq $doc) {
    throw 'Photoshop does not have an active document.'
}
$layers = @()
$layerCount = Invoke-WithComRetry { [int]$doc.Layers.Count }
$maxLayerCount = [Math]::Min($layerCount, 100)
for ($i = 1; $i -le $maxLayerCount; $i++) {
    $layer = Invoke-WithComRetry { $doc.Layers.Item($i) }
    $layers += [ordered]@{
        name = Invoke-WithComRetry { [string]$layer.Name }
        visible = Invoke-WithComRetry { [bool]$layer.Visible }
        index = $i
    }
}
$fullName = $null
try {
    $fullName = Invoke-WithComRetry { [string]$doc.FullName }
} catch {
    $fullName = $null
}
$activeLayerName = $null
try {
    $activeLayerName = Invoke-WithComRetry { [string]$doc.ActiveLayer.Name }
} catch {
    $activeLayerName = $null
}
$result = [ordered]@{
    documentName = Invoke-WithComRetry { [string]$doc.Name }
    fullName = $fullName
    width = Invoke-WithComRetry { [string]$doc.Width }
    height = Invoke-WithComRetry { [string]$doc.Height }
    layerCount = $layerCount
    activeLayerName = $activeLayerName
    layers = $layers
    truncatedLayers = $layerCount -gt $maxLayerCount
}
$result | ConvertTo-Json -Compress -Depth 6
"#
    .trim()
}

fn illustrator_observe_script() -> &'static str {
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
$app = Invoke-WithComRetry { [Runtime.InteropServices.Marshal]::GetActiveObject('Illustrator.Application') }
$doc = Invoke-WithComRetry { $app.ActiveDocument }
if ($null -eq $doc) {
    throw 'Illustrator does not have an active document.'
}
$layers = @()
$layerCount = Invoke-WithComRetry { [int]$doc.Layers.Count }
$maxLayerCount = [Math]::Min($layerCount, 100)
for ($i = 1; $i -le $maxLayerCount; $i++) {
    $layer = Invoke-WithComRetry { $doc.Layers.Item($i) }
    $layers += [ordered]@{
        name = Invoke-WithComRetry { [string]$layer.Name }
        visible = Invoke-WithComRetry { [bool]$layer.Visible }
        locked = Invoke-WithComRetry { [bool]$layer.Locked }
        index = $i
    }
}
$artboards = @()
$artboardCount = Invoke-WithComRetry { [int]$doc.Artboards.Count }
$maxArtboardCount = [Math]::Min($artboardCount, 100)
for ($i = 1; $i -le $maxArtboardCount; $i++) {
    $artboard = Invoke-WithComRetry { $doc.Artboards.Item($i) }
    $artboards += [ordered]@{
        name = Invoke-WithComRetry { [string]$artboard.Name }
        index = $i
    }
}
$fullName = $null
try {
    $fullName = Invoke-WithComRetry { [string]$doc.FullName }
} catch {
    $fullName = $null
}
$activeLayerName = $null
try {
    $activeLayerName = Invoke-WithComRetry { [string]$doc.ActiveLayer.Name }
} catch {
    $activeLayerName = $null
}
$result = [ordered]@{
    documentName = Invoke-WithComRetry { [string]$doc.Name }
    fullName = $fullName
    layerCount = $layerCount
    artboardCount = $artboardCount
    activeLayerName = $activeLayerName
    layers = $layers
    artboards = $artboards
    truncatedLayers = $layerCount -gt $maxLayerCount
    truncatedArtboards = $artboardCount -gt $maxArtboardCount
}
$result | ConvertTo-Json -Compress -Depth 6
"#
    .trim()
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

    impl AdobeAutomationRunner for RecordingRunner {
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
            mode: "read_only".to_string(),
            adapters: HashMap::from([
                ("photoshop".to_string(), true),
                ("illustrator".to_string(), true),
            ]),
            mutating_approval_mode: "always".to_string(),
            read_scope: "active".to_string(),
            allow_background_operation: false,
            allow_raw_automation: false,
            timeout_ms: 15_000,
            max_output_chars: 12_000,
            advanced: AppUseAdvancedConfig::default(),
        }
    }

    #[test]
    fn photoshop_observe_reads_active_document_layers_without_raw_target() {
        let runner = Arc::new(RecordingRunner::new(Ok(json!({
            "documentName": "hero.psd",
            "fullName": "C:\\design\\hero.psd",
            "width": "1024 px",
            "height": "768 px",
            "layerCount": 2,
            "activeLayerName": "Logo",
            "layers": [
                { "name": "Logo", "visible": true, "index": 1 },
                { "name": "Background", "visible": true, "index": 2 }
            ],
            "truncatedLayers": false
        })
        .to_string())));
        let adapter = PhotoshopAdapter::with_runner(runner.clone());

        let response = adapter.observe(&AppUseObserveRequest {
            execution_id: "ps-observe-1".to_string(),
            adapter_id: "photoshop".to_string(),
            scope: "layers".to_string(),
            description: "read Photoshop layers".to_string(),
            target_id: None,
            max_output_chars: 12_000,
            config: config(),
        });

        assert_eq!(response.ok, true);
        assert!(response.content.unwrap_or_default().contains("Logo"));
        let script = runner.scripts().join("\n");
        assert!(script.contains("Photoshop.Application"));
        assert!(script.contains("ActiveDocument"));
        assert!(script.contains(".Layers"));
        assert!(!script.contains("UIAutomation"));
    }

    #[test]
    fn photoshop_observe_rejects_explicit_target_before_running_adobe() {
        let runner = Arc::new(RecordingRunner::new(Ok("{}".to_string())));
        let adapter = PhotoshopAdapter::with_runner(runner.clone());

        let response = adapter.observe(&AppUseObserveRequest {
            execution_id: "ps-observe-2".to_string(),
            adapter_id: "photoshop".to_string(),
            scope: "layers".to_string(),
            description: "read explicit Photoshop target".to_string(),
            target_id: Some("C:\\design\\hero.psd".to_string()),
            max_output_chars: 12_000,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.metadata["reason"], "target_not_supported");
        assert!(runner.scripts().is_empty());
    }

    #[test]
    fn illustrator_observe_reads_active_document_artboards_and_layers() {
        let runner = Arc::new(RecordingRunner::new(Ok(json!({
            "documentName": "poster.ai",
            "fullName": "C:\\design\\poster.ai",
            "layerCount": 1,
            "artboardCount": 1,
            "activeLayerName": "Artwork",
            "layers": [
                { "name": "Artwork", "visible": true, "locked": false, "index": 1 }
            ],
            "artboards": [
                { "name": "A1", "index": 1 }
            ],
            "truncatedLayers": false,
            "truncatedArtboards": false
        })
        .to_string())));
        let adapter = IllustratorAdapter::with_runner(runner.clone());

        let response = adapter.observe(&AppUseObserveRequest {
            execution_id: "ai-observe-1".to_string(),
            adapter_id: "illustrator".to_string(),
            scope: "artboards".to_string(),
            description: "read Illustrator artboards".to_string(),
            target_id: None,
            max_output_chars: 12_000,
            config: config(),
        });

        assert_eq!(response.ok, true);
        assert!(response.content.unwrap_or_default().contains("A1"));
        let script = runner.scripts().join("\n");
        assert!(script.contains("Illustrator.Application"));
        assert!(script.contains("ActiveDocument"));
        assert!(script.contains(".Artboards"));
        assert!(script.contains(".Layers"));
        assert!(!script.contains("UIAutomation"));
    }

    #[test]
    fn adobe_actions_are_explicitly_read_only_before_running_adobe() {
        let runner = Arc::new(RecordingRunner::new(Ok("{}".to_string())));
        let adapter = IllustratorAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "ai-act-1".to_string(),
            adapter_id: "illustrator".to_string(),
            action: "export_preview".to_string(),
            description: "export Illustrator preview".to_string(),
            target_id: None,
            parameters: None,
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert_eq!(response.metadata["reason"], "read_only_adapter");
        assert!(runner.scripts().is_empty());
    }
}
