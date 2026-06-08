// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

use super::{
    discovery, AppUseActRequest, AppUseActResponse, AppUseAdapter, AppUseAuthorizeActRequest,
    AppUseObserveRequest, AppUseObserveResponse,
};
use base64::{engine::general_purpose, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

pub trait OfficeAutomationRunner: Send + Sync {
    fn run_script(&self, script: &str, timeout_ms: u64) -> Result<String, String>;
}

struct PowerShellOfficeAutomationRunner;

fn powershell_executable() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let windows_root = PathBuf::from(r"C:\Windows");
        let powershell = windows_root
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");

        if powershell.exists() {
            return Ok(powershell);
        }

        return Err(format!(
            "Trusted Windows PowerShell executable is unavailable at {}.",
            powershell.display()
        ));
    }

    #[cfg(not(windows))]
    {
        Err("Office App Use automation is only available on Windows.".to_string())
    }
}

fn powershell_arguments(encoded_script: &str) -> Vec<String> {
    [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Sta",
        "-EncodedCommand",
        encoded_script,
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

impl OfficeAutomationRunner for PowerShellOfficeAutomationRunner {
    fn run_script(&self, script: &str, timeout_ms: u64) -> Result<String, String> {
        let encoded_script = general_purpose::STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        let shell_path = powershell_executable()?;
        let mut child = Command::new(&shell_path)
            .args(powershell_arguments(&encoded_script))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                format!(
                    "Failed to start Office automation shell ({}): {error}",
                    shell_path.display()
                )
            })?;

        let started_at = Instant::now();
        let timeout = Duration::from_millis(timeout_ms.max(1_000));
        loop {
            match child
                .try_wait()
                .map_err(|error| format!("Failed to wait for Office automation shell: {error}"))?
            {
                Some(_) => {
                    let output = child.wait_with_output().map_err(|error| {
                        format!("Failed to collect Office automation output: {error}")
                    })?;
                    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    if output.status.success() {
                        return Ok(stdout);
                    }

                    return Err(if stderr.is_empty() { stdout } else { stderr });
                }
                None if started_at.elapsed() >= timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "Office automation timed out after {timeout_ms}ms while waiting for the Office COM server."
                    ));
                }
                None => thread::sleep(Duration::from_millis(50)),
            }
        }
    }
}

pub struct OfficeWordAdapter {
    runner: Arc<dyn OfficeAutomationRunner>,
}

impl OfficeWordAdapter {
    pub fn new() -> Self {
        Self {
            runner: Arc::new(PowerShellOfficeAutomationRunner),
        }
    }

    #[cfg(test)]
    pub fn with_runner(runner: Arc<dyn OfficeAutomationRunner>) -> Self {
        Self { runner }
    }
}

impl Default for OfficeWordAdapter {
    fn default() -> Self {
        Self::new()
    }
}

pub struct OfficeExcelAdapter {
    runner: Arc<dyn OfficeAutomationRunner>,
}

impl OfficeExcelAdapter {
    pub fn new() -> Self {
        Self {
            runner: Arc::new(PowerShellOfficeAutomationRunner),
        }
    }

    #[cfg(test)]
    pub fn with_runner(runner: Arc<dyn OfficeAutomationRunner>) -> Self {
        Self { runner }
    }
}

impl Default for OfficeExcelAdapter {
    fn default() -> Self {
        Self::new()
    }
}

pub struct OfficePowerPointAdapter {
    runner: Arc<dyn OfficeAutomationRunner>,
}

impl OfficePowerPointAdapter {
    pub fn new() -> Self {
        Self {
            runner: Arc::new(PowerShellOfficeAutomationRunner),
        }
    }

    #[cfg(test)]
    pub fn with_runner(runner: Arc<dyn OfficeAutomationRunner>) -> Self {
        Self { runner }
    }
}

impl Default for OfficePowerPointAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl AppUseAdapter for OfficeWordAdapter {
    fn id(&self) -> &'static str {
        "office_word"
    }

    fn label(&self) -> &'static str {
        "Microsoft Word"
    }

    fn capabilities(&self) -> &'static [&'static str] {
        &[
            "discover",
            "observe_active_document",
            "observe_selection",
            "replace_document_text",
            "format_document_text",
        ]
    }

    fn vendor(&self) -> &'static str {
        "Microsoft Office"
    }

    fn contract_version(&self) -> &'static str {
        "office-com-v1"
    }

    fn observe_scopes(&self) -> &'static [&'static str] {
        &["active_document", "selection"]
    }

    fn actions(&self) -> &'static [&'static str] {
        &["replace_document_text", "format_document_text"]
    }

    fn installed(&self) -> bool {
        discovery::discover_adapter_install_status(self.id()).installed
    }

    fn observe(&self, request: &AppUseObserveRequest) -> AppUseObserveResponse {
        let owned_target = match validate_owned_target_for_app(
            request.target_id.as_deref(),
            false,
            self.label(),
        ) {
            Ok(owned_target) => owned_target,
            Err(error) => return observe_error(request, error, "target_not_owned"),
        };
        let target_path = owned_target.as_ref().map(OwnedTargetGuard::path_string);
        let script = word_observe_script(target_path.as_deref(), &request.scope);
        match run_json_script(self.runner.as_ref(), &script, request.config.timeout_ms) {
            Ok(metadata) => {
                let content = format_word_observe_content(&metadata, &request.scope);
                let (content, truncated) = truncate_content(content, request.max_output_chars);
                observe_success(request, metadata, content, truncated, target_path)
            }
            Err(error) => observe_error(request, error, "office_automation_failed"),
        }
    }

    fn validate_act(&self, request: &AppUseAuthorizeActRequest) -> Result<(), String> {
        match request.action.as_str() {
            "replace_document_text" => {
                text_parameter(request.parameters.as_ref(), "Microsoft Word")?;
            }
            "format_document_text" => {
                format_document_text_parameters(request.parameters.as_ref(), "Microsoft Word")
                    .map(|_| ())?;
            }
            _ => {
                return Err(format!(
                    "Unsupported Microsoft Word action: {}",
                    request.action
                ))
            }
        }

        validate_owned_target_for_app(request.target_id.as_deref(), true, self.label()).map(|_| ())
    }

    fn act(&self, request: &AppUseActRequest) -> AppUseActResponse {
        let owned_target = match validate_owned_target_for_app(
            request.target_id.as_deref(),
            true,
            self.label(),
        ) {
            Ok(Some(owned_target)) => owned_target,
            Ok(None) => {
                return act_error(
                        request,
                        format!(
                            "{} targetId must reference a TouchAI-owned document before running write actions.",
                            self.label()
                        ),
                        "target_not_owned",
                    );
            }
            Err(error) => return act_error(request, error, "target_not_owned"),
        };
        let target_path = owned_target.path_string();
        let script = match request.action.as_str() {
            "replace_document_text" => {
                let text = match text_parameter(request.parameters.as_ref(), "Microsoft Word") {
                    Ok(text) => text,
                    Err(error) => return act_error(request, error, "invalid_parameters"),
                };
                word_text_script(&text, request.action.as_str(), Some(&target_path))
            }
            "format_document_text" => {
                let format = match format_document_text_parameters(
                    request.parameters.as_ref(),
                    "Microsoft Word",
                ) {
                    Ok(format) => format,
                    Err(error) => return act_error(request, error, "invalid_parameters"),
                };
                word_format_document_text_script(&format, Some(&target_path))
            }
            _ => {
                return act_error(
                    request,
                    format!("Unsupported Microsoft Word action: {}", request.action),
                    "unsupported_action",
                );
            }
        };

        match run_json_script(self.runner.as_ref(), &script, request.config.timeout_ms) {
            Ok(metadata) => {
                let document_name = metadata
                    .get("documentName")
                    .and_then(Value::as_str)
                    .unwrap_or("owned Word document");
                AppUseActResponse {
                    ok: true,
                    adapter_id: request.adapter_id.clone(),
                    action: request.action.clone(),
                    receipt: format!(
                        "Microsoft Word {} completed for {document_name}",
                        request.action
                    ),
                    changed: metadata
                        .get("changed")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    metadata,
                }
            }
            Err(error) => act_error(request, error, "office_automation_failed"),
        }
    }
}

