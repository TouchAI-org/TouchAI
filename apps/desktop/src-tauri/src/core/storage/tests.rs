use super::*;
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use std::io::Write;

struct FixtureRoot(tempfile::TempDir);

impl std::ops::Deref for FixtureRoot {
    type Target = tempfile::TempDir;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Drop for FixtureRoot {
    fn drop(&mut self) {
        // Only test-owned fixtures are made writable for Windows TempDir cleanup.
        let mut directories = vec![self.0.path().to_path_buf()];
        while let Some(directory) = directories.pop() {
            let Ok(entries) = fs::read_dir(directory) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let Ok(metadata) = fs::symlink_metadata(&path) else {
                    continue;
                };
                if files::is_reparse(&metadata) {
                    continue;
                }
                if metadata.is_dir() {
                    directories.push(path);
                } else if metadata.permissions().readonly() {
                    let mut permissions = metadata.permissions();
                    permissions.set_readonly(false);
                    let _ = fs::set_permissions(path, permissions);
                }
            }
        }
    }
}

async fn fixture() -> (FixtureRoot, DatabaseRuntime, StorageRuntime) {
    let parent = fs::canonicalize(std::env::temp_dir()).expect("physical fixture root");
    let root = FixtureRoot(tempfile::tempdir_in(parent).expect("private fixture"));
    let data = root.path().join("data");
    fs::create_dir_all(&data).expect("data directory");
    let database = DatabaseRuntime::initialize_for_tests(&data)
        .await
        .expect("database");
    let cache = root.path().join("cache");
    fs::create_dir_all(&cache).expect("cache directory");
    let storage = StorageRuntime::new(database.clone(), cache);
    (root, database, storage)
}

#[cfg(any(unix, windows))]
fn directory_link(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).expect("private directory link");
    #[cfg(windows)]
    {
        let result = std::process::Command::new("cmd")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("private junction");
        assert!(result.status.success(), "junction creation failed");
    }
}

fn old(path: &Path) {
    fs::File::options()
        .write(true)
        .open(path)
        .expect("fixture handle")
        .set_times(
            fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(10)),
        )
        .expect("controlled modification time");
}

async fn attach(
    database: &DatabaseRuntime,
    storage: &StorageRuntime,
    source: &Path,
) -> (i64, PathBuf) {
    let published = storage
        .publish_attachment("image".into(), source.into(), None)
        .await
        .expect("snapshot");
    let id: i64 = sqlx::query_scalar("INSERT INTO attachments (hash, type, original_name, origin_path, mime_type, size, created_at) VALUES (?, 'image', 'fixture.png', ?, 'image/png', ?, '2000-01-01 00:00:00') RETURNING id")
        .bind(published.hash).bind(source.to_string_lossy().as_ref()).bind(published.size as i64)
        .fetch_one(database.pool()).await.expect("attachment row");
    (id, PathBuf::from(published.path))
}

async fn messages(database: &DatabaseRuntime, attachment: i64) {
    sqlx::raw_sql("INSERT INTO sessions (id,session_id,title,model) VALUES (1,'first','First','test'), (2,'second','Second','test'); INSERT INTO messages(id,session_id,role) VALUES (1,1,'user'),(2,2,'user');")
        .execute(database.pool()).await.expect("conversations");
    for message in [1, 2] {
        sqlx::query("INSERT INTO message_parts(message_id,type,content,data,sort_order) VALUES (?,'attachment','',?,0)")
            .bind(message).bind(serde_json::json!({"attachmentId": attachment}).to_string())
            .execute(database.pool()).await.expect("message reference");
    }
}

#[tokio::test]
async fn user_given_a_database_reset_and_unused_cleanup_when_attachments_are_not_selected_then_previously_referenced_files_are_retained(
) {
    let (root, database, storage) = fixture().await;
    let source = root.path().join("original.png");
    fs::write(&source, b"keep saved image").expect("original");
    let (attachment, cached) = attach(&database, &storage, &source).await;
    messages(&database, attachment).await;
    let lease = storage.exclusive().await.expect("exclusive");
    let result = storage
        .cleanup_selected(
            StorageCleanupSelection {
                unused: true,
                categories: vec![StorageCategory::Database],
            },
            Vec::new(),
            lease,
        )
        .await
        .expect("database reset");
    assert!(result.restart_required);
    assert!(database.pool().is_closed());
    assert_eq!(
        fs::read(cached).expect("unselected attachment retained"),
        b"keep saved image"
    );
}

#[tokio::test]
async fn user_given_invalid_recovery_metadata_when_deleting_attachments_then_the_transaction_rolls_back_and_files_remain(
) {
    let (root, database, storage) = fixture().await;
    let source = root.path().join("original.png");
    fs::write(&source, b"keep saved image").expect("original");
    let (attachment, cached) = attach(&database, &storage, &source).await;
    messages(&database, attachment).await;
    sqlx::query("INSERT INTO session_turns(task_id,prompt_snapshot_json) VALUES('invalid','{')")
        .execute(database.pool())
        .await
        .expect("old invalid snapshot");
    assert_eq!(
        selected_cleanup(&storage, vec![StorageCategory::Attachments])
            .await
            .expect_err("preflight metadata refusal"),
        "storage_scan_incomplete"
    );
    assert!(cached.exists());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM attachments")
            .fetch_one(database.pool())
            .await
            .expect("retained metadata"),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM message_parts WHERE attachment_id = ?")
            .bind(attachment)
            .fetch_one(database.pool())
            .await
            .expect("retained associations"),
        2
    );
    database.pool().close().await;
}

