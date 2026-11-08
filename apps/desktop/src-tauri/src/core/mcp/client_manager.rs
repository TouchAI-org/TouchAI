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

                warn!(
                    "Legacy SSE transport is unavailable in the upgraded MCP SDK; attempting Streamable HTTP for server {}",
                    config.id
                );
                client.connect_http(url, headers).await
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
    /// 在短读锁内取出客户端句柄，锁在等待 RPC 前释放。
    ///
    /// 连接/断开需要写锁；如果读锁跨 RPC 持有，写操作会被在途请求阻塞，
    /// 后续读操作也会在写锁后排队。
    async fn client_snapshot(&self, server_id: i64) -> Result<Arc<McpClient>, String> {
        let clients = self.clients.read().await;
        clients
            .get(&server_id)
            .cloned()
            .ok_or_else(|| format!("Server {server_id} not found"))
    }

    pub async fn list_tools(&self, server_id: i64) -> Result<Vec<McpToolDefinition>, String> {
        let client = self.client_snapshot(server_id).await?;
        client.list_tools().await
    }

    /// 调用服务器上的工具。
    ///
    /// `timeout_ms` 透传给客户端，由 rmcp 的请求级超时负责在到点时取消远端调用。
    pub async fn call_tool(
        &self,
        server_id: i64,
        tool_name: String,
        arguments: serde_json::Value,
        timeout_ms: Option<u64>,
    ) -> Result<McpToolCallResponse, String> {
        let client = self.client_snapshot(server_id).await?;
        client.call_tool(tool_name, arguments, timeout_ms).await
    }

    /// 获取服务器状态。
    pub async fn get_server_status(&self, server_id: i64) -> Result<ServerStatusInfo, String> {
        let client = self.client_snapshot(server_id).await?;

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
        // 一次读锁内取快照，随后在锁外逐个查询，避免慢服务阻塞连接/断开。
        let clients: Vec<(i64, Arc<McpClient>)> = {
            let clients = self.clients.read().await;
            clients
                .iter()
                .map(|(&id, client)| (id, client.clone()))
                .collect()
        };
        let mut statuses = Vec::with_capacity(clients.len());

        for (server_id, client) in clients {
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

    /// 批量获取所有服务器状态（兼容 Result 返回）。
    pub async fn get_all_server_statuses_result(&self) -> Result<Vec<ServerStatusInfo>, String> {
        Ok(self.get_all_server_statuses().await)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio_config_without_command() -> McpServerConfig {
        McpServerConfig {
            id: 1,
            name: "misconfigured".to_string(),
            transport_type: TransportType::Stdio,
            command: None,
            args: None,
            env: None,
            cwd: None,
            url: None,
            headers: None,
            enabled: true,
            tool_timeout: 30_000,
        }
    }

    fn http_config_without_url() -> McpServerConfig {
        McpServerConfig {
            transport_type: TransportType::Http,
            ..stdio_config_without_command()
        }
    }

    // The settings page asks for every server's status while it loads, before any connection
    // exists. These tests pin how an unknown id answers, which needs no live server.

    #[tokio::test]
    async fn user_gets_a_clear_error_when_the_server_is_unknown() {
        let manager = McpClientManager::new();

        let error = manager
            .get_server_status(42)
            .await
            .expect_err("an unknown server must not report a status");

        assert_eq!(error, "Server 42 not found");
    }

    #[tokio::test]
    async fn user_gets_a_clear_error_when_listing_tools_of_an_unknown_server() {
        let manager = McpClientManager::new();

        let error = manager
            .list_tools(7)
            .await
            .expect_err("an unknown server must not list tools");

        assert_eq!(error, "Server 7 not found");
    }

    #[tokio::test]
    async fn user_gets_a_clear_error_when_calling_a_tool_on_an_unknown_server() {
        let manager = McpClientManager::new();

        let error = manager
            .call_tool(7, "search".to_string(), serde_json::json!({}), None)
            .await
            .expect_err("an unknown server must not accept a tool call");

        assert_eq!(error, "Server 7 not found");
    }

    #[tokio::test]
    async fn user_gets_a_clear_error_when_disconnecting_an_unknown_server() {
        let manager = McpClientManager::new();

        let error = manager
            .disconnect_server(9)
            .await
            .expect_err("an unknown server must not be disconnected");

        assert_eq!(error, "Server 9 not found");
    }

    #[tokio::test]
    async fn user_sees_no_connected_servers_before_any_connect() {
        let manager = McpClientManager::new();

        assert!(manager.get_all_servers().await.is_empty());
        assert!(manager.get_all_server_statuses().await.is_empty());
        assert!(manager
            .get_all_server_statuses_result()
            .await
            .expect("an empty manager is not an error")
            .is_empty());
    }

    #[tokio::test]
    async fn user_can_disconnect_everything_when_nothing_is_connected() {
        let manager = McpClientManager::new();

        // Shutdown runs unconditionally, so it must survive an empty registry.
        manager
            .disconnect_all()
            .await
            .expect("disconnecting nothing is not an error");
    }

    #[tokio::test]
    async fn user_gets_an_error_when_a_stdio_server_has_no_command() {
        let manager = McpClientManager::new();

        let error = manager
            .connect_server(stdio_config_without_command())
            .await
            .expect_err("a stdio server without a command cannot start");

        assert!(
            error.contains("Command is required"),
            "unexpected error for a missing command: {error}"
        );
    }

    #[tokio::test]
    async fn user_gets_an_error_when_an_http_server_has_no_url() {
        let manager = McpClientManager::new();

        let error = manager
            .connect_server(http_config_without_url())
            .await
            .expect_err("an HTTP server without a URL cannot connect");

        assert!(
            error.contains("URL is required"),
            "unexpected error for a missing url: {error}"
        );
    }

    #[tokio::test]
    async fn user_does_not_see_a_server_whose_transport_refused_the_connection() {
        let manager = McpClientManager::new();
        // A valid URL on a closed loopback port: validation passes and the transport fails.
        let mut config = http_config_without_url();
        config.url = Some("http://127.0.0.1:9/mcp".to_string());

        let result = manager.connect_server(config).await;

        assert!(
            result.is_err(),
            "connecting to a closed port must not report success"
        );
        // A server that never connected must not linger in the registry.
        assert!(manager.get_all_servers().await.is_empty());
    }
    async fn insert_client(manager: &McpClientManager, server_id: i64) {
        manager.clients.write().await.insert(
            server_id,
            Arc::new(McpClient::new(server_id, "demo".into())),
        );
    }

    // 连接/断开需要写锁；读锁不能跨 RPC 持有，否则在途请求会阻塞写锁。
    #[tokio::test]
    async fn server_status_queries_release_the_map_lock_before_waiting() {
        let manager = Arc::new(McpClientManager::new());
        insert_client(&manager, 7).await;

        // 持有客户端状态锁，模拟一个在途 RPC，使状态查询停在 await 上。
        let client = manager.client_snapshot(7).await.expect("client");
        let status_guard = client.lock_status_for_test().await;

        let pending = tokio::spawn({
            let manager = Arc::clone(&manager);
            async move { manager.get_all_server_statuses().await }
        });

        for _ in 0..16 {
            tokio::task::yield_now().await;
        }

        assert!(manager.clients.try_write().is_ok());

        drop(status_guard);
        let statuses = pending.await.expect("join");
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].server_id, 7);
    }

    #[tokio::test]
    async fn single_server_status_releases_the_map_lock_before_waiting() {
        let manager = Arc::new(McpClientManager::new());
        insert_client(&manager, 7).await;

        let client = manager.client_snapshot(7).await.expect("client");
        let status_guard = client.lock_status_for_test().await;

        let pending = tokio::spawn({
            let manager = Arc::clone(&manager);
            async move { manager.get_server_status(7).await }
        });

        for _ in 0..16 {
            tokio::task::yield_now().await;
        }

        assert!(manager.clients.try_write().is_ok());

        drop(status_guard);
        let status = pending.await.expect("join").expect("status");
        assert_eq!(status.server_id, 7);
    }
}
