mod common;

use base64::Engine as _;
use common::{build_test_app, invoke_command_ok, TestAppOptions};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tempfile::TempDir;
use touchai_lib::testing;

fn app_use_config(enabled_adapter: &str) -> Value {
    json!({
        "mode": "interactive",
        "adapters": {
            "office_word": false,
            "office_excel": false,
            "office_powerpoint": false,
            "wps_writer": enabled_adapter == "wps_writer",
            "wps_spreadsheet": enabled_adapter == "wps_spreadsheet",
            "wps_presentation": enabled_adapter == "wps_presentation",
            "photoshop": false,
            "illustrator": false
        },
        "mutatingApprovalMode": "always",
        "readScope": "active",
        "allowRawAutomation": false,
        "timeoutMs": 30000,
        "maxOutputChars": 12000
    })
}

fn wps_writer_config() -> Value {
    app_use_config("wps_writer")
}

fn wps_spreadsheet_config() -> Value {
    app_use_config("wps_spreadsheet")
}

fn wps_presentation_config() -> Value {
    app_use_config("wps_presentation")
}

struct OwnedWpsSmokeRoot {
    _root: TempDir,
    path: PathBuf,
}

impl OwnedWpsSmokeRoot {
    fn new() -> Result<Self, String> {
        let root =
            TempDir::new().map_err(|error| format!("Failed to create WPS smoke root: {error}"))?;
        testing::configure_app_use_wps_owned_root_for_tests(root.path())?;
        Ok(Self {
            path: root.path().to_path_buf(),
            _root: root,
        })
    }
}

fn mark_owned_wps_target(path: String, app_label: &str) -> Result<String, String> {
    let canonical_path = PathBuf::from(&path)
        .canonicalize()
        .map_err(|error| format!("Failed to canonicalize owned WPS target: {error}"))?;
    testing::mark_app_use_wps_owned_target_for_tests(&canonical_path, app_label)?;
    Ok(canonical_path.to_string_lossy().to_string())
}

fn powershell_executable() -> PathBuf {
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

    PathBuf::from("powershell.exe")
}

fn run_powershell(script: &str) -> Result<String, String> {
    let shell_path = powershell_executable();
    let mut child = Command::new(&shell_path)
        .args([
            "-Sta",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "Failed to run PowerShell smoke helper ({}): {error}",
                shell_path.display()
            )
        })?;

    let timeout = Duration::from_secs(45);
    let started_at = Instant::now();
    loop {
        match child
            .try_wait()
            .map_err(|error| format!("Failed to wait for PowerShell smoke helper: {error}"))?
        {
            Some(_) => {
                let output = child
                    .wait_with_output()
                    .map_err(|error| format!("Failed to collect PowerShell output: {error}"))?;
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                if output.status.success() {
                    return Ok(stdout);
                } else if stderr.is_empty() {
                    return Err(stdout);
                } else {
                    return Err(stderr);
                }
            }
            None if started_at.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "PowerShell smoke helper timed out after {}s while waiting for KWPS.Application.",
                    timeout.as_secs()
                ));
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn create_owned_wps_document(root: &Path, sentinel: &str) -> Result<String, String> {
    let encoded_sentinel = base64::engine::general_purpose::STANDARD.encode(sentinel.as_bytes());
    let encoded_root =
        base64::engine::general_purpose::STANDARD.encode(root.to_string_lossy().as_bytes());
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
function Invoke-WithComRetry([scriptblock]$Operation) {{
    $lastError = $null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {{
        try {{
            return & $Operation
        }} catch {{
            $lastError = $_
            Start-Sleep -Milliseconds 200
        }}
    }}
    throw $lastError
}}
$sentinel = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_sentinel}'))
$root = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_root}'))
New-Item -ItemType Directory -Force -Path $root | Out-Null
$path = Join-Path $root ($sentinel + '.docx')
$app = Invoke-WithComRetry {{ New-Object -ComObject KWPS.Application }}
$app.Visible = $true
$doc = Invoke-WithComRetry {{ $app.Documents.Add() }}
Invoke-WithComRetry {{ $app.Selection.TypeText($sentinel) }} | Out-Null
Invoke-WithComRetry {{ $doc.SaveAs($path) }} | Out-Null
Invoke-WithComRetry {{ $doc.Close([ref]$false) }} | Out-Null
$path
"#
    );

    mark_owned_wps_target(run_powershell(&script)?, "WPS Writer")
}

