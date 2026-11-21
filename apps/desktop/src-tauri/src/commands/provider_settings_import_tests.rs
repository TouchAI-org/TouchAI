use std::fs;

use super::*;
use serde_json::json;

fn write_config(home: &Path, path: &str, contents: &str) {
    let path = home.join(path);
    fs::create_dir_all(path.parent().expect("fixture parent")).expect("fixture directory");
    fs::write(path, contents).expect("fixture written");
}

fn fixture_key() -> String {
    "x".repeat(32)
}

fn write_codex(home: &Path, provider_fields: &str) {
    write_config(
        home,
        ".codex/config.toml",
        &format!("model = 'gpt-test'\nmodel_provider = 'gateway'\n[model_providers.gateway]\nbase_url = 'https://gateway.example.test/v1'\n{provider_fields}"),
    );
    write_config(
        home,
        ".codex/auth.json",
        &json!({"OPENAI_API_KEY": fixture_key()}).to_string(),
    );
}

#[test]
fn user_gets_only_api_settings_when_scanning_claude_and_source_bytes_stay_unchanged() {
    let home = tempfile::tempdir().expect("fixture home");
    let contents = json!({
        "env": {"ANTHROPIC_API_KEY": fixture_key(), "ANTHROPIC_BASE_URL": "https://gateway.example.test", "ANTHROPIC_MODEL": "claude-sonnet"},
        "permissions": {"allow": ["ignored"]}, "hooks": {"ignored": "never execute"}, "instructions": "ignored"
    }).to_string();
    write_config(home.path(), ".claude/settings.json", &contents);
    let result = scan_at(home.path()).claude_code;
    assert_eq!(result.status, ImportStatus::Available);
    let candidate = result.candidate.expect("compatible candidate");
    assert_eq!(candidate.driver, ImportDriver::AnthropicCompatible);
    assert_eq!(candidate.api_endpoint, "https://gateway.example.test/v1");
    assert_eq!(candidate.model_id.as_deref(), Some("claude-sonnet"));
    assert!(candidate.api_key.as_deref() == Some(fixture_key().as_str()));
    let serialized = serde_json::to_value(candidate).expect("IPC response");
    assert_eq!(serialized.as_object().expect("object").len(), 5);
    assert!(
        fs::read_to_string(home.path().join(".claude/settings.json")).expect("source") == contents
    );
}

#[test]
fn user_keeps_the_responses_or_chat_protocol_when_importing_a_codex_provider() {
    let home = tempfile::tempdir().expect("fixture home");
    for (wire, driver) in [
        ("responses", ImportDriver::Openai),
        ("chat", ImportDriver::OpenaiCompatible),
    ] {
        write_codex(
            home.path(),
            &format!("name = 'Team gateway'\nwire_api = '{wire}'\nrequires_openai_auth = true\n"),
        );
        let result = scan_at(home.path()).codex;
        assert_eq!(result.status, ImportStatus::Available);
        let candidate = result.candidate.expect("compatible candidate");
        assert_eq!(candidate.driver, driver);
        assert_eq!(candidate.provider_name, "Team gateway");
        assert!(candidate.api_key.as_deref() == Some(fixture_key().as_str()));
    }
}

#[test]
fn user_does_not_send_an_unrelated_openai_key_when_a_custom_provider_uses_other_authentication() {
    let home = tempfile::tempdir().expect("fixture home");
    for fields in [
        "",
        "env_key = 'GATEWAY_API_KEY'\n",
        "env_key = 'GATEWAY_API_KEY'\nrequires_openai_auth = true\n",
        "experimental_bearer_token = '$GATEWAY_TOKEN'\n",
    ] {
        write_codex(home.path(), fields);
        let result = scan_at(home.path()).codex;
        assert_eq!(result.status, ImportStatus::Partial);
        assert!(result
            .candidate
            .expect("partial candidate")
            .api_key
            .is_none());
    }
}

