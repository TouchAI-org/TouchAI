mod common;

use std::{
    fs,
    path::{Path, PathBuf},
};

use common::{build_test_app_with_database_root, invoke_command_ok};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteConnection},
    Connection,
};
use tempfile::TempDir;
use touchai_lib::testing::{database_path_for_tests, decode_row};

const CURRENT_MIGRATIONS: &[&str] = &[
    "0000_lyrical_toad",
    "0001_silent_reasoning",
    "0002_quick_search_click_stats_unique",
    "0003_tough_amazoness",
    "0004_ordinary_solo",
    "0005_performance_query_indexes",
];

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("database")
        .join("released")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn rows(connection: &mut SqliteConnection, sql: String) -> Vec<Value> {
    tauri::async_runtime::block_on(async {
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .fetch_all(&mut *connection)
            .await
            .expect("query database")
            .iter()
            .map(|row| Value::Object(decode_row(row).expect("decode database row")))
            .collect()
    })
}

fn scalar<T>(connection: &mut SqliteConnection, sql: &str) -> T
where
    T: for<'r> sqlx::Decode<'r, sqlx::Sqlite> + sqlx::Type<sqlx::Sqlite> + Send + Unpin,
{
    tauri::async_runtime::block_on(async {
        sqlx::query_scalar::<_, T>(sqlx::AssertSqlSafe(sql.to_owned()))
            .fetch_one(&mut *connection)
            .await
            .expect("query scalar")
    })
}

fn open_connection(path: &Path) -> SqliteConnection {
    tauri::async_runtime::block_on(async {
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path))
            .await
            .expect("open database")
    })
}

fn schema_facts(path: &Path) -> Value {
    let mut connection = open_connection(path);
    let objects = rows(
        &mut connection,
        "SELECT type, name, tbl_name, sql
         FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name"
            .to_string(),
    );
    let tables = objects
        .iter()
        .filter(|object| object["type"] == "table")
        .filter_map(|object| object["name"].as_str())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let table_facts = tables
        .into_iter()
        .map(|table| {
            let quoted = quote_identifier(&table);
            let mut indexes = rows(&mut connection, format!("PRAGMA index_list({quoted})"));
            indexes.sort_by_key(|index| index["name"].as_str().unwrap_or_default().to_string());
            let index_facts = indexes
                .iter()
                .filter_map(|index| index["name"].as_str())
                .map(|index| {
                    let mut columns = rows(
                        &mut connection,
                        format!("PRAGMA index_info({})", quote_identifier(index)),
                    );
                    columns.sort_by_key(|column| column["seqno"].as_i64().unwrap_or_default());
                    json!({
                        "name": index,
                        "columns": columns
                    })
                })
                .collect::<Vec<_>>();
            let mut columns = rows(&mut connection, format!("PRAGMA table_info({quoted})"));
            columns.sort_by_key(|column| column["cid"].as_i64().unwrap_or_default());
            let mut foreign_keys = rows(
                &mut connection,
                format!("PRAGMA foreign_key_list({quoted})"),
            );
            foreign_keys.sort_by_key(|foreign_key| foreign_key["id"].as_i64().unwrap_or_default());
            json!({
                "name": table,
                "columns": columns,
                "indexes": index_facts,
                "foreignKeys": foreign_keys,
            })
        })
        .collect::<Vec<_>>();

    tauri::async_runtime::block_on(connection.close()).expect("close schema connection");
    json!({
        "objects": objects,
        "tables": table_facts,
    })
}

fn normalize(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(normalize).collect()),
        Value::Object(values) => {
            let mut entries = values.into_iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, normalize(value)))
                    .collect::<Map<_, _>>(),
            )
        }
        value => value,
    }
}

fn first_difference(left: &Value, right: &Value, path: &str) -> Option<String> {
    match (left, right) {
        (Value::Object(left), Value::Object(right)) => {
            let mut keys = left.keys().chain(right.keys()).collect::<Vec<_>>();
            keys.sort();
            keys.dedup();
            for key in keys {
                let next_path = format!("{path}.{key}");
                match (left.get(key), right.get(key)) {
                    (Some(left), Some(right)) => {
                        if let Some(difference) = first_difference(left, right, &next_path) {
                            return Some(difference);
                        }
                    }
                    (left, right) => {
                        return Some(format!("{next_path}: left={left:?}, right={right:?}"));
                    }
                }
            }
            None
        }
        (Value::Array(left), Value::Array(right)) => {
            for index in 0..left.len().min(right.len()) {
                if let Some(difference) =
                    first_difference(&left[index], &right[index], &format!("{path}[{index}]"))
                {
                    return Some(difference);
                }
            }
            (left.len() != right.len())
                .then(|| format!("{path}.length: left={}, right={}", left.len(), right.len()))
        }
        (left, right) if left != right => Some(format!("{path}: left={left}, right={right}")),
        _ => None,
    }
}

