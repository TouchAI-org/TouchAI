// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

//! Atomic persistence for a completed assistant result.

use std::io::Write;
use std::path::{Path, PathBuf};

const MAX_RESULT_EXPORT_BYTES: usize = 8 * 1024 * 1024;

fn validate_destination(destination: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(destination);
    if !path.is_absolute() {
        return Err("Result export destination must be an absolute path".to_string());
    }
    let is_html = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("html"));
    if !is_html {
        return Err("Result export destination must use the .html extension".to_string());
    }
    Ok(path)
}

fn write_html_atomic(destination: &Path, html: &str) -> Result<(), String> {
    if html.len() > MAX_RESULT_EXPORT_BYTES {
        return Err("Result export exceeds the 8 MiB limit".to_string());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "Result export destination has no parent directory".to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Cannot create temporary result file: {error}"))?;
    temporary
        .write_all(html.as_bytes())
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|error| format!("Cannot write result file: {error}"))?;
    temporary
        .persist(destination)
        .map_err(|error| format!("Cannot replace result file: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn result_export_html(destination: String, html: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let destination = validate_destination(&destination)?;
        write_html_atomic(&destination, &html)
    })
    .await
    .map_err(|error| format!("Result export task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{validate_destination, write_html_atomic, MAX_RESULT_EXPORT_BYTES};

    #[test]
    fn user_saves_result_as_html_without_leaving_a_temporary_file() {
        let root = tempfile::tempdir().expect("temporary directory");
        let destination = root.path().join("TouchAI-result.html");

        write_html_atomic(&destination, "<html>result</html>").expect("write result");

        assert_eq!(
            fs::read_to_string(&destination).expect("read result"),
            "<html>result</html>"
        );
        assert_eq!(fs::read_dir(root.path()).expect("list files").count(), 1);
    }

    #[test]
    fn user_retries_by_replacing_an_existing_result_file() {
        let root = tempfile::tempdir().expect("temporary directory");
        let destination = root.path().join("TouchAI-result.html");
        fs::write(&destination, "old").expect("seed result");

        write_html_atomic(&destination, "new").expect("replace result");

        assert_eq!(
            fs::read_to_string(&destination).expect("read result"),
            "new"
        );
        assert_eq!(fs::read_dir(root.path()).expect("list files").count(), 1);
    }

    #[test]
    fn user_gets_no_partial_file_when_the_destination_cannot_be_replaced() {
        let root = tempfile::tempdir().expect("temporary directory");
        let destination = root.path().join("occupied.html");
        fs::create_dir(&destination).expect("destination directory");

        assert!(write_html_atomic(&destination, "result").is_err());
        assert_eq!(fs::read_dir(root.path()).expect("list files").count(), 1);
    }

    #[test]
    fn user_is_blocked_from_relative_or_non_html_destinations() {
        assert!(validate_destination("relative.html").is_err());
        assert!(validate_destination("/tmp/result.txt").is_err());
        assert!(validate_destination("/tmp/result.HTML").is_ok());
    }

    #[test]
    fn user_is_blocked_from_writing_more_than_eight_mebibytes() {
        let root = tempfile::tempdir().expect("temporary directory");
        let destination = root.path().join("TouchAI-result.html");
        let oversized = "a".repeat(MAX_RESULT_EXPORT_BYTES + 1);

        assert!(write_html_atomic(&destination, &oversized).is_err());
        assert_eq!(fs::read_dir(root.path()).expect("list files").count(), 0);
    }
}
