// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Crash records are written synchronously and never pass through the logger.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use time::macros::format_description;
use time::OffsetDateTime;

static PANIC_HOOK_INSTALLED: OnceLock<()> = OnceLock::new();
const MAX_CRASH_RECORDS: usize = 50;

pub(crate) fn install_panic_hook(app_version: &str) {
    if PANIC_HOOK_INSTALLED.set(()).is_err() {
        return;
    }

    let default_hook = std::panic::take_hook();
    let version = app_version.to_string();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(directory) = super::crash_directory() {
            let payload = info
                .payload()
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
                .unwrap_or("<non-string panic payload>");
            let location = info
                .location()
                .map(|location| format!("{}:{}", location.file(), location.line()))
                .unwrap_or_else(|| "unknown".to_string());
            let thread = std::thread::current();
            let _ = write_crash_record_values(
                &directory,
                super::run_id(),
                &version,
                thread.name().unwrap_or("<unnamed>"),
                &location,
                payload,
            );
        }
        default_hook(info);
    }));
}

fn write_crash_record_values(
    directory: &Path,
    run_id: &str,
    app_version: &str,
    thread_name: &str,
    location: &str,
    payload: &str,
) -> std::io::Result<PathBuf> {
    fs::create_dir_all(directory)?;
    restrict_directory_permissions(directory);

    let timestamp = OffsetDateTime::now_utc()
        .format(format_description!(
            "[year][month][day]T[hour][minute][second].[subsecond digits:3]Z"
        ))
        .unwrap_or_else(|_| "unknown".to_string());
    let stem = format!("{timestamp}-{}", &run_id[..run_id.len().min(6)]);
    let backtrace = std::backtrace::Backtrace::force_capture();
    let redacted_payload = crate::core::mcp::redact_stderr(payload);
    let content = format!(
        "kind=panic\nrun={run_id}\nversion={app_version}\nos={}\narch={}\nthread={thread_name}\nlocation={location}\nmessage={payload}\n\n{backtrace}\n",
        std::env::consts::OS,
        std::env::consts::ARCH,
        payload = redacted_payload,
    );

    let mut options = OpenOptions::new();
    // create_new 保证同一毫秒内的两次崩溃不会互相覆盖。
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let mut path = directory.join(format!("{stem}.txt"));
    let mut attempt = 0;
    let mut file = loop {
        match options.open(&path) {
            Ok(file) => break file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt < 9 => {
                attempt += 1;
                path = directory.join(format!("{stem}-{attempt}.txt"));
            }
            Err(error) => return Err(error),
        }
    };
    file.write_all(content.as_bytes())?;
    file.sync_all()?;
    prune_old_crash_records(directory, MAX_CRASH_RECORDS);
    Ok(path)
}

fn prune_old_crash_records(directory: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut records = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            (path.extension().and_then(|value| value.to_str()) == Some("txt")).then_some(path)
        })
        .collect::<Vec<_>>();
    records.sort();
    let remove_count = records.len().saturating_sub(keep);
    for path in records.into_iter().take(remove_count) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(unix)]
fn restrict_directory_permissions(directory: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(directory, fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
fn restrict_directory_permissions(_directory: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_gets_a_crash_record_with_the_run_and_version() {
        let directory = tempfile::TempDir::new().expect("temp dir");
        let path = write_crash_record_values(
            directory.path(),
            "7f3a9cdeadbeef",
            "1.2.2",
            "main",
            "test.rs:10",
            "test panic",
        )
        .expect("write crash record");
        let content = fs::read_to_string(path).expect("read crash record");
        assert!(content.contains("run=7f3a9cdeadbeef"));
        assert!(content.contains("version=1.2.2"));
        assert!(content.contains("message=test panic"));
    }

    #[test]
    fn user_does_not_get_secrets_in_a_crash_record() {
        let directory = tempfile::TempDir::new().expect("temp dir");
        let path = write_crash_record_values(
            directory.path(),
            "7f3a9cdeadbeef",
            "1.2.2",
            "main",
            "test.rs:10",
            "failed with token=secret-value",
        )
        .expect("write crash record");
        let content = fs::read_to_string(path).expect("read crash record");

        assert!(!content.contains("secret-value"));
        assert!(content.contains("token=[redacted]"));
    }

    #[test]
    fn user_keeps_only_the_newest_fifty_crash_records() {
        let directory = tempfile::TempDir::new().expect("temp dir");
        for index in 0..55 {
            fs::write(
                directory.path().join(format!("record-{index:02}.txt")),
                "panic",
            )
            .expect("write crash record");
        }

        prune_old_crash_records(directory.path(), MAX_CRASH_RECORDS);

        let remaining = fs::read_dir(directory.path()).expect("read dir").count();
        assert_eq!(remaining, MAX_CRASH_RECORDS);
        assert!(!directory.path().join("record-00.txt").exists());
        assert!(directory.path().join("record-54.txt").exists());
    }

    #[test]
    fn user_keeps_every_crash_record_written_in_the_same_second() {
        let directory = tempfile::TempDir::new().expect("temp dir");
        let first = write_crash_record_values(
            directory.path(),
            "7f3a9cdeadbeef",
            "1.2.2",
            "main",
            "test.rs:10",
            "first panic",
        )
        .expect("write first crash record");
        let second = write_crash_record_values(
            directory.path(),
            "7f3a9cdeadbeef",
            "1.2.2",
            "main",
            "test.rs:20",
            "second panic",
        )
        .expect("write second crash record");

        assert_ne!(first, second);
        assert!(fs::read_to_string(&first)
            .expect("read")
            .contains("first panic"));
        assert!(fs::read_to_string(&second)
            .expect("read")
            .contains("second panic"));
    }
}
