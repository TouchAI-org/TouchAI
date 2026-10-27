// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Stable error codes shared with the frontend observability contract.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    #[serde(rename = "provider.auth")]
    ProviderAuth,
    #[serde(rename = "provider.rate_limited")]
    ProviderRateLimited,
    #[serde(rename = "provider.bad_request")]
    ProviderBadRequest,
    #[serde(rename = "provider.context_length")]
    ProviderContextLength,
    #[serde(rename = "provider.unavailable")]
    ProviderUnavailable,
    #[serde(rename = "network.offline")]
    NetworkOffline,
    #[serde(rename = "network.timeout")]
    NetworkTimeout,
    #[serde(rename = "request.cancelled")]
    RequestCancelled,
    #[serde(rename = "tool.denied")]
    ToolDenied,
    #[serde(rename = "tool.timeout")]
    ToolTimeout,
    #[serde(rename = "tool.failed")]
    ToolFailed,
    #[serde(rename = "mcp.connect_failed")]
    McpConnectFailed,
    #[serde(rename = "mcp.protocol")]
    McpProtocol,
    #[serde(rename = "mcp.process_exited")]
    McpProcessExited,
    #[serde(rename = "app.startup_failed")]
    AppStartupFailed,
    #[serde(rename = "app.update_failed")]
    AppUpdateFailed,
    #[serde(rename = "unknown")]
    Unknown,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_gets_the_same_error_code_vocabulary_as_the_frontend() {
        assert_eq!(
            serde_json::to_string(&ErrorCode::ProviderRateLimited).expect("serialize"),
            "\"provider.rate_limited\""
        );
        assert_eq!(
            serde_json::to_string(&ErrorCode::McpConnectFailed).expect("serialize"),
            "\"mcp.connect_failed\""
        );
    }
}
