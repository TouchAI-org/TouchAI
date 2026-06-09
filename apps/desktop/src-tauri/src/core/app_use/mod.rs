// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

pub mod adobe;
pub mod discovery;
pub mod office;
pub mod types;
pub mod wps;

use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
pub use types::{
    AppUseActPermit, AppUseActRequest, AppUseActResponse, AppUseAdapterContract,
    AppUseAdapterDescriptor, AppUseAuthorizeActRequest, AppUseAuthorizeActResponse,
    AppUseObserveRequest, AppUseObserveResponse, AppUseSessionRequest, AppUseSessionResponse,
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const APP_USE_PERMIT_TTL: Duration = Duration::from_secs(30);
const APP_USE_CREATE_TARGET_OPERATION: &str = "create_owned_target";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AppUseAdapterDefinition {
    id: &'static str,
    label: &'static str,
    capabilities: &'static [&'static str],
}

const APP_USE_ADAPTERS: &[AppUseAdapterDefinition] = &[
    AppUseAdapterDefinition {
        id: "office_word",
        label: "Microsoft Word",
        capabilities: &[
            "discover",
            "observe_active_document",
            "observe_selection",
            "replace_document_text",
            "format_document_text",
        ],
    },
    AppUseAdapterDefinition {
        id: "office_excel",
        label: "Microsoft Excel",
        capabilities: &[
            "discover",
            "observe_workbook",
            "observe_worksheet",
            "write_cells",
        ],
    },
    AppUseAdapterDefinition {
        id: "office_powerpoint",
        label: "Microsoft PowerPoint",
        capabilities: &[
            "discover",
            "observe_presentation",
            "observe_slide",
            "add_slide_text",
        ],
    },
    AppUseAdapterDefinition {
        id: "wps_writer",
        label: "WPS Writer",
        capabilities: &[
            "discover",
            "observe_active_document",
            "observe_selection",
            "replace_document_text",
            "format_document_text",
        ],
    },
    AppUseAdapterDefinition {
        id: "wps_spreadsheet",
        label: "WPS Spreadsheet",
        capabilities: &[
            "discover",
            "observe_workbook",
            "observe_worksheet",
            "write_cells",
        ],
    },
    AppUseAdapterDefinition {
        id: "wps_presentation",
        label: "WPS Presentation",
        capabilities: &[
            "discover",
            "observe_presentation",
            "observe_slide",
            "add_slide_text",
        ],
    },
    AppUseAdapterDefinition {
        id: "photoshop",
        label: "Adobe Photoshop",
        capabilities: &["discover", "observe_layers"],
    },
    AppUseAdapterDefinition {
        id: "illustrator",
        label: "Adobe Illustrator",
        capabilities: &["discover", "observe_artboards"],
    },
];

pub trait AppUseAdapter: Send + Sync {
    fn id(&self) -> &'static str;

    fn label(&self) -> &'static str;

    fn capabilities(&self) -> &'static [&'static str];

    fn vendor(&self) -> &'static str {
        "builtin"
    }

    fn contract_version(&self) -> &'static str {
        "app-use-adapter/v1"
    }

    fn observe_scopes(&self) -> &'static [&'static str] {
        &[]
    }

    fn actions(&self) -> &'static [&'static str] {
        &[]
    }

    fn risk_level(&self) -> &'static str {
        "high"
    }

    fn raw_automation_allowed(&self) -> bool {
        false
    }

    fn contract(&self) -> AppUseAdapterContract {
        AppUseAdapterContract {
            vendor: self.vendor().to_string(),
            version: self.contract_version().to_string(),
            observe_scopes: self
                .observe_scopes()
                .iter()
                .map(|scope| scope.to_string())
                .collect(),
            actions: self
                .actions()
                .iter()
                .map(|action| action.to_string())
                .collect(),
            risk_level: self.risk_level().to_string(),
            raw_automation_allowed: self.raw_automation_allowed(),
        }
    }

    fn installed(&self) -> bool {
        false
    }

    fn running(&self) -> bool {
        false
    }

    fn active_target_name(&self) -> Option<String> {
        None
    }

    fn observe(&self, request: &AppUseObserveRequest) -> AppUseObserveResponse {
        AppUseObserveResponse {
            ok: false,
            adapter_id: request.adapter_id.clone(),
            scope: request.scope.clone(),
            target: request.target_id.clone(),
            content: Some(
                "No structured App Use adapter is available for this application yet.".to_string(),
            ),
            metadata: json!({
                "executionId": request.execution_id,
                "reason": "adapter_unimplemented",
            }),
            truncated: false,
        }
    }

    fn validate_act(&self, _request: &AppUseAuthorizeActRequest) -> Result<(), String> {
        Err("No structured App Use action adapter is available yet.".to_string())
    }

    fn act(&self, request: &AppUseActRequest) -> AppUseActResponse {
        AppUseActResponse {
            ok: false,
            adapter_id: request.adapter_id.clone(),
            action: request.action.clone(),
            receipt: "No structured App Use action adapter is available yet.".to_string(),
            changed: false,
            metadata: json!({
                "executionId": request.execution_id,
                "reason": "adapter_unimplemented",
            }),
        }
    }
}

struct StaticAppUseAdapter {
    definition: AppUseAdapterDefinition,
}

impl AppUseAdapter for StaticAppUseAdapter {
    fn id(&self) -> &'static str {
        self.definition.id
    }

    fn label(&self) -> &'static str {
        self.definition.label
    }

    fn capabilities(&self) -> &'static [&'static str] {
        self.definition.capabilities
    }

    fn vendor(&self) -> &'static str {
        "builtin"
    }

    fn installed(&self) -> bool {
        discovery::discover_adapter_install_status(self.definition.id).installed
    }
}

pub struct AppUseRuntime {
    adapters: Vec<Box<dyn AppUseAdapter>>,
    act_permits: Mutex<HashMap<String, PermitRecord>>,
}

#[derive(Clone, Debug)]
struct PermitRecord {
    permit: AppUseActPermit,
    expires_at: Instant,
}