#[test]
fn user_can_import_builtin_openai_settings_without_importing_login_tokens() {
    let home = tempfile::tempdir().expect("fixture home");
    write_config(home.path(), ".codex/config.toml", "model = 'gpt-test'\n");
    write_config(home.path(), ".codex/auth.json", &json!({"auth_mode": "chatgpt", "OPENAI_API_KEY": fixture_key(), "tokens": {"access_token": fixture_key()}}).to_string());
    let result = scan_at(home.path()).codex;
    assert_eq!(result.status, ImportStatus::Partial);
    let candidate = result.candidate.expect("partial candidate");
    assert_eq!(candidate.api_endpoint, OPENAI_DEFAULT_ENDPOINT);
    assert!(candidate.api_key.is_none());

    write_config(
        home.path(),
        ".codex/auth.json",
        &json!({"auth_mode": "apikey", "OPENAI_API_KEY": fixture_key()}).to_string(),
    );
    assert_eq!(scan_at(home.path()).codex.status, ImportStatus::Available);
}

#[test]
fn user_gets_partial_settings_when_authentication_is_missing_malformed_or_an_environment_reference()
{
    let home = tempfile::tempdir().expect("fixture home");
    write_config(home.path(), ".codex/config.toml", "model = 'gpt-test'\n");
    assert_eq!(scan_at(home.path()).codex.status, ImportStatus::Partial);
    for auth in [
        "not json",
        r#"{"OPENAI_API_KEY":"$OPENAI_API_KEY"}"#,
        r#"{"OPENAI_API_KEY":42}"#,
    ] {
        write_config(home.path(), ".codex/auth.json", auth);
        let result = scan_at(home.path()).codex;
        assert_eq!(result.status, ImportStatus::Partial);
        assert!(result
            .candidate
            .expect("partial candidate")
            .api_key
            .is_none());
    }
}

#[test]
fn user_gets_safe_statuses_when_configs_are_missing_malformed_or_unrelated() {
    let home = tempfile::tempdir().expect("fixture home");
    let missing = scan_at(home.path());
    assert_eq!(missing.claude_code.status, ImportStatus::Missing);
    assert_eq!(missing.codex.status, ImportStatus::Missing);
    write_config(home.path(), ".claude/settings.json", "not json");
    write_config(home.path(), ".codex/config.toml", "not = [toml");
    let malformed = scan_at(home.path());
    assert_eq!(malformed.claude_code.status, ImportStatus::Malformed);
    assert_eq!(malformed.codex.status, ImportStatus::Malformed);
    write_config(home.path(), ".claude/settings.json", "{}");
    write_config(
        home.path(),
        ".codex/config.toml",
        "instructions = 'ignore this text'\n",
    );
    let unrelated = scan_at(home.path());
    assert_eq!(unrelated.claude_code.status, ImportStatus::Unsupported);
    assert_eq!(unrelated.codex.status, ImportStatus::Unsupported);
}

#[test]
fn user_cannot_import_unsafe_urls_when_previewing_either_source() {
    let home = tempfile::tempdir().expect("fixture home");
    for endpoint in [
        "https://user:x@example.test/v1",
        "https://example.test/v1?key=invalid",
        "https://example.test/#invalid",
        "file:///tmp/config",
        "https://",
        "https://example.test/\n",
    ] {
        write_config(
            home.path(),
            ".claude/settings.json",
            &json!({"env": {"ANTHROPIC_BASE_URL": endpoint}}).to_string(),
        );
        assert!(scan_at(home.path()).claude_code.candidate.is_none());
        write_config(
            home.path(),
            ".codex/config.toml",
            &format!(
                "model_provider = 'gateway'\n[model_providers.gateway]\nbase_url = {}\n",
                serde_json::to_string(endpoint).expect("fixture URL")
            ),
        );
        assert!(scan_at(home.path()).codex.candidate.is_none());
    }
}

#[test]
fn user_is_not_given_a_default_endpoint_when_a_configured_endpoint_has_the_wrong_type() {
    let home = tempfile::tempdir().expect("fixture home");
    write_config(
        home.path(),
        ".claude/settings.json",
        &json!({"env": {"ANTHROPIC_API_KEY": fixture_key(), "ANTHROPIC_BASE_URL": 123}})
            .to_string(),
    );
    assert_eq!(
        scan_at(home.path()).claude_code.status,
        ImportStatus::Unsupported
    );
    for config in [
        "model = 'gpt-test'\nmodel_providers = 123\n",
        "model_provider = 'openai'\nmodel_providers.openai = 123\n",
        "model = 'gpt-test'\nprofile = 'work'\n[profiles.work]\nmodel_provider = 'other'\n",
    ] {
        write_config(home.path(), ".codex/config.toml", config);
        assert_eq!(scan_at(home.path()).codex.status, ImportStatus::Unsupported);
    }
}

