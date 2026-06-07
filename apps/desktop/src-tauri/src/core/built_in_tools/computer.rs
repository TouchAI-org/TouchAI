// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

//! Native computer-use runtime.
//!
//! This module intentionally owns the policy and receipt boundary for desktop
//! actions. External CUA or vision providers may later add target candidates,
//! but they should not bypass this runtime's validation and audit shape.

use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::{Duration, Instant},
};

use super::types::{
    ComputerActionOperation, ComputerActionRequest, ComputerActionResponse, ComputerActionStatus,
    ComputerBackgroundCapability, ComputerBounds, ComputerCapabilitySnapshot,
    ComputerDisplaySnapshot, ComputerElementSnapshot, ComputerExecutionMode,
    ComputerGroundingCapability, ComputerLane, ComputerObservationInclude, ComputerObservationMode,
    ComputerObservationRequest, ComputerObservationResponse, ComputerObservationTree,
    ComputerResolvedTarget, ComputerRoute, ComputerScreenshotSnapshot, ComputerSessionRequest,
    ComputerSessionResponse, ComputerSessionStatus, ComputerTarget, ComputerWindowSnapshot,
};

const PROVIDER_CUA: &str = "cua";
const PROVIDER_OMNIPARSER: &str = "omniparser";
const PROVIDER_UI_TARS: &str = "ui_tars";

#[derive(Debug, Clone)]
struct ComputerSessionState {
    target: ComputerTarget,
    capabilities: ComputerCapabilitySnapshot,
    observed_native_ids: HashSet<String>,
    created_at: Instant,
}

#[derive(Default)]
struct ComputerUseRuntimeState {
    sessions: HashMap<String, ComputerSessionState>,
    next_observation_id: u64,
    next_action_id: u64,
}

/// Runtime state for native computer-use calls.
pub struct ComputerUseRuntime {
    state: Mutex<ComputerUseRuntimeState>,
    action_lock: Mutex<()>,
}

