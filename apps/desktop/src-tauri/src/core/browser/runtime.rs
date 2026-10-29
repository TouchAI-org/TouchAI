use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::join_all;
use tokio::time::{timeout_at, Instant};

use super::{
    actions, cdp,
    endpoint::{
        parse_loopback_endpoint, validate_cdp_version_endpoint, validate_stale_navigation_token,
        BrowserEndpoint,
    },
    process::{self, ManagedBrowserProcess},
    snapshot,
    types::{
        BrowserActRequest, BrowserActResult, BrowserConnectExistingRequest,
        BrowserConnectExistingResult, BrowserDomRef, BrowserExistingSession,
        BrowserFingerprintMode, BrowserNavigateRequest, BrowserObservation,
        BrowserObserveOperation, BrowserObserveRequest, BrowserStartRequest, BrowserStatus,
        BrowserStatusKind, BrowserTab, BrowserTabRequest,
    },
    url_policy::validate_browser_url,
};

const EXISTING_BROWSER_DISCOVERY_PORTS: &[u16] = &[
    9222, 9223, 9224, 9225, 9226, 9227, 9228, 9229, 9230, 9231, 9232, 9333,
];

/// 端口发现的总期限与单批并发。
///
/// 顺序探测 12 个端口时，每个不可达端口都要等连接失败；
/// 有界并发 + 总期限把最坏耗时限制在常数级，且不会同时打满文件描述符。
const EXISTING_BROWSER_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(6);
const EXISTING_BROWSER_DISCOVERY_CONCURRENCY: usize = 4;

#[derive(Clone, Default)]
pub struct BrowserRuntime {
    inner: Arc<Mutex<BrowserState>>,
}

#[derive(Default)]
struct BrowserState {
    lifecycle_generation: u64,
    status: BrowserStatusKind,
    managed: bool,
    endpoint: Option<BrowserEndpoint>,
    active_tab_id: Option<String>,
    tabs: Vec<BrowserTab>,
    refs: Vec<BrowserDomRef>,
    observed_tab_id: Option<String>,
    observed_page_token: Option<String>,
    observed_observation_token: Option<String>,
    observation_sequence: u64,
    process: Option<ManagedBrowserProcess>,
    fingerprint: Option<BrowserFingerprintRuntimeConfig>,
    error: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct BrowserFingerprintRuntimeConfig {
    locale: Option<String>,
    timezone: Option<String>,
    stealth_script: bool,
}

impl BrowserRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn status(&self) -> BrowserStatus {
        self.inner.lock().expect("browser runtime lock").status()
    }

    pub fn stop(&self) -> BrowserStatus {
        let process = {
            let mut state = self.inner.lock().expect("browser runtime lock");
            state.lifecycle_generation = state.lifecycle_generation.saturating_add(1);
            let process = state.process.take();
            state.status = BrowserStatusKind::Idle;
            state.managed = false;
            state.endpoint = None;
            state.active_tab_id = None;
            state.tabs.clear();
            state.refs.clear();
            state.observed_tab_id = None;
            state.observed_page_token = None;
            state.observed_observation_token = None;
            state.fingerprint = None;
            state.error = None;
            process
        };
        drop(process);
        let _ = cdp::prune_screenshot_artifacts();
        self.status()
    }

    pub async fn start(&self, request: BrowserStartRequest) -> Result<BrowserStatus, String> {
        let generation = self.begin_start();
        let fingerprint = fingerprint_config_from_request(&request);
        let launch_result =
            tokio::task::spawn_blocking(move || process::launch_managed_browser(request))
                .await
                .map_err(|error| format!("Failed to join browser launch task: {error}"));
        let launch_result = match launch_result {
            Ok(result) => result,
            Err(error) => {
                if self.is_current_lifecycle_generation(generation) {
                    self.set_error(error.clone());
                }
                return Err(error);
            }
        };

        match launch_result {
            Ok((endpoint, process)) => {
                if !self.is_current_lifecycle_generation(generation) {
                    drop(process);
                    return Ok(self.status());
                }
                if let Err(error) = wait_for_endpoint(&endpoint).await {
                    let error = friendly_browser_start_error(&error);
                    if self.is_current_lifecycle_generation(generation) {
                        self.set_error(error.clone());
                    }
                    return Err(error);
                }
                if !self.is_current_lifecycle_generation(generation) {
                    drop(process);
                    return Ok(self.status());
                }
                let stale_process = {
                    let mut state = self.inner.lock().expect("browser runtime lock");
                    if state.lifecycle_generation != generation {
                        Some(process)
                    } else {
                        state.endpoint = Some(endpoint);
                        state.process = Some(process);
                        state.fingerprint = fingerprint;
                        state.managed = true;
                        state.status = BrowserStatusKind::Connected;
                        state.error = None;
                        state.refs.clear();
                        state.observed_tab_id = None;
                        state.observed_page_token = None;
                        state.observed_observation_token = None;
                        None
                    }
                };
                if let Some(process) = stale_process {
                    drop(process);
                    return Ok(self.status());
                }
                let _ = self.refresh_tabs().await;
                Ok(self.status())
            }
            Err(error) => {
                if self.is_current_lifecycle_generation(generation) {
                    self.set_error(error.clone());
                }
                Err(error)
            }
        }
    }