#[test]
fn user_is_told_a_cloud_auth_or_custom_protocol_config_is_unsupported_when_scanning() {
    let home = tempfile::tempdir().expect("fixture home");
    write_config(
        home.path(),
        ".claude/settings.json",
        &json!({"env": {"ANTHROPIC_API_KEY": fixture_key(), "CLAUDE_CODE_USE_BEDROCK": "1"}})
            .to_string(),
    );
    assert_eq!(
        scan_at(home.path()).claude_code.status,
        ImportStatus::Unsupported
    );
    for fields in [
        "wire_api = 'custom'\n",
        "http_headers = { Authorization = 'unsupported' }\n",
        "query_params = { version = 'unsupported' }\n",
        "requires_openai_auth = 'yes'\n",
    ] {
        write_codex(home.path(), fields);
        assert_eq!(scan_at(home.path()).codex.status, ImportStatus::Unsupported);
    }
}

#[test]
fn user_gets_partial_claude_fields_when_the_api_key_model_or_authentication_cannot_be_copied() {
    let home = tempfile::tempdir().expect("fixture home");
    for env in [
        json!({"ANTHROPIC_AUTH_TOKEN": fixture_key(), "ANTHROPIC_MODEL": "claude-sonnet"}),
        json!({"ANTHROPIC_API_KEY": "$API_KEY", "ANTHROPIC_MODEL": "claude-sonnet"}),
        json!({"ANTHROPIC_BASE_URL": ANTHROPIC_DEFAULT_ENDPOINT, "ANTHROPIC_MODEL": "invalid model"}),
    ] {
        write_config(
            home.path(),
            ".claude/settings.json",
            &json!({"env": env}).to_string(),
        );
        let result = scan_at(home.path()).claude_code;
        assert_eq!(result.status, ImportStatus::Partial);
        assert!(result
            .candidate
            .expect("partial candidate")
            .api_key
            .is_none());
    }
}

#[test]
fn user_uses_the_claude_top_level_model_but_not_a_bare_cli_alias() {
    let home = tempfile::tempdir().expect("fixture home");
    for (model, expected) in [
        ("claude-sonnet-4-5", Some("claude-sonnet-4-5")),
        ("sonnet", None),
        ("opus[1m]", None),
    ] {
        write_config(
            home.path(),
            ".claude/settings.json",
            &json!({
                "model": model,
                "env": {"ANTHROPIC_API_KEY": fixture_key()}
            })
            .to_string(),
        );
        let candidate = scan_at(home.path())
            .claude_code
            .candidate
            .expect("partial candidate");
        assert_eq!(candidate.model_id.as_deref(), expected);
    }
}

#[test]
fn user_does_not_import_claude_custom_headers_or_append_v1_to_the_official_route() {
    let home = tempfile::tempdir().expect("fixture home");
    write_config(
        home.path(),
        ".claude/settings.json",
        &json!({
            "env": {
                "ANTHROPIC_API_KEY": fixture_key(),
                "ANTHROPIC_CUSTOM_HEADERS": "X-Team: private"
            }
        })
        .to_string(),
    );
    assert_eq!(
        scan_at(home.path()).claude_code.status,
        ImportStatus::Unsupported
    );

    write_config(
        home.path(),
        ".claude/settings.json",
        &json!({
            "env": {
                "ANTHROPIC_API_KEY": fixture_key(),
                "ANTHROPIC_BASE_URL": "https://api.anthropic.com/",
                "ANTHROPIC_MODEL": "claude-sonnet-4-5"
            }
        })
        .to_string(),
    );
    assert_eq!(
        scan_at(home.path())
            .claude_code
            .candidate
            .expect("official candidate")
            .api_endpoint,
        ANTHROPIC_DEFAULT_ENDPOINT
    );
}

