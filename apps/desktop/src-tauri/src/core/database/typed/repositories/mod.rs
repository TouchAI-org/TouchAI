// Copyright (c) 2026. 千诚. Licensed under GPL v3.

mod settings;

use serde_json::Value as JsonValue;
use sqlx::SqlitePool;

use super::operation::{DatabaseOperation, DatabaseOperationError};

pub(super) async fn execute(
    pool: &SqlitePool,
    operation: DatabaseOperation,
) -> Result<JsonValue, DatabaseOperationError> {
    match operation {
        DatabaseOperation::SettingFind { key } => settings::find_setting(pool, key).await,
        DatabaseOperation::SettingGet { key } => settings::get_setting(pool, key).await,
        DatabaseOperation::SettingGetMany { keys } => settings::get_settings(pool, keys).await,
        DatabaseOperation::SettingSet { key, value } => {
            settings::set_setting(pool, key, value).await
        }
        DatabaseOperation::StatisticGet { key } => settings::get_statistic(pool, key).await,
        DatabaseOperation::StatisticSet { key, value } => {
            settings::set_statistic(pool, key, value).await
        }
        DatabaseOperation::MetaGet { key } => settings::get_meta(pool, key).await,
        DatabaseOperation::MetaSet { key, value } => settings::set_meta(pool, key, value).await,
        DatabaseOperation::MetaDelete { key } => settings::delete_meta(pool, key).await,
        DatabaseOperation::QuickSearchFind { query_norm, limit } => {
            settings::find_quick_search(pool, query_norm, limit).await
        }
        DatabaseOperation::QuickSearchFindRecent { query_norm, limit } => {
            settings::find_recent_quick_search(pool, query_norm, limit).await
        }
        DatabaseOperation::QuickSearchUpsert {
            query_norm,
            path_norm,
            max_click_count,
        } => settings::upsert_quick_search(pool, query_norm, path_norm, max_click_count).await,
    }
}