impl ComputerUseRuntime {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(ComputerUseRuntimeState::default()),
            action_lock: Mutex::new(()),
        }
    }

    pub fn start_session(
        &self,
        request: ComputerSessionRequest,
    ) -> Result<ComputerSessionResponse, String> {
        validate_non_empty("sessionId", &request.session_id)?;
        validate_non_empty("reason", &request.reason)?;

        let capabilities = platform_capabilities();
        let status = if capabilities
            .routes
            .iter()
            .any(|route| route == &ComputerRoute::Unsupported)
        {
            ComputerSessionStatus::Unsupported
        } else {
            ComputerSessionStatus::Ready
        };
        let mut warnings = Vec::new();
        if status == ComputerSessionStatus::Unsupported {
            warnings.push("Computer use is not implemented on this platform yet.".to_string());
        }
        if request.provider_hints.iter().any(|hint| {
            matches!(
                hint.as_str(),
                PROVIDER_CUA | PROVIDER_OMNIPARSER | PROVIDER_UI_TARS
            )
        }) {
            warnings.push(
                "External grounding providers are adapter hooks only and are not bundled."
                    .to_string(),
            );
        }

        let mut state = self
            .state
            .lock()
            .map_err(|_| "ComputerUseRuntime state lock poisoned".to_string())?;
        state.sessions.insert(
            request.session_id.clone(),
            ComputerSessionState {
                observed_native_ids: HashSet::new(),
                target: request.target.clone(),
                capabilities: capabilities.clone(),
                created_at: Instant::now(),
            },
        );

        Ok(ComputerSessionResponse {
            session_id: request.session_id,
            status,
            capabilities,
            target: request.target,
            warnings,
        })
    }

    pub fn observe(
        &self,
        request: ComputerObservationRequest,
    ) -> Result<ComputerObservationResponse, String> {
        validate_non_empty("sessionId", &request.session_id)?;
        validate_non_empty("reason", &request.reason)?;

        let (session_target, session_age_warning, observation_id) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "ComputerUseRuntime state lock poisoned".to_string())?;
            let (target, warning) = {
                let session = state.sessions.get(&request.session_id).ok_or_else(|| {
                    format!("computer session '{}' was not found", request.session_id)
                })?;
                let warning = if session.created_at.elapsed() > Duration::from_secs(10 * 60) {
                    Some(
                        "Computer session is older than 10 minutes; refresh if grounding looks stale.",
                    )
                } else {
                    None
                };

                (session.target.clone(), warning.map(str::to_string))
            };
            state.next_observation_id += 1;
            (
                target,
                warning,
                format!("obs-{}", state.next_observation_id),
            )
        };

        let target = merge_target(session_target, request.target);
        let displays = observe_displays();
        let windows = observe_windows();
        let include_tree = request.include.contains(&ComputerObservationInclude::Tree)
            || matches!(
                &request.mode,
                ComputerObservationMode::Tree | ComputerObservationMode::TreeAndScreenshot
            );
        let include_screenshot = request
            .include
            .contains(&ComputerObservationInclude::Screenshot)
            || matches!(
                &request.mode,
                ComputerObservationMode::Screenshot | ComputerObservationMode::TreeAndScreenshot
            );
        let tree = include_tree.then(|| build_tree(&windows));
        let screenshot = include_screenshot.then(|| build_screenshot_placeholder(&displays));
        let observed_native_ids = collect_observation_native_ids(&windows, tree.as_ref());
        let mut warnings = Vec::new();
        if let Some(warning) = session_age_warning {
            warnings.push(warning);
        }
        if include_screenshot {
            warnings.push(
                "Screenshot payload is represented as metadata; image materialization is adapter-scoped."
                    .to_string(),
            );
        }

        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "ComputerUseRuntime state lock poisoned".to_string())?;
            if let Some(session) = state.sessions.get_mut(&request.session_id) {
                session.observed_native_ids.extend(observed_native_ids);
            }
        }

        Ok(ComputerObservationResponse {
            observation_id,
            session_id: request.session_id,
            platform: platform_name().to_string(),
            target,
            displays,
            windows,
            tree,
            screenshot,
            warnings,
        })
    }

    pub fn act(&self, request: ComputerActionRequest) -> Result<ComputerActionResponse, String> {
        validate_non_empty("sessionId", &request.session_id)?;
        validate_non_empty("reason", &request.reason)?;
        validate_operation(&request.operation, request.value.as_deref())?;
        validate_target_shape(&request.target)?;

        let _guard = self
            .action_lock
            .lock()
            .map_err(|_| "ComputerUseRuntime action lock poisoned".to_string())?;

        let (capabilities, observed_native_ids) = {
            let state = self
                .state
                .lock()
                .map_err(|_| "ComputerUseRuntime state lock poisoned".to_string())?;
            state
                .sessions
                .get(&request.session_id)
                .map(|session| {
                    (
                        session.capabilities.clone(),
                        session.observed_native_ids.clone(),
                    )
                })
                .ok_or_else(|| format!("computer session '{}' was not found", request.session_id))?
        };

        let route = resolve_route(&request)?;
        let mut normalized_target = NormalizedTarget::from(&request.target);
        let lane = resolve_lane(&normalized_target);
        let background_safe = request.execution_mode == ComputerExecutionMode::Background
            && route == ComputerRoute::Win32Message;

        if route == ComputerRoute::Win32Message
            && request.execution_mode != ComputerExecutionMode::Background
        {
            return Ok(self.action_response(
                request,
                route,
                lane,
                background_safe,
                false,
                false,
                normalized_target.resolved(),
                ComputerActionStatus::Blocked,
                vec!["route 'win32.message' requires background execution".to_string()],
            )?);
        }
        if route == ComputerRoute::Win32Message && !request.options.allow_background {
            return Ok(self.action_response(
                request,
                route,
                lane,
                background_safe,
                false,
                false,
                normalized_target.resolved(),
                ComputerActionStatus::Blocked,
                vec!["route 'win32.message' requires allowBackground=true".to_string()],
            )?);
        }
        if route == ComputerRoute::Win32SendInput
            && request.execution_mode == ComputerExecutionMode::Background
        {
            return Ok(self.action_response(
                request,
                route,
                lane,
                background_safe,
                false,
                false,
                normalized_target.resolved(),
                ComputerActionStatus::Blocked,
                vec!["route 'win32.send_input' cannot execute in background mode".to_string()],
            )?);
        }
        if route == ComputerRoute::ScreenCapture {
            return Ok(self.action_response(
                request,
                route,
                lane,
                background_safe,
                false,
                false,
                normalized_target.resolved(),
                ComputerActionStatus::Blocked,
                vec!["route 'screen.capture' cannot execute computer actions".to_string()],
            )?);
        }
        if route == ComputerRoute::Unsupported {
            return Ok(self.action_response(
                request,
                route,
                lane,
                background_safe,
                false,
                false,
                normalized_target.resolved(),
                ComputerActionStatus::Unsupported,
                vec!["computer action route is unsupported on this platform".to_string()],
            )?);
        }
        if !capabilities
            .routes
            .iter()
            .any(|candidate| candidate == &route)
        {
            return Ok(self.action_response(
                request,
                route.clone(),
                lane,
                background_safe,
                false,
                false,
                normalized_target.resolved(),
                ComputerActionStatus::Unsupported,
                vec![format!(
                    "route '{}' is not available for this session",
                    route_label(&route)
                )],
            )?);
        }

        if request.execution_mode == ComputerExecutionMode::Background
            && normalized_target.has_coordinates()
        {
            return Ok(self.action_response(
                request,
                route,
                lane,
                background_safe,
                false,
                false,
                normalized_target.resolved(),
                ComputerActionStatus::Blocked,
                vec!["coordinate targets cannot be executed in background mode".to_string()],
            )?);
        }
        if request.execution_mode == ComputerExecutionMode::Background
            && !normalized_target.has_native_reference()
        {
            return Ok(self.action_response(
                request,
                route,
                lane,
                background_safe,
                false,
                false,
                normalized_target.resolved(),
                ComputerActionStatus::Blocked,
                vec![
                    "background execution requires a native windowId or elementId target"
                        .to_string(),
                ],
            )?);
        }
        if normalized_target.has_native_reference()
            && !normalized_target
                .native_references()
                .iter()
                .any(|native_id| observed_native_ids.contains(*native_id))
        {
            return Ok(self.action_response(
                request,
                route,
                lane,
                background_safe,
                false,
                false,
                normalized_target.resolved(),
                ComputerActionStatus::Blocked,
                vec!["native target was not observed in this computer session".to_string()],
            )?);
        }
        if normalized_target.has_native_reference() {
            match resolve_native_target_coordinates(&normalized_target) {
                Ok(resolved_target) => normalized_target = resolved_target,
                Err(error) => {
                    return Ok(self.action_response(
                        request,
                        route,
                        lane,
                        background_safe,
                        false,
                        false,
                        normalized_target.resolved(),
                        ComputerActionStatus::Blocked,
                        vec![error],
                    )?);
                }
            }
        }

        if lane == ComputerLane::Unsupported && request.operation != ComputerActionOperation::Wait {
            return Ok(self.action_response(
                request,
                route,
                lane,
                background_safe,
                false,
                false,
                normalized_target.resolved(),
                ComputerActionStatus::Blocked,
                vec!["computer action target could not be resolved".to_string()],
            )?);
        }

        let dry_run = request.options.dry_run;
        let mut warnings = Vec::new();
        let mut cursor_moved = false;
        let mut foreground_changed = false;
        let mut status = ComputerActionStatus::Success;

        if dry_run {
            warnings.push("dryRun=true: action was validated but not executed.".to_string());
        } else if request.operation == ComputerActionOperation::Wait {
            std::thread::sleep(Duration::from_millis(request.timeout_ms.min(2_000)));
        } else if let Err(error) = execute_native_action(&request, &normalized_target, &route) {
            status = ComputerActionStatus::Error;
            warnings.push(format!(
                "Failed to execute computer action '{}': {error}",
                operation_label(&request.operation)
            ));
        } else {
            cursor_moved =
                route == ComputerRoute::Win32SendInput && is_pointer_operation(&request.operation);
            foreground_changed = request.execution_mode == ComputerExecutionMode::Foreground
                && route == ComputerRoute::Win32SendInput;
            if route == ComputerRoute::Win32Message {
                warnings.push(
                    "win32.message queued input messages; target handling is not confirmed."
                        .to_string(),
                );
            }
        }

        self.action_response(
            request,
            route,
            lane,
            background_safe,
            cursor_moved,
            foreground_changed,
            normalized_target.resolved(),
            status,
            warnings,
        )
    }

    fn next_action_id(&self) -> Result<String, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "ComputerUseRuntime state lock poisoned".to_string())?;
        state.next_action_id += 1;
        Ok(format!("act-{}", state.next_action_id))
    }

    fn action_response(
        &self,
        request: ComputerActionRequest,
        route: ComputerRoute,
        lane: ComputerLane,
        background_safe: bool,
        cursor_moved: bool,
        foreground_changed: bool,
        target_resolved: ComputerResolvedTarget,
        status: ComputerActionStatus,
        warnings: Vec<String>,
    ) -> Result<ComputerActionResponse, String> {
        let post_action_observation = if status == ComputerActionStatus::Success
            && request.options.post_action_observe
            && !request.options.dry_run
        {
            Some(self.build_post_action_observation(&request.session_id)?)
        } else {
            None
        };

        Ok(ComputerActionResponse {
            action_id: self.next_action_id()?,
            session_id: request.session_id,
            operation: request.operation,
            route,
            lane,
            background_safe,
            cursor_moved,
            foreground_changed,
            target_resolved,
            status,
            warnings,
            post_action_observation,
        })
    }

    fn build_post_action_observation(
        &self,
        session_id: &str,
    ) -> Result<ComputerObservationResponse, String> {
        let (session_target, session_age_warning, observation_id) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "ComputerUseRuntime state lock poisoned".to_string())?;
            let (target, warning) = {
                let session = state
                    .sessions
                    .get(session_id)
                    .ok_or_else(|| format!("computer session '{session_id}' was not found"))?;
                let warning = if session.created_at.elapsed() > Duration::from_secs(10 * 60) {
                    Some(
                        "Computer session is older than 10 minutes; refresh if grounding looks stale.",
                    )
                } else {
                    None
                };

                (session.target.clone(), warning.map(str::to_string))
            };
            state.next_observation_id += 1;
            (
                target,
                warning,
                format!("obs-{}", state.next_observation_id),
            )
        };

        let displays = observe_displays();
        let windows = observe_windows();
        let tree = Some(build_tree(&windows));
        let observed_native_ids = collect_observation_native_ids(&windows, tree.as_ref());
        let mut warnings = Vec::new();
        if let Some(warning) = session_age_warning {
            warnings.push(warning);
        }

        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "ComputerUseRuntime state lock poisoned".to_string())?;
            if let Some(session) = state.sessions.get_mut(session_id) {
                session.observed_native_ids.extend(observed_native_ids);
            }
        }

        Ok(ComputerObservationResponse {
            observation_id,
            session_id: session_id.to_string(),
            platform: platform_name().to_string(),
            target: session_target,
            displays,
            windows,
            tree,
            screenshot: None,
            warnings,
        })
    }
}

