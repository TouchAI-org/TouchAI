// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 基于 rmcp SDK 的 MCP 客户端实现。

use super::types::*;
use log::{debug, error, info, warn};
use rmcp::{
    model::CallToolRequestParam,
    service::{RunningService, ServiceExt},
    transport::{
        ConfigureCommandExt, SseClientTransport, StreamableHttpClientTransport, TokioChildProcess,
    },
};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::{
    io::AsyncReadExt,
    process::ChildStderr,
    sync::{Mutex, RwLock},
    task::JoinHandle,
    time::{timeout, Duration},
};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

type McpService = RunningService<rmcp::RoleClient, ()>;

/// 支持多种传输方式的 MCP 客户端封装。
pub struct McpClient {
    server_id: i64,
    server_name: String,
    service: Arc<RwLock<Option<McpService>>>,
    status: Arc<Mutex<ServerStatus>>,
    error: Arc<Mutex<Option<String>>>,
}

impl McpClient {
    /// 创建新的 MCP 客户端。
    pub fn new(server_id: i64, server_name: String) -> Self {
        Self {
            server_id,
            server_name,
            service: Arc::new(RwLock::new(None)),
            status: Arc::new(Mutex::new(ServerStatus::Disconnected)),
            error: Arc::new(Mutex::new(None)),
        }
    }