fn create_owned_wps_workbook(root: &Path, sentinel: &str) -> Result<String, String> {
    let encoded_sentinel = base64::engine::general_purpose::STANDARD.encode(sentinel.as_bytes());
    let encoded_root =
        base64::engine::general_purpose::STANDARD.encode(root.to_string_lossy().as_bytes());
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
function Invoke-WithComRetry([scriptblock]$Operation) {{
    $lastError = $null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {{
        try {{
            return & $Operation
        }} catch {{
            $lastError = $_
            Start-Sleep -Milliseconds 200
        }}
    }}
    throw $lastError
}}
$sentinel = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_sentinel}'))
$root = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_root}'))
New-Item -ItemType Directory -Force -Path $root | Out-Null
$path = Join-Path $root ($sentinel + '.xlsx')
$app = Invoke-WithComRetry {{ New-Object -ComObject KET.Application }}
$app.Visible = $true
$workbook = Invoke-WithComRetry {{ $app.Workbooks.Add() }}
$sheet = Invoke-WithComRetry {{ $app.ActiveSheet }}
Invoke-WithComRetry {{ $sheet.Range('A1').Value2 = $sentinel }} | Out-Null
Invoke-WithComRetry {{ $workbook.SaveAs($path) }} | Out-Null
Invoke-WithComRetry {{ $workbook.Close($false) }} | Out-Null
$path
"#
    );

    mark_owned_wps_target(run_powershell(&script)?, "WPS Spreadsheet")
}

fn create_owned_wps_presentation(root: &Path, sentinel: &str) -> Result<String, String> {
    let encoded_sentinel = base64::engine::general_purpose::STANDARD.encode(sentinel.as_bytes());
    let encoded_root =
        base64::engine::general_purpose::STANDARD.encode(root.to_string_lossy().as_bytes());
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
function Invoke-WithComRetry([scriptblock]$Operation) {{
    $lastError = $null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {{
        try {{
            return & $Operation
        }} catch {{
            $lastError = $_
            Start-Sleep -Milliseconds 200
        }}
    }}
    throw $lastError
}}
$sentinel = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_sentinel}'))
$root = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_root}'))
New-Item -ItemType Directory -Force -Path $root | Out-Null
$path = Join-Path $root ($sentinel + '.pptx')
$app = Invoke-WithComRetry {{ New-Object -ComObject KWPP.Application }}
$app.Visible = $true
$presentation = Invoke-WithComRetry {{ $app.Presentations.Add() }}
$slide = Invoke-WithComRetry {{ $presentation.Slides.Add(1, 12) }}
$shape = Invoke-WithComRetry {{ $slide.Shapes.AddTextbox(1, 48, 48, 600, 120) }}
Invoke-WithComRetry {{ $shape.TextFrame.TextRange.Text = $sentinel }} | Out-Null
Invoke-WithComRetry {{ $presentation.SaveAs($path) }} | Out-Null
Invoke-WithComRetry {{ $presentation.Close() }} | Out-Null
$path
"#
    );

    mark_owned_wps_target(run_powershell(&script)?, "WPS Presentation")
}

fn close_owned_wps_target(path: &str, prog_id: &str, collection_name: &str) -> Result<(), String> {
    let encoded_path = base64::engine::general_purpose::STANDARD.encode(path.as_bytes());
    let script = format!(
        r#"
$ErrorActionPreference = 'Continue'
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
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_path}'))
try {{
    $app = Invoke-WithComRetry {{ [Runtime.InteropServices.Marshal]::GetActiveObject('{prog_id}') }}
    $targets = $app.{collection_name}
    for ($i = $targets.Count; $i -ge 1; $i--) {{
        $target = $targets.Item($i)
        $candidatePath = ''
        try {{ $candidatePath = [string]$target.FullName }} catch {{}}
        if ($candidatePath -eq $path) {{
            try {{
                Invoke-WithComRetry {{ $target.Close([ref]$false) }} | Out-Null
            }} catch {{
                try {{
                    Invoke-WithComRetry {{ $target.Close($false) }} | Out-Null
                }} catch {{
                    Invoke-WithComRetry {{ $target.Close() }} | Out-Null
                }}
            }}
        }}
    }}
}} catch {{}}
"#
    );
    run_powershell(&script).map(|_| ())
}

fn close_owned_wps_document(path: &str) -> Result<(), String> {
    close_owned_wps_target(path, "KWPS.Application", "Documents")
}

fn close_owned_wps_workbook(path: &str) -> Result<(), String> {
    close_owned_wps_target(path, "KET.Application", "Workbooks")
}

