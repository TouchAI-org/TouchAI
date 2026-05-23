// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Velopack-backed application update support.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Runtime};
use velopack::{
    sources::{AutoSource, GithubSource},
    Error as VelopackError, UpdateCheck, UpdateInfo, UpdateManager, UpdateOptions,
};

const GITHUB_REPO_URL: &str = "https://github.com/TouchAI-org/TouchAI";
const UPDATE_SOURCE_OVERRIDE_ENV: &str = "TOUCHAI_UPDATE_SOURCE_OVERRIDE";
const DOWNLOAD_PROGRESS_EVENT: &str = "updater://download-progress";
const VELOPACK_WORKER_STACK_SIZE: usize = 8 * 1024 * 1024;
const MAXIMUM_DELTAS_BEFORE_FULL_FALLBACK: i32 = 10;

#[derive(Default)]
pub struct AppUpdaterState {
    pending_update: Mutex<Option<PendingUpdate>>,
}

#[derive(Debug, Clone)]
struct PendingUpdate {
    channel: AppUpdateChannel,
    update: UpdateInfo,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppUpdateChannel {
    Stable,
    Beta,
    Nightly,
}

impl AppUpdateChannel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
            Self::Nightly => "nightly",
        }
    }

    fn includes_github_prereleases(self) -> bool {
        matches!(self, Self::Beta | Self::Nightly)
    }
}

