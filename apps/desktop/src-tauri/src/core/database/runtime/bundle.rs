// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Independent full backups. The command layer holds the storage filesystem gate;
//! these methods hold database maintenance throughout snapshot, publication and merge.

use std::{
    cell::Cell,
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, Metadata},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
};

use futures::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use tempfile::{NamedTempFile, TempDir};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use super::{analytics_snapshot, import::run_import_backup, DatabaseRuntime};
use crate::core::database::{
    contract::{migrate_database, DatabaseContractSource},
    protocol::types::DatabaseImportRequest,
};

const FORMAT: &str = "touchai-full-backup";
const VERSION: u32 = 1;
const MANIFEST_ENTRY: &str = "manifest.json";
const SNAPSHOT_FILE: &str = "touchai.db";
const MAX_FILES: usize = 50_000;
const MAX_ORIGINS: usize = 100_000;
const MAX_BLOBS: usize = MAX_FILES + 1;
const MAX_ENTRIES: usize = MAX_BLOBS + 1;
const MAX_BLOB_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = MAX_EXPANDED_BYTES + 2 * MAX_METADATA_BYTES;
const MAX_JSON_BYTES: i64 = 4 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 32_768;
const MAX_RELATIVE_PATH_BYTES: usize = 4096;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format: String,
    version: u32,
    // This is a label for exact path remapping, never an import filesystem destination.
    cache_root: String,
    windows_paths: bool,
    database: String,
    blobs: Vec<Blob>,
    files: Vec<ManagedFile>,
    origins: Vec<OriginalPath>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Blob {
    sha256: String,
    bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManagedFile {
    path: String,
    blob: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OriginalPath {
    source: String,
    path: String,
}

#[derive(Default)]
struct References {
    files: BTreeMap<String, Option<String>>,
    origins: BTreeMap<String, String>,
    label_bytes: usize,
}

impl DatabaseRuntime {
    pub async fn export_full_backup(&self, target: &Path, cache_root: &Path) -> Result<(), String> {
        let _maintenance = self.maintenance().await?;
        let database_path = self.database_path().to_path_buf();
        let target = target.to_path_buf();
        let platform_cache = cache_root.to_path_buf();
        let cache_root = platform_cache.clone();
        let (workspace, cache_root, target) = blocking({
            let target = target.clone();
            move || {
                require_zip_path(&target)?;
                let database_path = resolve_backup_platform_path(&database_path)?;
                let database_directory = database_parent(&database_path)?;
                let cache_root = resolve_backup_platform_path(&cache_root)?;
                let target = resolve_backup_platform_path(&target)?;
                check_directory(database_directory, false)?;
                check_cache_root(&cache_root)?;
                check_directory(database_parent(&target)?, false)?;
                check_optional_file(&target)?;
                let root = RootLabel::new(path_text(&cache_root)?, cfg!(windows))?;
                if root.relative(path_text(&target)?)?.is_some()
                    || normalized_label(path_text(&target)?, cfg!(windows))
                        == normalized_label(path_text(&cache_root)?, cfg!(windows))
                {
                    return Err(
                        "Full backup destination must be outside the managed cache".to_string()
                    );
                }
                Ok((create_workspace(database_directory)?, cache_root, target))
            }
        })
        .await?;
        let snapshot = workspace.path().join(SNAPSHOT_FILE);
        let result = async {
            // VACUUM INTO includes committed WAL data without checkpoint-and-copy races.
            sqlx::query("VACUUM INTO ?")
                .bind(path_text(&snapshot)?)
                .execute(self.pool())
                .await
                .map_err(|error| format!("Failed to snapshot database for full backup: {error}"))?;
            let prune = self.storage_artifact("backup_refs.sql")?;
            prune_snapshot_metadata(&snapshot, prune).await?;
            let _ = analytics_snapshot::sanitize_analytics_snapshot(&snapshot).await?;
            normalize_snapshot_cache_paths(&snapshot, &platform_cache, &cache_root).await?;
            let references = read_references(&snapshot, path_text(&cache_root)?).await?;
            let workspace_path = workspace.path().to_path_buf();
            blocking(move || {
                write_bundle(&workspace_path, &snapshot, &target, &cache_root, references)
            })
            .await
        }
        .await;
        finish_workspace(workspace, result).await
    }

    pub async fn import_full_backup(
        &self,
        request: DatabaseImportRequest,
        cache_root: &Path,
    ) -> Result<(), String> {
        let _maintenance = self.maintenance().await?;
        let source = PathBuf::from(&request.source_path);
        let cache_root = cache_root.to_path_buf();
        let database_path = self.database_path().to_path_buf();
        let database_parent = database_parent(&database_path)?.to_path_buf();
        let (workspace, manifest, cache_root) = blocking({
            move || {
                require_zip_path(&source)?;
                let database_parent = resolve_backup_platform_path(&database_parent)?;
                let cache_root = resolve_backup_platform_path(&cache_root)?;
                let source = resolve_backup_platform_path(&source)?;
                check_directory(&database_parent, false)?;
                check_cache_root(&cache_root)?;
                check_file(&source)?;
                let workspace = create_workspace(&database_parent)?;
                match unpack_bundle(&source, workspace.path()) {
                    Ok(manifest) => Ok((workspace, manifest, cache_root)),
                    Err(error) => after_cleanup(Err(error), close_workspace(workspace)),
                }
            }
        })
        .await?;
        let snapshot = workspace.path().join(SNAPSHOT_FILE);
        let mut committed = false;
        let result = async {
            prepare_snapshot(
                &snapshot,
                &self.inner.database_contract,
                &manifest,
                &cache_root,
            )
            .await?;
            let import_request = DatabaseImportRequest {
                source_path: path_text(&snapshot)?.to_string(),
                mode: request.mode,
            };
            let publication = blocking({
                let cache_root = cache_root.clone();
                let workspace_path = workspace.path().to_path_buf();
                move || publish_files(&workspace_path, &manifest, &cache_root)
            })
            .await?;
            // Do not call the gated import_backup from inside maintenance.
            let merge = run_import_backup(
                self.pool().clone(),
                database_path,
                self.inner.database_contract.clone(),
                import_request,
            )
            .await;
            match merge {
                Ok(()) => {
                    committed = true;
                    Ok(())
                }
                // The legacy importer reports DETACH errors only after a successful COMMIT.
                // Removing files here would strand committed attachment references.
                Err(error) if error.starts_with("Failed to detach import database:") => {
                    committed = true;
                    Err(error)
                }
                Err(error) => {
                    let rollback = blocking(move || publication.rollback()).await;
                    after_cleanup(Err(error), rollback)
                }
            }
        }
        .await;
        let result = finish_workspace(workspace, result).await;
        if committed {
            result.map_err(|error| format!("database_import_committed:{error}"))
        } else {
            result
        }
    }
}

async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Full backup filesystem worker failed: {error}"))?
}

async fn finish_workspace(workspace: TempDir, result: Result<(), String>) -> Result<(), String> {
    let cleanup = blocking(move || close_workspace(workspace)).await;
    after_cleanup(result, cleanup)
}

fn close_workspace(workspace: TempDir) -> Result<(), String> {
    workspace
        .close()
        .map_err(|error| format!("Failed to remove full backup workspace: {error}"))
}

fn after_cleanup<T>(result: Result<T, String>, cleanup: Result<(), String>) -> Result<T, String> {
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(cleanup)) => Err(format!("{error}; {cleanup}")),
    }
}

