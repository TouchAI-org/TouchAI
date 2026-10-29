import { native } from '@services/NativeService';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { attachEarlyErrorSink, resetEarlyErrorsForTests } from '@/utils/early-errors';

import { ATTR } from './attributes';
import {
    installConsoleInterceptor,
    reportLoggingFailure,
    restoreConsoleInterceptor,
} from './console';
import { errorAttributes } from './errors';
import {
    OBSERVABILITY_EVENTS,
    type ObservabilityEventAttributes,
    type ObservabilityEventName,
    validateEventAttributes,
} from './events';
import { LogQueue } from './queue';
import { redactAttributes, redactText } from './redact';
import { activeSpanContext, initTracing, resetTracingForTests } from './tracing';
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
let flushUnlisten: UnlistenFn | null = null;

/** 关闭前等待日志落盘的上限；后端卡住时不能让窗口关不掉。 */
const SHUTDOWN_FLUSH_TIMEOUT_MS = 800;
/** Rust 在退出前发出的刷盘事件，覆盖托盘退出和更新重启。 */
export const QUIT_FLUSH_EVENT = 'obs://flush';

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
    initTracing();
    resolveWindowLabel();

    queue = new LogQueue({
        send: (batch) => native.observability.ingest(batch),
        // 日志后端不可用时不能让业务路径抛出，也不重试，避免形成循环。
        onError: reportLoggingFailure,
    });
    queue.start();
    installConsoleInterceptor(emit);
    attachEarlyErrorSink(({ level, event: name, attrs, msg }) => emit(level, name, attrs, msg));
    event('app.start', { [ATTR.window]: resolveWindowLabel() ?? 'unknown' });

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
 *
 * 关闭钩子同步注册：放进异步 IIFE 会让启动后极短时间内的关闭丢掉监听。
 * 托盘退出和更新重启不触发窗口关闭，改由 Rust 的退出事件补齐。
 */
function installShutdownFlush(): void {
    if (shutdownFlushInstalled) return;
    shutdownFlushInstalled = true;

    try {
        const currentWindow = getCurrentWindow();
        void currentWindow
            .onCloseRequested(async (event) => {
                event.preventDefault();
                await flushBeforeExit();
                try {
                    await currentWindow.destroy();
                } catch (error) {
                    reportLoggingFailure(error);
                }
            })
            .catch(reportLoggingFailure);

        void listen(QUIT_FLUSH_EVENT, async () => {
            await flushBeforeExit();
            try {
                await native.observability.flushDone(resolveWindowLabel() ?? 'unknown');
            } catch (error) {
                reportLoggingFailure(error);
            }
        })
            .then((unlisten) => {
                flushUnlisten = unlisten;
            })
            .catch(() => {
                // 非 Tauri 环境（测试、浏览器预览）没有事件总线。
            });
    } catch {
        // 非 Tauri 环境（测试、浏览器预览）没有关闭钩子。
    }
}

/** 有上限地刷一次队列；后端卡住时也要让退出继续。 */
async function flushBeforeExit(): Promise<void> {
    try {
        await Promise.race([
            queue?.flushWithRetry() ?? Promise.resolve(),
            new Promise((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS)),
        ]);
    } catch (error) {
        reportLoggingFailure(error);
    }
}

/** 记录一条结构化事件。未初始化时静默丢弃，避免启动早期产生副作用。 */
export function emit(
    level: LogLevelName,
    event: string,
    attrs: Record<string, LogAttributeValue> = {},
    msg?: string
): void {
    if (!queue) return;

    const spanContext = activeSpanContext();
    const envelope: LogEnvelope = {
        level: LOG_LEVEL_NUMBERS[level],
        event,
        window: resolveWindowLabel() ?? undefined,
        traceId: spanContext?.traceId,
        spanId: spanContext?.spanId,
        msg: msg ? redactText(msg) : undefined,
        attrs: redactAttributes(attrs),
    };
    queue.push(envelope);
}

/** Emit a typed critical event; schemas are checked in development and tests. */
export function event<T extends ObservabilityEventName>(
    name: T,
    attrs: ObservabilityEventAttributes<T>,
    msg?: string
): void {
    if (!isValidEvent(name, attrs)) return;
    const definition = OBSERVABILITY_EVENTS[name];
    emit(definition.level, name, attrs, msg);
}

export function error(
    name: ObservabilityEventName,
    cause: unknown,
    attrs: Record<string, string | number | boolean> = {},
    msg?: string
): void {
    const enriched = { ...attrs, ...errorAttributes(cause) };
    if (!isValidEvent(name, enriched)) return;
    emit(OBSERVABILITY_EVENTS[name].level, name, enriched, msg);
}

/**
 * Logging must never break the caller. A schema mismatch drops the typed event,
 * records a content-free marker, and leaves the business path untouched.
 */
function isValidEvent(
    name: ObservabilityEventName,
    attrs: Record<string, string | number | boolean>
): boolean {
    try {
        validateEventAttributes(name, attrs);
        return true;
    } catch {
        emit('error', 'obs.schema.invalid', { 'obs.event': name });
        return false;
    }
}

export async function flushObservability(): Promise<void> {
    await queue?.flush();
}

function stringifyArg(arg: unknown): string {
    if (arg instanceof Error) return describeError(arg);
    if (typeof arg === 'string') return arg;

    try {
        return JSON.stringify(arg) ?? String(arg);
    } catch {
        return String(arg);
    }
}

/**
 * 错误只保留第一行消息和调用帧。
 *
 * provider 和工具的报错经常把整个响应体塞进 `message`，原样落盘会把对话内容和
 * 工具输出写进日志，也会跟着诊断包一起外发。
 */
function describeError(error: Error): string {
    const firstLine = (error.message.split('\n')[0] ?? '').trim();
    const summary = `${error.name}: ${firstLine}`;
    const stack = error.stack ?? '';
    // V8 的 stack 以 `name: message` 开头（message 可能多行），WebKit 只有调用帧。
    // 按值定位 message，避免在 WebKit 上把第一帧当成消息删掉。
    const messageEnd =
        error.message && stack.includes(error.message)
            ? stack.indexOf(error.message) + error.message.length
            : 0;
    const frames = stack
        .slice(messageEnd)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line !== error.name)
        .slice(0, 20)
        .join('\n');

    return frames ? `${summary}\n${frames}` : summary;
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
    flushUnlisten?.();
    flushUnlisten = null;
    queue = null;
    windowLabel = null;
    initialized = false;
    visibilityListenerInstalled = false;
    shutdownFlushInstalled = false;
    restoreConsoleInterceptor();
    resetTracingForTests();
    resetEarlyErrorsForTests();
}
