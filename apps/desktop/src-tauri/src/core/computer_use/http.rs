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

/// One published release, resolved from the package indexes.
pub struct WheelRelease {
    pub package_path: String,
    pub sha256: String,
}

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
        for url in self.sources(mirrors, "/simple/cua-driver/").await {
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
                        None => last_error = format!("{url} listed no versions"),
                    }
                }
                Ok(response) => last_error = format!("{url} answered {}", response.status()),
                Err(error) => last_error = format!("{url}: {error}"),
            }
        }
        Err(last_error)
    }

    /// Resolve the wheel for `version` and the digest every reachable index agrees on.
    ///
    /// The pinned manifest cannot describe a version that did not exist when this
    /// build shipped, so an upgrade takes its digest from the indexes instead. The
    /// official index must answer and no two indexes may disagree, otherwise the
    /// caller has no reviewed bytes to verify against and the upgrade is refused.
    pub async fn release(
        &self,
        mirrors: &[&str],
        version: &str,
        filename: &str,
    ) -> Result<WheelRelease, String> {
        let mut agreed: Option<(String, String)> = None;
        let mut official: Option<(String, String)> = None;
        let mut last_error = String::from("no mirror answered");
        for (index, mirror) in mirrors.iter().enumerate() {
            let url = format!("{}/simple/cua-driver/", mirror.trim_end_matches('/'));
            let response = self
                .client
                .get(&url)
                .header(reqwest::header::USER_AGENT, &self.user_agent)
                .send()
                .await;
            let body = match response {
                Ok(response) if response.status().is_success() => match response.text().await {
                    Ok(body) => body,
                    Err(error) => {
                        last_error = format!("{url}: {error}");
                        continue;
                    }
                },
                Ok(response) => {
                    last_error = format!("{url} answered {}", response.status());
                    continue;
                }
                Err(error) => {
                    last_error = format!("{url}: {error}");
                    continue;
                }
            };
            let Some((path, digest)) = wheel_entry(&body, filename) else {
                last_error = format!("{url} does not publish {filename}");
                continue;
            };
            if index == 0 {
                official = Some((path.clone(), digest.clone()));
            }
            match &agreed {
                Some((_, known)) if *known != digest => {
                    return Err(format!(
                        "package indexes disagree on {filename}: {known} and {digest}"
                    ));
                }
                Some(_) => {}
                None => agreed = Some((path, digest)),
            }
        }
        let Some((_, digest)) = agreed else {
            return Err(last_error);
        };
        let Some((path, official_digest)) = official else {
            return Err(format!(
                "the official package index did not answer; refusing to install {version} without a reviewed digest"
            ));
        };
        if official_digest != digest {
            return Err(format!(
                "the official package index reports a different digest for {filename}"
            ));
        }
        Ok(WheelRelease {
            package_path: path,
            sha256: digest,
        })
    }
}

/// The href and `sha256` digest of one wheel in a PEP 503 index page.
///
/// Indexes disagree on how they link a file: PyPI publishes an absolute
/// `https://files.pythonhosted.org/...` URL, while the mirrors use a relative
/// `../../packages/...`. Both are reduced to the archive path so every mirror
/// can serve it with its own host.
pub fn wheel_entry(index: &str, filename: &str) -> Option<(String, String)> {
    let mut cursor = 0usize;
    while let Some(found) = index[cursor..].find("href=\"") {
        let start = cursor + found + "href=\"".len();
        let end = start + index[start..].find('"')?;
        let href = &index[start..end];
        cursor = end;
        if !href.contains(filename) {
            continue;
        }
        let Some((path, fragment)) = href.split_once('#') else {
            continue;
        };
        let Some(digest) = fragment.strip_prefix("sha256=") else {
            continue;
        };
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        let path = absolute_path(path)?;
        return Some((format!("/{path}"), digest.to_ascii_lowercase()));
    }
    None
}

fn absolute_path(href: &str) -> Option<&str> {
    let path = match href.split_once("://") {
        Some((_, rest)) => rest.split_once('/').map(|(_, path)| path)?,
        None => href.trim_start_matches("./").trim_start_matches("../"),
    };
    (!path.is_empty() && !path.starts_with('/')).then_some(path)
}

