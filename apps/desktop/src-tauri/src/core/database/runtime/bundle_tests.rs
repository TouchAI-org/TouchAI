// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use std::{fs, io::Read, path::PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use super::super::DatabaseRuntime;
use crate::core::{
    analytics::ANALYTICS_STATE_SETTING,
    database::protocol::types::{DatabaseImportMode, DatabaseImportRequest},
};

const SAVED_BYTES: &[u8] = b"small immutable image fixture";

fn private_directory() -> tempfile::TempDir {
    #[cfg(unix)]
    let parent = fs::canonicalize(std::env::temp_dir()).expect("physical temporary root");
    #[cfg(not(unix))]
    let parent = std::env::temp_dir();
    tempfile::tempdir_in(parent).expect("private fixture directory")
}

struct Installation {
    root: tempfile::TempDir,
    runtime: DatabaseRuntime,
    cache: PathBuf,
}

impl Installation {
    async fn new() -> Self {
        let root = private_directory();
        let runtime = DatabaseRuntime::initialize_for_tests(&root.path().join("data"))
            .await
            .expect("synthetic database");
        let cache = root.path().join("cache");
        fs::create_dir(&cache).expect("private cache");
        Self {
            root,
            runtime,
            cache,
        }
    }

    async fn close(self) {
        self.runtime.pool().close().await;
        for (relative, _) in cache_contents(&self.cache) {
            let path = self.cache.join(relative);
            let metadata = fs::metadata(&path).expect("private fixture metadata");
            if metadata.permissions().readonly() {
                let mut permissions = metadata.permissions();
                permissions.set_readonly(false);
                fs::set_permissions(path, permissions).expect("test-only writable cleanup");
            }
        }
        self.root
            .close()
            .expect("closed SQLite handles permit cleanup");
    }
}

fn content_hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn attachment_path(cache: &std::path::Path) -> PathBuf {
    let hash = content_hash(SAVED_BYTES);
    cache.join("attachments/images").join(&hash[..3]).join(hash)
}

async fn seed_history(installation: &Installation) {
    let pool = installation.runtime.pool();
    let first = installation.cache.join("clipboard/17.png");
    let second = installation.cache.join("clipboard/18.png");
    fs::create_dir(installation.cache.join("clipboard")).expect("clipboard directory");
    fs::write(&first, SAVED_BYTES).expect("first retained original");
    fs::write(&second, SAVED_BYTES).expect("second retained original");
    fs::write(
        installation.cache.join("clipboard/unused.png"),
        b"not referenced",
    )
    .expect("unused clipboard image");
    let attachment = attachment_path(&installation.cache);
    fs::create_dir_all(attachment.parent().expect("attachment directory"))
        .expect("managed attachment directory");
    fs::write(&attachment, SAVED_BYTES).expect("managed attachment");

    let attachment_id: i64 = sqlx::query_scalar(
        "INSERT INTO attachments (hash, type, original_name, origin_path, mime_type, size)
         VALUES (?, 'image', 'fixture.png', ?, 'image/png', ?) RETURNING id",
    )
    .bind(content_hash(SAVED_BYTES))
    .bind(first.to_str().expect("fixture path"))
    .bind(SAVED_BYTES.len() as i64)
    .fetch_one(pool)
    .await
    .expect("attachment row");
    let mut first_message = 0;
    let mut first_session = 0;
    for (session_key, origin) in [("backup-first", &first), ("backup-second", &second)] {
        let session: i64 = sqlx::query_scalar(
            "INSERT INTO sessions (session_id, title, model) VALUES (?, 'Saved history', 'fixture') RETURNING id",
        )
        .bind(session_key)
        .fetch_one(pool)
        .await
        .expect("session");
        let message: i64 = sqlx::query_scalar(
            "INSERT INTO messages (session_id, role) VALUES (?, 'user') RETURNING id",
        )
        .bind(session)
        .fetch_one(pool)
        .await
        .expect("message");
        sqlx::query(
            "INSERT INTO message_parts (message_id, type, content, data, sort_order)
             VALUES (?, 'attachment', '', ?, 0)",
        )
        .bind(message)
        .bind(json!({"attachmentId": attachment_id, "originPath": origin}).to_string())
        .execute(pool)
        .await
        .expect("attachment part");
        if first_message == 0 {
            first_message = message;
            first_session = session;
        }
    }

    let provider: i64 = sqlx::query_scalar(
        "INSERT INTO providers (name, driver, api_endpoint, logo)
         VALUES ('Backup fixture provider', 'openai', 'https://fixture.invalid', '') RETURNING id",
    )
    .fetch_one(pool)
    .await
    .expect("provider");
    let model: i64 = sqlx::query_scalar(
        "INSERT INTO models (provider_id, name, model_id) VALUES (?, 'Fixture', 'backup-fixture') RETURNING id",
    )
    .bind(provider)
    .fetch_one(pool)
    .await
    .expect("model");
    let external = installation.root.path().join("external-source.txt");
    sqlx::query(
        "INSERT INTO session_turns (session_id, model_id, model_name, provider_name, task_id, prompt_snapshot_json, prompt_message_id)
         VALUES (?, ?, 'Fixture', 'Backup fixture provider', 'backup-fixture-task', ?, ?)",
    )
    .bind(first_session)
    .bind(model)
    .bind(json!({
        "attachments": [
            {"originPath": first, "hash": content_hash(SAVED_BYTES)},
            {"originPath": external}
        ],
        "inputSnapshot": {"editorDoc": {"attrs": {"origin_path": second}}},
        "userPrompt": format!("{} is mentioned in prose", first.display())
    }).to_string())
    .bind(first_message)
    .execute(pool)
    .await
    .expect("prompt snapshot");
    sqlx::query("INSERT INTO settings (key, value) VALUES ('keep', 'backup')")
        .execute(pool)
        .await
        .expect("backup setting");
}

struct ArchiveEntry {
    name: String,
    bytes: Vec<u8>,
    options: SimpleFileOptions,
}

fn archive_entries(path: &std::path::Path) -> Vec<ArchiveEntry> {
    let mut archive =
        ZipArchive::new(fs::File::open(path).expect("archive file")).expect("fixture archive");
    (0..archive.len())
        .map(|index| {
            let mut entry = archive.by_index(index).expect("archive entry");
            let name = entry.name().expect("entry name").into_owned();
            let options = entry.options();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).expect("small entry bytes");
            ArchiveEntry {
                name,
                bytes,
                options,
            }
        })
        .collect()
}

fn archive_manifest(path: &std::path::Path) -> Value {
    let entries = archive_entries(path);
    serde_json::from_slice(
        &entries
            .iter()
            .find(|entry| entry.name == "manifest.json")
            .expect("manifest")
            .bytes,
    )
    .expect("manifest JSON")
}

fn write_entries(path: &std::path::Path, entries: Vec<ArchiveEntry>) {
    use std::io::Write;
    let mut archive = ZipWriter::new(fs::File::create(path).expect("private archive"));
    for entry in entries {
        archive
            .start_file(&entry.name, entry.options)
            .expect("entry header");
        archive.write_all(&entry.bytes).expect("entry payload");
    }
    drop(archive.finish().expect("complete archive"));
}