impl AppUseAdapter for OfficeExcelAdapter {
    fn id(&self) -> &'static str {
        "office_excel"
    }

    fn label(&self) -> &'static str {
        "Microsoft Excel"
    }

    fn capabilities(&self) -> &'static [&'static str] {
        &[
            "discover",
            "observe_workbook",
            "observe_worksheet",
            "write_cells",
        ]
    }

    fn vendor(&self) -> &'static str {
        "Microsoft Office"
    }

    fn contract_version(&self) -> &'static str {
        "office-com-v1"
    }

    fn observe_scopes(&self) -> &'static [&'static str] {
        &["workbook", "worksheet"]
    }

    fn actions(&self) -> &'static [&'static str] {
        &["write_cells"]
    }

    fn installed(&self) -> bool {
        discovery::discover_adapter_install_status(self.id()).installed
    }

    fn observe(&self, request: &AppUseObserveRequest) -> AppUseObserveResponse {
        let owned_target = match validate_owned_target_for_app(
            request.target_id.as_deref(),
            false,
            self.label(),
        ) {
            Ok(owned_target) => owned_target,
            Err(error) => return observe_error(request, error, "target_not_owned"),
        };
        let target_path = owned_target.as_ref().map(OwnedTargetGuard::path_string);
        let script = excel_observe_script(target_path.as_deref());
        match run_json_script(self.runner.as_ref(), &script, request.config.timeout_ms) {
            Ok(metadata) => {
                let content = format_excel_observe_content(&metadata, &request.scope);
                let (content, truncated) = truncate_content(content, request.max_output_chars);
                observe_success(request, metadata, content, truncated, target_path)
            }
            Err(error) => observe_error(request, error, "office_automation_failed"),
        }
    }

    fn validate_act(&self, request: &AppUseAuthorizeActRequest) -> Result<(), String> {
        if request.action != "write_cells" {
            return Err(format!(
                "Unsupported Microsoft Excel action: {}",
                request.action
            ));
        }

        spreadsheet_write_parameters(request.parameters.as_ref(), "Microsoft Excel")?;
        validate_owned_target_for_app(request.target_id.as_deref(), true, self.label()).map(|_| ())
    }

    fn act(&self, request: &AppUseActRequest) -> AppUseActResponse {
        if request.action != "write_cells" {
            return act_error(
                request,
                format!("Unsupported Microsoft Excel action: {}", request.action),
                "unsupported_action",
            );
        }

        let cells =
            match spreadsheet_write_parameters(request.parameters.as_ref(), "Microsoft Excel") {
                Ok(cells) => cells,
                Err(error) => return act_error(request, error, "invalid_parameters"),
            };

        let owned_target = match validate_owned_target_for_app(
            request.target_id.as_deref(),
            true,
            self.label(),
        ) {
            Ok(Some(owned_target)) => owned_target,
            Ok(None) => {
                return act_error(
                        request,
                        format!(
                            "{} targetId must reference a TouchAI-owned document before running write actions.",
                            self.label()
                        ),
                        "target_not_owned",
                    );
            }
            Err(error) => return act_error(request, error, "target_not_owned"),
        };
        let target_path = owned_target.path_string();

        let script = excel_write_cells_script(&cells, Some(&target_path));
        match run_json_script(self.runner.as_ref(), &script, request.config.timeout_ms) {
            Ok(metadata) => {
                let workbook_name = metadata
                    .get("workbookName")
                    .and_then(Value::as_str)
                    .unwrap_or("owned Excel workbook");
                AppUseActResponse {
                    ok: true,
                    adapter_id: request.adapter_id.clone(),
                    action: request.action.clone(),
                    receipt: format!("Microsoft Excel write_cells completed for {workbook_name}"),
                    changed: metadata
                        .get("changed")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    metadata,
                }
            }
            Err(error) => act_error(request, error, "office_automation_failed"),
        }
    }
}

impl AppUseAdapter for OfficePowerPointAdapter {
    fn id(&self) -> &'static str {
        "office_powerpoint"
    }

    fn label(&self) -> &'static str {
        "Microsoft PowerPoint"
    }

    fn capabilities(&self) -> &'static [&'static str] {
        &[
            "discover",
            "observe_presentation",
            "observe_slide",
            "add_slide_text",
        ]
    }

    fn vendor(&self) -> &'static str {
        "Microsoft Office"
    }

    fn contract_version(&self) -> &'static str {
        "office-com-v1"
    }

    fn observe_scopes(&self) -> &'static [&'static str] {
        &["presentation", "slide"]
    }

    fn actions(&self) -> &'static [&'static str] {
        &["add_slide_text"]
    }

    fn installed(&self) -> bool {
        discovery::discover_adapter_install_status(self.id()).installed
    }

    fn observe(&self, request: &AppUseObserveRequest) -> AppUseObserveResponse {
        let owned_target = match validate_owned_target_for_app(
            request.target_id.as_deref(),
            false,
            self.label(),
        ) {
            Ok(owned_target) => owned_target,
            Err(error) => return observe_error(request, error, "target_not_owned"),
        };
        let target_path = owned_target.as_ref().map(OwnedTargetGuard::path_string);
        let script = powerpoint_observe_script(target_path.as_deref());
        match run_json_script(self.runner.as_ref(), &script, request.config.timeout_ms) {
            Ok(metadata) => {
                let content = format_powerpoint_observe_content(&metadata, &request.scope);
                let (content, truncated) = truncate_content(content, request.max_output_chars);
                observe_success(request, metadata, content, truncated, target_path)
            }
            Err(error) => observe_error(request, error, "office_automation_failed"),
        }
    }

    fn validate_act(&self, request: &AppUseAuthorizeActRequest) -> Result<(), String> {
        if request.action != "add_slide_text" {
            return Err(format!(
                "Unsupported Microsoft PowerPoint action: {}",
                request.action
            ));
        }

        presentation_text_parameters(request.parameters.as_ref(), "Microsoft PowerPoint")?;
        validate_owned_target_for_app(request.target_id.as_deref(), true, self.label()).map(|_| ())
    }

    fn act(&self, request: &AppUseActRequest) -> AppUseActResponse {
        if request.action != "add_slide_text" {
            return act_error(
                request,
                format!(
                    "Unsupported Microsoft PowerPoint action: {}",
                    request.action
                ),
                "unsupported_action",
            );
        }

        let slide_text =
            match presentation_text_parameters(request.parameters.as_ref(), "Microsoft PowerPoint")
            {
                Ok(slide_text) => slide_text,
                Err(error) => return act_error(request, error, "invalid_parameters"),
            };

        let owned_target = match validate_owned_target_for_app(
            request.target_id.as_deref(),
            true,
            self.label(),
        ) {
            Ok(Some(owned_target)) => owned_target,
            Ok(None) => {
                return act_error(
                        request,
                        format!(
                            "{} targetId must reference a TouchAI-owned document before running write actions.",
                            self.label()
                        ),
                        "target_not_owned",
                    );
            }
            Err(error) => return act_error(request, error, "target_not_owned"),
        };
        let target_path = owned_target.path_string();

        let script = powerpoint_add_slide_text_script(&slide_text, Some(&target_path));
        match run_json_script(self.runner.as_ref(), &script, request.config.timeout_ms) {
            Ok(metadata) => {
                let presentation_name = metadata
                    .get("presentationName")
                    .and_then(Value::as_str)
                    .unwrap_or("owned PowerPoint presentation");
                AppUseActResponse {
                    ok: true,
                    adapter_id: request.adapter_id.clone(),
                    action: request.action.clone(),
                    receipt: format!(
                        "Microsoft PowerPoint add_slide_text completed for {presentation_name}"
                    ),
                    changed: metadata
                        .get("changed")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    metadata,
                }
            }
            Err(error) => act_error(request, error, "office_automation_failed"),
        }
    }
}

fn observe_success(
    request: &AppUseObserveRequest,
    metadata: Value,
    content: String,
    truncated: bool,
    target: Option<String>,
) -> AppUseObserveResponse {
    AppUseObserveResponse {
        ok: true,
        adapter_id: request.adapter_id.clone(),
        scope: request.scope.clone(),
        target,
        content: Some(content),
        metadata,
        truncated,
    }
}

fn observe_error(
    request: &AppUseObserveRequest,
    error: String,
    reason: &str,
) -> AppUseObserveResponse {
    AppUseObserveResponse {
        ok: false,
        adapter_id: request.adapter_id.clone(),
        scope: request.scope.clone(),
        target: request.target_id.clone(),
        content: Some(error),
        metadata: json!({
            "executionId": request.execution_id,
            "reason": reason,
        }),
        truncated: false,
    }
}

fn act_error(request: &AppUseActRequest, receipt: String, reason: &str) -> AppUseActResponse {
    AppUseActResponse {
        ok: false,
        adapter_id: request.adapter_id.clone(),
        action: request.action.clone(),
        receipt,
        changed: false,
        metadata: json!({
            "executionId": request.execution_id,
            "reason": reason,
        }),
    }
}

fn run_json_script(
    runner: &dyn OfficeAutomationRunner,
    script: &str,
    timeout_ms: u64,
) -> Result<Value, String> {
    let output = runner.run_script(script, timeout_ms)?;
    serde_json::from_str(output.trim())
        .map_err(|error| format!("Office automation returned invalid JSON: {error}"))
}

fn encoded_utf8_script_value(value: Option<&str>) -> String {
    value
        .map(|value| general_purpose::STANDARD.encode(value.as_bytes()))
        .unwrap_or_default()
}

fn truncate_content(content: String, max_chars: usize) -> (String, bool) {
    if content.chars().count() <= max_chars {
        return (content, false);
    }

    (content.chars().take(max_chars).collect(), true)
}

fn text_parameter(parameters: Option<&Value>, app_label: &str) -> Result<String, String> {
    let text = parameters
        .and_then(|value| value.get("text"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_default();

    if text.trim().is_empty() {
        return Err(format!(
            "{app_label} action requires a non-empty text parameter."
        ));
    }
    if text.chars().count() > 20_000 {
        return Err(format!(
            "{app_label} text must be 20000 characters or fewer."
        ));
    }

    Ok(text)
}

#[derive(Clone, Debug, Default, PartialEq)]
struct SelectionFormat {
    bold: Option<bool>,
    italic: Option<bool>,
    underline: Option<bool>,
    font_size: Option<f64>,
    font_name: Option<String>,
}

impl SelectionFormat {
    fn is_empty(&self) -> bool {
        self.bold.is_none()
            && self.italic.is_none()
            && self.underline.is_none()
            && self.font_size.is_none()
            && self.font_name.is_none()
    }
}

fn format_document_text_parameters(
    parameters: Option<&Value>,
    app_label: &str,
) -> Result<SelectionFormat, String> {
    let Some(parameters) = parameters.and_then(Value::as_object) else {
        return Err(format!(
            "{app_label} format_document_text requires structured format parameters."
        ));
    };

    let mut format = SelectionFormat::default();
    if let Some(value) = parameters.get("bold") {
        format.bold =
            Some(value.as_bool().ok_or_else(|| {
                format!("{app_label} format_document_text bold must be a boolean.")
            })?);
    }
    if let Some(value) = parameters.get("italic") {
        format.italic = Some(value.as_bool().ok_or_else(|| {
            format!("{app_label} format_document_text italic must be a boolean.")
        })?);
    }
    if let Some(value) = parameters.get("underline") {
        format.underline = Some(value.as_bool().ok_or_else(|| {
            format!("{app_label} format_document_text underline must be a boolean.")
        })?);
    }
    if let Some(value) = parameters.get("fontSize") {
        let font_size = value.as_f64().ok_or_else(|| {
            format!("{app_label} format_document_text fontSize must be a number.")
        })?;
        if !(6.0..=96.0).contains(&font_size) {
            return Err(format!(
                "{app_label} format_document_text fontSize must be between 6 and 96."
            ));
        }
        format.font_size = Some(font_size);
    }
    if let Some(value) = parameters.get("fontName") {
        let font_name = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                format!("{app_label} format_document_text fontName must be a non-empty string.")
            })?;
        if font_name.chars().count() > 128 {
            return Err(format!(
                "{app_label} format_document_text fontName must be 128 characters or fewer."
            ));
        }
        format.font_name = Some(font_name.to_string());
    }

    if format.is_empty() {
        return Err(format!(
            "{app_label} format_document_text requires at least one format option."
        ));
    }

    Ok(format)
}