fn database_parent(path: &Path) -> Result<&Path, String> {
    path.parent()
        .ok_or_else(|| "Path has no parent directory".to_string())
}

fn path_text(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| "Full backup paths must be valid Unicode".to_string())
}

fn create_workspace(parent: &Path) -> Result<TempDir, String> {
    tempfile::Builder::new()
        .prefix(".touchai-full-backup-")
        .tempdir_in(parent)
        .map_err(|error| format!("Failed to create full backup workspace: {error}"))
}

fn require_zip_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        return Err("Full backup requires an absolute .zip path".to_string());
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Full backup file name is missing or is not valid Unicode".to_string())?;
    safe_relative_path(name)
}

fn is_redirect(metadata: &Metadata) -> bool {
    let symbolic_link = metadata.file_type().is_symlink();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        symbolic_link || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
    }
    #[cfg(not(windows))]
    {
        symbolic_link
    }
}

fn resolve_backup_platform_path(path: &Path) -> Result<PathBuf, String> {
    crate::core::storage::files::resolve_platform_path(path).map_err(|error| {
        format!("Full backup refuses unsafe paths, symbolic links and reparse points: {error}")
    })
}

fn check_directory(path: &Path, allow_missing: bool) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Full backup roots must be absolute paths".to_string());
    }
    let mut current = PathBuf::new();
    let mut missing = false;
    for component in path.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err("Full backup roots must not contain relative path components".to_string());
        }
        current.push(component.as_os_str());
        if matches!(component, Component::Prefix(_)) || missing {
            continue;
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if is_redirect(&metadata) {
                    return Err("Full backup refuses symbolic links and reparse points".to_string());
                }
                if !metadata.is_dir() {
                    return Err("Full backup root contains a non-directory component".to_string());
                }
            }
            Err(error) if allow_missing && error.kind() == io::ErrorKind::NotFound => {
                missing = true
            }
            Err(error) => return Err(format!("Failed to inspect full backup root: {error}")),
        }
    }
    Ok(())
}

fn check_cache_root(root: &Path) -> Result<(), String> {
    let _ = RootLabel::new(path_text(root)?, cfg!(windows))?;
    check_directory(database_parent(root)?, false)?;
    check_directory(root, true)
}

fn check_optional_file(path: &Path) -> Result<Option<Metadata>, String> {
    check_directory(database_parent(path)?, true)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if is_redirect(&metadata) || !metadata.is_file() {
                return Err(
                    "Full backup refuses non-regular files, symbolic links and reparse points"
                        .to_string(),
                );
            }
            Ok(Some(metadata))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to inspect full backup file: {error}")),
    }
}

