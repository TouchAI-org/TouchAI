//! App-owned storage accounting, publication and explicit maintenance.

pub(crate) mod files;
mod selection;

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime},
};

use futures::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use tokio::sync::{Mutex, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

use crate::core::database::DatabaseRuntime;
use files::{FileIdentity, PhysicalFile};

const MAX_ENTRIES: usize = 100_000;
const MAX_ROWS: usize = 100_000;
const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
const MAX_ACTIVITIES: usize = 128;
const MAX_PIN_PATHS: usize = 256;
const MAX_PIN_BYTES: usize = 256 * 1024;
const TOTAL_PIN_BUDGET: usize = 8 * 1024 * 1024;
const UNUSED_GRACE: Duration = Duration::from_secs(24 * 60 * 60);
const THUMBNAIL_BUDGET: u64 = 256 * 1024 * 1024;
const CLIPBOARD_BUDGET: u64 = 256 * 1024 * 1024;
const CLIPBOARD_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageCategory {
    Attachments,
    Clipboard,
    Thumbnails,
    Temporary,
    Recordings,
    Logs,
    Database,
    Assets,
    Browser,
}

const CATEGORIES: [StorageCategory; 9] = [
    StorageCategory::Attachments,
    StorageCategory::Clipboard,
    StorageCategory::Thumbnails,
    StorageCategory::Temporary,
    StorageCategory::Recordings,
    StorageCategory::Logs,
    StorageCategory::Database,
    StorageCategory::Assets,
    StorageCategory::Browser,
];
const SAFE_CATEGORIES: [StorageCategory; 4] = [
    StorageCategory::Attachments,
    StorageCategory::Clipboard,
    StorageCategory::Thumbnails,
    StorageCategory::Temporary,
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCategoryUsage {
    pub id: StorageCategory,
    pub bytes: u64,
    pub reclaimable_bytes: u64,
    pub file_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSummary {
    pub categories: Vec<StorageCategoryUsage>,
    pub total_bytes: u64,
    pub reclaimable_bytes: u64,
    pub database_free_bytes: u64,
    pub warnings: Vec<String>,
    pub busy: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageFailure {
    pub path: String,
    pub code: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCleanupResult {
    pub removed_files: usize,
    pub released_bytes: u64,
    pub pending_bytes: u64,
    pub failed_files: usize,
    pub failures: Vec<StorageFailure>,
    pub summary: StorageSummary,
    pub restart_required: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StorageCleanupSelection {
    pub unused: bool,
    pub categories: Vec<StorageCategory>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCompactionResult {
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub released_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedAttachment {
    pub hash: String,
    pub path: String,
    pub size: u64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryKind {
    Sessions,
    Messages,
    Turns,
}

struct Activity {
    window: String,
    _guard: Option<OwnedRwLockReadGuard<()>>,
    paths: Vec<PathBuf>,
}

#[derive(Clone)]
pub struct StorageRuntime {
    database: DatabaseRuntime,
    cache: PathBuf,
    gate: Arc<RwLock<()>>,
    activities: Arc<Mutex<HashMap<String, Activity>>>,
}

struct AttachmentRow {
    id: i64,
    hash: String,
    kind: String,
    origin: String,
    directory: bool,
    expired: bool,
}

struct References {
    protected: HashSet<String>,
    orphan_ids: Vec<i64>,
}

struct Entry {
    root: PathBuf,
    path: PathBuf,
    category: StorageCategory,
    physical: PhysicalFile,
    candidate: bool,
    modified: SystemTime,
}

fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        let value = if let Some(unc) = value.strip_prefix("//?/UNC/") {
            format!("//{unc}")
        } else {
            value.strip_prefix("//?/").unwrap_or(&value).to_string()
        };
        value.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        value
    }
}

impl StorageRuntime {
    pub fn new(database: DatabaseRuntime, cache: PathBuf) -> Self {
        Self {
            database,
            cache,
            gate: Arc::new(RwLock::new(())),
            activities: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn cache_root(&self) -> &Path {
        &self.cache
    }

    async fn physical_cache_root(&self) -> Result<PathBuf, String> {
        let cache = self.cache.clone();
        tokio::task::spawn_blocking(move || files::resolve_platform_path(&cache))
            .await
            .map_err(|_| "storage_io_failed".to_string())?
    }

    fn protection_key(&self, path: &Path, physical_cache: &Path) -> String {
        let key = path_key(path);
        let logical = format!("{}/", path_key(&self.cache).trim_end_matches('/'));
        if let Some(relative) = key.strip_prefix(&logical) {
            format!(
                "{}/{relative}",
                path_key(physical_cache).trim_end_matches('/')
            )
        } else {
            key
        }
    }

    pub(crate) async fn access(&self) -> OwnedRwLockReadGuard<()> {
        self.gate.clone().read_owned().await
    }

    pub(crate) fn blocking_access(&self) -> tokio::sync::RwLockReadGuard<'_, ()> {
        self.gate.blocking_read()
    }

    pub(crate) async fn exclusive(&self) -> Result<OwnedRwLockWriteGuard<()>, String> {
        self.gate
            .clone()
            .try_write_owned()
            .map_err(|_| "storage_busy".into())
    }

    pub async fn hold(&self, window: &str) -> Result<String, String> {
        let guard = self
            .gate
            .clone()
            .try_read_owned()
            .map_err(|_| "storage_busy")?;
        let mut activities = self.activities.lock().await;
        if activities.len() >= MAX_ACTIVITIES {
            return Err("storage_busy".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        activities.insert(
            id.clone(),
            Activity {
                window: window.to_string(),
                _guard: Some(guard),
                paths: Vec::new(),
            },
        );
        Ok(id)
    }

    pub async fn pin_paths(&self, window: &str, paths: Vec<PathBuf>) -> Result<String, String> {
        if paths.len() > MAX_PIN_PATHS {
            return Err("storage_busy".into());
        }
        let bytes: usize = paths.iter().map(|path| path.as_os_str().len()).sum();
        if bytes > MAX_PIN_BYTES {
            return Err("storage_busy".into());
        }
        let physical_cache = self.physical_cache_root().await?;
        let mut activities = self.activities.lock().await;
        if activities.len() >= MAX_ACTIVITIES
            || !activities
                .values()
                .any(|activity| activity.window == window && activity._guard.is_some())
        {
            return Err("storage_busy".into());
        }
        let retained: usize = activities
            .values()
            .flat_map(|activity| &activity.paths)
            .map(|path| path.as_os_str().len())
            .sum();
        if retained.saturating_add(bytes) > TOTAL_PIN_BUDGET {
            return Err("storage_busy".into());
        }
        let roots = [path_key(&self.cache), path_key(&physical_cache)];
        let paths = paths
            .into_iter()
            .filter(|path| {
                let key = path_key(path);
                roots
                    .iter()
                    .any(|root| key.starts_with(&format!("{}/", root.trim_end_matches('/'))))
                    && !path
                        .components()
                        .any(|part| matches!(part, std::path::Component::ParentDir))
            })
            .collect();
        let id = uuid::Uuid::new_v4().to_string();
        activities.insert(
            id.clone(),
            Activity {
                window: window.to_string(),
                _guard: None,
                paths,
            },
        );
        Ok(id)
    }

    pub async fn release(&self, window: &str, id: &str) -> Result<(), String> {
        let mut activities = self.activities.lock().await;
        if activities
            .get(id)
            .is_some_and(|activity| activity.window != window)
        {
            return Err("storage_invalid_path".into());
        }
        activities.remove(id);
        Ok(())
    }

    pub async fn abort_window(&self, window: &str) {
        self.activities
            .lock()
            .await
            .retain(|_, activity| activity.window != window);
    }

    #[cfg(test)]
    pub async fn publish_attachment(
        &self,
        kind: String,
        source: PathBuf,
        expected_hash: Option<String>,
    ) -> Result<PublishedAttachment, String> {
        self.publish_with_alias(kind, source, expected_hash, None)
            .await
    }

    pub async fn publish_with_alias(
        &self,
        kind: String,
        source: PathBuf,
        expected_hash: Option<String>,
        alias_source: Option<PathBuf>,
    ) -> Result<PublishedAttachment, String> {
        let guard = self.access().await;
        let cache = self.cache.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            let (hash, path, size) =
                files::publish_attachment(&cache, &kind, &source, expected_hash.as_deref())?;
            if let Err(error) = files::reuse_managed_alias(
                &cache,
                alias_source.as_deref().unwrap_or(&source),
                &path,
            ) {
                log::warn!("Attachment alias optimization unavailable: {error}");
            }
            let physical_cache = files::resolve_platform_path(&cache)?;
            let staging = physical_cache.join("attachments/.staging");
            let managed_source = source
                .strip_prefix(&cache)
                .map(|relative| physical_cache.join(relative))
                .unwrap_or_else(|_| source.clone());
            if managed_source.starts_with(&staging) {
                match files::physical_file(&managed_source).and_then(|file| {
                    let identity = file.identity.ok_or("storage_invalid_path")?;
                    files::remove_owned(&staging, &managed_source, &identity)
                }) {
                    Ok(()) => {}
                    Err(error) => log::warn!("Attachment staging cleanup deferred: {error}"),
                }
            }
            Ok(PublishedAttachment {
                hash,
                path: path.to_string_lossy().into_owned(),
                size,
            })
        })
        .await
        .map_err(|_| "storage_io_failed".to_string())?
    }

    pub async fn scan(&self, extra: Vec<PathBuf>) -> Result<StorageSummary, String> {
        let _guard = self.access().await;
        let _database_access = self.database.read_access().await;
        let busy = self
            .activities
            .lock()
            .await
            .values()
            .any(|activity| activity._guard.is_some());
        self.scan_unlocked(extra, busy).await
    }

    async fn scan_unlocked(
        &self,
        extra: Vec<PathBuf>,
        busy: bool,
    ) -> Result<StorageSummary, String> {
        let physical_cache = self.physical_cache_root().await?;
        let references = self.references(extra, false, &physical_cache).await?;
        let free_pages: i64 = sqlx::query_scalar("PRAGMA freelist_count")
            .fetch_one(self.database.pool())
            .await
            .map_err(|_| "storage_io_failed")?;
        let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
            .fetch_one(self.database.pool())
            .await
            .map_err(|_| "storage_io_failed")?;
        let roots = self.roots(&physical_cache);
        tokio::task::spawn_blocking(move || {
            let (entries, warnings) = scan_entries(roots, &references.protected);
            Ok(summarize(
                &entries,
                warnings,
                busy,
                (free_pages.max(0) as u64).saturating_mul(page_size.max(0) as u64),
            ))
        })
        .await
        .map_err(|_| "storage_io_failed".to_string())?
    }

    #[cfg(test)]
    pub async fn cleanup(
        &self,
        categories: Vec<StorageCategory>,
        extra: Vec<PathBuf>,
    ) -> Result<StorageCleanupResult, String> {
        self.cleanup_with_snapshot(categories, move || Ok(extra))
            .await
    }

    pub async fn cleanup_with_snapshot<F>(
        &self,
        categories: Vec<StorageCategory>,
        snapshot: F,
    ) -> Result<StorageCleanupResult, String>
    where
        F: FnOnce() -> Result<Vec<PathBuf>, String> + Send + 'static,
    {
        let owner = self.clone();
        tokio::spawn(async move {
            let _guard = owner.exclusive().await?;
            let _database_guard = owner.database.maintenance().await?;
            let extra = snapshot()?;
            owner
                .cleanup_unlocked(categories, extra, false, false)
                .await
        })
        .await
        .map_err(|_| "storage_io_failed".to_string())?
    }

    async fn cleanup_unlocked(
        &self,
        categories: Vec<StorageCategory>,
        extra: Vec<PathBuf>,
        force_orphans: bool,
        automatic: bool,
    ) -> Result<StorageCleanupResult, String> {
        if categories.iter().any(|category| {
            !SAFE_CATEGORIES.contains(category)
                && !matches!(
                    category,
                    StorageCategory::Recordings | StorageCategory::Logs
                )
        }) {
            return Err("storage_invalid_path".into());
        }
        let physical_cache = self.physical_cache_root().await?;
        let references = self
            .references(extra.clone(), force_orphans, &physical_cache)
            .await?;
        let roots = self.roots(&physical_cache);
        let protected = references.protected.clone();
        let (entries, warnings) =
            tokio::task::spawn_blocking(move || scan_entries(roots, &protected))
                .await
                .map_err(|_| "storage_io_failed")?;
        if !warnings.is_empty() {
            return Err("storage_scan_incomplete".into());
        }
        // A complete filesystem plan precedes the metadata transaction; live writers are excluded.
        if !automatic && categories.contains(&StorageCategory::Attachments) {
            let mut transaction = self
                .database
                .pool()
                .begin()
                .await
                .map_err(|_| "storage_io_failed")?;
            for id in &references.orphan_ids {
                sqlx::query("DELETE FROM attachments WHERE id = ? AND NOT EXISTS (SELECT 1 FROM message_parts WHERE attachment_id = ?)")
                    .bind(id).bind(id).execute(&mut *transaction).await.map_err(|_| "storage_io_failed")?;
            }
            transaction
                .commit()
                .await
                .map_err(|_| "storage_io_failed")?;
        }
        let removed = tokio::task::spawn_blocking(move || {
            remove_entries(entries, &categories, &physical_cache, automatic)
        })
        .await
        .map_err(|_| "storage_io_failed")??;
        let summary = self.scan_unlocked(extra, false).await?;
        Ok(StorageCleanupResult {
            removed_files: removed.0,
            released_bytes: removed.1,
            pending_bytes: removed.2,
            failed_files: removed.3.len(),
            failures: removed.3,
            summary,
            restart_required: false,
        })
    }

    pub async fn compact_database(&self) -> Result<StorageCompactionResult, String> {
        let owner = self.clone();
        tokio::spawn(async move { owner.compact_owned().await })
            .await
            .map_err(|_| "storage_io_failed".to_string())?
    }

    async fn compact_owned(&self) -> Result<StorageCompactionResult, String> {
        let _guard = self.exclusive().await?;
        let _database_guard = self.database.maintenance().await?;
        self.compact_unlocked().await
    }

    async fn compact_unlocked(&self) -> Result<StorageCompactionResult, String> {
        let path = self.database.database_path().to_path_buf();
        let page_count: i64 = sqlx::query_scalar("PRAGMA page_count")
            .fetch_one(self.database.pool())
            .await
            .map_err(|_| "storage_io_failed")?;
        let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
            .fetch_one(self.database.pool())
            .await
            .map_err(|_| "storage_io_failed")?;
        let logical = (page_count.max(0) as u64).saturating_mul(page_size.max(0) as u64);
        let (path, before, available) = tokio::task::spawn_blocking(move || {
            let path = files::resolve_platform_path(&path)?;
            Ok::<_, String>((
                path.clone(),
                files::database_allocated(&path)?,
                files::available_space(path.parent().ok_or("storage_invalid_path")?)?,
            ))
        })
        .await
        .map_err(|_| "storage_io_failed")??;
        // Admission uses the committed logical page count, including pages still in WAL.
        if available < logical.saturating_mul(2).saturating_add(16 * 1024 * 1024) {
            return Err("storage_insufficient_space".into());
        }
        let checkpoint: (i64, i64, i64) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
            .fetch_one(self.database.pool())
            .await
            .map_err(|_| "storage_io_failed")?;
        if checkpoint.0 != 0 {
            return Err("storage_busy".into());
        }
        sqlx::query("VACUUM")
            .execute(self.database.pool())
            .await
            .map_err(|_| "storage_io_failed")?;
        let checkpoint: (i64, i64, i64) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
            .fetch_one(self.database.pool())
            .await
            .map_err(|_| "storage_io_failed")?;
        if checkpoint.0 != 0 {
            return Err("storage_busy".into());
        }
        let after = tokio::task::spawn_blocking(move || files::database_allocated(&path))
            .await
            .map_err(|_| "storage_io_failed")??;
        Ok(StorageCompactionResult {
            before_bytes: before,
            after_bytes: after,
            released_bytes: before.saturating_sub(after),
        })
    }

    #[cfg(test)]
    pub async fn clear_history(
        &self,
        kind: HistoryKind,
        extra: Vec<PathBuf>,
    ) -> Result<(), String> {
        self.clear_history_with_snapshot(kind, move || Ok(extra))
            .await
    }

    pub async fn clear_history_with_snapshot<F>(
        &self,
        kind: HistoryKind,
        snapshot: F,
    ) -> Result<(), String>
    where
        F: FnOnce() -> Result<Vec<PathBuf>, String> + Send + 'static,
    {
        let owner = self.clone();
        tokio::spawn(async move { owner.clear_history_owned(kind, snapshot).await })
            .await
            .map_err(|_| "storage_io_failed".to_string())?
    }

    async fn clear_history_owned<F>(&self, kind: HistoryKind, snapshot: F) -> Result<(), String>
    where
        F: FnOnce() -> Result<Vec<PathBuf>, String> + Send,
    {
        let _guard = self.exclusive().await?;
        let _database_guard = self.database.maintenance().await?;
        let extra = snapshot()?;
        let rollup = self.database.storage_artifact("rollup.sql")?;
        let clear = self.database.storage_artifact(match kind {
            HistoryKind::Sessions => "clear_sessions.sql",
            HistoryKind::Messages => "clear_messages.sql",
            HistoryKind::Turns => "clear_turns.sql",
        })?;
        let mut transaction = self
            .database
            .pool()
            .begin()
            .await
            .map_err(|_| "storage_io_failed")?;
        sqlx::raw_sql(sqlx::AssertSqlSafe(rollup))
            .execute(&mut *transaction)
            .await
            .map_err(|_| "storage_io_failed")?;
        sqlx::raw_sql(sqlx::AssertSqlSafe(clear))
            .execute(&mut *transaction)
            .await
            .map_err(|_| "storage_io_failed")?;
        transaction
            .commit()
            .await
            .map_err(|_| "storage_io_failed")?;
        // Content deletion has committed. Never hide an incomplete filesystem reclamation.
        let result = self
            .cleanup_unlocked(
                vec![StorageCategory::Attachments, StorageCategory::Clipboard],
                extra,
                true,
                false,
            )
            .await
            .map_err(|error| format!("storage_history_committed:{error}"))?;
        if result.failed_files > 0 {
            return Err("storage_history_committed:storage_io_failed".into());
        }
        Ok(())
    }

    pub fn spawn_cache_maintenance<R: tauri::Runtime>(&self, app: tauri::AppHandle<R>) {
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60 * 60));
            interval.tick().await;
            loop {
                interval.tick().await;
                let Ok(_guard) = runtime.exclusive().await else {
                    continue;
                };
                let Ok(_database_guard) = runtime.database.maintenance().await else {
                    continue;
                };
                use tauri::Manager;
                let extra =
                    match app.try_state::<crate::core::system::clipboard::ClipboardRuntime>() {
                        Some(clipboard) => match clipboard.protected_paths() {
                            Ok(paths) => paths,
                            Err(_) => continue,
                        },
                        None => continue,
                    };
                if let Err(error) = runtime
                    .cleanup_unlocked(
                        vec![
                            StorageCategory::Clipboard,
                            StorageCategory::Thumbnails,
                            StorageCategory::Temporary,
                        ],
                        extra,
                        false,
                        true,
                    )
                    .await
                {
                    log::warn!("Storage cache maintenance failed: {error}");
                }
            }
        });
    }

    fn roots(&self, cache: &Path) -> Vec<(PathBuf, StorageCategory)> {
        let root = cache.parent().unwrap_or(cache);
        vec![
            (cache.join("attachments"), StorageCategory::Attachments),
            (cache.join("originals"), StorageCategory::Attachments),
            (cache.join("clipboard"), StorageCategory::Clipboard),
            (cache.join("icons"), StorageCategory::Thumbnails),
            (cache.join("temporary"), StorageCategory::Temporary),
            (
                cache.join("computer-use-trajectories"),
                StorageCategory::Recordings,
            ),
            (root.join("logs"), StorageCategory::Logs),
            (
                self.database.database_path().to_path_buf(),
                StorageCategory::Database,
            ),
            (
                self.database
                    .database_path()
                    .with_file_name("touchai.db-wal"),
                StorageCategory::Database,
            ),
            (
                self.database
                    .database_path()
                    .with_file_name("touchai.db-shm"),
                StorageCategory::Database,
            ),
            (root.join("assets"), StorageCategory::Assets),
            (root.join("computer-use"), StorageCategory::Assets),
            (root.join("data/browser-data"), StorageCategory::Browser),
        ]
    }

    async fn references(
        &self,
        extra: Vec<PathBuf>,
        force_orphans: bool,
        physical_cache: &Path,
    ) -> Result<References, String> {
        let mut rows = Vec::new();
        let mut stream = sqlx::query("SELECT id, hash, type, origin_path, mime_type, coalesce(julianday(created_at) < julianday('now', '-1 day'), 0) AS expired FROM attachments LIMIT ?")
            .bind((MAX_ROWS + 1) as i64).fetch(self.database.pool());
        while let Some(row) = stream
            .try_next()
            .await
            .map_err(|_| "storage_scan_incomplete")?
        {
            if rows.len() >= MAX_ROWS {
                return Err("storage_scan_incomplete".into());
            }
            rows.push(AttachmentRow {
                id: row.try_get("id").map_err(|_| "storage_scan_incomplete")?,
                hash: row.try_get("hash").map_err(|_| "storage_scan_incomplete")?,
                kind: row.try_get("type").map_err(|_| "storage_scan_incomplete")?,
                origin: row
                    .try_get("origin_path")
                    .map_err(|_| "storage_scan_incomplete")?,
                directory: row
                    .try_get::<Option<String>, _>("mime_type")
                    .map_err(|_| "storage_scan_incomplete")?
                    .as_deref()
                    == Some("application/x-directory"),
                expired: row
                    .try_get::<i64, _>("expired")
                    .map_err(|_| "storage_scan_incomplete")?
                    != 0,
            });
        }
        drop(stream);
        let mut ids = HashSet::new();
        let mut hashes = HashSet::new();
        let mut persistent_paths = HashSet::new();
        let mut protected: HashSet<String> = extra
            .iter()
            .map(|path| self.protection_key(path, physical_cache))
            .collect();
        for activity in self.activities.lock().await.values() {
            protected.extend(
                activity
                    .paths
                    .iter()
                    .map(|path| self.protection_key(path, physical_cache)),
            );
        }
        let mut nodes = 1_000_000_usize;
        for (query, include_ids) in [
            (
                "SELECT CASE WHEN length(CAST(data AS BLOB)) <= ? THEN data END AS value FROM message_parts WHERE type IN ('attachment', 'tool_call') LIMIT ?",
                true,
            ),
            (
                "SELECT CASE WHEN length(CAST(prompt_snapshot_json AS BLOB)) <= ? THEN prompt_snapshot_json END AS value FROM session_turns LIMIT ?",
                false,
            ),
        ] {
            let mut count = 0;
            let mut stream = sqlx::query(query).bind(MAX_JSON_BYTES as i64)
                .bind((MAX_ROWS + 1) as i64).fetch(self.database.pool());
            while let Some(row) = stream.try_next().await.map_err(|_| "storage_scan_incomplete")? {
                count += 1;
                if count > MAX_ROWS { return Err("storage_scan_incomplete".into()); }
                let raw: Option<String> = row.try_get("value").map_err(|_| "storage_scan_incomplete")?;
                let value: Value = serde_json::from_str(raw.as_deref().ok_or("storage_scan_incomplete")?)
                    .map_err(|_| "storage_scan_incomplete")?;
                collect_references(
                    &value,
                    &mut ids,
                    &mut hashes,
                    &mut persistent_paths,
                    &mut nodes,
                    0,
                    include_ids,
                )?;
            }
        }
        protected.extend(
            persistent_paths
                .iter()
                .map(|path| self.protection_key(Path::new(path), physical_cache)),
        );
        let mut orphan_ids = Vec::new();
        for row in rows {
            if !row.directory
                && !files::is_hash(&row.hash, 64)
                && !ids.contains(&row.id)
                && !hashes.contains(&row.hash)
                && (force_orphans || row.expired)
            {
                // Bad unreferenced metadata owns no recognized hash path; never infer a filename.
                orphan_ids.push(row.id);
                continue;
            }
            let cache_path = if row.directory {
                None
            } else {
                Some(files::attachment_path(
                    physical_cache,
                    &row.kind,
                    &row.hash,
                )?)
            };
            let live = ids.contains(&row.id)
                || hashes.contains(&row.hash)
                || cache_path
                    .as_ref()
                    .is_some_and(|path| protected.contains(&path_key(path)))
                || (!force_orphans && !row.expired);
            if live {
                if let Some(path) = cache_path {
                    protected.insert(path_key(&path));
                }
                let origin = Path::new(&row.origin);
                if origin.is_absolute() {
                    protected.insert(self.protection_key(origin, physical_cache));
                }
            } else {
                orphan_ids.push(row.id);
            }
        }
        Ok(References {
            protected,
            orphan_ids,
        })
    }
}

fn collect_references(
    value: &Value,
    ids: &mut HashSet<i64>,
    hashes: &mut HashSet<String>,
    paths: &mut HashSet<String>,
    nodes: &mut usize,
    depth: usize,
    include_ids: bool,
) -> Result<(), String> {
    if *nodes == 0 || depth > 64 || paths.len() > MAX_ROWS {
        return Err("storage_scan_incomplete".into());
    }
    *nodes -= 1;
    match value {
        Value::Object(object) => {
            if include_ids {
                if let Some(id) = object.get("attachmentId").and_then(Value::as_i64) {
                    ids.insert(id);
                }
            }
            if let Some(hash) = object.get("hash").and_then(Value::as_str) {
                if files::is_hash(hash, 64) {
                    hashes.insert(hash.to_string());
                }
            }
            for child in object.values() {
                collect_references(child, ids, hashes, paths, nodes, depth + 1, include_ids)?;
            }
        }
        Value::Array(array) => {
            for child in array {
                collect_references(child, ids, hashes, paths, nodes, depth + 1, include_ids)?;
            }
        }
        Value::String(value) if value.len() <= 65_536 && Path::new(value).is_absolute() => {
            paths.insert(path_key(Path::new(value)));
        }
        _ => {}
    }
    Ok(())
}

fn recognized(path: &Path, root: &Path, category: StorageCategory) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    match category {
        StorageCategory::Attachments
            if root.file_name().is_some_and(|name| name == "originals") =>
        {
            files::is_hash(name, 64)
        }
        StorageCategory::Attachments => path.strip_prefix(root).ok().is_some_and(|relative| {
            let parts: Vec<_> = relative
                .components()
                .filter_map(|part| part.as_os_str().to_str())
                .collect();
            matches!(parts.as_slice(), ["images" | "files", shard, hash]
                if files::is_hash(hash, 64) && *shard == &hash[..3])
        }),
        StorageCategory::Clipboard => {
            path.parent() == Some(root)
                && name.rsplit_once('.').is_some_and(|(stem, ext)| {
                    stem.bytes().all(|byte| byte.is_ascii_digit())
                        && !stem.is_empty()
                        && matches!(ext, "png" | "svg")
                })
        }
        StorageCategory::Thumbnails => {
            path.parent() == Some(root)
                && name.rsplit_once('.').is_some_and(|(stem, ext)| {
                    files::is_hash(stem, 32) && matches!(ext, "png" | "jpeg")
                })
        }
        StorageCategory::Temporary => {
            (name.starts_with("browser-screenshot-") && name.ends_with(".png"))
                || (name == "alias"
                    && path.components().any(|part| {
                        part.as_os_str()
                            .to_str()
                            .is_some_and(|name| name.starts_with(".attachment-alias-"))
                    }))
                || (path.components().any(|part| part.as_os_str() == ".staging")
                    && (name.starts_with("image-") || name.starts_with("attachment-")))
        }
        StorageCategory::Recordings => path.strip_prefix(root).ok().is_some_and(|relative| {
            relative.components().any(|component| {
                component.as_os_str().to_str().is_some_and(|name| {
                    name.strip_prefix("recording-")
                        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
                })
            })
        }),
        StorageCategory::Logs => {
            (name.starts_with("TouchAI_") && name.ends_with(".log"))
                || (path.parent() == Some(root.join("crashes").as_path()) && name.ends_with(".txt"))
        }
        _ => false,
    }
}

fn scan_entries(
    roots: Vec<(PathBuf, StorageCategory)>,
    protected: &HashSet<String>,
) -> (Vec<Entry>, Vec<String>) {
    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    for (root, category) in roots {
        let root = if matches!(
            category,
            StorageCategory::Database | StorageCategory::Browser
        ) {
            match files::resolve_platform_path(&root) {
                Ok(physical) => physical,
                Err(error) => {
                    warnings.push(error);
                    warnings.push("storage_scan_incomplete".into());
                    continue;
                }
            }
        } else {
            root
        };
        let paths = match files::walk(&root, MAX_ENTRIES.saturating_sub(entries.len())) {
            Ok(paths) => paths,
            Err(error) => {
                warnings.push(error);
                warnings.push("storage_scan_incomplete".into());
                continue;
            }
        };
        for path in paths {
            let category = if category == StorageCategory::Attachments
                && path.strip_prefix(&root).ok().is_some_and(|relative| {
                    relative
                        .components()
                        .next()
                        .is_some_and(|part| part.as_os_str() == ".staging")
                })
                || path.strip_prefix(&root).ok().is_some_and(|relative| {
                    relative.components().any(|part| {
                        part.as_os_str()
                            .to_str()
                            .is_some_and(|name| name.starts_with(".attachment-alias-"))
                    })
                }) {
                StorageCategory::Temporary
            } else {
                category
            };
            let physical = match files::physical_file(&path) {
                Ok(value) => value,
                Err(error) => {
                    warnings.push(error);
                    warnings.push("storage_scan_incomplete".into());
                    continue;
                }
            };
            if physical.identity.is_none() {
                warnings.push("storage_scan_incomplete".into());
            }
            let modified = fs::metadata(&path)
                .and_then(|metadata| metadata.modified())
                .unwrap_or(SystemTime::now());
            let old = SystemTime::now()
                .duration_since(modified)
                .unwrap_or_default()
                >= UNUSED_GRACE;
            let candidate = recognized(&path, &root, category)
                && !protected.contains(&path_key(&path))
                && (!matches!(
                    category,
                    StorageCategory::Clipboard | StorageCategory::Temporary
                ) || old);
            entries.push(Entry {
                root: root.clone(),
                path,
                category,
                physical,
                candidate,
                modified,
            });
        }
    }
    warnings.sort();
    warnings.dedup();
    (entries, warnings)
}

fn summarize(
    entries: &[Entry],
    warnings: Vec<String>,
    busy: bool,
    database_free_bytes: u64,
) -> StorageSummary {
    let mut categories: Vec<_> = CATEGORIES
        .into_iter()
        .map(|id| StorageCategoryUsage {
            id,
            bytes: 0,
            reclaimable_bytes: 0,
            file_count: 0,
        })
        .collect();
    let mut seen = HashSet::new();
    let mut groups: HashMap<FileIdentity, Vec<&Entry>> = HashMap::new();
    for entry in entries {
        let usage = categories
            .iter_mut()
            .find(|usage| usage.id == entry.category)
            .expect("category");
        usage.file_count += 1;
        if entry
            .physical
            .identity
            .as_ref()
            .is_none_or(|id| seen.insert(id.clone()))
        {
            usage.bytes = usage.bytes.saturating_add(entry.physical.allocated);
        }
        if let Some(id) = &entry.physical.identity {
            groups.entry(id.clone()).or_default().push(entry);
        }
    }
    for group in groups.values() {
        if group
            .iter()
            .all(|entry| entry.candidate && SAFE_CATEGORIES.contains(&entry.category))
            && group[0].physical.links == group.len() as u64
        {
            let usage = categories
                .iter_mut()
                .find(|usage| usage.id == group[0].category)
                .expect("category");
            usage.reclaimable_bytes = usage
                .reclaimable_bytes
                .saturating_add(group[0].physical.allocated);
        }
    }
    let total_bytes = categories.iter().map(|usage| usage.bytes).sum();
    let reclaimable_bytes = categories.iter().map(|usage| usage.reclaimable_bytes).sum();
    StorageSummary {
        categories,
        total_bytes,
        reclaimable_bytes,
        database_free_bytes,
        warnings,
        busy,
    }
}

type Removal = (usize, u64, u64, Vec<StorageFailure>);

fn remove_entries(
    mut entries: Vec<Entry>,
    categories: &[StorageCategory],
    cache: &Path,
    automatic: bool,
) -> Result<Removal, String> {
    files::validate_path(cache)?;
    fs::create_dir_all(cache).map_err(|_| "storage_io_failed")?;
    let available_before = files::available_space(cache)?;
    entries.sort_by_key(|entry| entry.modified);
    let mut thumbnail_bytes: u64 = entries
        .iter()
        .filter(|entry| entry.category == StorageCategory::Thumbnails)
        .map(|entry| entry.physical.allocated)
        .sum();
    let mut clipboard_bytes: u64 = entries
        .iter()
        .filter(|entry| entry.category == StorageCategory::Clipboard && entry.candidate)
        .map(|entry| entry.physical.allocated)
        .sum();
    let mut removed_files = 0;
    let mut failures = Vec::new();
    let mut removed: HashMap<FileIdentity, (usize, u64, u64)> = HashMap::new();
    for entry in entries {
        if !entry.candidate || !categories.contains(&entry.category) {
            continue;
        }
        if automatic
            && entry.category == StorageCategory::Thumbnails
            && thumbnail_bytes <= THUMBNAIL_BUDGET
        {
            continue;
        }
        if automatic
            && entry.category == StorageCategory::Clipboard
            && clipboard_bytes <= CLIPBOARD_BUDGET
            && SystemTime::now()
                .duration_since(entry.modified)
                .unwrap_or_default()
                < CLIPBOARD_TTL
        {
            continue;
        }
        let Some(id) = entry.physical.identity else {
            continue;
        };
        match files::remove_owned(&entry.root, &entry.path, &id) {
            Ok(()) => {
                removed_files += 1;
                let group = removed.entry(id).or_insert((
                    0,
                    entry.physical.links,
                    entry.physical.allocated,
                ));
                group.0 += 1;
                if entry.category == StorageCategory::Thumbnails {
                    thumbnail_bytes = thumbnail_bytes.saturating_sub(entry.physical.allocated);
                }
                if entry.category == StorageCategory::Clipboard {
                    clipboard_bytes = clipboard_bytes.saturating_sub(entry.physical.allocated);
                }
            }
            Err(code) => failures.push(StorageFailure {
                path: entry.path.to_string_lossy().into_owned(),
                code,
            }),
        }
    }
    let expected: u64 = removed
        .values()
        .filter(|(count, links, _)| *count as u64 == *links)
        .map(|(_, _, bytes)| *bytes)
        .sum();
    // A removed name may still have an open handle; report only the observed allocation return.
    let observed = match files::available_space(cache) {
        Ok(available) => available.saturating_sub(available_before).min(expected),
        Err(code) => {
            failures.push(StorageFailure {
                path: cache.to_string_lossy().into_owned(),
                code,
            });
            0
        }
    };
    Ok((
        removed_files,
        observed,
        expected.saturating_sub(observed),
        failures,
    ))
}

#[cfg(test)]
mod tests;