#[derive(Clone, Debug, PartialEq)]
struct SpreadsheetWriteCells {
    range: String,
    sheet_name: Option<String>,
    values: Vec<Vec<Value>>,
}

const SPREADSHEET_MAX_ROWS: usize = 100;
const SPREADSHEET_MAX_COLUMNS: usize = 50;
const SPREADSHEET_MAX_CELLS: usize = 5_000;
const SPREADSHEET_MAX_CELL_TEXT_CHARS: usize = 4_096;
const SPREADSHEET_MAX_VALUES_JSON_BYTES: usize = 256 * 1024;

fn validate_spreadsheet_cell(cell: &Value, app_label: &str) -> Result<(), String> {
    let Value::String(text) = cell else {
        return Ok(());
    };

    if text.chars().count() > SPREADSHEET_MAX_CELL_TEXT_CHARS {
        return Err(format!(
            "{app_label} write_cells cell text must be {SPREADSHEET_MAX_CELL_TEXT_CHARS} characters or fewer."
        ));
    }

    let trimmed = text.trim_start();
    if trimmed.starts_with(['=', '+', '-', '@']) {
        return Err(format!(
            "{app_label} write_cells rejects formula-like strings; formulas require an explicit future action."
        ));
    }

    Ok(())
}

fn spreadsheet_write_parameters(
    parameters: Option<&Value>,
    app_label: &str,
) -> Result<SpreadsheetWriteCells, String> {
    let Some(parameters) = parameters.and_then(Value::as_object) else {
        return Err(format!(
            "{app_label} write_cells requires structured cell parameters."
        ));
    };

    let range = parameters
        .get("range")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{app_label} write_cells requires a non-empty range."))?;
    if range.chars().count() > 64
        || !range
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, ':' | '$'))
    {
        return Err(format!(
            "{app_label} write_cells range must be an A1-style address."
        ));
    }

    let sheet_name = parameters
        .get("sheetName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if sheet_name
        .as_ref()
        .is_some_and(|value| value.chars().count() > 128)
    {
        return Err(format!(
            "{app_label} write_cells sheetName must be 128 characters or fewer."
        ));
    }

    let Some(rows) = parameters.get("values").and_then(Value::as_array) else {
        return Err(format!("{app_label} write_cells requires values."));
    };
    if rows.is_empty() {
        return Err(format!("{app_label} write_cells values cannot be empty."));
    }
    if rows.len() > SPREADSHEET_MAX_ROWS {
        return Err(format!(
            "{app_label} write_cells supports at most {SPREADSHEET_MAX_ROWS} rows per action."
        ));
    }

    let mut values = Vec::with_capacity(rows.len());
    let mut width = None;
    for row in rows {
        let Some(cells) = row.as_array() else {
            return Err(format!(
                "{app_label} write_cells values must be a two-dimensional array."
            ));
        };
        if cells.is_empty() {
            return Err(format!("{app_label} write_cells rows cannot be empty."));
        }
        if cells.len() > SPREADSHEET_MAX_COLUMNS {
            return Err(format!(
                "{app_label} write_cells supports at most {SPREADSHEET_MAX_COLUMNS} columns per action."
            ));
        }
        if width.is_some_and(|expected| expected != cells.len()) {
            return Err(format!(
                "{app_label} write_cells values must use rectangular rows."
            ));
        }
        width = Some(cells.len());

        let mut normalized_row = Vec::with_capacity(cells.len());
        for cell in cells {
            if !matches!(
                cell,
                Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
            ) {
                return Err(format!(
                    "{app_label} write_cells values can only contain scalar cells."
                ));
            }
            validate_spreadsheet_cell(cell, app_label)?;
            normalized_row.push(cell.clone());
        }
        values.push(normalized_row);
    }
    if values.len() * width.unwrap_or_default() > SPREADSHEET_MAX_CELLS {
        return Err(format!(
            "{app_label} write_cells supports at most {SPREADSHEET_MAX_CELLS} cells per action."
        ));
    }
    let values_json = serde_json::to_string(&values).unwrap_or_default();
    if values_json.len() > SPREADSHEET_MAX_VALUES_JSON_BYTES {
        return Err(format!(
            "{app_label} write_cells payload must be {SPREADSHEET_MAX_VALUES_JSON_BYTES} bytes or fewer."
        ));
    }

    Ok(SpreadsheetWriteCells {
        range: range.to_string(),
        sheet_name,
        values,
    })
}

#[derive(Clone, Debug, PartialEq)]
struct SlideText {
    text: String,
    slide_index: Option<i64>,
}

fn presentation_text_parameters(
    parameters: Option<&Value>,
    app_label: &str,
) -> Result<SlideText, String> {
    let Some(parameters) = parameters.and_then(Value::as_object) else {
        return Err(format!(
            "{app_label} add_slide_text requires structured text parameters."
        ));
    };

    let text = parameters
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!("{app_label} add_slide_text requires a non-empty text parameter.")
        })?;
    if text.chars().count() > 2_000 {
        return Err(format!(
            "{app_label} add_slide_text text must be 2000 characters or fewer."
        ));
    }

    let slide_index = match parameters.get("slideIndex") {
        Some(value) => {
            let index = value.as_i64().ok_or_else(|| {
                format!("{app_label} add_slide_text slideIndex must be an integer.")
            })?;
            if index < 1 {
                return Err(format!(
                    "{app_label} add_slide_text slideIndex must be at least 1."
                ));
            }
            Some(index)
        }
        None => None,
    };

    Ok(SlideText {
        text: text.to_string(),
        slide_index,
    })
}

const OFFICE_OWNED_ROOT_ENV: &str = "TOUCHAI_APP_USE_OFFICE_OWNED_ROOT";
const OWNED_SECRET_ENV: &str = "TOUCHAI_APP_USE_OWNED_SECRET";

fn owned_office_target_root() -> PathBuf {
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var_os(OFFICE_OWNED_ROOT_ENV) {
            return PathBuf::from(path);
        }
    }

    app_use_owned_data_root().join("office")
}

pub(crate) fn owned_office_target_root_path() -> PathBuf {
    owned_office_target_root()
}

fn app_use_owned_data_root() -> PathBuf {
    crate::core::system::paths::app_directory_path_without_app_root_override(
        crate::core::system::paths::AppDirectory::Data,
    )
    .unwrap_or_else(|_| fallback_app_data_root())
    .join("app-use")
    .join("owned-targets")
}

fn fallback_app_data_root() -> PathBuf {
    if cfg!(target_os = "windows") {
        if let Some(path) = std::env::var_os("LOCALAPPDATA")
            .or_else(|| std::env::var_os("APPDATA"))
            .map(PathBuf::from)
        {
            return path.join("TouchAI").join("data");
        }
    }

    if let Some(path) = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
        return path.join("TouchAI").join("data");
    }

    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        return home
            .join(".local")
            .join("share")
            .join("TouchAI")
            .join("data");
    }

    PathBuf::from(".").join("touchai-data")
}

fn owned_marker_path(target_path: &Path) -> PathBuf {
    let mut marker_name = target_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("target")
        .to_string();
    marker_name.push_str(".touchai-owned.json");
    target_path.with_file_name(marker_name)
}

fn hash_owned_path(target_path: &Path) -> String {
    let canonical = target_path.to_string_lossy().to_ascii_lowercase();
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(windows)]
fn owned_file_information(
    file: &File,
    label: &str,
) -> Result<windows::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION, String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    unsafe {
        GetFileInformationByHandle(
            HANDLE(file.as_raw_handle() as *mut core::ffi::c_void),
            &mut information,
        )
    }
    .map_err(|error| format!("TouchAI-owned {label} metadata is unavailable: {error}"))?;

    Ok(information)
}

#[cfg(windows)]
fn file_identity(file: &File) -> Result<String, String> {
    let information = owned_file_information(file, "file identity")?;

    Ok(format!(
        "{}:{}:{}",
        information.dwVolumeSerialNumber, information.nFileIndexHigh, information.nFileIndexLow
    ))
}

#[cfg(not(windows))]
fn file_identity(_file: &File) -> Result<String, String> {
    Ok("non-windows-test-file".to_string())
}

fn hash_owned_marker(canonical_path: &Path, file_identity: &str, nonce: Option<&str>) -> String {
    let canonical = canonical_path.to_string_lossy().to_ascii_lowercase();
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hasher.update(b"\0");
    hasher.update(file_identity.as_bytes());
    hasher.update(b"\0");
    hasher.update(nonce.unwrap_or_default().as_bytes());
    format!("{:x}", hasher.finalize())
}

fn read_owned_marker_secret(secret_path: &Path) -> Result<Option<String>, String> {
    if !secret_path.exists() {
        return Ok(None);
    }

    if let Some(parent) = secret_path.parent() {
        ensure_path_chain_not_reparse(parent, "secret root")?;
    }
    let mut secret_file = match open_owned_guard_file(secret_path, "secret", false) {
        Ok(file) => file,
        Err(_) if !secret_path.exists() => return Ok(None),
        Err(error) => {
            return Err(format!(
                "TouchAI owned-target secret could not be opened: {error}"
            ));
        }
    };
    let mut secret = String::new();
    secret_file
        .read_to_string(&mut secret)
        .map_err(|error| format!("TouchAI owned-target secret could not be read: {error}"))?;
    let secret = secret.trim().to_string();
    if secret.is_empty() {
        Ok(None)
    } else {
        Ok(Some(secret))
    }
}