fn check_file(path: &Path) -> Result<Metadata, String> {
    check_optional_file(path)?.ok_or_else(|| "A referenced full backup file is missing".to_string())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn safe_relative_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > MAX_RELATIVE_PATH_BYTES {
        return Err("Full backup contains an invalid relative path".to_string());
    }
    for component in path.split('/') {
        let device_name = component
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let numbered_device = device_name
            .strip_prefix("COM")
            .or_else(|| device_name.strip_prefix("LPT"));
        if component.is_empty()
            || matches!(component, "." | "..")
            || component.len() > 255
            || component.ends_with([' ', '.'])
            || component.chars().any(|character| {
                character.is_control()
                    || matches!(character, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            })
            || matches!(
                device_name.as_str(),
                "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$"
            )
            || numbered_device.is_some_and(|number| {
                matches!(
                    number,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        {
            return Err("Full backup contains an unsafe relative path".to_string());
        }
    }
    Ok(())
}

// Some historical originals use Windows separators or extended-length prefixes.
// Only labels are normalized; no source label is ever opened during restore.
fn normalized_label(value: &str, windows: bool) -> Option<String> {
    if value.len() > MAX_PATH_BYTES || value.contains('\0') {
        return None;
    }
    if !windows {
        if !value.starts_with('/') {
            return None;
        }
        return Some(format!(
            "/{}",
            value
                .split('/')
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("/")
        ));
    }
    let value = value.replace('\\', "/");
    let value = if let Some(unc) = value.strip_prefix("//?/UNC/") {
        format!("//{unc}")
    } else if let Some(path) = value.strip_prefix("//?/") {
        path.to_string()
    } else {
        value
    };
    let bytes = value.as_bytes();
    let drive =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/';
    if drive || value.starts_with("//") {
        Some(value)
    } else {
        None
    }
}

struct RootLabel {
    windows: bool,
    normalized: String,
}

impl RootLabel {
    fn new(value: &str, windows: bool) -> Result<Self, String> {
        let mut normalized = normalized_label(value, windows)
            .ok_or_else(|| "Full backup contains an invalid cache root label".to_string())?;
        if normalized
            .split('/')
            .any(|component| matches!(component, "." | ".."))
        {
            return Err("Full backup cache root contains relative path components".to_string());
        }
        while normalized.ends_with('/') {
            normalized.pop();
        }
        if normalized.is_empty() || (windows && normalized.len() <= 2) {
            return Err("Full backup cache root must not be a filesystem root".to_string());
        }
        Ok(Self {
            windows,
            normalized,
        })
    }

    fn relative(&self, value: &str) -> Result<Option<String>, String> {
        let Some(normalized) = normalized_label(value, self.windows) else {
            return Ok(None);
        };
        if normalized.len() <= self.normalized.len() {
            return Ok(None);
        }
        let prefix = format!("{}/", self.normalized);
        let matches = if self.windows {
            normalized
                .get(..prefix.len())
                .is_some_and(|start| start.eq_ignore_ascii_case(&prefix))
        } else {
            normalized.starts_with(&prefix)
        };
        if !matches {
            return Ok(None);
        }
        let relative = normalized[prefix.len()..].to_string();
        safe_relative_path(&relative)?;
        Ok(Some(relative))
    }
}

fn managed_hash(path: &str) -> Result<Option<&str>, String> {
    safe_relative_path(path)?;
    let components = path.split('/').collect::<Vec<_>>();
    match components.as_slice() {
        ["attachments", "images" | "files", shard, hash]
            if is_sha256(hash) && *shard == &hash[..3] =>
        {
            Ok(Some(*hash))
        }
        ["clipboard" | "originals" | "temporary", _, ..] => Ok(None),
        _ => Err(
            "Full backup contains a path outside the managed attachment/original roots".to_string(),
        ),
    }
}

impl References {
    fn add_file(&mut self, path: String, hash: Option<String>) -> Result<(), String> {
        if let Some(existing) = self.files.get(&path) {
            if existing != &hash {
                return Err("Full backup has conflicting managed attachment references".to_string());
            }
            return Ok(());
        }
        if self.files.len() >= MAX_FILES {
            return Err("Full backup managed file count budget exceeded".to_string());
        }
        self.reserve_labels(path.len())?;
        self.files.insert(path, hash);
        Ok(())
    }

    fn reserve_labels(&mut self, bytes: usize) -> Result<(), String> {
        self.label_bytes = self
            .label_bytes
            .checked_add(bytes)
            .filter(|bytes| *bytes as u64 <= MAX_MANIFEST_BYTES)
            .ok_or_else(|| "Full backup reference label size budget exceeded".to_string())?;
        Ok(())
    }

    fn add_original(&mut self, source: &str, root: &RootLabel) -> Result<(), String> {
        let Some(path) = root.relative(source)? else {
            return Ok(());
        };
        if !matches!(
            path.split('/').next(),
            Some("attachments" | "clipboard" | "originals" | "temporary")
        ) {
            return Ok(());
        }
        let hash = managed_hash(&path)?.map(str::to_string);
        self.add_file(path.clone(), hash)?;
        if !self.origins.contains_key(source) {
            if self.origins.len() >= MAX_ORIGINS {
                return Err("Full backup original path count budget exceeded".to_string());
            }
            self.reserve_labels(source.len() + path.len())?;
            self.origins.insert(source.to_string(), path);
        }
        Ok(())
    }

    fn add_json(&mut self, value: &Value, root: &RootLabel) -> Result<(), String> {
        match value {
            Value::Array(values) => {
                for value in values {
                    self.add_json(value, root)?;
                }
                Ok(())
            }
            Value::Object(values) => {
                for (key, value) in values {
                    // Prompt prose may start with a cache path; only path metadata owns files.
                    if matches!(
                        key.as_str(),
                        "originPath"
                            | "origin_path"
                            | "path"
                            | "sourcePath"
                            | "source_path"
                            | "filePath"
                            | "file_path"
                    ) {
                        if let Value::String(source) = value {
                            self.add_original(source, root)?;
                        }
                    }
                    self.add_json(value, root)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

async fn prune_snapshot_metadata(path: &Path, sql: String) -> Result<(), String> {
    let mut connection =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path))
            .await
            .map_err(|error| format!("Failed to open backup metadata snapshot: {error}"))?;
    let result = sqlx::query(sqlx::AssertSqlSafe(sql))
        .execute(&mut connection)
        .await
        .map(|_| ())
        .map_err(|error| format!("Failed to prune unreferenced backup metadata: {error}"));
    let close = connection
        .close()
        .await
        .map_err(|error| format!("Failed to close backup metadata snapshot: {error}"));
    after_cleanup(result, close)
}

async fn normalize_snapshot_cache_paths(
    path: &Path,
    logical: &Path,
    physical: &Path,
) -> Result<(), String> {
    if normalized_label(path_text(logical)?, cfg!(windows))
        == normalized_label(path_text(physical)?, cfg!(windows))
    {
        return Ok(());
    }
    let references = read_references(path, path_text(logical)?).await?;
    let remapping = references
        .origins
        .into_iter()
        .map(|(source, relative)| Ok((source, path_text(&physical.join(relative))?.to_string())))
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    let mut connection =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path))
            .await
            .map_err(|error| format!("Failed to open platform-path snapshot: {error}"))?;
    let result = async {
        remap_attachment_origins(&mut connection, &remapping).await?;
        for table in [JsonTable::Parts, JsonTable::Prompts] {
            remap_json_rows(&mut connection, table, &remapping).await?;
        }
        Ok(())
    }
    .await;
    let close = connection
        .close()
        .await
        .map_err(|error| format!("Failed to close platform-path snapshot: {error}"));
    after_cleanup(result, close)
}

async fn read_references(path: &Path, cache_root: &str) -> Result<References, String> {
    let mut connection =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path).read_only(true))
            .await
            .map_err(|error| format!("Failed to open full backup snapshot: {error}"))?;
    let result = collect_references(&mut connection, cache_root, cfg!(windows)).await;
    let close = connection
        .close()
        .await
        .map_err(|error| format!("Failed to close full backup snapshot: {error}"));
    after_cleanup(result, close)
}

async fn collect_references(
    connection: &mut SqliteConnection,
    cache_root: &str,
    windows_paths: bool,
) -> Result<References, String> {
    let root = RootLabel::new(cache_root, windows_paths)?;
    let mut references = References::default();
    {
        let mut rows = sqlx::query_as::<_, (Option<String>, Option<String>, Option<String>, bool)>(
            "SELECT CASE WHEN length(hash) = 64 THEN hash END,
                    CASE WHEN type IN ('image', 'file') THEN type END,
                    CASE WHEN length(CAST(origin_path AS BLOB)) <= ? THEN origin_path END,
                    coalesce(mime_type = 'application/x-directory', 0)
             FROM attachments",
        )
        .bind(MAX_PATH_BYTES as i64)
        .fetch(&mut *connection);
        while let Some((hash, kind, origin, directory)) = rows
            .try_next()
            .await
            .map_err(|error| format!("Failed to read full backup attachment references: {error}"))?
        {
            if directory {
                continue;
            }
            let hash = hash
                .filter(|hash| is_sha256(hash))
                .ok_or_else(|| "Full backup has an invalid attachment hash".to_string())?;
            let kind =
                kind.ok_or_else(|| "Full backup has an invalid attachment type".to_string())?;
            let origin = origin
                .ok_or_else(|| "Full backup original path exceeds its size budget".to_string())?;
            let bucket = if kind == "image" { "images" } else { "files" };
            references.add_file(
                format!("attachments/{bucket}/{}/{hash}", &hash[..3]),
                Some(hash),
            )?;
            references.add_original(&origin, &root)?;
        }
    }
    for table in [JsonTable::Parts, JsonTable::Prompts] {
        let mut rows = sqlx::query_scalar::<_, Option<String>>(table.all_query())
            .bind(MAX_JSON_BYTES)
            .fetch(&mut *connection);
        while let Some(data) = rows
            .try_next()
            .await
            .map_err(|error| format!("Failed to read full backup JSON references: {error}"))?
        {
            let data =
                data.ok_or_else(|| "Full backup JSON reference size budget exceeded".to_string())?;
            let value: Value = serde_json::from_str(&data)
                .map_err(|error| format!("Full backup contains invalid reference JSON: {error}"))?;
            references.add_json(&value, &root)?;
        }
    }
    Ok(references)
}

#[derive(Clone, Copy)]
enum JsonTable {
    Parts,
    Prompts,
}

impl JsonTable {
    fn all_query(self) -> &'static str {
        match self {
            Self::Parts => "SELECT CASE WHEN length(CAST(data AS BLOB)) <= ? THEN data END FROM message_parts",
            Self::Prompts => "SELECT CASE WHEN length(CAST(prompt_snapshot_json AS BLOB)) <= ? THEN prompt_snapshot_json END FROM session_turns",
        }
    }
    fn page_query(self) -> &'static str {
        match self {
            Self::Parts => "SELECT id, CASE WHEN length(CAST(data AS BLOB)) <= ? THEN data END FROM message_parts WHERE (? IS NULL OR id > ?) ORDER BY id LIMIT 8",
            Self::Prompts => "SELECT id, CASE WHEN length(CAST(prompt_snapshot_json AS BLOB)) <= ? THEN prompt_snapshot_json END FROM session_turns WHERE (? IS NULL OR id > ?) ORDER BY id LIMIT 8",
        }
    }
    fn update_query(self) -> &'static str {
        match self {
            Self::Parts => "UPDATE message_parts SET data = ? WHERE id = ?",
            Self::Prompts => "UPDATE session_turns SET prompt_snapshot_json = ? WHERE id = ?",
        }
    }
}

