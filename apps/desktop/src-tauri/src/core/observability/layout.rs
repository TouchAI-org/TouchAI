// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 日志目录的准备：可写性、旧格式覆盖和文件权限。

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use super::format::OBS_TARGET;
use crate::core::system::paths::{app_directory_path, AppDirectory};

pub(crate) const LOG_FILE_NAME: &str = "TouchAI";
const PROBE_FILE_NAME: &str = ".write-probe";
const LEGACY_DETECTION_SAMPLE_LINES: usize = 20;
static FALLBACK_USED: AtomicBool = AtomicBool::new(false);
static DISCARDED_LEGACY_FILES: AtomicUsize = AtomicUsize::new(0);

/// 准备日志目录并返回实际使用的目录。
///
/// 目录不可写时退到当前目录，并保证当前日志文件存在且为 0600。
pub(crate) fn prepare(logs_path: &Path) -> PathBuf {
    FALLBACK_USED.store(false, Ordering::SeqCst);
    let directory = match ensure_directory(logs_path) {
        Ok(()) => logs_path.to_path_buf(),
        Err(_error) => {
            FALLBACK_USED.store(true, Ordering::SeqCst);
            fallback_directory(logs_path)
        }
    };

    DISCARDED_LEGACY_FILES.store(discard_legacy_files(&directory), Ordering::SeqCst);
    ensure_current_file(&directory);
    restrict_log_file_permissions(&directory);
    directory
}

fn fallback_directory(primary: &Path) -> PathBuf {
    let data_directory = app_directory_path(AppDirectory::Data)
        .map(|path| path.join("logs"))
        .ok();
    let temporary_directory = std::env::temp_dir().join("TouchAI").join("logs");

    for candidate in [data_directory, Some(temporary_directory.clone())]
        .into_iter()
        .flatten()
    {
        if candidate != primary && ensure_directory(&candidate).is_ok() {
            return candidate;
        }
    }

    temporary_directory
}

pub(crate) fn fallback_used() -> bool {
    FALLBACK_USED.load(Ordering::SeqCst)
}

/// Emit startup layout events after the logger target is installed.
pub(crate) fn log_startup_events() {
    if fallback_used() {
        let path = super::log_directory().unwrap_or_default();
        log::warn!(
            target: OBS_TARGET,
            "log.dir.fallback path={}",
            super::format::escape_value(&path.display().to_string())
        );
    }

    let discarded = DISCARDED_LEGACY_FILES.swap(0, Ordering::SeqCst);
    if discarded > 0 {
        log::info!(target: OBS_TARGET, "log.legacy.discarded count={discarded}");
    }
}

fn ensure_directory(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    // 共享临时目录（`/tmp/TouchAI/logs`）可能已被别的用户先建好。
    // 收紧权限失败说明目录不归我们所有，必须当成不可用，否则日志会写进别人控制的目录。
    restrict_directory_permissions(path)?;

    let probe = path.join(PROBE_FILE_NAME);
    {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&probe)?;
        file.write_all(b"probe")?;
    }
    fs::remove_file(&probe)?;

    Ok(())
}

/// 目录只允许当前用户进入；轮转出来的日志文件即使仍是默认权限也读不到。
#[cfg(unix)]
fn restrict_directory_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn restrict_directory_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// 旧格式文件与新格式混在一起会让解析器读到两种行，直接丢弃。
pub(crate) fn discard_legacy_files(directory: &Path) -> usize {
    let Ok(entries) = fs::read_dir(directory) else {
        return 0;
    };

    let mut discarded = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with(LOG_FILE_NAME) || !name.ends_with(".log") {
            continue;
        }

        let is_current = fs::read_to_string(&path)
            .map(|content| has_current_format_line(&content))
            .unwrap_or(false);

        if is_current {
            continue;
        }

        let removed = if name == format!("{LOG_FILE_NAME}.log") {
            OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&path)
                .map(|_| true)
                .unwrap_or(false)
        } else {
            match fs::remove_file(&path) {
                Ok(()) => true,
                Err(error) if error.kind() == ErrorKind::NotFound => true,
                Err(_) => false,
            }
        };

        if removed {
            discarded += 1;
        }
    }

    discarded
}

/// 只看首行会误判：崩溃或并发写入可能留下半行。取前若干非空行判断。
fn has_current_format_line(content: &str) -> bool {
    content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(LEGACY_DETECTION_SAMPLE_LINES)
        .any(is_current_format)
}