fn owned_marker_secret() -> Result<String, String> {
    if cfg!(debug_assertions) {
        if let Some(secret) = std::env::var_os(OWNED_SECRET_ENV)
            .and_then(|value| value.into_string().ok())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            return Ok(secret);
        }
    }

    let root = app_use_owned_data_root();
    if root.exists() {
        ensure_path_chain_not_reparse(&root, "secret root")?;
    }
    let secret_path = root.join(".ownership-secret");
    if let Some(secret) = read_owned_marker_secret(&secret_path)? {
        return Ok(secret);
    }

    fs::create_dir_all(&root)
        .map_err(|error| format!("TouchAI owned-target secret root is unavailable: {error}"))?;
    ensure_path_chain_not_reparse(&root, "secret root")?;
    let secret = uuid::Uuid::new_v4().to_string();
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&secret_path)
    {
        Ok(mut file) => file.write_all(secret.as_bytes()).map_err(|error| {
            format!("TouchAI owned-target secret could not be written: {error}")
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if let Some(secret) = read_owned_marker_secret(&secret_path)? {
                return Ok(secret);
            }
            return Err("TouchAI owned-target secret already exists but is empty.".to_string());
        }
        Err(error) => {
            return Err(format!(
                "TouchAI owned-target secret could not be created: {error}"
            ));
        }
    }
    Ok(secret)
}

fn hmac_sha256_hex(secret: &str, parts: &[&[u8]]) -> String {
    const BLOCK_SIZE: usize = 64;

    let mut key = secret.as_bytes().to_vec();
    if key.len() > BLOCK_SIZE {
        key = Sha256::digest(&key).to_vec();
    }
    key.resize(BLOCK_SIZE, 0);

    let mut inner_pad = [0x36; BLOCK_SIZE];
    let mut outer_pad = [0x5c; BLOCK_SIZE];
    for (index, byte) in key.iter().enumerate() {
        inner_pad[index] ^= byte;
        outer_pad[index] ^= byte;
    }

    let mut inner = Sha256::new();
    inner.update(inner_pad);
    for part in parts {
        inner.update(part);
    }
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_hash);
    format!("{:x}", outer.finalize())
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut diff = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        let left_byte = left.get(index).copied().unwrap_or_default();
        let right_byte = right.get(index).copied().unwrap_or_default();
        diff |= (left_byte ^ right_byte) as usize;
    }
    diff == 0
}

fn sign_owned_marker(
    canonical_path: &Path,
    file_identity: &str,
    nonce: &str,
) -> Result<String, String> {
    let secret = owned_marker_secret()?;
    let canonical = canonical_path.to_string_lossy().to_ascii_lowercase();
    Ok(hmac_sha256_hex(
        &secret,
        &[
            b"touchai-owned-target-v1",
            canonical.as_bytes(),
            file_identity.as_bytes(),
            nonce.as_bytes(),
        ],
    ))
}

fn create_owned_marker_file(
    marker_path: &Path,
    marker: &Value,
    app_label: &str,
) -> Result<(), String> {
    if marker_path.exists() {
        ensure_path_chain_not_reparse(marker_path, "marker")?;
        if is_path_symlink(marker_path) || has_windows_reparse_point(marker_path) {
            return Err(format!(
                "{app_label} owned marker must not be a symlink or reparse point."
            ));
        }
        return Err(format!(
            "{app_label} owned target marker already exists; create a fresh TouchAI-owned target before issuing a new marker."
        ));
    }

    if let Some(parent) = marker_path.parent() {
        ensure_path_chain_not_reparse(parent, "marker parent")?;
    }
    let marker_json = marker.to_string();
    let mut marker_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(marker_path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                format!("{app_label} owned target marker already exists.")
            } else {
                format!("{app_label} owned target marker could not be created: {error}")
            }
        })?;
    if let Err(error) = marker_file.write_all(marker_json.as_bytes()) {
        drop(marker_file);
        let _ = fs::remove_file(marker_path);
        return Err(format!(
            "{app_label} owned target marker could not be written: {error}"
        ));
    }

    Ok(())
}

pub(crate) fn mark_owned_office_target(
    target_path: &Path,
    app_label: &str,
    created_by: &str,
) -> Result<PathBuf, String> {
    if !target_path.is_absolute() {
        return Err(format!(
            "{app_label} owned target must be an absolute document path."
        ));
    }

    let root_path = owned_office_target_root();
    fs::create_dir_all(&root_path)
        .map_err(|error| format!("{app_label} owned target root is unavailable: {error}"))?;
    ensure_path_chain_not_reparse(&root_path, "target root")?;
    let canonical_root = root_path.canonicalize().map_err(|_| {
        format!("{app_label} owned target root is not available for marker issuance.")
    })?;

    let canonical_candidate = target_path.canonicalize().map_err(|_| {
        format!("{app_label} owned target must reference an existing TouchAI document.")
    })?;
    validate_owned_target_extension(&canonical_candidate, app_label)?;
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(format!(
            "{app_label} owned target must live inside the TouchAI-owned document root."
        ));
    }
    ensure_path_chain_not_reparse(&canonical_candidate, "target")?;

    let target_file =
        open_owned_guard_file(&canonical_candidate, "target", true).map_err(|error| {
            format!("{app_label} owned target must reference an existing TouchAI document: {error}")
        })?;

    let marker_path = owned_marker_path(&canonical_candidate);
    let identity = file_identity(&target_file)?;
    let nonce = uuid::Uuid::new_v4().to_string();
    let marker = json!({
        "version": "touchai-owned-target/v1",
        "createdBy": created_by,
        "pathHash": hash_owned_path(&canonical_candidate),
        "nonce": nonce,
        "identityHash": hash_owned_marker(&canonical_candidate, &identity, Some(&nonce)),
        "signature": sign_owned_marker(&canonical_candidate, &identity, &nonce)?,
    });
    create_owned_marker_file(&marker_path, &marker, app_label)?;
    let _marker_file = verify_owned_marker(&canonical_candidate, &target_file)?;

    Ok(canonical_candidate)
}

#[cfg(windows)]
fn open_owned_guard_file(
    path: &Path,
    label: &str,
    allow_shared_writes: bool,
) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_SHARE_READ: u32 = 0x00000001;
    const FILE_SHARE_WRITE: u32 = 0x00000002;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;

    let share_mode = if allow_shared_writes {
        FILE_SHARE_READ | FILE_SHARE_WRITE
    } else {
        FILE_SHARE_READ
    };

    let file = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(share_mode)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| format!("TouchAI-owned {label} guard could not be opened: {error}"))?;
    ensure_owned_guard_file_handle(&file, label)?;
    Ok(file)
}

#[cfg(not(windows))]
fn open_owned_guard_file(
    path: &Path,
    label: &str,
    _allow_shared_writes: bool,
) -> Result<File, String> {
    File::open(path)
        .map_err(|error| format!("TouchAI-owned {label} guard could not be opened: {error}"))
}

fn is_path_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
}

