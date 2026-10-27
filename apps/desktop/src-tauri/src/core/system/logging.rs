use log::LevelFilter;
use tauri::plugin::TauriPlugin;
use tauri::Runtime;
use tauri_plugin_log::fern::colors::{Color, ColoredLevelConfig};
use tauri_plugin_log::{Builder, RotationStrategy, Target, TargetKind, TimezoneStrategy};
use time::macros::format_description;
use time::OffsetDateTime;

use super::paths::{app_directory_path, AppDirectory};
use crate::core::observability::format::format_line;

const DEFAULT_LOG_LEVEL: LevelFilter = LevelFilter::Info;
const LOG_FILE_NAME: &str = "TouchAI";
const MAX_LOG_FILE_SIZE_BYTES: u128 = 10 * 1024 * 1024; // 10MB
const MAX_ARCHIVED_FILES: usize = 7;

/// 从字符串解析日志级别
fn parse_log_level(value: &str) -> Option<LevelFilter> {
    match value.trim().to_ascii_lowercase().as_str() {
        "trace" => Some(LevelFilter::Trace),
        "debug" => Some(LevelFilter::Debug),
        "info" => Some(LevelFilter::Info),
        "warn" => Some(LevelFilter::Warn),
        "error" => Some(LevelFilter::Error),
        "off" => Some(LevelFilter::Off),
        _ => None,
    }
}

/// 从环境变量 TOUCHAI_LOG_LEVEL 获取日志级别
fn resolve_log_level() -> LevelFilter {
    std::env::var("TOUCHAI_LOG_LEVEL")
        .ok()
        .as_deref()
        .and_then(parse_log_level)
        .unwrap_or(DEFAULT_LOG_LEVEL)
}

/// 分离 webview 目标和位置信息
/// "webview:location" -> ("webview", Some("location"))
fn split_webview_target(target: &str) -> (&str, Option<&str>) {
    target
        .strip_prefix("webview:")
        .map(|location| ("webview", Some(location)))
        .unwrap_or((target, None))
}

/// 分离窗口标签和位置路径
/// "label|path" -> (Some("label"), "path")
fn split_webview_location(location: &str) -> (Option<&str>, &str) {
    location
        .split_once('|')
        .map(|(label, rest)| (Some(label), rest))
        .unwrap_or((None, location))
}

mod ansi {
    pub const DIM: &str = "\x1b[90m";
    pub const CYAN: &str = "\x1b[36m";
    pub const RESET: &str = "\x1b[0m";
}

// ============================================================================
// 日志格式化
// ============================================================================

/// 格式化目标标签
fn format_target_label(target: &str, label: Option<&str>) -> String {
    match label {
        Some(label) => format!("{target}:{label}"),
        None => target.to_string(),
    }
}

/// 构建控制台输出目标（带颜色）
fn build_stdout_target(timezone_strategy: TimezoneStrategy) -> Target {
    let date_format = format_description!("[year]-[month]-[day]");
    let time_format = format_description!("[hour]:[minute]:[second]");

    let colors = ColoredLevelConfig::new()
        .trace(Color::Magenta)
        .debug(Color::Blue)
        .info(Color::Green)
        .warn(Color::Yellow)
        .error(Color::Red);

    Target::new(TargetKind::Stdout).format(move |out, message, record| {
        let now = timezone_strategy.get_now();
        let date = now.format(&date_format).unwrap_or_default();
        let time = now.format(&time_format).unwrap_or_default();
        let level = colors.color(record.level());
        let (target, location) = split_webview_target(record.target());

        match location {
            Some(location) => {
                let (label, location_path) = split_webview_location(location);
                let target_label = format_target_label(target, label);
                out.finish(format_args!(
                    "{dim}[{date}][{time}]{reset}[{level}]{cyan}[{target_label}]{reset}{dim}[{location_path}]{reset} {message}",
                    dim = ansi::DIM,
                    reset = ansi::RESET,
                    cyan = ansi::CYAN,
                ));
            }
            None => {
                out.finish(format_args!(
                    "{dim}[{date}][{time}]{reset}[{level}]{cyan}[{target}]{reset} {message}",
                    dim = ansi::DIM,
                    reset = ansi::RESET,
                    cyan = ansi::CYAN,
                ));
            }
        }
    })
}

