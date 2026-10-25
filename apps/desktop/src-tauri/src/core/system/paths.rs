// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

//! Application directory layout and path resolution.

use serde::Deserialize;
use std::{path::PathBuf, sync::OnceLock};

const TAURI_CONFIG_JSON: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppDirectory {
    Data,
    Logs,
    Cache,
    CacheIcons,
    Assets,
    AssetsFont,
    AssetsBin,
}

#[derive(Debug, Deserialize)]
struct TauriIdentifierConfig {
    identifier: String,
}

pub(crate) const APP_DIRECTORY_LAYOUT: &[(AppDirectory, &str, &str)] = &[
    (AppDirectory::Data, "DATA", "data"),
    (AppDirectory::Logs, "LOGS", "logs"),
    (AppDirectory::Cache, "CACHE", "cache"),
    (AppDirectory::CacheIcons, "CACHE_ICONS", "cache/icons"),
    (AppDirectory::Assets, "ASSETS", "assets"),
    (AppDirectory::AssetsFont, "ASSETS_FONT", "assets/font"),
    (AppDirectory::AssetsBin, "ASSETS_BIN", "assets/bin"),
];

fn resolve_program_root_directory() -> Result<PathBuf, String> {
    if let Some(path) = crate::core::system::runtime::resolve_app_root_override() {
        return Ok(path);
    }

    let exe_dir = std::env::current_exe()
        .map_err(|err| format!("Failed to resolve current exe: {err}"))?
        .parent()
        .ok_or_else(|| "Failed to get executable directory".to_string())?
        .to_path_buf();

    if cfg!(debug_assertions) {
        exe_dir
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf())
            .ok_or_else(|| "Failed to get project root".to_string())
    } else {
        Ok(exe_dir)
    }
}

fn bundled_app_identifier() -> Result<&'static str, String> {
    static IDENTIFIER: OnceLock<Result<String, String>> = OnceLock::new();
    IDENTIFIER
        .get_or_init(|| {
            let config: TauriIdentifierConfig = serde_json::from_str(TAURI_CONFIG_JSON)
                .map_err(|error| format!("Failed to parse tauri.conf.json: {error}"))?;
            let identifier = config.identifier.trim().to_string();
            if identifier.is_empty() {
                return Err("tauri.conf.json identifier must not be empty.".to_string());
            }
            Ok(identifier)
        })
        .as_ref()
        .map(|value| value.as_str())
        .map_err(Clone::clone)
}

fn resolve_user_data_root_directory() -> Result<PathBuf, String> {
    if let Some(path) = crate::core::system::runtime::resolve_app_root_override() {
        return Ok(path);
    }

    if cfg!(debug_assertions) {
        return resolve_program_root_directory();
    }

    let base_dir = if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA")
            .or_else(|| std::env::var_os("APPDATA"))
            .map(PathBuf::from)
            .ok_or_else(|| "Failed to resolve LOCALAPPDATA or APPDATA.".to_string())?
    } else if cfg!(target_os = "macos") {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "Failed to resolve HOME.".to_string())?;
        home.join("Library").join("Application Support")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(|home| PathBuf::from(home).join(".local").join("share"))
            })
            .ok_or_else(|| "Failed to resolve XDG_DATA_HOME or HOME.".to_string())?
    };

    Ok(base_dir.join(bundled_app_identifier()?))
}

fn program_root_directory() -> Result<PathBuf, String> {
    static PROGRAM_ROOT: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    PROGRAM_ROOT
        .get_or_init(resolve_program_root_directory)
        .clone()
}

fn user_data_root_directory() -> Result<PathBuf, String> {
    static USER_DATA_ROOT: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    USER_DATA_ROOT
        .get_or_init(resolve_user_data_root_directory)
        .clone()
}

fn directory_relative_path(directory: AppDirectory) -> Result<&'static str, String> {
    APP_DIRECTORY_LAYOUT
        .iter()
        .find_map(|(kind, _, relative_path)| (*kind == directory).then_some(*relative_path))
        .ok_or_else(|| format!("Directory mapping is missing for {directory:?}"))
}

