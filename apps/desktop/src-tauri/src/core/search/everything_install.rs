// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Verified Everything portable installation for Windows.
//!
//! The installer treats mirrors as transport only. Every file must match the
//! size and SHA-256 pinned in `resources/binaries.json` before it can replace a
//! managed file under `assets/bin`.

use std::{
    future::Future,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use log::{info, warn};
use serde::{Deserialize, Serialize};
use tokio::{fs, io::AsyncWriteExt, sync::Mutex};

use crate::core::download::{download_bytes, sha256_hex, DownloadTimeouts};
use crate::core::system::paths::{app_directory_path, AppDirectory};

const RESOURCE_MANIFEST: &str = include_str!("../../../resources/binaries.json");
const INSTALL_RECORD_FILENAME: &str = "everything.json";
const DOWNLOAD_CONNECT_TIMEOUT_SECS: u64 = 15;
const DOWNLOAD_TIMEOUT_SECS: u64 = 60;

static INSTALL_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Deserialize)]
struct ResourceManifest {
    everything: EverythingManifest,
}

#[derive(Debug, Clone, Deserialize)]
struct EverythingManifest {
    version: String,
    files: Vec<ManagedFile>,
    fallback: ArchiveFallback,
}

#[derive(Debug, Clone, Deserialize)]
struct ManagedFile {
    filename: String,
    size: u64,
    sha256: String,
    archive_path: String,
    mirrors: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ArchiveFallback {
    url: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct InstallRecord {
    version: String,
    files: Vec<InstallRecordFile>,
}

#[derive(Debug, Deserialize, Serialize)]
struct InstallRecordFile {
    filename: String,
    size: u64,
    sha256: String,
}

struct StagedFile {
    filename: String,
    bytes: Vec<u8>,
}

fn manifest() -> &'static EverythingManifest {
    static MANIFEST: OnceLock<EverythingManifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        serde_json::from_str::<ResourceManifest>(RESOURCE_MANIFEST)
            .expect("embedded Everything manifest is valid")
            .everything
    })
}

/// Download, verify, install, and start the managed Everything executable.
#[cfg(target_os = "windows")]
pub async fn install() -> Result<(), String> {
    let _guard = INSTALL_LOCK.lock().await;
    let bin_dir = app_directory_path(AppDirectory::AssetsBin)?;
    let executable = provision(&bin_dir, manifest()).await?;
    start(&executable)?;
    Ok(())
}

/// Everything is only available as a local search provider on Windows.
#[cfg(not(target_os = "windows"))]
pub async fn install() -> Result<(), String> {
    Err("Everything is only available on Windows".to_string())
}

async fn provision(bin_dir: &Path, manifest: &EverythingManifest) -> Result<PathBuf, String> {
    provision_with(
        bin_dir,
        manifest,
        |url, expected_size, expected_sha256| async move {
            info!("Downloading Everything from {url}");
            download_bytes(
                &url,
                expected_size,
                &expected_sha256,
                DownloadTimeouts {
                    connect: Duration::from_secs(DOWNLOAD_CONNECT_TIMEOUT_SECS),
                    operation: Duration::from_secs(DOWNLOAD_TIMEOUT_SECS),
                },
            )
            .await
            .map_err(|error| error.to_string())
        },
    )
    .await
}

async fn provision_with<F, Fut>(
    bin_dir: &Path,
    manifest: &EverythingManifest,
    mut fetch: F,
) -> Result<PathBuf, String>
where
    F: FnMut(String, u64, String) -> Fut,
    Fut: Future<Output = Result<Vec<u8>, String>>,
{
    let executable = bin_dir.join(executable_filename(manifest)?);
    let files_are_valid = managed_files_are_valid(bin_dir, &manifest.files).await?;
    if files_are_valid {
        if !install_record_is_valid(bin_dir, manifest).await? {
            commit(
                bin_dir,
                vec![StagedFile {
                    filename: INSTALL_RECORD_FILENAME.to_string(),
                    bytes: install_record_bytes(manifest)?,
                }],
            )
            .await?;
        }
        info!(
            "Reusing verified Everything installation in {}",
            bin_dir.display()
        );
        return Ok(executable);
    }

    fs::create_dir_all(bin_dir)
        .await
        .map_err(|error| format!("Failed to create Everything directory: {error}"))?;

    let downloaded = match download_direct_files(manifest, &mut fetch).await {
        Ok(files) => files,
        Err(error) => {
            warn!("Everything mirrors failed; trying official archive: {error}");
            download_from_archive(manifest, &mut fetch).await?
        }
    };

    let mut staged = downloaded
        .into_iter()
        .map(|(filename, bytes)| StagedFile { filename, bytes })
        .collect::<Vec<_>>();
    staged.push(StagedFile {
        filename: INSTALL_RECORD_FILENAME.to_string(),
        bytes: install_record_bytes(manifest)?,
    });
    commit(bin_dir, staged).await?;
    info!(
        "Installed Everything {} in {}",
        manifest.version,
        bin_dir.display()
    );
    Ok(executable)
}