fn copy_and_hash(
    source: &mut impl Read,
    target: &mut impl Write,
    limit: u64,
) -> Result<Blob, String> {
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let length = source
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read full backup content: {error}"))?;
        if length == 0 {
            break;
        }
        bytes = bytes
            .checked_add(length as u64)
            .filter(|bytes| *bytes <= limit)
            .ok_or_else(|| "Full backup content size budget exceeded".to_string())?;
        target
            .write_all(&buffer[..length])
            .map_err(|error| format!("Failed to write full backup content: {error}"))?;
        hasher.update(&buffer[..length]);
    }
    let sha256 = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(Blob { sha256, bytes })
}

fn blob_path(workspace: &Path, sha256: &str) -> PathBuf {
    workspace.join("blobs").join(sha256)
}

fn stage_blob(
    workspace: &Path,
    managed_root: &Path,
    path: &Path,
    expected: Option<&str>,
    blobs: &mut BTreeMap<String, Blob>,
    expanded_bytes: &mut u64,
) -> Result<String, String> {
    let metadata = check_file(path)?;
    if metadata.len() > MAX_BLOB_BYTES {
        return Err("Full backup content size budget exceeded".to_string());
    }
    let mut temporary = NamedTempFile::new_in(workspace.join("blobs"))
        .map_err(|error| format!("Failed to stage full backup content: {error}"))?;
    let mut source = crate::core::storage::files::open_owned(managed_root, path)
        .map_err(|error| format!("Failed to bind full backup content: {error}"))?;
    let blob = copy_and_hash(&mut source, &mut temporary, MAX_BLOB_BYTES)?;
    drop(source);
    if expected.is_some_and(|expected| expected != blob.sha256) {
        return Err("A managed attachment does not match its stored SHA-256 hash".to_string());
    }
    if let Some(existing) = blobs.get(&blob.sha256) {
        if existing.bytes != blob.bytes {
            return Err("Full backup content hash collision".to_string());
        }
    } else {
        let expanded = expanded_bytes
            .checked_add(blob.bytes)
            .filter(|bytes| *bytes <= MAX_EXPANDED_BYTES)
            .ok_or_else(|| "Full backup expanded size budget exceeded".to_string())?;
        if blobs.len() >= MAX_BLOBS {
            return Err("Full backup blob count budget exceeded".to_string());
        }
        let target = blob_path(workspace, &blob.sha256);
        drop(
            temporary
                .persist_noclobber(&target)
                .map_err(|error| format!("Failed to stage full backup blob: {}", error.error))?,
        );
        *expanded_bytes = expanded;
        blobs.insert(blob.sha256.clone(), blob.clone());
    }
    Ok(blob.sha256)
}

