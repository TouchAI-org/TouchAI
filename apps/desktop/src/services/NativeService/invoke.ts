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
    const payload =
        traceparent && (!args || !Array.isArray(args)) ? { ...(args ?? {}), traceparent } : args;
    return tauriInvoke<T>(command, payload, options);
}