impl AppUseRuntime {
    pub fn new() -> Self {
        Self::with_adapters(
            APP_USE_ADAPTERS
                .iter()
                .copied()
                .map(|definition| match definition.id {
                    "office_word" => {
                        Box::new(office::OfficeWordAdapter::new()) as Box<dyn AppUseAdapter>
                    }
                    "office_excel" => {
                        Box::new(office::OfficeExcelAdapter::new()) as Box<dyn AppUseAdapter>
                    }
                    "office_powerpoint" => {
                        Box::new(office::OfficePowerPointAdapter::new()) as Box<dyn AppUseAdapter>
                    }
                    "wps_writer" => {
                        Box::new(wps::WpsWriterAdapter::new()) as Box<dyn AppUseAdapter>
                    }
                    "wps_spreadsheet" => {
                        Box::new(wps::WpsSpreadsheetAdapter::new()) as Box<dyn AppUseAdapter>
                    }
                    "wps_presentation" => {
                        Box::new(wps::WpsPresentationAdapter::new()) as Box<dyn AppUseAdapter>
                    }
                    "photoshop" => {
                        Box::new(adobe::PhotoshopAdapter::new()) as Box<dyn AppUseAdapter>
                    }
                    "illustrator" => {
                        Box::new(adobe::IllustratorAdapter::new()) as Box<dyn AppUseAdapter>
                    }
                    _ => Box::new(StaticAppUseAdapter { definition }) as Box<dyn AppUseAdapter>,
                })
                .collect(),
        )
    }

    pub fn with_adapters(adapters: Vec<Box<dyn AppUseAdapter>>) -> Self {
        Self {
            adapters,
            act_permits: Mutex::new(HashMap::new()),
        }
    }

    fn find_adapter(&self, adapter_id: &str) -> Option<&dyn AppUseAdapter> {
        self.adapters
            .iter()
            .find(|adapter| adapter.id() == adapter_id)
            .map(|adapter| adapter.as_ref())
    }

    fn adapter_supports_action(adapter: &dyn AppUseAdapter, action: &str) -> bool {
        adapter
            .actions()
            .iter()
            .any(|supported_action| *supported_action == action)
    }

    fn adapter_supports_observe_scope(adapter: &dyn AppUseAdapter, scope: &str) -> bool {
        adapter
            .observe_scopes()
            .iter()
            .any(|supported_scope| *supported_scope == scope)
    }

    fn create_owned_target(
        &self,
        adapter_id: &str,
        target_kind: Option<&str>,
    ) -> Result<(String, String), String> {
        let spec = OwnedTargetSpec::from_request(adapter_id, target_kind)?;
        let target_path = create_owned_target_file(&spec)?;
        let canonical_path = match spec.family {
            OwnedTargetFamily::Office => {
                office::mark_owned_office_target(&target_path, spec.app_label, "TouchAI App Use")?
            }
            OwnedTargetFamily::Wps => {
                wps::mark_owned_wps_target(&target_path, spec.app_label, "TouchAI App Use")?
            }
        };
        Ok((
            canonical_path.to_string_lossy().to_string(),
            spec.kind.to_string(),
        ))
    }

    fn normalize_config(&self, mut config: types::AppUseConfig) -> types::AppUseConfig {
        if config.mode != "interactive" {
            config.mode = "read_only".to_string();
        }
        config.mutating_approval_mode = "always".to_string();
        config.read_scope = "active".to_string();
        config.allow_background_operation = false;
        config.allow_raw_automation = false;
        config.timeout_ms = match config.timeout_ms {
            1_000..=120_000 => config.timeout_ms,
            _ => 15_000,
        };
        config.max_output_chars = match config.max_output_chars {
            1_000..=50_000 => config.max_output_chars,
            _ => 12_000,
        };
        config.advanced = types::AppUseAdvancedConfig::default();
        config
            .adapters
            .retain(|adapter_id, _| self.find_adapter(adapter_id).is_some());
        config
    }

    fn cleanup_expired_permits(&self, now: Instant) {
        let mut permits = self.act_permits.lock().expect("app use permits");
        permits.retain(|_, record| record.expires_at > now);
    }

    fn advanced_action_enabled(&self, request: &AppUseAuthorizeActRequest) -> bool {
        match request.action.as_str() {
            "export_preview" => request.config.advanced.export_previews,
            "batch_export" => request.config.advanced.batch_workflows,
            "cross_app_transfer" => request.config.advanced.cross_app_workflows,
            _ => true,
        }
    }

    fn advanced_act_enabled(&self, request: &AppUseActRequest) -> bool {
        match request.action.as_str() {
            "export_preview" => request.config.advanced.export_previews,
            "batch_export" => request.config.advanced.batch_workflows,
            "cross_app_transfer" => request.config.advanced.cross_app_workflows,
            _ => true,
        }
    }

    fn issue_permit(&self, request: &AppUseAuthorizeActRequest) -> AppUseActPermit {
        let permit = AppUseActPermit {
            call_id: request.execution_id.clone(),
            adapter_id: request.adapter_id.clone(),
            action: request.action.clone(),
            target_id: request.target_id.clone(),
            parameters_hash: hash_parameters(request.parameters.as_ref()),
            token: uuid::Uuid::new_v4().to_string(),
        };
        let record = PermitRecord {
            permit: permit.clone(),
            expires_at: Instant::now() + APP_USE_PERMIT_TTL,
        };
        self.act_permits
            .lock()
            .expect("app use permits")
            .insert(permit.token.clone(), record);
        permit
    }

    fn consume_valid_permit(&self, request: &AppUseActRequest) -> bool {
        let Some(permit) = request.permit.as_ref() else {
            return false;
        };
        let now = Instant::now();
        self.cleanup_expired_permits(now);

        let Some(record) = self
            .act_permits
            .lock()
            .expect("app use permits")
            .remove(&permit.token)
        else {
            return false;
        };

        record.expires_at > now
            && record.permit == *permit
            && permit.call_id == request.execution_id
            && permit.adapter_id == request.adapter_id
            && permit.action == request.action
            && permit.target_id == request.target_id
            && permit.parameters_hash == hash_parameters(request.parameters.as_ref())
    }