fn cache_contents(root: &std::path::Path) -> Vec<(PathBuf, Vec<u8>)> {
    fn visit(
        root: &std::path::Path,
        directory: &std::path::Path,
        files: &mut Vec<(PathBuf, Vec<u8>)>,
    ) {
        for entry in fs::read_dir(directory).expect("private directory") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                visit(root, &path, files);
            } else {
                files.push((
                    path.strip_prefix(root)
                        .expect("relative path")
                        .to_path_buf(),
                    fs::read(path).expect("private bytes"),
                ));
            }
        }
    }
    let mut files = Vec::new();
    visit(root, root, &mut files);
    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
}

async fn restore(target: &Installation, source: &std::path::Path) -> Result<(), String> {
    target
        .runtime
        .import_full_backup(
            DatabaseImportRequest {
                source_path: source.to_str().expect("archive path").to_string(),
                mode: DatabaseImportMode::Full,
            },
            &target.cache,
        )
        .await
}

async fn setting(installation: &Installation) -> String {
    sqlx::query_scalar("SELECT value FROM settings WHERE key = 'keep'")
        .fetch_one(installation.runtime.pool())
        .await
        .expect("setting")
}

const TURN_USAGE: &str = "SELECT json_object('input',input_tokens,'output',output_tokens,'read',cache_read_tokens,'write',cache_write_tokens,'reasoning',reasoning_tokens,'cost',total_cost_micros,'unpriced',unpriced_calls,'ttft',ttft_ms,'firstText',first_text_ms,'calls',llm_call_count,'tools',tool_call_count,'switches',model_switch_count,'argumentErrors',tool_argument_error_count,'empty',empty_response_count,'ceiling',hit_iteration_ceiling,'kind',kind,'error',error_code,'retry',retry_scope,'breakdown',prompt_breakdown_json) FROM session_turns WHERE task_id='backup-fixture-task'";
const ATTEMPT_USAGE: &str = "SELECT json_object('input',input_tokens,'output',output_tokens,'read',cache_read_tokens,'write',cache_write_tokens,'reasoning',reasoning_tokens,'cost',total_cost_micros,'unpriced',unpriced_calls,'ttft',ttft_ms,'calls',llm_call_count) FROM session_turn_attempts";
const DAILY_USAGE: &str = "SELECT json_object('day',day,'model',model_name,'provider',provider_name,'requests',request_count,'successes',success_count,'input',input_tokens,'output',output_tokens,'read',cache_read_tokens,'write',cache_write_tokens,'reasoning',reasoning_tokens,'cost',total_cost_micros,'unpriced',unpriced_count,'ttft',sum_ttft_ms,'duration',sum_duration_ms,'samples',ttft_sample_count) FROM usage_daily_rollups";

async fn seed_usage(installation: &Installation) {
    sqlx::raw_sql("UPDATE session_turns SET status='completed',input_tokens=120,output_tokens=30,cache_read_tokens=5,cache_write_tokens=7,reasoning_tokens=11,total_cost_micros=250000,unpriced_calls=2,ttft_ms=80,first_text_ms=100,llm_call_count=3,tool_call_count=4,model_switch_count=1,tool_argument_error_count=2,empty_response_count=1,hit_iteration_ceiling=1,kind='chat',error_code='fixture',retry_scope='checkpoint',prompt_breakdown_json='{}',duration_ms=1500,created_at='2020-01-01 00:00:00'; INSERT INTO session_turn_attempts(turn_id,attempt_index,status,checkpoint_json,delivery_manifest_json,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,total_cost_micros,unpriced_calls,ttft_ms,llm_call_count) SELECT id,1,'completed','{}','{}',120,30,5,7,11,250000,2,80,3 FROM session_turns;")
        .execute(installation.runtime.pool()).await.expect("usage fixture");
    let rollup = installation
        .runtime
        .storage_artifact("rollup.sql")
        .expect("usage contract");
    sqlx::raw_sql(sqlx::AssertSqlSafe(rollup))
        .execute(installation.runtime.pool())
        .await
        .expect("source daily usage");
}

async fn usage_json(installation: &Installation, query: &'static str) -> Value {
    let json: String = sqlx::query_scalar(sqlx::AssertSqlSafe(query))
        .fetch_one(installation.runtime.pool())
        .await
        .expect("observable usage");
    serde_json::from_str(&json).expect("usage JSON")
}

#[tokio::test]
async fn user_given_nonzero_usage_when_restoring_repeatedly_then_keeps_turn_attempt_and_daily_totals_in_both_import_modes(
) {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    seed_usage(&source).await;
    let turn = usage_json(&source, TURN_USAGE).await;
    let attempt = usage_json(&source, ATTEMPT_USAGE).await;
    let daily = usage_json(&source, DAILY_USAGE).await;
    let backup = backup_root.path().join("usage.zip");
    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("full usage backup");
    for full in [false, true] {
        let target = Installation::new().await;
        for _ in 0..2 {
            target
                .runtime
                .import_full_backup(
                    DatabaseImportRequest {
                        source_path: backup.to_string_lossy().into_owned(),
                        mode: if full {
                            DatabaseImportMode::Full
                        } else {
                            DatabaseImportMode::ChatOnly
                        },
                    },
                    &target.cache,
                )
                .await
                .expect("usage restore");
            assert_eq!(usage_json(&target, TURN_USAGE).await, turn);
            assert_eq!(usage_json(&target, ATTEMPT_USAGE).await, attempt);
            assert_eq!(usage_json(&target, DAILY_USAGE).await, daily);
        }
        target.close().await;
    }
    source.close().await;
}

#[tokio::test]
async fn user_given_cleared_call_details_when_restoring_then_keeps_archived_usage_in_both_import_modes(
) {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    seed_usage(&source).await;
    let daily = usage_json(&source, DAILY_USAGE).await;
    let storage =
        crate::core::storage::StorageRuntime::new(source.runtime.clone(), source.cache.clone());
    storage
        .clear_history(crate::core::storage::HistoryKind::Turns, Vec::new())
        .await
        .expect("clear call details");
    let backup = backup_root.path().join("archived-usage.zip");
    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("archived usage backup");
    for full in [false, true] {
        let target = Installation::new().await;
        target
            .runtime
            .import_full_backup(
                DatabaseImportRequest {
                    source_path: backup.to_string_lossy().into_owned(),
                    mode: if full {
                        DatabaseImportMode::Full
                    } else {
                        DatabaseImportMode::ChatOnly
                    },
                },
                &target.cache,
            )
            .await
            .expect("restore archived usage");
        assert_eq!(usage_json(&target, DAILY_USAGE).await, daily);
        let rollup = target
            .runtime
            .storage_artifact("rollup.sql")
            .expect("usage contract");
        sqlx::raw_sql(sqlx::AssertSqlSafe(rollup))
            .execute(target.runtime.pool())
            .await
            .expect("later maintenance");
        assert_eq!(usage_json(&target, DAILY_USAGE).await, daily);
        target.close().await;
    }
    source.close().await;
}

