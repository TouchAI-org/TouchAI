// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! `WheelFetcher` over HTTPS with Range resume, plus the update check.
//!
//! Mirrors reject requests without a `User-Agent` (verified: Tsinghua and Aliyun
//! answer 403 to a default .NET client and 206 once a UA is present), so every
//! request carries one.

use std::cmp::Ordering;
use std::time::Duration;

use futures::StreamExt;

use super::provision::{Fetched, WheelFetcher};

pub struct HttpWheelFetcher {
    client: reqwest::Client,
    user_agent: String,
}

impl HttpWheelFetcher {
    pub fn new(user_agent: impl Into<String>) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|error| format!("Failed to build the download client: {error}"))?;
        Ok(Self {
            client,
            user_agent: user_agent.into(),
        })
    }

    /// Highest `cua-driver` version published on any configured mirror.
    ///
    /// Reads the PEP 503 simple index instead of the JSON API: every mirror
    /// serves it, while the JSON API path differs between mirrors.
    pub async fn latest_version(&self, mirrors: &[&str]) -> Result<String, String> {
        let mut last_error = String::from("no mirror answered");
        for mirror in mirrors {
            let url = format!("{}/simple/cua-driver/", mirror.trim_end_matches('/'));
            let response = self
                .client
                .get(&url)
                .header(reqwest::header::USER_AGENT, &self.user_agent)
                .send()
                .await;

            match response {
                Ok(response) if response.status().is_success() => {
                    let body = response.text().await.map_err(|error| error.to_string())?;
                    match highest_version(&body) {
                        Some(version) => return Ok(version),
                        None => last_error = format!("{mirror} listed no versions"),
                    }
                }
                Ok(response) => last_error = format!("{mirror} answered {}", response.status()),
                Err(error) => last_error = format!("{mirror}: {error}"),
            }
        }
        Err(last_error)
    }
}

impl WheelFetcher for HttpWheelFetcher {
    async fn fetch(&self, url: &str, offset: u64) -> Result<Fetched, String> {
        let mut request = self
            .client
            .get(url)
            .header(reqwest::header::USER_AGENT, &self.user_agent);
        if offset > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
        }

        let response = request
            .send()
            .await
            .map_err(|error| format!("Request failed: {error}"))?;
        let status = response.status();
        if !(status.is_success() || status == reqwest::StatusCode::PARTIAL_CONTENT) {
            return Err(format!("Mirror answered {status}"));
        }

        // A server that ignores the Range header answers 200 with the whole body.
        // Treat that as a restart instead of appending a duplicate file.
        let restart = offset > 0 && status == reqwest::StatusCode::OK;
        let total = response.content_length().map(|length| length + offset);

        let mut bytes = Vec::with_capacity(total.unwrap_or(0) as usize);
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("Download interrupted: {error}"))?;
            bytes.extend_from_slice(&chunk);
        }

        Ok(Fetched { bytes, restart })
    }
}

/// Highest `cua_driver-<version>-` file name in a PEP 503 index page.
pub fn highest_version(index: &str) -> Option<String> {
    const PREFIX: &str = "cua_driver-";
    let bytes = index.as_bytes();
    let mut best: Option<String> = None;
    let mut cursor = 0usize;

    while let Some(found) = index[cursor..].find(PREFIX) {
        let start = cursor + found + PREFIX.len();
        let rest = &index[start..];
        let end = rest.find("-py3-none-")?;
        let candidate = &rest[..end];
        if is_release(candidate)
            && best
                .as_deref()
                .is_none_or(|current| compare(current, candidate) == Ordering::Less)
        {
            best = Some(candidate.to_string());
        }
        cursor = start;
        if cursor >= bytes.len() {
            break;
        }
    }

    best
}

fn is_release(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

/// Compares two `major.minor.patch` versions.
pub fn compare(left: &str, right: &str) -> Ordering {
    let parse = |value: &str| -> Vec<u64> {
        value
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let left = parse(left);
    let right = parse(right);
    for index in 0..left.len().max(right.len()) {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        match a.cmp(&b) {
            Ordering::Equal => continue,
            other => return other,
        }
    }
    Ordering::Equal
}

#[cfg(test)]
mod tests {
    use super::*;

    const INDEX: &str = r#"
        <a href="../../packages/aa/cua_driver-0.37.0-py3-none-win_amd64.whl">x</a>
        <a href="../../packages/bb/cua_driver-0.38.0-py3-none-win_amd64.whl">x</a>
        <a href="../../packages/cc/cua_driver-0.10.0-py3-none-win_amd64.whl">x</a>
        <a href="../../packages/dd/cua_driver-0.38.0-py3-none-manylinux_2_31_x86_64.whl">x</a>
    "#;

    #[test]
    fn user_gets_the_highest_published_version() {
        assert_eq!(highest_version(INDEX).as_deref(), Some("0.38.0"));
    }

    #[test]
    fn user_gets_no_version_when_the_index_lists_none() {
        assert!(highest_version("<html></html>").is_none());
    }

    #[test]
    fn version_order_is_numeric_not_lexicographic() {
        assert_eq!(compare("0.10.0", "0.9.0"), Ordering::Greater);
        assert_eq!(compare("0.38.0", "0.38.0"), Ordering::Equal);
        assert_eq!(compare("1.0.0", "0.99.99"), Ordering::Greater);
    }
}
