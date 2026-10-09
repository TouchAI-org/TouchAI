import { afterEach, beforeEach, vi } from 'vitest';

import { installTauriMocks, resetTauriMocks } from '../utils/tauri';

const webStreamGlobals = {
    ReadableStream: globalThis.ReadableStream,
    TransformStream: globalThis.TransformStream,
    WritableStream: globalThis.WritableStream,
};

for (const [name, value] of Object.entries(webStreamGlobals)) {
    if (
        typeof value !== 'undefined' &&
        typeof (globalThis as Record<string, unknown>)[name] === 'undefined'
    ) {
        Object.defineProperty(globalThis, name, {
            configurable: true,
            writable: true,
            value,
        });
    }
}

beforeEach(() => {
    installTauriMocks();
});

afterEach(() => {
    vi.restoreAllMocks();
    resetTauriMocks();
});