#[tokio::test]
async fn user_given_overlapping_archived_usage_when_restoring_then_keeps_existing_data_instead_of_guessing_or_double_counting(
) {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    seed_usage(&source).await;
    let storage =
        crate::core::storage::StorageRuntime::new(source.runtime.clone(), source.cache.clone());
    storage
        .clear_history(crate::core::storage::HistoryKind::Turns, Vec::new())
        .await
        .expect("archive source detail");
    let backup = backup_root.path().join("overlapping-usage.zip");
    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("backup");
    let target = Installation::new().await;
    seed_history(&target).await;
    seed_usage(&target).await;
    let before = usage_json(&target, DAILY_USAGE).await;
    let files = cache_contents(&target.cache);
    assert!(restore(&target, &backup)
        .await
        .expect_err("ambiguous archived usage is refused")
        .contains("database_import_usage_conflict"));
    assert_eq!(usage_json(&target, DAILY_USAGE).await, before);
    assert_eq!(cache_contents(&target.cache), files);
    assert_eq!(usage_json(&target, TURN_USAGE).await["input"], 120);
    target.close().await;
    source.close().await;
}

#[tokio::test]
async fn user_given_saved_model_options_and_prices_when_restoring_fully_then_keeps_future_request_configuration(
) {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    sqlx::raw_sql("UPDATE models SET reasoning_options='[\"high\"]',upstream_metadata='{\"attachment\":1}'; INSERT INTO llm_metadata(model_id,name,attachment,modalities,open_weights,reasoning,release_date,temperature,tool_call,[limit],input_cost_per_million,output_cost_per_million,cache_read_cost_per_million,cache_write_cost_per_million,reasoning_cost_per_million,cost_currency,cost_tiers) VALUES('backup-fixture','Fixture',1,'{}',0,1,'2020-01-01',1,1,'{}','1','2','0.1','0.2','3','USD','[]');")
        .execute(source.runtime.pool()).await.expect("saved model configuration");
    let backup = backup_root.path().join("configuration.zip");
    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("backup");
    let target = Installation::new().await;
    restore(&target, &backup).await.expect("full restore");
    let options: (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT reasoning_options, upstream_metadata FROM models WHERE model_id='backup-fixture'",
    )
    .fetch_one(target.runtime.pool())
    .await
    .expect("model options");
    assert_eq!(
        options,
        (Some("[\"high\"]".into()), Some("{\"attachment\":1}".into()))
    );
    let prices: (Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>) = sqlx::query_as("SELECT input_cost_per_million,output_cost_per_million,cache_read_cost_per_million,cache_write_cost_per_million,reasoning_cost_per_million,cost_currency,cost_tiers FROM llm_metadata WHERE model_id='backup-fixture'")
        .fetch_one(target.runtime.pool()).await.expect("future call prices");
    assert_eq!(
        prices,
        (
            Some("1".into()),
            Some("2".into()),
            Some("0.1".into()),
            Some("0.2".into()),
            Some("3".into()),
            Some("USD".into()),
            Some("[]".into())
        )
    );
    target.close().await;
    source.close().await;
}

#[tokio::test]
async fn user_given_removed_model_configuration_when_backing_up_then_restores_detached_history_names_and_usage_in_both_formats(
) {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    seed_usage(&source).await;
    let expected = usage_json(&source, DAILY_USAGE).await;
    sqlx::query("DELETE FROM providers WHERE name='Backup fixture provider'")
        .execute(source.runtime.pool())
        .await
        .expect("remove configuration");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM session_turns WHERE model_id IS NULL")
            .fetch_one(source.runtime.pool())
            .await
            .expect("detached history"),
        1
    );
    for zip in [false, true] {
        let backup = backup_root.path().join(if zip {
            "removed-model.zip"
        } else {
            "removed-model.db"
        });
        if zip {
            source
                .runtime
                .export_full_backup(&backup, &source.cache)
                .await
                .expect("ZIP export");
        } else {
            source
                .runtime
                .export_backup(backup.to_str().expect("path"))
                .await
                .expect("database export");
        }
        for full in [false, true] {
            let target = Installation::new().await;
            let request = DatabaseImportRequest {
                source_path: backup.to_string_lossy().into_owned(),
                mode: if full {
                    DatabaseImportMode::Full
                } else {
                    DatabaseImportMode::ChatOnly
                },
            };
            if zip {
                target
                    .runtime
                    .import_full_backup(request, &target.cache)
                    .await
                    .expect("ZIP restore");
            } else {
                target
                    .runtime
                    .import_backup(request)
                    .await
                    .expect("database restore");
            }
            let names: (Option<i64>, String, String) =
                sqlx::query_as("SELECT model_id,model_name,provider_name FROM session_turns")
                    .fetch_one(target.runtime.pool())
                    .await
                    .expect("retained names");
            assert_eq!(
                names,
                (None, "Fixture".into(), "Backup fixture provider".into())
            );
            assert_eq!(usage_json(&target, DAILY_USAGE).await, expected);
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT count(*) FROM session_turn_attempts")
                    .fetch_one(target.runtime.pool())
                    .await
                    .expect("retained attempts"),
                1
            );
            target.close().await;
        }
    }
    source.close().await;
}

#[tokio::test]
async fn user_given_a_model_deleted_after_restoring_when_importing_the_same_backup_then_does_not_duplicate_historical_calls(
) {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    seed_usage(&source).await;
    let backup = backup_root.path().join("before-delete.zip");
    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("backup");
    let target = Installation::new().await;
    restore(&target, &backup).await.expect("first restore");
    let before = usage_json(&target, DAILY_USAGE).await;
    sqlx::query("DELETE FROM models WHERE model_id='backup-fixture'")
        .execute(target.runtime.pool())
        .await
        .expect("delete model");
    restore(&target, &backup)
        .await
        .expect("restore after association changed");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM session_turns")
            .fetch_one(target.runtime.pool())
            .await
            .expect("unique call"),
        1
    );
    assert_eq!(usage_json(&target, DAILY_USAGE).await, before);
    target.close().await;
    source.close().await;
}

#[tokio::test]
async fn user_given_shared_content_when_exporting_then_gets_each_content_object_archived_once() {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    let backup = backup_root.path().join("full.zip");

    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("full backup");

    let manifest = archive_manifest(&backup);
    assert_eq!(manifest["format"], "touchai-full-backup");
    assert_eq!(manifest["version"], 1);
    assert_eq!(manifest["files"].as_array().expect("file map").len(), 3);
    assert_eq!(manifest["blobs"].as_array().expect("blob map").len(), 2);
    for file in manifest["files"].as_array().expect("files") {
        assert_eq!(file["blob"], content_hash(SAVED_BYTES));
        assert_ne!(file["path"], "clipboard/unused.png");
    }
    let names: Vec<_> = archive_entries(&backup)
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    assert_eq!(names.len(), 3);
    assert_eq!(
        names
            .iter()
            .filter(|name| **name == format!("blobs/{}", content_hash(SAVED_BYTES)))
            .count(),
        1
    );
    source.close().await;
}

