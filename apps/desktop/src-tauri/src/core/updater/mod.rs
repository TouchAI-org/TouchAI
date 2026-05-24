// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Velopack-backed application update support.

use semver::{Prerelease, Version};
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Runtime};
use velopack::{
    sources::{AutoSource, GithubSource},
    Error as VelopackError, UpdateCheck, UpdateInfo, UpdateManager, UpdateOptions,
};

const PRODUCT_CONFIG_JSON: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../product.json"));
const UPDATE_SOURCE_OVERRIDE_ENV: &str = "TOUCHAI_UPDATE_SOURCE_OVERRIDE";
const DOWNLOAD_PROGRESS_EVENT: &str = "updater://download-progress";
const VELOPACK_WORKER_STACK_SIZE: usize = 8 * 1024 * 1024;
const MAXIMUM_DELTAS_BEFORE_FULL_FALLBACK: i32 = 10;
const UPDATE_POLICY_TIMEOUT_SECONDS: u64 = 5;

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
#[serde(rename_all = "camelCase")]
pub struct AppUpdateRequirement {
    pub required: bool,
    pub minimum_supported_version: Option<String>,
    pub required_severity: Option<String>,
    pub required_reason: Option<String>,
    pub target_satisfies_requirement: bool,
}

impl AppUpdateRequirement {
    fn neutral() -> Self {
        Self {
            required: false,
            minimum_supported_version: None,
            required_severity: None,
            required_reason: None,
            target_satisfies_requirement: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateChannelLatest {
    pub version: String,
    pub tag: String,
    pub release_url: String,
    pub published_at: Option<String>,
    pub prerelease: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AppUpdateCheckResult {
    #[serde(rename_all = "camelCase")]
    Available {
        channel: AppUpdateChannel,
        current_version: String,
        latest: Option<AppUpdateChannelLatest>,
        update: AppUpdateInfo,
        requirement: AppUpdateRequirement,
    },
    #[serde(rename_all = "camelCase")]
    NotAvailable {
        channel: AppUpdateChannel,
        current_version: String,
        latest: Option<AppUpdateChannelLatest>,
        requirement: AppUpdateRequirement,
    },
    #[serde(rename_all = "camelCase")]
    Unsupported {
        channel: AppUpdateChannel,
        current_version: Option<String>,
        latest: Option<AppUpdateChannelLatest>,
        reason: AppUpdateUnsupportedReason,
        message: String,
        requirement: AppUpdateRequirement,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppUpdateUnsupportedReason {
    NotInstalled,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductConfig {
    schema_version: u32,
    product: String,
    display_name: String,
    identifier: String,
    repository: ProductRepository,
    packaging: ProductPackaging,
    services: ProductServices,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductRepository {
    url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductPackaging {
    main_exe: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductServices {
    updates: ProductUpdates,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductUpdates {
    base_url: String,
    channels: BTreeMap<String, ProductUpdateChannelConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductUpdateChannelConfig {
    policy: ProductUpdatePolicy,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProductUpdatePolicy {
    minimum_supported_version: Option<String>,
    required_severity: Option<String>,
    required_reason: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct ProductUpdateChannelManifest {
    latest: Option<AppUpdateChannelLatest>,
    policy: ProductUpdatePolicy,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteChannelManifestDocument {
    schema_version: u32,
    product: String,
    display_name: String,
    channel: String,
    generated_at: String,
    latest: Option<AppUpdateChannelLatest>,
    policy: ProductUpdatePolicy,
}

static PRODUCT_CONFIG: OnceLock<Result<ProductConfig, String>> = OnceLock::new();

fn product_config() -> Result<&'static ProductConfig, String> {
    PRODUCT_CONFIG
        .get_or_init(|| product_config_from_json(PRODUCT_CONFIG_JSON))
        .as_ref()
        .map_err(Clone::clone)
}

fn validate_https_url(value: &str, label: &str) -> Result<(), String> {
    let url =
        reqwest::Url::parse(value).map_err(|_| format!("{label} must be an absolute URL."))?;
    if url.scheme() != "https" {
        return Err(format!("{label} must use https."));
    }
    Ok(())
}

fn product_config_from_json(json: &str) -> Result<ProductConfig, String> {
    let config: ProductConfig =
        serde_json::from_str(json).map_err(|error| format!("解析 product.json 失败：{error}"))?;

    if config.schema_version != 1 {
        return Err("product.json schemaVersion must be 1.".to_string());
    }

    if config.product.trim().is_empty() {
        return Err("product.json product must be a non-empty string.".to_string());
    }

    if config.display_name.trim().is_empty() {
        return Err("product.json displayName must be a non-empty string.".to_string());
    }

    if config.identifier.trim().is_empty() {
        return Err("product.json identifier must be a non-empty string.".to_string());
    }

    if config.repository.url.trim().is_empty() {
        return Err("repository.url must be a non-empty string.".to_string());
    }
    validate_https_url(&config.repository.url, "repository.url")?;

    if config.packaging.main_exe.trim().is_empty() {
        return Err("packaging.mainExe must be a non-empty string.".to_string());
    }

    if config.services.updates.base_url.trim().is_empty() {
        return Err("services.updates.baseUrl must be a non-empty string.".to_string());
    }
    validate_https_url(
        &config.services.updates.base_url,
        "services.updates.baseUrl",
    )?;

    if config.services.updates.channels.is_empty() {
        return Err("services.updates.channels must include at least one channel.".to_string());
    }

    for (channel, channel_config) in &config.services.updates.channels {
        if channel.trim().is_empty() {
            return Err("services.updates.channels must not include an empty channel.".to_string());
        }
        let _ = &channel_config.policy;
    }

    Ok(config)
}

fn channel_manifest_url_from_config(
    config: &ProductConfig,
    channel: AppUpdateChannel,
) -> Result<String, String> {
    let channel_name = channel.as_str();
    if !config.services.updates.channels.contains_key(channel_name) {
        return Err(format!(
            "services.updates.channels does not include {channel_name}."
        ));
    }

    let base_url = config.services.updates.base_url.trim_end_matches('/');
    Ok(format!("{base_url}/channels/{channel_name}.json"))
}

fn parse_remote_channel_manifest(
    json: &str,
    expected_product: &str,
    expected_channel: AppUpdateChannel,
) -> Result<ProductUpdateChannelManifest, String> {
    let document: RemoteChannelManifestDocument =
        serde_json::from_str(json).map_err(|error| format!("解析更新通道清单失败：{error}"))?;

    if document.schema_version != 1 {
        return Err("更新通道清单 schemaVersion must be 1.".to_string());
    }

    if document.product != expected_product {
        return Err(format!(
            "更新通道清单 product 不匹配：期望 {expected_product}，实际 {}。",
            document.product
        ));
    }

    if document.channel != expected_channel.as_str() {
        return Err(format!(
            "更新通道清单 channel 不匹配：期望 {}，实际 {}。",
            expected_channel.as_str(),
            document.channel
        ));
    }

    let _ = (document.display_name, document.generated_at);
    Ok(ProductUpdateChannelManifest {
        latest: document.latest,
        policy: document.policy,
    })
}

fn fetch_remote_channel_manifest(
    channel: AppUpdateChannel,
) -> Result<ProductUpdateChannelManifest, String> {
    let config = product_config()?;
    let url = channel_manifest_url_from_config(config, channel)?;

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(UPDATE_POLICY_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| format!("创建更新通道清单客户端失败：{error}"))?;

    let response = client
        .get(&url)
        .send()
        .map_err(|error| format!("拉取更新通道清单失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("拉取更新通道清单失败：{error}"))?;
    let body = response
        .text()
        .map_err(|error| format!("读取更新通道清单失败：{error}"))?;

    parse_remote_channel_manifest(&body, &config.product, channel)
}

#[cfg(test)]
fn version_is_less_than(value: &str, minimum: &str) -> bool {
    match (Version::parse(value), Version::parse(minimum)) {
        (Ok(value), Ok(minimum)) => compare_app_versions(&value, &minimum) == Ordering::Less,
        _ => false,
    }
}

fn version_is_at_least(value: &str, minimum: &str) -> bool {
    match (Version::parse(value), Version::parse(minimum)) {
        (Ok(value), Ok(minimum)) => compare_app_versions(&value, &minimum) != Ordering::Less,
        _ => false,
    }
}

fn compare_app_versions(value: &Version, minimum: &Version) -> Ordering {
    value
        .major
        .cmp(&minimum.major)
        .then_with(|| value.minor.cmp(&minimum.minor))
        .then_with(|| value.patch.cmp(&minimum.patch))
        .then_with(|| compare_app_prerelease(&value.pre, &minimum.pre))
}

fn compare_app_prerelease(value: &Prerelease, minimum: &Prerelease) -> Ordering {
    match (value.is_empty(), minimum.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => {
            let value_rank = prerelease_channel_rank(value);
            let minimum_rank = prerelease_channel_rank(minimum);
            match (value_rank, minimum_rank) {
                (Some(value_rank), Some(minimum_rank)) if value_rank != minimum_rank => {
                    value_rank.cmp(&minimum_rank)
                }
                _ => value.cmp(minimum),
            }
        }
    }
}

fn prerelease_channel_rank(value: &Prerelease) -> Option<u8> {
    match value.as_str().split('.').next() {
        Some("nightly") => Some(0),
        Some("alpha") => Some(1),
        Some("beta") => Some(2),
        Some("rc") => Some(3),
        _ => None,
    }
}

fn update_requirement_from_policy(
    policy: &ProductUpdatePolicy,
    current_version: Option<&str>,
    target_version: Option<&str>,
) -> AppUpdateRequirement {
    let Some(minimum_supported_version) = policy.minimum_supported_version.as_deref() else {
        return AppUpdateRequirement {
            required: false,
            minimum_supported_version: None,
            required_severity: policy.required_severity.clone(),
            required_reason: policy.required_reason.clone(),
            target_satisfies_requirement: true,
        };
    };

    let Ok(minimum_supported_version) = Version::parse(minimum_supported_version) else {
        return AppUpdateRequirement {
            required: false,
            minimum_supported_version: policy.minimum_supported_version.clone(),
            required_severity: policy.required_severity.clone(),
            required_reason: policy.required_reason.clone(),
            target_satisfies_requirement: true,
        };
    };

    let current_is_supported = current_version
        .and_then(|version| Version::parse(version).ok())
        .is_some_and(|version| compare_app_versions(&version, &minimum_supported_version).is_ge());
    let target_satisfies_requirement = target_version
        .and_then(|version| Version::parse(version).ok())
        .is_some_and(|version| compare_app_versions(&version, &minimum_supported_version).is_ge());
    let required = !current_is_supported;

    AppUpdateRequirement {
        required,
        minimum_supported_version: policy.minimum_supported_version.clone(),
        required_severity: policy.required_severity.clone(),
        required_reason: policy.required_reason.clone(),
        target_satisfies_requirement: if required {
            target_satisfies_requirement
        } else {
            true
        },
    }
}

fn neutral_update_requirement() -> AppUpdateRequirement {
    AppUpdateRequirement::neutral()
}

fn manager(channel: AppUpdateChannel) -> Result<UpdateManager, VelopackError> {
    if let Some(source_override) = update_source_override_from_env(|key| std::env::var(key)) {
        return UpdateManager::new(
            AutoSource::new(&source_override),
            Some(update_options(channel)),
            None,
        );
    }

    let config = product_config().map_err(VelopackError::Other)?;
    let source = GithubSource::new(
        &config.repository.url,
        None,
        channel.includes_github_prereleases(),
    );
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

fn unsupported_not_installed(
    channel: AppUpdateChannel,
    latest: Option<AppUpdateChannelLatest>,
) -> AppUpdateCheckResult {
    AppUpdateCheckResult::Unsupported {
        channel,
        current_version: None,
        latest,
        reason: AppUpdateUnsupportedReason::NotInstalled,
        message: "应用通过正式安装包安装后才能使用自动更新。".to_string(),
        requirement: neutral_update_requirement(),
    }
}

fn map_manager_init_error(
    channel: AppUpdateChannel,
    latest: Option<AppUpdateChannelLatest>,
    error: VelopackError,
) -> Result<AppUpdateCheckResult, String> {
    match error {
        VelopackError::NotInstalled(_) => Ok(unsupported_not_installed(channel, latest)),
        other => Err(format!("初始化更新器失败：{other}")),
    }
}

pub fn check_for_updates(
    state: &AppUpdaterState,
    channel: AppUpdateChannel,
) -> Result<AppUpdateCheckResult, String> {
    let manifest = match fetch_remote_channel_manifest(channel) {
        Ok(manifest) => manifest,
        Err(error) => {
            log::warn!("拉取更新通道清单失败，继续使用默认非强制策略：{error}");
            ProductUpdateChannelManifest::default()
        }
    };
    let latest = manifest.latest.clone();
    let policy = manifest.policy;

    let manager = match manager(channel) {
        Ok(manager) => manager,
        Err(error) => return map_manager_init_error(channel, latest, error),
    };

    let current_version = manager.get_current_version_as_string();

    match manager.check_for_updates() {
        Ok(UpdateCheck::UpdateAvailable(update)) => {
            let requirement = update_requirement_from_policy(
                &policy,
                Some(&current_version),
                Some(&update.TargetFullRelease.Version),
            );
            let response = AppUpdateCheckResult::Available {
                channel,
                current_version,
                latest,
                update: update_info_from_target(&update),
                requirement,
            };
            let mut pending_update = state
                .pending_update
                .lock()
                .map_err(|_| "更新状态锁已损坏".to_string())?;
            *pending_update = Some(PendingUpdate { channel, update });
            Ok(response)
        }
        Ok(UpdateCheck::NoUpdateAvailable | UpdateCheck::RemoteIsEmpty) => {
            let requirement = update_requirement_from_policy(&policy, Some(&current_version), None);
            let mut pending_update = state
                .pending_update
                .lock()
                .map_err(|_| "更新状态锁已损坏".to_string())?;
            *pending_update = None;
            Ok(AppUpdateCheckResult::NotAvailable {
                channel,
                current_version,
                latest,
                requirement,
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
        let override_path = std::env::temp_dir()
            .join("touchai-local-updates")
            .display()
            .to_string();

        let source = update_source_override_from_env(|key| {
            assert_eq!(key, UPDATE_SOURCE_OVERRIDE_ENV);
            Ok(override_path.clone())
        });

        assert_eq!(source.as_deref(), Some(override_path.as_str()));
    }

    #[test]
    fn maps_not_installed_to_unsupported_result() {
        let latest = Some(AppUpdateChannelLatest {
            version: "0.2.1-beta.1".to_string(),
            tag: "v0.2.1-beta.1".to_string(),
            release_url: "https://github.com/TouchAI-org/TouchAI/releases/tag/v0.2.1-beta.1"
                .to_string(),
            published_at: Some("2026-05-24T00:00:00.000Z".to_string()),
            prerelease: true,
        });
        let result = map_manager_init_error(
            AppUpdateChannel::Beta,
            latest.clone(),
            VelopackError::NotInstalled("missing manifest".to_string()),
        )
        .expect("unsupported result");

        assert_eq!(
            result,
            unsupported_not_installed(AppUpdateChannel::Beta, latest)
        );
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
    fn parses_embedded_product_update_config() {
        let config = product_config_from_json(PRODUCT_CONFIG_JSON).expect("product config");

        assert!(!config.product.trim().is_empty());
        assert!(!config.display_name.trim().is_empty());
        assert!(!config.identifier.trim().is_empty());
        assert!(!config.packaging.main_exe.trim().is_empty());
        assert!(config.repository.url.starts_with("https://"));
        assert!(config.services.updates.base_url.starts_with("https://"));
        assert!(config.services.updates.channels.contains_key("stable"));
        assert!(config.services.updates.channels.contains_key("beta"));
        assert!(config.services.updates.channels.contains_key("nightly"));
    }

    #[test]
    fn builds_channel_manifest_url_from_product_config() {
        let config = product_config_from_json(PRODUCT_CONFIG_JSON).expect("product config");

        let url = channel_manifest_url_from_config(&config, AppUpdateChannel::Beta)
            .expect("manifest url");
        let expected_url = format!(
            "{}/channels/{}.json",
            config.services.updates.base_url.trim_end_matches('/'),
            AppUpdateChannel::Beta.as_str()
        );

        assert_eq!(url, expected_url);
    }

    #[test]
    fn parses_remote_channel_manifest_for_expected_product_and_channel() {
        let config = product_config_from_json(PRODUCT_CONFIG_JSON).expect("product config");
        let latest = serde_json::json!({
            "version": "0.2.1",
            "tag": "v0.2.1",
            "releaseUrl": format!("{}/releases/tag/v0.2.1", config.repository.url),
            "publishedAt": "2026-05-24T00:00:00.000Z",
            "prerelease": false
        });
        let body = serde_json::json!({
            "schemaVersion": 1,
            "product": config.product,
            "displayName": config.display_name,
            "channel": AppUpdateChannel::Stable.as_str(),
            "generatedAt": "2026-05-24T00:00:00.000Z",
            "latest": latest,
            "policy": {
                "minimumSupportedVersion": "0.2.1",
                "requiredSeverity": "critical",
                "requiredReason": "Security update required"
            }
        })
        .to_string();

        let manifest =
            parse_remote_channel_manifest(&body, &config.product, AppUpdateChannel::Stable)
                .expect("remote manifest");
        let policy = manifest.policy;

        assert_eq!(
            manifest.latest,
            Some(AppUpdateChannelLatest {
                version: "0.2.1".to_string(),
                tag: "v0.2.1".to_string(),
                release_url: format!("{}/releases/tag/v0.2.1", config.repository.url),
                published_at: Some("2026-05-24T00:00:00.000Z".to_string()),
                prerelease: false,
            })
        );
        assert_eq!(policy.minimum_supported_version.as_deref(), Some("0.2.1"));
        assert_eq!(policy.required_severity.as_deref(), Some("critical"));
        assert_eq!(
            policy.required_reason.as_deref(),
            Some("Security update required")
        );
    }

    #[test]
    fn rejects_remote_channel_manifest_for_wrong_channel() {
        let config = product_config_from_json(PRODUCT_CONFIG_JSON).expect("product config");
        let body = serde_json::json!({
            "schemaVersion": 1,
            "product": config.product,
            "displayName": config.display_name,
            "channel": AppUpdateChannel::Nightly.as_str(),
            "generatedAt": "2026-05-24T00:00:00.000Z",
            "latest": null,
            "policy": {
                "minimumSupportedVersion": null,
                "requiredSeverity": null,
                "requiredReason": null
            }
        })
        .to_string();

        let error = parse_remote_channel_manifest(&body, &config.product, AppUpdateChannel::Stable)
            .expect_err("wrong channel must be rejected");

        assert!(error.contains("channel"));
    }

    #[test]
    fn marks_update_required_when_current_version_is_below_minimum() {
        let policy = ProductUpdatePolicy {
            minimum_supported_version: Some("0.2.1".to_string()),
            required_severity: Some("critical".to_string()),
            required_reason: Some("Security update required".to_string()),
        };

        let requirement = update_requirement_from_policy(&policy, Some("0.2.0"), Some("0.2.1"));

        assert_eq!(
            requirement,
            AppUpdateRequirement {
                required: true,
                minimum_supported_version: Some("0.2.1".to_string()),
                required_severity: Some("critical".to_string()),
                required_reason: Some("Security update required".to_string()),
                target_satisfies_requirement: true,
            }
        );
    }

    #[test]
    fn marks_required_update_unsatisfied_when_no_target_reaches_minimum() {
        let policy = ProductUpdatePolicy {
            minimum_supported_version: Some("0.2.1".to_string()),
            required_severity: Some("security".to_string()),
            required_reason: Some("Upgrade required".to_string()),
        };

        let requirement = update_requirement_from_policy(&policy, Some("0.2.0"), Some("0.2.0"));

        assert!(requirement.required);
        assert!(!requirement.target_satisfies_requirement);
    }

    #[test]
    fn treats_missing_or_invalid_minimum_version_as_optional() {
        let policy = ProductUpdatePolicy {
            minimum_supported_version: Some("not-a-version".to_string()),
            required_severity: Some("critical".to_string()),
            required_reason: Some("Ignored because version is invalid".to_string()),
        };

        let requirement = update_requirement_from_policy(&policy, Some("0.2.0"), None);

        assert!(!requirement.required);
        assert!(requirement.target_satisfies_requirement);
        assert_eq!(
            requirement.minimum_supported_version.as_deref(),
            Some("not-a-version")
        );
    }

    #[test]
    fn compares_semver_prereleases_before_final_releases() {
        assert!(version_is_at_least("0.2.0", "0.2.0-beta.1"));
        assert!(!version_is_at_least("0.2.0-beta.1", "0.2.0"));
        assert!(version_is_less_than("0.2.0-nightly.1", "0.2.0-beta.1"));
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