impl Default for ComputerUseRuntime {
    fn default() -> Self {
        Self::new()
    }
}

pub type ComputerRuntime = ComputerUseRuntime;

pub fn computer_session(
    request: ComputerSessionRequest,
    runtime: &ComputerRuntime,
) -> Result<ComputerSessionResponse, String> {
    runtime.start_session(request)
}

pub fn computer_observe(
    request: ComputerObservationRequest,
    runtime: &ComputerRuntime,
) -> Result<ComputerObservationResponse, String> {
    runtime.observe(request)
}

pub fn computer_act(
    request: ComputerActionRequest,
    runtime: &ComputerRuntime,
) -> Result<ComputerActionResponse, String> {
    runtime.act(request)
}

fn validate_non_empty(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    Ok(())
}

fn validate_operation(
    operation: &ComputerActionOperation,
    value: Option<&str>,
) -> Result<(), String> {
    match operation {
        ComputerActionOperation::Click
        | ComputerActionOperation::DoubleClick
        | ComputerActionOperation::RightClick
        | ComputerActionOperation::Move
        | ComputerActionOperation::Drag
        | ComputerActionOperation::Scroll
        | ComputerActionOperation::Wait => Ok(()),
        ComputerActionOperation::TypeText if value.is_some_and(|text| !text.is_empty()) => Ok(()),
        ComputerActionOperation::TypeText => Err("value is required for type_text".to_string()),
        ComputerActionOperation::PressKey | ComputerActionOperation::Hotkey
            if value.is_some_and(|text| !text.is_empty()) =>
        {
            Ok(())
        }
        ComputerActionOperation::PressKey | ComputerActionOperation::Hotkey => Err(format!(
            "value is required for {}",
            operation_label(operation)
        )),
    }
}

