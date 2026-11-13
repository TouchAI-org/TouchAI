// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use std::collections::BTreeSet;

use sqlx::{Executor, Sqlite, SqliteConnection, SqlitePool, Transaction};

use super::{validate_skill_directory_name, SkillId};

pub(super) const SETTING_KEY: &str = "skills_disabled_ids_v1";
const MAX_SETTING_BYTES: usize = 8 * 1024 * 1024;

pub(super) async fn read<'a>(
    executor: impl Executor<'a, Database = Sqlite>,
) -> Result<Option<BTreeSet<SkillId>>, String> {
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
            let skills: BTreeSet<SkillId> =
                serde_json::from_str(&value).map_err(|_| "Skill state is invalid".to_string())?;
            for skill in &skills {
                validate_skill_directory_name(&skill.directory_name)?;
            }
            Ok(skills)
        })
        .transpose()
}

fn serialize(skills: &BTreeSet<SkillId>) -> Result<String, String> {
    let value =
        serde_json::to_string(skills).map_err(|_| "Cannot encode skill state".to_string())?;
    if value.len() > MAX_SETTING_BYTES {
        return Err("Skill state is too large".into());
    }
    Ok(value)
}

pub(super) async fn write(
    connection: &mut SqliteConnection,
    skills: &BTreeSet<SkillId>,
) -> Result<(), String> {
    sqlx::query("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?")
        .bind(serialize(skills)?)
        .bind(SETTING_KEY)
        .execute(connection)
        .await
        .map_err(|error| format!("Cannot save skill state: {error}"))?;
    Ok(())
}

pub(super) async fn load(pool: &SqlitePool) -> Result<BTreeSet<SkillId>, String> {
    // New installations have no released file-backed state to migrate.
    sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
        .bind(SETTING_KEY)
        .bind("[]")
        .execute(pool)
        .await
        .map_err(|error| format!("Cannot initialize skill state: {error}"))?;
    read(pool)
        .await?
        .ok_or_else(|| "Skill state is missing".to_string())
}

