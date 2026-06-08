mod common;

use base64::Engine as _;
use common::{build_test_app, invoke_command_ok, TestAppOptions};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

fn app_use_config() -> Value {
    json!({
        "mode": "interactive",
        "adapters": {
            "office_word": false,
            "office_excel": false,
            "office_powerpoint": false,
            "wps_writer": true,
            "wps_spreadsheet": false,
            "wps_presentation": false,
            "photoshop": false,
            "illustrator": false
        },
        "mutatingApprovalMode": "always",
        "readScope": "active",
        "allowBackgroundOperation": false,
        "allowRawAutomation": false,
        "timeoutMs": 30000,
        "maxOutputChars": 12000
    })
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

fn create_owned_wps_document(sentinel: &str) -> Result<String, String> {
    let encoded_sentinel = base64::engine::general_purpose::STANDARD.encode(sentinel.as_bytes());
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
$root = Join-Path $env:TEMP 'touchai-wps-smoke'
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

    run_powershell(&script)
}

fn close_owned_wps_document(path: &str) -> Result<(), String> {
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
    $app = Invoke-WithComRetry {{ [Runtime.InteropServices.Marshal]::GetActiveObject('KWPS.Application') }}
    for ($i = $app.Documents.Count; $i -ge 1; $i--) {{
        $doc = $app.Documents.Item($i)
        $candidatePath = ''
        try {{ $candidatePath = [string]$doc.FullName }} catch {{}}
        if ($candidatePath -eq $path) {{
            Invoke-WithComRetry {{ $doc.Close([ref]$false) }} | Out-Null
        }}
    }}
}} catch {{}}
"#
    );
    run_powershell(&script).map(|_| ())
}

struct OwnedWpsDocument {
    path: String,
}

impl Drop for OwnedWpsDocument {
    fn drop(&mut self) {
        let _ = close_owned_wps_document(&self.path);
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
    let path = create_owned_wps_document(&sentinel).expect("owned WPS document");
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
                "config": app_use_config()
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
                "action": "replace_selection",
                "targetId": path,
                "parameters": { "text": inserted },
                "config": app_use_config()
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
                "action": "replace_selection",
                "description": "write sentinel text to owned WPS document",
                "targetId": path,
                "parameters": { "text": inserted },
                "permit": permit,
                "config": app_use_config()
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
                "config": app_use_config()
            }
        }),
    );
    eprintln!("app_use_observe response: {observed}");
    assert_eq!(observed["ok"], true);
    assert!(observed["content"]
        .as_str()
        .expect("content")
        .contains(&inserted));

    assert!(std::path::Path::new(&path).exists());
}
