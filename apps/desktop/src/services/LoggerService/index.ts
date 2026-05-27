import { native } from '@services/NativeService';
import { getCurrentWindow } from '@tauri-apps/api/window';

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
type ConsoleLevel = LogLevel | 'log';
type ConsoleMethod = (...args: unknown[]) => void;

interface Callsite {
    location?: string; // 格式: "窗口标签|文件:行:列" 或 "文件:行:列"
    file?: string; // 标准化后的文件路径
    line?: number; // 源文件行号
}

/** 日志级别到 Tauri 插件数字级别的映射 */
const TAURI_LOG_LEVELS: Record<LogLevel, number> = {
    trace: 1,
    debug: 2,
    info: 3,
    warn: 4,
    error: 5,
} as const;

/** 保存原始 console 方法（在打补丁之前） */
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

/**
 * 获取当前 Tauri 窗口标签（首次调用后会缓存）
 * @returns 窗口标签，如果不可用则返回 null
 */
const getWindowLabel = (): string | null => {
    if (cachedWindowLabel) return cachedWindowLabel;

    try {
        cachedWindowLabel = getCurrentWindow().label;
        return cachedWindowLabel;
    } catch {
        return null;
    }
};

/**
 * 将任意值转换为字符串用于日志记录
 * - Error 对象: 返回堆栈跟踪或错误消息
 * - 字符串: 原样返回
 * - 对象: JSON 序列化
 * - 其他: 转换为字符串
 */
const stringifyArg = (arg: unknown): string => {
    if (arg instanceof Error) return arg.stack ?? arg.message;
    if (typeof arg === 'string') return arg;

    try {
        return JSON.stringify(arg);
    } catch {
        return String(arg);
    }
};

/**
 * 将多个日志参数格式化为单个消息字符串
 */
const formatMessage = (args: unknown[]): string => args.map(stringifyArg).join(' ');

// ============================================================================
// 文件路径标准化
// ============================================================================

/**
 * 标准化堆栈跟踪中的文件路径
 * - 移除括号、查询参数、哈希片段
 * - 从完整 URL 中提取路径名
 */
const normalizeFilePath = (raw: string): string => {
    // 移除噪音: 括号、查询参数、哈希片段
    const sanitized = raw.replace(/[()]/g, '').split('?')[0]?.split('#')[0] ?? raw;

    // 尝试解析为 URL 并提取路径名
    try {
        return new URL(sanitized).pathname.replace(/^\/+/, '');
    } catch {
        return sanitized;
    }
};

/**
 * 检查文件路径是否是 logger 本身（避免无限递归）
 */
const isLoggerFile = (file: string): boolean =>
    file.replace(/\\/g, '/').endsWith('src/services/LoggerService/logger.ts');

/**
 * 解析单行堆栈跟踪以提取调用位置信息
 * 支持 V8 (Chrome/Node) 和 JSC (Safari) 两种堆栈格式
 *
 * @param line - Error.stack 中的单行
 * @returns 调用位置信息，如果行无效或应跳过则返回 null
 */
const parseStackLine = (line: string): Callsite | null => {
    const STACK_PATTERNS = [
        /at\s+(?:(.+?)\s+\()?(.+):(\d+):(\d+)\)?$/, // V8 引擎 (Chrome, Node.js)
        /^(?:(.*?)@)?(.+):(\d+):(\d+)$/, // JavaScriptCore 引擎 (Safari)
    ] as const;

    // 尝试每个正则表达式模式直到匹配
    for (const pattern of STACK_PATTERNS) {
        const match = line.match(pattern);
        if (!match) continue;

        // 提取文件路径并标准化
        const [, , fileRaw, lineRaw, columnRaw] = match;
        const file = normalizeFilePath(fileRaw ?? '');

        // 跳过无效文件或 logger 本身
        if (!file || isLoggerFile(file)) return null;

        // 解析行号
        const lineNum = Number(lineRaw);
        if (Number.isNaN(lineNum)) return null;

        // 构建位置字符串: "文件:行:列"
        const column = Number(columnRaw);
        const locationPath = `${file}:${lineNum}:${Number.isNaN(column) ? 0 : column}`;

        // 如果可用，添加窗口标签前缀: "窗口标签|文件:行:列"
        const label = getWindowLabel();
        const location = label ? `${label}|${locationPath}` : locationPath;

        return { location, file, line: lineNum };
    }

    return null;
};

/**
 * 从当前堆栈跟踪中提取调用位置
 *
 * @returns 调用位置信息，如果未找到有效调用位置则返回 undefined
 */
const extractCallsite = (): Callsite | undefined => {
    const stack = new Error().stack;
    if (!stack) return undefined;

    // 跳过第一行（Error 消息）并解析剩余行
    for (const line of stack.split('\n').slice(1)) {
        const callsite = parseStackLine(line.trim());
        if (callsite) return callsite;
    }

    return undefined;
};

// ============================================================================
// Tauri 集成
// ============================================================================

/**
 * 将日志消息转发到 Tauri 后端日志插件
 *
 * @param level - 日志级别 (trace/debug/info/warn/error)
 * @param args - 要记录的参数
 * @param callsite - 可选的源位置信息
 */
const forwardToTauri = (level: LogLevel, args: unknown[], callsite?: Callsite): void => {
    const payload = {
        level: TAURI_LOG_LEVELS[level],
        message: formatMessage(args),
        location: callsite?.location,
        file: callsite?.file,
        line: callsite?.line,
    };

    void native.log.log(payload).catch((error: unknown) => {
        NATIVE_CONSOLE.error('[Logger] 转发日志到 Tauri 失败:', error);
    });
};

/**
 * 创建新console方法，新增日志转发功能
 *
 * @param level - Tauri 日志级别
 * @param fallback - 要调用的原始 console 方法
 */
const createLogMethod = (level: LogLevel, fallback: ConsoleLevel): ConsoleMethod => {
    return (...args: unknown[]) => {
        NATIVE_CONSOLE[fallback](...args);
        forwardToTauri(level, args, extractCallsite());
    };
};

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 替换 console 方法初始化 logger
 * 应在应用启动时调用一次
 */
export const initializeLogger = (): void => {
    if (initialized) return;

    initialized = true;

    console.trace = createLogMethod('trace', 'trace');
    console.debug = createLogMethod('debug', 'debug');
    console.info = createLogMethod('info', 'info');
    console.warn = createLogMethod('warn', 'warn');
    console.error = createLogMethod('error', 'error');
    console.log = createLogMethod('info', 'log');
};

/**
 * 类型化的 logger 接口（可替代直接使用 console.*）
 * 提供与打补丁的 console 方法相同的功能
 */
export const index = {
    trace: (...args: unknown[]) => console.trace(...args),
    debug: (...args: unknown[]) => console.debug(...args),
    info: (...args: unknown[]) => console.info(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
} as const;
