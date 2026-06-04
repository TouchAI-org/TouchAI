use std::{fmt, time::Duration};

use reqwest::Url;

use super::types::{BrowserEndpointSnapshot, CdpVersionResponse};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserEndpoint {
    pub host: String,
    pub port: u16,
}

impl BrowserEndpoint {
    pub fn origin(&self) -> String {
        let host = if self.host.contains(':') && !self.host.starts_with('[') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        format!("http://{}:{}", host, self.port)
    }

    pub fn version_url(&self) -> String {
        format!("{}/json/version", self.origin())
    }

    pub fn list_url(&self) -> String {
        format!("{}/json/list", self.origin())
    }

    pub fn new_tab_url(&self, url: &str) -> String {
        format!(
            "{}/json/new?{}",
            self.origin(),
            percent_encode_query_value(url)
        )
    }

    pub fn snapshot(&self) -> BrowserEndpointSnapshot {
        BrowserEndpointSnapshot {
            host: self.host.clone(),
            port: self.port,
            version_url: self.version_url(),
        }
    }
}

impl fmt::Display for BrowserEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.origin())
    }
}

pub fn parse_loopback_endpoint(raw: &str) -> Result<BrowserEndpoint, String> {
    let url = Url::parse(raw).map_err(|_| "Browser endpoint must be a valid URL".to_string())?;

    if url.scheme() != "http" {
        return Err("Browser endpoint must use http".to_string());
    }

    if !url.username().is_empty() || url.password().is_some() {
        return Err("Browser endpoint must not include credentials".to_string());
    }

    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(
            "Browser endpoint must be an origin without path, query, or fragment".to_string(),
        );
    }

    let host = url
        .host_str()
        .ok_or_else(|| "Browser endpoint must include a host".to_string())?;
    let host = normalize_loopback_host(host);
    if !is_allowed_loopback_host(&host) {
        return Err("Browser endpoint must use a loopback host".to_string());
    }

    let port = url
        .port()
        .ok_or_else(|| "Browser endpoint must include an explicit port".to_string())?;

    Ok(BrowserEndpoint { host, port })
}

pub async fn validate_cdp_version_endpoint(
    endpoint: &BrowserEndpoint,
) -> Result<CdpVersionResponse, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|error| format!("Failed to build browser endpoint client: {error}"))?;

    let version = client
        .get(endpoint.version_url())
        .send()
        .await
        .map_err(|error| format!("Failed to query browser endpoint: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Browser endpoint returned an error: {error}"))?
        .json::<CdpVersionResponse>()
        .await
        .map_err(|error| format!("Browser endpoint did not return valid /json/version: {error}"))?;

    let ws_url = version
        .web_socket_debugger_url
        .as_deref()
        .ok_or_else(|| "Browser endpoint did not expose webSocketDebuggerUrl".to_string())?;
    validate_loopback_websocket(ws_url, endpoint)?;
    Ok(version)
}

pub fn validate_loopback_websocket(raw: &str, endpoint: &BrowserEndpoint) -> Result<(), String> {
    let url = Url::parse(raw).map_err(|_| "CDP websocket URL is invalid".to_string())?;
    if url.scheme() != "ws" {
        return Err("CDP websocket URL must use ws".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("CDP websocket URL must not include credentials".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "CDP websocket URL must include a host".to_string())?;
    let host = normalize_loopback_host(host);
    if !is_allowed_loopback_host(&host) || url.port() != Some(endpoint.port) {
        return Err(
            "CDP websocket URL must use the same loopback port on a loopback host".to_string(),
        );
    }
    Ok(())
}

pub fn validate_stale_navigation_token(supplied: &str, current: &str) -> Result<(), String> {
    if supplied == current {
        Ok(())
    } else {
        Err("Browser ref is stale; observe again before acting".to_string())
    }
}

fn is_allowed_loopback_host(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1"
    )
}

fn normalize_loopback_host(host: &str) -> String {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .to_string()
}

fn percent_encode_query_value(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(byte as char);
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}
