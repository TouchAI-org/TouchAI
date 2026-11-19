use super::*;
use sqlx::{Sqlite, SqliteConnection, Transaction};

impl StorageRuntime {
    pub async fn cleanup_selected(
        &self,
        selection: StorageCleanupSelection,
        extra: Vec<PathBuf>,
        _lease: OwnedRwLockWriteGuard<()>,
    ) -> Result<StorageCleanupResult, String> {
        if selection.categories.len() > CATEGORIES.len()
            || (!selection.unused && selection.categories.is_empty())
        {
            return Err("storage_invalid_path".into());
        }
        let _database_lease = self.database.maintenance().await?;
        let reset = selection.categories.contains(&StorageCategory::Database);
        let physical_cache = self.physical_cache_root().await?;
        let references = if selection.unused {
            self.references(extra.clone(), false, &physical_cache)
                .await?
        } else {
            References {
                protected: HashSet::new(),
                orphan_ids: Vec::new(),
            }
        };
        let roots = self.roots(&physical_cache);
        let (mut entries, warnings) =
            tokio::task::spawn_blocking(move || scan_entries(roots, &references.protected))
                .await
                .map_err(|_| "storage_io_failed")?;
        if !warnings.is_empty() {
            return Err("storage_scan_incomplete".into());
        }
        let before = summarize(&entries, Vec::new(), false, 0);
        for entry in &mut entries {
            entry.candidate = entry.category != StorageCategory::Database
                && (selection.categories.contains(&entry.category)
                    || (selection.unused
                        && SAFE_CATEGORIES.contains(&entry.category)
                        && entry.candidate));
        }
        let paths = entries
            .iter()
            .filter(|entry| entry.candidate)
            .map(|entry| path_key(&entry.path))
            .collect();
        let mut transaction = self
            .database
            .pool()
            .begin()
            .await
            .map_err(|_| "storage_io_failed")?;
        if reset {
            let sql = self.database.storage_artifact("clear_database.sql")?;
            sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
                .execute(&mut *transaction)
                .await
                .map_err(|_| "storage_io_failed")?;
        } else {
            for id in references.orphan_ids {
                sqlx::query("DELETE FROM attachments WHERE id = ? AND NOT EXISTS (SELECT 1 FROM message_parts WHERE attachment_id = ?)")
                    .bind(id).bind(id).execute(&mut *transaction).await.map_err(|_| "storage_io_failed")?;
            }
            self.prune_selected_references(&mut transaction, &selection, paths, &physical_cache)
                .await?;
        }
        transaction
            .commit()
            .await
            .map_err(|_| "storage_io_failed")?;

        let removed = tokio::task::spawn_blocking(move || {
            remove_entries(entries, &CATEGORIES, &physical_cache, false)
        })
        .await;
        let (removed_files, mut released_bytes, pending_bytes, mut failures) = match removed {
            Ok(Ok(result)) => result,
            _ => (
                0,
                0,
                0,
                vec![StorageFailure {
                    path: self.cache.to_string_lossy().into_owned(),
                    code: "storage_io_failed".into(),
                }],
            ),
        };
        if reset || selection.unused {
            match self.compact_unlocked().await {
                Ok(result) => released_bytes = released_bytes.saturating_add(result.released_bytes),
                Err(code) => failures.push(StorageFailure {
                    path: self.database.database_path().to_string_lossy().into_owned(),
                    code,
                }),
            }
        }
        let summary = match self.scan_unlocked(extra, false).await {
            Ok(summary) => summary,
            Err(code) => StorageSummary {
                warnings: vec![code, "storage_scan_incomplete".into()],
                ..before
            },
        };
        if reset {
            self.database.pool().close().await;
        }
        Ok(StorageCleanupResult {
            removed_files,
            released_bytes,
            pending_bytes,
            failed_files: failures.len(),
            failures,
            summary,
            restart_required: reset || selection.categories.contains(&StorageCategory::Assets),
        })
    }

