// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 基于 rmcp SDK 的 MCP 客户端实现。

use super::redact::{http_connect_message, stdio_actual_command_message, stdio_connect_message};
use super::types::*;
use log::{debug, error, info, warn};
use reqwest as mcp_reqwest;
use rmcp::{
    model::{CallToolRequest, CallToolRequestParams, CallToolResult, ClientRequest, ServerResult},
    service::{PeerRequestOptions, RunningService, ServiceError, ServiceExt},
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, ConfigureCommandExt,
        StreamableHttpClientTransport, TokioChildProcess,
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
        info!("{}", stdio_connect_message(self.server_id, &command, &args));

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
            "{}",
            stdio_actual_command_message(self.server_id, &actual_command, &actual_args)
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

    /// 通过 HTTP 传输连接到 MCP 服务器（Streamable HTTP）。
    pub async fn connect_http(
        &self,
        url: String,
        headers: Option<HashMap<String, String>>,
    ) -> Result<(), String> {
        info!("{}", http_connect_message(self.server_id, &url));

        self.set_status(ServerStatus::Connecting).await;
        self.clear_error().await;

        let http_client = Self::build_http_client(headers)?;

        // 创建 Streamable HTTP 传输
        let url_str: Arc<str> = url.into();
        let transport = StreamableHttpClientTransport::with_client(
            http_client,
            StreamableHttpClientTransportConfig::with_uri(url_str),
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

    /// 构建带可选请求头且与 rmcp transport 兼容的 HTTP 客户端。
    fn build_http_client(
        headers: Option<HashMap<String, String>>,
    ) -> Result<mcp_reqwest::Client, String> {
        let mut client_builder = mcp_reqwest::Client::builder();

        if let Some(header_map) = headers {
            let mut header_values = mcp_reqwest::header::HeaderMap::new();
            for (key, value) in header_map {
                if let (Ok(name), Ok(val)) = (
                    mcp_reqwest::header::HeaderName::from_bytes(key.as_bytes()),
                    mcp_reqwest::header::HeaderValue::from_str(&value),
                ) {
                    header_values.insert(name, val);
                } else {
                    warn!("Skipping invalid header: {}", key);
                    debug!("Invalid header value length: {}", value.len());
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
                    let (name, version) = peer_info
                        .server_info
                        .as_ref()
                        .map(|info| (info.name.as_str(), info.version.as_str()))
                        .unwrap_or(("<unknown>", "<unknown>"));
                    info!("Server info: name={name}, version={version}");
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
    ///
    /// 传入 `timeout_ms` 时，超时由 rmcp 的请求级超时负责：到点会向服务器发送
    /// `notifications/cancelled` 并返回超时错误，避免本地已判定超时、远端却仍在
    /// 执行造成副作用重复。
    pub async fn call_tool(
        &self,
        tool_name: String,
        arguments: serde_json::Value,
        timeout_ms: Option<u64>,
    ) -> Result<McpToolCallResponse, String> {
        let service = self.service.read().await;
        let service = service
            .as_ref()
            .ok_or_else(|| "Service not connected".to_string())?;

        // 将参数转换为 JsonObject
        let params = if let Some(args_obj) = arguments.as_object().cloned() {
            CallToolRequestParams::new(tool_name).with_arguments(args_obj)
        } else {
            CallToolRequestParams::new(tool_name)
        };

        // 调用工具
        match Self::dispatch_call(service, params, timeout_ms).await {
            Ok(response) => {
                // 转换内容
                let content: Vec<ToolContent> = response
                    .content
                    .into_iter()
                    .filter_map(|item| match &item {
                        rmcp::model::ContentBlock::Text(text_content) => Some(ToolContent::Text {
                            text: text_content.text.clone(),
                        }),
                        rmcp::model::ContentBlock::Image(image_content) => {
                            Some(ToolContent::Image {
                                data: image_content.data.clone(),
                                mime_type: image_content.mime_type.clone(),
                            })
                        }
                        rmcp::model::ContentBlock::Resource(embedded_resource) => {
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
                                _ => None,
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
                // dispatch_call 已把错误格式化成可读信息，这里只负责记录并透传。
                error!("{}", e);
                Err(e)
            }
        }
    }

    /// 按是否给出超时选择调用路径。
    ///
    /// 有超时时走 rmcp 的请求级超时（到点会向服务器发送取消通知）；否则沿用默认的
    /// `call_tool`。两条路径都只发送单轮 `tools/call` 请求，与改动前一致。
    async fn dispatch_call(
        service: &McpService,
        params: CallToolRequestParams,
        timeout_ms: Option<u64>,
    ) -> Result<CallToolResult, String> {
        match timeout_ms.filter(|ms| *ms > 0) {
            Some(ms) => {
                let request = ClientRequest::CallToolRequest(CallToolRequest::new(params));
                let options = PeerRequestOptions::with_timeout(Duration::from_millis(ms));
                let response = service
                    .peer()
                    .send_request_with_option(request, options)
                    .await
                    .map_err(Self::format_call_error)?
                    .await_response()
                    .await
                    .map_err(Self::format_call_error)?;

                match response {
                    ServerResult::CallToolResult(result) => Ok(result),
                    other => Err(format!("Unexpected MCP tool response: {:?}", other)),
                }
            }
            None => service
                .peer()
                .call_tool(params)
                .await
                .map_err(Self::format_call_error),
        }
    }

    /// 统一把 rmcp 调用错误格式化成可读信息；超时给出稳定文案，便于前端识别。
    fn format_call_error(error: ServiceError) -> String {
        match error {
            ServiceError::Timeout { timeout } => {
                format!("Tool execution timed out ({}ms)", timeout.as_millis())
            }
            other => format!("Failed to call tool: {}", other),
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
            let info = init_result
                .server_info
                .as_ref()
                .ok_or_else(|| "Server info not available".to_string())?;
            Ok((info.name.clone(), info.version.clone()))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_call_error_maps_timeout_to_a_stable_message() {
        let message = McpClient::format_call_error(ServiceError::Timeout {
            timeout: Duration::from_millis(1500),
        });

        assert_eq!(message, "Tool execution timed out (1500ms)");
    }

    #[test]
    fn format_call_error_keeps_the_generic_prefix_for_other_errors() {
        let message = McpClient::format_call_error(ServiceError::TransportClosed);

        assert!(message.starts_with("Failed to call tool:"));
    }

    // A server that fails to start reports through stderr. The message has to carry that text,
    // because it is the only clue about why the server died.

    #[test]
    fn user_gets_the_server_stderr_when_it_is_the_only_detail() {
        let message = McpClient::merge_stdio_error(
            Some("server crashed on startup".to_string()),
            "connection closed".to_string(),
        );

        assert!(message.contains("server crashed on startup"));
        assert!(message.contains("Connection error"));
        assert!(message.contains("connection closed"));
    }

    #[test]
    fn user_does_not_get_the_same_text_repeated_when_stderr_already_has_it() {
        let message = McpClient::merge_stdio_error(
            Some("failed: connection closed".to_string()),
            "connection closed".to_string(),
        );

        assert_eq!(message, "failed: connection closed");
    }

    #[test]
    fn user_gets_the_error_alone_when_the_server_wrote_nothing() {
        assert_eq!(
            McpClient::merge_stdio_error(None, "connection closed".to_string()),
            "connection closed"
        );
    }

    #[test]
    fn user_gets_the_error_alone_when_the_server_stderr_was_empty() {
        assert_eq!(
            McpClient::merge_stdio_error(Some(String::new()), "connection closed".to_string()),
            "connection closed"
        );
    }

    #[test]
    fn user_gets_a_client_built_without_headers() {
        McpClient::build_http_client(None).expect("a plain client builds");
    }

    /// Serve one request on a loopback port and report the headers it received.
    fn capture_request_headers() -> (u16, std::thread::JoinHandle<Vec<(String, String)>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
        let port = listener.local_addr().expect("local addr").port();
        let handle = std::thread::spawn(move || {
            use std::io::{BufRead, BufReader, Write};

            let (stream, _) = listener.accept().expect("accept one request");
            let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
            let mut headers = Vec::new();
            let mut line = String::new();
            reader.read_line(&mut line).expect("read request line");
            loop {
                line.clear();
                if reader.read_line(&mut line).expect("read header") == 0 {
                    break;
                }
                let trimmed = line.trim_end();
                if trimmed.is_empty() {
                    break;
                }
                if let Some((name, value)) = trimmed.split_once(':') {
                    headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
                }
            }
            let mut stream = stream;
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .expect("write response");
            headers
        });
        (port, handle)
    }

    #[test]
    fn user_gets_their_configured_headers_sent_with_each_request() {
        let (port, server) = capture_request_headers();
        let mut headers = HashMap::new();
        headers.insert("x-api-key".to_string(), "secret".to_string());
        let client = McpClient::build_http_client(Some(headers)).expect("a client builds");

        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        runtime
            .block_on(async {
                client
                    .get(format!("http://127.0.0.1:{port}/mcp"))
                    .send()
                    .await
            })
            .expect("the request reaches the server");

        let received = server.join().expect("server thread");
        assert!(
            received
                .iter()
                .any(|(name, value)| name == "x-api-key" && value == "secret"),
            "the configured header did not arrive: {received:?}"
        );
    }

    #[test]
    fn user_does_not_get_an_invalid_header_sent_or_the_connection_blocked() {
        let (port, server) = capture_request_headers();
        let mut headers = HashMap::new();
        headers.insert("x-good".to_string(), "ok".to_string());
        // A header name with a space is not a legal header name.
        headers.insert("x bad".to_string(), "nope".to_string());
        let client = McpClient::build_http_client(Some(headers)).expect("a client builds");

        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        runtime
            .block_on(async {
                client
                    .get(format!("http://127.0.0.1:{port}/mcp"))
                    .send()
                    .await
            })
            .expect("one bad header must not block the connection");

        let received = server.join().expect("server thread");
        assert!(
            received
                .iter()
                .any(|(name, value)| name == "x-good" && value == "ok"),
            "the valid header did not arrive: {received:?}"
        );
        assert!(
            !received.iter().any(|(name, _)| name.contains(' ')),
            "an invalid header was sent: {received:?}"
        );
    }

    #[test]
    fn user_sees_a_disconnected_server_before_any_connect() {
        let client = McpClient::new(1, "test".to_string());

        assert_eq!(
            tokio::runtime::Runtime::new()
                .expect("runtime")
                .block_on(client.get_status()),
            ServerStatus::Disconnected
        );
    }

    #[test]
    fn user_sees_no_error_before_any_connect() {
        let client = McpClient::new(1, "test".to_string());

        assert_eq!(
            tokio::runtime::Runtime::new()
                .expect("runtime")
                .block_on(client.get_error()),
            None
        );
    }
}