fn prepare_fixture(manifest: &Value, index: usize) -> (TempDir, PathBuf, String) {
    let fixture = &manifest["fixtures"][index];
    let file = fixture["file"].as_str().expect("fixture file");
    let version = fixture["version"].as_str().expect("fixture version");
    let expected_hash = fixture["sha256"].as_str().expect("fixture hash");
    let source = fixture_root().join(file);
    let bytes = fs::read(&source).expect("read released fixture");
    assert_eq!(
        sha256_hex(&bytes),
        expected_hash,
        "frozen fixture {version} changed"
    );

    let root = TempDir::new().expect("fixture database root");
    let target = root.path().join("touchai.db");
    fs::write(&target, bytes).expect("copy released fixture");
    (root, target, version.to_string())
}

#[test]
fn user_upgrades_every_released_database_fixture_in_place() {
    let manifest_path = fixture_root().join("manifest.json");
    let manifest: Value =
        serde_json::from_slice(&fs::read(manifest_path).expect("read fixture manifest"))
            .expect("parse fixture manifest");
    assert_eq!(
        manifest["fixtures"].as_array().expect("fixture list").len(),
        3
    );

    let fresh_root = TempDir::new().expect("fresh database root");
    let fresh_app =
        build_test_app_with_database_root(fresh_root.path()).expect("build fresh test app");
    let fresh_schema = normalize(schema_facts(&database_path_for_tests(
        &fresh_app.main_webview,
    )));

    for index in 0..3 {
        let (_root, path, version) = prepare_fixture(&manifest, index);
        let app = build_test_app_with_database_root(path.parent().expect("fixture parent"))
            .unwrap_or_else(|error| panic!("open {version} fixture: {error}"));
        let database_path = database_path_for_tests(&app.main_webview);
        let mut connection = open_connection(&database_path);

        let integrity: String = scalar(&mut connection, "PRAGMA integrity_check");
        assert_eq!(integrity, "ok", "{version}");
        let journal_mode: String = scalar(&mut connection, "PRAGMA journal_mode");
        assert_eq!(journal_mode.to_lowercase(), "wal", "{version}");

        let ledger = rows(
            &mut connection,
            "SELECT hash FROM migrations ORDER BY id".to_string(),
        );
        assert_eq!(
            ledger
                .iter()
                .map(|row| row["hash"].as_str().expect("migration hash"))
                .collect::<Vec<_>>(),
            CURRENT_MIGRATIONS,
            "{version}"
        );

        let session_sequence: i64 = scalar(
            &mut connection,
            "SELECT seq FROM sqlite_sequence WHERE name = 'sessions'",
        );
        assert_eq!(session_sequence, 30, "{version} must preserve ID gaps");
        assert_eq!(
            rows(&mut connection, "PRAGMA foreign_key_check".to_string()),
            Vec::<Value>::new(),
            "{version}"
        );

        let search_results: Value = invoke_command_ok(
            &app.main_webview,
            "database_operation",
            json!({
                "request": {
                    "kind": "session_list",
                    "query": "arc",
                    "limit": 40
                }
            }),
        );
        assert_eq!(
            search_results
                .as_array()
                .expect("search result list")
                .iter()
                .map(|session| session["id"].as_i64().expect("session id"))
                .collect::<Vec<_>>(),
            vec![10],
            "{version} FTS search"
        );

        let messages: Value = invoke_command_ok(
            &app.main_webview,
            "database_operation",
            json!({
                "request": {
                    "kind": "session_messages",
                    "sessionId": 10
                }
            }),
        );
        let first_message = &messages[0];
        assert_eq!(first_message["id"], 11, "{version}");
        let parts = first_message["parts"].as_array().expect("message parts");
        assert!(
            parts
                .iter()
                .any(|part| part["type"] == "text" && part["content"] == "archived needle text"),
            "{version} text part"
        );
        assert!(
            parts
                .iter()
                .any(|part| part["type"] == "tool_call" && part["tool_call_id"] == "fixture-call"),
            "{version} tool part"
        );
        assert!(
            parts
                .iter()
                .any(|part| part["type"] == "attachment" && part["attachment_id"] == 50),
            "{version} attachment part"
        );
        assert_eq!(
            first_message["attachments"][0]["id"], 50,
            "{version} attachment metadata"
        );

        let latest: Value = invoke_command_ok(
            &app.main_webview,
            "database_operation",
            json!({
                "request": {
                    "kind": "session_list",
                    "limit": 1
                }
            }),
        );
        assert_eq!(latest[0]["id"], 30, "{version} pagination");

        let fixture_schema = normalize(schema_facts(&database_path));
        if fixture_schema != fresh_schema {
            panic!(
                "{version} semantic schema mismatch: {}",
                first_difference(&fixture_schema, &fresh_schema, "$")
                    .unwrap_or_else(|| "unknown difference".to_string())
            );
        }

        tauri::async_runtime::block_on(connection.close()).expect("close fixture connection");
        drop(app);
    }

    drop(fresh_app);
}