fn close_owned_wps_presentation(path: &str) -> Result<(), String> {
    close_owned_wps_target(path, "KWPP.Application", "Presentations")
}

struct OwnedWpsDocument {
    path: String,
}

impl Drop for OwnedWpsDocument {
    fn drop(&mut self) {
        let _ = close_owned_wps_document(&self.path);
    }
}

struct OwnedWpsWorkbook {
    path: String,
}

impl Drop for OwnedWpsWorkbook {
    fn drop(&mut self) {
        let _ = close_owned_wps_workbook(&self.path);
    }
}

struct OwnedWpsPresentation {
    path: String,
}

impl Drop for OwnedWpsPresentation {
    fn drop(&mut self) {
        let _ = close_owned_wps_presentation(&self.path);
    }
}

#[test]
#[ignore = "Runs real WPS Writer COM automation and creates an owned temp document."]
fn app_use_wps_writer_owned_document_smoke() {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis();
    let sentinel = format!("touchai-app-use-smoke-{millis}");
    let smoke_root = OwnedWpsSmokeRoot::new().expect("owned WPS smoke root");
    let path = create_owned_wps_document(&smoke_root.path, &sentinel).expect("owned WPS document");
    let _owned_document = OwnedWpsDocument { path: path.clone() };
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let session: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_session",
        json!({
            "request": {
                "executionId": "wps-smoke-session",
                "operation": "discover",
                "description": "discover WPS Writer for App Use smoke",
                "config": wps_writer_config()
            }
        }),
    );
    assert_eq!(session["ok"], true);
    assert!(session["adapters"]
        .as_array()
        .expect("adapters")
        .iter()
        .any(|adapter| adapter["id"] == "wps_writer" && adapter["enabled"] == true));

    let inserted = format!("{sentinel}-inserted");
    let authorization: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_authorize_act",
        json!({
            "request": {
                "executionId": "wps-smoke-act",
                "adapterId": "wps_writer",
                "action": "replace_document_text",
                "targetId": path,
                "parameters": { "text": inserted },
                "config": wps_writer_config()
            }
        }),
    );
    let permit = authorization["permit"].clone();
    assert!(permit["token"]
        .as_str()
        .is_some_and(|token| !token.is_empty()));

    let act: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_act",
        json!({
            "request": {
                "executionId": "wps-smoke-act",
                "adapterId": "wps_writer",
                "action": "replace_document_text",
                "description": "write sentinel text to owned WPS document",
                "targetId": path,
                "parameters": { "text": inserted },
                "permit": permit,
                "config": wps_writer_config()
            }
        }),
    );
    eprintln!("app_use_act response: {act}");
    assert_eq!(act["ok"], true);
    assert_eq!(act["changed"], true);

    let observed: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_observe",
        json!({
            "request": {
                "executionId": "wps-smoke-observe",
                "adapterId": "wps_writer",
                "scope": "active_document",
                "description": "verify sentinel text from owned WPS document",
                "targetId": path,
                "maxOutputChars": 12000,
                "config": wps_writer_config()
            }
        }),
    );
    eprintln!("app_use_observe response: {observed}");
    assert_eq!(observed["ok"], true);
    assert!(observed["content"]
        .as_str()
        .expect("content")
        .contains(&inserted));

    let format_authorization: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_authorize_act",
        json!({
            "request": {
                "executionId": "wps-smoke-format",
                "adapterId": "wps_writer",
                "action": "format_document_text",
                "targetId": path,
                "parameters": { "bold": true, "fontSize": 18 },
                "config": wps_writer_config()
            }
        }),
    );
    let format_permit = format_authorization["permit"].clone();
    assert!(format_permit["token"]
        .as_str()
        .is_some_and(|token| !token.is_empty()));

    let formatted: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_act",
        json!({
            "request": {
                "executionId": "wps-smoke-format",
                "adapterId": "wps_writer",
                "action": "format_document_text",
                "description": "format sentinel text in owned WPS document",
                "targetId": path,
                "parameters": { "bold": true, "fontSize": 18 },
                "permit": format_permit,
                "config": wps_writer_config()
            }
        }),
    );
    eprintln!("app_use format_document_text response: {formatted}");
    assert_eq!(formatted["ok"], true);
    assert_eq!(formatted["changed"], true);

    assert!(std::path::Path::new(&path).exists());
}