#[tokio::test]
async fn user_given_committed_history_when_exporting_then_gets_a_consistent_snapshot_without_analytics_identity(
) {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    let state = json!({
        "policyVersion": 1, "status": "disabled", "consentExplicit": 1,
        "installationId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "consentEpoch": 7,
        "observationStartedDay": "2026-01-01", "firstSuccessDay": null,
        "lastObservedAppVersion": "1.2.2", "pendingUpdateJson": "{}",
        "deploymentKey": "https://fixture.invalid|fixture", "updatedAtMs": 1
    });
    sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?)")
        .bind(ANALYTICS_STATE_SETTING)
        .bind(state.to_string())
        .execute(source.runtime.pool())
        .await
        .expect("source privacy state");
    let backup = backup_root.path().join("full.zip");
    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("full backup");
    let manifest = archive_manifest(&backup);
    let entries = archive_entries(&backup);
    let database_entry = entries
        .iter()
        .find(|entry| {
            entry.name
                == format!(
                    "blobs/{}",
                    manifest["database"].as_str().expect("database hash")
                )
        })
        .expect("database blob");
    let snapshot = backup_root.path().join("snapshot.db");
    fs::write(&snapshot, &database_entry.bytes).expect("private snapshot");
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&snapshot)
            .read_only(true),
    )
    .await
    .expect("snapshot connection");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(&mut connection)
        .await
        .expect("snapshot history");
    assert_eq!(count, 2);
    let exported: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
        .bind(ANALYTICS_STATE_SETTING)
        .fetch_one(&mut connection)
        .await
        .expect("exported state");
    let exported: Value = serde_json::from_str(&exported).expect("state JSON");
    assert_eq!(exported["installationId"], Value::Null);
    assert_eq!(exported["status"], "disabled");
    assert_eq!(exported["consentExplicit"], 1);
    assert_eq!(exported["consentEpoch"], 0);
    let unchanged: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
        .bind(ANALYTICS_STATE_SETTING)
        .fetch_one(source.runtime.pool())
        .await
        .expect("live state");
    assert_eq!(
        serde_json::from_str::<Value>(&unchanged).expect("live JSON"),
        state
    );
    connection.close().await.expect("close snapshot");
    source.close().await;
}

#[tokio::test]
async fn user_given_an_independent_backup_when_restoring_elsewhere_then_reads_saved_bytes_and_remapped_originals_without_the_source_installation(
) {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    let old_first = source.cache.join("clipboard/17.png");
    let old_external = source.root.path().join("external-source.txt");
    let backup = backup_root.path().join("full.zip");
    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("full backup");
    fs::write(attachment_path(&source.cache), b"changed live attachment")
        .expect("mutate live data after backup");
    fs::write(&old_first, b"changed live original").expect("mutate original after backup");
    source.close().await;
    let target = Installation::new().await;

    restore(&target, &backup)
        .await
        .expect("restore independent backup");

    assert_eq!(
        fs::read(attachment_path(&target.cache)).expect("restored attachment"),
        SAVED_BYTES
    );
    for name in ["17.png", "18.png"] {
        assert_eq!(
            fs::read(target.cache.join("clipboard").join(name)).expect("restored original"),
            SAVED_BYTES
        );
    }
    assert_eq!(
        crate::core::storage::files::physical_file(&attachment_path(&target.cache))
            .expect("attachment identity")
            .identity,
        crate::core::storage::files::physical_file(&target.cache.join("clipboard/17.png"))
            .expect("original identity")
            .identity,
        "immutable aliases restore without duplicating file contents",
    );
    let origin: String = sqlx::query_scalar("SELECT origin_path FROM attachments")
        .fetch_one(target.runtime.pool())
        .await
        .expect("attachment origin");
    assert_eq!(
        origin,
        target
            .cache
            .join("clipboard/17.png")
            .to_str()
            .expect("target path")
    );
    let origins: Vec<String> = sqlx::query_scalar("SELECT json_extract(data, '$.originPath') FROM message_parts WHERE type = 'attachment' ORDER BY id").fetch_all(target.runtime.pool()).await.expect("part origins");
    assert_eq!(
        origins,
        vec![
            target
                .cache
                .join("clipboard/17.png")
                .to_string_lossy()
                .into_owned(),
            target
                .cache
                .join("clipboard/18.png")
                .to_string_lossy()
                .into_owned()
        ]
    );
    let snapshot: String = sqlx::query_scalar(
        "SELECT prompt_snapshot_json FROM session_turns WHERE task_id = 'backup-fixture-task'",
    )
    .fetch_one(target.runtime.pool())
    .await
    .expect("restored prompt");
    let snapshot: Value = serde_json::from_str(&snapshot).expect("prompt JSON");
    assert_eq!(
        snapshot["attachments"][0]["originPath"],
        target
            .cache
            .join("clipboard/17.png")
            .to_string_lossy()
            .as_ref()
    );
    assert_eq!(
        snapshot["inputSnapshot"]["editorDoc"]["attrs"]["origin_path"],
        target
            .cache
            .join("clipboard/18.png")
            .to_string_lossy()
            .as_ref()
    );
    assert_eq!(
        snapshot["attachments"][1]["originPath"],
        old_external.to_string_lossy().as_ref()
    );
    assert_eq!(
        snapshot["userPrompt"],
        format!("{} is mentioned in prose", old_first.display())
    );
    assert!(!old_external.exists());
    assert_eq!(setting(&target).await, "backup");
    target.close().await;
}

#[tokio::test]
async fn user_given_a_legacy_database_when_exporting_and_importing_then_keeps_the_database_only_contract_and_import_modes(
) {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    let backup = backup_root.path().join("legacy.db");
    source
        .runtime
        .export_backup(backup.to_str().expect("legacy path"))
        .await
        .expect("legacy export");
    assert!(fs::read(&backup)
        .expect("legacy bytes")
        .starts_with(b"SQLite format 3\0"));
    source.close().await;
    let target = Installation::new().await;
    sqlx::query("INSERT INTO settings (key, value) VALUES ('keep', 'local')")
        .execute(target.runtime.pool())
        .await
        .expect("local setting");
    for (mode, expected_setting) in [
        (DatabaseImportMode::ChatOnly, "local"),
        (DatabaseImportMode::Full, "backup"),
    ] {
        target
            .runtime
            .import_backup(DatabaseImportRequest {
                source_path: backup.to_str().expect("backup path").to_string(),
                mode,
            })
            .await
            .expect("legacy import");
        assert_eq!(setting(&target).await, expected_setting);
        let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
            .fetch_one(target.runtime.pool())
            .await
            .expect("legacy history");
        assert_eq!(sessions, 2);
        assert!(cache_contents(&target.cache).is_empty());
    }
    target.close().await;
}

#[tokio::test]
async fn user_given_distinct_original_and_normalized_bytes_when_restoring_then_reads_both_saved_versions(
) {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    let original_bytes = b"retained original before image normalization";
    fs::write(source.cache.join("clipboard/17.png"), original_bytes)
        .expect("distinct original fixture");
    let backup = backup_root.path().join("full.zip");
    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("full backup");
    source.close().await;
    let target = Installation::new().await;

    restore(&target, &backup)
        .await
        .expect("restore both versions");

    assert_eq!(
        fs::read(attachment_path(&target.cache)).expect("normalized attachment"),
        SAVED_BYTES
    );
    assert_eq!(
        fs::read(target.cache.join("clipboard/17.png")).expect("retained original"),
        original_bytes
    );
    assert_eq!(
        archive_manifest(&backup)["blobs"]
            .as_array()
            .expect("blobs")
            .len(),
        3
    );
    target.close().await;
}