#[cfg(windows)]
#[tokio::test]
async fn user_given_a_locked_log_when_deleting_logs_then_sees_the_failure_and_can_retry_the_remaining_file(
) {
    use std::os::windows::fs::OpenOptionsExt;
    let (root, database, storage) = fixture().await;
    let logs = root.path().join("logs");
    fs::create_dir(&logs).expect("logs");
    let locked = logs.join("locked.log");
    let removable = logs.join("removable.log");
    fs::write(&locked, b"locked bytes").expect("locked file");
    fs::write(&removable, b"removable bytes").expect("removable file");
    let handle = fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&locked)
        .expect("reader denies deletion");
    let result = selected_cleanup(&storage, vec![StorageCategory::Logs])
        .await
        .expect("partial cleanup");
    assert_eq!(result.removed_files, 1);
    assert_eq!(result.failed_files, 1);
    assert_eq!(PathBuf::from(&result.failures[0].path), locked);
    assert!(locked.exists());
    assert!(!removable.exists());
    drop(handle);
    let retry = selected_cleanup(&storage, vec![StorageCategory::Logs])
        .await
        .expect("retry after reader closes");
    assert_eq!(retry.removed_files, 1);
    assert_eq!(retry.failed_files, 0);
    database.pool().close().await;
}

async fn selected_cleanup(
    storage: &StorageRuntime,
    categories: Vec<StorageCategory>,
) -> Result<StorageCleanupResult, String> {
    let lease = storage.exclusive().await?;
    storage
        .cleanup_selected(
            StorageCleanupSelection {
                unused: false,
                categories,
            },
            Vec::new(),
            lease,
        )
        .await
}

#[tokio::test]
async fn user_given_referenced_attachments_when_explicitly_deleting_then_keeps_text_and_external_originals_without_dangling_file_metadata(
) {
    let (root, database, storage) = fixture().await;
    let source = root.path().join("original.png");
    fs::write(&source, b"original bytes").expect("original");
    let (attachment, cached) = attach(&database, &storage, &source).await;
    messages(&database, attachment).await;
    sqlx::query("INSERT INTO message_parts(message_id,type,content,sort_order) VALUES (1,'text','keep this conversation',1)").execute(database.pool()).await.expect("text");
    let hash = cached
        .file_name()
        .expect("hash")
        .to_string_lossy()
        .into_owned();
    let original = storage.cache.join("originals").join(&hash);
    fs::create_dir_all(original.parent().expect("parent")).expect("original cache");
    fs::write(&original, b"restored original").expect("owned original");
    let snapshot = serde_json::json!({"userPrompt":"keep prompt", "attachments":[{"attachmentId":attachment,"path":cached,"originPath":source}],"toolResult":{"filePath":cached,"text":"keep tool output","hash":hash},"original":{"originPath":original}});
    sqlx::query(
        "INSERT INTO session_turns(task_id,prompt_snapshot_json) VALUES ('deleted-attachment',?)",
    )
    .bind(snapshot.to_string())
    .execute(database.pool())
    .await
    .expect("snapshot");
    let result = selected_cleanup(&storage, vec![StorageCategory::Attachments])
        .await
        .expect("explicit cleanup");
    assert_eq!(result.failed_files, 0);
    assert!(!cached.exists());
    assert!(!original.exists());
    assert_eq!(
        fs::read(&source).expect("external original"),
        b"original bytes"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM attachments")
            .fetch_one(database.pool())
            .await
            .expect("attachment rows"),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT content FROM message_parts WHERE type='text'")
            .fetch_one(database.pool())
            .await
            .expect("text"),
        "keep this conversation"
    );
    let retained: String = sqlx::query_scalar("SELECT prompt_snapshot_json FROM session_turns")
        .fetch_one(database.pool())
        .await
        .expect("snapshot");
    let retained: Value = serde_json::from_str(&retained).expect("valid snapshot");
    assert_eq!(retained["userPrompt"], "keep prompt");
    assert_eq!(retained["attachments"], serde_json::json!([]));
    assert!(retained["toolResult"].get("filePath").is_none());
    assert_eq!(retained["toolResult"]["text"], "keep tool output");
    assert_eq!(retained["toolResult"]["hash"], hash);
    assert!(retained["original"].get("originPath").is_none());
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(database.pool())
        .await
        .expect("foreign keys")
        .is_empty());
    database
        .export_scoped_backup(
            &root.path().join("after-deletion.zip"),
            &storage.cache,
            crate::core::database::types::DatabaseImportMode::Full,
        )
        .await
        .expect("backup after deletion");
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_installed_assets_browser_data_and_recent_cache_when_selecting_each_then_can_remove_all_managed_files(
) {
    let (root, database, storage) = fixture().await;
    let paths = [
        root.path().join("assets/font/font.woff2"),
        root.path().join("data/browser-data/Default/Cookies"),
        storage.cache.join("clipboard/123.png"),
        storage.cache.join("temporary/unknown-owned.tmp"),
    ];
    for path in &paths {
        fs::create_dir_all(path.parent().expect("parent")).expect("directory");
        fs::write(path, b"managed bytes").expect("file");
    }
    let result = selected_cleanup(
        &storage,
        vec![
            StorageCategory::Assets,
            StorageCategory::Browser,
            StorageCategory::Clipboard,
            StorageCategory::Temporary,
        ],
    )
    .await
    .expect("selected cleanup");
    assert_eq!(result.failed_files, 0);
    assert_eq!(result.removed_files, 4);
    assert!(result.restart_required);
    assert!(paths.iter().all(|path| !path.exists()));
    assert!(database.database_path().exists());
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_conversations_configuration_and_usage_when_deleting_database_contents_then_keeps_a_valid_empty_schema_and_requires_restart(
) {
    let (_root, database, storage) = fixture().await;
    sqlx::raw_sql("INSERT INTO sessions(session_id,title,model) VALUES('history','private conversation','fixture'); INSERT INTO settings(key,value) VALUES('private-setting','private value'); INSERT INTO statistics(key,value) VALUES('usage_rollup_baseline','[]');").execute(database.pool()).await.expect("personal data");
    let migrations: i64 = sqlx::query_scalar("SELECT count(*) FROM migrations")
        .fetch_one(database.pool())
        .await
        .expect("migrations");
    let result = selected_cleanup(&storage, vec![StorageCategory::Database])
        .await
        .expect("database reset");
    assert!(result.restart_required);
    assert_eq!(result.failed_files, 0);
    assert!(database.pool().is_closed());
    let mut reopened = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(database.database_path())
            .read_only(true),
    )
    .await
    .expect("inspect committed reset");
    for table in [
        "sessions",
        "settings",
        "statistics",
        "providers",
        "built_in_tools",
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!(
                "SELECT count(*) FROM {table}"
            )))
            .fetch_one(&mut reopened)
            .await
            .expect("empty user table"),
            0
        );
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM migrations")
            .fetch_one(&mut reopened)
            .await
            .expect("retained migrations"),
        migrations
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
            .fetch_one(&mut reopened)
            .await
            .expect("integrity"),
        "ok"
    );
    assert!(database.database_path().exists());
    reopened.close().await.expect("close inspection");
}

