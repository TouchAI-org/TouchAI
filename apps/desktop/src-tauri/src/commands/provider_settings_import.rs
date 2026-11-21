// Copyright (c) 2026. TouchAI. Licensed under GPL v3.

//! Read-only import of compatible global Claude Code and Codex API settings.

use std::{io::Read, path::Path};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use serde::Serialize;
use serde_json::Value as JsonValue;
use tauri::{Manager, Url};

const MAX_CONFIG_BYTES: u64 = 256 * 1024;
const ANTHROPIC_DEFAULT_ENDPOINT: &str = "https://api.anthropic.com";
const OPENAI_DEFAULT_ENDPOINT: &str = "https://api.openai.com/v1";

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ImportDriver {
    Openai,
    OpenaiCompatible,
    Anthropic,
    AnthropicCompatible,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ImportStatus {
    Available,
    Partial,
    Missing,
    Malformed,
    Unsupported,
    Unavailable,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderImportCandidate {
    provider_name: String,
    driver: ImportDriver,
    api_endpoint: String,
    model_id: Option<String>,
    api_key: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderImportSource {
    status: ImportStatus,
    candidate: Option<ProviderImportCandidate>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettingsImportScan {
    claude_code: ProviderImportSource,
    codex: ProviderImportSource,
}

enum ReadResult {
    Content(String),
    Missing,
    Malformed,
    Unavailable,
}

fn unavailable_source() -> ProviderImportSource {
    ProviderImportSource {
        status: ImportStatus::Unavailable,
        candidate: None,
    }
}

fn source_without_candidate(status: ImportStatus) -> ProviderImportSource {
    ProviderImportSource {
        status,
        candidate: None,
    }
}

fn source_with_candidate(candidate: ProviderImportCandidate) -> ProviderImportSource {
    let status = if candidate.model_id.is_some() && candidate.api_key.is_some() {
        ImportStatus::Available
    } else {
        ImportStatus::Partial
    };
    ProviderImportSource {
        status,
        candidate: Some(candidate),
    }
}

fn read_config_file(home: &Path, relative_path: &str) -> ReadResult {
    let mut components = Path::new(relative_path).components();
    let Some(file_name) = components.next_back() else {
        return ReadResult::Unavailable;
    };
    if !matches!(file_name, std::path::Component::Normal(_)) {
        return ReadResult::Unavailable;
    }

    let mut dir = match Dir::open_ambient_dir(home, ambient_authority()) {
        Ok(dir) => dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return ReadResult::Missing,
        Err(_) => return ReadResult::Unavailable,
    };
    for component in components {
        let std::path::Component::Normal(component) = component else {
            return ReadResult::Unavailable;
        };
        dir = match dir.open_dir_nofollow(component) {
            Ok(next) => next,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return ReadResult::Missing
            }
            Err(_) => return ReadResult::Unavailable,
        };
    }

    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let mut file = match dir.open_with(file_name.as_os_str(), &options) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return ReadResult::Missing,
        Err(_) => return ReadResult::Unavailable,
    };
    match file.metadata() {
        Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_CONFIG_BYTES => {}
        Ok(metadata) if metadata.len() > MAX_CONFIG_BYTES => return ReadResult::Malformed,
        _ => return ReadResult::Unavailable,
    }
    let mut bytes = Vec::new();
    if file
        .by_ref()
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > MAX_CONFIG_BYTES
    {
        return ReadResult::Malformed;
    }

    match String::from_utf8(bytes) {
        Ok(contents) => ReadResult::Content(contents),
        Err(_) => ReadResult::Malformed,
    }
}

fn safe_model_id(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:/-".contains(&byte))
        || !value.as_bytes()[0].is_ascii_alphanumeric()
    {
        return None;
    }
    Some(value.to_string())
}

fn safe_claude_model_id(value: Option<&str>) -> Option<String> {
    let model_id = safe_model_id(value)?;
    let normalized = model_id.to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "sonnet" | "sonnet[1m]" | "opus" | "opus[1m]" | "haiku" | "opusplan" | "best" | "default"
    ) {
        return None;
    }
    Some(model_id)
}

fn safe_literal_secret(value: Option<&str>) -> Option<String> {
    let value = value?;
    if value.is_empty()
        || value.len() > 4096
        || value.chars().any(char::is_control)
        || value.trim() != value
        || value.starts_with('$')
        || value.starts_with("{{")
        || value.contains("${")
    {
        return None;
    }
    Some(value.to_string())
}

fn safe_endpoint(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > 2048 || value.chars().any(char::is_control) {
        return None;
    }
    let parsed = Url::parse(value).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(parsed.as_str().trim_end_matches('/').to_string())
}

fn is_official_anthropic_endpoint(endpoint: &str) -> bool {
    Url::parse(endpoint)
        .ok()
        .and_then(|url| {
            url.host_str()
                .map(|host| host.eq_ignore_ascii_case("api.anthropic.com"))
        })
        .unwrap_or(false)
}

fn normalize_anthropic_endpoint(endpoint: String) -> String {
    if is_official_anthropic_endpoint(&endpoint) || endpoint.ends_with("/v1") {
        endpoint
    } else {
        format!("{endpoint}/v1")
    }
}

fn has_non_empty_custom_headers(env: &serde_json::Map<String, JsonValue>) -> bool {
    env.get("ANTHROPIC_CUSTOM_HEADERS").is_some_and(|value| {
        value
            .as_str()
            .map_or(true, |headers| !headers.trim().is_empty())
    })
}

fn json_string<'a>(value: &'a JsonValue, key: &str) -> Option<&'a str> {
    value.get(key).and_then(JsonValue::as_str)
}

