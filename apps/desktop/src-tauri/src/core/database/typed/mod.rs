// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Typed database operations owned by the Rust runtime.
//!
//! The frontend never sends SQL. Every operation in this module is a named
//! business/read operation with a fixed payload and an explicit surface
//! permission.

mod model_id;
mod operation;
pub(crate) mod repositories;
mod repository;
mod row;

pub(crate) use operation::{DatabaseOperation, DatabaseOperationError};

use sqlx::SqlitePool;

use self::operation::OperationSurface;

/// The backup group is allowed from the main and settings windows only.
pub(crate) fn backup_allows(window_label: &str) -> bool {
    OperationSurface::new(OperationGroup::Backup).allows(window_label)
}

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
    SettingsWrite,
    Config,
    Agent,
    Maintenance,
    Search,
    ToolHistory,
    Usage,
    UsageWrite,
    Backup,
}

impl OperationSurface {
    pub(crate) fn allows(self, window_label: &str) -> bool {
        let surface = Surface::from_label(window_label);
        match surface {
            Surface::Main => true,
            // Settings owns configuration, usage, logs, and local-data maintenance
            // surfaces. It must not gain access to the main window's agent loop,
            // search index, settings writes, or usage writes just because those
            // groups happen to share a database.
            Surface::Settings => matches!(
                self.group,
                OperationGroup::Settings
                    | OperationGroup::Config
                    | OperationGroup::Maintenance
                    | OperationGroup::ToolHistory
                    | OperationGroup::Usage
                    | OperationGroup::Backup
            ),
            // There is no standalone popup WebView in the product. Keep the
            // surface fail-closed so a future popup cannot reach search,
            // credentials, configuration writes, or any other database group.
            Surface::Popup => false,
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
    fn user_cannot_read_search_data_from_a_popup_surface() {
        let operation = DatabaseOperation::QuickSearchFind {
            query_norm: "file".to_string(),
            limit: 10,
        };

        assert!(!operation.surface().allows("popup-model-dropdown-popup"));
    }

    #[test]
    fn user_gets_only_the_explicit_settings_surface_groups() {
        let allowed = [
            OperationGroup::Settings,
            OperationGroup::Config,
            OperationGroup::Maintenance,
            OperationGroup::ToolHistory,
            OperationGroup::Usage,
            OperationGroup::Backup,
        ];
        let denied = [
            OperationGroup::SettingsWrite,
            OperationGroup::Agent,
            OperationGroup::Search,
            OperationGroup::UsageWrite,
        ];

        for group in allowed {
            assert!(OperationSurface::new(group).allows("settings"));
        }
        for group in denied {
            assert!(!OperationSurface::new(group).allows("settings"));
        }
    }

    #[test]
    fn user_cannot_reach_database_groups_from_popup_preview_or_unknown_surfaces() {
        let groups = [
            OperationGroup::Settings,
            OperationGroup::SettingsWrite,
            OperationGroup::Config,
            OperationGroup::Agent,
            OperationGroup::Maintenance,
            OperationGroup::Search,
            OperationGroup::ToolHistory,
            OperationGroup::Usage,
            OperationGroup::UsageWrite,
            OperationGroup::Backup,
        ];

        for group in groups {
            for label in [
                "popup-database-test",
                "preview-test",
                "unknown-test",
                "tray-menu",
            ] {
                assert!(
                    !OperationSurface::new(group).allows(label),
                    "{group:?} {label}"
                );
            }
        }
    }

    #[test]
    fn user_cannot_write_settings_from_the_settings_surface() {
        let operation = DatabaseOperation::SettingSet {
            key: "language".to_string(),
            value: "en-US".to_string(),
        };

        assert!(!operation.surface().allows("settings"));
    }

    #[test]
    fn user_cannot_write_statistics_or_app_metadata_from_the_settings_surface() {
        for operation in [
            DatabaseOperation::StatisticSet {
                key: "maintenance".to_string(),
                value: "settings".to_string(),
            },
            DatabaseOperation::MetaSet {
                key: "import_success".to_string(),
                value: "settings".to_string(),
            },
            DatabaseOperation::MetaDelete {
                key: "import_success".to_string(),
            },
        ] {
            assert!(!operation.surface().allows("settings"));
        }
    }

    #[test]
    fn user_can_maintain_local_data_from_the_settings_surface() {
        for group in [OperationGroup::Maintenance] {
            assert!(OperationSurface::new(group).allows("settings"));
        }
    }

    #[test]
    fn user_can_read_usage_from_the_settings_surface() {
        let operation = DatabaseOperation::UsageSummary {
            filter: super::operation::UsageFilterInput {
                from: "2026-01-01 00:00:00".to_string(),
                to: "2026-12-31 23:59:59".to_string(),
                model_ids: None,
                provider_ids: None,
                statuses: None,
                only_failed: None,
                only_retried: None,
                search: None,
            },
        };

        assert!(operation.surface().allows("settings"));
    }

    #[test]
    fn user_cannot_write_usage_detail_from_the_settings_surface() {
        let operation = DatabaseOperation::UsageAppendLlmCallParts {
            message_id: 1,
            calls: Vec::new(),
        };

        assert!(!operation.surface().allows("settings"));
    }
}
