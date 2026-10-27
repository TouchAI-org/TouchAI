// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! W3C trace context parsing and task-local propagation for IPC commands.

use std::future::Future;

use tracing::Instrument;

tokio::task_local! {
    static CURRENT_TRACE: TraceContext;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TraceContext {
    pub trace_id: String,
    pub span_id: String,
}

impl TraceContext {
    fn parse(traceparent: &str) -> Option<Self> {
        let mut parts = traceparent.split('-');
        let version = parts.next()?;
        let trace_id = parts.next()?;
        let parent_span_id = parts.next()?;
        let flags = parts.next()?;
        if parts.next().is_some()
            || version != "00"
            || flags.len() != 2
            || !is_lower_hex(flags)
            || !is_hex_id(trace_id, 32)
            || !is_hex_id(parent_span_id, 16)
            || trace_id.bytes().all(|byte| byte == b'0')
            || parent_span_id.bytes().all(|byte| byte == b'0')
        {
            return None;
        }

        Some(Self {
            trace_id: trace_id.to_string(),
            span_id: next_span_id(),
        })
    }
}

fn is_lower_hex(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn is_hex_id(value: &str, length: usize) -> bool {
    value.len() == length && is_lower_hex(value)
}

fn next_span_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..16].to_string()
}

/// Run a command future under a parsed trace context.
///
/// Invalid or missing traceparents leave the command unchanged. The local
/// context is what lets the log formatter add matching ids without requiring
/// every call site to pass them through manually.
pub(crate) async fn with_traceparent<F, T>(
    traceparent: Option<String>,
    operation: &'static str,
    future: F,
) -> T
where
    F: Future<Output = T>,
{
    let Some(traceparent) = traceparent else {
        return future.await;
    };
    let Some(trace) = TraceContext::parse(&traceparent) else {
        return future.await;
    };
    let span = tracing::info_span!(
        "ipc.command",
        operation,
        trace_id = %trace.trace_id,
        span_id = %trace.span_id
    );

    CURRENT_TRACE.scope(trace, future.instrument(span)).await
}

pub(crate) fn current_trace() -> Option<TraceContext> {
    CURRENT_TRACE.try_with(Clone::clone).ok()
}

/// Scope work spawned from a command so it keeps the originating trace.
pub(crate) async fn scope_trace<F, T>(trace: TraceContext, future: F) -> T
where
    F: Future<Output = T>,
{
    CURRENT_TRACE.scope(trace, future).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_gets_a_valid_traceparent_parsed_with_a_fresh_child_span() {
        let trace = TraceContext::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
            .expect("valid traceparent");

        assert_eq!(trace.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
        assert_eq!(trace.span_id.len(), 16);
    }

    #[test]
    fn user_does_not_accept_a_malformed_traceparent() {
        assert!(TraceContext::parse("00-short-00f067aa0ba902b7-01").is_none());
        assert!(
            TraceContext::parse("00-00000000000000000000000000000000-00f067aa0ba902b7-01")
                .is_none()
        );
        assert!(
            TraceContext::parse("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
                .is_none()
        );
    }

    #[tokio::test]
    async fn user_gets_the_command_trace_available_inside_the_future() {
        let traceparent =
            Some("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01".to_string());

        let trace = with_traceparent(traceparent, "test.command", async {
            current_trace().expect("trace context")
        })
        .await;

        assert_eq!(trace.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
    }

    #[tokio::test]
    async fn user_does_not_get_an_invented_trace_for_a_malformed_traceparent() {
        let traceparent = Some("00-short-00f067aa0ba902b7-01".to_string());

        let trace = with_traceparent(traceparent, "test.command", async { current_trace() }).await;

        assert!(trace.is_none());
    }
}