fn validate_target_shape(target: &ComputerTarget) -> Result<(), String> {
    if target.x.is_some() != target.y.is_some() {
        return Err("target.x and target.y must be provided together".to_string());
    }
    if target.width.is_some() != target.height.is_some() {
        return Err("target.width and target.height must be provided together".to_string());
    }
    if let Some(coordinates) = target.coordinates.as_ref() {
        if coordinates.width.is_some() != coordinates.height.is_some() {
            return Err(
                "target.coordinates.width and target.coordinates.height must be provided together"
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn resolve_route(request: &ComputerActionRequest) -> Result<ComputerRoute, String> {
    if request.route_hint != ComputerRoute::Auto {
        return Ok(request.route_hint.clone());
    }
    if request.execution_mode == ComputerExecutionMode::Background {
        return Ok(ComputerRoute::Win32Message);
    }
    Ok(ComputerRoute::Win32SendInput)
}

fn route_label(route: &ComputerRoute) -> &'static str {
    match route {
        ComputerRoute::Auto => "auto",
        ComputerRoute::Win32SendInput => "win32.send_input",
        ComputerRoute::Win32Message => "win32.message",
        ComputerRoute::ScreenCapture => "screen.capture",
        ComputerRoute::Unsupported => "unsupported",
    }
}

fn operation_label(operation: &ComputerActionOperation) -> &'static str {
    match operation {
        ComputerActionOperation::Click => "click",
        ComputerActionOperation::DoubleClick => "double_click",
        ComputerActionOperation::RightClick => "right_click",
        ComputerActionOperation::Move => "move",
        ComputerActionOperation::Drag => "drag",
        ComputerActionOperation::Scroll => "scroll",
        ComputerActionOperation::TypeText => "type_text",
        ComputerActionOperation::PressKey => "press_key",
        ComputerActionOperation::Hotkey => "hotkey",
        ComputerActionOperation::Wait => "wait",
    }
}

fn is_pointer_operation(operation: &ComputerActionOperation) -> bool {
    matches!(
        operation,
        ComputerActionOperation::Click
            | ComputerActionOperation::DoubleClick
            | ComputerActionOperation::RightClick
            | ComputerActionOperation::Move
            | ComputerActionOperation::Drag
    )
}

fn resolve_lane(target: &NormalizedTarget) -> ComputerLane {
    if target.has_native_reference() {
        ComputerLane::NativeTree
    } else if target.has_coordinates() {
        ComputerLane::VisionFallback
    } else {
        ComputerLane::Unsupported
    }
}

fn merge_target(session_target: ComputerTarget, request_target: ComputerTarget) -> ComputerTarget {
    if request_target.scope.is_none()
        && request_target.label.is_none()
        && request_target.window_id.is_none()
        && request_target.element_id.is_none()
        && request_target.x.is_none()
        && request_target.coordinates.is_none()
        && request_target.window.is_none()
        && request_target.element.is_none()
    {
        return session_target;
    }
    request_target
}

#[derive(Debug, Clone)]
struct NormalizedTarget {
    x: Option<i32>,
    y: Option<i32>,
    element_id: Option<String>,
    window_id: Option<String>,
}

impl NormalizedTarget {
    fn from(target: &ComputerTarget) -> Self {
        Self {
            x: target
                .x
                .or_else(|| target.coordinates.as_ref().map(|coords| coords.x)),
            y: target
                .y
                .or_else(|| target.coordinates.as_ref().map(|coords| coords.y)),
            element_id: target.element_id.clone().or_else(|| {
                target
                    .element
                    .as_ref()
                    .and_then(|element| element.id.clone())
            }),
            window_id: target
                .window_id
                .clone()
                .or_else(|| target.window.as_ref().and_then(|window| window.id.clone())),
        }
    }

    fn has_coordinates(&self) -> bool {
        self.x.is_some() && self.y.is_some()
    }

    fn has_native_reference(&self) -> bool {
        self.element_id.is_some() || self.window_id.is_some()
    }

    fn native_references(&self) -> Vec<&str> {
        [self.element_id.as_deref(), self.window_id.as_deref()]
            .into_iter()
            .flatten()
            .collect()
    }

    fn window_message_target_id(&self) -> Option<&str> {
        self.window_id.as_deref().or(self.element_id.as_deref())
    }

    fn resolved(&self) -> ComputerResolvedTarget {
        ComputerResolvedTarget {
            x: self.x,
            y: self.y,
            element_id: self.element_id.clone(),
            window_id: self.window_id.clone(),
            confidence: if self.has_native_reference() || self.has_coordinates() {
                1.0
            } else {
                0.0
            },
        }
    }
}

fn collect_observation_native_ids(
    windows: &[ComputerWindowSnapshot],
    tree: Option<&ComputerObservationTree>,
) -> HashSet<String> {
    let mut native_ids: HashSet<String> = windows
        .iter()
        .map(|window| window.element_id.clone())
        .collect();

    if let Some(tree) = tree {
        for element in &tree.elements {
            collect_element_native_ids(element, &mut native_ids);
        }
    }

    native_ids
}

fn collect_element_native_ids(element: &ComputerElementSnapshot, native_ids: &mut HashSet<String>) {
    native_ids.insert(element.element_id.clone());
    for child in &element.children {
        collect_element_native_ids(child, native_ids);
    }
}

fn resolve_native_target_coordinates(
    target: &NormalizedTarget,
) -> Result<NormalizedTarget, String> {
    let Some(native_id) = target.window_message_target_id() else {
        return Ok(target.clone());
    };

    let (x, y) = resolve_native_window_center(native_id)?;
    let mut resolved = target.clone();
    if resolved.x.is_none() {
        resolved.x = Some(x);
    }
    if resolved.y.is_none() {
        resolved.y = Some(y);
    }
    Ok(resolved)
}

#[cfg(target_os = "windows")]
fn resolve_native_window_center(native_id: &str) -> Result<(i32, i32), String> {
    use windows::Win32::{
        Foundation::RECT,
        UI::WindowsAndMessaging::{GetWindowRect, IsWindow},
    };

    let hwnd = parse_window_id(native_id)
        .ok_or_else(|| "native window target is no longer valid".to_string())?;
    unsafe {
        if !IsWindow(hwnd).as_bool() {
            return Err("native window target is no longer valid".to_string());
        }

        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect)
            .map_err(|_| "native window target is no longer valid".to_string())?;
        if rect.right <= rect.left || rect.bottom <= rect.top {
            return Err("native window target is no longer valid".to_string());
        }

        Ok(((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2))
    }
}

#[cfg(not(target_os = "windows"))]
fn resolve_native_window_center(_native_id: &str) -> Result<(i32, i32), String> {
    Err("native window target is no longer valid".to_string())
}

fn platform_capabilities() -> ComputerCapabilitySnapshot {
    #[cfg(target_os = "windows")]
    {
        ComputerCapabilitySnapshot {
            platform: "windows".to_string(),
            lanes: vec![ComputerLane::NativeTree, ComputerLane::VisionFallback],
            routes: vec![
                ComputerRoute::Win32SendInput,
                ComputerRoute::Win32Message,
                ComputerRoute::ScreenCapture,
            ],
            background: ComputerBackgroundCapability {
                supported: true,
                routes: vec![ComputerRoute::Win32Message],
                limitations: vec![
                    "Background actions require native window or element targets.".to_string(),
                    "Coordinate-only targets are foreground-only.".to_string(),
                ],
            },
            grounding: ComputerGroundingCapability {
                tree: true,
                screenshot: true,
                click_prediction: false,
                external_providers: vec![
                    PROVIDER_CUA.to_string(),
                    PROVIDER_OMNIPARSER.to_string(),
                    PROVIDER_UI_TARS.to_string(),
                ],
            },
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        ComputerCapabilitySnapshot {
            platform: platform_name().to_string(),
            lanes: vec![ComputerLane::Unsupported],
            routes: vec![ComputerRoute::Unsupported],
            background: ComputerBackgroundCapability {
                supported: false,
                routes: Vec::new(),
                limitations: vec![
                    "Native computer use is implemented for Windows first.".to_string()
                ],
            },
            grounding: ComputerGroundingCapability {
                tree: false,
                screenshot: false,
                click_prediction: false,
                external_providers: vec![
                    PROVIDER_CUA.to_string(),
                    PROVIDER_OMNIPARSER.to_string(),
                    PROVIDER_UI_TARS.to_string(),
                ],
            },
        }
    }
}

fn platform_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "unknown"
    }
}

fn observe_displays() -> Vec<ComputerDisplaySnapshot> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
            SM_YVIRTUALSCREEN,
        };

        unsafe {
            return vec![ComputerDisplaySnapshot {
                id: "display-0".to_string(),
                x: GetSystemMetrics(SM_XVIRTUALSCREEN),
                y: GetSystemMetrics(SM_YVIRTUALSCREEN),
                width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
                height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
                scale_factor: 1.0,
                primary: true,
            }];
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

fn observe_windows() -> Vec<ComputerWindowSnapshot> {
    #[cfg(target_os = "windows")]
    {
        windows_foreground_window()
            .map(|window| vec![window])
            .unwrap_or_default()
    }

    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

fn build_tree(windows: &[ComputerWindowSnapshot]) -> ComputerObservationTree {
    ComputerObservationTree {
        lane: if cfg!(target_os = "windows") {
            ComputerLane::NativeTree
        } else {
            ComputerLane::Unsupported
        },
        elements: windows
            .iter()
            .map(|window| ComputerElementSnapshot {
                element_id: window.element_id.clone(),
                role: "window".to_string(),
                name: window.title.clone(),
                bounds: Some(window.bounds.clone()),
                states: if window.focused {
                    vec!["focused".to_string()]
                } else {
                    Vec::new()
                },
                value: None,
                children: window_child_elements(&window.element_id),
            })
            .collect(),
    }
}

fn build_screenshot_placeholder(
    displays: &[ComputerDisplaySnapshot],
) -> ComputerScreenshotSnapshot {
    let (width, height) = displays
        .first()
        .map(|display| (display.width.max(0), display.height.max(0)))
        .unwrap_or((0, 0));
    ComputerScreenshotSnapshot {
        format: "png".to_string(),
        width,
        height,
        data_base64: None,
        path: None,
    }
}

#[cfg(target_os = "windows")]
fn window_child_elements(window_id: &str) -> Vec<ComputerElementSnapshot> {
    use std::ffi::c_void;

    use windows::Win32::{
        Foundation::{BOOL, HWND, LPARAM},
        UI::WindowsAndMessaging::EnumChildWindows,
    };

    let Some(parent_hwnd) = parse_window_id(window_id) else {
        return Vec::new();
    };

    let mut elements = Vec::new();
    {
        let mut callback = |hwnd| {
            if elements.len() >= 64 {
                return false;
            }
            if let Some(element) = window_element_snapshot(hwnd) {
                elements.push(element);
            }
            true
        };
        let mut trait_obj: &mut dyn FnMut(HWND) -> bool = &mut callback;
        let closure_pointer_pointer: *mut c_void = unsafe { std::mem::transmute(&mut trait_obj) };
        let lparam = LPARAM(closure_pointer_pointer as _);

        unsafe extern "system" fn enumerate_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let closure = &mut *(lparam.0 as *mut c_void as *mut &mut dyn FnMut(HWND) -> bool);
            closure(hwnd).into()
        }

        let _ = unsafe { EnumChildWindows(parent_hwnd, Some(enumerate_callback), lparam) };
    }

    elements
}

#[cfg(not(target_os = "windows"))]
fn window_child_elements(_window_id: &str) -> Vec<ComputerElementSnapshot> {
    Vec::new()
}

#[cfg(target_os = "windows")]
fn windows_foreground_window() -> Option<ComputerWindowSnapshot> {
    use windows::Win32::{
        Foundation::RECT,
        UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect, IsWindowVisible},
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }

        let mut rect = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);
        let title = window_text(hwnd);
        Some(ComputerWindowSnapshot {
            element_id: hwnd_element_id(hwnd),
            title,
            process_name: None,
            bounds: ComputerBounds {
                x: rect.left,
                y: rect.top,
                width: (rect.right - rect.left).max(0),
                height: (rect.bottom - rect.top).max(0),
            },
            focused: true,
            visible: IsWindowVisible(hwnd).as_bool(),
            native: true,
        })
    }
}