    pub async fn discover_existing_sessions(&self) -> Result<Vec<BrowserExistingSession>, String> {
        let deadline = Instant::now() + EXISTING_BROWSER_DISCOVERY_TIMEOUT;
        let mut sessions = Vec::new();

        for ports in EXISTING_BROWSER_DISCOVERY_PORTS.chunks(EXISTING_BROWSER_DISCOVERY_CONCURRENCY)
        {
            let probes = ports.iter().copied().map(|port| {
                let endpoint = BrowserEndpoint {
                    host: "127.0.0.1".to_string(),
                    port,
                };
                async move {
                    match timeout_at(deadline, existing_session_from_endpoint(endpoint)).await {
                        Ok(Ok(session)) => Some(session),
                        _ => None,
                    }
                }
            });

            sessions.extend(join_all(probes).await.into_iter().flatten());

            if Instant::now() >= deadline {
                break;
            }
        }

        Ok(sessions)
    }

    pub async fn connect_existing(
        &self,
        request: BrowserConnectExistingRequest,
    ) -> Result<BrowserConnectExistingResult, String> {
        let endpoint = parse_loopback_endpoint(&request.endpoint)?;
        let (generation, stale_process) = self.begin_unmanaged_connect();
        drop(stale_process);

        let session = match existing_session_from_endpoint(endpoint.clone()).await {
            Ok(session) => session,
            Err(error) => {
                if self.is_current_lifecycle_generation(generation) {
                    self.set_error(error.clone());
                }
                return Err(error);
            }
        };

        {
            let mut state = self.inner.lock().expect("browser runtime lock");
            if state.lifecycle_generation != generation {
                return Err("Browser connection was superseded".to_string());
            }
            state.endpoint = Some(endpoint);
            state.process = None;
            state.fingerprint = None;
            state.managed = false;
            state.status = BrowserStatusKind::Connected;
            state.error = None;
            state.active_tab_id = session
                .tabs
                .iter()
                .find(|tab| tab.active)
                .or_else(|| session.tabs.first())
                .map(|tab| tab.id.clone());
            state.tabs = session.tabs.clone();
            state.refs.clear();
            state.observed_tab_id = None;
            state.observed_page_token = None;
            state.observed_observation_token = None;
        }

        Ok(BrowserConnectExistingResult {
            status: self.status(),
            session,
        })
    }

    pub async fn refresh_tabs(&self) -> Result<BrowserStatus, String> {
        let (generation, endpoint, current_active_tab_id) = self.connected_snapshot()?;
        let tabs = cdp::list_tabs(&endpoint, current_active_tab_id.as_deref()).await?;
        let active_tab_id = tabs
            .iter()
            .find(|tab| tab.active)
            .or_else(|| tabs.first())
            .map(|tab| tab.id.clone());
        {
            let mut state = self.inner.lock().expect("browser runtime lock");
            if state.lifecycle_generation != generation
                || state.endpoint.as_ref() != Some(&endpoint)
                || state.status != BrowserStatusKind::Connected
            {
                return Ok(state.status());
            }
            state.active_tab_id = active_tab_id;
            state.tabs = tabs;
            state.status = BrowserStatusKind::Connected;
            state.error = None;
        }
        Ok(self.status())
    }

    pub async fn navigate(&self, request: BrowserNavigateRequest) -> Result<BrowserStatus, String> {
        let url = validate_browser_url(&request.url)?;
        let endpoint = self.endpoint()?;
        let fallback_active = self.active_tab_id();
        let tab_id = request.tab_id.as_deref().or(fallback_active.as_deref());
        if tab_id.is_some() {
            self.apply_fingerprint_overrides(&endpoint, tab_id).await?;
            cdp::navigate_current_page(&endpoint, tab_id, &url).await?;
        } else {
            cdp::create_tab(&endpoint, &url).await?;
        }
        self.clear_observed_refs();
        self.refresh_tabs().await
    }

    pub async fn history_action(
        &self,
        request: BrowserTabRequest,
        action: &str,
    ) -> Result<BrowserStatus, String> {
        self.ensure_connected()?;
        let endpoint = self.endpoint()?;
        let fallback_active = self.active_tab_id();
        let tab_id = request.tab_id.as_deref().or(fallback_active.as_deref());
        cdp::history_action(&endpoint, tab_id, action).await?;
        self.clear_observed_refs();
        self.refresh_tabs().await
    }

