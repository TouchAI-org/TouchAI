export const LOG_LEVEL_VALUES = {
    trace: 1,
    debug: 2,
    info: 3,
    warn: 4,
    error: 5,
} as const;

export type LogLevel = keyof typeof LOG_LEVEL_VALUES;
export type ConsoleLevel = LogLevel | 'log';

export const LOG_CATEGORIES = [
    'lifecycle',
    'search',
    'window',
    'resize',
    'startup',
    'database',
    'agent',
    'mcp',
    'settings',
    'rendering',
    'performance',
    'diagnostics',
    'popup',
    'notification',
    'scheduler',
    'quick-search',
    'built-in-tools',
    'unknown',
] as const;

export type LogCategory = (typeof LOG_CATEGORIES)[number];

export interface LoggerConfig {
    defaultLevel: LogLevel;
    categoryLevels: Partial<Record<LogCategory, LogLevel>>;
    includeCallsite: boolean;
    forwardToNative: boolean;
}

export interface ShouldForwardLogInput {
    level: LogLevel;
    category: LogCategory;
    config?: LoggerConfig;
}

const NORMALIZED_FIELD_VALUE_LIMIT = 128;

const SENSITIVE_FIELD_NAMES = new Set([
    'apiKey',
    'api_key',
    'authorization',
    'content',
    'fileContent',
    'password',
    'prompt',
    'secret',
    'token',
]);

const PREFIX_CATEGORY_MAP: Array<[RegExp, LogCategory]> = [
    [/^\[SearchView\]/, 'search'],
    [/^\[SearchKeyboardRouter\]/, 'search'],
    [/^\[SearchBar\]/, 'search'],
    [/^\[QuickSearchPanel\]/, 'quick-search'],
    [/^\[McpManager\]/, 'mcp'],
    [/^\[McpStore\]/, 'mcp'],
    [/^\[McpToolsView\]/, 'mcp'],
    [/^\[PopupManager\]/, 'popup'],
    [/^\[TrayMenu\]/, 'window'],
    [/^\[SettingsView\]/, 'settings'],
    [/^\[Database\]/, 'database'],
    [/^\[AiRequestExecutor\]/, 'agent'],
    [/^\[AiConversationRuntime\]/, 'agent'],
    [/^\[SessionTaskCenter\]/, 'agent'],
    [/^\[BuiltInToolService\]/, 'built-in-tools'],
    [/^\[TaskScheduler\]/, 'scheduler'],
    [/^\[NotificationService\]/, 'notification'],
    [/^\[Logger\]/, 'diagnostics'],
];

export const DEFAULT_LOGGER_CONFIG: LoggerConfig = {
    defaultLevel: 'warn',
    categoryLevels: {
        lifecycle: 'info',
        diagnostics: 'warn',
    },
    includeCallsite: false,
    forwardToNative: true,
};

export function createDiagnosticLoggerConfig(): LoggerConfig {
    return {
        defaultLevel: 'debug',
        categoryLevels: {
            performance: 'debug',
            resize: 'debug',
            search: 'debug',
            window: 'debug',
        },
        includeCallsite: true,
        forwardToNative: true,
    };
}

export function resolveLogThreshold(category: LogCategory, config = DEFAULT_LOGGER_CONFIG): number {
    const level = config.categoryLevels[category] ?? config.defaultLevel;
    return LOG_LEVEL_VALUES[level];
}

export function shouldForwardLog(input: ShouldForwardLogInput): boolean {
    const config = input.config ?? DEFAULT_LOGGER_CONFIG;
    if (!config.forwardToNative) {
        return false;
    }

    return LOG_LEVEL_VALUES[input.level] >= resolveLogThreshold(input.category, config);
}

export function inferCategoryFromArgs(args: readonly unknown[]): LogCategory {
    const first = args[0];
    if (typeof first !== 'string') {
        return 'unknown';
    }

    for (const [pattern, category] of PREFIX_CATEGORY_MAP) {
        if (pattern.test(first)) {
            return category;
        }
    }

    return 'unknown';
}

export function normalizeLogFields(fields: Record<string, unknown> = {}): Record<string, string> {
    const normalized: Record<string, string> = {};

    for (const [key, value] of Object.entries(fields)) {
        if (SENSITIVE_FIELD_NAMES.has(key)) {
            continue;
        }

        if (value === undefined || value === null) {
            continue;
        }

        const stringValue =
            typeof value === 'string'
                ? value
                : typeof value === 'number' || typeof value === 'boolean'
                  ? String(value)
                  : '[object]';

        normalized[key] =
            stringValue.length > NORMALIZED_FIELD_VALUE_LIMIT
                ? stringValue.slice(0, NORMALIZED_FIELD_VALUE_LIMIT)
                : stringValue;
    }

    return normalized;
}