#[tokio::test]
async fn user_given_foreign_root_labels_when_restoring_then_reads_originals_in_the_current_cache() {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    let native_backup = backup_root.path().join("native.zip");
    source
        .runtime
        .export_full_backup(&native_backup, &source.cache)
        .await
        .expect("native backup");
    let mut entries = archive_entries(&native_backup);
    let mut manifest = archive_manifest(&native_backup);
    let old_database_hash = manifest["database"]
        .as_str()
        .expect("database hash")
        .to_string();
    let database_index = entries
        .iter()
        .position(|entry| entry.name == format!("blobs/{old_database_hash}"))
        .expect("database blob");
    let snapshot = backup_root.path().join("foreign.db");
    fs::write(&snapshot, &entries[database_index].bytes).expect("private foreign snapshot");
    let mut connection =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&snapshot))
            .await
            .expect("foreign snapshot connection");
    let first = r"C:\OldMachine\cache\clipboard\17.png";
    let second = r"\\?\C:\OldMachine\cache\clipboard\18.png";
    for (old, foreign) in [
        (source.cache.join("clipboard/17.png"), first),
        (source.cache.join("clipboard/18.png"), second),
    ] {
        sqlx::query("UPDATE attachments SET origin_path = ? WHERE origin_path = ?")
            .bind(foreign)
            .bind(old.to_str().expect("native origin"))
            .execute(&mut connection)
            .await
            .expect("foreign attachment origin");
        sqlx::query("UPDATE message_parts SET data = json_set(data, '$.originPath', ?) WHERE json_extract(data, '$.originPath') = ?")
            .bind(foreign).bind(old.to_str().expect("native origin"))
            .execute(&mut connection).await.expect("foreign part origin");
    }
    sqlx::query("UPDATE session_turns SET prompt_snapshot_json = json_set(prompt_snapshot_json, '$.attachments[0].originPath', ?, '$.inputSnapshot.editorDoc.attrs.origin_path', ?)")
        .bind(first).bind(second).execute(&mut connection).await.expect("foreign prompt origins");
    connection
        .close()
        .await
        .expect("close foreign snapshot before reading its bytes");
    entries[database_index].bytes = fs::read(&snapshot).expect("foreign snapshot bytes");
    let database_hash = content_hash(&entries[database_index].bytes);
    entries[database_index].name = format!("blobs/{database_hash}");
    for blob in manifest["blobs"].as_array_mut().expect("blobs") {
        if blob["sha256"] == old_database_hash {
            blob["sha256"] = json!(database_hash);
            blob["bytes"] = json!(entries[database_index].bytes.len());
        }
    }
    manifest["database"] = json!(database_hash);
    manifest["cacheRoot"] = json!(r"c:\OldMachine\cache");
    manifest["windowsPaths"] = json!(true);
    for origin in manifest["origins"].as_array_mut().expect("origins") {
        origin["source"] = if origin["path"] == "clipboard/17.png" {
            json!(first)
        } else {
            json!(second)
        };
    }
    entries
        .iter_mut()
        .find(|entry| entry.name == "manifest.json")
        .expect("manifest entry")
        .bytes = serde_json::to_vec(&manifest).expect("foreign manifest");
    let foreign_backup = backup_root.path().join("foreign.zip");
    write_entries(&foreign_backup, entries);
    source.close().await;
    let target = Installation::new().await;

    restore(&target, &foreign_backup)
        .await
        .expect("restore foreign path labels without their source installation");

    for name in ["17.png", "18.png"] {
        assert_eq!(
            fs::read(target.cache.join("clipboard").join(name)).expect("restored original"),
            SAVED_BYTES
        );
    }
    let origins: Vec<String> = sqlx::query_scalar("SELECT json_extract(data, '$.originPath') FROM message_parts WHERE type = 'attachment' ORDER BY id").fetch_all(target.runtime.pool()).await.expect("current part origins");
    assert_eq!(
        origins,
        vec![
            target
                .cache
                .join("clipboard/17.png")
                .to_string_lossy()
                .into_owned(),
            target
                .cache
                .join("clipboard/18.png")
                .to_string_lossy()
                .into_owned()
        ]
    );
    target.close().await;
}

#[tokio::test]
async fn user_given_unreferenced_missing_cache_metadata_when_exporting_then_backs_up_valid_history_without_changing_live_rows(
) {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    sqlx::query("INSERT INTO attachments(hash,type,original_name,origin_path) VALUES(?, 'file', 'unused', '/unused')")
        .bind(content_hash(b"orphan metadata without a file")).execute(source.runtime.pool()).await.expect("orphan row");
    let backup = backup_root.path().join("full.zip");
    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("valid history backup");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM attachments")
            .fetch_one(source.runtime.pool())
            .await
            .expect("live rows"),
        2
    );
    let target = Installation::new().await;
    restore(&target, &backup)
        .await
        .expect("restore valid references");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM attachments")
            .fetch_one(target.runtime.pool())
            .await
            .expect("restored rows"),
        1
    );
    target.close().await;
    source.close().await;
}

#[tokio::test]
async fn user_given_a_retained_browser_original_when_restoring_then_reads_it_at_the_new_cache_root()
{
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    let original = source
        .cache
        .join("temporary/touchai-browser-artifacts-fixture/browser-screenshot-1-2.png");
    fs::create_dir_all(original.parent().expect("parent")).expect("browser original directory");
    fs::write(&original, b"full browser original").expect("original");
    sqlx::query("UPDATE session_turns SET prompt_snapshot_json = json_set(prompt_snapshot_json, '$.browser.originPath', ?)")
        .bind(original.to_str().expect("path")).execute(source.runtime.pool()).await.expect("original reference");
    let backup = backup_root.path().join("full.zip");
    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("full backup");
    let target = Installation::new().await;
    restore(&target, &backup).await.expect("restore");
    let path = target
        .cache
        .join("temporary/touchai-browser-artifacts-fixture/browser-screenshot-1-2.png");
    assert_eq!(
        fs::read(&path).expect("restored original"),
        b"full browser original"
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT json_extract(prompt_snapshot_json, '$.browser.originPath') FROM session_turns"
        )
        .fetch_one(target.runtime.pool())
        .await
        .expect("new path"),
        path.to_string_lossy().into_owned()
    );
    target.close().await;
    source.close().await;
}