    pub async fn observe(
        &self,
        request: BrowserObserveRequest,
    ) -> Result<BrowserObservation, String> {
        self.ensure_connected()?;
        let (generation, endpoint, fallback_active) = self.connected_snapshot()?;
        let include_screenshot = request.operation == BrowserObserveOperation::Screenshot;
        let include_dom = request.operation == BrowserObserveOperation::Snapshot;
        let include_console = request.include_console.unwrap_or(false);
        let include_network = request.include_network.unwrap_or(false);
        self.apply_fingerprint_overrides(
            &endpoint,
            request.tab_id.as_deref().or(fallback_active.as_deref()),
        )
        .await?;
        let mut page = cdp::observe_page(
            &endpoint,
            request.tab_id.as_deref().or(fallback_active.as_deref()),
            include_dom,
            include_screenshot,
            include_console,
            include_network,
        )
        .await?;
        let status = self.refresh_tabs().await?;
        if !self.is_current_connected_generation(generation, &endpoint) {
            return Err("Browser is not connected".to_string());
        }
        let observed_tab_id = current_action_tab(
            &status.tabs,
            request.tab_id.as_deref().or(fallback_active.as_deref()),
        )
        .map(|tab| tab.id.clone());
        let observed_page_token = page.navigation_token.clone();
        let observation_token = self.next_observation_token();
        page.navigation_token = Some(observation_token.clone());
        for reference in &mut page.refs {
            reference.navigation_token = observation_token.clone();
        }
        {
            let mut state = self.inner.lock().expect("browser runtime lock");
            state.refs = page.refs.clone();
            state.observed_tab_id = observed_tab_id;
            state.observed_page_token = observed_page_token;
            state.observed_observation_token = Some(observation_token);
        }
        Ok(snapshot::page_observation(status, page))
    }

    pub async fn act(&self, request: BrowserActRequest) -> Result<BrowserActResult, String> {
        self.ensure_connected()?;
        let (generation, endpoint, fallback_active) = self.connected_snapshot()?;
        let refs = self
            .inner
            .lock()
            .expect("browser runtime lock")
            .refs
            .clone();
        let resolved_action = actions::resolve_ref_action(&request, &refs)?;
        let target_tab_id = request
            .tab_id
            .as_deref()
            .or(fallback_active.as_deref())
            .map(str::to_string);
        let status = self.refresh_tabs().await?;
        if !self.is_current_connected_generation(generation, &endpoint) {
            return Err("Browser is not connected".to_string());
        }
        validate_current_observation(
            &resolved_action,
            &status.tabs,
            target_tab_id.as_deref().or(status.active_tab_id.as_deref()),
            &self.observation_guard(),
        )?;
        self.apply_fingerprint_overrides(
            &endpoint,
            request.tab_id.as_deref().or(fallback_active.as_deref()),
        )
        .await?;
        cdp::dispatch_action(
            &endpoint,
            request.tab_id.as_deref().or(fallback_active.as_deref()),
            &request,
            resolved_action,
        )
        .await
    }

    fn connected_snapshot(&self) -> Result<(u64, BrowserEndpoint, Option<String>), String> {
        let state = self.inner.lock().expect("browser runtime lock");
        if state.status != BrowserStatusKind::Connected {
            return Err("Browser is not connected".to_string());
        }
        let endpoint = state
            .endpoint
            .clone()
            .ok_or_else(|| "Browser is not connected".to_string())?;
        Ok((
            state.lifecycle_generation,
            endpoint,
            state.active_tab_id.clone(),
        ))
    }

    fn endpoint(&self) -> Result<BrowserEndpoint, String> {
        let state = self.inner.lock().expect("browser runtime lock");
        if state.status != BrowserStatusKind::Connected {
            return Err("Browser is not connected".to_string());
        }

        state
            .endpoint
            .clone()
            .ok_or_else(|| "Browser is not connected".to_string())
    }

    fn ensure_connected(&self) -> Result<(), String> {
        if self.inner.lock().expect("browser runtime lock").status == BrowserStatusKind::Connected {
            Ok(())
        } else {
            Err("Browser is not connected".to_string())
        }
    }

    fn active_tab_id(&self) -> Option<String> {
        self.inner
            .lock()
            .expect("browser runtime lock")
            .active_tab_id
            .clone()
    }

    async fn apply_fingerprint_overrides(
        &self,
        endpoint: &BrowserEndpoint,
        tab_id: Option<&str>,
    ) -> Result<(), String> {
        let fingerprint = self
            .inner
            .lock()
            .expect("browser runtime lock")
            .fingerprint
            .clone();
        let Some(fingerprint) = fingerprint else {
            return Ok(());
        };
        cdp::apply_page_fingerprint_overrides(
            endpoint,
            tab_id,
            fingerprint.locale.as_deref(),
            fingerprint.timezone.as_deref(),
            fingerprint.stealth_script,
        )
        .await
    }

    fn begin_start(&self) -> u64 {
        self.begin_lifecycle_transition()
    }

    fn begin_lifecycle_transition(&self) -> u64 {
        let mut state = self.inner.lock().expect("browser runtime lock");
        state.lifecycle_generation = state.lifecycle_generation.saturating_add(1);
        state.status = BrowserStatusKind::Starting;
        state.error = None;
        state.endpoint = None;
        state.active_tab_id = None;
        state.tabs.clear();
        state.refs.clear();
        state.observed_tab_id = None;
        state.observed_page_token = None;
        state.observed_observation_token = None;
        state.lifecycle_generation
    }

