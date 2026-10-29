// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Bounded MCP stderr retention shared with diagnostic bundles.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tokio::sync::Mutex as AsyncMutex;

pub(crate) const MAX_STDERR_BYTES: usize = 64 * 1024;

pub(crate) type SharedBuffer = Arc<AsyncMutex<Vec<u8>>>;

fn buffers() -> &'static Mutex<HashMap<i64, SharedBuffer>> {
    static BUFFERS: OnceLock<Mutex<HashMap<i64, SharedBuffer>>> = OnceLock::new();
    BUFFERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn buffer_for(server_id: i64) -> SharedBuffer {
    let mut buffers = buffers()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(
        buffers
            .entry(server_id)
            .or_insert_with(|| Arc::new(AsyncMutex::new(Vec::new()))),
    )
}

/// 单次连接尝试专用的缓冲。
///
/// per-server 历史保留所有尝试的输出供诊断包使用；连接失败时报告的错误文本
/// 只应包含本次尝试的输出，否则会带上更早一次会话的 stderr。
pub(crate) fn attempt_buffer() -> SharedBuffer {
    Arc::new(AsyncMutex::new(Vec::new()))
}

/// Keep the latest bytes from a long-running process without blocking its stderr pipe.
pub(crate) fn append_chunk(buffer: &mut Vec<u8>, chunk: &[u8]) {
    if chunk.len() >= MAX_STDERR_BYTES {
        buffer.clear();
        buffer.extend_from_slice(&chunk[chunk.len() - MAX_STDERR_BYTES..]);
        return;
    }

    let overflow = buffer
        .len()
        .saturating_add(chunk.len())
        .saturating_sub(MAX_STDERR_BYTES);
    if overflow > 0 {
        buffer.drain(..overflow);
    }
    buffer.extend_from_slice(chunk);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StderrSnapshot {
    pub server_id: i64,
    pub bytes: usize,
    pub content: String,
}

pub(crate) async fn snapshots() -> Vec<StderrSnapshot> {
    let entries = {
        let buffers = buffers()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        buffers
            .iter()
            .map(|(server_id, buffer)| (*server_id, Arc::clone(buffer)))
            .collect::<Vec<_>>()
    };

    let mut snapshots = Vec::with_capacity(entries.len());
    for (server_id, buffer) in entries {
        let bytes = buffer.lock().await;
        let raw = String::from_utf8_lossy(&bytes);
        snapshots.push(StderrSnapshot {
            server_id,
            bytes: bytes.len(),
            content: super::super::mcp::redact_stderr(&raw),
        });
    }
    snapshots.sort_by_key(|snapshot| snapshot.server_id);
    snapshots
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn user_gets_bounded_stderr_for_each_mcp_server() {
        let buffer = buffer_for(7);
        buffer.lock().await.extend_from_slice(b"server failed");

        let snapshots = snapshots().await;

        assert!(snapshots.iter().any(|snapshot| {
            snapshot.server_id == 7 && snapshot.content.contains("server failed")
        }));
    }

    #[test]
    fn user_gets_the_latest_stderr_when_the_buffer_wraps() {
        let mut buffer = Vec::new();
        append_chunk(&mut buffer, &vec![b'a'; MAX_STDERR_BYTES]);
        append_chunk(&mut buffer, b"tail");

        assert_eq!(buffer.len(), MAX_STDERR_BYTES);
        assert!(buffer.ends_with(b"tail"));
        assert_eq!(buffer[0], b'a');
    }
}