    pub fn session(&self, request: AppUseSessionRequest) -> AppUseSessionResponse {
        let config = self.normalize_config(request.config);
        if request.operation == APP_USE_CREATE_TARGET_OPERATION {
            let target_response = request
                .adapter_id
                .as_deref()
                .ok_or_else(|| "create_owned_target requires adapterId.".to_string())
                .and_then(|adapter_id| {
                    if !config.adapter_enabled(adapter_id) {
                        return Err(
                            "App Use adapter is disabled. Enable it in Settings > App Use before creating an owned target."
                            .to_string(),
                        );
                    }
                    self.create_owned_target(adapter_id, request.target_kind.as_deref())
                        .map(|(target, target_kind)| {
                            (adapter_id.to_string(), target_kind, target)
                        })
                });

            return match target_response {
                Ok((adapter_id, target_kind, target)) => AppUseSessionResponse {
                    ok: true,
                    operation: request.operation,
                    adapters: Vec::new(),
                    message: Some("TouchAI-owned App Use target created.".to_string()),
                    adapter_id: Some(adapter_id),
                    target_kind: Some(target_kind),
                    target: Some(target),
                },
                Err(error) => AppUseSessionResponse {
                    ok: false,
                    operation: request.operation,
                    adapters: Vec::new(),
                    message: Some(error),
                    adapter_id: request.adapter_id,
                    target_kind: request.target_kind,
                    target: None,
                },
            };
        }

        let adapters = self
            .adapters
            .iter()
            .map(|adapter| AppUseAdapterDescriptor {
                id: adapter.id().to_string(),
                label: adapter.label().to_string(),
                installed: adapter.installed(),
                running: adapter.running(),
                enabled: config.adapter_enabled(adapter.id()),
                capabilities: adapter
                    .capabilities()
                    .iter()
                    .map(|capability| capability.to_string())
                    .collect(),
                contract: adapter.contract(),
                active_target_name: adapter.active_target_name(),
            })
            .collect();

        AppUseSessionResponse {
            ok: true,
            operation: request.operation,
            adapters,
            message: None,
            adapter_id: None,
            target_kind: None,
            target: None,
        }
    }

    pub fn observe(&self, mut request: AppUseObserveRequest) -> AppUseObserveResponse {
        request.config = self.normalize_config(request.config);
        if !request.config.adapter_enabled(&request.adapter_id) {
            return AppUseObserveResponse {
                ok: false,
                adapter_id: request.adapter_id,
                scope: request.scope,
                target: request.target_id,
                content: Some(
                    "App Use adapter is disabled. Enable it in Settings > App Use before observing."
                        .to_string(),
                ),
                metadata: json!({
                    "executionId": request.execution_id,
                    "reason": "adapter_disabled",
                }),
                truncated: false,
            };
        }

        self.find_adapter(&request.adapter_id)
            .map(|adapter| {
                if !Self::adapter_supports_observe_scope(adapter, &request.scope) {
                    return AppUseObserveResponse {
                        ok: false,
                        adapter_id: request.adapter_id.clone(),
                        scope: request.scope.clone(),
                        target: request.target_id.clone(),
                        content: Some(format!(
                            "App Use adapter does not declare support for observe scope {}.",
                            request.scope
                        )),
                        metadata: json!({
                            "executionId": request.execution_id,
                            "reason": "unsupported_scope",
                        }),
                        truncated: false,
                    };
                }

                adapter.observe(&request)
            })
            .unwrap_or_else(|| AppUseObserveResponse {
                ok: false,
                adapter_id: request.adapter_id,
                scope: request.scope,
                target: request.target_id,
                content: Some("Unknown App Use adapter.".to_string()),
                metadata: json!({
                    "executionId": request.execution_id,
                    "reason": "adapter_unknown",
                }),
                truncated: false,
            })
    }

    pub fn authorize_act(
        &self,
        mut request: AppUseAuthorizeActRequest,
    ) -> AppUseAuthorizeActResponse {
        request.config = self.normalize_config(request.config);
        if request.config.is_read_only() || !request.config.adapter_enabled(&request.adapter_id) {
            return AppUseAuthorizeActResponse {
                permit: None,
                expires_in_ms: 0,
            };
        }
        if !self.advanced_action_enabled(&request) {
            return AppUseAuthorizeActResponse {
                permit: None,
                expires_in_ms: 0,
            };
        }

        let Some(adapter) = self.find_adapter(&request.adapter_id) else {
            return AppUseAuthorizeActResponse {
                permit: None,
                expires_in_ms: 0,
            };
        };
        if !Self::adapter_supports_action(adapter, &request.action) {
            return AppUseAuthorizeActResponse {
                permit: None,
                expires_in_ms: 0,
            };
        }
        if adapter.validate_act(&request).is_err() {
            return AppUseAuthorizeActResponse {
                permit: None,
                expires_in_ms: 0,
            };
        }

        AppUseAuthorizeActResponse {
            permit: Some(self.issue_permit(&request)),
            expires_in_ms: APP_USE_PERMIT_TTL.as_millis() as u64,
        }
    }

