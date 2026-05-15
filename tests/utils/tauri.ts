import type { InvokeArgs } from '@tauri-apps/api/core';
import { clearMocks, mockConvertFileSrc, mockIPC, mockWindows } from '@tauri-apps/api/mocks';

export interface TauriInvokeCall {
    cmd: string;
    payload: InvokeArgs | undefined;
}

interface TauriInternals {
    invoke: (
        cmd: string,
        payload?: InvokeArgs,
        options?: Record<string, unknown>
    ) => Promise<unknown>;
    runCallback: (id: number, payload: unknown) => void;
}

type TauriWindow = Window & {
    __TAURI_INTERNALS__?: TauriInternals;
};

type TauriCommandResponder = (payload?: InvokeArgs) => unknown;
type TauriInvokeInterceptor = (
    call: TauriInvokeCall,
    next: (
        cmd?: string,
        payload?: InvokeArgs,
        options?: Record<string, unknown>
    ) => Promise<unknown>,
    options?: Record<string, unknown>
) => Promise<unknown> | unknown;

interface InstallTauriMocksOptions {
    currentWindowLabel?: string;
    additionalWindows?: string[];
}

const DEFAULT_WINDOWS = ['settings', 'popup-model-dropdown-popup', 'popup-session-history-popup'];

const tauriInvokeCalls: TauriInvokeCall[] = [];
const tauriCommandResponders = new Map<string, TauriCommandResponder>();
const tauriEventListeners = new Map<string, Set<number>>();

let tauriInvokeInterceptor: TauriInvokeInterceptor | undefined;

function getTauriInternals(): TauriInternals {
    return (window as TauriWindow).__TAURI_INTERNALS__ as TauriInternals;
}

function resetTauriMockState() {
    tauriInvokeCalls.length = 0;
    tauriCommandResponders.clear();
    tauriEventListeners.clear();
    tauriInvokeInterceptor = undefined;
}

function isEventPluginCommand(cmd: string) {
    return cmd.startsWith('plugin:event|');
}

function toInvokePayloadRecord(payload?: InvokeArgs): Record<string, unknown> {
    return (payload ?? {}) as Record<string, unknown>;
}

function normalizeRecordedPayload(payload?: InvokeArgs): InvokeArgs | undefined {
    if (!payload) {
        return undefined;
    }

    if (Array.isArray(payload)) {
        return payload;
    }

    return Object.keys(payload).length === 0 ? undefined : payload;
}

function addEventListener(event: string, handlerId: number) {
    const listeners = tauriEventListeners.get(event) ?? new Set<number>();
    listeners.add(handlerId);
    tauriEventListeners.set(event, listeners);
}

function removeEventListener(event: string, handlerId: number) {
    const listeners = tauriEventListeners.get(event);
    if (!listeners) {
        return;
    }

    listeners.delete(handlerId);
    if (listeners.size === 0) {
        tauriEventListeners.delete(event);
    }
}

function invokeEventPluginCommand(
    tauriInternals: TauriInternals,
    cmd: string,
    payload?: InvokeArgs
) {
    const payloadRecord = toInvokePayloadRecord(payload);

    if (cmd === 'plugin:event|listen') {
        const event = String(payloadRecord.event ?? '');
        const handlerId = Number(payloadRecord.handler);
        addEventListener(event, handlerId);
        return Promise.resolve(handlerId);
    }

    if (cmd === 'plugin:event|emit') {
        const event = String(payloadRecord.event ?? '');
        const listeners = [...(tauriEventListeners.get(event) ?? [])];
        for (const handlerId of listeners) {
            tauriInternals.runCallback(handlerId, {
                event,
                id: handlerId,
                payload: payloadRecord.payload,
            });
        }
        return Promise.resolve(null);
    }

    if (cmd === 'plugin:event|unlisten') {
        const event = String(payloadRecord.event ?? '');
        const handlerId = Number(payloadRecord.eventId ?? payloadRecord.id);
        removeEventListener(event, handlerId);
        return Promise.resolve(undefined);
    }

    return Promise.resolve(undefined);
}

export function installTauriMocks(options: InstallTauriMocksOptions = {}) {
    const { currentWindowLabel = 'main', additionalWindows = DEFAULT_WINDOWS } = options;

    clearMocks();
    resetTauriMockState();
    mockWindows(currentWindowLabel, ...additionalWindows);
    mockConvertFileSrc('windows');
    mockIPC((cmd, payload) => {
        const responder = tauriCommandResponders.get(cmd);
        return responder?.(payload);
    });

    const tauriInternals = getTauriInternals();
    const baseInvoke = tauriInternals.invoke.bind(tauriInternals);
    tauriInternals.invoke = async (cmd, payload, invokeOptions) => {
        const call = { cmd, payload: normalizeRecordedPayload(payload) };
        tauriInvokeCalls.push(call);

        const execute = (nextCmd = cmd, nextPayload = payload, nextOptions = invokeOptions) => {
            if (isEventPluginCommand(nextCmd)) {
                return invokeEventPluginCommand(tauriInternals, nextCmd, nextPayload);
            }

            return baseInvoke(nextCmd, nextPayload, nextOptions);
        };

        if (tauriInvokeInterceptor) {
            return tauriInvokeInterceptor(call, execute, invokeOptions);
        }

        return execute();
    };
}

export function resetTauriMocks() {
    clearMocks();
    resetTauriMockState();
}

export function mockTauriCommand(cmd: string, responder: unknown | TauriCommandResponder) {
    tauriCommandResponders.set(
        cmd,
        typeof responder === 'function' ? (responder as TauriCommandResponder) : () => responder
    );
}

export function interceptTauriInvoke(interceptor: TauriInvokeInterceptor) {
    tauriInvokeInterceptor = interceptor;
}

export function getTauriInvokeCalls(cmd?: string): TauriInvokeCall[] {
    if (!cmd) {
        return [...tauriInvokeCalls];
    }

    return tauriInvokeCalls.filter((call) => call.cmd === cmd);
}

export function getLastTauriInvokeCall(cmd: string): TauriInvokeCall | undefined {
    const calls = getTauriInvokeCalls(cmd);
    return calls[calls.length - 1];
}
