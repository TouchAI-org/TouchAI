import { native } from '@services/NativeService';
import { getCurrentWindow } from '@tauri-apps/api/window';

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
        onError: (error) => {
            // 日志后端不可用时不能让业务路径抛出，也不重试，避免形成循环。
            console.error('[Observability] failed to send log batch', error);
        },
    });
    queue.start();

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
        ts: Date.now(),
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
}