    fn begin_unmanaged_connect(&self) -> (u64, Option<ManagedBrowserProcess>) {
        let mut state = self.inner.lock().expect("browser runtime lock");
        state.lifecycle_generation = state.lifecycle_generation.saturating_add(1);
        state.status = BrowserStatusKind::Starting;
        state.error = None;
        state.endpoint = None;
        state.active_tab_id = None;
        state.tabs.clear();
        state.refs.clear();
        state.observed_tab_id = None;
        state.observed_page_token = None;
        state.observed_observation_token = None;
        state.managed = false;
        let process = state.process.take();
        (state.lifecycle_generation, process)
    }

    fn is_current_lifecycle_generation(&self, generation: u64) -> bool {
        self.inner
            .lock()
            .expect("browser runtime lock")
            .lifecycle_generation
            == generation
    }

    fn is_current_connected_generation(&self, generation: u64, endpoint: &BrowserEndpoint) -> bool {
        let state = self.inner.lock().expect("browser runtime lock");
        state.lifecycle_generation == generation
            && state.endpoint.as_ref() == Some(endpoint)
            && state.status == BrowserStatusKind::Connected
    }

    fn set_error(&self, error: String) {
        let process = {
            let mut state = self.inner.lock().expect("browser runtime lock");
            state.status = BrowserStatusKind::Error;
            state.error = Some(redact_browser_endpoint_urls(&error));
            state.endpoint = None;
            state.tabs.clear();
            state.active_tab_id = None;
            let process = state.process.take();
            state.managed = false;
            state.refs.clear();
            state.observed_tab_id = None;
            state.observed_page_token = None;
            state.observed_observation_token = None;
            process
        };
        drop(process);
    }

    fn clear_observed_refs(&self) {
        let mut state = self.inner.lock().expect("browser runtime lock");
        state.refs.clear();
        state.observed_tab_id = None;
        state.observed_page_token = None;
        state.observed_observation_token = None;
    }

    fn next_observation_token(&self) -> String {
        let mut state = self.inner.lock().expect("browser runtime lock");
        state.observation_sequence = state.observation_sequence.saturating_add(1);
        format!("obs-{}", state.observation_sequence)
    }

    fn observation_guard(&self) -> ObservationGuard {
        let state = self.inner.lock().expect("browser runtime lock");
        ObservationGuard {
            tab_id: state.observed_tab_id.clone(),
            page_token: state.observed_page_token.clone(),
            observation_token: state.observed_observation_token.clone(),
        }
    }

    #[cfg(test)]
    fn begin_start_for_tests(&self) -> u64 {
        self.begin_start()
    }

    #[cfg(test)]
    fn set_connected_endpoint_for_tests(&self, endpoint: BrowserEndpoint) {
        let mut state = self.inner.lock().expect("browser runtime lock");
        state.endpoint = Some(endpoint);
        state.status = BrowserStatusKind::Connected;
        state.managed = false;
    }

    #[cfg(test)]
    fn endpoint_for_tests(&self) -> Result<BrowserEndpoint, String> {
        self.endpoint()
    }

    #[cfg(test)]
    fn is_current_lifecycle_generation_for_tests(&self, generation: u64) -> bool {
        self.is_current_lifecycle_generation(generation)
    }
}

async fn existing_session_from_endpoint(
    endpoint: BrowserEndpoint,
) -> Result<BrowserExistingSession, String> {
    let version = validate_cdp_version_endpoint(&endpoint).await?;
    let browser_name = version
        .browser
        .as_deref()
        .and_then(|value| value.split('/').next())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Browser")
        .to_string();
    let tabs = cdp::list_tabs(&endpoint, None).await?;
    let current = tabs.iter().find(|tab| tab.active).or_else(|| tabs.first());
    let current_url = current
        .map(|tab| tab.url.clone())
        .filter(|url| !url.is_empty());
    let title = current
        .map(|tab| tab.title.clone())
        .filter(|title| !title.is_empty());
    let location = current_url
        .as_deref()
        .and_then(|url| reqwest::Url::parse(url).ok())
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| endpoint.origin());

    Ok(BrowserExistingSession {
        id: format!("{}:{}", endpoint.host, endpoint.port),
        label: format!("{browser_name} - {location}"),
        endpoint: endpoint.origin(),
        browser_name,
        current_url,
        title,
        tabs,
    })
}

impl BrowserState {
    fn status(&self) -> BrowserStatus {
        let connected = self.status == BrowserStatusKind::Connected;
        BrowserStatus {
            status: self.status,
            managed: self.managed,
            active_tab_id: connected.then(|| self.active_tab_id.clone()).flatten(),
            tabs: if connected {
                self.tabs.clone()
            } else {
                Vec::new()
            },
            error: self.error.clone(),
        }
    }
}

