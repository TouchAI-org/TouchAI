// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Small, content-free diagnostic bundles for support.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use time::macros::format_description;
use time::OffsetDateTime;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const MAX_ROTATED_LOGS: usize = 2;
const MAX_CRASH_FILES: usize = 50;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BundleFile {
    pub name: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundlePreview {
    pub files: Vec<BundleFile>,
    pub total_bytes: u64,
    pub log_directory_fallback: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BundleManifest {
    format: u32,
    app_version: &'static str,
    run: String,
    generated_at: String,
    os: &'static str,
    arch: &'static str,
    log_directory_fallback: bool,
    files: Vec<BundleFile>,
    note: &'static str,
}

pub(crate) async fn preview() -> Result<BundlePreview, String> {
    let directory =
        super::log_directory().ok_or_else(|| "Log directory is unavailable".to_string())?;
    let files = collect_files(&directory)?;
    Ok(preview_with_stderr(
        &files,
        &super::stderr::snapshots().await,
    ))
}

pub(crate) async fn export(destination: &str) -> Result<BundlePreview, String> {
    let destination = PathBuf::from(destination);
    if !destination.is_absolute()
        || destination.extension().and_then(|value| value.to_str()) != Some("zip")
    {
        return Err("Diagnostic bundle destination must be an absolute .zip path".to_string());
    }
    let directory =
        super::log_directory().ok_or_else(|| "Log directory is unavailable".to_string())?;
    let preview = create_bundle(&directory, &destination).await?;
    Ok(preview)
}

pub(crate) fn dismiss_crashes() -> Result<usize, String> {
    let Some(directory) = super::crash_directory() else {
        return Ok(0);
    };
    if !directory.exists() {
        return Ok(0);
    }

    let mut removed = 0;
    for entry in fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) == Some("txt")
            && fs::remove_file(path).is_ok()
        {
            removed += 1;
        }
    }
    Ok(removed)
}

async fn create_bundle(log_directory: &Path, destination: &Path) -> Result<BundlePreview, String> {
    if let Some(parent) = destination.parent() {
        if !parent.exists() {
            return Err("Diagnostic bundle directory does not exist".to_string());
        }
    }

    let files = collect_files(log_directory)?;
    let stderr = super::stderr::snapshots().await;
    let preview = preview_with_stderr(&files, &stderr);
    let file = create_private_file(destination).map_err(|error| error.to_string())?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o600);

    let manifest = BundleManifest {
        format: 1,
        app_version: env!("CARGO_PKG_VERSION"),
        run: super::run_id().to_string(),
        generated_at: now_utc(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        log_directory_fallback: super::layout::fallback_used(),
        files: preview.files.clone(),
        note:
            "Contains local diagnostics only; no database, conversation, prompt, or tool payload.",
    };
    zip.start_file("manifest.json", options)
        .map_err(|error| error.to_string())?;
    zip.write_all(
        serde_json::to_string_pretty(&manifest)
            .map_err(|error| error.to_string())?
            .as_bytes(),
    )
    .map_err(|error| error.to_string())?;

    for (name, _bytes, path) in &files {
        zip.start_file(name, options)
            .map_err(|error| error.to_string())?;
        let mut source = File::open(path).map_err(|error| error.to_string())?;
        std::io::copy(&mut source, &mut zip).map_err(|error| error.to_string())?;
    }

    for snapshot in stderr {
        zip.start_file(
            format!("mcp-stderr/server-{}.txt", snapshot.server_id),
            options,
        )
        .map_err(|error| error.to_string())?;
        zip.write_all(snapshot.content.as_bytes())
            .map_err(|error| error.to_string())?;
    }

    zip.finish().map_err(|error| error.to_string())?;
    Ok(preview)
}

/// 诊断包可能含本地路径和运行信息，只允许当前用户读写。
fn create_private_file(path: &Path) -> std::io::Result<File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let file = options.open(path)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }

    Ok(file)
}

fn preview_with_stderr(
    files: &[(String, u64, PathBuf)],
    stderr: &[super::stderr::StderrSnapshot],
) -> BundlePreview {
    let mut preview_files = files
        .iter()
        .map(|(name, bytes, _)| BundleFile {
            name: name.clone(),
            bytes: *bytes,
        })
        .collect::<Vec<_>>();
    preview_files.extend(stderr.iter().map(|snapshot| BundleFile {
        name: format!("mcp-stderr/server-{}.txt", snapshot.server_id),
        bytes: snapshot.bytes as u64,
    }));
    BundlePreview {
        total_bytes: preview_files.iter().map(|file| file.bytes).sum(),
        files: preview_files,
        log_directory_fallback: super::layout::fallback_used(),
    }
}

