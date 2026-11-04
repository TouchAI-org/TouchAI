// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use super::OperationGroup;
use serde::{Deserialize, Serialize};

/// A named database operation. The tagged payload is deliberately not a SQL
/// envelope; each variant maps to one repository method.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum DatabaseOperation {
    SettingFind {
        key: String,
    },
    SettingGet {
        key: String,
    },
    SettingGetMany {
        keys: Vec<String>,
    },
    SettingSet {
        key: String,
        value: String,
    },
    StatisticGet {
        key: String,
    },
    StatisticSet {
        key: String,
        value: String,
    },
    MetaGet {
        key: String,
    },
    MetaSet {
        key: String,
        value: String,
    },
    MetaDelete {
        key: String,
    },
    QuickSearchFind {
        query_norm: String,
        limit: u32,
    },
    QuickSearchUpsert {
        query_norm: String,
        path_norm: String,
        max_click_count: u32,
    },
}

impl DatabaseOperation {
    pub(crate) fn surface(&self) -> OperationSurface {
        match self {
            Self::SettingFind { .. }
            | Self::SettingGet { .. }
            | Self::SettingGetMany { .. }
            | Self::SettingSet { .. }
            | Self::StatisticGet { .. }
            | Self::StatisticSet { .. }
            | Self::MetaGet { .. }
            | Self::MetaSet { .. }
            | Self::MetaDelete { .. } => OperationSurface::new(OperationGroup::Settings),
            Self::QuickSearchFind { .. } | Self::QuickSearchUpsert { .. } => {
                OperationSurface::new(OperationGroup::Search)
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DatabaseOperationError {
    pub code: &'static str,
    pub message: String,
}

impl DatabaseOperationError {
    pub(crate) fn validation(message: impl Into<String>) -> Self {
        Self {
            code: "database-validation",
            message: message.into(),
        }
    }

    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self {
            code: "database-not-found",
            message: message.into(),
        }
    }

    pub(crate) fn forbidden(window_label: &str) -> Self {
        Self {
            code: "database-forbidden",
            message: format!(
                "Database operation is not allowed for window '{}'",
                window_label
            ),
        }
    }

    pub(crate) fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: "database-unavailable",
            message: message.into(),
        }
    }
}

impl From<sqlx::Error> for DatabaseOperationError {
    fn from(error: sqlx::Error) -> Self {
        match error {
            sqlx::Error::RowNotFound => Self::not_found("Database row was not found"),
            sqlx::Error::Database(error) if error.is_unique_violation() => Self {
                code: "database-conflict",
                message: error.message().to_string(),
            },
            sqlx::Error::Database(error) if error.is_foreign_key_violation() => Self {
                code: "database-conflict",
                message: error.message().to_string(),
            },
            sqlx::Error::Database(error) => Self {
                code: "database-query",
                message: error.message().to_string(),
            },
            other => Self::unavailable(other.to_string()),
        }
    }
}

impl From<String> for DatabaseOperationError {
    fn from(message: String) -> Self {
        Self::validation(message)
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct OperationSurface {
    pub(crate) group: OperationGroup,
}

impl OperationSurface {
    const fn new(group: OperationGroup) -> Self {
        Self { group }
    }
}