async fn wait_for_endpoint(endpoint: &BrowserEndpoint) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    let mut last_error = None;
    while std::time::Instant::now() < deadline {
        match validate_cdp_version_endpoint(endpoint).await {
            Ok(_) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "Browser endpoint did not become ready".to_string()))
}

fn friendly_browser_start_error(error: &str) -> String {
    if error.contains("Failed to query browser endpoint")
        || error.contains("Browser endpoint did not become ready")
        || error.contains("Browser endpoint returned an error")
        || error.contains("Browser endpoint did not return valid /json/version")
        || error.contains("Browser endpoint did not expose webSocketDebuggerUrl")
    {
        return format!(
            "Browser launched but its local debugging endpoint did not respond. This is a local Chrome/Edge startup or CDP port readiness problem, not evidence of an external website/network fetch failure. Detail: {error}"
        );
    }

    error.to_string()
}

fn fingerprint_config_from_request(
    request: &BrowserStartRequest,
) -> Option<BrowserFingerprintRuntimeConfig> {
    if request.fingerprint_mode != Some(BrowserFingerprintMode::Balanced) {
        return None;
    }
    let locale = normalized_runtime_fingerprint_value(request.fingerprint_locale.as_deref());
    let timezone = normalized_runtime_fingerprint_value(request.fingerprint_timezone.as_deref());
    let stealth_script = request.fingerprint_stealth_script.unwrap_or(true);
    if locale.is_none() && timezone.is_none() && !stealth_script {
        return None;
    }
    Some(BrowserFingerprintRuntimeConfig {
        locale,
        timezone,
        stealth_script,
    })
}

fn normalized_runtime_fingerprint_value(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| !value.starts_with('-') && !value.contains('\0'))
        .map(str::to_string)
}

#[derive(Debug, Clone)]
struct ObservationGuard {
    tab_id: Option<String>,
    page_token: Option<String>,
    observation_token: Option<String>,
}

fn validate_current_observation(
    resolved_action: &actions::BrowserResolvedAction<'_>,
    tabs: &[BrowserTab],
    tab_id: Option<&str>,
    guard: &ObservationGuard,
) -> Result<(), String> {
    let Some(expected_token) = action_navigation_token(resolved_action) else {
        if resolved_action.requires_current_observation {
            let supplied = resolved_action
                .page_navigation_token
                .as_deref()
                .ok_or_else(|| {
                    "Browser action requires navigationToken from browser_observe".to_string()
                })?;
            let Some(tab) = current_action_tab(tabs, tab_id) else {
                return Ok(());
            };
            if guard.tab_id.as_deref() != Some(tab.id.as_str()) {
                return Err("Browser ref is stale; observe again before acting".to_string());
            }
            validate_stale_navigation_token(
                guard.page_token.as_deref().unwrap_or_default(),
                &tab.navigation_token,
            )?;
            return if guard.observation_token.as_deref() == Some(supplied) {
                Ok(())
            } else {
                Err("Browser ref is stale; observe again before acting".to_string())
            };
        }
        return Ok(());
    };
    let Some(tab) = current_action_tab(tabs, tab_id) else {
        return Ok(());
    };
    if guard.tab_id.as_deref() != Some(tab.id.as_str()) {
        return Err("Browser ref is stale; observe again before acting".to_string());
    }
    validate_stale_navigation_token(
        guard.page_token.as_deref().unwrap_or_default(),
        &tab.navigation_token,
    )?;
    if resolved_action
        .reference
        .is_some_and(|reference| reference.navigation_token == expected_token)
        || resolved_action
            .form_fields
            .iter()
            .any(|field| field.navigation_token == expected_token)
    {
        Ok(())
    } else {
        Err("Browser ref is stale; observe again before acting".to_string())
    }
}

fn action_navigation_token<'a>(
    resolved_action: &'a actions::BrowserResolvedAction<'_>,
) -> Option<&'a str> {
    resolved_action
        .reference
        .map(|reference| reference.navigation_token.as_str())
        .or_else(|| {
            resolved_action
                .form_fields
                .first()
                .map(|field| field.navigation_token.as_str())
        })
}

fn current_action_tab<'a>(tabs: &'a [BrowserTab], tab_id: Option<&str>) -> Option<&'a BrowserTab> {
    tab_id
        .and_then(|id| tabs.iter().find(|tab| tab.id == id))
        .or_else(|| tabs.iter().find(|tab| tab.active))
        .or_else(|| tabs.first())
}

fn redact_browser_endpoint_urls(input: &str) -> String {
    let mut output = input.to_string();
    for prefix in ["http://127.0.0.1:", "http://localhost:", "http://[::1]:"] {
        output = redact_urls_with_prefix(&output, prefix);
    }
    output
}

