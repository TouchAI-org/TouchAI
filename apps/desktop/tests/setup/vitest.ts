import {
    ReadableStream as NodeReadableStream,
    TransformStream as NodeTransformStream,
    WritableStream as NodeWritableStream,
} from 'node:stream/web';

import { afterEach, beforeEach, vi } from 'vitest';

import { installTauriMocks, resetTauriMocks } from '../utils/tauri';

const webStreamGlobals = {
    ReadableStream: NodeReadableStream,
    TransformStream: NodeTransformStream,
    WritableStream: NodeWritableStream,
};

for (const [name, value] of Object.entries(webStreamGlobals)) {
    if (typeof (globalThis as Record<string, unknown>)[name] === 'undefined') {
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
