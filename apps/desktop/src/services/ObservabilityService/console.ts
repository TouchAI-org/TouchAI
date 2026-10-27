import type { LogAttributeValue, LogLevelName } from './types';

type ConsoleMethod = (...args: unknown[]) => void;
type InterceptableLevel = Extract<LogLevelName, 'warn' | 'error'>;

const MAX_ARGUMENT_LENGTH = 2048;

const initialConsole: Record<InterceptableLevel, ConsoleMethod> = {
    warn: console.warn.bind(console),
    error: console.error.bind(console),
};

let installed = false;
let previousConsole: Record<InterceptableLevel, ConsoleMethod> | null = null;

function stringifyArgument(value: unknown): string {
    if (value instanceof Error) {
        return value.stack ?? `${value.name}: ${value.message}`;
    }
    if (typeof value === 'string') {
        return value;
    }

    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

function describeArguments(args: unknown[]): string {
    return args
        .map((argument) => stringifyArgument(argument).slice(0, MAX_ARGUMENT_LENGTH))
        .join(' ');
}

/**
 * Third-party code can still call console directly. Only warnings and errors are
 * mirrored into the structured log; lower levels stay local to the WebView.
 */
export function installConsoleInterceptor(
    emit: (
        level: LogLevelName,
        event: string,
        attrs?: Record<string, LogAttributeValue>,
        msg?: string
    ) => void
): void {
    if (installed) return;
    installed = true;
    previousConsole = {
        warn: console.warn.bind(console),
        error: console.error.bind(console),
    };

    for (const level of ['warn', 'error'] as const) {
        console[level] = (...args: unknown[]) => {
            previousConsole?.[level](...args);
            emit(
                level,
                'external.console',
                {
                    'external.level': level,
                    'external.argument_count': args.length,
                },
                describeArguments(args)
            );
        };
    }
}

/** Internal failures must not go back through the interceptor and recurse. */
export function reportLoggingFailure(error: unknown): void {
    (previousConsole?.error ?? initialConsole.error)(
        '[Observability] failed to send log batch',
        error
    );
}

/** Restores the original methods so tests and teardown leave the WebView untouched. */
export function restoreConsoleInterceptor(): void {
    if (!installed || !previousConsole) return;
    console.warn = previousConsole.warn;
    console.error = previousConsole.error;
    previousConsole = null;
    installed = false;
}
