// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! MCP (Model Context Protocol) 模块。
//!
//! 该模块基于官方 rmcp SDK 提供 MCP 客户端功能。
//! 支持 stdio、SSE 和 HTTP 传输方式。

mod client;
mod client_manager;
pub mod types;

pub use client_manager::McpClientManager;
pub use types::*;