fn write_bundle(
    workspace: &Path,
    snapshot: &Path,
    target: &Path,
    cache_root: &Path,
    references: References,
) -> Result<(), String> {
    fs::create_dir(workspace.join("blobs"))
        .map_err(|error| format!("Failed to create full backup blob workspace: {error}"))?;
    let mut blobs = BTreeMap::new();
    let mut expanded_bytes = 0;
    let database = stage_blob(
        workspace,
        workspace,
        snapshot,
        None,
        &mut blobs,
        &mut expanded_bytes,
    )?;
    let mut restored_bytes = blobs[&database].bytes;
    let mut files = Vec::with_capacity(references.files.len());
    for (path, expected) in references.files {
        let _ = managed_hash(&path)?;
        let source = cache_root.join(&path);
        let blob = stage_blob(
            workspace,
            cache_root,
            &source,
            expected.as_deref(),
            &mut blobs,
            &mut expanded_bytes,
        )?;
        restored_bytes = restored_bytes
            .checked_add(blobs[&blob].bytes)
            .filter(|bytes| *bytes <= MAX_EXPANDED_BYTES)
            .ok_or_else(|| "Full backup restored file size budget exceeded".to_string())?;
        files.push(ManagedFile { path, blob });
    }
    let manifest = Manifest {
        format: FORMAT.to_string(),
        version: VERSION,
        cache_root: path_text(cache_root)?.to_string(),
        windows_paths: cfg!(windows),
        database,
        blobs: blobs.into_values().collect(),
        files,
        origins: references
            .origins
            .into_iter()
            .map(|(source, path)| OriginalPath { source, path })
            .collect(),
    };
    validate_manifest(&manifest)?;
    let manifest_bytes = serde_json::to_vec(&manifest)
        .map_err(|error| format!("Failed to serialize full backup manifest: {error}"))?;
    let expanded_bytes = manifest
        .blobs
        .iter()
        .try_fold(manifest_bytes.len() as u64, |bytes, blob| {
            bytes.checked_add(blob.bytes)
        });
    if manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES
        || expanded_bytes.is_none_or(|bytes| bytes > MAX_EXPANDED_BYTES)
    {
        return Err("Full backup manifest or expanded size budget exceeded".to_string());
    }
    check_directory(database_parent(target)?, false)?;
    check_optional_file(target)?;
    let mut temporary = NamedTempFile::new_in(database_parent(target)?)
        .map_err(|error| format!("Failed to create independent full backup archive: {error}"))?;
    let mut archive = ZipWriter::new(temporary.as_file_mut());
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o600);
    archive
        .start_file(MANIFEST_ENTRY, options)
        .map_err(|error| format!("Failed to write full backup manifest entry: {error}"))?;
    archive
        .write_all(&manifest_bytes)
        .map_err(|error| format!("Failed to write full backup manifest: {error}"))?;
    for blob in &manifest.blobs {
        archive
            .start_file(
                format!("blobs/{}", blob.sha256),
                options.large_file(blob.bytes >= zip::ZIP64_BYTES_THR),
            )
            .map_err(|error| format!("Failed to write full backup blob entry: {error}"))?;
        let mut source = File::open(blob_path(workspace, &blob.sha256))
            .map_err(|error| format!("Failed to open staged full backup blob: {error}"))?;
        let actual = copy_and_hash(&mut source, &mut archive, blob.bytes)?;
        if &actual != blob {
            return Err("Staged full backup content failed SHA-256 verification".to_string());
        }
    }
    let _ = archive
        .finish()
        .map_err(|error| format!("Failed to finish full backup archive: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("Failed to flush full backup archive: {error}"))?;
    if temporary
        .as_file()
        .metadata()
        .map_err(|error| error.to_string())?
        .len()
        > MAX_ARCHIVE_BYTES
    {
        return Err("Full backup archive size budget exceeded".to_string());
    }
    zip_directory_budget(temporary.as_file_mut())?;
    check_directory(database_parent(target)?, false)?;
    check_optional_file(target)?;
    // Atomic replacement changes the destination name, never an existing live inode.
    drop(
        temporary
            .persist(target)
            .map_err(|error| format!("Failed to publish full backup archive: {}", error.error))?,
    );
    Ok(())
}

fn validate_manifest(manifest: &Manifest) -> Result<BTreeMap<&str, &Blob>, String> {
    if manifest.format != FORMAT || manifest.version != VERSION {
        return Err("Unsupported full backup manifest format or version".to_string());
    }
    let root = RootLabel::new(&manifest.cache_root, manifest.windows_paths)?;
    if manifest.files.len() > MAX_FILES
        || manifest.origins.len() > MAX_ORIGINS
        || manifest.blobs.len() > MAX_BLOBS
    {
        return Err("Full backup manifest count budget exceeded".to_string());
    }
    if !is_sha256(&manifest.database) {
        return Err("Full backup has an invalid database blob hash".to_string());
    }
    let mut blobs = BTreeMap::new();
    let mut expanded = 0_u64;
    for blob in &manifest.blobs {
        if !is_sha256(&blob.sha256) || blob.bytes > MAX_BLOB_BYTES {
            return Err(
                "Full backup has an invalid blob hash or exceeds the blob size budget".to_string(),
            );
        }
        if blobs.insert(blob.sha256.as_str(), blob).is_some() {
            return Err("Full backup has duplicate blob hashes".to_string());
        }
        expanded = expanded
            .checked_add(blob.bytes)
            .filter(|bytes| *bytes <= MAX_EXPANDED_BYTES)
            .ok_or_else(|| "Full backup expanded size budget exceeded".to_string())?;
    }
    let database = blobs
        .get(manifest.database.as_str())
        .ok_or_else(|| "Full backup database blob is missing".to_string())?;
    if database.bytes == 0 {
        return Err("Full backup database blob is empty".to_string());
    }
    let mut used_blobs = BTreeSet::from([manifest.database.as_str()]);
    let mut files = BTreeSet::new();
    let mut casefolded = BTreeSet::new();
    let mut restored_bytes = database.bytes;
    for file in &manifest.files {
        let expected = managed_hash(&file.path)?;
        let blob = blobs
            .get(file.blob.as_str())
            .ok_or_else(|| "Full backup managed file references a missing blob".to_string())?;
        if expected.is_some_and(|hash| hash != file.blob) {
            return Err("Full backup attachment path does not match its blob SHA-256".to_string());
        }
        if !files.insert(file.path.as_str()) || !casefolded.insert(file.path.to_lowercase()) {
            return Err("Full backup has duplicate managed paths".to_string());
        }
        used_blobs.insert(file.blob.as_str());
        restored_bytes = restored_bytes
            .checked_add(blob.bytes)
            .filter(|bytes| *bytes <= MAX_EXPANDED_BYTES)
            .ok_or_else(|| "Full backup restored file size budget exceeded".to_string())?;
    }
    for path in &casefolded {
        let mut parent = path.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            if casefolded.contains(prefix) {
                return Err("Full backup has conflicting file and directory paths".to_string());
            }
            parent = prefix;
        }
    }
    let mut origins = BTreeSet::new();
    for origin in &manifest.origins {
        if !origins.insert(origin.source.as_str()) {
            return Err("Full backup has duplicate original path mappings".to_string());
        }
        if !files.contains(origin.path.as_str())
            || root.relative(&origin.source)?.as_deref() != Some(origin.path.as_str())
        {
            return Err(
                "Full backup original path mapping is not a restored managed file".to_string(),
            );
        }
    }
    if used_blobs.len() != blobs.len() {
        return Err("Full backup has unreferenced content blobs".to_string());
    }
    Ok(blobs)
}

// zip 9.1 allocates its file table from footer counts before exposing len().
// These fixed-footer guards bound that allocation; zip still parses and validates
// every central/local header. V1 uses ordinary, unprefixed ZIP32/ZIP64 without comments.
fn zip_directory_budget(file: &mut File) -> Result<(), String> {
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    if !(22..=MAX_ARCHIVE_BYTES).contains(&length) {
        return Err("Full backup archive size budget exceeded or archive is truncated".to_string());
    }
    let footer = read_at::<22>(file, length - 22)?;
    if &footer[..4] != b"PK\x05\x06"
        || u16_at(&footer, 20) != 0
        || u16_at(&footer, 4) != 0
        || u16_at(&footer, 6) != 0
        || u16_at(&footer, 8) != u16_at(&footer, 10)
    {
        return Err(
            "Full backup requires an unprefixed single-disk ZIP archive without comments"
                .to_string(),
        );
    }
    let mut count = u64::from(u16_at(&footer, 10));
    let mut bytes = u64::from(u32_at(&footer, 12));
    let mut start = u64::from(u32_at(&footer, 16));
    let mut end = length - 22;
    if count == u64::from(u16::MAX) || bytes == u64::from(u32::MAX) || start == u64::from(u32::MAX)
    {
        let locator_start = length
            .checked_sub(42)
            .ok_or_else(|| "Truncated ZIP64 full backup footer".to_string())?;
        let locator = read_at::<20>(file, locator_start)?;
        if &locator[..4] != b"PK\x06\x07" || u32_at(&locator, 4) != 0 || u32_at(&locator, 16) != 1 {
            return Err("Invalid ZIP64 full backup locator".to_string());
        }
        end = u64_at(&locator, 8);
        if end.checked_add(56) != Some(locator_start) {
            return Err("Unsupported ZIP64 full backup footer size".to_string());
        }
        let footer64 = read_at::<56>(file, end)?;
        if &footer64[..4] != b"PK\x06\x06"
            || u64_at(&footer64, 4) != 44
            || u32_at(&footer64, 16) != 0
            || u32_at(&footer64, 20) != 0
            || u64_at(&footer64, 24) != u64_at(&footer64, 32)
        {
            return Err("Invalid ZIP64 full backup footer".to_string());
        }
        count = u64_at(&footer64, 32);
        bytes = u64_at(&footer64, 40);
        start = u64_at(&footer64, 48);
    }
    if !(2..=MAX_ENTRIES as u64).contains(&count) {
        return Err("Full backup archive entry count budget exceeded".to_string());
    }
    if bytes > MAX_METADATA_BYTES || bytes < count * 46 || start.checked_add(bytes) != Some(end) {
        return Err(
            "Full backup ZIP metadata size budget exceeded or directory is invalid".to_string(),
        );
    }
    if read_at::<4>(file, start)? != *b"PK\x01\x02" {
        return Err("Full backup ZIP central directory is invalid".to_string());
    }
    Ok(())
}