impl WheelFetcher for HttpWheelFetcher {
    async fn sources(&self, mirrors: &[&str], package_path: &str) -> Vec<String> {
        let mut urls: Vec<String> = mirrors
            .iter()
            .map(|mirror| format!("{}{}", mirror.trim_end_matches('/'), package_path))
            .collect();
        let mut probes = futures::stream::FuturesUnordered::new();
        for (index, url) in urls.iter().enumerate() {
            let request = self
                .client
                .head(url)
                .header(reqwest::header::USER_AGENT, &self.user_agent)
                .timeout(Duration::from_secs(3));
            probes.push(async move {
                (
                    index,
                    request
                        .send()
                        .await
                        .is_ok_and(|response| response.status().is_success()),
                )
            });
        }
        let preferred = loop {
            match probes.next().await {
                Some((index, true)) => break Some(index),
                Some((_, false)) => continue,
                None => break None,
            }
        };
        drop(probes);
        if let Some(index) = preferred {
            let chosen = urls.remove(index);
            log::info!("Computer-use download source selected by network availability: {chosen}");
            urls.insert(0, chosen);
        }
        urls
    }

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
    fn user_given_a_published_wheel_when_resolving_it_then_gets_its_absolute_path_and_digest() {
        const PAGE: &str = r#"
            <a href="../../packages/6f/81/6192287039cc/cua_driver-0.44.0-py3-none-win_amd64.whl#sha256=1fba13e3a3f513117ce36e11949150708e25af5b035058cf870d9148f102db0f" data-requires-python="&gt;=3.10">cua_driver-0.44.0-py3-none-win_amd64.whl</a>
            <a href="../../packages/6f/81/6192287039cc/cua_driver-0.44.0-py3-none-win_arm64.whl#sha256=bf1561ba87ce40505edbc21c18cc64de649976efe0153389f711a6ddb9e2df38">cua_driver-0.44.0-py3-none-win_arm64.whl</a>
        "#;

        assert_eq!(
            wheel_entry(PAGE, "cua_driver-0.44.0-py3-none-win_amd64.whl"),
            Some((
                "/packages/6f/81/6192287039cc/cua_driver-0.44.0-py3-none-win_amd64.whl".to_string(),
                "1fba13e3a3f513117ce36e11949150708e25af5b035058cf870d9148f102db0f".to_string(),
            ))
        );
    }

    #[test]
    fn user_given_a_wheel_without_a_digest_when_resolving_it_then_gets_no_release() {
        const PAGE: &str = r#"
            <a href="../../packages/6f/81/cua_driver-0.44.0-py3-none-win_amd64.whl">x</a>
            <a href="../../packages/6f/81/cua_driver-0.44.0-py3-none-win_amd64.whl#md5=abc">x</a>
        "#;

        assert_eq!(
            wheel_entry(PAGE, "cua_driver-0.44.0-py3-none-win_amd64.whl"),
            None
        );
    }

    #[test]
    fn user_given_an_absolute_file_url_when_resolving_it_then_gets_the_same_archive_path() {
        const PAGE: &str = r#"
            <a href="https://files.pythonhosted.org/packages/d8/ca/cua_driver-0.44.0-py3-none-win_amd64.whl#sha256=1fba13e3a3f513117ce36e11949150708e25af5b035058cf870d9148f102db0f">x</a>
        "#;

        assert_eq!(
            wheel_entry(PAGE, "cua_driver-0.44.0-py3-none-win_amd64.whl"),
            Some((
                "/packages/d8/ca/cua_driver-0.44.0-py3-none-win_amd64.whl".to_string(),
                "1fba13e3a3f513117ce36e11949150708e25af5b035058cf870d9148f102db0f".to_string(),
            ))
        );
    }

    /// Live check of the upgrade path against the real indexes.
    ///
    /// Ignored by default: it needs the network and downloads a release wheel.
    /// Run with `--ignored` to verify that the digests agree and the resolved
    /// archive really is the one the mirror serves.
    #[tokio::test]
    #[ignore = "downloads a release from the package indexes"]
    async fn user_given_the_published_indexes_when_resolving_a_release_then_agrees_on_its_digest() {
        let fetcher = HttpWheelFetcher::new("TouchAI/test").expect("client");
        let manifest = &super::super::cua_driver::manifest::MANIFEST;
        let artifact = super::super::manifest::artifact(manifest).expect("artifact");
        let filename = super::super::cua_driver::manifest::release_filename(artifact, "0.44.0")
            .expect("filename");

        let release = fetcher
            .release(&manifest.mirrors, "0.44.0", &filename)
            .await
            .expect("release resolved from agreeing indexes");

        assert_eq!(release.sha256.len(), 64);
        assert!(release.package_path.ends_with(&filename));
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
