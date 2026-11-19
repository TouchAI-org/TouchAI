import type { LogAttributeValue, LogLevelName } from '@/platform/diagnostics/types';

interface EarlyError {
    level: LogLevelName;
    event: string;
    attrs: Record<string, LogAttributeValue>;
    msg: string;
}

type EarlyErrorSink = (entry: EarlyError) => void;

const MAX_EARLY_ERRORS = 100;
const buffer: EarlyError[] = [];
let sink: EarlyErrorSink | null = null;
let stopListeners: (() => void) | null = null;

function describe(value: unknown): string {
    if (value instanceof Error) {
        return value.stack ?? `${value.name}: ${value.message}`;
    }
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

function capture(entry: EarlyError): void {
    if (sink) {
        sink(entry);
        return;
    }
    if (buffer.length < MAX_EARLY_ERRORS) {
        buffer.push(entry);
    }
}

export function installEarlyErrors(): void {
    if (stopListeners || typeof window === 'undefined') return;
    const onError = (event: ErrorEvent) => {
        capture({
            level: 'error',
            event: 'app.early-error',
            attrs: {
                'error.source': event.filename || 'unknown',
                'error.line': event.lineno || 0,
                'error.column': event.colno || 0,
            },
            msg: describe(event.error ?? event.message),
        });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
        capture({
            level: 'error',
            event: 'app.unhandled-rejection',
            attrs: {},
            msg: describe(event.reason),
        });
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    stopListeners = () => {
        window.removeEventListener('error', onError);
        window.removeEventListener('unhandledrejection', onRejection);
        stopListeners = null;
    };
}

/** Install the structured logger and replay anything captured before bootstrap. */
export function attachEarlyErrorSink(nextSink: EarlyErrorSink): void {
    sink = nextSink;
    for (const entry of buffer.splice(0)) {
        sink(entry);
    }
}

export function resetEarlyErrorsForTests(): void {
    stopListeners?.();
    sink = null;
    buffer.length = 0;
}
