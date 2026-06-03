// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 内置工具原生类型定义。

use serde::{Deserialize, Serialize};

/// 内置 Bash 工具的执行请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltInBashExecutionRequest {
    /// 本次执行的唯一标识，用于后续取消。
    pub execution_id: String,
    /// 用户或上层工具网关要执行的 PowerShell 命令文本。
    pub command: String,
    /// 可选工作目录。留空时沿用当前进程工作目录。
    pub working_directory: Option<String>,
    /// 可选超时，单位毫秒。
    pub timeout_ms: Option<u64>,
    /// 是否启用输出压缩：执行前自动为命令添加压缩前缀以精简输出。
    #[serde(default)]
    pub compact_output: bool,
    /// 是否跳过压缩直接返回原始输出。为 true 时不走 rtk。
    #[serde(default)]
    pub raw_output: bool,
}

/// 内置 Bash 工具的结构化执行结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltInBashExecutionResponse {
    /// 原始命令，便于审计和前端日志展示。
    pub command: String,
    /// 当前实现固定为 PowerShell，方便前端按命令环境类型展示。
    pub shell: String,
    /// 实际使用的工作目录。
    pub working_directory: Option<String>,
    /// 进程退出码；被超时终止时通常为 `None`。
    pub exit_code: Option<i32>,
    /// 是否成功退出。超时或非 0 退出码都视为 false。
    pub success: bool,
    /// 是否因超时中止。
    pub timed_out: bool,
    /// 是否因外部取消请求而中止。
    pub cancelled: bool,
    /// 总耗时，单位毫秒。
    pub duration_ms: u64,
    /// 标准输出全文。
    pub stdout: String,
    /// 标准错误全文。
    pub stderr: String,
    /// 为了避免前端重复拼接，原生层直接给出组合输出。
    pub combined_output: String,
    /// 输出是否经过 rtk 压缩。
    #[serde(default)]
    pub compressed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComputerCapability {
    NativeTree,
    Screenshot,
    BackgroundActions,
    VisionFallback,
    BrowserDom,
    ExternalProvider,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComputerObservationMode {
    Tree,
    Screenshot,
    TreeAndScreenshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComputerObservationInclude {
    Displays,
    Windows,
    Tree,
    Screenshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComputerExecutionMode {
    Foreground,
    Background,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComputerRoute {
    Auto,
    #[serde(rename = "win32.send_input")]
    Win32SendInput,
    #[serde(rename = "win32.message")]
    Win32Message,
    #[serde(rename = "screen.capture")]
    ScreenCapture,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComputerActionOperation {
    Click,
    DoubleClick,
    RightClick,
    Move,
    Drag,
    Scroll,
    TypeText,
    PressKey,
    Hotkey,
    Wait,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComputerLane {
    NativeTree,
    VisionFallback,
    BrowserDom,
    ExternalProvider,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComputerSessionStatus {
    Ready,
    Unsupported,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComputerActionStatus {
    Success,
    Unsupported,
    Blocked,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerWindowTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerElementTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerCoordinateTarget {
    pub x: i32,
    pub y: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<ComputerWindowTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element: Option<ComputerElementTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinates: Option<ComputerCoordinateTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerSessionRequest {
    pub session_id: String,
    pub target: ComputerTarget,
    #[serde(default)]
    pub capabilities: Vec<ComputerCapability>,
    #[serde(default)]
    pub provider_hints: Vec<String>,
    pub reason: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerCapabilitySnapshot {
    pub platform: String,
    pub lanes: Vec<ComputerLane>,
    pub routes: Vec<ComputerRoute>,
    pub background: ComputerBackgroundCapability,
    pub grounding: ComputerGroundingCapability,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerBackgroundCapability {
    pub supported: bool,
    pub routes: Vec<ComputerRoute>,
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerGroundingCapability {
    pub tree: bool,
    pub screenshot: bool,
    pub click_prediction: bool,
    pub external_providers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerSessionResponse {
    pub session_id: String,
    pub status: ComputerSessionStatus,
    pub capabilities: ComputerCapabilitySnapshot,
    pub target: ComputerTarget,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerObservationRequest {
    pub session_id: String,
    pub mode: ComputerObservationMode,
    pub target: ComputerTarget,
    #[serde(default)]
    pub include: Vec<ComputerObservationInclude>,
    pub reason: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerDisplaySnapshot {
    pub id: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub scale_factor: f64,
    pub primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerWindowSnapshot {
    pub element_id: String,
    pub title: String,
    pub process_name: Option<String>,
    pub bounds: ComputerBounds,
    pub focused: bool,
    pub visible: bool,
    pub native: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerElementSnapshot {
    pub element_id: String,
    pub role: String,
    pub name: String,
    pub bounds: Option<ComputerBounds>,
    pub states: Vec<String>,
    pub value: Option<String>,
    pub children: Vec<ComputerElementSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerObservationTree {
    pub lane: ComputerLane,
    pub elements: Vec<ComputerElementSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerScreenshotSnapshot {
    pub format: String,
    pub width: i32,
    pub height: i32,
    pub data_base64: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerObservationResponse {
    pub observation_id: String,
    pub session_id: String,
    pub platform: String,
    pub target: ComputerTarget,
    pub displays: Vec<ComputerDisplaySnapshot>,
    pub windows: Vec<ComputerWindowSnapshot>,
    pub tree: Option<ComputerObservationTree>,
    pub screenshot: Option<ComputerScreenshotSnapshot>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComputerActionOptions {
    #[serde(default)]
    pub allow_background: bool,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub post_action_observe: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerActionRequest {
    pub session_id: String,
    pub operation: ComputerActionOperation,
    pub target: ComputerTarget,
    pub value: Option<String>,
    pub execution_mode: ComputerExecutionMode,
    pub reason: String,
    pub route_hint: ComputerRoute,
    pub timeout_ms: u64,
    #[serde(default)]
    pub options: ComputerActionOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerResolvedTarget {
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub element_id: Option<String>,
    pub window_id: Option<String>,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerActionResponse {
    pub action_id: String,
    pub session_id: String,
    pub operation: ComputerActionOperation,
    pub route: ComputerRoute,
    pub lane: ComputerLane,
    pub background_safe: bool,
    pub cursor_moved: bool,
    pub foreground_changed: bool,
    pub target_resolved: ComputerResolvedTarget,
    pub status: ComputerActionStatus,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_action_observation: Option<ComputerObservationResponse>,
}
