// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

fn default_mode() -> String {
    "read_only".to_string()
}

fn default_mutating_approval_mode() -> String {
    "always".to_string()
}

fn default_read_scope() -> String {
    "active".to_string()
}

fn default_timeout_ms() -> u64 {
    15_000
}

fn default_max_output_chars() -> usize {
    12_000
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUseConfig {
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default)]
    pub adapters: HashMap<String, bool>,
    #[serde(default = "default_mutating_approval_mode")]
    pub mutating_approval_mode: String,
    #[serde(default = "default_read_scope")]
    pub read_scope: String,
    #[serde(default)]
    pub allow_background_operation: bool,
    #[serde(default)]
    pub allow_raw_automation: bool,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_max_output_chars")]
    pub max_output_chars: usize,
}

impl AppUseConfig {
    pub fn adapter_enabled(&self, adapter_id: &str) -> bool {
        self.adapters.get(adapter_id).copied().unwrap_or(false)
    }

    pub fn is_read_only(&self) -> bool {
        self.mode == "read_only"
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUseActPermit {
    pub call_id: String,
    pub adapter_id: String,
    pub action: String,
    pub target_id: Option<String>,
    pub parameters_hash: String,
    pub token: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppUseAuthorizeActRequest {
    pub execution_id: String,
    pub adapter_id: String,
    pub action: String,
    pub target_id: Option<String>,
    #[serde(default)]
    pub parameters: Option<Value>,
    pub config: AppUseConfig,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUseAuthorizeActResponse {
    pub permit: Option<AppUseActPermit>,
    pub expires_in_ms: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUseSessionRequest {
    pub execution_id: String,
    pub operation: String,
    pub description: String,
    pub config: AppUseConfig,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUseObserveRequest {
    pub execution_id: String,
    pub adapter_id: String,
    pub scope: String,
    pub description: String,
    #[serde(default)]
    pub target_id: Option<String>,
    pub max_output_chars: usize,
    pub config: AppUseConfig,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppUseActRequest {
    pub execution_id: String,
    pub adapter_id: String,
    pub action: String,
    pub description: String,
    #[serde(default)]
    pub target_id: Option<String>,
    #[serde(default)]
    pub parameters: Option<Value>,
    #[serde(default)]
    pub permit: Option<AppUseActPermit>,
    pub config: AppUseConfig,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUseAdapterDescriptor {
    pub id: String,
    pub label: String,
    pub installed: bool,
    pub running: bool,
    pub enabled: bool,
    pub capabilities: Vec<String>,
    pub active_target_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUseSessionResponse {
    pub ok: bool,
    pub operation: String,
    pub adapters: Vec<AppUseAdapterDescriptor>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppUseObserveResponse {
    pub ok: bool,
    pub adapter_id: String,
    pub scope: String,
    pub target: Option<String>,
    pub content: Option<String>,
    pub metadata: Value,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppUseActResponse {
    pub ok: bool,
    pub adapter_id: String,
    pub action: String,
    pub receipt: String,
    pub changed: bool,
    pub metadata: Value,
}