#[test]
#[ignore = "Runs real WPS Spreadsheet COM automation and creates an owned temp workbook."]
fn app_use_wps_spreadsheet_create_owned_target_smoke() {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis();
    let sentinel = format!("touchai-app-use-sheet-created-smoke-{millis}");
    let smoke_root = OwnedWpsSmokeRoot::new().expect("owned WPS smoke root");
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let created: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_session",
        json!({
            "request": {
                "executionId": "wps-sheet-create-target-smoke",
                "operation": "create_owned_target",
                "description": "create a WPS Spreadsheet target for App Use smoke",
                "adapterId": "wps_spreadsheet",
                "targetKind": "spreadsheet",
                "config": wps_spreadsheet_config()
            }
        }),
    );
    eprintln!("app_use create_owned_target response: {created}");
    assert_eq!(created["ok"], true);
    assert_eq!(created["adapterId"], "wps_spreadsheet");
    assert_eq!(created["targetKind"], "spreadsheet");
    let path = created["target"].as_str().expect("target").to_string();
    assert!(path.ends_with(".xlsx"));
    let canonical_smoke_root = smoke_root
        .path
        .canonicalize()
        .expect("canonical smoke root");
    assert!(
        Path::new(&path).starts_with(&canonical_smoke_root),
        "target {path} should live under {}",
        canonical_smoke_root.display()
    );
    let _owned_workbook = OwnedWpsWorkbook { path: path.clone() };

    let authorization: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_authorize_act",
        json!({
            "request": {
                "executionId": "wps-sheet-create-target-act",
                "adapterId": "wps_spreadsheet",
                "action": "write_cells",
                "targetId": path,
                "parameters": {
                    "range": "A1:B2",
                    "values": [[sentinel, "42"], ["status", "ok"]]
                },
                "config": wps_spreadsheet_config()
            }
        }),
    );
    let permit = authorization["permit"].clone();
    assert!(permit["token"]
        .as_str()
        .is_some_and(|token| !token.is_empty()));

    let act: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_act",
        json!({
            "request": {
                "executionId": "wps-sheet-create-target-act",
                "adapterId": "wps_spreadsheet",
                "action": "write_cells",
                "description": "write sentinel cells to an App Use-created WPS workbook",
                "targetId": path,
                "parameters": {
                    "range": "A1:B2",
                    "values": [[sentinel, "42"], ["status", "ok"]]
                },
                "permit": permit,
                "config": wps_spreadsheet_config()
            }
        }),
    );
    eprintln!("app_use created workbook write_cells response: {act}");
    assert_eq!(act["ok"], true);
    assert_eq!(act["changed"], true);

    let observed: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_observe",
        json!({
            "request": {
                "executionId": "wps-sheet-create-target-observe",
                "adapterId": "wps_spreadsheet",
                "scope": "worksheet",
                "description": "verify sentinel cells from an App Use-created WPS workbook",
                "targetId": path,
                "maxOutputChars": 12000,
                "config": wps_spreadsheet_config()
            }
        }),
    );
    eprintln!("app_use created workbook observe response: {observed}");
    assert_eq!(observed["ok"], true);
    let observed_text = observed["content"].as_str().expect("content");
    assert!(observed_text.contains(&sentinel));
    assert!(observed_text.contains("42"));
    assert!(observed_text.contains("ok"));

    assert!(Path::new(&path).exists());
}

