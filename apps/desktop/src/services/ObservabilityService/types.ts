export type LogLevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export type LogAttributeValue = string | number | boolean;

/** 前端到 Rust 的线上格式。字段名与 `LogEnvelope` 的 camelCase 反序列化一致。 */
export interface LogEnvelope {
    ts: number;
    level: 1 | 2 | 3 | 4 | 5;
    event: string;
    window?: string;
    traceId?: string;
    spanId?: string;
    msg?: string;
    attrs: Record<string, LogAttributeValue>;
}

export const LOG_LEVEL_NUMBERS: Record<LogLevelName, 1 | 2 | 3 | 4 | 5> = {
    trace: 1,
    debug: 2,
    info: 3,
    warn: 4,
    error: 5,
} as const;
