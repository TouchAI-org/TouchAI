use std::sync::OnceLock;
use std::{fmt, time::Duration};

use reqwest::Url;

use super::types::{BrowserEndpointSnapshot, CdpVersionResponse};

/// 浏览器端点探测与页面操作共享的 HTTP 客户端。
///
/// 每次连接都新建 reqwest Client 会重新建立连接池与 TLS 配置；
/// 端点固定为 loopback + no_proxy，配置恒定，可安全复用。
pub fn shared_http_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();

    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(4))
                .build()
                .map_err(|error| format!("Failed to build browser endpoint client: {error}"))
        })
        .as_ref()
        .map_err(|error| error.clone())
}

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
    let client = shared_http_client()?;

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

#[cfg(test)]
mod tests {
    use super::*;

    // The endpoint is the app's only route into a browser. Every rejection here is a
    // security decision: a non-loopback host would let the agent drive a remote browser.

    #[test]
    fn user_gets_the_endpoint_from_a_loopback_origin() {
        let endpoint = parse_loopback_endpoint("http://127.0.0.1:9222").expect("valid endpoint");

        assert_eq!(endpoint.host, "127.0.0.1");
        assert_eq!(endpoint.port, 9222);
        assert_eq!(endpoint.origin(), "http://127.0.0.1:9222");
    }

    #[test]
    fn user_gets_localhost_accepted_as_a_loopback_host() {
        let endpoint = parse_loopback_endpoint("http://localhost:9222").expect("valid endpoint");

        assert_eq!(endpoint.host, "localhost");
    }

    #[test]
    fn user_gets_an_ipv6_loopback_written_with_brackets() {
        let endpoint = parse_loopback_endpoint("http://[::1]:9222").expect("valid endpoint");

        // The stored host is unbracketed, but the origin has to bracket it again.
        assert_eq!(endpoint.host, "::1");
        assert_eq!(endpoint.origin(), "http://[::1]:9222");
    }

    #[test]
    fn user_gets_a_remote_browser_refused() {
        let error = parse_loopback_endpoint("http://example.com:9222")
            .expect_err("a remote host must be refused");

        assert_eq!(error, "Browser endpoint must use a loopback host");
    }

    #[test]
    fn user_gets_https_refused_for_the_endpoint() {
        let error =
            parse_loopback_endpoint("https://127.0.0.1:9222").expect_err("https must be refused");

        assert_eq!(error, "Browser endpoint must use http");
    }

    #[test]
    fn user_gets_credentials_in_the_endpoint_refused() {
        let error = parse_loopback_endpoint("http://user:pass@127.0.0.1:9222")
            .expect_err("credentials must be refused");

        assert_eq!(error, "Browser endpoint must not include credentials");
    }

    #[test]
    fn user_gets_a_path_on_the_endpoint_refused() {
        let error = parse_loopback_endpoint("http://127.0.0.1:9222/devtools")
            .expect_err("a path must be refused");

        assert_eq!(
            error,
            "Browser endpoint must be an origin without path, query, or fragment"
        );
    }

    #[test]
    fn user_gets_an_endpoint_without_a_port_refused() {
        let error = parse_loopback_endpoint("http://127.0.0.1")
            .expect_err("a missing port must be refused");

        assert_eq!(error, "Browser endpoint must include an explicit port");
    }

    #[test]
    fn user_gets_a_non_url_refused() {
        let error = parse_loopback_endpoint("not a url").expect_err("garbage must be refused");

        assert_eq!(error, "Browser endpoint must be a valid URL");
    }

    #[test]
    fn user_gets_the_version_and_list_urls_built_from_the_origin() {
        let endpoint = parse_loopback_endpoint("http://127.0.0.1:9222").expect("valid endpoint");

        assert_eq!(endpoint.version_url(), "http://127.0.0.1:9222/json/version");
        assert_eq!(endpoint.list_url(), "http://127.0.0.1:9222/json/list");
    }