#[test]
#[ignore = "Runs real WPS Spreadsheet COM automation and creates an owned temp workbook."]
fn app_use_wps_spreadsheet_owned_workbook_smoke() {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis();
    let sentinel = format!("touchai-app-use-sheet-smoke-{millis}");
    let smoke_root = OwnedWpsSmokeRoot::new().expect("owned WPS smoke root");
    let path = create_owned_wps_workbook(&smoke_root.path, &sentinel).expect("owned WPS workbook");
    let _owned_workbook = OwnedWpsWorkbook { path: path.clone() };
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let session: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_session",
        json!({
            "request": {
                "executionId": "wps-sheet-smoke-session",
                "operation": "discover",
                "description": "discover WPS Spreadsheet for App Use smoke",
                "config": wps_spreadsheet_config()
            }
        }),
    );
    assert_eq!(session["ok"], true);
    assert!(session["adapters"]
        .as_array()
        .expect("adapters")
        .iter()
        .any(|adapter| adapter["id"] == "wps_spreadsheet" && adapter["enabled"] == true));

    let authorization: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_authorize_act",
        json!({
            "request": {
                "executionId": "wps-sheet-smoke-act",
                "adapterId": "wps_spreadsheet",
                "action": "write_cells",
                "targetId": path,
                "parameters": {
                    "range": "A1:B2",
                    "values": [[sentinel, "42"], ["status", "ok"]]
                },
                "config": wps_spreadsheet_config()
            }
        }),
    );
    let permit = authorization["permit"].clone();
    assert!(permit["token"]
        .as_str()
        .is_some_and(|token| !token.is_empty()));

    let act: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_act",
        json!({
            "request": {
                "executionId": "wps-sheet-smoke-act",
                "adapterId": "wps_spreadsheet",
                "action": "write_cells",
                "description": "write sentinel cells to owned WPS workbook",
                "targetId": path,
                "parameters": {
                    "range": "A1:B2",
                    "values": [[sentinel, "42"], ["status", "ok"]]
                },
                "permit": permit,
                "config": wps_spreadsheet_config()
            }
        }),
    );
    eprintln!("app_use write_cells response: {act}");
    assert_eq!(act["ok"], true);
    assert_eq!(act["changed"], true);

    let observed: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_observe",
        json!({
            "request": {
                "executionId": "wps-sheet-smoke-observe",
                "adapterId": "wps_spreadsheet",
                "scope": "worksheet",
                "description": "verify sentinel cells from owned WPS workbook",
                "targetId": path,
                "maxOutputChars": 12000,
                "config": wps_spreadsheet_config()
            }
        }),
    );
    eprintln!("app_use spreadsheet observe response: {observed}");
    assert_eq!(observed["ok"], true);
    let observed_text = observed["content"].as_str().expect("content");
    assert!(observed_text.contains(&sentinel));
    assert!(observed_text.contains("42"));
    assert!(observed_text.contains("ok"));

    assert!(std::path::Path::new(&path).exists());
}

#[test]
#[ignore = "Runs real WPS Presentation COM automation and creates an owned temp deck."]
fn app_use_wps_presentation_owned_deck_smoke() {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis();
    let sentinel = format!("touchai-app-use-deck-smoke-{millis}");
    let smoke_root = OwnedWpsSmokeRoot::new().expect("owned WPS smoke root");
    let path =
        create_owned_wps_presentation(&smoke_root.path, &sentinel).expect("owned WPS presentation");
    let _owned_presentation = OwnedWpsPresentation { path: path.clone() };
    let test_app = build_test_app(TestAppOptions::default()).expect("test app");

    let session: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_session",
        json!({
            "request": {
                "executionId": "wps-deck-smoke-session",
                "operation": "discover",
                "description": "discover WPS Presentation for App Use smoke",
                "config": wps_presentation_config()
            }
        }),
    );
    assert_eq!(session["ok"], true);
    assert!(session["adapters"]
        .as_array()
        .expect("adapters")
        .iter()
        .any(|adapter| adapter["id"] == "wps_presentation" && adapter["enabled"] == true));

    let inserted = format!("{sentinel}-inserted");
    let authorization: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_authorize_act",
        json!({
            "request": {
                "executionId": "wps-deck-smoke-act",
                "adapterId": "wps_presentation",
                "action": "add_slide_text",
                "targetId": path,
                "parameters": { "text": inserted, "slideIndex": 1 },
                "config": wps_presentation_config()
            }
        }),
    );
    let permit = authorization["permit"].clone();
    assert!(permit["token"]
        .as_str()
        .is_some_and(|token| !token.is_empty()));

    let act: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_act",
        json!({
            "request": {
                "executionId": "wps-deck-smoke-act",
                "adapterId": "wps_presentation",
                "action": "add_slide_text",
                "description": "add sentinel text to owned WPS presentation",
                "targetId": path,
                "parameters": { "text": inserted, "slideIndex": 1 },
                "permit": permit,
                "config": wps_presentation_config()
            }
        }),
    );
    eprintln!("app_use add_slide_text response: {act}");
    assert_eq!(act["ok"], true);
    assert_eq!(act["changed"], true);

    let observed: Value = invoke_command_ok(
        &test_app.main_webview,
        "app_use_observe",
        json!({
            "request": {
                "executionId": "wps-deck-smoke-observe",
                "adapterId": "wps_presentation",
                "scope": "slide",
                "description": "verify sentinel text from owned WPS presentation",
                "targetId": path,
                "maxOutputChars": 12000,
                "config": wps_presentation_config()
            }
        }),
    );
    eprintln!("app_use presentation observe response: {observed}");
    assert_eq!(observed["ok"], true);
    assert!(observed["content"]
        .as_str()
        .expect("content")
        .contains(&inserted));

    assert!(std::path::Path::new(&path).exists());
}