#[cfg(target_os = "windows")]
fn window_element_snapshot(
    hwnd: windows::Win32::Foundation::HWND,
) -> Option<ComputerElementSnapshot> {
    use windows::Win32::{
        Foundation::RECT,
        UI::WindowsAndMessaging::{GetWindowRect, IsWindowVisible},
    };

    unsafe {
        if !IsWindowVisible(hwnd).as_bool() {
            return None;
        }

        let mut rect = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);
        let class_name = window_class_name(hwnd);
        let title = window_text(hwnd);
        let name = if title.is_empty() {
            class_name.clone()
        } else {
            title
        };

        Some(ComputerElementSnapshot {
            element_id: hwnd_element_id(hwnd),
            role: role_from_class_name(&class_name).to_string(),
            name,
            bounds: Some(ComputerBounds {
                x: rect.left,
                y: rect.top,
                width: (rect.right - rect.left).max(0),
                height: (rect.bottom - rect.top).max(0),
            }),
            states: vec!["visible".to_string()],
            value: None,
            children: Vec::new(),
        })
    }
}

#[cfg(target_os = "windows")]
fn window_text(hwnd: windows::Win32::Foundation::HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW, GetWindowTextW};

    unsafe {
        let title_len = GetWindowTextLengthW(hwnd);
        let mut title_buffer = vec![0u16; title_len.max(0) as usize + 1];
        let copied = if title_buffer.is_empty() {
            0
        } else {
            GetWindowTextW(hwnd, &mut title_buffer)
        };
        String::from_utf16_lossy(&title_buffer[..copied.max(0) as usize])
    }
}