#[tokio::test]
async fn user_given_editable_original_bytes_when_restoring_then_changes_the_copy_without_mutating_history(
) {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    let editable = source.cache.join("clipboard/editable.bin");
    fs::write(&editable, SAVED_BYTES).expect("editable original");
    sqlx::query("UPDATE session_turns SET prompt_snapshot_json = json_set(prompt_snapshot_json, '$.editable.path', ?)")
        .bind(editable.to_str().expect("path")).execute(source.runtime.pool()).await.expect("reference");
    let backup = backup_root.path().join("full.zip");
    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("backup");
    let target = Installation::new().await;
    restore(&target, &backup).await.expect("restore");
    fs::write(
        target.cache.join("clipboard/editable.bin"),
        b"edited independently",
    )
    .expect("edit copied output");
    assert_eq!(
        fs::read(attachment_path(&target.cache)).expect("history bytes"),
        SAVED_BYTES
    );
    target.close().await;
    source.close().await;
}

#[tokio::test]
async fn user_given_missing_managed_content_when_exporting_then_preserves_the_previous_backup() {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    let backup = backup_root.path().join("full.zip");
    fs::write(&backup, b"previous independent backup").expect("previous backup");
    fs::remove_file(attachment_path(&source.cache)).expect("remove controlled attachment");

    let error = source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect_err("missing attachment is refused");

    assert!(error.contains("missing"), "{error}");
    assert_eq!(
        fs::read(&backup).expect("previous backup"),
        b"previous independent backup"
    );
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(source.runtime.pool())
        .await
        .expect("unchanged history");
    assert_eq!(sessions, 2);
    fs::write(attachment_path(&source.cache), SAVED_BYTES).expect("repair controlled attachment");
    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("subsequent export");
    assert_eq!(archive_manifest(&backup)["version"], 1);
    source.close().await;
}

#[tokio::test]
async fn user_given_an_absent_cache_when_restoring_then_gets_readable_managed_files() {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    let backup = backup_root.path().join("full.zip");
    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("full backup");
    let target = Installation::new().await;
    fs::remove_dir(&target.cache).expect("absent target cache");

    restore(&target, &backup)
        .await
        .expect("restore into absent cache");

    assert_eq!(
        fs::read(attachment_path(&target.cache)).expect("restored attachment"),
        SAVED_BYTES
    );
    assert_eq!(cache_contents(&target.cache).len(), 3);
    target.close().await;
    source.close().await;
}

#[tokio::test]
async fn user_given_an_external_original_when_restoring_then_keeps_external_bytes_and_locations_unchanged(
) {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    let external = source.root.path().join("external-source.txt");
    fs::write(&external, b"external original").expect("private external original");
    sqlx::query("UPDATE attachments SET origin_path = ?")
        .bind(external.to_str().expect("external path"))
        .execute(source.runtime.pool())
        .await
        .expect("external attachment origin");
    let backup = backup_root.path().join("full.zip");
    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("full backup");
    fs::write(&external, b"changed external original").expect("external content changes");
    let target = Installation::new().await;

    restore(&target, &backup)
        .await
        .expect("restore managed content");

    assert_eq!(
        fs::read(&external).expect("external content"),
        b"changed external original"
    );
    let snapshot: String = sqlx::query_scalar(
        "SELECT prompt_snapshot_json FROM session_turns WHERE task_id = 'backup-fixture-task'",
    )
    .fetch_one(target.runtime.pool())
    .await
    .expect("restored prompt");
    let snapshot: Value = serde_json::from_str(&snapshot).expect("prompt JSON");
    let origin: String = sqlx::query_scalar("SELECT origin_path FROM attachments")
        .fetch_one(target.runtime.pool())
        .await
        .expect("restored external origin");
    assert_eq!(origin, external.to_str().expect("external path"));
    assert_eq!(
        snapshot["attachments"][1]["originPath"],
        external.to_string_lossy().as_ref()
    );
    assert_eq!(cache_contents(&target.cache).len(), 3);
    target.close().await;
    source.close().await;
}

#[derive(Clone, Copy, Debug)]
enum Damage {
    BlobHash,
    DatabaseContent,
    ManifestTraversal,
    ArchiveTraversal,
    AbsoluteArchivePath,
    WindowsArchivePath,
    BackslashArchivePath,
    DuplicateEntry,
    DuplicateManagedPath,
    DuplicateOriginal,
    SymbolicLink,
    ReparseEntry,
    UnsupportedVersion,
    EntryBudget,
    ExpandedBudget,
    MissingOriginal,
}

impl Damage {
    fn error_fragment(self) -> &'static str {
        match self {
            Self::BlobHash => "SHA-256 verification",
            Self::DatabaseContent => "database",
            Self::ManifestTraversal
            | Self::ArchiveTraversal
            | Self::AbsoluteArchivePath
            | Self::WindowsArchivePath
            | Self::BackslashArchivePath => "unsafe relative path",
            Self::DuplicateEntry => "duplicate entries",
            Self::DuplicateManagedPath => "duplicate managed paths",
            Self::DuplicateOriginal => "duplicate original path",
            Self::SymbolicLink | Self::ReparseEntry => "non-regular entries",
            Self::UnsupportedVersion => "Unsupported full backup manifest",
            Self::EntryBudget => "entry count budget",
            Self::ExpandedBudget => "expanded size budget",
            Self::MissingOriginal => "original path mapping",
        }
    }
}

