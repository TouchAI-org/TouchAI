// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

pub mod discovery;
pub mod types;
pub mod wps;

use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
pub use types::{
    AppUseActPermit, AppUseActRequest, AppUseActResponse, AppUseAdapterDescriptor,
    AppUseAuthorizeActRequest, AppUseAuthorizeActResponse, AppUseObserveRequest,
    AppUseObserveResponse, AppUseSessionRequest, AppUseSessionResponse,
};

const APP_USE_PERMIT_TTL: Duration = Duration::from_secs(30);

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
            "insert_text",
            "replace_selection",
            "format_selection",
        ],
    },
    AppUseAdapterDefinition {
        id: "office_excel",
        label: "Microsoft Excel",
        capabilities: &[
            "discover",
            "observe_workbook",
            "observe_worksheet",
            "read_cells",
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
            "insert_text",
            "replace_selection",
            "format_selection",
        ],
    },
    AppUseAdapterDefinition {
        id: "wps_spreadsheet",
        label: "WPS Spreadsheet",
        capabilities: &[
            "discover",
            "observe_workbook",
            "observe_worksheet",
            "read_cells",
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
        capabilities: &[
            "discover",
            "observe_layers",
            "select_layer",
            "export_preview",
            "batch_export",
        ],
    },
    AppUseAdapterDefinition {
        id: "illustrator",
        label: "Adobe Illustrator",
        capabilities: &[
            "discover",
            "observe_artboards",
            "select_layer",
            "export_preview",
            "batch_export",
        ],
    },
];

pub trait AppUseAdapter: Send + Sync {
    fn id(&self) -> &'static str;

    fn label(&self) -> &'static str;

    fn capabilities(&self) -> &'static [&'static str];

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
                .map(|definition| {
                    if definition.id == "wps_writer" {
                        Box::new(wps::WpsWriterAdapter::new()) as Box<dyn AppUseAdapter>
                    } else {
                        Box::new(StaticAppUseAdapter { definition }) as Box<dyn AppUseAdapter>
                    }
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

    fn normalize_config(&self, mut config: types::AppUseConfig) -> types::AppUseConfig {
        if config.mode != "interactive" {
            config.mode = "read_only".to_string();
        }
        config.mutating_approval_mode = "always".to_string();
        config.read_scope = "active".to_string();
        config.allow_raw_automation = false;
        config.timeout_ms = match config.timeout_ms {
            1_000..=120_000 => config.timeout_ms,
            _ => 15_000,
        };
        config.max_output_chars = match config.max_output_chars {
            1_000..=50_000 => config.max_output_chars,
            _ => 12_000,
        };
        config
            .adapters
            .retain(|adapter_id, _| self.find_adapter(adapter_id).is_some());
        config
    }

    fn cleanup_expired_permits(&self, now: Instant) {
        let mut permits = self.act_permits.lock().expect("app use permits");
        permits.retain(|_, record| record.expires_at > now);
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
                active_target_name: adapter.active_target_name(),
            })
            .collect();

        AppUseSessionResponse {
            ok: true,
            operation: request.operation,
            adapters,
            message: None,
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
            .map(|adapter| adapter.observe(&request))
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
            .map(|adapter| adapter.act(&request))
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
    use types::{AppUseConfig, AppUseObserveRequest, AppUseSessionRequest};

    struct MockAdapter;

    impl AppUseAdapter for MockAdapter {
        fn id(&self) -> &'static str {
            "mock_app"
        }

        fn label(&self) -> &'static str {
            "Mock App"
        }

        fn capabilities(&self) -> &'static [&'static str] {
            &["observe_selection", "replace_selection"]
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
        }
    }

    #[test]
    fn session_reports_state_from_registered_adapters() {
        let runtime = AppUseRuntime::with_adapters(vec![Box::new(MockAdapter)]);

        let response = runtime.session(AppUseSessionRequest {
            execution_id: "adapter-test-1".to_string(),
            operation: "discover".to_string(),
            description: "discover mock app".to_string(),
            config: enabled_config("read_only"),
        });

        assert_eq!(response.ok, true);
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
    fn act_rejects_forged_approval_payload_in_interactive_mode() {
        let runtime = AppUseRuntime::with_adapters(vec![Box::new(MockAdapter)]);

        let response = runtime.act(AppUseActRequest {
            execution_id: "adapter-test-3".to_string(),
            adapter_id: "mock_app".to_string(),
            action: "replace_selection".to_string(),
            description: "replace mock selection".to_string(),
            target_id: Some("target-1".to_string()),
            parameters: Some(json!({ "text": "hello" })),
            permit: Some(types::AppUseActPermit {
                call_id: "adapter-test-3".to_string(),
                adapter_id: "mock_app".to_string(),
                action: "replace_selection".to_string(),
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
            action: "replace_selection".to_string(),
            target_id: Some("target-1".to_string()),
            parameters: Some(parameters.clone()),
            config: enabled_config("interactive"),
        });
        let permit = authorization.permit.expect("permit");

        let response = runtime.act(AppUseActRequest {
            execution_id: "adapter-test-3".to_string(),
            adapter_id: "mock_app".to_string(),
            action: "replace_selection".to_string(),
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
            action: "replace_selection".to_string(),
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
            action: "replace_selection".to_string(),
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
            action: "replace_selection".to_string(),
            description: "replace mock selection".to_string(),
            target_id: None,
            parameters: Some(json!({ "text": "hello" })),
            permit: Some(types::AppUseActPermit {
                call_id: "adapter-test-5".to_string(),
                adapter_id: "mock_app".to_string(),
                action: "replace_selection".to_string(),
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