    #[test]
    fn user_gets_a_new_tab_url_that_encodes_the_target() {
        let endpoint = parse_loopback_endpoint("http://127.0.0.1:9222").expect("valid endpoint");

        let url = endpoint.new_tab_url("https://example.com/a b?x=1&y=2");

        // The target has to survive as one query value, so its separators are escaped.
        assert_eq!(
            url,
            "http://127.0.0.1:9222/json/new?https%3A%2F%2Fexample.com%2Fa%20b%3Fx%3D1%26y%3D2"
        );
    }

    #[test]
    fn user_gets_an_unreserved_character_left_readable_in_a_new_tab_url() {
        let endpoint = parse_loopback_endpoint("http://127.0.0.1:9222").expect("valid endpoint");

        assert!(endpoint
            .new_tab_url("about:blank")
            .contains("about%3Ablank"));
    }

    #[test]
    fn user_gets_a_websocket_url_on_the_same_port_accepted() {
        let endpoint = parse_loopback_endpoint("http://127.0.0.1:9222").expect("valid endpoint");

        assert!(
            validate_loopback_websocket("ws://127.0.0.1:9222/devtools/browser/abc", &endpoint)
                .is_ok()
        );
    }

    #[test]
    fn user_gets_a_websocket_url_on_another_port_refused() {
        let endpoint = parse_loopback_endpoint("http://127.0.0.1:9222").expect("valid endpoint");

        let error =
            validate_loopback_websocket("ws://127.0.0.1:9333/devtools/browser/abc", &endpoint)
                .expect_err("a different port must be refused");

        assert_eq!(
            error,
            "CDP websocket URL must use the same loopback port on a loopback host"
        );
    }

    #[test]
    fn user_gets_a_remote_websocket_url_refused() {
        let endpoint = parse_loopback_endpoint("http://127.0.0.1:9222").expect("valid endpoint");

        let error =
            validate_loopback_websocket("ws://evil.example:9222/devtools/browser/abc", &endpoint)
                .expect_err("a remote websocket must be refused");

        assert_eq!(
            error,
            "CDP websocket URL must use the same loopback port on a loopback host"
        );
    }

    #[test]
    fn user_gets_a_non_websocket_scheme_refused() {
        let endpoint = parse_loopback_endpoint("http://127.0.0.1:9222").expect("valid endpoint");

        let error = validate_loopback_websocket("http://127.0.0.1:9222/devtools", &endpoint)
            .expect_err("http must be refused");

        assert_eq!(error, "CDP websocket URL must use ws");
    }

    #[test]
    fn user_gets_credentials_in_the_websocket_url_refused() {
        let endpoint = parse_loopback_endpoint("http://127.0.0.1:9222").expect("valid endpoint");

        let error = validate_loopback_websocket("ws://u:p@127.0.0.1:9222/devtools", &endpoint)
            .expect_err("credentials must be refused");

        assert_eq!(error, "CDP websocket URL must not include credentials");
    }

    #[test]
    fn user_keeps_acting_while_the_observed_page_is_the_same() {
        assert!(validate_stale_navigation_token("nav-1", "nav-1").is_ok());
    }

    #[test]
    fn user_is_stopped_when_the_page_changed_underneath() {
        let error = validate_stale_navigation_token("nav-1", "nav-2")
            .expect_err("a stale ref must be refused");

        assert_eq!(error, "Browser ref is stale; observe again before acting");
    }

    #[test]
    fn user_gets_the_endpoint_snapshot_the_frontend_reads() {
        let endpoint = parse_loopback_endpoint("http://127.0.0.1:9222").expect("valid endpoint");

        let snapshot = endpoint.snapshot();

        assert_eq!(snapshot.host, "127.0.0.1");
        assert_eq!(snapshot.port, 9222);
        assert_eq!(snapshot.version_url, "http://127.0.0.1:9222/json/version");
    }

    #[test]
    fn user_sees_the_endpoint_origin_in_a_message() {
        let endpoint = parse_loopback_endpoint("http://localhost:9222").expect("valid endpoint");

        assert_eq!(endpoint.to_string(), "http://localhost:9222");
    }
}