    async fn prune_selected_references(
        &self,
        transaction: &mut Transaction<'_, Sqlite>,
        selection: &StorageCleanupSelection,
        paths: HashSet<String>,
        physical_cache: &Path,
    ) -> Result<(), String> {
        let mut removed = RemovedReferences {
            paths,
            ids: HashSet::new(),
            hashes: HashSet::new(),
        };
        let mut cursor = 0_i64;
        let mut count = 0;
        loop {
            let rows = sqlx::query("SELECT id, hash, type, CASE WHEN length(CAST(origin_path AS BLOB)) <= 65536 THEN origin_path END AS origin_path, coalesce(mime_type = 'application/x-directory', 0) AS directory FROM attachments WHERE id > ? ORDER BY id LIMIT 32")
                .bind(cursor).fetch_all(&mut **transaction).await.map_err(|_| "storage_io_failed")?;
            if rows.is_empty() {
                break;
            }
            count += rows.len();
            if count > MAX_ROWS {
                return Err("storage_scan_incomplete".into());
            }
            for row in rows {
                cursor = row.try_get("id").map_err(|_| "storage_io_failed")?;
                if row
                    .try_get::<bool, _>("directory")
                    .map_err(|_| "storage_io_failed")?
                {
                    continue;
                }
                let hash: String = row.try_get("hash").map_err(|_| "storage_io_failed")?;
                let kind: String = row.try_get("type").map_err(|_| "storage_io_failed")?;
                let cached = files::attachment_path(physical_cache, &kind, &hash)?;
                if selection.categories.contains(&StorageCategory::Attachments)
                    || removed.paths.contains(&path_key(&cached))
                {
                    removed.ids.insert(cursor);
                    removed.hashes.insert(hash);
                    removed.paths.insert(path_key(&cached));
                    sqlx::query("DELETE FROM attachments WHERE id = ?")
                        .bind(cursor)
                        .execute(&mut **transaction)
                        .await
                        .map_err(|_| "storage_io_failed")?;
                } else {
                    let origin: Option<String> = row
                        .try_get("origin_path")
                        .map_err(|_| "storage_io_failed")?;
                    let origin = origin.ok_or("storage_scan_incomplete")?;
                    if removed
                        .paths
                        .contains(&self.protection_key(Path::new(&origin), physical_cache))
                    {
                        sqlx::query("UPDATE attachments SET origin_path = ? WHERE id = ?")
                            .bind(cached.to_string_lossy().as_ref())
                            .bind(cursor)
                            .execute(&mut **transaction)
                            .await
                            .map_err(|_| "storage_io_failed")?;
                    }
                }
            }
        }
        if removed.paths.is_empty() && removed.ids.is_empty() {
            return Ok(());
        }
        let mut nodes = 1_000_000;
        for (table, column) in [
            ("message_parts", "data"),
            ("session_turns", "prompt_snapshot_json"),
            ("session_turn_attempts", "checkpoint_json"),
            ("session_turn_attempts", "delivery_manifest_json"),
        ] {
            self.prune_json_rows(
                &mut **transaction,
                table,
                column,
                &removed,
                physical_cache,
                &mut nodes,
            )
            .await?;
        }
        Ok(())
    }

    async fn prune_json_rows(
        &self,
        connection: &mut SqliteConnection,
        table: &str,
        column: &str,
        removed: &RemovedReferences,
        physical_cache: &Path,
        nodes: &mut usize,
    ) -> Result<(), String> {
        let query = format!("SELECT id, CASE WHEN length(CAST({column} AS BLOB)) <= ? THEN {column} END FROM {table} WHERE id > ? ORDER BY id LIMIT 8");
        let update = format!("UPDATE {table} SET {column} = ? WHERE id = ?");
        let mut cursor = 0_i64;
        let mut count = 0;
        loop {
            let rows: Vec<(i64, Option<String>)> =
                sqlx::query_as(sqlx::AssertSqlSafe(query.as_str()))
                    .bind(MAX_JSON_BYTES as i64)
                    .bind(cursor)
                    .fetch_all(&mut *connection)
                    .await
                    .map_err(|_| "storage_io_failed")?;
            if rows.is_empty() {
                break;
            }
            count += rows.len();
            if count > MAX_ROWS {
                return Err("storage_scan_incomplete".into());
            }
            for (id, raw) in rows {
                cursor = id;
                let raw = raw.ok_or("storage_scan_incomplete")?;
                let mut value: Value =
                    serde_json::from_str(&raw).map_err(|_| "storage_scan_incomplete")?;
                let mut changed = false;
                prune_json(
                    &mut value,
                    removed,
                    &|path| self.protection_key(Path::new(path), physical_cache),
                    nodes,
                    0,
                    &mut changed,
                )?;
                if changed {
                    sqlx::query(sqlx::AssertSqlSafe(update.as_str()))
                        .bind(value.to_string())
                        .bind(id)
                        .execute(&mut *connection)
                        .await
                        .map_err(|_| "storage_io_failed")?;
                }
            }
        }
        Ok(())
    }
}

struct RemovedReferences {
    paths: HashSet<String>,
    ids: HashSet<i64>,
    hashes: HashSet<String>,
}

fn prune_json(
    value: &mut Value,
    removed: &RemovedReferences,
    normalize: &impl Fn(&str) -> String,
    nodes: &mut usize,
    depth: usize,
    changed: &mut bool,
) -> Result<bool, String> {
    if *nodes == 0 || depth > 64 {
        return Err("storage_scan_incomplete".into());
    }
    *nodes -= 1;
    match value {
        Value::Array(array) => {
            let mut retained = Vec::with_capacity(array.len());
            for mut child in std::mem::take(array) {
                if !prune_json(&mut child, removed, normalize, nodes, depth + 1, changed)? {
                    retained.push(child);
                }
            }
            *array = retained;
        }
        Value::Object(object) => {
            if object
                .get("attachmentId")
                .and_then(Value::as_i64)
                .is_some_and(|id| removed.ids.contains(&id))
                || (matches!(
                    object.get("type").and_then(Value::as_str),
                    Some("image" | "file")
                ) && object
                    .get("hash")
                    .and_then(Value::as_str)
                    .is_some_and(|hash| removed.hashes.contains(hash)))
            {
                object.clear();
                *changed = true;
                return Ok(true);
            }
            let keys: Vec<_> = object.keys().cloned().collect();
            for key in keys {
                let child = object.get_mut(&key).ok_or("storage_scan_incomplete")?;
                let deleted_path = matches!(
                    key.as_str(),
                    "originPath"
                        | "origin_path"
                        | "path"
                        | "sourcePath"
                        | "source_path"
                        | "filePath"
                        | "file_path"
                ) && child
                    .as_str()
                    .is_some_and(|path| removed.paths.contains(&normalize(path)));
                if deleted_path || prune_json(child, removed, normalize, nodes, depth + 1, changed)?
                {
                    object.remove(&key);
                    *changed = true;
                }
            }
        }
        _ => {}
    }
    Ok(false)
}
