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
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

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

        // 在 Windows 上通过 cmd.exe 包装命令，以支持 PATH 查找
        // （如 npx、node、python 等）。对于绝对路径会多一层 shell，
        // 但开销可忽略，且简化了处理逻辑。
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

        // 从命令创建传输
        let transport = TokioChildProcess::new(cmd).map_err(|e| {
            let err_msg = format!("Failed to create transport: {}", e);
            error!("{}", err_msg);
            err_msg
        })?;

        self.store_service_and_set_connected(
            ().serve(transport).await.map_err(|e| e.to_string()),
            "stdio",
        )
        .await
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
                let err_msg = format!("Failed to connect via {}: {}", transport_name, e);
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
                                    text,
                                    ..
                                } => Some(ToolContent::Resource {
                                    uri: uri.clone(),
                                    text: Some(text.clone()),
                                    blob: None,
                                }),
                                rmcp::model::ResourceContents::BlobResourceContents {
                                    uri,
                                    blob,
                                    ..
                                } => Some(ToolContent::Resource {
                                    uri: uri.clone(),
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