fn scan_claude_code(home: &Path) -> ProviderImportSource {
    let contents = match read_config_file(home, ".claude/settings.json") {
        ReadResult::Content(contents) => contents,
        ReadResult::Missing => return source_without_candidate(ImportStatus::Missing),
        ReadResult::Malformed => return source_without_candidate(ImportStatus::Malformed),
        ReadResult::Unavailable => return unavailable_source(),
    };
    let settings: JsonValue = match serde_json::from_str(&contents) {
        Ok(settings) => settings,
        Err(_) => return source_without_candidate(ImportStatus::Malformed),
    };
    let Some(env) = settings.get("env").and_then(JsonValue::as_object) else {
        return source_without_candidate(ImportStatus::Unsupported);
    };
    let has_supported_setting = [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_AUTH_TOKEN",
    ]
    .iter()
    .any(|key| env.contains_key(*key));
    if !has_supported_setting {
        return source_without_candidate(ImportStatus::Unsupported);
    }

    if [
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
    ]
    .iter()
    .any(|key| {
        env.get(*key)
            .is_some_and(|value| !matches!(value.as_str(), Some("0" | "false" | "")))
    }) {
        return source_without_candidate(ImportStatus::Unsupported);
    }
    if has_non_empty_custom_headers(env) {
        return source_without_candidate(ImportStatus::Unsupported);
    }
    // Bearer/OAuth authentication does not map to TouchAI's API-key field.
    let api_key =
        if env.contains_key("ANTHROPIC_AUTH_TOKEN") || settings.get("apiKeyHelper").is_some() {
            None
        } else {
            safe_literal_secret(env.get("ANTHROPIC_API_KEY").and_then(JsonValue::as_str))
        };
    let model_id = env
        .get("ANTHROPIC_MODEL")
        .and_then(JsonValue::as_str)
        .or_else(|| settings.get("model").and_then(JsonValue::as_str))
        .and_then(|value| safe_claude_model_id(Some(value)));
    let endpoint_value = match env.get("ANTHROPIC_BASE_URL") {
        Some(value) => match value.as_str() {
            Some(value) => value,
            None => return source_without_candidate(ImportStatus::Unsupported),
        },
        None => ANTHROPIC_DEFAULT_ENDPOINT,
    };
    let Some(api_endpoint) = safe_endpoint(endpoint_value) else {
        return source_without_candidate(ImportStatus::Unsupported);
    };
    let official = is_official_anthropic_endpoint(&api_endpoint);
    let driver = if official {
        ImportDriver::Anthropic
    } else {
        ImportDriver::AnthropicCompatible
    };
    let api_endpoint = if official {
        api_endpoint
    } else {
        normalize_anthropic_endpoint(api_endpoint)
    };

    source_with_candidate(ProviderImportCandidate {
        provider_name: "Claude Code".into(),
        driver,
        api_endpoint,
        model_id,
        api_key,
    })
}

