// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use std::collections::BTreeSet;

use sqlx::{Executor, Sqlite, SqliteConnection, SqlitePool, Transaction};

use super::{read_disabled_skill_paths_from_file, EditableSkillRoot};

pub(super) const SETTING_KEY: &str = "skills_disabled_paths_v1";
const MAX_SETTING_BYTES: usize = 8 * 1024 * 1024;

pub(super) async fn read<'a>(
    executor: impl Executor<'a, Database = Sqlite>,
) -> Result<Option<BTreeSet<String>>, String> {
    let value: Option<Option<String>> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
            .bind(SETTING_KEY)
            .fetch_optional(executor)
            .await
            .map_err(|error| format!("Cannot read skill state: {error}"))?;
    value
        .map(|value| {
            let value = value.ok_or_else(|| "Skill state is invalid".to_string())?;
            if value.len() > MAX_SETTING_BYTES {
                return Err("Skill state is too large".into());
            }
            serde_json::from_str(&value).map_err(|_| "Skill state is invalid".to_string())
        })
        .transpose()
}

fn serialize(paths: &BTreeSet<String>) -> Result<String, String> {
    let value =
        serde_json::to_string(paths).map_err(|_| "Cannot encode skill state".to_string())?;
    if value.len() > MAX_SETTING_BYTES {
        return Err("Skill state is too large".into());
    }
    Ok(value)
}

pub(super) async fn write(
    connection: &mut SqliteConnection,
    paths: &BTreeSet<String>,
) -> Result<(), String> {
    sqlx::query("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?")
        .bind(serialize(paths)?)
        .bind(SETTING_KEY)
        .execute(connection)
        .await
        .map_err(|error| format!("Cannot save skill state: {error}"))?;
    Ok(())
}

pub(super) async fn load(
    pool: &SqlitePool,
    roots: &[EditableSkillRoot],
) -> Result<BTreeSet<String>, String> {
    if let Some(paths) = read(pool).await? {
        return Ok(paths);
    }
    let roots = roots.to_vec();
    let paths = tauri::async_runtime::spawn_blocking(move || {
        let mut paths = BTreeSet::new();
        for root in roots {
            paths.extend(read_disabled_skill_paths_from_file(
                &root.directory,
                &root.state_file,
            )?);
        }
        Ok::<_, String>(paths)
    })
    .await
    .map_err(|error| format!("Cannot import skill state: {error}"))??;
    // Row presence, including [], marks a completed import. Concurrent imports must not overwrite a toggle.
    sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
        .bind(SETTING_KEY)
        .bind(serialize(&paths)?)
        .execute(pool)
        .await
        .map_err(|error| format!("Cannot import skill state: {error}"))?;
    read(pool)
        .await?
        .ok_or_else(|| "Skill state is missing".to_string())
}