#[tokio::test]
async fn user_given_a_clipboard_original_used_by_history_when_deleting_clipboard_files_then_retains_the_saved_attachment_and_can_back_it_up(
) {
    let (root, database, storage) = fixture().await;
    let source = storage.cache.join("clipboard/123.png");
    fs::create_dir_all(source.parent().expect("parent")).expect("directory");
    fs::write(&source, b"saved clipboard image").expect("original");
    let (attachment, cached) = attach(&database, &storage, &source).await;
    messages(&database, attachment).await;
    sqlx::query("INSERT INTO session_turns(task_id,prompt_snapshot_json) VALUES('clipboard',?)")
        .bind(serde_json::json!({"attachments":[{"attachmentId":attachment,"originPath":source}],"userPrompt":source}).to_string())
        .execute(database.pool()).await.expect("snapshot");
    let result = selected_cleanup(&storage, vec![StorageCategory::Clipboard])
        .await
        .expect("cleanup");
    assert_eq!(result.removed_files, 1);
    assert!(!source.exists());
    assert_eq!(
        fs::read(&cached).expect("saved copy"),
        b"saved clipboard image"
    );
    let origin: String = sqlx::query_scalar("SELECT origin_path FROM attachments WHERE id = ?")
        .bind(attachment)
        .fetch_one(database.pool())
        .await
        .expect("retained attachment");
    assert_eq!(PathBuf::from(origin), cached);
    let snapshot: String = sqlx::query_scalar("SELECT prompt_snapshot_json FROM session_turns")
        .fetch_one(database.pool())
        .await
        .expect("snapshot");
    let snapshot: Value = serde_json::from_str(&snapshot).expect("json");
    assert_eq!(snapshot["userPrompt"], source.to_string_lossy().as_ref());
    assert!(snapshot["attachments"][0].get("originPath").is_none());
    database
        .export_scoped_backup(
            &root.path().join("retained.zip"),
            &storage.cache,
            crate::core::database::types::DatabaseImportMode::Full,
        )
        .await
        .expect("backup without deleted original");
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_overlapping_unused_and_selected_categories_when_deleting_then_each_file_is_removed_once_and_unselected_files_remain(
) {
    let (_root, database, storage) = fixture().await;
    let icon = storage.cache.join(format!("icons/{}.png", "a".repeat(32)));
    fs::create_dir_all(icon.parent().expect("parent")).expect("directory");
    fs::write(&icon, b"thumbnail").expect("icon");
    let keep = storage.cache.join("computer-use-trajectories/keep.mp4");
    fs::create_dir_all(keep.parent().expect("parent")).expect("directory");
    fs::write(&keep, b"saved recording").expect("recording");
    let lease = storage.exclusive().await.expect("exclusive");
    let result = storage
        .cleanup_selected(
            StorageCleanupSelection {
                unused: true,
                categories: vec![StorageCategory::Thumbnails],
            },
            Vec::new(),
            lease,
        )
        .await
        .expect("cleanup");
    assert_eq!(result.removed_files, 1);
    assert!(!icon.exists());
    assert!(keep.exists());
    assert!(!result.restart_required);
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_an_active_transaction_when_explicitly_deleting_then_no_selected_files_or_data_change(
) {
    let (_root, database, storage) = fixture().await;
    let transaction = database
        .begin_transaction("main".into(), None)
        .await
        .expect("transaction");
    assert_eq!(
        selected_cleanup(&storage, vec![StorageCategory::Database])
            .await
            .expect_err("busy"),
        "storage_busy"
    );
    assert!(!database.pool().is_closed());
    database
        .rollback_transaction(&transaction)
        .await
        .expect("transaction still usable");
    selected_cleanup(&storage, vec![StorageCategory::Logs])
        .await
        .expect("cleanup after transaction");
    database.pool().close().await;
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn user_given_a_redirected_asset_folder_when_explicitly_deleting_then_no_file_or_database_content_is_removed(
) {
    let (root, database, storage) = fixture().await;
    let outside = root.path().join("external");
    fs::create_dir_all(&outside).expect("external directory");
    fs::write(outside.join("keep"), b"external bytes").expect("external file");
    directory_link(&outside, &root.path().join("assets"));
    sqlx::query("INSERT INTO settings(key,value) VALUES('keep','yes')")
        .execute(database.pool())
        .await
        .expect("setting");
    assert_eq!(
        selected_cleanup(
            &storage,
            vec![StorageCategory::Assets, StorageCategory::Database]
        )
        .await
        .expect_err("redirect rejected"),
        "storage_scan_incomplete"
    );
    assert_eq!(
        fs::read(outside.join("keep")).expect("external retained"),
        b"external bytes"
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key='keep'")
            .fetch_one(database.pool())
            .await
            .expect("setting retained"),
        "yes"
    );
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_an_external_file_when_sending_then_keeps_a_snapshot_after_source_changes() {
    let (root, database, storage) = fixture().await;
    let source = root.path().join("original.png");
    fs::write(&source, b"first bytes").expect("original");
    let (_, cached) = attach(&database, &storage, &source).await;
    fs::write(&source, b"new external bytes").expect("user edits original");
    assert_eq!(fs::read(&cached).expect("saved attachment"), b"first bytes");
    assert_ne!(
        files::physical_file(&source)
            .expect("source identity")
            .identity,
        files::physical_file(&cached)
            .expect("snapshot identity")
            .identity
    );
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_shared_attachments_when_removing_one_conversation_then_keeps_the_other_copy() {
    let (root, database, storage) = fixture().await;
    let source = root.path().join("original.png");
    fs::write(&source, b"shared bytes").expect("original");
    let (id, cached) = attach(&database, &storage, &source).await;
    messages(&database, id).await;
    sqlx::query("DELETE FROM sessions WHERE id = 1")
        .execute(database.pool())
        .await
        .expect("remove first");
    storage
        .cleanup(SAFE_CATEGORIES.to_vec(), Vec::new())
        .await
        .expect("safe cleanup");
    assert_eq!(
        fs::read(cached).expect("remaining attachment"),
        b"shared bytes"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM message_parts WHERE attachment_id = ?")
            .bind(id)
            .fetch_one(database.pool())
            .await
            .expect("remaining association"),
        1
    );
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_a_running_task_when_cleaning_then_is_refused_until_the_task_releases_files() {
    let (_root, database, storage) = fixture().await;
    let activity = storage.hold("main").await.expect("task activity");
    assert_eq!(
        storage
            .cleanup(SAFE_CATEGORIES.to_vec(), Vec::new())
            .await
            .expect_err("active task"),
        "storage_busy"
    );
    assert!(storage.scan(Vec::new()).await.expect("usage").busy);
    assert_eq!(
        storage
            .release("settings", &activity)
            .await
            .expect_err("foreign window"),
        "storage_invalid_path"
    );
    storage
        .release("main", &activity)
        .await
        .expect("task finished");
    assert!(!storage.scan(Vec::new()).await.expect("usage").busy);
    storage
        .cleanup(SAFE_CATEGORIES.to_vec(), Vec::new())
        .await
        .expect("idle cleanup");
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_recoverable_task_inputs_when_cleaning_after_completion_then_keeps_only_the_needed_files_pinned(
) {
    let (root, database, storage) = fixture().await;
    let source = root.path().join("recoverable.png");
    fs::write(&source, b"recoverable bytes").expect("source");
    let (id, cached) = attach(&database, &storage, &source).await;
    let activity = storage.hold("main").await.expect("running task");
    let pin = storage
        .pin_paths("main", vec![cached.clone()])
        .await
        .expect("input retention");
    storage
        .release("main", &activity)
        .await
        .expect("task completed");
    assert!(!storage.scan(Vec::new()).await.expect("usage").busy);
    storage
        .cleanup(SAFE_CATEGORIES.to_vec(), Vec::new())
        .await
        .expect("unrelated cache cleanup");
    assert_eq!(
        fs::read(&cached).expect("recoverable input"),
        b"recoverable bytes"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM attachments WHERE id = ?")
            .bind(id)
            .fetch_one(database.pool())
            .await
            .expect("retained identity"),
        1
    );
    storage
        .release("main", &pin)
        .await
        .expect("retention expired");
    storage
        .cleanup(SAFE_CATEGORIES.to_vec(), Vec::new())
        .await
        .expect("unreferenced input cleanup");
    assert!(!cached.exists());
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_a_closed_window_when_cleaning_then_does_not_keep_abandoned_task_leases() {
    let (_root, database, storage) = fixture().await;
    storage.hold("main").await.expect("activity");
    storage.abort_window("main").await;
    storage
        .cleanup(SAFE_CATEGORIES.to_vec(), Vec::new())
        .await
        .expect("window cleanup");
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_an_active_database_transaction_when_cleaning_then_keeps_the_transaction_intact()
{
    let (_root, database, storage) = fixture().await;
    let transaction = database
        .begin_transaction("main".into(), None)
        .await
        .expect("transaction");
    assert_eq!(
        storage
            .cleanup(SAFE_CATEGORIES.to_vec(), Vec::new())
            .await
            .expect_err("active transaction"),
        "storage_busy"
    );
    database
        .rollback_transaction(&transaction)
        .await
        .expect("rollback remains available");
    storage
        .cleanup(SAFE_CATEGORIES.to_vec(), Vec::new())
        .await
        .expect("idle maintenance");
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_unused_caches_and_saved_recordings_when_cleaning_safely_then_keeps_user_data() {
    let (root, database, storage) = fixture().await;
    let clipboard = storage.cache.join("clipboard/123.png");
    fs::create_dir_all(clipboard.parent().expect("clipboard parent")).expect("clipboard directory");
    fs::write(&clipboard, b"unused").expect("clipboard file");
    old(&clipboard);
    let recording = storage
        .cache
        .join("computer-use-trajectories/cua-driver")
        .join(format!("recording-{}", uuid::Uuid::new_v4()))
        .join("actions.json");
    fs::create_dir_all(recording.parent().expect("recording parent")).expect("recording directory");
    fs::write(&recording, b"saved recording").expect("recording");
    let log = root.path().join("logs/TouchAI_2020.log");
    fs::create_dir_all(log.parent().expect("logs parent")).expect("logs directory");
    fs::write(&log, b"diagnostics").expect("log");
    storage
        .cleanup(SAFE_CATEGORIES.to_vec(), Vec::new())
        .await
        .expect("safe cleanup");
    assert!(!clipboard.exists());
    assert_eq!(
        fs::read(recording).expect("preserved recording"),
        b"saved recording"
    );
    assert_eq!(fs::read(log).expect("preserved logs"), b"diagnostics");
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_a_current_clipboard_image_when_cleaning_then_preserves_it_even_after_its_grace_period(
) {
    let (_root, database, storage) = fixture().await;
    let clipboard = storage.cache.join("clipboard/123.png");
    fs::create_dir_all(clipboard.parent().expect("parent")).expect("directory");
    fs::write(&clipboard, b"current clipboard").expect("image");
    old(&clipboard);
    storage
        .cleanup(SAFE_CATEGORIES.to_vec(), vec![clipboard.clone()])
        .await
        .expect("cleanup");
    assert_eq!(
        fs::read(clipboard).expect("current clipboard"),
        b"current clipboard"
    );
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_a_large_original_image_when_cleaning_then_keeps_the_original_needed_by_history()
{
    let (_root, database, storage) = fixture().await;
    let provider_id: i64 = sqlx::query_scalar("INSERT INTO providers(name,driver,api_endpoint,logo) VALUES('Fixture','openai','http://fixture.invalid','') RETURNING id")
        .fetch_one(database.pool()).await.expect("provider");
    let source = storage.cache.join("clipboard/987.png");
    fs::create_dir_all(source.parent().expect("parent")).expect("directory");
    fs::write(&source, b"full resolution original").expect("original");
    old(&source);
    let (_, cached) = attach(&database, &storage, &source).await;
    // The origin is referenced independently of which cached/normalized bytes the row contains.
    let model_id: i64 = sqlx::query_scalar(
        "INSERT INTO models(provider_id,name,model_id) VALUES(?, 'Fixture','fixture') RETURNING id",
    )
    .bind(provider_id)
    .fetch_one(database.pool())
    .await
    .expect("model");
    sqlx::query(
        "INSERT INTO session_turns (model_id,task_id,prompt_snapshot_json) VALUES (?,'task',?)",
    )
    .bind(model_id)
    .bind(serde_json::json!({"attachments":[{"originPath":source}]}).to_string())
    .execute(database.pool())
    .await
    .expect("origin reference");
    storage
        .cleanup(SAFE_CATEGORIES.to_vec(), Vec::new())
        .await
        .expect("cleanup");
    assert_eq!(
        fs::read(source).expect("original"),
        b"full resolution original"
    );
    // Its redundant cached name may be reclaimed, but the original entity remains.
    let _ = cached;
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_hard_linked_cache_names_when_measuring_then_counts_one_physical_file() {
    let (_root, database, storage) = fixture().await;
    let directory = storage.cache.join("icons");
    fs::create_dir_all(&directory).expect("icons directory");
    let first = directory.join(format!("{}.png", "a".repeat(32)));
    let second = directory.join(format!("{}.png", "b".repeat(32)));
    fs::write(&first, vec![7_u8; 8192]).expect("image");
    fs::hard_link(&first, &second).expect("same-volume fixture hard link");
    let summary = storage.scan(Vec::new()).await.expect("usage");
    let icons = summary
        .categories
        .iter()
        .find(|usage| usage.id == StorageCategory::Thumbnails)
        .expect("icon usage");
    assert_eq!(icons.file_count, 2);
    assert_eq!(
        icons.bytes,
        files::physical_file(&first)
            .expect("allocated size")
            .allocated
    );
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_an_external_hard_link_when_reclaiming_an_owned_name_then_keeps_external_bytes()
{
    let (root, database, storage) = fixture().await;
    let external = root.path().join("external.png");
    fs::write(&external, vec![3_u8; 8192]).expect("user file");
    let directory = storage.cache.join("icons");
    fs::create_dir_all(&directory).expect("directory");
    let cached = directory.join(format!("{}.png", "a".repeat(32)));
    fs::hard_link(&external, &cached).expect("fixture link");
    let result = storage
        .cleanup(SAFE_CATEGORIES.to_vec(), Vec::new())
        .await
        .expect("cleanup");
    assert!(!cached.exists());
    assert_eq!(fs::read(external).expect("external file"), vec![3_u8; 8192]);
    assert_eq!(result.released_bytes, 0);
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_corrupt_published_content_when_sending_again_then_gets_an_error_without_overwriting_it(
) {
    let (root, database, storage) = fixture().await;
    let original = root.path().join("original.png");
    fs::write(&original, b"expected").expect("original");
    let hash = files::sha256_file(&original).expect("digest");
    let cached = files::attachment_path(&storage.cache, "image", &hash).expect("cache path");
    fs::create_dir_all(cached.parent().expect("parent")).expect("directory");
    fs::write(&cached, b"damaged").expect("corrupt cache");
    assert_eq!(
        storage
            .publish_attachment("image".into(), original, None)
            .await
            .expect_err("corrupt content"),
        "storage_corrupt_attachment"
    );
    assert_eq!(fs::read(cached).expect("existing bytes"), b"damaged");
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_app_owned_clipboard_bytes_when_sending_then_can_reuse_the_original_name_without_a_copy(
) {
    let (_root, database, storage) = fixture().await;
    let source = storage.cache.join("clipboard/123.png");
    fs::create_dir_all(source.parent().expect("parent")).expect("directory");
    fs::write(&source, b"identical immutable bytes").expect("source");
    let published = storage
        .publish_attachment("image".into(), source.clone(), None)
        .await
        .expect("attachment");
    assert_eq!(
        files::physical_file(&source).expect("source").identity,
        files::physical_file(Path::new(&published.path))
            .expect("attachment")
            .identity
    );
    assert_eq!(
        fs::read(source).expect("original name"),
        b"identical immutable bytes"
    );
    database.pool().close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn user_given_a_link_outside_the_cache_when_cleaning_then_refuses_to_follow_it() {
    let (root, database, storage) = fixture().await;
    let outside = root.path().join("outside");
    fs::create_dir_all(&outside).expect("outside directory");
    fs::write(outside.join("keep.png"), b"keep").expect("outside file");
    std::os::unix::fs::symlink(&outside, storage.cache.join("clipboard")).expect("fixture symlink");
    assert_eq!(
        storage
            .cleanup(SAFE_CATEGORIES.to_vec(), Vec::new())
            .await
            .expect_err("reparse boundary"),
        "storage_scan_incomplete"
    );
    assert_eq!(
        fs::read(outside.join("keep.png")).expect("untouched outside"),
        b"keep"
    );
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_content_snapshots_when_clearing_messages_then_removes_content_but_keeps_usage()
{
    let (_root, database, storage) = fixture().await;
    sqlx::raw_sql("INSERT INTO providers(name,driver,api_endpoint,logo) VALUES('Fixture','openai','http://fixture.invalid',''); INSERT INTO models(provider_id,name,model_id) SELECT id,'Fixture','fixture' FROM providers WHERE name='Fixture'; INSERT INTO sessions(id,session_id,title,model,last_message_preview,message_count) VALUES(1,'session','Session','fixture','old content',1); INSERT INTO messages(id,session_id,role) VALUES(1,1,'user'); INSERT INTO message_parts(message_id,type,content,sort_order) VALUES(1,'text','old content',0); INSERT INTO session_turns(id,session_id,model_id,task_id,prompt_snapshot_json,prompt_message_id,status,input_tokens) VALUES(1,1,(SELECT id FROM models WHERE model_id='fixture'),'task','{\"userPrompt\":\"old content\"}',1,'cancelled',42); INSERT INTO session_turn_attempts(turn_id,attempt_index,checkpoint_json,delivery_manifest_json) VALUES(1,1,'{}','{}');")
        .execute(database.pool()).await.expect("history fixture");
    storage
        .clear_history(HistoryKind::Messages, Vec::new())
        .await
        .expect("clear history");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM messages")
            .fetch_one(database.pool())
            .await
            .expect("messages"),
        0
    );
    let turn: (String, Option<i64>, i64) =
        sqlx::query_as("SELECT prompt_snapshot_json, session_id, input_tokens FROM session_turns")
            .fetch_one(database.pool())
            .await
            .expect("retained aggregates");
    assert_eq!(turn, ("{}".into(), None, 42));
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(database.pool())
        .await
        .expect("foreign keys")
        .is_empty());
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_cleared_call_detail_when_new_calls_arrive_then_keeps_prior_daily_totals_without_double_counting(
) {
    let (_root, database, storage) = fixture().await;
    sqlx::raw_sql("INSERT INTO providers(name,driver,api_endpoint,logo) VALUES('Fixture','openai','http://fixture.invalid',''); INSERT INTO models(provider_id,name,model_id) SELECT id,'Fixture','fixture' FROM providers WHERE name='Fixture'; INSERT INTO session_turns(model_id,task_id,prompt_snapshot_json,status,input_tokens,created_at) SELECT id,'old','{}','completed',42,'2020-01-01 00:00:00' FROM models;")
        .execute(database.pool()).await.expect("old usage");
    storage
        .clear_history(HistoryKind::Turns, Vec::new())
        .await
        .expect("clear detail");
    sqlx::query("INSERT INTO session_turns(model_id,task_id,prompt_snapshot_json,status,input_tokens,created_at) VALUES((SELECT id FROM models WHERE model_id='fixture'),'new','{}','completed',8,'2020-01-01 01:00:00')")
        .execute(database.pool()).await.expect("new usage");
    for _ in 0..2 {
        let sql = database
            .storage_artifact("rollup.sql")
            .expect("rollup contract");
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
            .execute(database.pool())
            .await
            .expect("rollup");
    }
    let total: (i64, i64) =
        sqlx::query_as("SELECT request_count,input_tokens FROM usage_daily_rollups")
            .fetch_one(database.pool())
            .await
            .expect("daily totals");
    assert_eq!(total, (2, 50));
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_a_queued_cleanup_when_the_clipboard_changes_then_keeps_the_snapshot_current_at_maintenance_start(
) {
    let (_root, database, storage) = fixture().await;
    let directory = storage.cache.join("clipboard");
    fs::create_dir_all(&directory).expect("clipboard directory");
    let first = directory.join("1.png");
    let current = directory.join("2.png");
    for path in [&first, &current] {
        fs::write(path, b"clipboard bytes").expect("image");
        old(path);
    }
    let snapshot = Arc::new(std::sync::Mutex::new(vec![first.clone()]));
    let protection = snapshot.clone();
    let cleanup = storage.cleanup_with_snapshot(SAFE_CATEGORIES.to_vec(), move || {
        Ok(protection.lock().expect("fixture snapshot").clone())
    });
    *snapshot.lock().expect("clipboard changed") = vec![current.clone()];
    cleanup.await.expect("cleanup");
    assert!(!first.exists());
    assert_eq!(
        fs::read(current).expect("current clipboard remains usable"),
        b"clipboard bytes"
    );
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_active_storage_when_clipboard_capture_would_fail_then_gets_busy_without_starting_maintenance(
) {
    let (_root, database, storage) = fixture().await;
    let task = storage.hold("main").await.expect("task");
    assert_eq!(
        storage
            .cleanup_with_snapshot(SAFE_CATEGORIES.to_vec(), || Err(
                "storage_invalid_path".into()
            ))
            .await
            .expect_err("running task excludes maintenance"),
        "storage_busy"
    );
    storage.release("main", &task).await.expect("task finished");
    storage
        .cleanup(SAFE_CATEGORIES.to_vec(), Vec::new())
        .await
        .expect("subsequent cleanup");
    database.pool().close().await;
}

#[cfg(windows)]
#[tokio::test]
async fn user_given_compressed_cache_files_when_scanning_then_sees_compressed_allocation_not_logical_length(
) {
    use std::os::windows::{ffi::OsStrExt, fs::MetadataExt};
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{GetCompressedFileSizeW, FILE_ATTRIBUTE_COMPRESSED},
    };
    let (_root, database, storage) = fixture().await;
    let directory = storage.cache.join("icons");
    fs::create_dir(&directory).expect("private cache");
    let image = directory.join(format!("{}.png", "c".repeat(32)));
    fs::write(&image, vec![0_u8; 1024 * 1024]).expect("compressible fixture");
    let compressed = std::process::Command::new("compact.exe")
        .args(["/C", "/F", "/Q"])
        .arg(&image)
        .output()
        .expect("Windows file compression");
    assert!(
        compressed.status.success(),
        "Windows NTFS test fixture requires compression support"
    );
    let metadata = fs::metadata(&image).expect("compressed metadata");
    assert_ne!(metadata.file_attributes() & FILE_ATTRIBUTE_COMPRESSED.0, 0);
    let wide: Vec<u16> = image.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut high = 0;
    let low = unsafe { GetCompressedFileSizeW(PCWSTR(wide.as_ptr()), Some(&mut high)) };
    assert_ne!(low, u32::MAX, "compressed allocation query succeeds");
    let allocated = (u64::from(high) << 32) | u64::from(low);
    assert!(allocated < metadata.len());
    let summary = storage.scan(Vec::new()).await.expect("usage");
    let icons = summary
        .categories
        .iter()
        .find(|usage| usage.id == StorageCategory::Thumbnails)
        .expect("category");
    assert_eq!(icons.bytes, allocated);
    database.pool().close().await;
}

#[tokio::test]
async fn user_given_uncheckpointed_database_pages_when_compacting_then_sees_physical_usage_including_wal(
) {
    let (_root, database, storage) = fixture().await;
    let mut connection = database.pool().acquire().await.expect("writer");
    sqlx::query("PRAGMA wal_autocheckpoint = 0")
        .execute(&mut *connection)
        .await
        .expect("controlled WAL");
    for index in 0..64 {
        sqlx::query("INSERT INTO statistics(key,value) VALUES(?,?)")
            .bind(format!("fixture-{index}"))
            .bind("x".repeat(16 * 1024))
            .execute(&mut *connection)
            .await
            .expect("committed fixture page");
    }
    sqlx::query(
        "DELETE FROM statistics WHERE key LIKE 'fixture-%' AND CAST(substr(key,9) AS INTEGER) < 48",
    )
    .execute(&mut *connection)
    .await
    .expect("free pages");
    drop(connection);
    let owned_files = || {
        storage
            .roots(&storage.cache)
            .into_iter()
            .filter(|(_, category)| *category == StorageCategory::Database)
            .map(|(path, _)| path)
            .filter(|path| path.exists())
            .collect::<Vec<_>>()
    };
    let before = files::unique_allocated(&owned_files()).expect("physical database usage");
    let result = storage.compact_database().await.expect("compaction");
    let after = files::unique_allocated(&owned_files()).expect("remaining physical database usage");
    assert_eq!(result.before_bytes, before);
    assert_eq!(result.after_bytes, after);
    assert_eq!(result.released_bytes, before.saturating_sub(after));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM statistics WHERE key LIKE 'fixture-%'")
            .fetch_one(database.pool())
            .await
            .expect("preserved data"),
        16
    );
    database.pool().close().await;
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn user_given_relocated_platform_data_when_using_storage_then_keeps_logical_paths_without_following_internal_links(
) {
    let (root, previous, _) = fixture().await;
    previous.pool().close().await;
    let real = root.path().join("physical-app");
    fs::create_dir_all(real.join("data")).expect("data");
    fs::create_dir_all(real.join("cache/clipboard")).expect("cache");
    let logical = root.path().join("platform-app");
    directory_link(&real, &logical);
    let database = DatabaseRuntime::initialize_for_tests(&logical.join("data"))
        .await
        .expect("relocated database");
    let storage = StorageRuntime::new(database.clone(), logical.join("cache"));
    let source = logical.join("cache/clipboard/3.png");
    fs::write(&source, b"relocated original").expect("original");
    old(&source);
    let (id, cached) = attach(&database, &storage, &source).await;
    messages(&database, id).await;
    storage
        .cleanup(SAFE_CATEGORIES.to_vec(), Vec::new())
        .await
        .expect("maintenance through platform alias");
    assert_eq!(
        fs::read(&source).expect("original logical path"),
        b"relocated original"
    );
    assert_eq!(
        fs::read(&cached).expect("published path"),
        b"relocated original"
    );
    assert!(storage
        .scan(Vec::new())
        .await
        .expect("usage")
        .warnings
        .is_empty());
    storage
        .compact_database()
        .await
        .expect("relocated compaction");
    let outside = root.path().join("outside");
    fs::create_dir_all(&outside).expect("outside directory");
    fs::write(outside.join("keep.png"), b"external user file").expect("outside file");
    directory_link(&outside, real.join("cache/temporary").as_path());
    assert_eq!(
        storage
            .cleanup(SAFE_CATEGORIES.to_vec(), Vec::new())
            .await
            .expect_err("internal redirect rejected"),
        "storage_scan_incomplete"
    );
    assert_eq!(
        fs::read(outside.join("keep.png")).expect("external preserved"),
        b"external user file"
    );
    database.pool().close().await;
}

#[test]
fn user_given_an_incomplete_scan_when_cleaning_then_never_gets_a_partial_deletion_plan() {
    let root = tempfile::tempdir().expect("fixture");
    for name in ["one", "two"] {
        fs::write(root.path().join(name), b"keep").expect("file");
    }
    assert_eq!(
        files::walk(root.path(), 1).expect_err("bounded scan"),
        "storage_scan_incomplete"
    );
    assert_eq!(
        fs::read(root.path().join("one")).expect("unchanged"),
        b"keep"
    );
}

#[test]
fn user_given_an_invalid_attachment_type_when_publishing_then_keeps_the_source_untouched() {
    let root = tempfile::tempdir().expect("fixture");
    let source = root.path().join("source");
    let mut file = fs::File::create(&source).expect("source");
    file.write_all(b"keep").expect("write");
    drop(file);
    assert_eq!(
        files::publish_attachment(root.path(), "unknown", &source, None).expect_err("invalid kind"),
        "storage_invalid_path"
    );
    assert_eq!(fs::read(source).expect("source unchanged"), b"keep");
}