#[cfg(windows)]
fn has_windows_reparse_point(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    std::fs::symlink_metadata(path)
        .map(|metadata| metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn has_windows_reparse_point(_path: &Path) -> bool {
    false
}

fn ensure_path_chain_not_reparse(path: &Path, label: &str) -> Result<(), String> {
    for candidate in path.ancestors() {
        if candidate.as_os_str().is_empty() || !candidate.exists() {
            continue;
        }
        if is_path_symlink(candidate) || has_windows_reparse_point(candidate) {
            return Err(format!(
                "TouchAI-owned {label} path must not include a symlink or reparse point."
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn path_has_root_prefix(candidate: &Path, root: &Path) -> bool {
    let candidate = candidate
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    let root = root
        .to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase();
    candidate == root || candidate.starts_with(&format!("{root}\\"))
}

#[cfg(not(windows))]
fn path_has_root_prefix(candidate: &Path, root: &Path) -> bool {
    candidate.starts_with(root)
}

#[cfg(windows)]
fn ensure_owned_guard_file_handle(file: &File, label: &str) -> Result<(), String> {
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

    let information = owned_file_information(file, label)?;
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(format!(
            "TouchAI-owned {label} must not be a symlink or reparse point."
        ));
    }
    if information.nNumberOfLinks > 1 {
        return Err(format!("TouchAI-owned {label} must not be a hard link."));
    }
    Ok(())
}

#[cfg(not(windows))]
fn ensure_owned_guard_file_handle(_file: &File, _label: &str) -> Result<(), String> {
    Ok(())
}

struct OwnedTargetGuard {
    canonical_path: PathBuf,
    _target_file: File,
    _marker_file: File,
}

impl OwnedTargetGuard {
    fn path_string(&self) -> String {
        self.canonical_path.to_string_lossy().to_string()
    }
}

fn verify_owned_marker(target_path: &Path, target_file: &File) -> Result<File, String> {
    let marker_path = owned_marker_path(target_path);
    ensure_path_chain_not_reparse(&marker_path, "marker")?;
    if is_path_symlink(&marker_path) || has_windows_reparse_point(&marker_path) {
        return Err("TouchAI-owned marker must not be a symlink or reparse point.".to_string());
    }

    let mut marker_file = open_owned_guard_file(&marker_path, "marker", false)
        .map_err(|error| format!("TouchAI-owned marker is missing for this target: {error}"))?;
    let mut marker = String::new();
    marker_file
        .read_to_string(&mut marker)
        .map_err(|_| "TouchAI-owned marker is unreadable.".to_string())?;
    let marker: Value = serde_json::from_str(&marker)
        .map_err(|_| "TouchAI-owned marker is not valid JSON.".to_string())?;
    let marker_hash = marker
        .get("pathHash")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let marker_nonce = marker
        .get("nonce")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "TouchAI-owned marker nonce is missing.".to_string())?;
    let identity = file_identity(target_file)?;
    let identity_hash = marker
        .get("identityHash")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let marker_signature = marker
        .get("signature")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let expected_identity_hash = hash_owned_marker(target_path, &identity, Some(marker_nonce));
    let expected_signature = sign_owned_marker(target_path, &identity, marker_nonce)?;

    if marker_hash != hash_owned_path(target_path) {
        return Err("TouchAI-owned marker does not match this target path.".to_string());
    }
    if identity_hash != expected_identity_hash {
        return Err("TouchAI-owned marker does not match this target identity.".to_string());
    }
    if !constant_time_eq(marker_signature, &expected_signature) {
        return Err("TouchAI-owned marker is not signed by this TouchAI installation.".to_string());
    }

    Ok(marker_file)
}

fn validate_owned_target_extension(target_path: &Path, app_label: &str) -> Result<(), String> {
    let extension = target_path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let allowed = match app_label {
        "Microsoft Word" => ["docx"].contains(&extension.as_str()),
        "Microsoft Excel" => ["xlsx"].contains(&extension.as_str()),
        "Microsoft PowerPoint" => ["pptx"].contains(&extension.as_str()),
        _ => false,
    };

    if allowed {
        Ok(())
    } else {
        Err(format!(
            "{app_label} targetId must use a macro-free TouchAI-owned document format."
        ))
    }
}

fn validate_owned_target_for_app(
    target_path: Option<&str>,
    required: bool,
    app_label: &str,
) -> Result<Option<OwnedTargetGuard>, String> {
    let Some(target_path) = target_path else {
        return if required {
            Err(format!(
                "{app_label} targetId must reference a TouchAI-owned document before running write actions."
            ))
        } else {
            Ok(None)
        };
    };

    let trimmed_path = target_path.trim();
    if trimmed_path.is_empty() {
        return if required {
            Err(format!(
                "{app_label} targetId must reference a TouchAI-owned document before running write actions."
            ))
        } else {
            Ok(None)
        };
    }

    let candidate = Path::new(trimmed_path);
    if !candidate.is_absolute() {
        return Err(format!(
            "{app_label} targetId must reference a TouchAI-owned absolute document path."
        ));
    }

    let root_path = owned_office_target_root();
    if is_path_symlink(&root_path) || has_windows_reparse_point(&root_path) {
        return Err(format!(
            "{app_label} targetId root must not be a symlink or reparse point."
        ));
    }
    let canonical_root = root_path.canonicalize().map_err(|_| {
        format!("{app_label} targetId root is not available for owned document access.")
    })?;
    if !path_has_root_prefix(candidate, &root_path)
        && !path_has_root_prefix(candidate, &canonical_root)
    {
        return Err(format!(
            "{app_label} targetId is not a TouchAI-owned document path."
        ));
    }
    let canonical_candidate = candidate.canonicalize().map_err(|_| {
        format!("{app_label} targetId must reference an existing TouchAI-owned document.")
    })?;
    validate_owned_target_extension(&canonical_candidate, app_label)?;
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(format!(
            "{app_label} targetId is not a TouchAI-owned document path."
        ));
    }
    ensure_path_chain_not_reparse(&canonical_candidate, "target")?;
    let target_file =
        open_owned_guard_file(&canonical_candidate, "target", true).map_err(|error| {
            format!(
                "{app_label} targetId must reference an existing TouchAI-owned document: {error}"
            )
        })?;
    let marker_file = verify_owned_marker(&canonical_candidate, &target_file).map_err(|error| {
        format!("{app_label} targetId is missing valid TouchAI ownership proof: {error}")
    })?;
    Ok(Some(OwnedTargetGuard {
        canonical_path: canonical_candidate,
        _target_file: target_file,
        _marker_file: marker_file,
    }))
}

fn format_word_observe_content(metadata: &Value, scope: &str) -> String {
    let document_name = metadata
        .get("documentName")
        .and_then(Value::as_str)
        .unwrap_or("active Word document");
    let selection = metadata
        .get("selectionText")
        .and_then(Value::as_str)
        .unwrap_or("");
    let character_count = metadata
        .get("characterCount")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let document_text = metadata
        .get("documentText")
        .and_then(Value::as_str)
        .unwrap_or("");

    if scope == "selection" {
        return format!("Document: {document_name}\nSelection: {selection}");
    }

    format!(
        "Document: {document_name}\nCharacters: {character_count}\nSelection: {selection}\nText: {document_text}"
    )
}

fn format_excel_observe_content(metadata: &Value, scope: &str) -> String {
    let workbook_name = metadata
        .get("workbookName")
        .and_then(Value::as_str)
        .unwrap_or("active Excel workbook");
    let active_sheet = metadata
        .get("activeSheetName")
        .and_then(Value::as_str)
        .unwrap_or("active sheet");
    let used_range = metadata
        .get("usedRange")
        .and_then(Value::as_str)
        .unwrap_or("");
    let values = metadata
        .get("values")
        .map(Value::to_string)
        .unwrap_or_else(|| "[]".to_string());

    if scope == "workbook" {
        let sheets = metadata
            .get("sheetNames")
            .and_then(Value::as_array)
            .map(|sheets| {
                sheets
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        return format!(
            "Workbook: {workbook_name}\nSheets: {sheets}\nActive sheet: {active_sheet}"
        );
    }

    format!(
        "Workbook: {workbook_name}\nSheet: {active_sheet}\nUsed range: {used_range}\nValues: {values}"
    )
}

fn format_powerpoint_observe_content(metadata: &Value, scope: &str) -> String {
    let presentation_name = metadata
        .get("presentationName")
        .and_then(Value::as_str)
        .unwrap_or("active PowerPoint presentation");
    let slide_count = metadata
        .get("slideCount")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let active_slide_index = metadata
        .get("activeSlideIndex")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let slide_text = metadata
        .get("slideText")
        .and_then(Value::as_str)
        .unwrap_or("");

    if scope == "slide" {
        return format!(
            "Presentation: {presentation_name}\nSlide: {active_slide_index}\nText: {slide_text}"
        );
    }

    format!(
        "Presentation: {presentation_name}\nSlides: {slide_count}\nActive slide: {active_slide_index}\nText: {slide_text}"
    )
}

fn word_observe_script(target_path: Option<&str>, scope: &str) -> String {
    let encoded_target_path = encoded_utf8_script_value(target_path);
    let include_document_text = if scope == "active_document" {
        "$true"
    } else {
        "$false"
    };
    format!(
        r#"
$ErrorActionPreference = 'Stop'
function Invoke-WithComRetry([scriptblock]$Operation) {{
    $lastError = $null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {{
        try {{ return & $Operation }} catch {{ $lastError = $_; Start-Sleep -Milliseconds 150 }}
    }}
    throw $lastError
}}
$targetPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_target_path}'))
$includeDocumentText = {include_document_text}
$ownsDocument = $false
if ([string]::IsNullOrWhiteSpace($targetPath)) {{
    $app = Invoke-WithComRetry {{ [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application') }}
    $doc = Invoke-WithComRetry {{ $app.ActiveDocument }}
}} else {{
    $app = Invoke-WithComRetry {{ New-Object -ComObject Word.Application }}
    $oldAutomationSecurity = $null
    try {{ $oldAutomationSecurity = $app.AutomationSecurity; $app.AutomationSecurity = 3 }} catch {{}}
    $doc = Invoke-WithComRetry {{ $app.Documents.Open($targetPath, $false, $true, $false) }}
    $ownsDocument = $true
}}
if ($null -eq $doc) {{ throw 'Microsoft Word does not have an active document.' }}
$selectionText = ''
try {{ if ($null -ne $app.Selection) {{ $selectionText = Invoke-WithComRetry {{ [string]$app.Selection.Text }} }} }} catch {{}}
$documentText = ''
if ($includeDocumentText) {{ $documentText = Invoke-WithComRetry {{ [string]$doc.Content.Text }} }}
$fullName = $null
try {{ $fullName = Invoke-WithComRetry {{ [string]$doc.FullName }} }} catch {{ $fullName = $null }}
$result = [ordered]@{{
    documentName = Invoke-WithComRetry {{ [string]$doc.Name }}
    fullName = $fullName
    documentText = $documentText
    selectionText = $selectionText
    characterCount = Invoke-WithComRetry {{ [int]$doc.Characters.Count }}
}}
if ($ownsDocument) {{ Invoke-WithComRetry {{ $doc.Close([ref]$false) }} | Out-Null; if ($null -ne $oldAutomationSecurity) {{ $app.AutomationSecurity = $oldAutomationSecurity }}; Invoke-WithComRetry {{ $app.Quit() }} | Out-Null }}
$result | ConvertTo-Json -Compress -Depth 4
"#
    )
    .trim()
    .to_string()
}

fn word_text_script(text: &str, action: &str, target_path: Option<&str>) -> String {
    let encoded_text = encoded_utf8_script_value(Some(text));
    let encoded_target_path = encoded_utf8_script_value(target_path);
    let replace_document = if action == "replace_document_text" {
        "$true"
    } else {
        "$false"
    };

    format!(
        r#"
$ErrorActionPreference = 'Stop'
function Invoke-WithComRetry([scriptblock]$Operation) {{
    $lastError = $null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {{
        try {{ return & $Operation }} catch {{ $lastError = $_; Start-Sleep -Milliseconds 150 }}
    }}
    throw $lastError
}}
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_text}'))
$targetPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_target_path}'))
$replaceDocument = {replace_document}
$app = Invoke-WithComRetry {{ New-Object -ComObject Word.Application }}
$oldAutomationSecurity = $null
try {{ $oldAutomationSecurity = $app.AutomationSecurity; $app.AutomationSecurity = 3 }} catch {{}}
$doc = Invoke-WithComRetry {{ $app.Documents.Open($targetPath, $false, $false, $false) }}
if ($null -eq $doc) {{ throw 'Microsoft Word does not have an active document.' }}
if ($replaceDocument) {{
    Invoke-WithComRetry {{ $doc.Content.Select() }} | Out-Null
    Invoke-WithComRetry {{ $app.Selection.TypeText($text) }} | Out-Null
}} else {{
    $range = Invoke-WithComRetry {{ $doc.Range($doc.Content.End - 1, $doc.Content.End - 1) }}
    Invoke-WithComRetry {{ $range.InsertAfter($text) }} | Out-Null
}}
$fullName = $null
try {{ $fullName = Invoke-WithComRetry {{ [string]$doc.FullName }} }} catch {{ $fullName = $null }}
Invoke-WithComRetry {{ $doc.Save() }} | Out-Null
$result = [ordered]@{{
    documentName = Invoke-WithComRetry {{ [string]$doc.Name }}
    fullName = $fullName
    changed = $true
}}
Invoke-WithComRetry {{ $doc.Close([ref]$false) }} | Out-Null
if ($null -ne $oldAutomationSecurity) {{ $app.AutomationSecurity = $oldAutomationSecurity }}
Invoke-WithComRetry {{ $app.Quit() }} | Out-Null
$result | ConvertTo-Json -Compress -Depth 4
"#
    )
    .trim()
    .to_string()
}

fn powershell_optional_bool(value: Option<bool>) -> &'static str {
    match value {
        Some(true) => "$true",
        Some(false) => "$false",
        None => "$null",
    }
}

fn powershell_optional_number(value: Option<f64>) -> String {
    value
        .map(|value| value.to_string())
        .unwrap_or_else(|| "$null".to_string())
}

fn word_format_document_text_script(format: &SelectionFormat, target_path: Option<&str>) -> String {
    let encoded_target_path = encoded_utf8_script_value(target_path);
    let encoded_font_name = encoded_utf8_script_value(format.font_name.as_deref());
    let bold = powershell_optional_bool(format.bold);
    let italic = powershell_optional_bool(format.italic);
    let underline = powershell_optional_bool(format.underline);
    let font_size = powershell_optional_number(format.font_size);

    format!(
        r#"
$ErrorActionPreference = 'Stop'
function Invoke-WithComRetry([scriptblock]$Operation) {{
    $lastError = $null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {{
        try {{ return & $Operation }} catch {{ $lastError = $_; Start-Sleep -Milliseconds 150 }}
    }}
    throw $lastError
}}
$targetPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_target_path}'))
$fontName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_font_name}'))
$formatBold = {bold}
$formatItalic = {italic}
$formatUnderline = {underline}
$formatFontSize = {font_size}
$app = Invoke-WithComRetry {{ New-Object -ComObject Word.Application }}
$oldAutomationSecurity = $null
try {{ $oldAutomationSecurity = $app.AutomationSecurity; $app.AutomationSecurity = 3 }} catch {{}}
$doc = Invoke-WithComRetry {{ $app.Documents.Open($targetPath, $false, $false, $false) }}
if ($null -eq $doc) {{ throw 'Microsoft Word does not have an active document.' }}
Invoke-WithComRetry {{ $doc.Content.Select() }} | Out-Null
$selection = Invoke-WithComRetry {{ $app.Selection }}
if ($null -ne $formatBold) {{ if ([bool]$formatBold) {{ Invoke-WithComRetry {{ $selection.Font.Bold = 1 }} | Out-Null }} else {{ Invoke-WithComRetry {{ $selection.Font.Bold = 0 }} | Out-Null }} }}
if ($null -ne $formatItalic) {{ if ([bool]$formatItalic) {{ Invoke-WithComRetry {{ $selection.Font.Italic = 1 }} | Out-Null }} else {{ Invoke-WithComRetry {{ $selection.Font.Italic = 0 }} | Out-Null }} }}
if ($null -ne $formatUnderline) {{ if ([bool]$formatUnderline) {{ Invoke-WithComRetry {{ $selection.Font.Underline = 1 }} | Out-Null }} else {{ Invoke-WithComRetry {{ $selection.Font.Underline = 0 }} | Out-Null }} }}
if ($null -ne $formatFontSize) {{ Invoke-WithComRetry {{ $selection.Font.Size = [double]$formatFontSize }} | Out-Null }}
if (-not [string]::IsNullOrWhiteSpace($fontName)) {{ Invoke-WithComRetry {{ $selection.Font.Name = $fontName }} | Out-Null }}
$fullName = $null
try {{ $fullName = Invoke-WithComRetry {{ [string]$doc.FullName }} }} catch {{ $fullName = $null }}
Invoke-WithComRetry {{ $doc.Save() }} | Out-Null
$result = [ordered]@{{
    documentName = Invoke-WithComRetry {{ [string]$doc.Name }}
    fullName = $fullName
    changed = $true
}}
Invoke-WithComRetry {{ $doc.Close([ref]$false) }} | Out-Null
if ($null -ne $oldAutomationSecurity) {{ $app.AutomationSecurity = $oldAutomationSecurity }}
Invoke-WithComRetry {{ $app.Quit() }} | Out-Null
$result | ConvertTo-Json -Compress -Depth 4
"#
    )
    .trim()
    .to_string()
}

fn excel_observe_script(target_path: Option<&str>) -> String {
    let encoded_target_path = encoded_utf8_script_value(target_path);
    format!(
        r#"
$ErrorActionPreference = 'Stop'
function Invoke-WithComRetry([scriptblock]$Operation) {{
    $lastError = $null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {{
        try {{ return & $Operation }} catch {{ $lastError = $_; Start-Sleep -Milliseconds 150 }}
    }}
    throw $lastError
}}
function Convert-UsedRangeValues($range) {{
    $values = @()
    $rowCount = Invoke-WithComRetry {{ [int]$range.Rows.Count }}
    $columnCount = Invoke-WithComRetry {{ [int]$range.Columns.Count }}
    for ($row = 1; $row -le $rowCount; $row++) {{
        $rowValues = @()
        for ($column = 1; $column -le $columnCount; $column++) {{
            $rowValues += Invoke-WithComRetry {{ $range.Cells.Item($row, $column).Value2 }}
        }}
        $values += ,$rowValues
    }}
    return $values
}}
$targetPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_target_path}'))
$ownsWorkbook = $false
if ([string]::IsNullOrWhiteSpace($targetPath)) {{
    $app = Invoke-WithComRetry {{ [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application') }}
    $workbook = Invoke-WithComRetry {{ $app.ActiveWorkbook }}
}} else {{
    $app = Invoke-WithComRetry {{ New-Object -ComObject Excel.Application }}
    $oldAutomationSecurity = $app.AutomationSecurity
    $app.AutomationSecurity = 3
    $workbook = Invoke-WithComRetry {{ $app.Workbooks.Open($targetPath, 0, $true) }}
    $ownsWorkbook = $true
}}
if ($null -eq $workbook) {{ throw 'Microsoft Excel does not have an active workbook.' }}
$sheet = Invoke-WithComRetry {{ $app.ActiveSheet }}
$sheetNames = @()
for ($i = 1; $i -le $workbook.Worksheets.Count; $i++) {{ $sheetNames += Invoke-WithComRetry {{ [string]$workbook.Worksheets.Item($i).Name }} }}
$usedRange = Invoke-WithComRetry {{ $sheet.UsedRange }}
$fullName = $null
try {{ $fullName = Invoke-WithComRetry {{ [string]$workbook.FullName }} }} catch {{ $fullName = $null }}
$result = [ordered]@{{
    workbookName = Invoke-WithComRetry {{ [string]$workbook.Name }}
    fullName = $fullName
    activeSheetName = Invoke-WithComRetry {{ [string]$sheet.Name }}
    sheetNames = $sheetNames
    usedRange = Invoke-WithComRetry {{ [string]$usedRange.Address($false, $false) }}
    values = Convert-UsedRangeValues $usedRange
}}
if ($ownsWorkbook) {{ Invoke-WithComRetry {{ $workbook.Close($false) }} | Out-Null; $app.AutomationSecurity = $oldAutomationSecurity; Invoke-WithComRetry {{ $app.Quit() }} | Out-Null }}
$result | ConvertTo-Json -Compress -Depth 6
"#
    )
    .trim()
    .to_string()
}

fn excel_write_cells_script(cells: &SpreadsheetWriteCells, target_path: Option<&str>) -> String {
    let encoded_target_path = encoded_utf8_script_value(target_path);
    let encoded_range = encoded_utf8_script_value(Some(&cells.range));
    let encoded_sheet_name = encoded_utf8_script_value(cells.sheet_name.as_deref());
    let values_json = serde_json::to_string(&cells.values).unwrap_or_else(|_| "[]".to_string());
    let encoded_values = general_purpose::STANDARD.encode(values_json.as_bytes());

    format!(
        r#"
$ErrorActionPreference = 'Stop'
function Invoke-WithComRetry([scriptblock]$Operation) {{
    $lastError = $null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {{
        try {{ return & $Operation }} catch {{ $lastError = $_; Start-Sleep -Milliseconds 150 }}
    }}
    throw $lastError
}}
$targetPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_target_path}'))
$rangeAddress = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_range}'))
$sheetName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_sheet_name}'))
$valuesJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_values}'))
$rows = $valuesJson | ConvertFrom-Json
$app = Invoke-WithComRetry {{ New-Object -ComObject Excel.Application }}
$oldAutomationSecurity = $app.AutomationSecurity
$app.AutomationSecurity = 3
$workbook = Invoke-WithComRetry {{ $app.Workbooks.Open($targetPath, 0, $false) }}
if ($null -eq $workbook) {{ throw 'Microsoft Excel does not have an active workbook.' }}
if ([string]::IsNullOrWhiteSpace($sheetName)) {{ $sheet = Invoke-WithComRetry {{ $workbook.Worksheets.Item(1) }} }} else {{ $sheet = Invoke-WithComRetry {{ $workbook.Worksheets.Item($sheetName) }} }}
$openedFullName = Invoke-WithComRetry {{ [string]$workbook.FullName }}
if ([string]::Compare($openedFullName, $targetPath, $true, [Globalization.CultureInfo]::InvariantCulture) -ne 0) {{ throw 'Microsoft Excel opened a workbook that does not match the requested target.' }}
$range = Invoke-WithComRetry {{ $sheet.Range($rangeAddress) }}
for ($rowIndex = 0; $rowIndex -lt $rows.Count; $rowIndex++) {{
    $row = @($rows[$rowIndex])
    for ($columnIndex = 0; $columnIndex -lt $row.Count; $columnIndex++) {{
        $value = $row[$columnIndex]
        Invoke-WithComRetry {{ $range.Cells.Item($rowIndex + 1, $columnIndex + 1).Value2 = $value }} | Out-Null
    }}
}}
$fullName = $null
try {{ $fullName = $openedFullName }} catch {{ $fullName = $null }}
Invoke-WithComRetry {{ $workbook.Save() }} | Out-Null
$result = [ordered]@{{
    workbookName = Invoke-WithComRetry {{ [string]$workbook.Name }}
    fullName = $fullName
    sheetName = Invoke-WithComRetry {{ [string]$sheet.Name }}
    range = Invoke-WithComRetry {{ [string]$range.Address($false, $false) }}
    changed = $true
    values = $rows
}}
Invoke-WithComRetry {{ $workbook.Close($false) }} | Out-Null
$app.AutomationSecurity = $oldAutomationSecurity
Invoke-WithComRetry {{ $app.Quit() }} | Out-Null
$result | ConvertTo-Json -Compress -Depth 6
"#
    )
    .trim()
    .to_string()
}

fn powerpoint_observe_script(target_path: Option<&str>) -> String {
    let encoded_target_path = encoded_utf8_script_value(target_path);
    format!(
        r#"
$ErrorActionPreference = 'Stop'
function Invoke-WithComRetry([scriptblock]$Operation) {{
    $lastError = $null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {{
        try {{ return & $Operation }} catch {{ $lastError = $_; Start-Sleep -Milliseconds 150 }}
    }}
    throw $lastError
}}
function Get-SlideText($slide) {{
    $parts = @()
    for ($i = 1; $i -le $slide.Shapes.Count; $i++) {{
        $shape = $slide.Shapes.Item($i)
        try {{ if ($shape.HasTextFrame -and $shape.TextFrame.HasText) {{ $parts += [string]$shape.TextFrame.TextRange.Text }} }} catch {{}}
    }}
    return ($parts -join "`n")
}}
$targetPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_target_path}'))
$ownsPresentation = $false
if ([string]::IsNullOrWhiteSpace($targetPath)) {{
    $app = Invoke-WithComRetry {{ [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') }}
    $presentation = Invoke-WithComRetry {{ $app.ActivePresentation }}
}} else {{
    $app = Invoke-WithComRetry {{ New-Object -ComObject PowerPoint.Application }}
    $oldAutomationSecurity = $null
    try {{ $oldAutomationSecurity = $app.AutomationSecurity; $app.AutomationSecurity = 3 }} catch {{}}
    $presentation = Invoke-WithComRetry {{ $app.Presentations.Open($targetPath, $true, $false, $false) }}
    $ownsPresentation = $true
}}
if ($null -eq $presentation) {{ throw 'Microsoft PowerPoint does not have an active presentation.' }}
$slide = $null
$activeSlideIndex = 0
try {{ $slide = Invoke-WithComRetry {{ $app.ActiveWindow.View.Slide }}; $activeSlideIndex = Invoke-WithComRetry {{ [int]$slide.SlideIndex }} }} catch {{ if ($presentation.Slides.Count -gt 0) {{ $slide = Invoke-WithComRetry {{ $presentation.Slides.Item(1) }}; $activeSlideIndex = 1 }} }}
$fullName = $null
try {{ $fullName = Invoke-WithComRetry {{ [string]$presentation.FullName }} }} catch {{ $fullName = $null }}
$result = [ordered]@{{
    presentationName = Invoke-WithComRetry {{ [string]$presentation.Name }}
    fullName = $fullName
    slideCount = Invoke-WithComRetry {{ [int]$presentation.Slides.Count }}
    activeSlideIndex = $activeSlideIndex
    slideText = if ($null -eq $slide) {{ '' }} else {{ Get-SlideText $slide }}
}}
if ($ownsPresentation) {{ Invoke-WithComRetry {{ $presentation.Close() }} | Out-Null; if ($null -ne $oldAutomationSecurity) {{ $app.AutomationSecurity = $oldAutomationSecurity }}; Invoke-WithComRetry {{ $app.Quit() }} | Out-Null }}
$result | ConvertTo-Json -Compress -Depth 5
"#
    )
    .trim()
    .to_string()
}

fn powerpoint_add_slide_text_script(slide_text: &SlideText, target_path: Option<&str>) -> String {
    let encoded_target_path = encoded_utf8_script_value(target_path);
    let encoded_text = encoded_utf8_script_value(Some(&slide_text.text));
    let slide_index = slide_text
        .slide_index
        .map(|value| value.to_string())
        .unwrap_or_else(|| "$null".to_string());

    format!(
        r#"
$ErrorActionPreference = 'Stop'
function Invoke-WithComRetry([scriptblock]$Operation) {{
    $lastError = $null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {{
        try {{ return & $Operation }} catch {{ $lastError = $_; Start-Sleep -Milliseconds 150 }}
    }}
    throw $lastError
}}
$targetPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_target_path}'))
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_text}'))
$slideIndex = {slide_index}
$app = Invoke-WithComRetry {{ New-Object -ComObject PowerPoint.Application }}
$oldAutomationSecurity = $null
try {{ $oldAutomationSecurity = $app.AutomationSecurity; $app.AutomationSecurity = 3 }} catch {{}}
$presentation = Invoke-WithComRetry {{ $app.Presentations.Open($targetPath, $false, $false, $false) }}
if ($null -eq $presentation) {{ throw 'Microsoft PowerPoint does not have an active presentation.' }}
if ($presentation.Slides.Count -eq 0) {{
    $slide = Invoke-WithComRetry {{ $presentation.Slides.Add(1, 12) }}
}} elseif ($null -eq $slideIndex) {{
    $slide = Invoke-WithComRetry {{ $presentation.Slides.Item($presentation.Slides.Count) }}
    $slideIndex = Invoke-WithComRetry {{ [int]$slide.SlideIndex }}
}} else {{
    $slide = Invoke-WithComRetry {{ $presentation.Slides.Item([int]$slideIndex) }}
}}
$shape = Invoke-WithComRetry {{ $slide.Shapes.AddTextbox(1, 48, 48, 600, 120) }}
Invoke-WithComRetry {{ $shape.TextFrame.TextRange.Text = $text }} | Out-Null
$fullName = $null
try {{ $fullName = Invoke-WithComRetry {{ [string]$presentation.FullName }} }} catch {{ $fullName = $null }}
Invoke-WithComRetry {{ $presentation.Save() }} | Out-Null
$result = [ordered]@{{
    presentationName = Invoke-WithComRetry {{ [string]$presentation.Name }}
    fullName = $fullName
    slideIndex = Invoke-WithComRetry {{ [int]$slide.SlideIndex }}
    text = $text
    changed = $true
}}
Invoke-WithComRetry {{ $presentation.Close() }} | Out-Null
if ($null -ne $oldAutomationSecurity) {{ $app.AutomationSecurity = $oldAutomationSecurity }}
Invoke-WithComRetry {{ $app.Quit() }} | Out-Null
$result | ConvertTo-Json -Compress -Depth 5
"#
    )
    .trim()
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::app_use::types::{AppUseAdvancedConfig, AppUseConfig};
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    struct RecordingRunner {
        output: Result<String, String>,
        scripts: Mutex<Vec<String>>,
    }

    impl RecordingRunner {
        fn new(output: Result<String, String>) -> Self {
            Self {
                output,
                scripts: Mutex::new(Vec::new()),
            }
        }

        fn scripts(&self) -> Vec<String> {
            self.scripts.lock().expect("scripts").clone()
        }
    }

    impl OfficeAutomationRunner for RecordingRunner {
        fn run_script(&self, script: &str, _timeout_ms: u64) -> Result<String, String> {
            self.scripts
                .lock()
                .expect("scripts")
                .push(script.to_string());
            self.output.clone()
        }
    }

    fn config() -> AppUseConfig {
        AppUseConfig {
            mode: "interactive".to_string(),
            adapters: HashMap::from([("office_word".to_string(), true)]),
            mutating_approval_mode: "always".to_string(),
            read_scope: "active".to_string(),
            allow_background_operation: false,
            allow_raw_automation: false,
            timeout_ms: 15_000,
            max_output_chars: 12_000,
            advanced: AppUseAdvancedConfig::default(),
        }
    }

    fn prepare_owned_test_root() -> PathBuf {
        static OWNED_TEST_ROOT_LOCK: Mutex<()> = Mutex::new(());
        let _guard = OWNED_TEST_ROOT_LOCK.lock().expect("owned test root lock");
        let root = std::env::temp_dir().join("touchai-office-owned-tests");
        std::env::set_var(OFFICE_OWNED_ROOT_ENV, &root);
        std::env::set_var(OWNED_SECRET_ENV, "app-use-owned-test-secret");
        std::fs::create_dir_all(&root).expect("owned root");
        root
    }

    fn write_owned_test_file(path: &Path) {
        remove_owned_test_file(path);
        std::fs::write(path, b"owned").expect("owned file");
        let app_label = match path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("docx") => "Microsoft Word",
            Some("xlsx") => "Microsoft Excel",
            Some("pptx") => "Microsoft PowerPoint",
            _ => panic!("unsupported office test target extension"),
        };
        mark_owned_office_target(path, app_label, "TouchAI App Use test").expect("owned marker");
    }

    fn remove_owned_test_file(path: &Path) {
        let marker = path
            .canonicalize()
            .ok()
            .map(|canonical_path| owned_marker_path(&canonical_path))
            .unwrap_or_else(|| owned_marker_path(path));
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(marker);
    }

    #[test]
    fn word_observe_uses_microsoft_word_com_and_structured_content() {
        let runner = Arc::new(RecordingRunner::new(Ok(json!({
            "documentName": "demo.docx",
            "documentText": "full Word text",
            "selectionText": "selected Word text",
            "characterCount": 42
        })
        .to_string())));
        let adapter = OfficeWordAdapter::with_runner(runner.clone());

        let response = adapter.observe(&AppUseObserveRequest {
            execution_id: "office-word-observe".to_string(),
            adapter_id: "office_word".to_string(),
            scope: "selection".to_string(),
            description: "read Word selection".to_string(),
            target_id: None,
            max_output_chars: 12_000,
            config: config(),
        });

        assert_eq!(response.ok, true);
        assert!(response
            .content
            .unwrap_or_default()
            .contains("selected Word text"));
        let script = runner.scripts().join("\n");
        assert!(script.contains("Word.Application"));
        assert!(!script.contains("KWPS.Application"));
        assert!(!script.contains("UIAutomation"));
    }

    #[test]
    fn word_selection_observe_disables_full_document_collection() {
        let selection_script = word_observe_script(None, "selection");
        let document_script = word_observe_script(None, "active_document");

        assert!(selection_script.contains("$includeDocumentText = $false"));
        assert!(document_script.contains("$includeDocumentText = $true"));
    }

    #[test]
    fn word_replace_with_owned_target_uses_base64_payload() {
        let owned_root = prepare_owned_test_root();
        let owned_path = owned_root.join("owned-word-target.docx");
        write_owned_test_file(&owned_path);
        let owned_path_string = owned_path.to_string_lossy().to_string();
        let runner = Arc::new(RecordingRunner::new(Ok(json!({
            "documentName": "owned-word-target.docx",
            "fullName": owned_path_string.clone(),
            "changed": true
        })
        .to_string())));
        let adapter = OfficeWordAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "office-word-act".to_string(),
            adapter_id: "office_word".to_string(),
            action: "replace_document_text".to_string(),
            description: "replace owned Word content".to_string(),
            target_id: Some(owned_path_string.clone()),
            parameters: Some(json!({ "text": "hello from app use" })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, true);
        let script = runner.scripts().join("\n");
        assert!(script.contains("Word.Application"));
        assert!(script.contains("Documents.Open"));
        assert!(script.contains("TypeText"));
        assert!(!script.contains(&owned_path_string));
        assert!(!script.contains("hello from app use"));
        remove_owned_test_file(&owned_path);
    }

    #[test]
    fn word_rejects_missing_owned_target_before_running_office() {
        let runner = Arc::new(RecordingRunner::new(Ok("{}".to_string())));
        let adapter = OfficeWordAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "office-word-no-target".to_string(),
            adapter_id: "office_word".to_string(),
            action: "replace_document_text".to_string(),
            description: "replace owned Word content".to_string(),
            target_id: None,
            parameters: Some(json!({ "text": "hello" })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.metadata["reason"], "target_not_owned");
        assert!(runner.scripts().is_empty());
    }

    #[test]
    fn word_rejects_self_minted_owned_target_marker_before_running_office() {
        let owned_root = prepare_owned_test_root();
        let owned_path = owned_root.join("owned-word-unsigned-marker.docx");
        std::fs::write(&owned_path, b"owned").expect("owned file");
        let canonical_path = owned_path.canonicalize().expect("canonical owned file");
        let target_file = std::fs::File::open(&canonical_path).expect("owned target file");
        let identity = file_identity(&target_file).expect("owned identity");
        let nonce = "self-minted-office-marker";
        let marker = json!({
            "createdBy": "legacy TouchAI App Use test",
            "pathHash": hash_owned_path(&canonical_path),
            "nonce": nonce,
            "identityHash": hash_owned_marker(&canonical_path, &identity, Some(nonce)),
        });
        std::fs::write(owned_marker_path(&canonical_path), marker.to_string())
            .expect("owned marker");
        let runner = Arc::new(RecordingRunner::new(Ok(json!({}).to_string())));
        let adapter = OfficeWordAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "office-word-unsigned-marker".to_string(),
            adapter_id: "office_word".to_string(),
            action: "replace_document_text".to_string(),
            description: "replace self-minted Word document".to_string(),
            target_id: Some(owned_path.to_string_lossy().to_string()),
            parameters: Some(json!({ "text": "safe" })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.changed, false);
        assert!(response.receipt.contains("signed"));
        assert!(runner.scripts().is_empty());
        remove_owned_test_file(&owned_path);
    }

    #[test]
    fn mark_owned_office_target_refuses_to_overwrite_existing_marker() {
        let owned_root = prepare_owned_test_root();
        let owned_path = owned_root.join("owned-word-existing-marker.docx");
        remove_owned_test_file(&owned_path);
        std::fs::write(&owned_path, b"owned").expect("owned file");
        let canonical_path = owned_path.canonicalize().expect("canonical owned file");
        std::fs::write(owned_marker_path(&canonical_path), "{}").expect("existing marker");

        let error = mark_owned_office_target(&owned_path, "Microsoft Word", "TouchAI App Use test")
            .expect_err("existing marker must not be overwritten");

        assert!(error.contains("already exists"));
        remove_owned_test_file(&owned_path);
    }

    #[test]
    fn excel_write_cells_uses_macro_safe_excel_com_and_base64_payload() {
        let owned_root = prepare_owned_test_root();
        let owned_path = owned_root.join("owned-excel-target.xlsx");
        write_owned_test_file(&owned_path);
        let owned_path_string = owned_path.to_string_lossy().to_string();
        let runner = Arc::new(RecordingRunner::new(Ok(json!({
            "workbookName": "owned-excel-target.xlsx",
            "fullName": owned_path_string.clone(),
            "sheetName": "Sheet1",
            "range": "A1:B1",
            "changed": true
        })
        .to_string())));
        let adapter = OfficeExcelAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "office-excel-act".to_string(),
            adapter_id: "office_excel".to_string(),
            action: "write_cells".to_string(),
            description: "write owned Excel cells".to_string(),
            target_id: Some(owned_path_string.clone()),
            parameters: Some(json!({ "range": "A1:B1", "values": [["CellAlphaUserValue", "CellBetaUserValue"]] })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, true);
        let script = runner.scripts().join("\n");
        assert!(script.contains("Excel.Application"));
        assert!(script.contains("AutomationSecurity = 3"));
        assert!(script.contains("Workbooks.Open"));
        assert!(script.contains("$workbook.Worksheets.Item(1)"));
        assert!(script.contains("$openedFullName"));
        assert!(script.contains("does not match the requested target"));
        assert!(script.contains(".Value2"));
        assert!(!script.contains("$app.ActiveSheet"));
        assert!(!script.contains("$rows = @($valuesJson | ConvertFrom-Json)"));
        assert!(!script.contains(&owned_path_string));
        assert!(!script.contains("CellAlphaUserValue"));
        assert!(!script.contains("CellBetaUserValue"));
        assert!(!script.contains("KET.Application"));
        remove_owned_test_file(&owned_path);
    }

    #[test]
    fn excel_rejects_formula_like_cells_before_running_office() {
        let owned_root = prepare_owned_test_root();
        let owned_path = owned_root.join("owned-excel-formula.xlsx");
        write_owned_test_file(&owned_path);
        let runner = Arc::new(RecordingRunner::new(Ok("{}".to_string())));
        let adapter = OfficeExcelAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "office-excel-formula".to_string(),
            adapter_id: "office_excel".to_string(),
            action: "write_cells".to_string(),
            description: "write formula-like owned Excel cell".to_string(),
            target_id: Some(owned_path.to_string_lossy().to_string()),
            parameters: Some(
                json!({ "range": "A1", "values": [["=HYPERLINK(\"https://example.com\")"]] }),
            ),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, false);
        assert_eq!(response.metadata["reason"], "invalid_parameters");
        assert!(response.receipt.contains("formula"));
        assert!(runner.scripts().is_empty());
        remove_owned_test_file(&owned_path);
    }

    #[test]
    fn powerpoint_add_slide_text_uses_powerpoint_com_and_base64_payload() {
        let owned_root = prepare_owned_test_root();
        let owned_path = owned_root.join("owned-powerpoint-target.pptx");
        write_owned_test_file(&owned_path);
        let owned_path_string = owned_path.to_string_lossy().to_string();
        let runner = Arc::new(RecordingRunner::new(Ok(json!({
            "presentationName": "owned-powerpoint-target.pptx",
            "fullName": owned_path_string.clone(),
            "slideIndex": 1,
            "text": "hello slide",
            "changed": true
        })
        .to_string())));
        let adapter = OfficePowerPointAdapter::with_runner(runner.clone());

        let response = adapter.act(&AppUseActRequest {
            execution_id: "office-powerpoint-act".to_string(),
            adapter_id: "office_powerpoint".to_string(),
            action: "add_slide_text".to_string(),
            description: "add owned PowerPoint text".to_string(),
            target_id: Some(owned_path_string.clone()),
            parameters: Some(json!({ "text": "hello slide", "slideIndex": 1 })),
            permit: None,
            config: config(),
        });

        assert_eq!(response.ok, true);
        let script = runner.scripts().join("\n");
        assert!(script.contains("PowerPoint.Application"));
        assert!(script.contains("Presentations.Open"));
        assert!(script.contains(".Shapes.AddTextbox"));
        assert!(!script.contains(&owned_path_string));
        assert!(!script.contains("hello slide"));
        assert!(!script.contains("KWPP.Application"));
        remove_owned_test_file(&owned_path);
    }
}