#[cfg(target_os = "windows")]
fn window_class_name(hwnd: windows::Win32::Foundation::HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;

    unsafe {
        let mut class_buffer = vec![0u16; 256];
        let copied = GetClassNameW(hwnd, &mut class_buffer);
        String::from_utf16_lossy(&class_buffer[..copied.max(0) as usize])
    }
}

#[cfg(target_os = "windows")]
fn hwnd_element_id(hwnd: windows::Win32::Foundation::HWND) -> String {
    format!("window:{:x}", hwnd.0 as usize)
}

#[cfg(target_os = "windows")]
fn role_from_class_name(class_name: &str) -> &'static str {
    let normalized = class_name.to_ascii_lowercase();
    if normalized.contains("button") {
        "button"
    } else if normalized.contains("edit") || normalized.contains("textbox") {
        "textbox"
    } else if normalized.contains("combo") {
        "combobox"
    } else if normalized.contains("list") {
        "list"
    } else if normalized.contains("menu") {
        "menu"
    } else {
        "control"
    }
}

fn execute_native_action(
    request: &ComputerActionRequest,
    target: &NormalizedTarget,
    route: &ComputerRoute,
) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (request, target, route);
        return Err("native computer action execution is only available on Windows".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        match route {
            ComputerRoute::Win32SendInput => execute_send_input_action(request, target),
            ComputerRoute::Win32Message => execute_window_message_action(request, target),
            _ => Err(format!(
                "route '{}' cannot execute computer actions",
                route_label(route)
            )),
        }
    }
}

