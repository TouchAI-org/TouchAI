// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 本地日志行的格式：UTC 毫秒前缀加 logfmt 尾部。

use log::Level;
use time::macros::format_description;
use time::OffsetDateTime;

/// 前端事件统一使用的 target；该 target 的消息已经是完整的 logfmt 事件。
pub(crate) const OBS_TARGET: &str = "obs";

const TIMESTAMP_FORMAT: &[time::format_description::FormatItem<'static>] =
    format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");

/// 级别占 5 个字符，前缀三列因此不会随级别抖动。
pub(crate) fn level_label(level: Level) -> &'static str {
    match level {
        Level::Trace => "TRACE",
        Level::Debug => "DEBUG",
        Level::Info => "INFO ",
        Level::Warn => "WARN ",
        Level::Error => "ERROR",
    }
}

/// 把一条 record 格式化成落盘的一行。
///
/// `obs` target 的 message 已经包含事件名和字段；其他 target 由这里补上 target。
pub(crate) fn format_line(
    level: Level,
    target: &str,
    message: &str,
    now: OffsetDateTime,
) -> String {
    let timestamp = now.format(TIMESTAMP_FORMAT).unwrap_or_default();
    let body = message.replace(['\r', '\n'], " ");

    if target == OBS_TARGET {
        format!("{timestamp} {} {body}", level_label(level))
    } else {
        // 每行都带 run，跨运行关联不必依赖头部记录的位置。
        format!(
            "{timestamp} {} {target} run={} {body}{}",
            level_label(level),
            super::run_id(),
            current_trace_suffix()
        )
    }
}

fn current_trace_suffix() -> String {
    super::trace::current_trace()
        .map(|trace| {
            format!(
                " trace_id={} span_id={}",
                escape_value(&trace.trace_id),
                escape_value(&trace.span_id)
            )
        })
        .unwrap_or_default()
}

/// 生成头部记录，用于区分日志格式和运行。
pub(crate) fn header_line(run: &str, app_version: &str) -> String {
    format!(
        "log.header log.format=1 run={run} app.version={} os.type={} os.version={} arch={}",
        escape_value(app_version),
        escape_value(std::env::consts::OS),
        escape_value(std::env::consts::OS),
        escape_value(std::env::consts::ARCH)
    )
}

/// logfmt 值转义：安全值原样输出，其余用 JSON 字符串。
pub(crate) fn escape_value(value: &str) -> String {
    let safe = !value.is_empty()
        && value.chars().all(|character| {
            character.is_ascii()
                && !character.is_ascii_control()
                && !matches!(character, ' ' | '"' | '=' | '\\')
        });

    if safe {
        value.to_string()
    } else {
        serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn user_sees_a_utc_millisecond_timestamp_and_padded_level() {
        let line = format_line(
            Level::Warn,
            "touchai::core::mcp",
            "connected",
            datetime!(2026-10-28 03:12:45.123 UTC),
        );

        assert_eq!(
            line,
            format!(
                "2026-10-28T03:12:45.123Z WARN  touchai::core::mcp run={} connected",
                super::super::run_id()
            )
        );
    }

    #[test]
    fn user_sees_the_event_name_without_a_duplicated_target() {
        let line = format_line(
            Level::Info,
            OBS_TARGET,
            "app.start run=7f3a",
            datetime!(2026-10-28 03:12:45.001 UTC),
        );

        assert_eq!(line, "2026-10-28T03:12:45.001Z INFO  app.start run=7f3a");
    }

    #[test]
    fn user_never_gets_a_multi_line_record() {
        let line = format_line(
            Level::Error,
            "touchai",
            "first\nsecond\rthird",
            datetime!(2026-10-28 03:12:45 UTC),
        );

        assert!(!line.contains('\n'));
        assert!(!line.contains('\r'));
    }

    #[test]
    fn user_gets_values_with_spaces_quoted() {
        assert_eq!(escape_value("plain"), "plain");
        assert_eq!(escape_value("two words"), "\"two words\"");
        assert_eq!(escape_value("a=b"), "\"a=b\"");
        assert_eq!(escape_value("用户"), "\"用户\"");
    }
}