#[test]
fn user_imports_the_codex_openai_base_url_and_rejects_an_invalid_override() {
    let home = tempfile::tempdir().expect("fixture home");
    write_config(
        home.path(),
        ".codex/config.toml",
        "model = 'gpt-test'\nopenai_base_url = 'https://proxy.example.test/v1/'\n",
    );
    write_config(
        home.path(),
        ".codex/auth.json",
        &json!({"auth_mode": "apikey", "OPENAI_API_KEY": fixture_key()}).to_string(),
    );
    let candidate = scan_at(home.path())
        .codex
        .candidate
        .expect("official provider override");
    assert_eq!(candidate.api_endpoint, "https://proxy.example.test/v1");

    write_config(
        home.path(),
        ".codex/config.toml",
        "model = 'gpt-test'\nopenai_base_url = 42\n",
    );
    assert_eq!(scan_at(home.path()).codex.status, ImportStatus::Unsupported);
}

#[test]
fn user_does_not_copy_an_inline_codex_token_when_env_key_is_configured() {
    let home = tempfile::tempdir().expect("fixture home");
    write_codex(
        home.path(),
        "env_key = 'GATEWAY_API_KEY'\nexperimental_bearer_token = 'literal-token'\nrequires_openai_auth = true\n",
    );
    let candidate = scan_at(home.path()).codex.candidate.expect("candidate");
    assert!(candidate.api_key.is_none());

    write_codex(
        home.path(),
        "experimental_bearer_token = 'literal-token'\nrequires_openai_auth = true\n",
    );
    let candidate = scan_at(home.path()).codex.candidate.expect("candidate");
    assert_eq!(candidate.api_key.as_deref(), Some("literal-token"));
}

#[test]
fn user_gets_safe_statuses_when_files_are_oversized_non_utf8_or_not_regular_files() {
    let home = tempfile::tempdir().expect("fixture home");
    write_config(
        home.path(),
        ".claude/settings.json",
        &"x".repeat(MAX_CONFIG_BYTES as usize + 1),
    );
    write_config(home.path(), ".codex/config.toml", "model = 'gpt-test'\n");
    fs::write(home.path().join(".codex/config.toml"), [0xff, 0xfe]).expect("invalid UTF8 fixture");
    let result = scan_at(home.path());
    assert_eq!(result.claude_code.status, ImportStatus::Malformed);
    assert_eq!(result.codex.status, ImportStatus::Malformed);
    fs::create_dir_all(home.path().join(".codex/auth.json")).expect("directory fixture");
    write_config(home.path(), ".codex/config.toml", "model = 'gpt-test'\n");
    assert_eq!(scan_at(home.path()).codex.status, ImportStatus::Partial);
}

#[cfg(unix)]
#[test]
fn user_cannot_read_symlinked_configuration_when_it_redirects_discovery() {
    let home = tempfile::tempdir().expect("fixture home");
    let elsewhere = tempfile::tempdir().expect("external fixture");
    write_config(
        elsewhere.path(),
        "settings.json",
        r#"{"env":{"ANTHROPIC_MODEL":"claude-sonnet"}}"#,
    );
    std::os::unix::fs::symlink(elsewhere.path(), home.path().join(".claude"))
        .expect("symlink fixture");
    assert_eq!(
        scan_at(home.path()).claude_code.status,
        ImportStatus::Unavailable
    );
}

#[test]
fn user_cannot_read_provider_credentials_when_requesting_import_outside_settings() {
    use tauri::{
        ipc::{CallbackFn, InvokeBody},
        test::{get_ipc_response, mock_context, noop_assets, INVOKE_KEY},
        WebviewUrl, WebviewWindowBuilder,
    };
    let app = crate::testing::test_builder()
        .build(mock_context(noop_assets()))
        .expect("test app");
    let webview = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
        .build()
        .expect("test webview");
    let result = get_ipc_response(
        &webview,
        tauri::webview::InvokeRequest {
            cmd: "scan_provider_settings_import".into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .expect("test origin"),
            body: InvokeBody::Json(json!({})),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    );
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("provider settings must only be scanned from Settings"),
    };
    assert_eq!(error, json!("provider_settings_import_settings_only"));
}