#[cfg(target_os = "windows")]
fn execute_send_input_action(
    request: &ComputerActionRequest,
    target: &NormalizedTarget,
) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE,
        MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEINPUT,
    };

    if request.operation == ComputerActionOperation::Wait {
        return Ok(());
    }
    if !matches!(
        &request.operation,
        ComputerActionOperation::Click
            | ComputerActionOperation::DoubleClick
            | ComputerActionOperation::RightClick
            | ComputerActionOperation::Move
    ) {
        return Err(format!(
            "operation '{}' is validated but not yet implemented by SendInput",
            operation_label(&request.operation)
        ));
    }

    let (x, y) = match (target.x, target.y) {
        (Some(x), Some(y)) => (x, y),
        _ => return Err("SendInput pointer actions require x/y coordinates".to_string()),
    };
    unsafe {
        windows::Win32::UI::WindowsAndMessaging::SetCursorPos(x, y)
            .map_err(|error| format!("failed to position cursor: {error}"))?;
        if request.operation == ComputerActionOperation::Move {
            let input = INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: 0,
                        dy: 0,
                        mouseData: 0,
                        dwFlags: MOUSEEVENTF_MOVE,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            };
            send_input_checked(&[input], "move")?;
            return Ok(());
        }

        let (down, up) = if request.operation == ComputerActionOperation::RightClick {
            (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
        } else {
            (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
        };
        let pair = [mouse_input(down), mouse_input(up)];
        send_input_checked(&pair, "pointer click")?;
        if request.operation == ComputerActionOperation::DoubleClick {
            send_input_checked(&pair, "second pointer click")?;
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn send_input_checked(
    inputs: &[windows::Win32::UI::Input::KeyboardAndMouse::INPUT],
    label: &str,
) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT};

    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent == inputs.len() as u32 {
        return Ok(());
    }

    Err(format!(
        "SendInput submitted {sent}/{} events for {label}",
        inputs.len()
    ))
}

#[cfg(target_os = "windows")]
fn mouse_input(
    flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS,
) -> windows::Win32::UI::Input::KeyboardAndMouse::INPUT {
    use windows::Win32::UI::Input::KeyboardAndMouse::{INPUT, INPUT_0, INPUT_MOUSE, MOUSEINPUT};
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

#[cfg(target_os = "windows")]
fn execute_window_message_action(
    request: &ComputerActionRequest,
    target: &NormalizedTarget,
) -> Result<(), String> {
    if request.operation == ComputerActionOperation::Wait {
        return Ok(());
    }
    if !matches!(
        &request.operation,
        ComputerActionOperation::Click
            | ComputerActionOperation::DoubleClick
            | ComputerActionOperation::RightClick
    ) {
        return Err(format!(
            "operation '{}' is not background-safe through win32.message",
            operation_label(&request.operation)
        ));
    }
    let hwnd = target
        .window_id
        .as_deref()
        .or(target.element_id.as_deref())
        .and_then(parse_window_id)
        .ok_or_else(|| "win32.message requires a native window id".to_string())?;

    use windows::Win32::{
        Foundation::{POINT, WPARAM},
        Graphics::Gdi::ScreenToClient,
        UI::WindowsAndMessaging::{
            PostMessageW, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP,
        },
    };
    unsafe {
        let (down, up) = if request.operation == ComputerActionOperation::RightClick {
            (WM_RBUTTONDOWN, WM_RBUTTONUP)
        } else {
            (WM_LBUTTONDOWN, WM_LBUTTONUP)
        };
        let mut point = POINT {
            x: target.x.unwrap_or_default(),
            y: target.y.unwrap_or_default(),
        };
        if !ScreenToClient(hwnd, &mut point).as_bool() {
            return Err("failed to resolve target point in client coordinates".to_string());
        }
        let lparam = mouse_lparam(point.x, point.y)?;

        PostMessageW(hwnd, down, WPARAM(0), lparam)
            .map_err(|error| format!("failed to post mouse down: {error}"))?;
        PostMessageW(hwnd, up, WPARAM(0), lparam)
            .map_err(|error| format!("failed to post mouse up: {error}"))?;
        if request.operation == ComputerActionOperation::DoubleClick {
            PostMessageW(hwnd, down, WPARAM(0), lparam)
                .map_err(|error| format!("failed to post second mouse down: {error}"))?;
            PostMessageW(hwnd, up, WPARAM(0), lparam)
                .map_err(|error| format!("failed to post second mouse up: {error}"))?;
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn mouse_lparam(x: i32, y: i32) -> Result<windows::Win32::Foundation::LPARAM, String> {
    if !(i16::MIN as i32..=i16::MAX as i32).contains(&x)
        || !(i16::MIN as i32..=i16::MAX as i32).contains(&y)
    {
        return Err("client coordinates exceed win32 message range".to_string());
    }

    let packed = ((y as u16 as u32) << 16) | (x as u16 as u32);
    Ok(windows::Win32::Foundation::LPARAM(packed as isize))
}

#[cfg(target_os = "windows")]
fn parse_window_id(value: &str) -> Option<windows::Win32::Foundation::HWND> {
    let raw = value.strip_prefix("window:").unwrap_or(value);
    let parsed = usize::from_str_radix(raw, 16).ok()?;
    Some(windows::Win32::Foundation::HWND(parsed as _))
}

#[cfg(test)]
mod tests {
    use super::super::types::{ComputerActionOptions, ComputerCapability};
    use super::*;

    fn target() -> ComputerTarget {
        ComputerTarget {
            scope: Some("foreground".to_string()),
            label: Some("Focused window".to_string()),
            ..Default::default()
        }
    }

    fn session_request() -> ComputerSessionRequest {
        ComputerSessionRequest {
            session_id: "session-1".to_string(),
            target: target(),
            capabilities: vec![ComputerCapability::NativeTree],
            provider_hints: Vec::new(),
            reason: "test".to_string(),
            timeout_ms: 8000,
        }
    }

    #[test]
    fn start_session_rejects_blank_session_id() {
        let runtime = ComputerUseRuntime::new();
        let mut request = session_request();
        request.session_id = " ".to_string();

        assert_eq!(
            runtime.start_session(request).unwrap_err(),
            "sessionId cannot be empty"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn dry_run_coordinate_click_returns_send_input_receipt() {
        let runtime = ComputerUseRuntime::new();
        runtime.start_session(session_request()).unwrap();

        let response = runtime
            .act(ComputerActionRequest {
                session_id: "session-1".to_string(),
                operation: ComputerActionOperation::Click,
                target: ComputerTarget {
                    scope: Some("screen".to_string()),
                    x: Some(10),
                    y: Some(20),
                    ..Default::default()
                },
                value: None,
                execution_mode: ComputerExecutionMode::Foreground,
                reason: "test click".to_string(),
                route_hint: ComputerRoute::Auto,
                timeout_ms: 8000,
                options: ComputerActionOptions {
                    allow_background: false,
                    dry_run: true,
                    post_action_observe: false,
                },
            })
            .unwrap();

        assert_eq!(response.route, ComputerRoute::Win32SendInput);
        assert_eq!(response.lane, ComputerLane::VisionFallback);
        assert_eq!(response.status, ComputerActionStatus::Success);
        assert_eq!(response.target_resolved.x, Some(10));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn auto_route_returns_unsupported_on_non_windows() {
        let runtime = ComputerUseRuntime::new();
        runtime.start_session(session_request()).unwrap();

        let response = runtime
            .act(ComputerActionRequest {
                session_id: "session-1".to_string(),
                operation: ComputerActionOperation::Click,
                target: ComputerTarget {
                    scope: Some("screen".to_string()),
                    x: Some(10),
                    y: Some(20),
                    ..Default::default()
                },
                value: None,
                execution_mode: ComputerExecutionMode::Foreground,
                reason: "test unsupported platform".to_string(),
                route_hint: ComputerRoute::Auto,
                timeout_ms: 8000,
                options: ComputerActionOptions {
                    allow_background: false,
                    dry_run: true,
                    post_action_observe: false,
                },
            })
            .unwrap();

        assert_eq!(response.route, ComputerRoute::Win32SendInput);
        assert_eq!(response.status, ComputerActionStatus::Unsupported);
        assert_eq!(
            response.warnings,
            vec!["route 'win32.send_input' is not available for this session"]
        );
    }

    #[test]
    fn screen_capture_route_cannot_execute_actions() {
        let runtime = ComputerUseRuntime::new();
        runtime.start_session(session_request()).unwrap();

        let response = runtime
            .act(ComputerActionRequest {
                session_id: "session-1".to_string(),
                operation: ComputerActionOperation::Click,
                target: ComputerTarget {
                    element_id: Some("window:100".to_string()),
                    ..Default::default()
                },
                value: None,
                execution_mode: ComputerExecutionMode::Foreground,
                reason: "test route".to_string(),
                route_hint: ComputerRoute::ScreenCapture,
                timeout_ms: 8000,
                options: ComputerActionOptions {
                    allow_background: false,
                    dry_run: true,
                    post_action_observe: false,
                },
            })
            .unwrap();

        assert_eq!(response.route, ComputerRoute::ScreenCapture);
        assert_eq!(response.status, ComputerActionStatus::Blocked);
        assert_eq!(
            response.warnings,
            vec!["route 'screen.capture' cannot execute computer actions"]
        );
    }

    #[test]
    fn window_message_route_requires_background_execution() {
        let runtime = ComputerUseRuntime::new();
        runtime.start_session(session_request()).unwrap();

        let response = runtime
            .act(ComputerActionRequest {
                session_id: "session-1".to_string(),
                operation: ComputerActionOperation::Click,
                target: ComputerTarget {
                    x: Some(10),
                    y: Some(20),
                    ..Default::default()
                },
                value: None,
                execution_mode: ComputerExecutionMode::Foreground,
                reason: "test foreground route hint".to_string(),
                route_hint: ComputerRoute::Win32Message,
                timeout_ms: 8000,
                options: ComputerActionOptions {
                    allow_background: false,
                    dry_run: true,
                    post_action_observe: false,
                },
            })
            .unwrap();

        assert_eq!(response.route, ComputerRoute::Win32Message);
        assert_eq!(response.status, ComputerActionStatus::Blocked);
        assert_eq!(
            response.warnings,
            vec!["route 'win32.message' requires background execution"]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn background_coordinate_actions_are_rejected() {
        let runtime = ComputerUseRuntime::new();
        runtime.start_session(session_request()).unwrap();

        let response = runtime
            .act(ComputerActionRequest {
                session_id: "session-1".to_string(),
                operation: ComputerActionOperation::Click,
                target: ComputerTarget {
                    x: Some(10),
                    y: Some(20),
                    ..Default::default()
                },
                value: None,
                execution_mode: ComputerExecutionMode::Background,
                reason: "test background".to_string(),
                route_hint: ComputerRoute::Auto,
                timeout_ms: 8000,
                options: ComputerActionOptions {
                    allow_background: true,
                    dry_run: true,
                    post_action_observe: false,
                },
            })
            .unwrap();

        assert_eq!(response.route, ComputerRoute::Win32Message);
        assert_eq!(response.status, ComputerActionStatus::Blocked);
        assert_eq!(
            response.warnings,
            vec!["coordinate targets cannot be executed in background mode"]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn background_window_actions_require_observed_native_targets() {
        let runtime = ComputerUseRuntime::new();
        runtime.start_session(session_request()).unwrap();

        let response = runtime
            .act(ComputerActionRequest {
                session_id: "session-1".to_string(),
                operation: ComputerActionOperation::Click,
                target: ComputerTarget {
                    element_id: Some("window:100".to_string()),
                    ..Default::default()
                },
                value: None,
                execution_mode: ComputerExecutionMode::Background,
                reason: "test fabricated background target".to_string(),
                route_hint: ComputerRoute::Auto,
                timeout_ms: 8000,
                options: ComputerActionOptions {
                    allow_background: true,
                    dry_run: true,
                    post_action_observe: false,
                },
            })
            .unwrap();

        assert_eq!(response.route, ComputerRoute::Win32Message);
        assert_eq!(response.status, ComputerActionStatus::Blocked);
        assert_eq!(
            response.warnings,
            vec!["native target was not observed in this computer session"]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn background_window_actions_do_not_trust_session_target_native_ids() {
        let runtime = ComputerUseRuntime::new();
        let mut request = session_request();
        request.target.element_id = Some("window:0".to_string());
        runtime.start_session(request).unwrap();

        let response = runtime
            .act(ComputerActionRequest {
                session_id: "session-1".to_string(),
                operation: ComputerActionOperation::Click,
                target: ComputerTarget {
                    element_id: Some("window:0".to_string()),
                    ..Default::default()
                },
                value: None,
                execution_mode: ComputerExecutionMode::Background,
                reason: "test stale background target".to_string(),
                route_hint: ComputerRoute::Auto,
                timeout_ms: 8000,
                options: ComputerActionOptions {
                    allow_background: true,
                    dry_run: true,
                    post_action_observe: false,
                },
            })
            .unwrap();

        assert_eq!(response.route, ComputerRoute::Win32Message);
        assert_eq!(response.status, ComputerActionStatus::Blocked);
        assert_eq!(
            response.warnings,
            vec!["native target was not observed in this computer session"]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn background_window_actions_reject_stale_observed_native_targets() {
        let runtime = ComputerUseRuntime::new();
        runtime.start_session(session_request()).unwrap();
        {
            let mut state = runtime.state.lock().unwrap();
            state
                .sessions
                .get_mut("session-1")
                .unwrap()
                .observed_native_ids
                .insert("window:0".to_string());
        }

        let response = runtime
            .act(ComputerActionRequest {
                session_id: "session-1".to_string(),
                operation: ComputerActionOperation::Click,
                target: ComputerTarget {
                    element_id: Some("window:0".to_string()),
                    ..Default::default()
                },
                value: None,
                execution_mode: ComputerExecutionMode::Background,
                reason: "test stale background target".to_string(),
                route_hint: ComputerRoute::Auto,
                timeout_ms: 8000,
                options: ComputerActionOptions {
                    allow_background: true,
                    dry_run: true,
                    post_action_observe: false,
                },
            })
            .unwrap();

        assert_eq!(response.route, ComputerRoute::Win32Message);
        assert_eq!(response.status, ComputerActionStatus::Blocked);
        assert_eq!(
            response.warnings,
            vec!["native window target is no longer valid"]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn mouse_lparam_packs_client_coordinates() {
        let lparam = mouse_lparam(12, 34).unwrap();

        assert_eq!(lparam.0 as usize, 0x0022_000c);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn post_action_observe_returns_follow_up_observation_for_successful_actions() {
        let runtime = ComputerUseRuntime::new();
        runtime.start_session(session_request()).unwrap();

        let response = runtime
            .act(ComputerActionRequest {
                session_id: "session-1".to_string(),
                operation: ComputerActionOperation::Wait,
                target: ComputerTarget {
                    scope: Some("foreground".to_string()),
                    ..Default::default()
                },
                value: None,
                execution_mode: ComputerExecutionMode::Foreground,
                reason: "test post-action observation".to_string(),
                route_hint: ComputerRoute::Auto,
                timeout_ms: 1,
                options: ComputerActionOptions {
                    allow_background: false,
                    dry_run: false,
                    post_action_observe: true,
                },
            })
            .unwrap();

        assert_eq!(response.status, ComputerActionStatus::Success);
        assert!(response.post_action_observation.is_some());
    }
}
