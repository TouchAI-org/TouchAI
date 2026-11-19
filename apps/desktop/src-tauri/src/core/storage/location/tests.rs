use super::*;
use crate::core::database::DatabaseRuntime;
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};

async fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let parent = fs::canonicalize(std::env::temp_dir()).expect("temp root");
    let root = tempfile::tempdir_in(parent).expect("fixture");
    let source = root.path().join("source");
    fs::create_dir_all(source.join("data")).expect("data");
    let database = DatabaseRuntime::initialize_for_tests(&source.join("data"))
        .await
        .expect("database");
    let file = source.join("cache/originals/example.txt");
    fs::create_dir_all(file.parent().expect("parent")).expect("cache");
    fs::write(&file, b"original bytes").expect("file");
    sqlx::query("INSERT INTO settings(key,value) VALUES('migration-test',?)")
        .bind(serde_json::json!({"path":file,"external":"/unmanaged/example.txt"}).to_string())
        .execute(database.pool())
        .await
        .expect("path setting");
    database.pool().close().await;
    let target = root.path().join("target");
    (root, source, target)
}

#[tokio::test]
async fn user_given_local_data_when_moving_and_restarting_then_reads_the_same_bytes_and_rebased_paths(
) {
    let (_root, source, target) = fixture().await;
    let runtime = DataLocationRuntime::initialize(source.clone())
        .await
        .expect("location");
    runtime.schedule(target.clone()).expect("schedule");
    assert!(source.join("data/touchai.db").exists());
    assert!(!target.exists());
    drop(runtime);
    let runtime = DataLocationRuntime::initialize(source.clone())
        .await
        .expect("restart");
    let info = runtime.info().expect("info");
    assert_eq!(info.current_path, target);
    assert!(info.pending_path.is_none());
    assert!(info.notice.is_none(), "{:?}", info.notice);
    assert_eq!(
        fs::read(target.join("cache/originals/example.txt")).expect("moved file"),
        b"original bytes"
    );
    assert!(!source.join("data/touchai.db").exists());
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new().filename(target.join("data/touchai.db")),
    )
    .await
    .expect("moved database");
    let value: String = sqlx::query_scalar("SELECT value FROM settings WHERE key='migration-test'")
        .fetch_one(&mut connection)
        .await
        .expect("setting");
    let value: serde_json::Value = serde_json::from_str(&value).expect("json");
    assert_eq!(
        value["path"],
        target
            .join("cache/originals/example.txt")
            .to_string_lossy()
            .as_ref()
    );
    assert_eq!(value["external"], "/unmanaged/example.txt");
    connection.close().await.expect("close");
    drop(runtime);
    assert_eq!(
        DataLocationRuntime::initialize(source)
            .await
            .expect("another restart")
            .current(),
        target
    );
}

#[tokio::test]
async fn user_given_a_scheduled_move_when_destination_becomes_occupied_then_restarts_with_original_data(
) {
    let (_root, source, target) = fixture().await;
    let runtime = DataLocationRuntime::initialize(source.clone())
        .await
        .expect("location");
    runtime.schedule(target.clone()).expect("schedule");
    fs::create_dir(&target).expect("target");
    fs::write(target.join("keep.txt"), b"external").expect("occupied");
    drop(runtime);
    let runtime = DataLocationRuntime::initialize(source.clone())
        .await
        .expect("restart");
    assert_eq!(runtime.current(), source);
    assert_eq!(
        runtime.info().expect("info").notice.as_deref(),
        Some("storage_move_not_empty")
    );
    assert!(source.join("data/touchai.db").exists());
    assert_eq!(
        fs::read(target.join("keep.txt")).expect("preserved"),
        b"external"
    );
}

#[tokio::test]
async fn user_given_a_scheduled_move_when_cancelling_then_keeps_the_current_location_after_restart()
{
    let (_root, source, target) = fixture().await;
    let runtime = DataLocationRuntime::initialize(source.clone())
        .await
        .expect("location");
    runtime.schedule(target.clone()).expect("schedule");
    runtime.cancel().expect("cancel");
    assert!(runtime.schedule(source.join("nested")).is_err());
    drop(runtime);
    assert_eq!(
        DataLocationRuntime::initialize(source.clone())
            .await
            .expect("restart")
            .current(),
        source
    );
    assert!(!target.exists());
}

#[tokio::test]
async fn user_given_a_running_profile_when_a_second_process_opens_it_then_migration_is_refused() {
    let (_root, source, _target) = fixture().await;
    let _runtime = DataLocationRuntime::initialize(source.clone())
        .await
        .expect("location");
    assert!(
        matches!(DataLocationRuntime::initialize(source).await, Err(error) if error == "storage_busy")
    );
}