fn ensure_current_file(directory: &Path) {
    let path = directory.join(format!("{LOG_FILE_NAME}.log"));
    let mut options = OpenOptions::new();
    options.create(true).append(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    if let Ok(file) = options.open(&path) {
        drop(file);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
}

/// 轮转文件由日志插件以默认权限创建，启动时统一收紧到 0600。
///
/// 目录已经是 0700，但这层保护在 Windows 上不存在，所以每个文件自己也要受限。
#[cfg(unix)]
fn restrict_log_file_permissions(directory: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with(LOG_FILE_NAME) || !name.ends_with(".log") {
            continue;
        }
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
}

#[cfg(not(unix))]
fn restrict_log_file_permissions(_directory: &Path) {}

/// 判断一行是否符合 `log.format=1`：UTC 毫秒时间加 5 字符级别。
pub(crate) fn is_current_format(line: &str) -> bool {
    let bytes = line.as_bytes();
    if bytes.len() < 25 {
        return false;
    }

    let digit_positions = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22];
    if !digit_positions
        .iter()
        .all(|index| bytes[*index].is_ascii_digit())
    {
        return false;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return false;
    }
    if bytes[13] != b':' || bytes[16] != b':' || bytes[19] != b'.' || bytes[23] != b'Z' {
        return false;
    }
    if bytes[24] != b' ' {
        return false;
    }

    let rest = &line[25..];
    ["TRACE ", "DEBUG ", "INFO  ", "WARN  ", "ERROR "]
        .iter()
        .any(|prefix| rest.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_gets_a_current_format_line_accepted() {
        assert!(is_current_format(
            "2026-10-28T03:12:45.123Z INFO  app.start run=7f3a"
        ));
        assert!(is_current_format(
            "2026-10-28T03:12:45.123Z WARN  touchai::mcp denied"
        ));
    }

    #[test]
    fn user_gets_a_legacy_line_rejected() {
        assert!(!is_current_format(
            "[2026-10-28][03:12:45][INFO][webview:main] workspace ready"
        ));
        assert!(!is_current_format(""));
        assert!(!is_current_format("2026-10-28 03:12:45 INFO app.start"));
    }

    #[test]
    fn user_gets_legacy_log_files_discarded_on_startup() {
        let directory = tempfile::TempDir::new().expect("temp dir");
        let current = directory.path().join("TouchAI.log");
        let rotated = directory.path().join("TouchAI_2026-10-27_10-00-00.log");
        fs::write(&current, "[2026-10-27][10:00:00][INFO][webview] old\n").expect("write");
        fs::write(&rotated, "[2026-10-27][10:00:00][INFO][webview] old\n").expect("write");

        let discarded = discard_legacy_files(directory.path());

        assert_eq!(discarded, 2);
        assert_eq!(fs::read_to_string(&current).expect("read"), "");
        assert!(!rotated.exists());
    }

    #[test]
    fn user_keeps_current_format_log_files_on_startup() {
        let directory = tempfile::TempDir::new().expect("temp dir");
        let current = directory.path().join("TouchAI.log");
        let content = "2026-10-28T03:12:45.123Z INFO  app.start run=7f3a\n";
        fs::write(&current, content).expect("write");

        let discarded = discard_legacy_files(directory.path());

        assert_eq!(discarded, 0);
        assert_eq!(fs::read_to_string(&current).expect("read"), content);
    }

    #[test]
    fn user_keeps_a_current_log_whose_first_line_is_partial() {
        let directory = tempfile::TempDir::new().expect("temp dir");
        let current = directory.path().join("TouchAI.log");
        let content = "2026-10-28T03:12:45.123Z INFO  app.st\n\
                       2026-10-28T03:12:46.001Z INFO  app.start run=7f3a\n";
        fs::write(&current, content).expect("write");

        let discarded = discard_legacy_files(directory.path());

        assert_eq!(discarded, 0);
        assert_eq!(fs::read_to_string(&current).expect("read"), content);
    }

    #[test]
    fn user_gets_a_writable_log_directory() {
        let root = tempfile::TempDir::new().expect("temp dir");
        let logs = root.path().join("logs");

        let prepared = prepare(&logs);

        assert_eq!(prepared, logs);
        assert!(logs.join("TouchAI.log").exists());
    }

    #[test]
    fn user_gets_a_private_log_directory() {
        let root = tempfile::TempDir::new().expect("temp dir");
        let logs = root.path().join("logs");

        let prepared = prepare(&logs);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&prepared)
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        #[cfg(not(unix))]
        let _ = prepared;
    }

    #[test]
    fn user_gets_a_shared_directory_tightened_before_logs_land_in_it() {
        let root = tempfile::TempDir::new().expect("temp dir");
        let logs = root.path().join("logs");
        fs::create_dir_all(&logs).expect("logs dir");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // 模拟别人先建好的可写目录：`/tmp/TouchAI/logs` 就是这样被抢占的。
            fs::set_permissions(&logs, fs::Permissions::from_mode(0o777)).expect("permissions");
        }

        let prepared = prepare(&logs);

        assert_eq!(prepared, logs);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&prepared)
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700);
        }
    }

    #[test]
    fn user_gets_rotated_log_files_restricted_on_startup() {
        let root = tempfile::TempDir::new().expect("temp dir");
        let logs = root.path().join("logs");
        fs::create_dir_all(&logs).expect("logs dir");

        // 日志插件轮转出来的文件带默认权限，启动时统一收紧。
        let rotated = logs.join("TouchAI_2026-10-29_05-41-32.log");
        fs::write(&rotated, "2026-10-29T05:41:32.118Z INFO  obs.app.start\n")
            .expect("write rotated");

        let _prepared = prepare(&logs);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&rotated)
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