    pub fn act(&self, mut request: AppUseActRequest) -> AppUseActResponse {
        request.config = self.normalize_config(request.config);
        if request.config.is_read_only() {
            return AppUseActResponse {
                ok: false,
                adapter_id: request.adapter_id,
                action: request.action,
                receipt:
                    "App Use is in read-only mode; enable interactive mode before running actions."
                        .to_string(),
                changed: false,
                metadata: json!({
                    "executionId": request.execution_id,
                    "reason": "read_only",
                }),
            };
        }

        if !request.config.adapter_enabled(&request.adapter_id) {
            return AppUseActResponse {
                ok: false,
                adapter_id: request.adapter_id,
                action: request.action,
                receipt:
                    "App Use adapter is disabled. Enable it in Settings > App Use before acting."
                        .to_string(),
                changed: false,
                metadata: json!({
                    "executionId": request.execution_id,
                    "reason": "adapter_disabled",
                }),
            };
        }

        if !self.advanced_act_enabled(&request) {
            return AppUseActResponse {
                ok: false,
                adapter_id: request.adapter_id,
                action: request.action,
                receipt: "This App Use workflow is planned for a later phase and is not available."
                    .to_string(),
                changed: false,
                metadata: json!({
                    "executionId": request.execution_id,
                    "reason": "workflow_not_available",
                }),
            };
        }

        if !self.consume_valid_permit(&request) {
            return AppUseActResponse {
                ok: false,
                adapter_id: request.adapter_id,
                action: request.action,
                receipt: "App Use action requires a fresh user-approved native permit.".to_string(),
                changed: false,
                metadata: json!({
                    "executionId": request.execution_id,
                    "reason": "approval_required",
                }),
            };
        }

        self.find_adapter(&request.adapter_id)
            .map(|adapter| {
                if !Self::adapter_supports_action(adapter, &request.action) {
                    return AppUseActResponse {
                        ok: false,
                        adapter_id: request.adapter_id.clone(),
                        action: request.action.clone(),
                        receipt: format!(
                            "App Use adapter does not declare support for action {}.",
                            request.action
                        ),
                        changed: false,
                        metadata: json!({
                            "executionId": request.execution_id,
                            "reason": "unsupported_action",
                        }),
                    };
                }

                adapter.act(&request)
            })
            .unwrap_or_else(|| AppUseActResponse {
                ok: false,
                adapter_id: request.adapter_id,
                action: request.action,
                receipt: "Unknown App Use adapter.".to_string(),
                changed: false,
                metadata: json!({
                    "executionId": request.execution_id,
                    "reason": "adapter_unknown",
                }),
            })
    }
}

fn hash_parameters(parameters: Option<&serde_json::Value>) -> String {
    let canonical = parameters
        .map(|value| serde_json::to_string(value).unwrap_or_default())
        .unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OwnedTargetFamily {
    Office,
    Wps,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OwnedTargetKind {
    Document,
    Spreadsheet,
    Presentation,
}

impl OwnedTargetKind {
    fn extension(self) -> &'static str {
        match self {
            OwnedTargetKind::Document => "docx",
            OwnedTargetKind::Spreadsheet => "xlsx",
            OwnedTargetKind::Presentation => "pptx",
        }
    }
}

impl std::fmt::Display for OwnedTargetKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OwnedTargetKind::Document => formatter.write_str("document"),
            OwnedTargetKind::Spreadsheet => formatter.write_str("spreadsheet"),
            OwnedTargetKind::Presentation => formatter.write_str("presentation"),
        }
    }
}

struct OwnedTargetSpec {
    family: OwnedTargetFamily,
    kind: OwnedTargetKind,
    adapter_id: &'static str,
    app_label: &'static str,
    root: PathBuf,
}

impl OwnedTargetSpec {
    fn from_request(adapter_id: &str, target_kind: Option<&str>) -> Result<Self, String> {
        let spec = match adapter_id {
            "office_word" => Self {
                family: OwnedTargetFamily::Office,
                kind: OwnedTargetKind::Document,
                adapter_id: "office_word",
                app_label: "Microsoft Word",
                root: office::owned_office_target_root_path(),
            },
            "office_excel" => Self {
                family: OwnedTargetFamily::Office,
                kind: OwnedTargetKind::Spreadsheet,
                adapter_id: "office_excel",
                app_label: "Microsoft Excel",
                root: office::owned_office_target_root_path(),
            },
            "office_powerpoint" => Self {
                family: OwnedTargetFamily::Office,
                kind: OwnedTargetKind::Presentation,
                adapter_id: "office_powerpoint",
                app_label: "Microsoft PowerPoint",
                root: office::owned_office_target_root_path(),
            },
            "wps_writer" => Self {
                family: OwnedTargetFamily::Wps,
                kind: OwnedTargetKind::Document,
                adapter_id: "wps_writer",
                app_label: "WPS Writer",
                root: wps::owned_wps_target_root_path(),
            },
            "wps_spreadsheet" => Self {
                family: OwnedTargetFamily::Wps,
                kind: OwnedTargetKind::Spreadsheet,
                adapter_id: "wps_spreadsheet",
                app_label: "WPS Spreadsheet",
                root: wps::owned_wps_target_root_path(),
            },
            "wps_presentation" => Self {
                family: OwnedTargetFamily::Wps,
                kind: OwnedTargetKind::Presentation,
                adapter_id: "wps_presentation",
                app_label: "WPS Presentation",
                root: wps::owned_wps_target_root_path(),
            },
            _ => {
                return Err(
                    "create_owned_target supports only Office and WPS App Use write adapters."
                        .to_string(),
                )
            }
        };

        if let Some(target_kind) = target_kind.map(str::trim).filter(|value| !value.is_empty()) {
            if target_kind != spec.kind.to_string() {
                return Err(format!(
                    "{} creates {} targets, not {target_kind} targets.",
                    spec.adapter_id, spec.kind
                ));
            }
        }

        Ok(spec)
    }
}

fn create_owned_target_file(spec: &OwnedTargetSpec) -> Result<PathBuf, String> {
    fs::create_dir_all(&spec.root)
        .map_err(|error| format!("App Use owned target root is unavailable: {error}"))?;
    ensure_owned_target_root_is_plain_directory(&spec.root)?;
    let target_path = unique_owned_target_path(spec);
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target_path)
        .map_err(|error| format!("App Use owned target could not be created: {error}"))?;
    let result = match spec.kind {
        OwnedTargetKind::Document => write_minimal_docx(file),
        OwnedTargetKind::Spreadsheet => write_minimal_xlsx(file),
        OwnedTargetKind::Presentation => write_minimal_pptx(file),
    };
    if let Err(error) = result {
        let _ = fs::remove_file(&target_path);
        return Err(error);
    }
    Ok(target_path)
}

fn ensure_owned_target_root_is_plain_directory(root: &Path) -> Result<(), String> {
    ensure_path_chain_not_reparse(root, "target root")?;
    root.canonicalize()
        .map_err(|error| format!("App Use owned target root is unavailable: {error}"))?;
    Ok(())
}