fn read_at<const N: usize>(file: &mut File, offset: u64) -> Result<[u8; N], String> {
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("Failed to seek full backup metadata: {error}"))?;
    let mut bytes = [0_u8; N];
    file.read_exact(&mut bytes)
        .map_err(|error| format!("Failed to read full backup metadata: {error}"))?;
    Ok(bytes)
}
fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}
fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}
fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7],
    ])
}

struct MetadataBudgetReader<'a> {
    file: File,
    remaining: &'a Cell<Option<u64>>,
}
impl Read for MetadataBudgetReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let limit = match self.remaining.get() {
            Some(0) => {
                return Err(io::Error::other(
                    "Full backup ZIP metadata read budget exceeded",
                ))
            }
            Some(remaining) => buffer.len().min(remaining as usize),
            None => buffer.len(),
        };
        let length = self.file.read(&mut buffer[..limit])?;
        if let Some(remaining) = self.remaining.get() {
            self.remaining.set(Some(remaining - length as u64));
        }
        Ok(length)
    }
}
impl Seek for MetadataBudgetReader<'_> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.file.seek(position)
    }
}

fn unpack_bundle(source: &Path, workspace: &Path) -> Result<Manifest, String> {
    let mut source = File::open(source)
        .map_err(|error| format!("Failed to open full backup archive: {error}"))?;
    zip_directory_budget(&mut source)?;
    let remaining = Cell::new(Some(2 * MAX_METADATA_BYTES));
    let mut archive = ZipArchive::with_config(
        zip::read::Config {
            archive_offset: zip::read::ArchiveOffset::Known(0),
        },
        MetadataBudgetReader {
            file: source,
            remaining: &remaining,
        },
    )
    .map_err(|error| format!("Failed to read full backup archive: {error}"))?;
    if archive.has_duplicate_names() || archive.len() > MAX_ENTRIES {
        return Err(
            "Full backup has duplicate entries or exceeds the entry count budget".to_string(),
        );
    }
    let mut entries = BTreeMap::new();
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index_data(index)
            .map_err(|error| format!("Failed to inspect full backup entry: {error}"))?;
        let name = entry
            .name()
            .map_err(|error| format!("Invalid full backup entry name: {error}"))?
            .into_owned();
        safe_relative_path(&name)?;
        if entry.enclosed_name().is_none()
            || !entry.is_file()
            || entry.is_symlink()
            || !entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o100000)
            || entry.external_attributes() & 0x400 != 0
            || entry.encrypted()
            || !matches!(
                entry.compression(),
                CompressionMethod::Stored | CompressionMethod::Deflated
            )
        {
            return Err("Full backup refuses non-regular entries, symbolic links, reparse points and encrypted content".to_string());
        }
        let limit = if name == MANIFEST_ENTRY {
            MAX_MANIFEST_BYTES
        } else {
            if !name.strip_prefix("blobs/").is_some_and(is_sha256) {
                return Err("Full backup contains an unexpected archive path".to_string());
            }
            MAX_BLOB_BYTES
        };
        if entry.size() > limit {
            return Err("Full backup archive entry size budget exceeded".to_string());
        }
        expanded = expanded
            .checked_add(entry.size())
            .filter(|bytes| *bytes <= MAX_EXPANDED_BYTES)
            .ok_or_else(|| "Full backup expanded size budget exceeded".to_string())?;
        if entries.insert(name, (index, entry.size())).is_some() {
            return Err("Full backup has duplicate decoded entry paths".to_string());
        }
    }
    remaining.set(Some(4 * MAX_METADATA_BYTES));
    archive
        .validate_header_consistency()
        .map_err(|error| format!("Invalid full backup ZIP headers: {error}"))?;
    remaining.set(None);
    let (manifest_index, manifest_size) = entries
        .get(MANIFEST_ENTRY)
        .copied()
        .ok_or_else(|| "Full backup manifest is missing".to_string())?;
    let manifest = {
        let mut entry = archive
            .by_index(manifest_index)
            .map_err(|error| format!("Failed to open full backup manifest: {error}"))?;
        let mut bytes = Vec::new();
        let _ = copy_and_hash(&mut entry, &mut bytes, MAX_MANIFEST_BYTES)?;
        if bytes.len() as u64 != manifest_size {
            return Err("Full backup manifest size does not match its ZIP entry".to_string());
        }
        serde_json::from_slice::<Manifest>(&bytes)
            .map_err(|error| format!("Invalid full backup manifest: {error}"))?
    };
    let blobs = validate_manifest(&manifest)?;
    if entries.len() != blobs.len() + 1 {
        return Err("Full backup archive entries do not match its manifest".to_string());
    }
    fs::create_dir(workspace.join("blobs"))
        .map_err(|error| format!("Failed to create full backup restore workspace: {error}"))?;
    for blob in blobs.values() {
        let name = format!("blobs/{}", blob.sha256);
        let (index, size) = entries
            .get(&name)
            .copied()
            .ok_or_else(|| "Full backup blob entry is missing".to_string())?;
        if size != blob.bytes {
            return Err("Full backup blob size does not match its manifest".to_string());
        }
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to open full backup blob: {error}"))?;
        let mut target = File::options()
            .write(true)
            .create_new(true)
            .open(blob_path(workspace, &blob.sha256))
            .map_err(|error| format!("Failed to stage restored full backup blob: {error}"))?;
        let actual = copy_and_hash(&mut entry, &mut target, blob.bytes)?;
        if &actual != *blob {
            return Err("Full backup blob failed SHA-256 verification".to_string());
        }
    }
    drop(blobs);
    drop(archive);
    let database = blob_path(workspace, &manifest.database);
    let mut database_file = File::open(&database)
        .map_err(|error| format!("Failed to open full backup database blob: {error}"))?;
    if read_at::<16>(&mut database_file, 0)? != *b"SQLite format 3\0" {
        return Err("Full backup database blob is not a SQLite snapshot".to_string());
    }
    drop(database_file);
    fs::copy(&database, workspace.join(SNAPSHOT_FILE))
        .map_err(|error| format!("Failed to prepare restored full backup database: {error}"))?;
    Ok(manifest)
}

