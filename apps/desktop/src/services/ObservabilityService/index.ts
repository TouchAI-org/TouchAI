import { native } from '@services/NativeService';
import { getCurrentWindow } from '@tauri-apps/api/window';

import {
    installConsoleInterceptor,
    reportLoggingFailure,
    restoreConsoleInterceptor,
} from './console';
import { LogQueue } from './queue';
import { redactAttributes, redactText } from './redact';
import {
    LOG_LEVEL_NUMBERS,
    type LogAttributeValue,
    type LogEnvelope,
    type LogLevelName,
} from './types';

let queue: LogQueue | null = null;
let windowLabel: string | null = null;
let initialized = false;
let visibilityListenerInstalled = false;
let shutdownFlushInstalled = false;

/** 关闭前等待日志落盘的上限；后端卡住时不能让窗口关不掉。 */
const SHUTDOWN_FLUSH_TIMEOUT_MS = 800;

function resolveWindowLabel(): string | null {
    if (windowLabel) return windowLabel;
    try {
        windowLabel = getCurrentWindow().label;
    } catch {
        windowLabel = null;
    }
    return windowLabel;
}

/** 初始化一次；重复调用不会重置队列或重复安装监听。 */
export function initObservability(): void {
    if (initialized) return;
    initialized = true;
    resolveWindowLabel();

    queue = new LogQueue({
        send: (batch) => native.observability.ingest(batch),
        // 日志后端不可用时不能让业务路径抛出，也不重试，避免形成循环。
        onError: reportLoggingFailure,
    });
    queue.start();
    installConsoleInterceptor(emit);

    if (!visibilityListenerInstalled && typeof document !== 'undefined') {
        visibilityListenerInstalled = true;
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                void flushObservability();
            }
        });
        window.addEventListener('pagehide', () => {
            void flushObservability();
        });
    }

    installShutdownFlush();
}

/**
 * 窗口关闭前把队列刷完。WebView 销毁后 IPC 不再可用，只靠 pagehide 不保证送达。
 */
function installShutdownFlush(): void {
    if (shutdownFlushInstalled) return;
    shutdownFlushInstalled = true;

    void (async () => {
        try {
            const currentWindow = getCurrentWindow();
            await currentWindow.onCloseRequested(async (event) => {
                event.preventDefault();
                try {
                    await Promise.race([
                        flushObservability(),
                        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS)),
                    ]);
                } catch (error) {
                    reportLoggingFailure(error);
                }
                try {
                    await currentWindow.destroy();
                } catch (error) {
                    reportLoggingFailure(error);
                }
            });
        } catch {
            // 非 Tauri 环境（测试、浏览器预览）没有关闭钩子。
        }
    })();
}

/** 记录一条结构化事件。未初始化时静默丢弃，避免启动早期产生副作用。 */
export function emit(
    level: LogLevelName,
    event: string,
    attrs: Record<string, LogAttributeValue> = {},
    msg?: string
): void {
    if (!queue) return;

    const envelope: LogEnvelope = {
        level: LOG_LEVEL_NUMBERS[level],
        event,
        window: resolveWindowLabel() ?? undefined,
        msg: msg ? redactText(msg) : undefined,
        attrs: redactAttributes(attrs),
    };
    queue.push(envelope);
}

export async function flushObservability(): Promise<void> {
    await queue?.flush();
}

function stringifyArg(arg: unknown): string {
    if (arg instanceof Error) return arg.stack ?? arg.message;
    if (typeof arg === 'string') return arg;

    try {
        return JSON.stringify(arg) ?? String(arg);
    } catch {
        return String(arg);
    }
}

function isAttributeBag(value: unknown): value is Record<string, LogAttributeValue> {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        !(value instanceof Error)
    );
}

function writeConsoleStyle(level: LogLevelName, args: unknown[]): void {
    if (args.length === 0) {
        emit(level, 'app.log');
        return;
    }

    const last = args[args.length - 1];
    const bag = isAttributeBag(last) ? last : null;
    const messageArgs = bag ? args.slice(0, -1) : args;
    const attrs: Record<string, LogAttributeValue> = {};

    if (bag) {
        for (const [key, value] of Object.entries(bag)) {
            if (
                typeof value === 'string' ||
                typeof value === 'number' ||
                typeof value === 'boolean'
            ) {
                attrs[key] = value;
            }
        }
    }

    emit(level, 'app.log', attrs, messageArgs.map(stringifyArg).join(' '));
}

/**
 * 服务层日志入口。签名与 console 一致，最后一个普通对象会作为结构化字段。
 * 事件名固定为 `app.log`；需要具名事件时用 `obs.event`。
 */
export const log = {
    trace: (...args: unknown[]) => writeConsoleStyle('trace', args),
    debug: (...args: unknown[]) => writeConsoleStyle('debug', args),
    info: (...args: unknown[]) => writeConsoleStyle('info', args),
    warn: (...args: unknown[]) => writeConsoleStyle('warn', args),
    error: (...args: unknown[]) => writeConsoleStyle('error', args),
} as const;

export function observabilityQueueSize(): number {
    return queue?.size() ?? 0;
}

/** 仅用于测试：把模块状态复位，便于验证初始化和丢弃策略。 */
export function resetObservabilityForTests(): void {
    queue?.stop();
    queue = null;
    windowLabel = null;
    initialized = false;
    visibilityListenerInstalled = false;
    shutdownFlushInstalled = false;
    restoreConsoleInterceptor();
}