impl Default for AppUpdateChannel {
    fn default() -> Self {
        Self::Stable
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub version: String,
    pub file_name: String,
    pub notes: Option<String>,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AppUpdateCheckResult {
    #[serde(rename_all = "camelCase")]
    Available {
        channel: AppUpdateChannel,
        current_version: String,
        update: AppUpdateInfo,
    },
    #[serde(rename_all = "camelCase")]
    NotAvailable {
        channel: AppUpdateChannel,
        current_version: String,
    },
    #[serde(rename_all = "camelCase")]
    Unsupported {
        channel: AppUpdateChannel,
        current_version: Option<String>,
        reason: AppUpdateUnsupportedReason,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppUpdateUnsupportedReason {
    NotInstalled,
}

fn manager(channel: AppUpdateChannel) -> Result<UpdateManager, VelopackError> {
    if let Some(source_override) = update_source_override_from_env(|key| std::env::var(key)) {
        return UpdateManager::new(
            AutoSource::new(&source_override),
            Some(update_options(channel)),
            None,
        );
    }

    let source = GithubSource::new(GITHUB_REPO_URL, None, channel.includes_github_prereleases());
    UpdateManager::new(source, Some(update_options(channel)), None)
}

fn update_options(channel: AppUpdateChannel) -> UpdateOptions {
    UpdateOptions {
        AllowVersionDowngrade: true,
        ExplicitChannel: Some(channel.as_str().to_string()),
        MaximumDeltasBeforeFallback: MAXIMUM_DELTAS_BEFORE_FULL_FALLBACK,
        ..UpdateOptions::default()
    }
}

fn update_source_override_from_env(
    get_env: impl FnOnce(&str) -> Result<String, std::env::VarError>,
) -> Option<String> {
    get_env(UPDATE_SOURCE_OVERRIDE_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn update_info_from_target(update: &UpdateInfo) -> AppUpdateInfo {
    let target = &update.TargetFullRelease;
    let notes = if target.NotesMarkdown.trim().is_empty() {
        None
    } else {
        Some(target.NotesMarkdown.clone())
    };

    AppUpdateInfo {
        version: target.Version.clone(),
        file_name: target.FileName.clone(),
        notes,
        size_bytes: Some(target.Size),
    }
}

fn unsupported_not_installed(channel: AppUpdateChannel) -> AppUpdateCheckResult {
    AppUpdateCheckResult::Unsupported {
        channel,
        current_version: None,
        reason: AppUpdateUnsupportedReason::NotInstalled,
        message: "应用通过正式安装包安装后才能使用自动更新。".to_string(),
    }
}

fn map_manager_init_error(
    channel: AppUpdateChannel,
    error: VelopackError,
) -> Result<AppUpdateCheckResult, String> {
    match error {
        VelopackError::NotInstalled(_) => Ok(unsupported_not_installed(channel)),
        other => Err(format!("初始化更新器失败：{other}")),
    }
}

pub fn check_for_updates(
    state: &AppUpdaterState,
    channel: AppUpdateChannel,
) -> Result<AppUpdateCheckResult, String> {
    let manager = match manager(channel) {
        Ok(manager) => manager,
        Err(error) => return map_manager_init_error(channel, error),
    };

    let current_version = manager.get_current_version_as_string();
    match manager.check_for_updates() {
        Ok(UpdateCheck::UpdateAvailable(update)) => {
            let response = AppUpdateCheckResult::Available {
                channel,
                current_version,
                update: update_info_from_target(&update),
            };
            let mut pending_update = state
                .pending_update
                .lock()
                .map_err(|_| "更新状态锁已损坏".to_string())?;
            *pending_update = Some(PendingUpdate { channel, update });
            Ok(response)
        }
        Ok(UpdateCheck::NoUpdateAvailable | UpdateCheck::RemoteIsEmpty) => {
            let mut pending_update = state
                .pending_update
                .lock()
                .map_err(|_| "更新状态锁已损坏".to_string())?;
            *pending_update = None;
            Ok(AppUpdateCheckResult::NotAvailable {
                channel,
                current_version,
            })
        }
        Err(error) => Err(format!("检查更新失败：{error}")),
    }
}

pub fn download_update<R: Runtime>(
    app: AppHandle<R>,
    state: &AppUpdaterState,
) -> Result<AppUpdateInfo, String> {
    let pending_update = state
        .pending_update
        .lock()
        .map_err(|_| "更新状态锁已损坏".to_string())?
        .clone()
        .ok_or_else(|| "没有可下载的更新，请先检查更新".to_string())?;

    let update_info = update_info_from_target(&pending_update.update);
    download_updates_on_velopack_worker(pending_update)?;
    let _ = app.emit(DOWNLOAD_PROGRESS_EVENT, 100_i16);

    Ok(update_info)
}

fn download_updates_on_velopack_worker(pending_update: PendingUpdate) -> Result<(), String> {
    run_on_velopack_worker(move || {
        let manager = match manager(pending_update.channel) {
            Ok(manager) => manager,
            Err(VelopackError::NotInstalled(_)) => {
                return Err("当前运行方式暂不支持应用内更新".to_string())
            }
            Err(error) => return Err(format!("初始化更新器失败：{error}")),
        };

        manager
            .download_updates(&pending_update.update, None)
            .map_err(|error| format!("下载更新失败：{error}"))
    })
}

fn run_on_velopack_worker(
    task: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    std::thread::Builder::new()
        .name("touchai-velopack-download".to_string())
        .stack_size(VELOPACK_WORKER_STACK_SIZE)
        .spawn(task)
        .map_err(|error| format!("启动更新下载任务失败：{error}"))?
        .join()
        .map_err(|_| "更新下载任务异常退出".to_string())?
}

pub fn install_update(state: &AppUpdaterState) -> Result<bool, String> {
    let pending_update = state
        .pending_update
        .lock()
        .map_err(|_| "更新状态锁已损坏".to_string())?
        .clone()
        .ok_or_else(|| "没有已下载的更新，请先下载更新".to_string())?;

    let manager = match manager(pending_update.channel) {
        Ok(manager) => manager,
        Err(VelopackError::NotInstalled(_)) => {
            return Err("当前运行方式暂不支持应用内更新".to_string())
        }
        Err(error) => return Err(format!("初始化更新器失败：{error}")),
    };

    manager
        .apply_updates_and_restart(pending_update.update)
        .map_err(|error| format!("安装更新失败：{error}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_update_source_override_from_env() {
        let override_path = r"D:\TouchAI\local-updates";

        let source = update_source_override_from_env(|key| {
            assert_eq!(key, UPDATE_SOURCE_OVERRIDE_ENV);
            Ok(override_path.to_string())
        });

        assert_eq!(source.as_deref(), Some(override_path));
    }

    #[test]
    fn maps_not_installed_to_unsupported_result() {
        let result = map_manager_init_error(
            AppUpdateChannel::Beta,
            VelopackError::NotInstalled("missing manifest".to_string()),
        )
        .expect("unsupported result");

        assert_eq!(result, unsupported_not_installed(AppUpdateChannel::Beta));
    }

    #[test]
    fn channel_update_options_allow_deltas_and_use_explicit_channel() {
        let options = update_options(AppUpdateChannel::Nightly);

        assert_eq!(options.ExplicitChannel.as_deref(), Some("nightly"));
        assert_eq!(
            options.MaximumDeltasBeforeFallback,
            MAXIMUM_DELTAS_BEFORE_FULL_FALLBACK
        );
        assert!(options.AllowVersionDowngrade);
    }

    #[test]
    fn only_non_stable_channels_include_github_prereleases() {
        assert!(!AppUpdateChannel::Stable.includes_github_prereleases());
        assert!(AppUpdateChannel::Beta.includes_github_prereleases());
        assert!(AppUpdateChannel::Nightly.includes_github_prereleases());
    }

    #[test]
    fn velopack_worker_uses_large_stack() {
        let result = run_on_velopack_worker(|| {
            const BUFFER_SIZE: usize = 2 * 1024 * 1024;
            let mut buffer = [0_u8; BUFFER_SIZE];
            buffer[0] = 1;
            buffer[BUFFER_SIZE - 1] = 2;
            std::hint::black_box(&mut buffer);
            assert_eq!(buffer[0] + buffer[BUFFER_SIZE - 1], 3);
            Ok(())
        });

        assert!(result.is_ok());
    }
}