pub(super) async fn set_disabled(
    transaction: &mut Transaction<'_, Sqlite>,
    path: String,
    disabled: bool,
) -> Result<(), String> {
    let mut paths = read(&mut **transaction)
        .await?
        .ok_or_else(|| "Skill state is missing".to_string())?;
    let changed = if disabled {
        paths.insert(path)
    } else {
        paths.remove(&path)
    };
    if changed {
        write(transaction, &paths).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{commands::skills::*, core::database::DatabaseRuntime};

    async fn change(pool: &SqlitePool, path: String, disabled: bool) -> Result<(), String> {
        let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        set_disabled(&mut transaction, path, disabled).await?;
        transaction
            .commit()
            .await
            .map_err(|error| error.to_string())
    }

    #[tokio::test]
    async fn user_given_legacy_disabled_skills_when_loading_then_keeps_them_in_the_database_after_restart(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let runtime = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        let app = temp.path().join("app");
        let shared = temp.path().join("shared");
        let roots = editable_skill_roots_at(&app, &shared, &temp.path().join("shared-state.txt"));
        let mut expected = BTreeSet::new();
        for root in &roots {
            let directory = root.directory.join("example");
            fs::create_dir_all(&directory).unwrap();
            let path = directory.join("SKILL.md");
            fs::write(&path, "---\nname: example\ndescription: Example\n---").unwrap();
            let canonical = path_to_string(&path.canonicalize().unwrap());
            fs::write(&root.state_file, format!("{canonical}\n{canonical}\n")).unwrap();
            expected.insert(canonical);
        }
        let loaded = load(runtime.pool(), &roots).await.unwrap();
        assert_eq!(loaded, expected);
        let stored: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
            .bind(SETTING_KEY)
            .fetch_optional(runtime.pool())
            .await
            .unwrap();
        assert_eq!(
            stored.map(|value| serde_json::from_str::<BTreeSet<String>>(&value).unwrap()),
            Some(expected.clone())
        );
        runtime.pool().close().await;
        let reopened = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        for root in &roots {
            assert!(root.state_file.exists());
            fs::write(&root.state_file, "").unwrap();
        }
        assert_eq!(load(reopened.pool(), &roots).await.unwrap(), expected);
    }

    #[tokio::test]
    async fn user_given_saved_database_state_when_legacy_files_change_then_keeps_the_database_choice(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let runtime = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings (key, value) VALUES (?, '[]')")
            .bind(SETTING_KEY)
            .execute(runtime.pool())
            .await
            .unwrap();
        let roots = editable_skill_roots_at(
            temp.path(),
            &temp.path().join("shared"),
            &temp.path().join("old-state"),
        );
        fs::create_dir(&roots[1].state_file).unwrap();
        assert!(load(runtime.pool(), &roots).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn user_given_an_unreadable_legacy_file_when_migrating_then_can_retry_without_partial_database_state(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let runtime = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        let roots = editable_skill_roots_at(
            temp.path(),
            &temp.path().join("shared"),
            &temp.path().join("old-state"),
        );
        fs::create_dir(&roots[1].state_file).unwrap();
        assert!(load(runtime.pool(), &roots).await.is_err());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM settings WHERE key = ?")
            .bind(SETTING_KEY)
            .fetch_one(runtime.pool())
            .await
            .unwrap();
        assert_eq!(count, 0);
        fs::remove_dir(&roots[1].state_file).unwrap();
        assert!(load(runtime.pool(), &roots).await.unwrap().is_empty());
        let value: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
            .bind(SETTING_KEY)
            .fetch_optional(runtime.pool())
            .await
            .unwrap();
        assert_eq!(value.as_deref(), Some("[]"));
    }

    #[tokio::test]
    async fn user_given_invalid_database_state_when_loading_then_gets_an_error_without_enabling_every_skill(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let runtime = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings (key, value) VALUES (?, 'private-invalid-state')")
            .bind(SETTING_KEY)
            .execute(runtime.pool())
            .await
            .unwrap();
        let error = load(runtime.pool(), &[]).await.unwrap_err();
        assert!(!error.contains("private-invalid-state"));
        let stored: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
            .bind(SETTING_KEY)
            .fetch_one(runtime.pool())
            .await
            .unwrap();
        assert_eq!(stored, "private-invalid-state");
    }

    #[tokio::test]
    async fn user_given_a_failed_database_write_when_toggling_then_keeps_the_previous_choice_and_can_retry(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let runtime = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        load(runtime.pool(), &[]).await.unwrap();
        change(runtime.pool(), "first".into(), true).await.unwrap();
        sqlx::query("CREATE TRIGGER reject_skill_update BEFORE UPDATE ON settings WHEN NEW.key = 'skills_disabled_paths_v1' BEGIN SELECT RAISE(ABORT, 'write rejected'); END")
            .execute(runtime.pool()).await.unwrap();
        assert!(change(runtime.pool(), "second".into(), true).await.is_err());
        assert_eq!(
            load(runtime.pool(), &[]).await.unwrap(),
            BTreeSet::from(["first".into()])
        );
        sqlx::query("DROP TRIGGER reject_skill_update")
            .execute(runtime.pool())
            .await
            .unwrap();
        change(runtime.pool(), "second".into(), true).await.unwrap();
        assert_eq!(load(runtime.pool(), &[]).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn user_given_two_database_connections_when_switches_change_together_then_keeps_both_choices(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let first = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        let second = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        load(first.pool(), &[]).await.unwrap();
        let (one, two) = tokio::join!(
            change(first.pool(), "one".into(), true),
            change(second.pool(), "two".into(), true)
        );
        one.unwrap();
        two.unwrap();
        assert_eq!(
            load(first.pool(), &[]).await.unwrap(),
            BTreeSet::from(["one".into(), "two".into()])
        );
        let (one, two) = tokio::join!(
            change(first.pool(), "one".into(), false),
            change(second.pool(), "three".into(), true)
        );
        one.unwrap();
        two.unwrap();
        assert_eq!(
            load(second.pool(), &[]).await.unwrap(),
            BTreeSet::from(["two".into(), "three".into()])
        );
    }

    #[tokio::test]
    async fn user_given_disabled_skills_when_exporting_a_backup_then_keeps_the_choices_in_the_snapshot(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let runtime = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        load(runtime.pool(), &[]).await.unwrap();
        change(runtime.pool(), "example".into(), true)
            .await
            .unwrap();
        let restored_root = temp.path().join("restored");
        fs::create_dir(&restored_root).unwrap();
        let backup = restored_root.join("touchai.db");
        runtime
            .export_backup(backup.to_str().unwrap())
            .await
            .unwrap();
        let snapshot = DatabaseRuntime::initialize_for_tests(&restored_root)
            .await
            .unwrap();
        assert_eq!(
            load(snapshot.pool(), &[]).await.unwrap(),
            BTreeSet::from(["example".into()])
        );
        let rows = sqlx::query("EXPLAIN QUERY PLAN SELECT value FROM settings WHERE key = ?")
            .bind(SETTING_KEY)
            .fetch_all(runtime.pool())
            .await
            .unwrap();
        use sqlx::Row;
        assert!(rows
            .iter()
            .any(|row| row.get::<String, _>("detail").contains("USING INDEX")));
    }

    #[tokio::test]
    async fn user_given_null_or_oversized_state_when_loading_then_sees_a_failure_instead_of_a_reset(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let runtime = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        for value in [None, Some("x".repeat(MAX_SETTING_BYTES + 1))] {
            sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                .bind(SETTING_KEY).bind(value).execute(runtime.pool()).await.unwrap();
            assert!(load(runtime.pool(), &[]).await.is_err());
        }
    }
}