pub fn app_directory_path(directory: AppDirectory) -> Result<PathBuf, String> {
    let _ = directory_relative_path(directory)?;
    Ok(user_data_root_directory()?.join(directory_relative_path(directory)?))
}

pub fn legacy_app_directory_path(directory: AppDirectory) -> Result<PathBuf, String> {
    Ok(program_root_directory()?.join(directory_relative_path(directory)?))
}

pub fn is_user_data_directory(directory: AppDirectory) -> bool {
    APP_DIRECTORY_LAYOUT
        .iter()
        .any(|(kind, _, _)| *kind == directory)
}

pub fn parse_app_directory_key(value: &str) -> Result<AppDirectory, String> {
    let normalized_key = value.trim().to_ascii_uppercase();

    APP_DIRECTORY_LAYOUT
        .iter()
        .find_map(|(directory, key, _)| (*key == normalized_key.as_str()).then_some(*directory))
        .ok_or_else(|| {
            let supported_keys = APP_DIRECTORY_LAYOUT
                .iter()
                .map(|(_, key, _)| *key)
                .collect::<Vec<_>>()
                .join(", ");
            format!("Unsupported app directory '{value}'. Supported: {supported_keys}")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every directory the app writes to is derived from this table. A wrong relative path
    // puts user data somewhere the migration and the cleanup paths do not look.

    #[test]
    fn user_gets_every_configured_directory_resolved_to_a_relative_path() {
        for (directory, _, relative_path) in APP_DIRECTORY_LAYOUT {
            assert_eq!(
                directory_relative_path(*directory).expect("a layout entry resolves"),
                *relative_path
            );
        }
    }

    #[test]
    fn user_gets_every_configured_directory_treated_as_a_directory_of_this_app() {
        // This answers "is this one of our directories", which the layout alone decides.
        for (directory, _, _) in APP_DIRECTORY_LAYOUT {
            assert!(
                is_user_data_directory(*directory),
                "{directory:?} is in the layout"
            );
        }
    }

    #[test]
    fn user_gets_a_directory_key_parsed_from_its_configured_name() {
        for (directory, key, _) in APP_DIRECTORY_LAYOUT {
            assert_eq!(
                parse_app_directory_key(key).expect("a configured key parses"),
                *directory
            );
        }
    }

    #[test]
    fn user_gets_an_unknown_directory_key_refused_with_the_supported_names() {
        let error = parse_app_directory_key("NOT_A_DIRECTORY").expect_err("unknown key");

        assert!(
            error.contains("Unsupported app directory"),
            "unexpected: {error}"
        );
        assert!(
            error.contains("DATA"),
            "the message should list the keys: {error}"
        );
    }

    #[test]
    fn user_gets_the_app_directory_path_built_under_the_user_data_root() {
        let path = app_directory_path(AppDirectory::Data).expect("a path resolves");
        let root = user_data_root_directory().expect("a root resolves");

        assert!(
            path.starts_with(&root),
            "{} should be under {}",
            path.display(),
            root.display()
        );
        assert!(path.ends_with("data"));
    }

    #[test]
    fn user_gets_the_legacy_path_resolved_under_the_program_root() {
        let legacy = legacy_app_directory_path(AppDirectory::Data).expect("legacy");
        let program_root = program_root_directory().expect("program root");

        // The legacy layout kept data beside the executable, which is why it has to move.
        assert!(legacy.starts_with(&program_root));
        assert!(legacy.ends_with("data"));
    }

    #[test]
    fn user_gets_the_bundled_identifier_read_from_the_config() {
        let identifier = bundled_app_identifier().expect("the config carries an identifier");

        assert!(!identifier.is_empty());
        assert!(
            identifier.contains('.'),
            "unexpected identifier: {identifier}"
        );
    }

    #[test]
    fn user_gets_the_program_root_resolved() {
        let root = program_root_directory().expect("a program root resolves");

        assert!(root.is_absolute(), "{} should be absolute", root.display());
    }
}