async fn download_direct_files<F, Fut>(
    manifest: &EverythingManifest,
    fetch: &mut F,
) -> Result<Vec<(String, Vec<u8>)>, String>
where
    F: FnMut(String, u64, String) -> Fut,
    Fut: Future<Output = Result<Vec<u8>, String>>,
{
    let mut files = Vec::with_capacity(manifest.files.len());
    for file in &manifest.files {
        let mut last_error = String::new();
        let mut downloaded = None;
        for url in &file.mirrors {
            match fetch(url.clone(), file.size, file.sha256.clone()).await {
                Ok(bytes) => {
                    match validate_bytes(&file.filename, &bytes, file.size, &file.sha256) {
                        Ok(()) => {
                            downloaded = Some(bytes);
                            break;
                        }
                        Err(error) => {
                            warn!("Rejected Everything mirror {url}: {error}");
                            last_error = error;
                        }
                    }
                }
                Err(error) => {
                    warn!("Failed to download Everything from {url}: {error}");
                    last_error = error;
                }
            }
        }
        files.push((
            file.filename.clone(),
            downloaded.ok_or_else(|| {
                if last_error.is_empty() {
                    format!("No mirror configured for {}", file.filename)
                } else {
                    format!("No usable mirror supplied {}: {last_error}", file.filename)
                }
            })?,
        ));
    }
    Ok(files)
}

async fn download_from_archive<F, Fut>(
    manifest: &EverythingManifest,
    fetch: &mut F,
) -> Result<Vec<(String, Vec<u8>)>, String>
where
    F: FnMut(String, u64, String) -> Fut,
    Fut: Future<Output = Result<Vec<u8>, String>>,
{
    let archive_bytes = fetch(
        manifest.fallback.url.clone(),
        manifest.fallback.size,
        manifest.fallback.sha256.clone(),
    )
    .await?;
    validate_bytes(
        "Everything archive",
        &archive_bytes,
        manifest.fallback.size,
        &manifest.fallback.sha256,
    )?;

    let mut archive = zip::ZipArchive::new(Cursor::new(archive_bytes))
        .map_err(|error| format!("Failed to read Everything archive: {error}"))?;
    let mut files = Vec::with_capacity(manifest.files.len());
    for file in &manifest.files {
        let Some(index) = find_archive_entry(&archive, &file.archive_path)? else {
            return Err(format!(
                "Everything archive does not contain {}",
                file.archive_path
            ));
        };
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read Everything archive entry: {error}"))?;
        if entry.size() != file.size {
            return Err(format!(
                "Everything archive entry {} has size {}, expected {}",
                file.archive_path,
                entry.size(),
                file.size
            ));
        }
        let mut bytes = Vec::with_capacity(file.size as usize);
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Failed to extract {}: {error}", file.archive_path))?;
        validate_bytes(&file.filename, &bytes, file.size, &file.sha256)?;
        files.push((file.filename.clone(), bytes));
    }
    Ok(files)
}

fn find_archive_entry(
    archive: &zip::ZipArchive<Cursor<Vec<u8>>>,
    archive_path: &str,
) -> Result<Option<usize>, String> {
    for index in 0..archive.len() {
        let Some(entry) = archive.name_for_index(index) else {
            return Err(format!(
                "Failed to read Everything archive entry name at index {index}"
            ));
        };
        let entry = entry.map_err(|error| {
            format!("Failed to decode Everything archive entry name at index {index}: {error}")
        })?;
        if entry.eq_ignore_ascii_case(archive_path) {
            return Ok(Some(index));
        }
    }
    Ok(None)
}

fn validate_bytes(
    filename: &str,
    bytes: &[u8],
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(), String> {
    if bytes.len() as u64 != expected_size {
        return Err(format!(
            "{filename} has size {}, expected {expected_size}",
            bytes.len()
        ));
    }
    let actual = sha256_hex(bytes);
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        return Err(format!(
            "{filename} has SHA-256 {actual}, expected {expected_sha256}"
        ));
    }
    Ok(())
}

