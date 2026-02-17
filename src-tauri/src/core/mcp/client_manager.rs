// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! MCP 客户端管理器 - 管理多个 MCP 客户端连接。

use super::client::McpClient;
use super::types::*;
use log::{error, info, warn};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// 管理多个 MCP 客户端连接。
pub struct McpClientManager {
    clients: Arc<RwLock<HashMap<i64, Arc<McpClient>>>>,
}

impl McpClientManager {
    /// 创建新的 MCP 客户端管理器。
    pub fn new() -> Self {
        Self {
            clients: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 连接到 MCP 服务器。
    pub async fn connect_server(&self, config: McpServerConfig) -> Result<(), String> {
        info!("Connecting to MCP server: {} ({})", config.name, config.id);

        // 创建客户端
        let client = Arc::new(McpClient::new(config.id, config.name.clone()));

        // 根据传输类型连接
        let result = match config.transport_type {
            TransportType::Stdio => {
                let command = config
                    .command
                    .ok_or_else(|| "Command is required for stdio transport".to_string())?;
                let args = config.args.unwrap_or_default();
                let env = config.env;
                let cwd = config.cwd;

                client.connect_stdio(command, args, env, cwd).await
            }
            TransportType::Sse => {
                let url = config
                    .url
                    .ok_or_else(|| "URL is required for SSE transport".to_string())?;
                let headers = config.headers;

                // 先尝试 Streamable HTTP（许多原 SSE 服务器已迁移到此协议），
                // 若失败则回退到传统 SSE
                let http_result = client.connect_http(url.clone(), headers.clone()).await;
                if http_result.is_err() {
                    warn!(
                        "Streamable HTTP failed for server {}, falling back to legacy SSE: {:?}",
                        config.id,
                        http_result.as_ref().err()
                    );
                    // 重建客户端以重置状态
                    let client_new = Arc::new(McpClient::new(config.id, config.name.clone()));
                    let sse_result = client_new.connect_sse(url, headers).await;
                    if sse_result.is_ok() {
                        // 回退成功，使用新客户端
                        let mut clients = self.clients.write().await;
                        clients.insert(config.id, client_new);
                        return Ok(());
                    }
                    warn!(
                        "Legacy SSE also failed for server {}: {:?}",
                        config.id,
                        sse_result.as_ref().err()
                    );
                    // 两者均失败，返回 Streamable HTTP 错误（更常见的协议）
                    http_result
                } else {
                    http_result
                }
            }
            TransportType::Http => {
                let url = config
                    .url
                    .ok_or_else(|| "URL is required for HTTP transport".to_string())?;
                let headers = config.headers;

                client.connect_http(url, headers).await
            }
        };

        match &result {
            Ok(()) => {
                // 仅在连接成功后保存客户端
                let mut clients = self.clients.write().await;
                clients.insert(config.id, client);
            }
            Err(e) => {
                error!("Failed to connect to server {}: {}", config.id, e);
            }
        }

        result
    }

    /// 断开 MCP 服务器连接。
    pub async fn disconnect_server(&self, server_id: i64) -> Result<(), String> {
        info!("Disconnecting from MCP server: {}", server_id);

        let client = {
            let clients = self.clients.read().await;
            clients
                .get(&server_id)
                .cloned()
                .ok_or_else(|| format!("Server {} not found", server_id))?
        };

        client.disconnect().await?;

        // 从映射中移除
        {
            let mut clients = self.clients.write().await;
            clients.remove(&server_id);
        }

        Ok(())
    }

    /// 列出服务器的工具。
    pub async fn list_tools(&self, server_id: i64) -> Result<Vec<McpToolDefinition>, String> {
        let clients = self.clients.read().await;
        let client = clients
            .get(&server_id)
            .ok_or_else(|| format!("Server {} not found", server_id))?;

        client.list_tools().await
    }

    /// 调用服务器上的工具。
    pub async fn call_tool(
        &self,
        server_id: i64,
        tool_name: String,
        arguments: serde_json::Value,
    ) -> Result<McpToolCallResponse, String> {
        let clients = self.clients.read().await;
        let client = clients
            .get(&server_id)
            .ok_or_else(|| format!("Server {} not found", server_id))?;

        client.call_tool(tool_name, arguments).await
    }

    /// 获取服务器状态。
    pub async fn get_server_status(&self, server_id: i64) -> Result<ServerStatusInfo, String> {
        let clients = self.clients.read().await;
        let client = clients
            .get(&server_id)
            .ok_or_else(|| format!("Server {} not found", server_id))?;

        let status = client.get_status().await;
        let error = client.get_error().await;
        let version = if status == ServerStatus::Connected {
            client.get_server_info().await.ok().map(|(_, v)| v)
        } else {
            None
        };

        Ok(ServerStatusInfo {
            server_id,
            status,
            error,
            version,
        })
    }

    /// 获取所有已连接的服务器。
    #[allow(dead_code)]
    pub async fn get_all_servers(&self) -> Vec<i64> {
        let clients = self.clients.read().await;
        clients.keys().copied().collect()
    }

    /// 批量获取所有服务器状态。
    pub async fn get_all_server_statuses(&self) -> Vec<ServerStatusInfo> {
        let clients = self.clients.read().await;
        let mut statuses = Vec::new();

        for (&server_id, client) in clients.iter() {
            let status = client.get_status().await;
            let error = client.get_error().await;
            let version = if status == ServerStatus::Connected {
                client.get_server_info().await.ok().map(|(_, v)| v)
            } else {
                None
            };

            statuses.push(ServerStatusInfo {
                server_id,
                status,
                error,
                version,
            });
        }

        statuses
    }

    /// 断开所有服务器连接。
    pub async fn disconnect_all(&self) -> Result<(), String> {
        info!("Disconnecting all MCP servers");

        let server_ids: Vec<i64> = {
            let clients = self.clients.read().await;
            clients.keys().copied().collect()
        };

        for server_id in server_ids {
            if let Err(e) = self.disconnect_server(server_id).await {
                warn!("Failed to disconnect server {}: {}", server_id, e);
            }
        }

        Ok(())
    }
}

impl Default for McpClientManager {
    fn default() -> Self {
        Self::new()
    }
}