pub(super) async fn set_disabled(
    transaction: &mut Transaction<'_, Sqlite>,
    skill: SkillId,
    disabled: bool,
) -> Result<(), String> {
    let mut skills = read(&mut **transaction)
        .await?
        .ok_or_else(|| "Skill state is missing".to_string())?;
    let changed = if disabled {
        skills.insert(skill)
    } else {
        skills.remove(&skill)
    };
    if changed {
        write(transaction, &skills).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::{commands::skills::SkillRootScope, core::database::DatabaseRuntime};

    fn skill(scope: SkillRootScope, directory_name: &str) -> SkillId {
        SkillId::new(scope, directory_name.into()).unwrap()
    }

    async fn change(pool: &SqlitePool, skill: SkillId, disabled: bool) -> Result<(), String> {
        let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        set_disabled(&mut transaction, skill, disabled).await?;
        transaction
            .commit()
            .await
            .map_err(|error| error.to_string())
    }

    #[tokio::test]
    async fn user_given_missing_skill_state_when_loading_then_initializes_an_empty_database_state()
    {
        let temp = tempfile::tempdir().unwrap();
        let runtime = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        assert!(load(runtime.pool()).await.unwrap().is_empty());
        let stored: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
            .bind(SETTING_KEY)
            .fetch_optional(runtime.pool())
            .await
            .unwrap();
        assert_eq!(stored.as_deref(), Some("[]"));
    }

    #[tokio::test]
    async fn user_given_saved_skill_ids_when_the_database_reopens_then_keeps_the_same_state() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        let expected = BTreeSet::from([skill(SkillRootScope::Shared, "demo")]);
        load(runtime.pool()).await.unwrap();
        change(runtime.pool(), skill(SkillRootScope::Shared, "demo"), true)
            .await
            .unwrap();

        runtime.pool().close().await;
        let moved_runtime = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        assert_eq!(load(moved_runtime.pool()).await.unwrap(), expected);
        let stored: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
            .bind(SETTING_KEY)
            .fetch_one(moved_runtime.pool())
            .await
            .unwrap();
        assert!(stored.contains(r#""scope":"shared""#));
        assert!(stored.contains(r#""directoryName":"demo""#));
        assert!(!stored.contains(temp.path().to_string_lossy().as_ref()));
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
        let error = load(runtime.pool()).await.unwrap_err();
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
        load(runtime.pool()).await.unwrap();
        change(runtime.pool(), skill(SkillRootScope::App, "first"), true)
            .await
            .unwrap();
        sqlx::query("CREATE TRIGGER reject_skill_update BEFORE UPDATE ON settings WHEN NEW.key = 'skills_disabled_ids_v1' BEGIN SELECT RAISE(ABORT, 'write rejected'); END")
            .execute(runtime.pool()).await.unwrap();
        assert!(
            change(runtime.pool(), skill(SkillRootScope::App, "second"), true)
                .await
                .is_err()
        );
        assert_eq!(
            load(runtime.pool()).await.unwrap(),
            BTreeSet::from([skill(SkillRootScope::App, "first")])
        );
        sqlx::query("DROP TRIGGER reject_skill_update")
            .execute(runtime.pool())
            .await
            .unwrap();
        change(runtime.pool(), skill(SkillRootScope::App, "second"), true)
            .await
            .unwrap();
        assert_eq!(load(runtime.pool()).await.unwrap().len(), 2);
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
        load(first.pool()).await.unwrap();
        let (one, two) = tokio::join!(
            change(first.pool(), skill(SkillRootScope::App, "one"), true),
            change(second.pool(), skill(SkillRootScope::Shared, "two"), true)
        );
        one.unwrap();
        two.unwrap();
        assert_eq!(
            load(first.pool()).await.unwrap(),
            BTreeSet::from([
                skill(SkillRootScope::App, "one"),
                skill(SkillRootScope::Shared, "two")
            ])
        );
        let (one, two) = tokio::join!(
            change(first.pool(), skill(SkillRootScope::App, "one"), false),
            change(second.pool(), skill(SkillRootScope::App, "three"), true)
        );
        one.unwrap();
        two.unwrap();
        assert_eq!(
            load(second.pool()).await.unwrap(),
            BTreeSet::from([
                skill(SkillRootScope::Shared, "two"),
                skill(SkillRootScope::App, "three")
            ])
        );
    }

    #[tokio::test]
    async fn user_given_disabled_skills_when_exporting_a_backup_then_keeps_the_choices_in_the_snapshot(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let runtime = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        load(runtime.pool()).await.unwrap();
        change(
            runtime.pool(),
            skill(SkillRootScope::Shared, "example"),
            true,
        )
        .await
        .unwrap();
        let restored_root = temp.path().join("restored");
        fs::create_dir(&restored_root).unwrap();
        let backup = restored_root.join("touchai.db");
        runtime
            .export_backup("main", backup.to_str().unwrap())
            .await
            .unwrap();
        let snapshot = DatabaseRuntime::initialize_for_tests(&restored_root)
            .await
            .unwrap();
        assert_eq!(
            load(snapshot.pool()).await.unwrap(),
            BTreeSet::from([skill(SkillRootScope::Shared, "example")])
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
            assert!(load(runtime.pool()).await.is_err());
        }
    }

    #[tokio::test]
    async fn user_given_an_invalid_portable_identity_when_loading_then_gets_an_error() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = DatabaseRuntime::initialize_for_tests(temp.path())
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?)")
            .bind(SETTING_KEY)
            .bind(r#"[{"scope":"shared","directoryName":"../escape"}]"#)
            .execute(runtime.pool())
            .await
            .unwrap();
        assert!(load(runtime.pool()).await.is_err());
    }
}
