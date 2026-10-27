// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 本地诊断日志：运行标识、目录准备、格式化和前端批量入口。

pub mod bundle;
pub mod error_code;
pub mod format;
pub mod ingest;
pub mod layout;
pub mod level;
pub mod panic;
pub mod stderr;
pub mod trace;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use format::OBS_TARGET;

static RUN_ID: OnceLock<String> = OnceLock::new();
static LOG_DIRECTORY: OnceLock<PathBuf> = OnceLock::new();

/// 准备日志目录并生成本次运行的标识。重复调用是幂等的。
pub(crate) fn initialize(logs_path: &Path) -> PathBuf {
    initialize_run_id();
    LOG_DIRECTORY
        .get_or_init(|| layout::prepare(logs_path))
        .clone()
}

/// Directory holding the current and rotated diagnostic logs.
pub(crate) fn log_directory() -> Option<PathBuf> {
    LOG_DIRECTORY.get().cloned()
}

/// Directory for synchronous crash records.
pub(crate) fn crash_directory() -> Option<PathBuf> {
    log_directory().map(|directory| directory.join("crashes"))
}

/// 只生成运行标识，不创建日志目录。dev 下不落盘，但仍需要 run id。
pub(crate) fn initialize_run_id() {
    RUN_ID.get_or_init(|| uuid::Uuid::new_v4().simple().to_string());
}

/// 本次运行的标识；未初始化时退化为 `unknown`。
pub(crate) fn run_id() -> &'static str {
    RUN_ID.get().map(String::as_str).unwrap_or("unknown")
}

/// 启动头记录，标记日志格式、运行和平台。
pub(crate) fn log_header(app_version: &str) {
    let message = format::header_line(run_id(), app_version);
    log::info!(target: OBS_TARGET, "{}", message);
    layout::log_startup_events();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_gets_one_run_id_for_the_whole_process() {
        let directory = tempfile::TempDir::new().expect("temp dir");
        initialize(directory.path());
        let first = run_id().to_string();
        initialize(directory.path());

        assert_eq!(first, run_id());
        assert_eq!(first.len(), 32);
    }

    #[test]
    fn user_sees_the_format_version_in_the_header() {
        let header = format::header_line("1.2.2", "1.2.2");

        assert!(header.contains("log.format=1"));
        assert!(header.contains("app.version=1.2.2"));
    }
}