fn collect_files(log_directory: &Path) -> Result<Vec<(String, u64, PathBuf)>, String> {
    let mut files = Vec::new();
    let current = log_directory.join("TouchAI.log");
    if current.exists() {
        push_file(&mut files, &current, "logs/TouchAI.log")?;
    }

    let mut rotated = fs::read_dir(log_directory)
        .map_err(|error| error.to_string())?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            (name.starts_with("TouchAI_") && name.ends_with(".log"))
                .then_some((path, entry.metadata().ok()?.modified().ok()?))
        })
        .collect::<Vec<_>>();
    rotated.sort_by_key(|(_, modified)| std::cmp::Reverse(*modified));
    for (path, _) in rotated.into_iter().take(MAX_ROTATED_LOGS) {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("TouchAI.log");
        push_file(&mut files, &path, &format!("logs/{name}"))?;
    }

    let crash_directory = log_directory.join("crashes");
    if crash_directory.exists() {
        let mut crashes = fs::read_dir(&crash_directory)
            .map_err(|error| error.to_string())?
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                (path.extension().and_then(|value| value.to_str()) == Some("txt")).then_some(path)
            })
            .collect::<Vec<_>>();
        crashes.sort();
        for path in crashes.into_iter().rev().take(MAX_CRASH_FILES) {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("crash.txt");
            push_file(&mut files, &path, &format!("crashes/{name}"))?;
        }
    }
    Ok(files)
}

fn push_file(
    files: &mut Vec<(String, u64, PathBuf)>,
    path: &Path,
    name: &str,
) -> Result<(), String> {
    let metadata = path.metadata().map_err(|error| error.to_string())?;
    let bytes = metadata.len();
    files.push((name.to_string(), bytes, path.to_path_buf()));
    Ok(())
}

fn now_utc() -> String {
    OffsetDateTime::now_utc()
        .format(format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
        ))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn user_exports_logs_and_crashes_without_private_content() {
        let directory = tempfile::TempDir::new().expect("temp dir");
        fs::write(directory.path().join("TouchAI.log"), "log line\n").expect("write log");
        fs::create_dir(directory.path().join("crashes")).expect("crash dir");
        fs::write(
            directory.path().join("crashes/20261028T031502Z-7f3a9c.txt"),
            "panic\n",
        )
        .expect("write crash");
        let destination = directory.path().join("diagnostics.zip");

        create_bundle(directory.path(), &destination)
            .await
            .expect("create bundle");

        let file = File::open(destination).expect("open bundle");
        let mut archive = zip::ZipArchive::new(file).expect("read bundle");
        let names = (0..archive.len())
            .map(|index| {
                archive
                    .by_index(index)
                    .expect("entry")
                    .name()
                    .expect("entry name")
                    .to_string()
            })
            .collect::<Vec<_>>();
        assert!(names.contains(&"logs/TouchAI.log".to_string()));
        assert!(names.iter().any(|name| name.starts_with("crashes/")));
        assert!(!names
            .iter()
            .any(|name| name.contains("database") || name.contains("chat")));
    }

    #[test]
    fn user_gets_only_safe_bundle_destinations_accepted() {
        let directory = tempfile::TempDir::new().expect("temp dir");
        let valid = directory.path().join("diagnostics.zip");
        assert!(valid.is_absolute());
        assert_eq!(
            valid.extension().and_then(|value| value.to_str()),
            Some("zip")
        );
    }

    #[tokio::test]
    async fn user_gets_relative_or_non_zip_destinations_rejected() {
        let relative = export("diagnostics.zip").await;
        assert!(relative.is_err());

        let directory = tempfile::TempDir::new().expect("temp dir");
        let wrong_extension = directory.path().join("diagnostics.txt");
        let rejected = export(&wrong_extension.to_string_lossy()).await;
        assert!(rejected.is_err());
        assert!(!wrong_extension.exists());
    }

    #[test]
    fn user_gets_a_private_bundle_file() {
        let directory = tempfile::TempDir::new().expect("temp dir");
        let path = directory.path().join("diagnostics.zip");
        let file = create_private_file(&path).expect("create bundle file");
        drop(file);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).expect("metadata").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