fn ensure_path_chain_not_reparse(path: &Path, label: &str) -> Result<(), String> {
    for candidate in path.ancestors() {
        if candidate.as_os_str().is_empty() || !candidate.exists() {
            continue;
        }
        if is_path_symlink(candidate) || has_windows_reparse_point(candidate) {
            return Err(format!(
                "App Use owned {label} path must not include a symlink or reparse point."
            ));
        }
    }
    Ok(())
}

fn is_path_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
}

#[cfg(windows)]
fn has_windows_reparse_point(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn has_windows_reparse_point(_path: &Path) -> bool {
    false
}

fn unique_owned_target_path(spec: &OwnedTargetSpec) -> PathBuf {
    let name = format!(
        "touchai-{}-{}.{}",
        spec.kind,
        uuid::Uuid::new_v4(),
        spec.kind.extension()
    );
    spec.root.join(name)
}

fn write_zip_entries(file: File, entries: &[(&str, &str)]) -> Result<(), String> {
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let mut zip = ZipWriter::new(file);
    for (path, contents) in entries {
        zip.start_file(path, options)
            .map_err(|error| format!("App Use owned target package is invalid: {error}"))?;
        zip.write_all(contents.as_bytes()).map_err(|error| {
            format!("App Use owned target package could not be written: {error}")
        })?;
    }
    zip.finish()
        .map_err(|error| format!("App Use owned target package could not be finalized: {error}"))?;
    Ok(())
}

fn write_minimal_docx(file: File) -> Result<(), String> {
    write_zip_entries(
        file,
        &[
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
            ),
            (
                "word/document.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:sectPr/></w:body></w:document>"#,
            ),
        ],
    )
}

fn write_minimal_xlsx(file: File) -> Result<(), String> {
    write_zip_entries(
        file,
        &[
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>"#,
            ),
        ],
    )
}

fn write_minimal_pptx(file: File) -> Result<(), String> {
    write_zip_entries(
        file,
        &[
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>"#,
            ),
            (
                "ppt/presentation.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/></p:presentation>"#,
            ),
            (
                "ppt/_rels/presentation.xml.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>"#,
            ),
            (
                "ppt/slides/slide1.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sld>"#,
            ),
        ],
    )
}