#[tokio::test]
async fn user_given_a_restarting_profile_when_the_previous_process_exits_then_the_next_start_continues(
) {
    let (_root, source, _target) = fixture().await;
    let runtime = DataLocationRuntime::initialize(source.clone())
        .await
        .expect("location");
    let mut startup = Box::pin(DataLocationRuntime::initialize(source));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), &mut startup)
            .await
            .is_err()
    );
    drop(runtime);
    startup
        .await
        .expect("restart waits for the previous process");
}

#[tokio::test]
async fn user_given_app_skills_and_shared_attachment_bytes_when_moving_then_keeps_skills_and_immutable_aliases(
) {
    let (_root, source, target) = fixture().await;
    fs::create_dir_all(source.join("skills/example")).expect("skill directory");
    fs::write(source.join("skills/example/SKILL.md"), b"local skill").expect("skill");
    let file = source.join("cache/originals/example.txt");
    let alias = source.join("cache/originals/alias.txt");
    fs::hard_link(&file, &alias).expect("alias");
    files::mark_immutable(&file).expect("immutable");
    let runtime = DataLocationRuntime::initialize(source.clone())
        .await
        .expect("location");
    runtime.schedule(target.clone()).expect("schedule");
    drop(runtime);
    let runtime = DataLocationRuntime::initialize(source)
        .await
        .expect("restart");
    assert!(runtime.info().expect("info").notice.is_none());
    assert_eq!(
        fs::read(target.join("skills/example/SKILL.md")).expect("moved skill"),
        b"local skill"
    );
    assert_eq!(
        files::physical_file(&target.join("cache/originals/example.txt"))
            .expect("file")
            .identity,
        files::physical_file(&target.join("cache/originals/alias.txt"))
            .expect("alias")
            .identity
    );
    assert!(fs::metadata(target.join("cache/originals/example.txt"))
        .expect("permissions")
        .permissions()
        .readonly());
}

#[tokio::test]
async fn user_given_a_corrupt_database_when_moving_then_keeps_the_source_and_reports_the_failure() {
    let (_root, source, target) = fixture().await;
    fs::write(source.join("data/touchai.db"), b"invalid database").expect("corrupt fixture");
    let runtime = DataLocationRuntime::initialize(source.clone())
        .await
        .expect("location");
    runtime.schedule(target.clone()).expect("schedule");
    drop(runtime);
    let runtime = DataLocationRuntime::initialize(source.clone())
        .await
        .expect("original location");
    assert_eq!(runtime.current(), source);
    assert!(runtime.info().expect("info").notice.is_some());
    assert_eq!(
        fs::read(source.join("data/touchai.db")).expect("source"),
        b"invalid database"
    );
    assert!(!target.exists());
}

#[tokio::test]
async fn user_given_attachment_paths_in_messages_when_moving_then_rebases_metadata_without_rewriting_message_text(
) {
    let (_root, source, target) = fixture().await;
    let old_path = source
        .join("cache/originals/example.txt")
        .to_string_lossy()
        .into_owned();
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new().filename(source.join("data/touchai.db")),
    )
    .await
    .expect("database");
    sqlx::raw_sql("INSERT INTO sessions(id,session_id,title,model) VALUES(1,'move','Keep','test'); INSERT INTO messages(id,session_id,role) VALUES(1,1,'user');").execute(&mut connection).await.expect("conversation");
    sqlx::query("INSERT INTO attachments(id,hash,type,original_name,origin_path,size) VALUES(1,?,'file','example.txt',?,14)")
        .bind("a".repeat(64)).bind(&old_path).execute(&mut connection).await.expect("attachment");
    sqlx::query("INSERT INTO message_parts(message_id,type,content,data,sort_order) VALUES(1,'attachment',?,?,0)")
        .bind(&old_path).bind(serde_json::json!({"attachmentId":1,"path":old_path,"text":old_path}).to_string()).execute(&mut connection).await.expect("path metadata");
    connection.close().await.expect("close");
    let runtime = DataLocationRuntime::initialize(source.clone())
        .await
        .expect("location");
    runtime.schedule(target.clone()).expect("schedule");
    drop(runtime);
    let runtime = DataLocationRuntime::initialize(source)
        .await
        .expect("restart");
    assert!(runtime.info().expect("info").notice.is_none());
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new().filename(target.join("data/touchai.db")),
    )
    .await
    .expect("moved database");
    let (content, data): (String, String) =
        sqlx::query_as("SELECT content,data FROM message_parts")
            .fetch_one(&mut connection)
            .await
            .expect("message");
    let data: serde_json::Value = serde_json::from_str(&data).expect("metadata");
    assert_eq!(content, old_path);
    assert_eq!(data["text"], old_path);
    assert_eq!(
        data["path"],
        target
            .join("cache/originals/example.txt")
            .to_string_lossy()
            .as_ref()
    );
    connection.close().await.expect("close");
}