/// 构建文件输出目标（无颜色）
fn build_file_target(logs_path: std::path::PathBuf) -> Target {
    Target::new(TargetKind::Folder {
        path: logs_path,
        file_name: Some(LOG_FILE_NAME.into()),
    })
    .format(|out, message, record| {
        out.finish(format_args!(
            "{}",
            format_line(
                record.level(),
                record.target(),
                &message.to_string(),
                OffsetDateTime::now_utc()
            )
        ))
    })
}

/// 构建 Tauri 日志插件
pub fn build_plugin<R: Runtime>() -> TauriPlugin<R> {
    let timezone_strategy = TimezoneStrategy::UseUtc;
    let logs_path = app_directory_path(AppDirectory::Logs).unwrap_or_else(|error| {
        eprintln!(
            "[logging] Failed to resolve logs directory from init module: {}. Falling back to current directory.",
            error
        );
        std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
    });
    crate::core::observability::initialize_run_id();

    let mut targets = vec![build_stdout_target(timezone_strategy.clone())];

    // 生产环境启用文件日志
    if !cfg!(debug_assertions) {
        let logs_path = crate::core::observability::initialize(&logs_path);
        targets.push(build_file_target(logs_path));
    }

    Builder::new()
        .level(resolve_log_level())
        .rotation_strategy(RotationStrategy::KeepSome(MAX_ARCHIVED_FILES))
        .timezone_strategy(timezone_strategy)
        .clear_format()
        .max_file_size(MAX_LOG_FILE_SIZE_BYTES)
        .targets(targets)
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The log level comes from an environment variable, and the webview target carries the
    // window label. Getting either wrong hides diagnostics or mislabels where a line came from.

    #[test]
    fn user_gets_every_level_name_parsed() {
        assert_eq!(parse_log_level("trace"), Some(LevelFilter::Trace));
        assert_eq!(parse_log_level("debug"), Some(LevelFilter::Debug));
        assert_eq!(parse_log_level("info"), Some(LevelFilter::Info));
        assert_eq!(parse_log_level("warn"), Some(LevelFilter::Warn));
        assert_eq!(parse_log_level("error"), Some(LevelFilter::Error));
        assert_eq!(parse_log_level("off"), Some(LevelFilter::Off));
    }

    #[test]
    fn user_gets_the_level_name_parsed_regardless_of_case_and_padding() {
        assert_eq!(parse_log_level("  WARN  "), Some(LevelFilter::Warn));
        assert_eq!(parse_log_level("Info"), Some(LevelFilter::Info));
    }

    #[test]
    fn user_gets_an_unknown_level_name_ignored() {
        assert_eq!(parse_log_level("verbose"), None);
        assert_eq!(parse_log_level(""), None);
    }

    #[test]
    fn user_gets_a_webview_target_split_into_its_location() {
        assert_eq!(
            split_webview_target("webview:http://localhost:1420/main"),
            ("webview", Some("http://localhost:1420/main"))
        );
    }

    #[test]
    fn user_gets_a_plain_target_left_whole() {
        assert_eq!(split_webview_target("touchai"), ("touchai", None));
    }

    #[test]
    fn user_gets_a_webview_location_split_into_its_label() {
        assert_eq!(
            split_webview_location("main|http://localhost:1420/"),
            (Some("main"), "http://localhost:1420/")
        );
    }

    #[test]
    fn user_gets_a_location_without_a_label_left_whole() {
        assert_eq!(
            split_webview_location("http://localhost:1420/"),
            (None, "http://localhost:1420/")
        );
    }

    #[test]
    fn user_gets_the_target_label_prefixed_with_the_window() {
        assert_eq!(format_target_label("webview", Some("main")), "webview:main");
    }

    #[test]
    fn user_gets_the_bare_target_when_no_window_is_known() {
        assert_eq!(format_target_label("touchai", None), "touchai");
    }

    #[test]
    fn user_gets_the_default_level_when_nothing_is_configured() {
        // A build without the variable must still log, at info.
        if std::env::var("TOUCHAI_LOG_LEVEL").is_err() {
            assert_eq!(resolve_log_level(), DEFAULT_LOG_LEVEL);
        }
    }

    #[test]
    fn user_gets_a_console_target_and_a_file_target_built() {
        // Both targets must construct without panicking; their internals are private to the
        // plugin, so building them is the observable contract.
        let _console = build_stdout_target(TimezoneStrategy::UseLocal);
        let directory = tempfile::TempDir::new().expect("temp dir");
        let _file = build_file_target(directory.path().to_path_buf());
    }
}
