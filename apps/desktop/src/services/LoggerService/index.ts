import { native } from '@services/NativeService';
import { getCurrentWindow } from '@tauri-apps/api/window';

import {
    type ConsoleLevel,
    DEFAULT_LOGGER_CONFIG,
    inferCategoryFromArgs,
    LOG_LEVEL_VALUES,
    type LogCategory,
    type LoggerConfig,
    type LogLevel,
    normalizeLogFields,
    shouldForwardLog,
} from './policy';

type ConsoleMethod = (...args: unknown[]) => void;

interface Callsite {
    location?: string;
    file?: string;
    line?: number;
}

interface LogOptions {
    category?: LogCategory;
    fields?: Record<string, unknown>;
}

type StructuredLoggerMethod = (...args: unknown[]) => void;

const TAURI_LOG_LEVELS: Record<LogLevel, number> = LOG_LEVEL_VALUES;

const NATIVE_CONSOLE: Record<ConsoleLevel, ConsoleMethod> = {
    trace: console.trace.bind(console),
    debug: console.debug.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    log: console.log.bind(console),
} as const;

let initialized = false;
let cachedWindowLabel: string | null = null;
let loggerConfig: LoggerConfig = DEFAULT_LOGGER_CONFIG;

export function configureLogger(config: LoggerConfig): void {
    loggerConfig = config;
}

const getWindowLabel = (): string | null => {
    if (cachedWindowLabel) {
        return cachedWindowLabel;
    }

    try {
        cachedWindowLabel = getCurrentWindow().label;
        return cachedWindowLabel;
    } catch {
        return null;
    }
};

const stringifyArg = (arg: unknown): string => {
    if (arg instanceof Error) {
        return arg.toString();
    }

    if (typeof arg === 'string') {
        return arg;
    }

    try {
        return JSON.stringify(arg);
    } catch {
        return String(arg);
    }
};

const formatMessage = (args: readonly unknown[]): string => args.map(stringifyArg).join(' ');

const normalizeFilePath = (raw: string): string => {
    const sanitized = raw.replace(/[()]/g, '').split('?')[0]?.split('#')[0] ?? raw;

    try {
        return new URL(sanitized).pathname.replace(/^\/+/, '');
    } catch {
        return sanitized;
    }
};

const isLoggerFile = (file: string): boolean =>
    file.replace(/\\/g, '/').endsWith('src/services/LoggerService/index.ts');

const parseStackLine = (line: string): Callsite | null => {
    const stackPatterns = [
        /at\s+(?:(.+?)\s+\()?(.+):(\d+):(\d+)\)?$/,
        /^(?:(.*?)@)?(.+):(\d+):(\d+)$/,
    ] as const;

    for (const pattern of stackPatterns) {
        const match = line.match(pattern);
        if (!match) {
            continue;
        }

        const [, , fileRaw, lineRaw, columnRaw] = match;
        const file = normalizeFilePath(fileRaw ?? '');
        if (!file || isLoggerFile(file)) {
            return null;
        }

        const lineNum = Number(lineRaw);
        if (Number.isNaN(lineNum)) {
            return null;
        }

        const column = Number(columnRaw);
        const locationPath = `${file}:${lineNum}:${Number.isNaN(column) ? 0 : column}`;
        const label = getWindowLabel();
        const location = label ? `${label}|${locationPath}` : locationPath;

        return { location, file, line: lineNum };
    }

    return null;
};

const extractCallsite = (): Callsite | undefined => {
    const stack = new Error().stack;
    if (!stack) {
        return undefined;
    }

    for (const line of stack.split('\n').slice(1)) {
        const callsite = parseStackLine(line.trim());
        if (callsite) {
            return callsite;
        }
    }

    return undefined;
};

function isPlainFields(value: unknown): value is Record<string, unknown> {
    return (
        typeof value === 'object' &&
        value !== null &&
        !(value instanceof Error) &&
        Object.getPrototypeOf(value) === Object.prototype
    );
}

function consumeTrailingFields(args: readonly unknown[]): {
    messageArgs: readonly unknown[];
    fields: Record<string, unknown> | undefined;
} {
    const lastArg = args.length > 0 ? args[args.length - 1] : undefined;
    if (!isPlainFields(lastArg)) {
        return {
            messageArgs: args,
            fields: undefined,
        };
    }

    return {
        messageArgs: args.slice(0, -1),
        fields: lastArg,
    };
}

const forwardToTauri = (
    level: LogLevel,
    args: readonly unknown[],
    category: LogCategory,
    fields: Record<string, unknown> | undefined,
    callsite?: Callsite
): void => {
    const payload = {
        level: TAURI_LOG_LEVELS[level],
        message: formatMessage(args),
        location: callsite?.location,
        file: callsite?.file,
        line: callsite?.line,
        keyValues: normalizeLogFields({
            ...fields,
            category,
        }),
    };

    void native.log.log(payload).catch((error: unknown) => {
        NATIVE_CONSOLE.error('[Logger] Failed to forward log to Tauri:', error);
    });
};

const writeLog = (
    level: LogLevel,
    fallback: ConsoleLevel,
    args: readonly unknown[],
    options: LogOptions = {}
): void => {
    NATIVE_CONSOLE[fallback](...args);

    const category = options.category ?? inferCategoryFromArgs(args);
    if (!shouldForwardLog({ level, category, config: loggerConfig })) {
        return;
    }

    const callsite = loggerConfig.includeCallsite ? extractCallsite() : undefined;
    forwardToTauri(level, args, category, options.fields, callsite);
};

const createLogMethod = (level: LogLevel, fallback: ConsoleLevel): ConsoleMethod => {
    return (...args: unknown[]) => {
        writeLog(level, fallback, args);
    };
};

function createStructuredMethod(level: LogLevel, fallback: ConsoleLevel, category: LogCategory) {
    const method: StructuredLoggerMethod = (...args: unknown[]) => {
        const { messageArgs, fields } = consumeTrailingFields(args);
        writeLog(level, fallback, messageArgs, {
            category,
            fields,
        });
    };

    return method;
}

export const initializeLogger = (): void => {
    if (initialized) {
        return;
    }

    initialized = true;

    console.trace = createLogMethod('trace', 'trace');
    console.debug = createLogMethod('debug', 'debug');
    console.info = createLogMethod('info', 'info');
    console.warn = createLogMethod('warn', 'warn');
    console.error = createLogMethod('error', 'error');
    console.log = createLogMethod('info', 'log');
};

export function createLogger(category: LogCategory) {
    return {
        trace: createStructuredMethod('trace', 'trace', category),
        debug: createStructuredMethod('debug', 'debug', category),
        info: createStructuredMethod('info', 'info', category),
        warn: createStructuredMethod('warn', 'warn', category),
        error: createStructuredMethod('error', 'error', category),
    } as const;
}

export const logger = createLogger('unknown');
export const index = logger;
