// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 内置工具原生命令。

use crate::core::built_in_tools::{
    self, BashExecutionRegistry, BuiltInBashEvent, BuiltInBashExecutionRequest,
    BuiltInBashExecutionResponse, BuiltInBashStreamChunk,
};
use crate::core::observability::trace::{current_trace, scope_trace, with_traceparent};
use tauri::{
    ipc::{Channel, JavaScriptChannelId},
    Runtime, State, Webview,
};

/// 执行内置 Bash 工具请求。
///
/// 命令层保持薄封装，避免把参数校验、平台分支和进程生命周期管理
/// 散落到 Tauri 注册入口；真正的执行流程统一收口到核心层。
///
/// 执行前会自动释放嵌入的 rg / rtk 二进制并追加到 PATH，
/// 使模型可以直接在 bash 中调用 `rg` / `rtk`。
#[tauri::command]
pub async fn built_in_tools_execute_bash<R: Runtime>(
    request: BuiltInBashExecutionRequest,
    registry: State<'_, BashExecutionRegistry>,
    webview: Webview<R>,
    stream: Option<JavaScriptChannelId>,
    traceparent: Option<String>,
) -> Result<BuiltInBashExecutionResponse, String> {
    with_traceparent(traceparent, "builtin.bash.execute", async move {
        let stream_channel: Option<Channel<BuiltInBashStreamChunk>> =
            stream.map(|channel_id| channel_id.channel_on(webview));
        built_in_tools::execute_bash(request, registry.inner(), stream_channel).await
    })
    .await
}

#[tauri::command]
pub async fn built_in_tools_start_bash<R: Runtime>(
    request: BuiltInBashExecutionRequest,
    registry: State<'_, BashExecutionRegistry>,
    webview: Webview<R>,
    events: JavaScriptChannelId,
    traceparent: Option<String>,
) -> Result<bool, String> {
    with_traceparent(traceparent, "builtin.bash.start", async move {
        let trace = current_trace();
        let event_channel: Channel<BuiltInBashEvent> = events.channel_on(webview.clone());
        let stream_channel = {
            let event_channel = event_channel.clone();
            Channel::new(move |body| {
                let chunk = body.deserialize::<BuiltInBashStreamChunk>()?;
                event_channel.send(BuiltInBashEvent::Chunk {
                    execution_id: chunk.execution_id,
                    stream: chunk.stream,
                    chunk: chunk.chunk,
                })?;
                Ok(())
            })
        };
        let registry = registry.inner().clone();
        tauri::async_runtime::spawn(async move {
            let execution_id = request.execution_id.clone();
            let execute = async move {
                match built_in_tools::execute_bash(request, &registry, Some(stream_channel)).await {
                    Ok(response) => {
                        if let Err(error) = event_channel.send(BuiltInBashEvent::Completed {
                            execution_id,
                            response,
                        }) {
                            log::warn!("Failed to send completed bash event: {}", error);
                        }
                    }
                    Err(error) => {
                        if let Err(send_error) = event_channel.send(BuiltInBashEvent::Failed {
                            execution_id,
                            error,
                        }) {
                            log::warn!("Failed to send failed bash event: {}", send_error);
                        }
                    }
                }
            };
            if let Some(trace) = trace {
                scope_trace(trace, execute).await;
            } else {
                execute.await;
            }
        });

        Ok(true)
    })
    .await
}

/// 取消一条正在执行中的内置 Bash 请求。
#[tauri::command]
pub fn built_in_tools_cancel_bash(
    execution_id: String,
    registry: State<'_, BashExecutionRegistry>,
) -> Result<bool, String> {
    Ok(registry.cancel(&execution_id))
}
