// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Shared product.json contract.
//!
//! Both the updater and analytics read the same embedded configuration. Keeping
//! the parser here prevents two copies of the endpoint and validation rules from
//! drifting apart.

use std::{collections::BTreeMap, sync::OnceLock};

use serde::Deserialize;
use uuid::Uuid;

const PRODUCT_CONFIG_JSON: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../product.json"));

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductConfig {
    pub(crate) schema_version: u32,
    pub(crate) product: String,
    pub(crate) display_name: String,
    pub(crate) identifier: String,
    pub(crate) repository: ProductRepository,
    pub(crate) packaging: ProductPackaging,
    pub(crate) services: ProductServices,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductRepository {
    pub(crate) url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductPackaging {
    pub(crate) main_exe: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductServices {
    pub(crate) updates: ProductUpdates,
    #[serde(default)]
    pub(crate) analytics: Option<ProductAnalytics>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductUpdates {
    pub(crate) base_url: String,
    pub(crate) channels: BTreeMap<String, ProductUpdateChannelConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductUpdateChannelConfig {
    pub(crate) policy: ProductUpdatePolicy,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductUpdatePolicy {
    pub(crate) minimum_supported_version: Option<String>,
    pub(crate) required_severity: Option<String>,
    pub(crate) required_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductAnalytics {
    pub(crate) base_url: String,
    pub(crate) protocol_version: u32,
    pub(crate) website_id: String,
    #[serde(default)]
    pub(crate) default_enabled: bool,
}

impl ProductAnalytics {
    pub(crate) fn send_url(&self) -> Result<String, String> {
        let base = self.base_url.trim_end_matches('/');
        let url = reqwest::Url::parse(&format!("{base}/send"))
            .map_err(|error| format!("services.analytics.baseUrl is invalid: {error}"))?;
        validate_https_url(&url, "services.analytics.baseUrl")?;
        Ok(url.to_string())
    }

    /// A deployment is transport-ready only when its generated project id is a
    /// real UUID. The public placeholder must never become a fabricated target.
    pub(crate) fn is_transport_ready(&self) -> bool {
        self.protocol_version == 1 && Uuid::parse_str(self.website_id.trim()).is_ok()
    }
}

static PRODUCT_CONFIG: OnceLock<Result<ProductConfig, String>> = OnceLock::new();

pub(crate) fn product_config() -> Result<&'static ProductConfig, String> {
    PRODUCT_CONFIG
        .get_or_init(|| product_config_from_json(PRODUCT_CONFIG_JSON))
        .as_ref()
        .map_err(Clone::clone)
}

pub(crate) fn product_config_from_json(json: &str) -> Result<ProductConfig, String> {
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
    validate_https_url_value(&config.repository.url, "repository.url")?;

    if config.packaging.main_exe.trim().is_empty() {
        return Err("packaging.mainExe must be a non-empty string.".to_string());
    }

    if config.services.updates.base_url.trim().is_empty() {
        return Err("services.updates.baseUrl must be a non-empty string.".to_string());
    }
    validate_https_url_value(
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

    if let Some(analytics) = &config.services.analytics {
        if analytics.base_url.trim().is_empty() {
            return Err("services.analytics.baseUrl must be a non-empty string.".to_string());
        }
        let url = reqwest::Url::parse(&analytics.base_url)
            .map_err(|error| format!("services.analytics.baseUrl is invalid: {error}"))?;
        validate_https_url(&url, "services.analytics.baseUrl")?;
        if url.path().trim_end_matches('/') != "/touchai-app/v1" {
            return Err(
                "services.analytics.baseUrl must use the /touchai-app/v1 path.".to_string(),
            );
        }
        if analytics.protocol_version != 1 {
            return Err("services.analytics.protocolVersion must be 1.".to_string());
        }
        // An empty websiteId is the unprovisioned public placeholder. A malformed
        // non-empty value is a release-configuration error, not a silent fallback.
        let website_id = analytics.website_id.trim();
        if !website_id.is_empty() && Uuid::parse_str(website_id).is_err() {
            return Err("services.analytics.websiteId must be a UUID when configured.".to_string());
        }
    }

    Ok(config)
}

fn validate_https_url_value(value: &str, label: &str) -> Result<(), String> {
    let url =
        reqwest::Url::parse(value).map_err(|_| format!("{label} must be an absolute URL."))?;
    validate_https_url(&url, label)
}

fn validate_https_url(url: &reqwest::Url, label: &str) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err(format!("{label} must use https."));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!("{label} must not contain credentials."));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(format!("{label} must not contain a query or fragment."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_ANALYTICS: &str = r#"
    {
        "schemaVersion": 1,
        "product": "touchai-app",
        "displayName": "TouchAI",
        "identifier": "org.touch-ai.app",
        "repository": { "url": "https://github.com/TouchAI-org/TouchAI" },
        "packaging": { "mainExe": "TouchAI.exe" },
        "services": {
            "updates": {
                "baseUrl": "https://updates.touch-ai.org/touchai-app/v1",
                "channels": {
                    "stable": { "policy": { "minimumSupportedVersion": null, "requiredSeverity": null, "requiredReason": null } }
                }
            },
            "analytics": {
                "baseUrl": "https://analytics.touch-ai.org/touchai-app/v1",
                "protocolVersion": 1,
                "websiteId": "8b6c4a1e-2f5d-4c9a-9b7e-1d3f5a7c9e2b",
                "defaultEnabled": true
            }
        }
    }
    "#;

    #[test]
    fn user_gets_analysis_and_update_endpoints_from_one_product_config() {
        let config = product_config_from_json(VALID_ANALYTICS).expect("valid config");
        let analytics = config.services.analytics.expect("analytics config");

        assert_eq!(analytics.protocol_version, 1);
        assert!(analytics.is_transport_ready());
        assert_eq!(
            analytics.send_url().expect("send url"),
            "https://analytics.touch-ai.org/touchai-app/v1/send"
        );
    }

    #[test]
    fn user_gets_a_missing_site_id_treated_as_not_ready_without_a_fabricated_target() {
        let config = product_config_from_json(
            &VALID_ANALYTICS.replace("8b6c4a1e-2f5d-4c9a-9b7e-1d3f5a7c9e2b", ""),
        )
        .expect("empty placeholder is valid configuration");
        let analytics = config.services.analytics.expect("analytics config");

        assert!(!analytics.is_transport_ready());
    }

    #[test]
    fn user_gets_a_malformed_site_id_rejected_before_transport() {
        let error = product_config_from_json(
            &VALID_ANALYTICS.replace("8b6c4a1e-2f5d-4c9a-9b7e-1d3f5a7c9e2b", "not-a-uuid"),
        )
        .expect_err("malformed site id must fail config parsing");

        assert!(error.contains("websiteId"));
    }
}
