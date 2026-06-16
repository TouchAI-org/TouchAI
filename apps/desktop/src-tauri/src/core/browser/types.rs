use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserStatusKind {
    Idle,
    Starting,
    Connected,
    Error,
}

impl Default for BrowserStatusKind {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDescriptor {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub id: String,
    pub url: String,
    pub title: String,
    pub active: bool,
    pub navigation_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub status: BrowserStatusKind,
    pub managed: bool,
    pub active_tab_id: Option<String>,
    pub tabs: Vec<BrowserTab>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserExistingSession {
    pub id: String,
    pub label: String,
    pub endpoint: String,
    pub browser_name: String,
    pub current_url: Option<String>,
    pub title: Option<String>,
    pub tabs: Vec<BrowserTab>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct BrowserConnectExistingRequest {
    pub endpoint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserConnectExistingResult {
    pub status: BrowserStatus,
    pub session: BrowserExistingSession,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct BrowserStartRequest {
    pub headless: Option<bool>,
    pub startup_url: Option<String>,
    pub browser_executable_path: Option<PathBuf>,
    pub browser_data_path: Option<PathBuf>,
    pub fingerprint_mode: Option<BrowserFingerprintMode>,
    pub fingerprint_locale: Option<String>,
    pub fingerprint_timezone: Option<String>,
    pub fingerprint_user_agent: Option<String>,
    pub fingerprint_window_size: Option<String>,
    pub fingerprint_stealth_script: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserFingerprintMode {
    Off,
    Balanced,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct BrowserNavigateRequest {
    pub tab_id: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct BrowserTabRequest {
    pub tab_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserObserveOperation {
    State,
    Snapshot,
    Screenshot,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct BrowserObserveRequest {
    pub operation: BrowserObserveOperation,
    pub tab_id: Option<String>,
    pub include_console: Option<bool>,
    pub include_network: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDomRef {
    pub ref_id: String,
    pub navigation_token: String,
    pub description: String,
    pub editable: bool,
    pub selector: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserObservation {
    pub status: BrowserStatus,
    pub url: Option<String>,
    pub title: Option<String>,
    pub navigation_token: Option<String>,
    pub dom_refs: Vec<BrowserDomRef>,
    pub file_path: Option<PathBuf>,
    pub mime_type: Option<String>,
    pub console: Vec<String>,
    pub network: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserActOperation {
    Click,
    Type,
    Fill,
    FillForm,
    PressKey,
    Scroll,
    Wait,
}

impl BrowserActOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Click => "click",
            Self::Type => "type",
            Self::Fill => "fill",
            Self::FillForm => "fill_form",
            Self::PressKey => "press_key",
            Self::Scroll => "scroll",
            Self::Wait => "wait",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct BrowserActRequest {
    pub action: BrowserActOperation,
    pub tab_id: Option<String>,
    pub ref_id: Option<String>,
    #[serde(alias = "ref")]
    pub target_ref: Option<String>,
    pub navigation_token: Option<String>,
    pub text: Option<String>,
    pub value: Option<String>,
    pub key: Option<String>,
    pub delta_x: Option<i64>,
    pub delta_y: Option<i64>,
    pub timeout_ms: Option<u64>,
    pub fields: Option<Vec<BrowserFormField>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct BrowserFormField {
    pub ref_id: String,
    pub navigation_token: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActResult {
    pub ok: bool,
    pub action: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEndpointSnapshot {
    pub host: String,
    pub port: u16,
    pub version_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CdpVersionResponse {
    #[serde(default, rename = "Browser")]
    pub browser: Option<String>,
    #[serde(default, rename = "webSocketDebuggerUrl")]
    pub web_socket_debugger_url: Option<String>,
}
