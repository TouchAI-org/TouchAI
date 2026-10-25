// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Tauri 平台配置以 RFC 7396 合并，`app.windows` 数组是整体替换而不是逐项合并。
//! 因此 `tauri.linux.conf.json` 必须完整重复主窗口定义，而重复就可能漂移。
//! 这里锁定两份定义只在显式允许的字段上不同，避免以后改窗口参数时漏改 Linux 覆盖。

use serde_json::{Map, Value};
use std::path::PathBuf;

/// 允许在 Linux 覆盖里与基础配置不同的字段。
/// - `transparent`：Linux 用透明窗口承载 CSS 圆角。
/// - `backgroundColor`：透明窗口下由 CSS 外壳负责底色，不再设置窗口底色。
const ALLOWED_LINUX_OVERRIDES: [&str; 2] = ["transparent", "backgroundColor"];

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
fn linux_override_repeats_the_main_window_definition() {
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
fn linux_main_window_is_transparent_for_css_rounded_corners() {
    let linux = read_config("tauri.linux.conf.json");

    assert_eq!(
        main_window(&linux).get("transparent"),
        Some(&Value::Bool(true)),
        "Linux main window must be transparent so #app can clip the rounded shell"
    );
    assert!(
        main_window(&linux).get("backgroundColor").is_none(),
        "a window background color would paint over the transparent rounded shell"
    );
}

#[test]
fn base_config_keeps_the_opaque_main_window() {
    let base = read_config("tauri.conf.json");

    assert_eq!(
        main_window(&base).get("transparent"),
        Some(&Value::Bool(false)),
        "only Linux uses a transparent window; other platforms keep the opaque window"
    );
}