fn damaged_archive(source: &std::path::Path, destination: &std::path::Path, damage: Damage) {
    let mut entries = archive_entries(source);
    let manifest_index = entries
        .iter()
        .position(|entry| entry.name == "manifest.json")
        .expect("manifest index");
    let mut manifest: Value =
        serde_json::from_slice(&entries[manifest_index].bytes).expect("manifest JSON");
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o600);
    match damage {
        Damage::BlobHash => {
            let blob = entries
                .iter_mut()
                .find(|entry| entry.name == format!("blobs/{}", content_hash(SAVED_BYTES)))
                .expect("shared blob");
            blob.bytes[0] ^= 0xff;
        }
        Damage::DatabaseContent => {
            let old_hash = manifest["database"]
                .as_str()
                .expect("database hash")
                .to_string();
            let entry = entries
                .iter_mut()
                .find(|entry| entry.name == format!("blobs/{old_hash}"))
                .expect("database blob");
            entry.bytes[0] ^= 0xff;
            let hash = content_hash(&entry.bytes);
            entry.name = format!("blobs/{hash}");
            for blob in manifest["blobs"].as_array_mut().expect("blobs") {
                if blob["sha256"] == old_hash {
                    blob["sha256"] = json!(hash);
                }
            }
            manifest["database"] = json!(hash);
        }
        Damage::ManifestTraversal => manifest["files"][0]["path"] = json!("../escape.txt"),
        Damage::ArchiveTraversal => entries.push(ArchiveEntry {
            name: "../escape.txt".to_string(),
            bytes: b"escape".to_vec(),
            options,
        }),
        Damage::AbsoluteArchivePath | Damage::WindowsArchivePath | Damage::BackslashArchivePath => {
            entries.push(ArchiveEntry {
                name: match damage {
                    Damage::AbsoluteArchivePath => "/escape.txt",
                    Damage::WindowsArchivePath => r"C:\escape.txt",
                    _ => r"..\escape.txt",
                }
                .to_string(),
                bytes: b"escape".to_vec(),
                options,
            })
        }
        Damage::DuplicateEntry => entries.push(ArchiveEntry {
            name: "repeated.json".to_string(),
            bytes: b"{}".to_vec(),
            options,
        }),
        Damage::DuplicateManagedPath => {
            let duplicate = manifest["files"][0].clone();
            manifest["files"]
                .as_array_mut()
                .expect("files")
                .push(duplicate);
        }
        Damage::DuplicateOriginal => {
            let duplicate = manifest["origins"][0].clone();
            manifest["origins"]
                .as_array_mut()
                .expect("origins")
                .push(duplicate);
        }
        Damage::SymbolicLink => {
            entries[manifest_index].options = options
                .system(zip::System::Unix)
                .external_attributes(0o120777 << 16)
        }
        Damage::ReparseEntry => {
            entries[manifest_index].options =
                options.system(zip::System::Dos).external_attributes(0x400)
        }
        Damage::UnsupportedVersion => manifest["version"] = json!(999),
        Damage::EntryBudget => {}
        Damage::ExpandedBudget => {
            for index in 0..6 {
                entries.push(ArchiveEntry {
                    name: format!("blobs/{}", content_hash(&[index])),
                    bytes: vec![index],
                    options,
                });
            }
        }
        Damage::MissingOriginal => {
            let files = manifest["files"].as_array_mut().expect("files");
            let index = files
                .iter()
                .position(|file| file["path"] == "clipboard/18.png")
                .expect("second original");
            files.remove(index);
        }
    }
    entries[manifest_index].bytes = serde_json::to_vec(&manifest).expect("mutated manifest");
    write_entries(destination, entries);
    if matches!(damage, Damage::DuplicateEntry) {
        let mut bytes = fs::read(destination).expect("archive bytes");
        for offset in 0..=bytes.len() - b"repeated.json".len() {
            if bytes[offset..].starts_with(b"repeated.json") {
                bytes[offset..offset + b"manifest.json".len()].copy_from_slice(b"manifest.json");
            }
        }
        fs::write(destination, bytes).expect("duplicate local and central names");
    }
    if matches!(damage, Damage::EntryBudget) {
        let mut bytes = fs::read(destination).expect("archive bytes");
        let end = bytes.len() - 22;
        let count = 50_003_u16.to_le_bytes();
        bytes[end + 8..end + 10].copy_from_slice(&count);
        bytes[end + 10..end + 12].copy_from_slice(&count);
        fs::write(destination, bytes).expect("oversized entry declaration");
    }
    if matches!(damage, Damage::ExpandedBudget) {
        let archive = ZipArchive::new(fs::File::open(destination).expect("fixture archive"))
            .expect("archive metadata");
        let offsets: Vec<_> = (0..archive.len())
            .filter_map(|index| {
                let entry = archive.by_index_data(index).expect("entry metadata");
                (entry.name().expect("entry name") != "manifest.json")
                    .then_some(entry.central_header_start() as usize)
            })
            .collect();
        drop(archive);
        let mut bytes = fs::read(destination).expect("archive bytes");
        for offset in offsets {
            bytes[offset + 24..offset + 28]
                .copy_from_slice(&(3_u32 * 1024 * 1024 * 1024).to_le_bytes());
        }
        fs::write(destination, bytes).expect("oversized expansion declaration");
    }
}

#[tokio::test]
async fn user_given_an_invalid_archive_when_restoring_then_keeps_database_files_and_external_locations_unchanged(
) {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    let valid = backup_root.path().join("valid.zip");
    source
        .runtime
        .export_full_backup(&valid, &source.cache)
        .await
        .expect("valid export");
    let target = Installation::new().await;
    fs::create_dir(target.cache.join("clipboard")).expect("existing original directory");
    fs::write(target.cache.join("clipboard/keep.png"), b"local original")
        .expect("existing original");
    sqlx::query("INSERT INTO settings (key, value) VALUES ('keep', 'local')")
        .execute(target.runtime.pool())
        .await
        .expect("local setting");
    let before = cache_contents(&target.cache);
    for damage in [
        Damage::BlobHash,
        Damage::DatabaseContent,
        Damage::ManifestTraversal,
        Damage::ArchiveTraversal,
        Damage::AbsoluteArchivePath,
        Damage::WindowsArchivePath,
        Damage::BackslashArchivePath,
        Damage::DuplicateEntry,
        Damage::DuplicateManagedPath,
        Damage::DuplicateOriginal,
        Damage::SymbolicLink,
        Damage::ReparseEntry,
        Damage::UnsupportedVersion,
        Damage::EntryBudget,
        Damage::ExpandedBudget,
        Damage::MissingOriginal,
    ] {
        let damaged = backup_root.path().join("damaged.zip");
        damaged_archive(&valid, &damaged, damage);
        let error = restore(&target, &damaged)
            .await
            .expect_err("invalid archive is refused");
        assert!(
            error.contains(damage.error_fragment()),
            "{damage:?}: {error}"
        );
        assert_eq!(cache_contents(&target.cache), before, "{damage:?}: {error}");
        assert_eq!(setting(&target).await, "local", "{damage:?}");
        let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
            .fetch_one(target.runtime.pool())
            .await
            .expect("unchanged history");
        assert_eq!(sessions, 0, "{damage:?}");
        assert!(!backup_root.path().join("escape.txt").exists());
        assert!(!target.root.path().join("escape.txt").exists());
    }
    restore(&target, &valid)
        .await
        .expect("valid restore after validation errors");
    target.close().await;
    source.close().await;
}

#[tokio::test]
async fn user_given_a_conflicting_retained_original_when_restoring_then_keeps_local_bytes_and_database_unchanged(
) {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    let backup = backup_root.path().join("full.zip");
    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("full backup");
    let target = Installation::new().await;
    fs::create_dir(target.cache.join("clipboard")).expect("existing original directory");
    fs::write(
        target.cache.join("clipboard/17.png"),
        b"different retained original",
    )
    .expect("conflicting original");
    sqlx::query("INSERT INTO settings (key, value) VALUES ('keep', 'local')")
        .execute(target.runtime.pool())
        .await
        .expect("local setting");
    let before = cache_contents(&target.cache);

    let error = restore(&target, &backup)
        .await
        .expect_err("conflicting original is refused");

    assert!(error.contains("conflict"), "{error}");
    assert_eq!(cache_contents(&target.cache), before);
    assert_eq!(setting(&target).await, "local");
    target.close().await;
    source.close().await;
}