async fn managed_files_are_valid(bin_dir: &Path, files: &[ManagedFile]) -> Result<bool, String> {
    for file in files {
        let path = bin_dir.join(checked_filename(&file.filename)?);
        let bytes = match fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(format!(
                    "Failed to read managed file '{}': {error}",
                    path.display()
                ));
            }
        };
        if validate_bytes(&file.filename, &bytes, file.size, &file.sha256).is_err() {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn install_record_is_valid(
    bin_dir: &Path,
    manifest: &EverythingManifest,
) -> Result<bool, String> {
    let path = bin_dir.join(INSTALL_RECORD_FILENAME);
    let bytes = match fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Failed to read Everything install record '{}': {error}",
                path.display()
            ));
        }
    };
    let Ok(record) = serde_json::from_slice::<InstallRecord>(&bytes) else {
        return Ok(false);
    };
    if record.version != manifest.version || record.files.len() != manifest.files.len() {
        return Ok(false);
    }
    Ok(manifest.files.iter().all(|file| {
        record.files.iter().any(|recorded| {
            recorded.filename == file.filename
                && recorded.size == file.size
                && recorded.sha256.eq_ignore_ascii_case(&file.sha256)
        })
    }))
}

fn install_record_bytes(manifest: &EverythingManifest) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(&InstallRecord {
        version: manifest.version.clone(),
        files: manifest
            .files
            .iter()
            .map(|file| InstallRecordFile {
                filename: file.filename.clone(),
                size: file.size,
                sha256: file.sha256.clone(),
            })
            .collect(),
    })
    .map_err(|error| format!("Failed to serialize Everything install record: {error}"))
}

async fn commit(bin_dir: &Path, staged: Vec<StagedFile>) -> Result<(), String> {
    if staged.is_empty() {
        return Ok(());
    }
    let suffix = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let mut temporary_paths = Vec::with_capacity(staged.len());
    for file in &staged {
        let filename = checked_filename(&file.filename)?;
        let temporary = bin_dir.join(format!(".{filename}.{suffix}.tmp"));
        let mut handle = fs::File::create(&temporary)
            .await
            .map_err(|error| format!("Failed to create temporary Everything file: {error}"))?;
        temporary_paths.push(temporary.clone());
        if let Err(error) = handle.write_all(&file.bytes).await {
            cleanup_paths(&temporary_paths).await;
            return Err(format!(
                "Failed to write temporary Everything file: {error}"
            ));
        }
        if let Err(error) = handle.sync_all().await {
            cleanup_paths(&temporary_paths).await;
            return Err(format!("Failed to sync temporary Everything file: {error}"));
        }
    }

    let mut backups: Vec<(PathBuf, PathBuf)> = Vec::with_capacity(staged.len());
    for file in &staged {
        let filename = checked_filename(&file.filename)?;
        let target = bin_dir.join(filename);
        match fs::metadata(&target).await {
            Ok(_) => {
                let backup = bin_dir.join(format!(".{filename}.{suffix}.bak"));
                if let Err(error) = fs::rename(&target, &backup).await {
                    rollback(&mut backups, &temporary_paths, &[]).await;
                    return Err(format!(
                        "Failed to preserve existing Everything file '{}': {error}",
                        target.display()
                    ));
                }
                backups.push((target, backup));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                rollback(&mut backups, &temporary_paths, &[]).await;
                return Err(format!(
                    "Failed to inspect existing Everything file '{}': {error}",
                    target.display()
                ));
            }
        }
    }

    let mut installed = Vec::with_capacity(staged.len());
    for (file, temporary) in staged.iter().zip(temporary_paths.iter()) {
        let target = bin_dir.join(checked_filename(&file.filename)?);
        if let Err(error) = fs::rename(temporary, &target).await {
            rollback(&mut backups, &temporary_paths, &installed).await;
            return Err(format!(
                "Failed to install Everything file '{}': {error}",
                target.display()
            ));
        }
        installed.push(target);
    }

    for (_, backup) in backups {
        let _ = fs::remove_file(backup).await;
    }
    Ok(())
}

async fn rollback(
    backups: &mut Vec<(PathBuf, PathBuf)>,
    temporary_paths: &[PathBuf],
    installed: &[PathBuf],
) {
    for target in installed {
        let _ = fs::remove_file(target).await;
    }
    while let Some((target, backup)) = backups.pop() {
        let _ = fs::rename(backup, target).await;
    }
    cleanup_paths(temporary_paths).await;
}

