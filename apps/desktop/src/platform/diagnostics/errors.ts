import { ATTR } from './attributes';
import type { LogAttributeValue } from './types';

export const OBSERVABILITY_ERROR_CODES = [
    'provider.auth',
    'provider.rate_limited',
    'provider.bad_request',
    'provider.context_length',
    'provider.unavailable',
    'network.offline',
    'network.timeout',
    'request.cancelled',
    'tool.denied',
    'tool.timeout',
    'tool.failed',
    'mcp.connect_failed',
    'mcp.protocol',
    'mcp.process_exited',
    'app.startup_failed',
    'app.update_failed',
    'unknown',
] as const;

export type ObservabilityErrorCode = (typeof OBSERVABILITY_ERROR_CODES)[number];

const LEGACY_CODE_MAP: Record<string, ObservabilityErrorCode> = {
    INVALID_API_KEY: 'provider.auth',
    UNAUTHORIZED: 'provider.auth',
    RATE_LIMIT: 'provider.rate_limited',
    API_ERROR: 'provider.bad_request',
    NETWORK_ERROR: 'network.offline',
    TIMEOUT: 'network.timeout',
    REQUEST_CANCELLED: 'request.cancelled',
    SERVICE_UNAVAILABLE: 'provider.unavailable',
    BAD_GATEWAY: 'provider.unavailable',
    GATEWAY_TIMEOUT: 'network.timeout',
    EMPTY_RESPONSE: 'provider.unavailable',
    STREAM_ERROR: 'provider.unavailable',
    UNSUPPORTED_INPUT: 'provider.bad_request',
    INVALID_CONFIG: 'provider.bad_request',
    MISSING_ENDPOINT: 'provider.bad_request',
    MCP_CONNECTION_FAILED: 'mcp.connect_failed',
    MCP_TOOL_TIMEOUT: 'tool.timeout',
    MCP_TOOL_EXECUTION_FAILED: 'tool.failed',
};

/** Classify once at the event boundary so logs and future telemetry share one vocabulary. */
export function classifyError(error: unknown): ObservabilityErrorCode {
    if (error && typeof error === 'object' && 'code' in error) {
        const code = String(error.code);
        if (code in LEGACY_CODE_MAP) {
            return LEGACY_CODE_MAP[code]!;
        }
        if (OBSERVABILITY_ERROR_CODES.includes(code as ObservabilityErrorCode)) {
            return code as ObservabilityErrorCode;
        }
    }

    const message = error instanceof Error ? error.message : String(error);
    if (/abort|cancel|取消/i.test(message)) return 'request.cancelled';
    if (/timeout|timed out|超时/i.test(message)) return 'network.timeout';
    // 状态码按整段匹配：`port 14290 refused` 不是 429。
    if (/rate.?limit|\b429\b/i.test(message)) return 'provider.rate_limited';
    if (/unauthori[sz]ed|forbidden|api.?key|\b40[13]\b/i.test(message)) return 'provider.auth';
    if (/mcp/i.test(message)) return 'mcp.connect_failed';
    if (/fetch|network|offline/i.test(message)) return 'network.offline';
    return 'unknown';
}

export function errorAttributes(
    error: unknown,
    code: ObservabilityErrorCode = classifyError(error)
): Record<string, LogAttributeValue> {
    const cause =
        error && typeof error === 'object' && 'cause' in error
            ? (error as { cause?: unknown }).cause
            : undefined;
    const name = error instanceof Error ? error.name : typeof error;
    return {
        [ATTR.errorCode]: code,
        'error.type': cause instanceof Error ? cause.name : name,
    };
}