#[tokio::test]
async fn user_given_a_failed_database_merge_when_restoring_then_removes_only_new_files_and_can_restore_again(
) {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    let backup = backup_root.path().join("full.zip");
    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("full backup");
    let target = Installation::new().await;
    fs::create_dir(target.cache.join("clipboard")).expect("existing original directory");
    fs::write(target.cache.join("clipboard/17.png"), SAVED_BYTES)
        .expect("matching pre-existing original");
    sqlx::raw_sql(
        "INSERT INTO settings (key, value) VALUES ('keep', 'local');
         CREATE TRIGGER refuse_fixture_import BEFORE INSERT ON sessions
         WHEN NEW.session_id = 'backup-first'
         BEGIN SELECT RAISE(ABORT, 'fixture import refused'); END;",
    )
    .execute(target.runtime.pool())
    .await
    .expect("controlled import failure");
    let before = cache_contents(&target.cache);

    let error = restore(&target, &backup)
        .await
        .expect_err("database merge is refused");

    assert!(error.contains("fixture import refused"), "{error}");
    assert_eq!(cache_contents(&target.cache), before);
    assert_eq!(setting(&target).await, "local");
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(target.runtime.pool())
        .await
        .expect("rolled-back history");
    assert_eq!(sessions, 0);
    assert!(fs::read_dir(target.root.path().join("data"))
        .expect("database directory")
        .all(|entry| !entry.expect("entry").path().is_dir()));
    sqlx::query("DROP TRIGGER refuse_fixture_import")
        .execute(target.runtime.pool())
        .await
        .expect("remove controlled failure");
    restore(&target, &backup).await.expect("subsequent restore");
    assert_eq!(
        fs::read(attachment_path(&target.cache)).expect("restored attachment"),
        SAVED_BYTES
    );
    assert_eq!(
        fs::read(target.cache.join("clipboard/17.png")).expect("preserved original"),
        SAVED_BYTES
    );
    assert_eq!(
        fs::read(target.cache.join("clipboard/18.png")).expect("published original"),
        SAVED_BYTES
    );
    target.close().await;
    source.close().await;
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn user_given_relocated_platform_directories_when_backing_up_then_restores_managed_originals_through_logical_paths(
) {
    let backup_root = private_directory();
    let mut source = Installation::new().await;
    seed_history(&source).await;
    let logical = backup_root.path().join("source-platform");
    #[cfg(unix)]
    std::os::unix::fs::symlink(source.root.path(), &logical).expect("platform redirect");
    #[cfg(windows)]
    assert!(std::process::Command::new("cmd")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(&logical)
        .arg(source.root.path())
        .output()
        .expect("platform junction")
        .status
        .success());
    source.runtime.pool().close().await;
    source.runtime = DatabaseRuntime::initialize_for_tests(&logical.join("data"))
        .await
        .expect("logical database path");
    source.cache = logical.join("cache");
    let logical_origin = source.cache.join("clipboard/17.png");
    sqlx::query("UPDATE attachments SET origin_path = ?")
        .bind(logical_origin.to_string_lossy().as_ref())
        .execute(source.runtime.pool())
        .await
        .expect("logical original reference");
    let backup = backup_root.path().join("platform.zip");
    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("platform backup");
    let mut target = Installation::new().await;
    let logical_target = backup_root.path().join("target-platform");
    #[cfg(unix)]
    std::os::unix::fs::symlink(target.root.path(), &logical_target).expect("target redirect");
    #[cfg(windows)]
    assert!(std::process::Command::new("cmd")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(&logical_target)
        .arg(target.root.path())
        .output()
        .expect("target junction")
        .status
        .success());
    target.runtime.pool().close().await;
    target.runtime = DatabaseRuntime::initialize_for_tests(&logical_target.join("data"))
        .await
        .expect("logical target database");
    target
        .runtime
        .import_full_backup(
            DatabaseImportRequest {
                source_path: backup.to_string_lossy().into_owned(),
                mode: DatabaseImportMode::Full,
            },
            &logical_target.join("cache"),
        )
        .await
        .expect("restore through platform ancestor");
    let origin: String = sqlx::query_scalar("SELECT origin_path FROM attachments")
        .fetch_one(target.runtime.pool())
        .await
        .expect("restored original");
    assert_eq!(
        fs::read(origin).expect("readable remapped original"),
        SAVED_BYTES
    );
    assert_eq!(
        fs::read(attachment_path(&logical_target.join("cache"))).expect("logical attachment path"),
        SAVED_BYTES
    );
    source.runtime.pool().close().await;
    target.runtime.pool().close().await;
    source.cache = source.root.path().join("cache");
    #[cfg(unix)]
    {
        fs::remove_file(&logical).expect("remove private link");
        fs::remove_file(&logical_target).expect("remove private link");
    }
    #[cfg(windows)]
    {
        fs::remove_dir(&logical).expect("remove private junction");
        fs::remove_dir(&logical_target).expect("remove private junction");
    }
    target.close().await;
    source.close().await;
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn user_given_a_redirected_managed_directory_when_restoring_then_never_writes_external_files()
{
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    let backup = backup_root.path().join("full.zip");
    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("full backup");
    let target = Installation::new().await;
    let external = backup_root.path().join("outside");
    fs::create_dir(&external).expect("private external directory");
    fs::write(external.join("keep.txt"), b"external content").expect("external file");
    fs::create_dir(target.cache.join("attachments")).expect("managed attachment root");
    let redirected = target.cache.join("attachments/images");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&external, &redirected).expect("controlled symbolic link");
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(&external, &redirected)
        .expect("Windows CI permits controlled reparse fixtures");

    let error = restore(&target, &backup)
        .await
        .expect_err("redirected managed directory is refused");

    assert!(
        error.contains("link") || error.contains("reparse"),
        "{error}"
    );
    assert_eq!(
        fs::read(external.join("keep.txt")).expect("external content"),
        b"external content"
    );
    assert_eq!(
        fs::read_dir(&external).expect("external directory").count(),
        1
    );
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(target.runtime.pool())
        .await
        .expect("unchanged history");
    assert_eq!(sessions, 0);
    #[cfg(unix)]
    fs::remove_file(&redirected).expect("remove fixture link");
    #[cfg(windows)]
    fs::remove_dir(&redirected).expect("remove fixture reparse directory");
    target.close().await;
    source.close().await;
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn user_given_a_redirected_cache_root_when_restoring_then_does_not_follow_it_or_change_external_files(
) {
    let backup_root = private_directory();
    let source = Installation::new().await;
    seed_history(&source).await;
    let backup = backup_root.path().join("full.zip");
    source
        .runtime
        .export_full_backup(&backup, &source.cache)
        .await
        .expect("full backup");
    let mut target = Installation::new().await;
    let external = backup_root.path().join("outside");
    fs::create_dir(&external).expect("external directory");
    fs::write(external.join("keep.txt"), b"external content").expect("external file");
    fs::remove_dir(&target.cache).expect("empty cache");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&external, &target.cache).expect("controlled symbolic link");
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(&external, &target.cache)
        .expect("Windows CI permits controlled reparse fixtures");

    let error = restore(&target, &backup)
        .await
        .expect_err("redirected cache is refused");

    assert!(
        error.contains("link") || error.contains("reparse"),
        "{error}"
    );
    assert_eq!(
        fs::read(external.join("keep.txt")).expect("external content"),
        b"external content"
    );
    assert_eq!(
        fs::read_dir(&external).expect("external directory").count(),
        1
    );
    #[cfg(unix)]
    fs::remove_file(&target.cache).expect("remove fixture link");
    #[cfg(windows)]
    fs::remove_dir(&target.cache).expect("remove fixture reparse directory");
    target.cache = target.root.path().join("cache");
    fs::create_dir(&target.cache).expect("real cache");
    restore(&target, &backup)
        .await
        .expect("restore after removing redirected root");
    target.close().await;
    source.close().await;
}