fn scan_codex(home: &Path) -> ProviderImportSource {
    let contents = match read_config_file(home, ".codex/config.toml") {
        ReadResult::Content(contents) => contents,
        ReadResult::Missing => return source_without_candidate(ImportStatus::Missing),
        ReadResult::Malformed => return source_without_candidate(ImportStatus::Malformed),
        ReadResult::Unavailable => return unavailable_source(),
    };
    let config: toml::Value = match toml::from_str(&contents) {
        Ok(config) => config,
        Err(_) => return source_without_candidate(ImportStatus::Malformed),
    };
    let Some(root) = config.as_table() else {
        return source_without_candidate(ImportStatus::Unsupported);
    };

    if root.contains_key("profile")
        || !["model", "model_provider", "model_providers"]
            .iter()
            .any(|key| root.contains_key(*key))
    {
        return source_without_candidate(ImportStatus::Unsupported);
    }
    let model_provider = match root.get("model_provider") {
        Some(value) => match value.as_str() {
            Some(value) if !value.trim().is_empty() => value.trim(),
            _ => return source_without_candidate(ImportStatus::Unsupported),
        },
        None => "openai",
    };
    let model_id = safe_model_id(root.get("model").and_then(toml::Value::as_str));
    let model_providers = match root.get("model_providers") {
        Some(value) => match value.as_table() {
            Some(table) => Some(table),
            None => return source_without_candidate(ImportStatus::Unsupported),
        },
        None => None,
    };
    let provider = match model_providers.and_then(|providers| providers.get(model_provider)) {
        Some(value) => match value.as_table() {
            Some(table) => Some(table),
            None => return source_without_candidate(ImportStatus::Unsupported),
        },
        None if model_provider == "openai" => None,
        None => return source_without_candidate(ImportStatus::Unsupported),
    };
    let get = |key: &str| provider.and_then(|table| table.get(key));
    if ["http_headers", "env_http_headers", "query_params", "auth"]
        .iter()
        .any(|key| get(key).is_some())
        || get("requires_openai_auth").is_some_and(|value| !value.is_bool())
    {
        return source_without_candidate(ImportStatus::Unsupported);
    }
    let endpoint_value = if model_provider == "openai" {
        match root.get("openai_base_url") {
            Some(value) => match value.as_str() {
                Some(value) => value,
                None => return source_without_candidate(ImportStatus::Unsupported),
            },
            None => match get("base_url") {
                Some(value) => match value.as_str() {
                    Some(value) => value,
                    None => return source_without_candidate(ImportStatus::Unsupported),
                },
                None => OPENAI_DEFAULT_ENDPOINT,
            },
        }
    } else {
        match get("base_url") {
            Some(value) => match value.as_str() {
                Some(value) => value,
                None => return source_without_candidate(ImportStatus::Unsupported),
            },
            None => return source_without_candidate(ImportStatus::Unsupported),
        }
    };
    let driver = match get("wire_api") {
        None => ImportDriver::Openai,
        Some(value) => match value.as_str() {
            Some("responses") => ImportDriver::Openai,
            Some("chat") => ImportDriver::OpenaiCompatible,
            _ => return source_without_candidate(ImportStatus::Unsupported),
        },
    };
    let provider_name = get("name")
        .and_then(toml::Value::as_str)
        .filter(|name| {
            !name.trim().is_empty() && name.len() <= 64 && !name.chars().any(char::is_control)
        })
        .map(|name| name.trim().to_string())
        .unwrap_or_else(|| {
            if model_provider == "openai" {
                "Codex (OpenAI)".into()
            } else {
                "Codex".into()
            }
        });
    let api_key = if get("env_key").is_some() {
        None
    } else if let Some(token) = get("experimental_bearer_token") {
        safe_literal_secret(token.as_str())
    } else if !get("requires_openai_auth")
        .and_then(toml::Value::as_bool)
        .unwrap_or(model_provider == "openai")
    {
        // Never resolve arbitrary environment variables or reuse another provider's key.
        None
    } else {
        match read_config_file(home, ".codex/auth.json") {
            ReadResult::Content(contents) => serde_json::from_str::<JsonValue>(&contents)
                .ok()
                .and_then(|auth| {
                    if auth
                        .get("auth_mode")
                        .is_some_and(|mode| mode.as_str() != Some("apikey"))
                    {
                        return None;
                    }
                    safe_literal_secret(json_string(&auth, "OPENAI_API_KEY"))
                }),
            _ => None,
        }
    };

    let Some(api_endpoint) = safe_endpoint(endpoint_value) else {
        return source_without_candidate(ImportStatus::Unsupported);
    };
    source_with_candidate(ProviderImportCandidate {
        provider_name,
        driver,
        api_endpoint,
        model_id,
        api_key,
    })
}

fn scan_at(home: &Path) -> ProviderSettingsImportScan {
    ProviderSettingsImportScan {
        claude_code: scan_claude_code(home),
        codex: scan_codex(home),
    }
}

#[tauri::command]
pub async fn scan_provider_settings_import<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> Result<ProviderSettingsImportScan, &'static str> {
    if window.label() != "settings" {
        return Err("provider_settings_import_settings_only");
    }
    let home = window.app_handle().path().home_dir().ok();
    tauri::async_runtime::spawn_blocking(move || match home {
        Some(home) => scan_at(&home),
        None => ProviderSettingsImportScan {
            claude_code: unavailable_source(),
            codex: unavailable_source(),
        },
    })
    .await
    .map_err(|_| "provider_settings_import_unavailable")
}

#[cfg(test)]
#[path = "provider_settings_import_tests.rs"]
mod tests;
