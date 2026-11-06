// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Tauri 平台配置以 RFC 7396 合并，`app.windows` 数组是整体替换而不是逐项合并。
//! 因此 `tauri.linux.conf.json` 必须完整重复主窗口定义，而重复就可能漂移。
//! 这里锁定两份定义一致，避免以后改窗口参数时漏改 Linux 覆盖。

use serde_json::{Map, Value};
use std::path::PathBuf;

const ALLOWED_LINUX_OVERRIDES: [&str; 0] = [];

fn read_config(file_name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(file_name);
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));

    serde_json::from_str(&raw)
        .unwrap_or_else(|error| panic!("failed to parse {}: {}", path.display(), error))
}

fn main_window(config: &Value) -> &Map<String, Value> {
    config["app"]["windows"]
        .as_array()
        .and_then(|windows| windows.first())
        .and_then(Value::as_object)
        .expect("app.windows[0] must be an object")
}

#[test]
fn user_gets_the_same_main_window_definition_on_linux() {
    let base = read_config("tauri.conf.json");
    let linux = read_config("tauri.linux.conf.json");

    assert_eq!(
        main_window(&base).get("label"),
        main_window(&linux).get("label"),
        "Linux override must target the same window label as the base config"
    );

    let base_window = main_window(&base);
    let linux_window = main_window(&linux);

    for (key, base_value) in base_window {
        if ALLOWED_LINUX_OVERRIDES.contains(&key.as_str()) {
            continue;
        }

        assert_eq!(
            linux_window.get(key),
            Some(base_value),
            "`{key}` drifted between tauri.conf.json and tauri.linux.conf.json"
        );
    }

    for key in linux_window.keys() {
        assert!(
            base_window.contains_key(key) || ALLOWED_LINUX_OVERRIDES.contains(&key.as_str()),
            "`{key}` only exists in tauri.linux.conf.json and has no base config counterpart"
        );
    }
}

#[test]
fn user_gets_antialiased_corners_from_a_transparent_frameless_window() {
    let base = read_config("tauri.conf.json");
    let linux = read_config("tauri.linux.conf.json");

    for (platform, config) in [("base", &base), ("linux", &linux)] {
        let window = main_window(config);

        assert_eq!(
            window.get("transparent"),
            Some(&Value::Bool(true)),
            "{platform} main window must be transparent so CSS can anti-alias its corners"
        );
        assert_eq!(
            window.get("shadow"),
            Some(&Value::Bool(false)),
            "{platform} main window must not ask tao for an undecorated native shadow frame"
        );
        assert_eq!(
            window.get("decorations"),
            Some(&Value::Bool(false)),
            "{platform} main window must not draw a native caption"
        );
        assert!(
            window.get("backgroundColor").is_none(),
            "{platform} main window must not paint a rectangular colour behind the rounded shell"
        );
    }
}

#[test]
fn user_gets_a_standard_close_without_the_destroy_permission() {
    let capabilities = read_config("capabilities/default.json");
    let permissions = capabilities["permissions"]
        .as_array()
        .expect("capabilities.permissions must be an array");

    assert!(
        !permissions
            .iter()
            .any(|permission| permission.as_str() == Some("core:window:allow-destroy")),
        "flushing logs must use the approved close path, not the destructive destroy capability"
    );
}
