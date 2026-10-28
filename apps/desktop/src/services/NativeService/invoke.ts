import { currentTraceparent } from '@services/ObservabilityService/traceparent';
import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';

/**
 * Propagate the active W3C trace context to application commands. Plugin
 * commands keep their exact payload contract.
 */
export function invoke<T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
    if (command.startsWith('plugin:')) {
        return tauriInvoke<T>(command, args, options);
    }

    const traceparent = currentTraceparent();
    // 只有对象形式的参数能安全合并；数组和二进制负载必须原样传递。
    const canAttachTrace = args === undefined || isPlainObject(args);
    const payload = traceparent && canAttachTrace ? { ...args, traceparent } : args;
    return tauriInvoke<T>(command, payload, options);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