    /// 通过 stdio 传输连接到 MCP 服务器。
    pub async fn connect_stdio(
        &self,
        command: String,
        args: Vec<String>,
        env: Option<HashMap<String, String>>,
        cwd: Option<String>,
    ) -> Result<(), String> {
        info!(
            "Connecting to MCP server {} (stdio): {} {:?}",
            self.server_id, command, args
        );

        self.set_status(ServerStatus::Connecting).await;
        self.clear_error().await;

        // 在 Windows 上通过 cmd.exe 包装命令以支持 PATH 查找
        // 这是必要的，因为 tokio::process::Command 在 Windows 上不会搜索 PATH
        // 来查找 npx、node、python 等可执行文件
        //
        // 权衡：绝对路径会多一层 shell，但开销可忽略，且这大大简化了逻辑
        let (actual_command, actual_args) = if cfg!(target_os = "windows") {
            let mut cmd_args = vec!["/c".to_string(), command.clone()];
            cmd_args.extend(args);
            ("cmd".to_string(), cmd_args)
        } else {
            (command.clone(), args)
        };

        info!(
            "Actual command for MCP server {}: {} {:?}",
            self.server_id, actual_command, actual_args
        );

        // 使用 tokio::process::Command 构建命令
        let cmd = tokio::process::Command::new(&actual_command).configure(|c| {
            c.args(&actual_args);

            // 在 Windows 上隐藏子进程的控制台窗口
            // 如果没有这个标志，MCP 服务器进程会生成可见的控制台窗口
            // 这对于 GUI 应用程序来说是不希望的
            #[cfg(target_os = "windows")]
            c.creation_flags(CREATE_NO_WINDOW);

            // 设置环境变量
            if let Some(env_vars) = &env {
                for (key, value) in env_vars {
                    c.env(key, value);
                }
            }

            // 设置工作目录
            if let Some(working_dir) = &cwd {
                c.current_dir(working_dir);
            }
        });

        // Capture process stderr during connect
        let (transport, stderr) = TokioChildProcess::builder(cmd)
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                let err_msg = format!("Failed to create transport: {}", e);
                error!("{}", err_msg);
                err_msg
            })?;

        let stderr_collector = Self::spawn_stderr_collector(stderr);
        let result = Self::format_stdio_connect_result(
            ().serve(transport).await.map_err(|e| e.to_string()),
            stderr_collector,
        )
        .await;

        self.store_service_and_set_connected(result, "stdio").await
    }

    /// 通过 SSE 传输连接到 MCP 服务器。
    pub async fn connect_sse(
        &self,
        url: String,
        headers: Option<HashMap<String, String>>,
    ) -> Result<(), String> {
        info!("Connecting to MCP server {} (SSE): {}", self.server_id, url);

        self.set_status(ServerStatus::Connecting).await;
        self.clear_error().await;

        let http_client = Self::build_http_client(headers)?;

        // 创建 SSE 传输
        let url_str: Arc<str> = url.into();
        let transport = SseClientTransport::start_with_client(
            http_client,
            rmcp::transport::sse_client::SseClientConfig {
                sse_endpoint: url_str,
                ..Default::default()
            },
        )
        .await
        .map_err(|e| {
            let err_msg = format!("Failed to create SSE transport: {}", e);
            error!("{}", err_msg);
            err_msg
        })?;

        self.store_service_and_set_connected(
            ().serve(transport).await.map_err(|e| e.to_string()),
            "SSE",
        )
        .await
    }

    /// 通过 HTTP 传输连接到 MCP 服务器（Streamable HTTP）。
    pub async fn connect_http(
        &self,
        url: String,
        headers: Option<HashMap<String, String>>,
    ) -> Result<(), String> {
        info!(
            "Connecting to MCP server {} (HTTP): {}",
            self.server_id, url
        );

        self.set_status(ServerStatus::Connecting).await;
        self.clear_error().await;

        let http_client = Self::build_http_client(headers)?;

        // 创建 Streamable HTTP 传输
        let url_str: Arc<str> = url.into();
        let transport = StreamableHttpClientTransport::with_client(
            http_client,
            rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig {
                uri: url_str,
                ..Default::default()
            },
        );

        self.store_service_and_set_connected(
            ().serve(transport).await.map_err(|e| e.to_string()),
            "HTTP",
        )
        .await
    }

    /// 生成后台任务以收集 MCP 服务器进程的 stderr 输出
    ///
    /// 为什么需要这个：当 MCP 服务器连接失败时，SDK 的错误消息通常很笼统
    /// 实际的错误详情通常由服务器进程打印到 stderr
    /// 通过捕获 stderr，我们可以为用户提供更有帮助的错误消息
    ///
    /// 32KB 限制可防止服务器大量输出 stderr 导致的内存耗尽
    fn spawn_stderr_collector(
        stderr: Option<ChildStderr>,
    ) -> Option<(Arc<Mutex<Vec<u8>>>, JoinHandle<std::io::Result<()>>)> {
        const MAX_CAPTURED_STDERR_BYTES: usize = 32 * 1024;

        stderr.map(|mut stderr| {
            let output = Arc::new(Mutex::new(Vec::new()));
            let output_clone = Arc::clone(&output);

            let task = tokio::spawn(async move {
                let mut buffer = [0u8; 4096];
                loop {
                    let bytes_read = stderr.read(&mut buffer).await?;
                    if bytes_read == 0 {
                        break;
                    }

                    let mut stderr_output = output_clone.lock().await;
                    // 达到限制后停止收集以防止内存问题
                    if stderr_output.len() >= MAX_CAPTURED_STDERR_BYTES {
                        continue;
                    }

                    let remaining = MAX_CAPTURED_STDERR_BYTES - stderr_output.len();
                    stderr_output.extend_from_slice(&buffer[..bytes_read.min(remaining)]);
                }

                Ok(())
            });

            (output, task)
        })
    }

    async fn format_stdio_connect_result(
        result: Result<McpService, String>,
        stderr_collector: Option<(Arc<Mutex<Vec<u8>>>, JoinHandle<std::io::Result<()>>)>,
    ) -> Result<McpService, String> {
        match result {
            Ok(service) => {
                if let Some((_output, task)) = stderr_collector {
                    drop(task);
                }
                Ok(service)
            }
            Err(error_message) => {
                let stderr_output = Self::collect_stderr_output(stderr_collector).await;
                Err(Self::merge_stdio_error(stderr_output, error_message))
            }
        }
    }

    /// 带超时地收集 stderr 输出
    ///
    /// 连接失败后，我们给 stderr 收集任务 300ms 的时间来完成读取
    /// 这通常足够捕获错误消息，但可以防止进程卡住时无限期挂起
    async fn collect_stderr_output(
        stderr_collector: Option<(Arc<Mutex<Vec<u8>>>, JoinHandle<std::io::Result<()>>)>,
    ) -> Option<String> {
        let Some((output, mut task)) = stderr_collector else {
            return None;
        };

        match timeout(Duration::from_millis(300), &mut task).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(read_error))) => {
                warn!("Failed to read MCP server stderr: {}", read_error);
            }
            Ok(Err(join_error)) if !join_error.is_cancelled() => {
                warn!("MCP stderr collector task failed: {}", join_error);
            }
            Ok(Err(_)) => {}
            Err(_) => {
                // 超时：中止任务以防止资源泄漏
                task.abort();
            }
        }

        let output = output.lock().await;
        let stderr_output = String::from_utf8_lossy(&output).trim().to_string();
        (!stderr_output.is_empty()).then_some(stderr_output)
    }

    /// 智能地合并 stderr 输出和 SDK 错误消息
    ///
    /// 如果 stderr 已经包含 SDK 错误消息，只返回 stderr 以避免重复
    /// 否则，组合两者以获得最大上下文
    fn merge_stdio_error(stderr_output: Option<String>, error_message: String) -> String {
        match stderr_output {
            Some(stderr_output) if !stderr_output.is_empty() => {
                if stderr_output.contains(&error_message) {
                    stderr_output
                } else {
                    format!("{}\n\nConnection error: {}", stderr_output, error_message)
                }
            }
            _ => error_message,
        }
    }

    /// 构建带可选自定义请求头的 reqwest HTTP 客户端。
    fn build_http_client(
        headers: Option<HashMap<String, String>>,
    ) -> Result<reqwest::Client, String> {
        let mut client_builder = reqwest::Client::builder();

        if let Some(header_map) = headers {
            let mut header_values = reqwest::header::HeaderMap::new();
            for (key, value) in header_map {
                if let (Ok(name), Ok(val)) = (
                    reqwest::header::HeaderName::from_bytes(key.as_bytes()),
                    reqwest::header::HeaderValue::from_str(&value),
                ) {
                    header_values.insert(name, val);
                } else {
                    warn!("Skipping invalid header: {}={}", key, value);
                }
            }
            client_builder = client_builder.default_headers(header_values);
        }

        client_builder.build().map_err(|e| {
            let err_msg = format!("Failed to build HTTP client: {}", e);
            error!("{}", err_msg);
            err_msg
        })
    }

    /// 保存连接结果中的 service 并更新状态。
    async fn store_service_and_set_connected(
        &self,
        result: Result<McpService, String>,
        transport_name: &str,
    ) -> Result<(), String> {
        match result {
            Ok(service) => {
                info!(
                    "Successfully connected to MCP server {} '{}' via {}",
                    self.server_id, self.server_name, transport_name
                );

                if let Some(peer_info) = service.peer().peer_info() {
                    info!(
                        "Server info: name={}, version={}",
                        peer_info.server_info.name, peer_info.server_info.version
                    );
                }

                let mut service_lock = self.service.write().await;
                *service_lock = Some(service);

                self.set_status(ServerStatus::Connected).await;
                Ok(())
            }
            Err(e) => {
                let err_msg = if e.contains('\n') {
                    format!("Failed to connect via {}:\n{}", transport_name, e)
                } else {
                    format!("Failed to connect via {}: {}", transport_name, e)
                };
                error!("{}", err_msg);
                self.set_error(err_msg.clone()).await;
                self.set_status(ServerStatus::Error).await;
                Err(err_msg)
            }
        }
    }

    /// 断开与 MCP 服务器的连接。
    pub async fn disconnect(&self) -> Result<(), String> {
        info!(
            "Disconnecting from MCP server {} '{}'",
            self.server_id, self.server_name
        );

        let mut service = self.service.write().await;
        if let Some(svc) = service.take() {
            if let Err(e) = svc.cancel().await {
                warn!(
                    "Failed to gracefully cancel MCP service {}: {}",
                    self.server_id, e
                );
            }
        }

        self.set_status(ServerStatus::Disconnected).await;
        self.clear_error().await;
        Ok(())
    }

    /// 列出服务器的可用工具。
    pub async fn list_tools(&self) -> Result<Vec<McpToolDefinition>, String> {
        let service = self.service.read().await;
        let service = service
            .as_ref()
            .ok_or_else(|| "Service not connected".to_string())?;

        // 调用 service 的 list_tools
        match service.peer().list_tools(Default::default()).await {
            Ok(response) => {
                let tools: Vec<McpToolDefinition> = response
                    .tools
                    .into_iter()
                    .map(|tool| McpToolDefinition {
                        name: tool.name.to_string(),
                        description: tool.description.map(|d| d.to_string()),
                        input_schema: serde_json::to_value(&tool.input_schema)
                            .unwrap_or(serde_json::Value::Null),
                    })
                    .collect();

                debug!(
                    "Listed {} tools from server {} '{}'",
                    tools.len(),
                    self.server_id,
                    self.server_name
                );
                Ok(tools)
            }
            Err(e) => {
                let err_msg = format!("Failed to list tools: {}", e);
                error!("{}", err_msg);
                Err(err_msg)
            }
        }
    }

    /// 调用服务器上的工具。
    pub async fn call_tool(
        &self,
        tool_name: String,
        arguments: serde_json::Value,
    ) -> Result<McpToolCallResponse, String> {
        let service = self.service.read().await;
        let service = service
            .as_ref()
            .ok_or_else(|| "Service not connected".to_string())?;

        // 将参数转换为 JsonObject
        let args_obj = arguments.as_object().cloned();

        // 调用工具
        match service
            .peer()
            .call_tool(CallToolRequestParam {
                name: tool_name.into(),
                arguments: args_obj,
            })
            .await
        {
            Ok(response) => {
                // 转换内容
                let content: Vec<ToolContent> = response
                    .content
                    .into_iter()
                    .filter_map(|item| match &*item {
                        rmcp::model::RawContent::Text(text_content) => Some(ToolContent::Text {
                            text: text_content.text.clone(),
                        }),
                        rmcp::model::RawContent::Image(image_content) => Some(ToolContent::Image {
                            data: image_content.data.clone(),
                            mime_type: image_content.mime_type.clone(),
                        }),
                        rmcp::model::RawContent::Resource(embedded_resource) => {
                            match &embedded_resource.resource {
                                rmcp::model::ResourceContents::TextResourceContents {
                                    uri,
                                    mime_type,
                                    text,
                                    ..
                                } => Some(ToolContent::Resource {
                                    uri: uri.clone(),
                                    mime_type: mime_type.clone(),
                                    text: Some(text.clone()),
                                    blob: None,
                                }),
                                rmcp::model::ResourceContents::BlobResourceContents {
                                    uri,
                                    mime_type,
                                    blob,
                                    ..
                                } => Some(ToolContent::Resource {
                                    uri: uri.clone(),
                                    mime_type: mime_type.clone(),
                                    text: None,
                                    blob: Some(blob.clone()),
                                }),
                            }
                        }
                        _ => None,
                    })
                    .collect();

                let is_error = response.is_error.unwrap_or(false);

                Ok(McpToolCallResponse {
                    success: !is_error,
                    content,
                    is_error,
                })
            }
            Err(e) => {
                let err_msg = format!("Failed to call tool: {}", e);
                error!("{}", err_msg);
                Err(err_msg)
            }
        }
    }

    /// 获取客户端当前状态。
    pub async fn get_status(&self) -> ServerStatus {
        let status = self.status.lock().await;
        status.clone()
    }

    /// 获取当前错误信息（如有）。
    pub async fn get_error(&self) -> Option<String> {
        let error = self.error.lock().await;
        error.clone()
    }

    /// 获取服务器信息。
    pub async fn get_server_info(&self) -> Result<(String, String), String> {
        let service = self.service.read().await;
        let service = service
            .as_ref()
            .ok_or_else(|| "Service not connected".to_string())?;

        let peer_info = service.peer().peer_info();
        if let Some(init_result) = peer_info {
            Ok((
                init_result.server_info.name.to_string(),
                init_result.server_info.version.to_string(),
            ))
        } else {
            Err("Server info not available".to_string())
        }
    }

    /// 设置客户端状态。
    async fn set_status(&self, status: ServerStatus) {
        let mut current_status = self.status.lock().await;
        *current_status = status;
    }

    /// 设置错误信息。
    async fn set_error(&self, error: String) {
        let mut current_error = self.error.lock().await;
        *current_error = Some(error);
    }

    /// 清除错误信息。
    async fn clear_error(&self) {
        let mut current_error = self.error.lock().await;
        *current_error = None;
    }
}
