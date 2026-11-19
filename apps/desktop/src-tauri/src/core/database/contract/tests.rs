use super::*;
use sqlx::{Connection, SqliteConnection};

fn current_contract() -> DatabaseContractSource {
    DatabaseContractSource::from_root(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("desktop root")
            .join("src/database"),
    )
    .expect("database contract")
}

fn copied_contract(
    current: &DatabaseContractSource,
    count: usize,
    fail_last: bool,
) -> (tempfile::TempDir, DatabaseContractSource) {
    let parent = fs::canonicalize(std::env::temp_dir()).expect("physical fixture root");
    let root = tempfile::tempdir_in(parent).expect("private contract fixture");
    fs::create_dir_all(root.path().join("drizzle/meta")).expect("journal directory");
    fs::create_dir(root.path().join("artifacts")).expect("artifact directory");
    let mut journal: serde_json::Value = serde_json::from_str(
        &current
            .read_text(&["drizzle", "meta", "_journal.json"])
            .expect("journal"),
    )
    .expect("journal JSON");
    journal["entries"]
        .as_array_mut()
        .expect("entries")
        .truncate(count);
    for (index, entry) in journal["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .enumerate()
    {
        let tag = entry["tag"].as_str().expect("tag");
        let file = format!("{tag}.sql");
        let mut sql = current
            .read_text(&["drizzle", &file])
            .expect("migration SQL")
            .into_owned();
        if fail_last && index + 1 == count {
            sql.push_str("\n--> statement-breakpoint\nSELECT * FROM missing_migration_fixture;\n");
        }
        fs::write(root.path().join("drizzle").join(file), sql).expect("private migration copy");
    }
    fs::write(
        root.path().join("drizzle/meta/_journal.json"),
        serde_json::to_vec(&journal).expect("journal bytes"),
    )
    .expect("private journal");
    let contract =
        DatabaseContractSource::from_root(root.path().to_path_buf()).expect("private contract");
    (root, contract)
}

async fn legacy_history(connection: &mut SqliteConnection, current: &DatabaseContractSource) {
    let (_root, previous) = copied_contract(current, 6, false);
    migrate_database(connection, &previous)
        .await
        .expect("previous schema");
    sqlx::raw_sql("INSERT INTO providers(id,name,driver,api_endpoint,logo) VALUES(1,'Historical provider','openai','http://fixture.invalid',''); INSERT INTO models(id,provider_id,name,model_id) VALUES(1,1,'Historical model','fixture'); INSERT INTO session_turns(id,model_id,task_id,prompt_snapshot_json,input_tokens,total_cost_micros) VALUES(55,1,'historical-task','{\"userPrompt\":\"retained prompt\"}',120,250000); INSERT INTO session_turn_attempts(id,turn_id,attempt_index,checkpoint_json,delivery_manifest_json) VALUES(77,55,1,'{\"iteration\":2}','{}'); UPDATE sqlite_sequence SET seq=1000 WHERE name='session_turns';")
        .execute(connection).await.expect("historical fixture");
}

#[tokio::test]
async fn user_given_existing_retry_records_when_upgrading_then_keeps_content_usage_and_identity_after_model_deletion(
) {
    let current = current_contract();
    let mut connection = SqliteConnection::connect(":memory:")
        .await
        .expect("private database");
    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&mut connection)
        .await
        .expect("foreign keys");
    legacy_history(&mut connection, &current).await;
    migrate_database(&mut connection, &current)
        .await
        .expect("upgrade");
    let turn: (i64, String, String, String, i64) = sqlx::query_as("SELECT id, model_name, provider_name, prompt_snapshot_json, input_tokens FROM session_turns")
        .fetch_one(&mut connection).await.expect("historical turn");
    assert_eq!(
        turn,
        (
            55,
            "Historical model".into(),
            "Historical provider".into(),
            "{\"userPrompt\":\"retained prompt\"}".into(),
            120
        )
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM session_turn_attempts WHERE id=77 AND turn_id=55"
        )
        .fetch_one(&mut connection)
        .await
        .expect("retry metadata"),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
            .fetch_one(&mut connection)
            .await
            .expect("foreign-key enforcement"),
        1
    );
    sqlx::query("DELETE FROM providers WHERE id=1")
        .execute(&mut connection)
        .await
        .expect("delete configuration");
    let model: Option<i64> = sqlx::query_scalar("SELECT model_id FROM session_turns WHERE id=55")
        .fetch_one(&mut connection)
        .await
        .expect("detached model");
    assert_eq!(model, None);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM session_turn_attempts")
            .fetch_one(&mut connection)
            .await
            .expect("preserved attempts"),
        1
    );
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut connection)
        .await
        .expect("integrity")
        .is_empty());
    let next: i64 = sqlx::query_scalar("INSERT INTO session_turns(model_id, task_id, prompt_snapshot_json) VALUES(NULL, 'next', '{}') RETURNING id").fetch_one(&mut connection).await.expect("new identity");
    assert!(next > 1000);
    connection.close().await.expect("closed fixture");
}

#[tokio::test]
async fn user_given_an_interrupted_upgrade_when_migration_fails_then_keeps_previous_rows_and_can_upgrade_again(
) {
    let current = current_contract();
    let mut connection = SqliteConnection::connect(":memory:")
        .await
        .expect("private database");
    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&mut connection)
        .await
        .expect("foreign keys");
    legacy_history(&mut connection, &current).await;
    let (_root, broken) = copied_contract(&current, 7, true);
    assert!(migrate_database(&mut connection, &broken)
        .await
        .expect_err("controlled failure")
        .contains("missing_migration_fixture"));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM session_turns")
            .fetch_one(&mut connection)
            .await
            .expect("previous turns"),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM session_turn_attempts")
            .fetch_one(&mut connection)
            .await
            .expect("previous attempts"),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM migrations")
            .fetch_one(&mut connection)
            .await
            .expect("previous migration journal"),
        6
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
            .fetch_one(&mut connection)
            .await
            .expect("foreign keys restored"),
        1
    );
    migrate_database(&mut connection, &current)
        .await
        .expect("successful retry after rollback");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM session_turn_attempts")
            .fetch_one(&mut connection)
            .await
            .expect("retained attempts"),
        1
    );
    connection.close().await.expect("closed fixture");
}