async fn prepare_snapshot(
    path: &Path,
    contract: &DatabaseContractSource,
    manifest: &Manifest,
    cache_root: &Path,
) -> Result<(), String> {
    let mut connection =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path))
            .await
            .map_err(|error| format!("Failed to open restored full backup database: {error}"))?;
    let result = async {
        // Run file-reading PRAGMAs only after we own a connection we can close on error.
        sqlx::query("PRAGMA journal_mode = DELETE")
            .execute(&mut connection)
            .await
            .map_err(|error| format!("Failed to prepare full backup database journal: {error}"))?;
        let is_touchai: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM touchai_meta WHERE key = 'app_id' AND value = 'touchai')",
        )
        .fetch_one(&mut connection)
        .await
        .map_err(|error| format!("Failed to validate full backup database identity: {error}"))?;
        if !is_touchai {
            return Err("Full backup does not contain a TouchAI database".to_string());
        }
        let integrity: String = sqlx::query_scalar("PRAGMA quick_check(1)")
            .fetch_one(&mut connection)
            .await
            .map_err(|error| format!("Failed to check full backup database integrity: {error}"))?;
        if integrity != "ok" {
            return Err("Full backup database failed its SQLite integrity check".to_string());
        }
        migrate_database(&mut connection, contract).await?;
        if sqlx::query("PRAGMA foreign_key_check")
            .fetch_optional(&mut connection)
            .await
            .map_err(|error| format!("Failed to validate full backup foreign keys: {error}"))?
            .is_some()
        {
            return Err("Full backup database contains invalid foreign key references".to_string());
        }
        let references = collect_references(
            &mut connection,
            &manifest.cache_root,
            manifest.windows_paths,
        )
        .await?;
        if references.files.len() != manifest.files.len()
            || references.origins.len() != manifest.origins.len()
        {
            return Err("Full backup file map does not match its database references".to_string());
        }
        for file in &manifest.files {
            let expected = references
                .files
                .get(&file.path)
                .ok_or_else(|| "Full backup includes an unreferenced managed file".to_string())?;
            if expected.as_ref().is_some_and(|hash| hash != &file.blob) {
                return Err(
                    "Full backup attachment blob does not match its database reference".to_string(),
                );
            }
        }
        for origin in &manifest.origins {
            if references.origins.get(&origin.source) != Some(&origin.path) {
                return Err(
                    "Full backup original mappings do not match its database references"
                        .to_string(),
                );
            }
        }
        let remapping = manifest
            .origins
            .iter()
            .map(|origin| {
                Ok((
                    origin.source.clone(),
                    path_text(&cache_root.join(&origin.path))?.to_string(),
                ))
            })
            .collect::<Result<BTreeMap<_, _>, String>>()?;
        let mut transaction = connection
            .begin()
            .await
            .map_err(|error| format!("Failed to begin full backup path remapping: {error}"))?;
        remap_attachment_origins(&mut transaction, &remapping).await?;
        for table in [JsonTable::Parts, JsonTable::Prompts] {
            remap_json_rows(&mut transaction, table, &remapping).await?;
        }
        transaction
            .commit()
            .await
            .map_err(|error| format!("Failed to commit full backup path remapping: {error}"))?;
        Ok(())
    }
    .await;
    // SQLite worker threads must release their Windows handles before TempDir cleanup.
    let close = connection
        .close()
        .await
        .map_err(|error| format!("Failed to close restored full backup database: {error}"));
    after_cleanup(result, close)
}

async fn remap_attachment_origins(
    connection: &mut SqliteConnection,
    remapping: &BTreeMap<String, String>,
) -> Result<(), String> {
    let mut after: Option<i64> = None;
    loop {
        let rows: Vec<(i64, Option<String>)> = sqlx::query_as(
            "SELECT id, CASE WHEN length(CAST(origin_path AS BLOB)) <= ? THEN origin_path END FROM attachments WHERE (? IS NULL OR id > ?) ORDER BY id LIMIT 128",
        ).bind(MAX_PATH_BYTES as i64).bind(after).bind(after).fetch_all(&mut *connection).await.map_err(|error| format!("Failed to read restored attachment origins: {error}"))?;
        if rows.is_empty() {
            return Ok(());
        }
        for (id, origin) in rows {
            let origin = origin
                .ok_or_else(|| "Full backup original path exceeds its size budget".to_string())?;
            if let Some(target) = remapping.get(&origin) {
                sqlx::query("UPDATE attachments SET origin_path = ? WHERE id = ?")
                    .bind(target)
                    .bind(id)
                    .execute(&mut *connection)
                    .await
                    .map_err(|error| {
                        format!("Failed to remap restored attachment origin: {error}")
                    })?;
            }
            after = Some(id);
        }
    }
}

fn remap_json(value: &mut Value, remapping: &BTreeMap<String, String>) -> bool {
    match value {
        Value::String(value) => {
            if let Some(target) = remapping.get(value) {
                *value = target.clone();
                true
            } else {
                false
            }
        }
        Value::Array(values) => values.iter_mut().fold(false, |changed, value| {
            remap_json(value, remapping) || changed
        }),
        Value::Object(values) => values.values_mut().fold(false, |changed, value| {
            remap_json(value, remapping) || changed
        }),
        _ => false,
    }
}

async fn remap_json_rows(
    connection: &mut SqliteConnection,
    table: JsonTable,
    remapping: &BTreeMap<String, String>,
) -> Result<(), String> {
    let mut after: Option<i64> = None;
    loop {
        let rows: Vec<(i64, Option<String>)> = sqlx::query_as(table.page_query())
            .bind(MAX_JSON_BYTES)
            .bind(after)
            .bind(after)
            .fetch_all(&mut *connection)
            .await
            .map_err(|error| format!("Failed to read restored reference JSON: {error}"))?;
        if rows.is_empty() {
            return Ok(());
        }
        for (id, data) in rows {
            let data =
                data.ok_or_else(|| "Full backup JSON reference size budget exceeded".to_string())?;
            let mut value: Value = serde_json::from_str(&data)
                .map_err(|error| format!("Full backup contains invalid reference JSON: {error}"))?;
            if remap_json(&mut value, remapping) {
                let data = serde_json::to_string(&value).map_err(|error| {
                    format!("Failed to serialize restored reference JSON: {error}")
                })?;
                if data.len() as i64 > MAX_JSON_BYTES {
                    return Err("Remapped full backup JSON exceeds its size budget".to_string());
                }
                sqlx::query(table.update_query())
                    .bind(data)
                    .bind(id)
                    .execute(&mut *connection)
                    .await
                    .map_err(|error| format!("Failed to remap restored reference JSON: {error}"))?;
            }
            after = Some(id);
        }
    }
}