impl Default for AppUseRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use types::{AppUseAdvancedConfig, AppUseConfig, AppUseObserveRequest, AppUseSessionRequest};

    struct MockAdapter;

    impl AppUseAdapter for MockAdapter {
        fn id(&self) -> &'static str {
            "mock_app"
        }

        fn label(&self) -> &'static str {
            "Mock App"
        }

        fn capabilities(&self) -> &'static [&'static str] {
            &["observe_selection", "replace_document_text"]
        }

        fn vendor(&self) -> &'static str {
            "test-extension"
        }

        fn contract_version(&self) -> &'static str {
            "mock-contract-v1"
        }

        fn observe_scopes(&self) -> &'static [&'static str] {
            &["selection"]
        }

        fn actions(&self) -> &'static [&'static str] {
            &[
                "replace_document_text",
                "export_preview",
                "batch_export",
                "cross_app_transfer",
            ]
        }

        fn installed(&self) -> bool {
            true
        }

        fn running(&self) -> bool {
            true
        }

        fn active_target_name(&self) -> Option<String> {
            Some("Mock Document".to_string())
        }

        fn observe(&self, request: &AppUseObserveRequest) -> AppUseObserveResponse {
            AppUseObserveResponse {
                ok: true,
                adapter_id: request.adapter_id.clone(),
                scope: request.scope.clone(),
                target: request.target_id.clone(),
                content: Some("mock observation".to_string()),
                metadata: json!({ "adapter": self.id() }),
                truncated: false,
            }
        }

        fn validate_act(&self, _request: &AppUseAuthorizeActRequest) -> Result<(), String> {
            Ok(())
        }

        fn act(&self, request: &AppUseActRequest) -> AppUseActResponse {
            AppUseActResponse {
                ok: true,
                adapter_id: request.adapter_id.clone(),
                action: request.action.clone(),
                receipt: "mock action applied".to_string(),
                changed: true,
                metadata: json!({ "adapter": self.id() }),
            }
        }
    }

    fn enabled_config(mode: &str) -> AppUseConfig {
        AppUseConfig {
            mode: mode.to_string(),
            adapters: HashMap::from([("mock_app".to_string(), true)]),
            mutating_approval_mode: "always".to_string(),
            read_scope: "active".to_string(),
            allow_background_operation: false,
            allow_raw_automation: false,
            timeout_ms: 15_000,
            max_output_chars: 12_000,
            advanced: AppUseAdvancedConfig::default(),
        }
    }

    fn default_runtime_config(mode: &str, enabled_adapter: &str) -> AppUseConfig {
        let mut adapters = HashMap::from([
            ("office_word".to_string(), false),
            ("office_excel".to_string(), false),
            ("office_powerpoint".to_string(), false),
            ("wps_writer".to_string(), false),
            ("wps_spreadsheet".to_string(), false),
            ("wps_presentation".to_string(), false),
            ("photoshop".to_string(), false),
            ("illustrator".to_string(), false),
        ]);
        adapters.insert(enabled_adapter.to_string(), true);

        AppUseConfig {
            mode: mode.to_string(),
            adapters,
            mutating_approval_mode: "always".to_string(),
            read_scope: "active".to_string(),
            allow_background_operation: false,
            allow_raw_automation: false,
            timeout_ms: 15_000,
            max_output_chars: 12_000,
            advanced: AppUseAdvancedConfig::default(),
        }
    }

    fn session_request(
        operation: &str,
        adapter_id: Option<&str>,
        target_kind: Option<&str>,
        config: AppUseConfig,
    ) -> AppUseSessionRequest {
        AppUseSessionRequest {
            execution_id: "runtime-session-test".to_string(),
            operation: operation.to_string(),
            description: "run App Use session operation".to_string(),
            adapter_id: adapter_id.map(str::to_string),
            target_kind: target_kind.map(str::to_string),
            config,
        }
    }

    #[test]
    fn session_reports_state_from_registered_adapters() {
        let runtime = AppUseRuntime::with_adapters(vec![Box::new(MockAdapter)]);

        let response = runtime.session(AppUseSessionRequest {
            execution_id: "adapter-test-1".to_string(),
            operation: "discover".to_string(),
            description: "discover mock app".to_string(),
            adapter_id: None,
            target_kind: None,
            config: enabled_config("read_only"),
        });

        assert_eq!(response.ok, true, "{:?}", response.message);
        assert_eq!(response.adapters.len(), 1);
        assert_eq!(response.adapters[0].id, "mock_app");
        assert_eq!(response.adapters[0].label, "Mock App");
        assert_eq!(response.adapters[0].installed, true);
        assert_eq!(response.adapters[0].running, true);
        assert_eq!(response.adapters[0].enabled, true);
        assert_eq!(
            response.adapters[0].active_target_name.as_deref(),
            Some("Mock Document")
        );
        assert_eq!(response.adapters[0].contract.vendor, "test-extension");
        assert_eq!(response.adapters[0].contract.version, "mock-contract-v1");
        assert_eq!(
            response.adapters[0].contract.observe_scopes,
            vec!["selection"]
        );
        assert!(response.adapters[0]
            .contract
            .actions
            .contains(&"replace_document_text".to_string()));
        assert_eq!(response.adapters[0].contract.raw_automation_allowed, false);
    }

    #[test]
    fn create_owned_target_returns_signed_wps_target_and_marker() {
        let runtime = AppUseRuntime::new();
        let response = runtime.session(session_request(
            APP_USE_CREATE_TARGET_OPERATION,
            Some("wps_spreadsheet"),
            Some("spreadsheet"),
            default_runtime_config("interactive", "wps_spreadsheet"),
        ));

        assert_eq!(response.ok, true);
        assert_eq!(response.adapter_id.as_deref(), Some("wps_spreadsheet"));
        assert_eq!(response.target_kind.as_deref(), Some("spreadsheet"));
        let target = response.target.expect("owned target");
        assert!(target.ends_with(".xlsx"));
        let target_path = PathBuf::from(&target);
        assert!(target_path.exists());
        let marker_path = target_path.with_file_name(format!(
            "{}.touchai-owned.json",
            target_path
                .file_name()
                .and_then(|value| value.to_str())
                .expect("target filename")
        ));
        let marker = std::fs::read_to_string(&marker_path).expect("owned marker");
        assert!(marker.contains("\"signature\""));
        let _ = std::fs::remove_file(&target);
        let _ = std::fs::remove_file(marker_path);
    }

    #[test]
    fn create_owned_target_rejects_disabled_adapter_and_wrong_kind() {
        let runtime = AppUseRuntime::new();
        let disabled = runtime.session(session_request(
            APP_USE_CREATE_TARGET_OPERATION,
            Some("wps_spreadsheet"),
            Some("spreadsheet"),
            default_runtime_config("interactive", "wps_writer"),
        ));
        assert_eq!(disabled.ok, false);
        assert!(disabled.message.unwrap_or_default().contains("disabled"));

        let wrong_kind = runtime.session(session_request(
            APP_USE_CREATE_TARGET_OPERATION,
            Some("wps_spreadsheet"),
            Some("document"),
            default_runtime_config("interactive", "wps_spreadsheet"),
        ));
        assert_eq!(wrong_kind.ok, false);
        assert!(wrong_kind
            .message
            .unwrap_or_default()
            .contains("spreadsheet"));
    }

    #[test]
    fn authorization_requires_adapter_declared_action_contract() {
        struct PermissiveUndeclaredAdapter;

        impl AppUseAdapter for PermissiveUndeclaredAdapter {
            fn id(&self) -> &'static str {
                "permissive_extension"
            }

            fn label(&self) -> &'static str {
                "Permissive Extension"
            }

            fn capabilities(&self) -> &'static [&'static str] {
                &["observe_selection", "replace_document_text"]
            }

            fn installed(&self) -> bool {
                true
            }

            fn validate_act(&self, _request: &AppUseAuthorizeActRequest) -> Result<(), String> {
                Ok(())
            }
        }

        let runtime = AppUseRuntime::with_adapters(vec![Box::new(PermissiveUndeclaredAdapter)]);
        let config = AppUseConfig {
            mode: "interactive".to_string(),
            adapters: HashMap::from([("permissive_extension".to_string(), true)]),
            mutating_approval_mode: "always".to_string(),
            read_scope: "active".to_string(),
            allow_background_operation: false,
            allow_raw_automation: false,
            timeout_ms: 15_000,
            max_output_chars: 12_000,
            advanced: AppUseAdvancedConfig::default(),
        };

        let authorization = runtime.authorize_act(AppUseAuthorizeActRequest {
            execution_id: "contract-undeclared-action".to_string(),
            adapter_id: "permissive_extension".to_string(),
            action: "replace_document_text".to_string(),
            target_id: Some("target-1".to_string()),
            parameters: Some(json!({ "text": "hello" })),
            config,
        });

        assert_eq!(authorization.permit, None);
        assert_eq!(authorization.expires_in_ms, 0);
    }

    #[test]
    fn default_runtime_refuses_invalid_wps_spreadsheet_authorization() {
        let runtime = AppUseRuntime::new();
        let authorization = runtime.authorize_act(AppUseAuthorizeActRequest {
            execution_id: "runtime-wps-sheet-1".to_string(),
            adapter_id: "wps_spreadsheet".to_string(),
            action: "write_cells".to_string(),
            target_id: Some("not-owned.xlsx".to_string()),
            parameters: Some(json!({ "range": "A1", "values": [] })),
            config: default_runtime_config("interactive", "wps_spreadsheet"),
        });

        assert_eq!(authorization.permit, None);
        assert_eq!(authorization.expires_in_ms, 0);
    }

    #[test]
    fn default_runtime_refuses_invalid_wps_presentation_authorization() {
        let runtime = AppUseRuntime::new();
        let authorization = runtime.authorize_act(AppUseAuthorizeActRequest {
            execution_id: "runtime-wps-presentation-1".to_string(),
            adapter_id: "wps_presentation".to_string(),
            action: "add_slide_text".to_string(),
            target_id: Some("not-owned.pptx".to_string()),
            parameters: Some(json!({ "text": "" })),
            config: default_runtime_config("interactive", "wps_presentation"),
        });

        assert_eq!(authorization.permit, None);
        assert_eq!(authorization.expires_in_ms, 0);
    }

    #[test]
    fn default_runtime_refuses_adobe_action_authorization() {
        let runtime = AppUseRuntime::new();
        let authorization = runtime.authorize_act(AppUseAuthorizeActRequest {
            execution_id: "runtime-adobe-1".to_string(),
            adapter_id: "photoshop".to_string(),
            action: "export_preview".to_string(),
            target_id: None,
            parameters: None,
            config: default_runtime_config("interactive", "photoshop"),
        });

        assert_eq!(authorization.permit, None);
        assert_eq!(authorization.expires_in_ms, 0);
    }

    #[test]
    fn default_runtime_refuses_future_workflow_actions() {
        let runtime = AppUseRuntime::with_adapters(vec![Box::new(MockAdapter)]);

        let export_authorization = runtime.authorize_act(AppUseAuthorizeActRequest {
            execution_id: "runtime-advanced-export".to_string(),
            adapter_id: "mock_app".to_string(),
            action: "export_preview".to_string(),
            target_id: Some("target-1".to_string()),
            parameters: None,
            config: enabled_config("interactive"),
        });
        assert_eq!(export_authorization.permit, None);

        let batch_authorization = runtime.authorize_act(AppUseAuthorizeActRequest {
            execution_id: "runtime-advanced-batch".to_string(),
            adapter_id: "mock_app".to_string(),
            action: "batch_export".to_string(),
            target_id: Some("target-1".to_string()),
            parameters: None,
            config: enabled_config("interactive"),
        });
        assert_eq!(batch_authorization.permit, None);

        let cross_app_authorization = runtime.authorize_act(AppUseAuthorizeActRequest {
            execution_id: "runtime-advanced-cross-app".to_string(),
            adapter_id: "mock_app".to_string(),
            action: "cross_app_transfer".to_string(),
            target_id: Some("target-1".to_string()),
            parameters: None,
            config: enabled_config("interactive"),
        });
        assert_eq!(cross_app_authorization.permit, None);
    }

    #[test]
    fn default_runtime_ignores_legacy_future_workflow_config() {
        let runtime = AppUseRuntime::with_adapters(vec![Box::new(MockAdapter)]);
        let mut config = enabled_config("interactive");
        config.advanced = AppUseAdvancedConfig {
            export_previews: true,
            batch_workflows: true,
            cross_app_workflows: true,
        };

        let authorization = runtime.authorize_act(AppUseAuthorizeActRequest {
            execution_id: "runtime-advanced-enabled".to_string(),
            adapter_id: "mock_app".to_string(),
            action: "cross_app_transfer".to_string(),
            target_id: Some("target-1".to_string()),
            parameters: None,
            config,
        });

        assert_eq!(authorization.permit, None);
        assert_eq!(authorization.expires_in_ms, 0);
    }

    #[test]
    fn default_runtime_refuses_office_action_without_owned_target() {
        let runtime = AppUseRuntime::new();
        let authorization = runtime.authorize_act(AppUseAuthorizeActRequest {
            execution_id: "runtime-office-1".to_string(),
            adapter_id: "office_word".to_string(),
            action: "replace_document_text".to_string(),
            target_id: None,
            parameters: Some(json!({ "text": "hello" })),
            config: default_runtime_config("interactive", "office_word"),
        });

        assert_eq!(authorization.permit, None);
        assert_eq!(authorization.expires_in_ms, 0);
    }

    #[test]
    fn default_runtime_refuses_non_owned_wps_authorization() {
        let runtime = AppUseRuntime::new();
        let authorization = runtime.authorize_act(AppUseAuthorizeActRequest {
            execution_id: "runtime-wps-unowned-1".to_string(),
            adapter_id: "wps_writer".to_string(),
            action: "replace_document_text".to_string(),
            target_id: Some("target-1".to_string()),
            parameters: Some(json!({ "text": "hello" })),
            config: default_runtime_config("interactive", "wps_writer"),
        });

        assert_eq!(authorization.permit, None);
        assert_eq!(authorization.expires_in_ms, 0);
    }

    #[test]
    fn default_runtime_adobe_future_actions_stay_unavailable_before_approval() {
        let runtime = AppUseRuntime::new();
        let response = runtime.act(AppUseActRequest {
            execution_id: "runtime-adobe-1".to_string(),
            adapter_id: "photoshop".to_string(),
            action: "export_preview".to_string(),
            description: "try Photoshop export preview".to_string(),
            target_id: None,
            parameters: None,
            permit: None,
            config: default_runtime_config("interactive", "photoshop"),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert_eq!(response.metadata["reason"], "workflow_not_available");
    }

    #[test]
    fn default_runtime_adobe_descriptors_expose_only_read_only_capabilities() {
        let runtime = AppUseRuntime::new();
        let response = runtime.session(AppUseSessionRequest {
            execution_id: "runtime-adobe-session".to_string(),
            operation: "capabilities".to_string(),
            description: "inspect Adobe capabilities".to_string(),
            adapter_id: None,
            target_kind: None,
            config: default_runtime_config("read_only", "photoshop"),
        });

        let photoshop = response
            .adapters
            .iter()
            .find(|adapter| adapter.id == "photoshop")
            .expect("photoshop descriptor");
        let illustrator = response
            .adapters
            .iter()
            .find(|adapter| adapter.id == "illustrator")
            .expect("illustrator descriptor");

        assert_eq!(photoshop.capabilities, vec!["discover", "observe_layers"]);
        assert_eq!(
            illustrator.capabilities,
            vec!["discover", "observe_artboards"]
        );
    }

    #[test]
    fn default_runtime_spreadsheet_descriptors_keep_cell_reads_observe_only() {
        let runtime = AppUseRuntime::new();
        let response = runtime.session(AppUseSessionRequest {
            execution_id: "runtime-spreadsheet-session".to_string(),
            operation: "capabilities".to_string(),
            description: "inspect spreadsheet capabilities".to_string(),
            adapter_id: None,
            target_kind: None,
            config: default_runtime_config("read_only", "office_excel"),
        });

        for adapter_id in ["office_excel", "wps_spreadsheet"] {
            let adapter = response
                .adapters
                .iter()
                .find(|adapter| adapter.id == adapter_id)
                .expect("spreadsheet descriptor");

            assert!(adapter
                .capabilities
                .contains(&"observe_worksheet".to_string()));
            assert!(!adapter.capabilities.contains(&"read_cells".to_string()));
            assert_eq!(adapter.contract.actions, vec!["write_cells"]);
        }
    }

    #[test]
    fn observe_delegates_to_enabled_adapter() {
        let runtime = AppUseRuntime::with_adapters(vec![Box::new(MockAdapter)]);

        let response = runtime.observe(AppUseObserveRequest {
            execution_id: "adapter-test-2".to_string(),
            adapter_id: "mock_app".to_string(),
            scope: "selection".to_string(),
            description: "read mock selection".to_string(),
            target_id: Some("target-1".to_string()),
            max_output_chars: 12_000,
            config: enabled_config("read_only"),
        });

        assert_eq!(response.ok, true);
        assert_eq!(response.content.as_deref(), Some("mock observation"));
        assert_eq!(response.metadata["adapter"], "mock_app");
    }

    #[test]
    fn observe_requires_adapter_declared_scope_contract() {
        let runtime = AppUseRuntime::with_adapters(vec![Box::new(MockAdapter)]);

        let response = runtime.observe(AppUseObserveRequest {
            execution_id: "adapter-test-undeclared-scope".to_string(),
            adapter_id: "mock_app".to_string(),
            scope: "workbook".to_string(),
            description: "read unsupported scope".to_string(),
            target_id: Some("target-1".to_string()),
            max_output_chars: 12_000,
            config: enabled_config("read_only"),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.metadata["reason"], "unsupported_scope");
    }

    #[test]
    fn act_rejects_forged_approval_payload_in_interactive_mode() {
        let runtime = AppUseRuntime::with_adapters(vec![Box::new(MockAdapter)]);

        let response = runtime.act(AppUseActRequest {
            execution_id: "adapter-test-3".to_string(),
            adapter_id: "mock_app".to_string(),
            action: "replace_document_text".to_string(),
            description: "replace mock selection".to_string(),
            target_id: Some("target-1".to_string()),
            parameters: Some(json!({ "text": "hello" })),
            permit: Some(types::AppUseActPermit {
                call_id: "adapter-test-3".to_string(),
                adapter_id: "mock_app".to_string(),
                action: "replace_document_text".to_string(),
                target_id: Some("target-1".to_string()),
                parameters_hash: "forged".to_string(),
                token: "forged".to_string(),
            }),
            config: enabled_config("interactive"),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert_eq!(response.metadata["reason"], "approval_required");
    }

    #[test]
    fn act_consumes_runtime_authorized_permit_once() {
        let runtime = AppUseRuntime::with_adapters(vec![Box::new(MockAdapter)]);
        let parameters = json!({ "text": "hello" });
        let authorization = runtime.authorize_act(AppUseAuthorizeActRequest {
            execution_id: "adapter-test-3".to_string(),
            adapter_id: "mock_app".to_string(),
            action: "replace_document_text".to_string(),
            target_id: Some("target-1".to_string()),
            parameters: Some(parameters.clone()),
            config: enabled_config("interactive"),
        });
        let permit = authorization.permit.expect("permit");

        let response = runtime.act(AppUseActRequest {
            execution_id: "adapter-test-3".to_string(),
            adapter_id: "mock_app".to_string(),
            action: "replace_document_text".to_string(),
            description: "replace mock selection".to_string(),
            target_id: Some("target-1".to_string()),
            parameters: Some(parameters.clone()),
            permit: Some(permit.clone()),
            config: enabled_config("interactive"),
        });

        assert_eq!(response.ok, true);
        assert_eq!(response.changed, true);
        assert_eq!(response.receipt, "mock action applied");
        assert_eq!(response.metadata["adapter"], "mock_app");

        let replay = runtime.act(AppUseActRequest {
            execution_id: "adapter-test-3".to_string(),
            adapter_id: "mock_app".to_string(),
            action: "replace_document_text".to_string(),
            description: "replace mock selection again".to_string(),
            target_id: Some("target-1".to_string()),
            parameters: Some(parameters),
            permit: Some(permit),
            config: enabled_config("interactive"),
        });

        assert_eq!(replay.ok, false);
        assert_eq!(replay.changed, false);
        assert_eq!(replay.metadata["reason"], "approval_required");
    }

    #[test]
    fn act_rejects_interactive_request_without_approval_capability() {
        let runtime = AppUseRuntime::with_adapters(vec![Box::new(MockAdapter)]);

        let response = runtime.act(AppUseActRequest {
            execution_id: "adapter-test-4".to_string(),
            adapter_id: "mock_app".to_string(),
            action: "replace_document_text".to_string(),
            description: "replace mock selection".to_string(),
            target_id: None,
            parameters: Some(json!({ "text": "hello" })),
            permit: None,
            config: enabled_config("interactive"),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert_eq!(response.metadata["reason"], "approval_required");
    }

    #[test]
    fn act_normalizes_invalid_native_config_to_read_only() {
        let runtime = AppUseRuntime::with_adapters(vec![Box::new(MockAdapter)]);
        let mut config = enabled_config("full_auto");
        config.allow_raw_automation = true;
        config.timeout_ms = 10;
        config.max_output_chars = 500_000;

        let response = runtime.act(AppUseActRequest {
            execution_id: "adapter-test-5".to_string(),
            adapter_id: "mock_app".to_string(),
            action: "replace_document_text".to_string(),
            description: "replace mock selection".to_string(),
            target_id: None,
            parameters: Some(json!({ "text": "hello" })),
            permit: Some(types::AppUseActPermit {
                call_id: "adapter-test-5".to_string(),
                adapter_id: "mock_app".to_string(),
                action: "replace_document_text".to_string(),
                target_id: None,
                parameters_hash: "forged".to_string(),
                token: "forged".to_string(),
            }),
            config,
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert_eq!(response.metadata["reason"], "read_only");
    }
}
