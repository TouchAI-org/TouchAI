// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 日志目录的准备：可写性、旧格式覆盖和文件权限。

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use super::format::OBS_TARGET;

pub(crate) const LOG_FILE_NAME: &str = "TouchAI";
const PROBE_FILE_NAME: &str = ".write-probe";

/// 准备日志目录并返回实际使用的目录。
///
/// 目录不可写时退到当前目录，并保证当前日志文件存在且为 0600。
pub(crate) fn prepare(logs_path: &Path) -> PathBuf {
    let directory = match ensure_directory(logs_path) {
        Ok(()) => logs_path.to_path_buf(),
        Err(error) => {
            log::warn!(
                target: OBS_TARGET,
                "log.dir.fallback reason={} path={}",
                super::format::escape_value(&error.to_string()),
                super::format::escape_value(&logs_path.display().to_string())
            );
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        }
    };

    discard_legacy_files(&directory);
    ensure_current_file(&directory);
    directory
}

fn ensure_directory(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)?;

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
            .ok()
            .and_then(|content| content.lines().next().map(str::to_string))
            .is_some_and(|line| is_current_format(&line));

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

    if discarded > 0 {
        log::info!(target: OBS_TARGET, "log.legacy.discarded count={discarded}");
    }
    discarded
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
    fn user_gets_a_writable_log_directory() {
        let root = tempfile::TempDir::new().expect("temp dir");
        let logs = root.path().join("logs");

        let prepared = prepare(&logs);

        assert_eq!(prepared, logs);
        assert!(logs.join("TouchAI.log").exists());
    }
}
