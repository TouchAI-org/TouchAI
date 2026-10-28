/** OpenTelemetry-compatible field names used by local logs and future telemetry. */
export const ATTR = {
    traceId: 'trace_id',
    spanId: 'span_id',
    window: 'window',
    providerName: 'gen_ai.provider.name',
    requestModel: 'gen_ai.request.model',
    responseModel: 'gen_ai.response.model',
    conversationId: 'gen_ai.conversation.id',
    toolCallId: 'gen_ai.tool.call.id',
    toolName: 'gen_ai.tool.name',
    mcpServerId: 'mcp.server.id',
    turnId: 'touchai.turn.id',
    attempt: 'touchai.attempt',
    errorCode: 'error.code',
    httpStatus: 'http.response.status_code',
    retryable: 'retryable',
    durationMs: 'duration_ms',
} as const;