async fn cleanup_paths(paths: &[PathBuf]) {
    for path in paths {
        let _ = fs::remove_file(path).await;
    }
}

fn executable_filename(manifest: &EverythingManifest) -> Result<&str, String> {
    manifest
        .files
        .iter()
        .map(|file| file.filename.as_str())
        .find(|filename| filename.eq_ignore_ascii_case("Everything.exe"))
        .ok_or_else(|| "Everything manifest does not contain Everything.exe".to_string())
}

fn checked_filename(filename: &str) -> Result<&str, String> {
    if filename.is_empty()
        || filename == "."
        || filename == ".."
        || filename.contains(['/', '\\', ':'])
    {
        return Err(format!("Invalid Everything filename: {filename}"));
    }
    Ok(filename)
}

#[cfg(target_os = "windows")]
fn start(executable: &Path) -> Result<(), String> {
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
    };

    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut command = Command::new(executable);
    command
        .arg("-startup")
        .current_dir(
            executable
                .parent()
                .ok_or_else(|| "Everything executable has no parent directory".to_string())?,
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Failed to start Everything: {error}"))
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        io::Write,
        sync::{Arc, Mutex as StdMutex},
    };

    use super::*;

    #[derive(Default)]
    struct TestSource {
        responses: HashMap<String, Result<Vec<u8>, String>>,
        requests: StdMutex<Vec<String>>,
    }

    impl TestSource {
        fn with_file(mut self, url: &str, bytes: &[u8]) -> Self {
            self.responses.insert(url.to_string(), Ok(bytes.to_vec()));
            self
        }

        fn with_error(mut self, url: &str) -> Self {
            self.responses
                .insert(url.to_string(), Err("simulated failure".to_string()));
            self
        }

        fn requests(&self) -> Vec<String> {
            self.requests.lock().expect("requests").clone()
        }

        fn fetch(&self, url: &str) -> Result<Vec<u8>, String> {
            self.requests
                .lock()
                .expect("requests")
                .push(url.to_string());
            self.responses
                .get(url)
                .cloned()
                .unwrap_or_else(|| Err(format!("unexpected URL {url}")))
        }
    }

    fn manifest_for(files: &[(&str, &[u8])], archive: &[u8]) -> EverythingManifest {
        EverythingManifest {
            version: "1.4.1.1032".to_string(),
            files: files
                .iter()
                .map(|(filename, bytes)| ManagedFile {
                    filename: (*filename).to_string(),
                    size: bytes.len() as u64,
                    sha256: sha256_hex(bytes),
                    archive_path: (*filename).to_string(),
                    mirrors: vec![format!("https://mirror.test/{filename}")],
                })
                .collect(),
            fallback: ArchiveFallback {
                url: "https://official.test/Everything.zip".to_string(),
                size: archive.len() as u64,
                sha256: sha256_hex(archive),
            },
        }
    }

    fn zip_bytes(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut output = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut output);
            let options = zip::write::SimpleFileOptions::default();
            for (filename, bytes) in files {
                writer.start_file(*filename, options).expect("start file");
                writer.write_all(bytes).expect("write file");
            }
            writer.finish().expect("finish zip");
        }
        output.into_inner()
    }

    async fn provision_from(
        directory: &Path,
        manifest: &EverythingManifest,
        source: Arc<TestSource>,
    ) -> Result<PathBuf, String> {
        provision_with(directory, manifest, move |url, _, _| {
            let source = source.clone();
            async move { source.fetch(&url) }
        })
        .await
    }

    #[tokio::test]
    async fn user_given_a_working_mirror_when_installing_then_files_and_record_are_managed() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let exe = b"verified executable";
        let lng = b"verified language";
        let archive = zip_bytes(&[("Everything.exe", exe), ("Everything.lng", lng)]);
        let manifest = manifest_for(
            &[("Everything.exe", exe), ("Everything.lng", lng)],
            &archive,
        );
        let source = Arc::new(
            TestSource::default()
                .with_file("https://mirror.test/Everything.exe", exe)
                .with_file("https://mirror.test/Everything.lng", lng),
        );

        let installed = provision_from(directory.path(), &manifest, source.clone())
            .await
            .expect("install");

        assert_eq!(installed, directory.path().join("Everything.exe"));
        assert_eq!(std::fs::read(&installed).expect("executable"), exe);
        assert_eq!(
            std::fs::read(directory.path().join("Everything.lng")).expect("language"),
            lng
        );
        let record: InstallRecord = serde_json::from_slice(
            &std::fs::read(directory.path().join(INSTALL_RECORD_FILENAME)).expect("record"),
        )
        .expect("valid record");
        assert_eq!(record.version, manifest.version);
        assert_eq!(record.files.len(), 2);
        assert!(!source
            .requests()
            .contains(&"https://official.test/Everything.zip".to_string()));
    }

    #[tokio::test]
    async fn user_given_failed_mirrors_when_installing_then_uses_the_verified_official_archive() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let exe = b"verified executable";
        let lng = b"verified language";
        let archive = zip_bytes(&[("Everything.exe", exe), ("Everything.lng", lng)]);
        let manifest = manifest_for(
            &[("Everything.exe", exe), ("Everything.lng", lng)],
            &archive,
        );
        let source = Arc::new(
            TestSource::default()
                .with_error("https://mirror.test/Everything.exe")
                .with_error("https://mirror.test/Everything.lng")
                .with_file("https://official.test/Everything.zip", &archive),
        );

        provision_from(directory.path(), &manifest, source.clone())
            .await
            .expect("fallback install");

        assert_eq!(
            std::fs::read(directory.path().join("Everything.exe")).expect("executable"),
            exe
        );
        assert!(source
            .requests()
            .contains(&"https://official.test/Everything.zip".to_string()));
    }

    #[tokio::test]
    async fn user_given_a_corrupt_mirror_when_installing_then_tries_the_next_mirror() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let exe = b"verified executable";
        let archive = zip_bytes(&[("Everything.exe", exe)]);
        let mut manifest = manifest_for(&[("Everything.exe", exe)], &archive);
        manifest.files[0].mirrors = vec![
            "https://corrupt.test/Everything.exe".to_string(),
            "https://healthy.test/Everything.exe".to_string(),
        ];
        let source = Arc::new(
            TestSource::default()
                .with_file("https://corrupt.test/Everything.exe", b"corrupt download")
                .with_file("https://healthy.test/Everything.exe", exe),
        );

        provision_from(directory.path(), &manifest, source.clone())
            .await
            .expect("next mirror install");

        assert_eq!(
            source.requests(),
            vec![
                "https://corrupt.test/Everything.exe",
                "https://healthy.test/Everything.exe"
            ]
        );
        assert_eq!(
            std::fs::read(directory.path().join("Everything.exe")).expect("executable"),
            exe
        );
    }

    #[tokio::test]
    async fn user_given_an_archive_with_wrong_inner_digest_when_installing_then_keeps_existing_files(
    ) {
        let directory = tempfile::tempdir().expect("temporary directory");
        let old_exe = b"existing executable";
        std::fs::write(directory.path().join("Everything.exe"), old_exe).expect("existing exe");
        let expected_exe = b"expected executable";
        let lng = b"verified language";
        let archive = zip_bytes(&[("Everything.exe", b"wrong"), ("Everything.lng", lng)]);
        let manifest = manifest_for(
            &[("Everything.exe", expected_exe), ("Everything.lng", lng)],
            &archive,
        );
        let source = Arc::new(
            TestSource::default()
                .with_error("https://mirror.test/Everything.exe")
                .with_file("https://official.test/Everything.zip", &archive),
        );

        assert!(provision_from(directory.path(), &manifest, source)
            .await
            .is_err());
        assert_eq!(
            std::fs::read(directory.path().join("Everything.exe")).expect("existing exe"),
            old_exe
        );
        assert!(!directory.path().join(INSTALL_RECORD_FILENAME).exists());
    }

    #[tokio::test]
    async fn user_given_valid_managed_files_when_reopening_then_does_not_download_again() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let exe = b"verified executable";
        let lng = b"verified language";
        let archive = zip_bytes(&[("Everything.exe", exe), ("Everything.lng", lng)]);
        let manifest = manifest_for(
            &[("Everything.exe", exe), ("Everything.lng", lng)],
            &archive,
        );
        let first_source = Arc::new(
            TestSource::default()
                .with_file("https://mirror.test/Everything.exe", exe)
                .with_file("https://mirror.test/Everything.lng", lng),
        );
        provision_from(directory.path(), &manifest, first_source)
            .await
            .expect("first install");

        let second_source = Arc::new(TestSource::default());
        provision_from(directory.path(), &manifest, second_source.clone())
            .await
            .expect("reuse install");
        assert!(second_source.requests().is_empty());
    }
}