struct Publication {
    root: PathBuf,
    files: Vec<(String, Option<crate::core::storage::files::FileIdentity>)>,
    directories: Vec<PathBuf>,
}

impl Publication {
    fn rollback(self) -> Result<(), String> {
        let mut errors = Vec::new();
        for (path, identity) in self.files.into_iter().rev() {
            let target = self.root.join(path);
            let result = check_optional_file(&target).and_then(|metadata| {
                if metadata.is_none() {
                    return Ok(());
                }
                let identity = identity.ok_or_else(|| {
                    "Cannot identify a newly restored file for rollback".to_string()
                })?;
                crate::core::storage::files::remove_owned(&self.root, &target, &identity)
            });
            if let Err(error) = result {
                errors.push(error);
            }
        }
        for directory in self.directories.into_iter().rev() {
            let result = check_directory(&directory, false).and_then(|()| {
                fs::remove_dir(directory).map_err(|error| {
                    format!("Failed to remove newly created restore directory: {error}")
                })
            });
            if let Err(error) = result {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

fn create_restore_directory(path: &Path, publication: &mut Publication) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => check_directory(path, false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            check_directory(database_parent(path)?, false)?;
            match fs::create_dir(path) {
                Ok(()) => {
                    publication.directories.push(path.to_path_buf());
                    Ok(())
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    check_directory(path, false)
                }
                Err(error) => Err(format!(
                    "Failed to create restored managed directory: {error}"
                )),
            }
        }
        Err(error) => Err(format!(
            "Failed to inspect restored managed directory: {error}"
        )),
    }
}

fn verify_existing(path: &Path, blob: &Blob) -> Result<bool, String> {
    let Some(metadata) = check_optional_file(path)? else {
        return Ok(false);
    };
    if metadata.len() != blob.bytes {
        return Err("Full backup conflicts with an existing managed file; local content was not overwritten".to_string());
    }
    let mut source = File::open(path)
        .map_err(|error| format!("Failed to verify existing restored content: {error}"))?;
    let actual = copy_and_hash(&mut source, &mut io::sink(), blob.bytes)?;
    if &actual != blob {
        return Err("Full backup conflicts with an existing managed file; local content was not overwritten".to_string());
    }
    Ok(true)
}

fn immutable_managed_path(path: &str, blob: &str) -> bool {
    if managed_hash(path).ok().flatten().is_some() {
        return true;
    }
    let name = path.rsplit('/').next().unwrap_or_default();
    if path.starts_with("temporary/") {
        return name.starts_with("browser-screenshot-") && name.ends_with(".png");
    }
    if path.starts_with("clipboard/") && path.split('/').count() == 2 {
        return name.rsplit_once('.').is_some_and(|(stem, extension)| {
            !stem.is_empty()
                && stem.bytes().all(|byte| byte.is_ascii_digit())
                && matches!(extension, "png" | "svg")
        });
    }
    path.starts_with("originals/") && name == blob
}

fn publish_files(
    workspace: &Path,
    manifest: &Manifest,
    cache_root: &Path,
) -> Result<Publication, String> {
    check_cache_root(cache_root)?;
    let blobs = validate_manifest(manifest)?;
    let snapshot_bytes = check_file(&workspace.join(SNAPSHOT_FILE))?.len();
    if snapshot_bytes > MAX_BLOB_BYTES {
        return Err("Restored full backup database size budget exceeded".to_string());
    }
    let mut absent = Vec::new();
    for file in &manifest.files {
        let blob = blobs
            .get(file.blob.as_str())
            .ok_or_else(|| "Full backup managed blob is missing".to_string())?;
        if !verify_existing(&cache_root.join(&file.path), blob)? {
            absent.push((file, *blob));
        }
    }
    let mut publication = Publication {
        root: cache_root.to_path_buf(),
        files: Vec::new(),
        directories: Vec::new(),
    };
    let result = (|| {
        if absent.is_empty() {
            return Ok(());
        }
        create_restore_directory(cache_root, &mut publication)?;
        for (file, blob) in absent {
            let target = cache_root.join(&file.path);
            let mut parent = cache_root.to_path_buf();
            let components = file.path.split('/').collect::<Vec<_>>();
            for component in &components[..components.len() - 1] {
                parent.push(component);
                create_restore_directory(&parent, &mut publication)?;
            }
            if verify_existing(&target, blob)? {
                continue;
            }
            let immutable = immutable_managed_path(&file.path, &blob.sha256);
            let mut temporary = NamedTempFile::new_in(&parent)
                .map_err(|error| format!("Failed to prepare restored managed file: {error}"))?;
            let mut source = File::open(blob_path(workspace, &blob.sha256))
                .map_err(|error| format!("Failed to open verified restore blob: {error}"))?;
            let actual = copy_and_hash(&mut source, &mut temporary, blob.bytes)?;
            drop(source);
            if &actual != blob {
                return Err(
                    "Restored file failed SHA-256 verification before publication".to_string(),
                );
            }
            temporary
                .as_file()
                .sync_all()
                .map_err(|error| format!("Failed to flush restored managed file: {error}"))?;
            check_directory(&parent, false)?;
            let identity = crate::core::storage::files::physical_handle(temporary.as_file())?
                .identity
                .ok_or_else(|| "Restored managed file has no physical identity".to_string())?;
            match temporary.persist_noclobber(&target) {
                Ok(file_handle) => {
                    drop(file_handle);
                    publication.files.push((file.path.clone(), Some(identity)));
                    if immutable {
                        crate::core::storage::files::mark_immutable(&target)?;
                    }
                }
                Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
                    // persist_noclobber never truncates an existing original, even if it appeared late.
                    drop(error.file);
                    if !verify_existing(&target, blob)? {
                        return Err(
                            "Restored managed file disappeared during publication".to_string()
                        );
                    }
                }
                Err(error) => {
                    return Err(format!(
                        "Failed to publish restored managed file: {}",
                        error.error
                    ))
                }
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => Ok(publication),
        Err(error) => after_cleanup(Err(error), publication.rollback()),
    }
}

#[cfg(test)]
#[path = "bundle_tests.rs"]
mod tests;
