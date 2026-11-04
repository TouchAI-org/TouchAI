// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Typed database operations owned by the Rust runtime.
//!
//! The frontend never sends SQL. Every operation in this module is a named
//! business/read operation with a fixed payload and an explicit surface
//! permission.

mod model_id;
mod operation;
mod repositories;
mod repository;
mod row;

pub(crate) use operation::{DatabaseOperation, DatabaseOperationError};

use sqlx::SqlitePool;

use self::operation::OperationSurface;

pub(crate) async fn execute(
    pool: &SqlitePool,
    window_label: &str,
    operation: DatabaseOperation,
) -> Result<serde_json::Value, DatabaseOperationError> {
    if !operation.surface().allows(window_label) {
        return Err(DatabaseOperationError::forbidden(window_label));
    }

    repositories::execute(pool, operation).await
}

/// Stable operation groups used by the window permission table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OperationGroup {
    Settings,
    Config,
    Agent,
    Search,
    ToolHistory,
    Usage,
    Backup,
}

impl OperationSurface {
    pub(crate) fn allows(self, window_label: &str) -> bool {
        let surface = Surface::from_label(window_label);
        match surface {
            Surface::Main => true,
            Surface::Settings => self.group != OperationGroup::Agent,
            Surface::Popup => matches!(self.group, OperationGroup::Search | OperationGroup::Config),
            Surface::Preview | Surface::Unknown => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Surface {
    Main,
    Settings,
    Popup,
    Preview,
    Unknown,
}

impl Surface {
    fn from_label(label: &str) -> Self {
        if label == "main" {
            Self::Main
        } else if label == "settings" {
            Self::Settings
        } else if label.starts_with("popup-") {
            Self::Popup
        } else if label.starts_with("preview") {
            Self::Preview
        } else {
            Self::Unknown
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_can_read_settings_from_the_settings_surface() {
        let operation = DatabaseOperation::SettingGet {
            key: "language".to_string(),
        };

        assert!(operation.surface().allows("settings"));
    }

    #[test]
    fn user_cannot_read_settings_from_a_preview_surface() {
        let operation = DatabaseOperation::SettingGet {
            key: "language".to_string(),
        };

        assert!(!operation.surface().allows("preview-surface"));
    }

    #[test]
    fn user_can_read_search_data_from_a_popup_surface() {
        let operation = DatabaseOperation::QuickSearchFind {
            query_norm: "file".to_string(),
            limit: 10,
        };

        assert!(operation.surface().allows("popup-model-dropdown-popup"));
    }
}