fn redact_urls_with_prefix(input: &str, prefix: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut remaining = input;
    while let Some(index) = remaining.find(prefix) {
        output.push_str(&remaining[..index]);
        output.push_str("[browser endpoint]");
        let after_prefix = &remaining[index + prefix.len()..];
        let consumed = after_prefix
            .char_indices()
            .find(|(_, character)| {
                character.is_whitespace() || matches!(character, '"' | '\'' | ')' | ']' | '}')
            })
            .map(|(offset, _)| offset)
            .unwrap_or(after_prefix.len());
        remaining = &after_prefix[consumed..];
    }
    output.push_str(remaining);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    // A failed browser start is the most common way this feature breaks, and the message is
    // what the user and the model see. It has to name the local cause, not suggest the site
    // was unreachable.

    // Error text reaches the logs and the model. A raw loopback endpoint in it leaks the CDP
    // port, which is enough for anything local to attach to the browser.

    fn tab(id: &str, active: bool) -> BrowserTab {
        BrowserTab {
            id: id.to_string(),
            url: "https://example.com".to_string(),
            title: "Example".to_string(),
            active,
            navigation_token: format!("nav-{id}"),
        }
    }

    #[test]
    fn user_does_not_see_a_loopback_endpoint_in_an_error_message() {
        let redacted = redact_browser_endpoint_urls(
            "Failed to query http://127.0.0.1:9222/json/version after 4s",
        );

        assert!(!redacted.contains("9222"), "port leaked: {redacted}");
        assert!(redacted.contains("[browser endpoint]"));
        assert!(redacted.ends_with("after 4s"));
    }

    #[test]
    fn user_does_not_see_a_localhost_endpoint_in_an_error_message() {
        let redacted = redact_browser_endpoint_urls("connect to http://localhost:9333 failed");

        assert!(!redacted.contains("9333"), "port leaked: {redacted}");
    }

    #[test]
    fn user_does_not_see_an_ipv6_loopback_endpoint_in_an_error_message() {
        let redacted = redact_browser_endpoint_urls("connect to http://[::1]:9222 failed");

        assert!(!redacted.contains("9222"), "port leaked: {redacted}");
    }

    #[test]
    fn user_gets_every_endpoint_redacted_when_several_appear() {
        let redacted = redact_browser_endpoint_urls(
            "http://127.0.0.1:9222 and http://localhost:9333 both failed",
        );

        assert!(!redacted.contains("9222"));
        assert!(!redacted.contains("9333"));
        assert_eq!(redacted.matches("[browser endpoint]").count(), 2);
    }

    #[test]
    fn user_gets_an_endpoint_redacted_up_to_its_delimiter() {
        let redacted = redact_browser_endpoint_urls("(http://127.0.0.1:9222)");

        assert_eq!(redacted, "([browser endpoint])");
    }

    #[test]
    fn user_gets_a_message_without_an_endpoint_left_exactly_as_it_was() {
        let message = "Browser endpoint did not become ready";

        assert_eq!(redact_browser_endpoint_urls(message), message);
    }

    #[test]
    fn user_gets_the_referenced_tab_chosen_for_an_action() {
        let tabs = vec![tab("t1", false), tab("t2", true)];

        let chosen = current_action_tab(&tabs, Some("t1")).expect("the named tab wins");

        assert_eq!(chosen.id, "t1");
    }

    #[test]
    fn user_gets_the_active_tab_when_no_tab_was_named() {
        let tabs = vec![tab("t1", false), tab("t2", true)];

        let chosen = current_action_tab(&tabs, None).expect("the active tab is used");

        assert_eq!(chosen.id, "t2");
    }

    #[test]
    fn user_gets_the_first_tab_when_none_is_marked_active() {
        let tabs = vec![tab("t1", false), tab("t2", false)];

        let chosen = current_action_tab(&tabs, None).expect("the first tab is a fallback");

        assert_eq!(chosen.id, "t1");
    }

    #[test]
    fn user_gets_no_tab_when_the_browser_has_none() {
        assert!(current_action_tab(&[], None).is_none());
    }

    #[test]
    fn user_gets_the_reference_token_preferred_for_an_action() {
        let reference = crate::core::browser::types::BrowserDomRef {
            ref_id: "ref-0".to_string(),
            navigation_token: "nav-ref".to_string(),
            description: "button".to_string(),
            editable: false,
            selector: "#a".to_string(),
            x: 0.0,
            y: 0.0,
        };
        let resolved = actions::BrowserResolvedAction {
            reference: Some(&reference),
            form_fields: vec![actions::BrowserResolvedFormField {
                navigation_token: "nav-field".to_string(),
                selector: "#b".to_string(),
                value: "v".to_string(),
            }],
            page_navigation_token: None,
            requires_current_observation: false,
        };

        assert_eq!(action_navigation_token(&resolved), Some("nav-ref"));
    }

    #[test]
    fn user_gets_the_form_field_token_when_there_is_no_reference() {
        let resolved = actions::BrowserResolvedAction {
            reference: None,
            form_fields: vec![actions::BrowserResolvedFormField {
                navigation_token: "nav-field".to_string(),
                selector: "#b".to_string(),
                value: "v".to_string(),
            }],
            page_navigation_token: None,
            requires_current_observation: false,
        };

        assert_eq!(action_navigation_token(&resolved), Some("nav-field"));
    }

    #[test]
    fn user_gets_no_token_for_an_action_with_neither() {
        let resolved = actions::BrowserResolvedAction {
            reference: None,
            form_fields: Vec::new(),
            page_navigation_token: None,
            requires_current_observation: false,
        };

        assert_eq!(action_navigation_token(&resolved), None);
    }

    #[test]
    fn user_is_told_a_cdp_readiness_problem_is_local_when_the_endpoint_did_not_answer() {
        let friendly =
            friendly_browser_start_error("Failed to query browser endpoint: connection refused");

        assert!(friendly.contains("local Chrome/Edge startup"));
        assert!(friendly.contains("not evidence of an external website"));
    }

    #[test]
    fn user_is_told_a_cdp_readiness_problem_is_local_when_the_endpoint_never_became_ready() {
        let friendly = friendly_browser_start_error("Browser endpoint did not become ready");

        assert!(friendly.contains("local Chrome/Edge startup"));
    }

    #[test]
    fn user_is_told_a_cdp_readiness_problem_is_local_when_the_version_payload_was_wrong() {
        let friendly =
            friendly_browser_start_error("Browser endpoint did not return valid /json/version");

        assert!(friendly.contains("local Chrome/Edge startup"));
    }

    #[test]
    fn user_is_told_a_cdp_readiness_problem_is_local_when_no_websocket_was_exposed() {
        let friendly =
            friendly_browser_start_error("Browser endpoint did not expose webSocketDebuggerUrl");

        assert!(friendly.contains("local Chrome/Edge startup"));
    }

    #[test]
    fn user_gets_an_unrelated_error_left_as_it_was() {
        // A missing executable is not a CDP problem and must not be described as one.
        let friendly = friendly_browser_start_error("Failed to spawn browser process");

        assert_eq!(friendly, "Failed to spawn browser process");
    }

    #[test]
    fn user_gets_the_original_detail_appended_to_a_readiness_message() {
        let friendly = friendly_browser_start_error("Browser endpoint returned an error: 500");

        assert!(friendly.ends_with("Detail: Browser endpoint returned an error: 500"));
    }

    #[test]
    fn user_gets_no_fingerprint_configuration_when_the_mode_is_off() {
        let request = BrowserStartRequest {
            fingerprint_mode: Some(BrowserFingerprintMode::Off),
            fingerprint_locale: Some("en-US".to_string()),
            ..Default::default()
        };

        assert!(fingerprint_config_from_request(&request).is_none());
    }

    #[test]
    fn user_gets_a_dash_prefixed_locale_dropped_from_the_fingerprint_config() {
        let request = BrowserStartRequest {
            fingerprint_mode: Some(BrowserFingerprintMode::Balanced),
            fingerprint_locale: Some("--headless".to_string()),
            fingerprint_stealth_script: Some(true),
            ..Default::default()
        };

        let config = fingerprint_config_from_request(&request).expect("stealth keeps a config");

        assert_eq!(config.locale, None);
        assert!(config.stealth_script);
    }

    #[test]
    fn user_gets_a_locale_containing_a_nul_dropped_from_the_fingerprint_config() {
        let request = BrowserStartRequest {
            fingerprint_mode: Some(BrowserFingerprintMode::Balanced),
            fingerprint_locale: Some("a\u{0000}b".to_string()),
            fingerprint_stealth_script: Some(true),
            ..Default::default()
        };

        let config = fingerprint_config_from_request(&request).expect("stealth keeps a config");

        assert_eq!(config.locale, None);
    }

    #[test]
    fn user_gets_a_plain_locale_trimmed_in_the_fingerprint_config() {
        let request = BrowserStartRequest {
            fingerprint_mode: Some(BrowserFingerprintMode::Balanced),
            fingerprint_locale: Some("  en-US  ".to_string()),
            fingerprint_stealth_script: Some(true),
            ..Default::default()
        };

        let config = fingerprint_config_from_request(&request).expect("a config is built");

        assert_eq!(config.locale.as_deref(), Some("en-US"));
    }

    #[test]
    fn stop_invalidates_in_flight_start_generation() {
        let runtime = BrowserRuntime::new();

        let generation = runtime.begin_start_for_tests();
        runtime.stop();

        assert!(!runtime.is_current_lifecycle_generation_for_tests(generation));
        assert_eq!(runtime.status().status, BrowserStatusKind::Idle);
    }

    #[test]
    fn endpoint_is_not_available_during_lifecycle_transition() {
        let runtime = BrowserRuntime::new();
        runtime.set_connected_endpoint_for_tests(BrowserEndpoint {
            host: "127.0.0.1".to_string(),
            port: 9222,
        });

        runtime.begin_start_for_tests();

        assert_eq!(
            runtime
                .endpoint_for_tests()
                .expect_err("starting state must not expose stale endpoint"),
            "Browser is not connected"
        );
    }

    #[test]
    fn status_does_not_expose_endpoint_or_tabs_during_lifecycle_transition() {
        let runtime = BrowserRuntime::new();
        runtime.set_connected_endpoint_for_tests(BrowserEndpoint {
            host: "127.0.0.1".to_string(),
            port: 9222,
        });

        runtime.begin_start_for_tests();
        let status = runtime.status();

        assert_eq!(status.status, BrowserStatusKind::Starting);
        assert_eq!(status.active_tab_id, None);
        assert!(status.tabs.is_empty());
    }

    #[test]
    fn observe_operation_deserialization_is_fail_closed() {
        let missing_operation_error =
            serde_json::from_value::<BrowserObserveRequest>(serde_json::json!({}))
                .expect_err("missing operation");
        assert!(
            missing_operation_error
                .to_string()
                .contains("missing field `operation`"),
            "unexpected missing operation error: {missing_operation_error}"
        );

        let unsupported_operation_error =
            serde_json::from_value::<BrowserObserveRequest>(serde_json::json!({
                "operation": "console"
            }))
            .expect_err("unsupported operation");
        assert!(
            unsupported_operation_error
                .to_string()
                .contains("unknown variant `console`"),
            "unexpected unsupported operation error: {unsupported_operation_error}"
        );

        assert!(
            serde_json::from_value::<BrowserObserveRequest>(serde_json::json!({
                "operation": "state"
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<BrowserObserveRequest>(serde_json::json!({
                "operation": "snapshot"
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<BrowserObserveRequest>(serde_json::json!({
                "operation": "screenshot"
            }))
            .is_ok()
        );
    }

    #[test]
    fn page_actions_require_current_observe_navigation_token() {
        let tabs = vec![BrowserTab {
            id: "tab-1".to_string(),
            url: "https://example.test".to_string(),
            title: "Example".to_string(),
            active: true,
            navigation_token: "nav-current".to_string(),
        }];
        let guard = ObservationGuard {
            tab_id: Some("tab-1".to_string()),
            page_token: Some("nav-current".to_string()),
            observation_token: Some("obs-current".to_string()),
        };
        let action_without_token = actions::BrowserResolvedAction {
            reference: None,
            form_fields: Vec::new(),
            page_navigation_token: None,
            requires_current_observation: true,
        };

        assert_eq!(
            validate_current_observation(&action_without_token, &tabs, Some("tab-1"), &guard)
                .expect_err("missing page token"),
            "Browser action requires navigationToken from browser_observe"
        );

        let stale_action = actions::BrowserResolvedAction {
            reference: None,
            form_fields: Vec::new(),
            page_navigation_token: Some("obs-old".to_string()),
            requires_current_observation: true,
        };
        assert_eq!(
            validate_current_observation(&stale_action, &tabs, Some("tab-1"), &guard)
                .expect_err("stale page token"),
            "Browser ref is stale; observe again before acting"
        );

        let valid_action = actions::BrowserResolvedAction {
            reference: None,
            form_fields: Vec::new(),
            page_navigation_token: Some("obs-current".to_string()),
            requires_current_observation: true,
        };
        assert!(validate_current_observation(&valid_action, &tabs, Some("tab-1"), &guard).is_ok());
    }

    #[test]
    fn error_status_redacts_loopback_browser_endpoint_urls() {
        let runtime = BrowserRuntime::new();

        runtime.set_error(
            "Failed to query browser endpoint: http://127.0.0.1:50123/json/version failed"
                .to_string(),
        );

        let status = runtime.status();
        let error = status.error.expect("redacted error");
        assert!(error.contains("[browser endpoint]"));
        assert!(!error.contains("127.0.0.1"));
        assert!(!error.contains("50123"));
        assert!(!error.contains("/json/version"));
    }

    #[test]
    fn browser_endpoint_startup_errors_explain_local_cdp_readiness() {
        let error =
            friendly_browser_start_error("Failed to query browser endpoint: connection refused");

        assert!(error.contains("Browser launched but its local debugging endpoint did not respond"));
        assert!(error.contains("local Chrome/Edge startup"));
        assert!(error.contains("connection refused"));
        assert!(!error.contains("browser management service"));
    }

    #[test]
    fn balanced_fingerprint_keeps_stealth_script_when_fields_are_empty() {
        let request = BrowserStartRequest {
            fingerprint_mode: Some(BrowserFingerprintMode::Balanced),
            fingerprint_locale: Some("   ".to_string()),
            fingerprint_timezone: None,
            fingerprint_stealth_script: Some(true),
            ..Default::default()
        };

        let fingerprint = fingerprint_config_from_request(&request).expect("stealth script config");

        assert_eq!(fingerprint.locale, None);
        assert_eq!(fingerprint.timezone, None);
        assert!(fingerprint.stealth_script);
    }

    #[test]
    fn balanced_fingerprint_skips_empty_fields_when_stealth_script_is_disabled() {
        let request = BrowserStartRequest {
            fingerprint_mode: Some(BrowserFingerprintMode::Balanced),
            fingerprint_locale: Some("   ".to_string()),
            fingerprint_timezone: None,
            fingerprint_stealth_script: Some(false),
            ..Default::default()
        };

        assert!(fingerprint_config_from_request(&request).is_none());
    }
}
